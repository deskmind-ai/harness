/**
 * The app protocol (hands.sock, next version; design notes docs/design/harness-app-integration-2026-10-17.md §2 and the
 * 10-18 revision): every persistent event carries a sequence number and is written to disk before it is sent, so an
 * app that reconnects says the last `seq` it saw and gets the rest (`EventLog.since`). The app ignores kinds it does
 * not know, so adding one never breaks an older app.
 *
 * Version: `start` carries `protocol: {events: 1}` (protocol/version.ts; the compatibility rule is in docs/protocol.md).
 *
 * Kinds: start, preparing, plan, step, step_result, ask, waiting, resumed, consent, refused, answer_given, task_done,
 * result_response.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

const Consequence = z.enum(["read", "create", "modify_user", "external"]);
const PlanFacts = z.object({
  steps: z.array(z.object({ purpose: z.string(), class: Consequence,
    objects: z.array(z.object({ ref: z.string(), label: z.string(), owner: z.enum(["user", "task"]), marks: z.array(z.enum(["changes", "sends", "opens_pages"])) })),
    sites: z.array(z.object({ host: z.string(), sends: z.string().nullable(), asks_each: z.boolean() })) })),
  foreground: z.object({ apps: z.array(z.string()), note: z.string() }).nullable(),
});
const ActionFacts = z.object({
  action: z.string(), action_text: z.string(), target: z.string().nullable(), object: z.string(), object_label: z.string(), consequence: Consequence,
  outgoing: z.array(z.object({ kind: z.enum(["field", "selected", "typed", "text"]), label: z.string(), value: z.string() })), site: z.string().nullable(),
});
export const CardEvent = z.object({
  kind: z.string(), text: z.string(),
  options: z.array(z.object({ kind: z.string(), text: z.string() })),
  free_text: z.boolean(), blocking: z.boolean(),
  // additive (events v1, M0): the card's facts in fields, for an app that lays them out itself; `text` says all of it.
  // plan: kind "plan"; consent: kind "action" when it asks consent for one action
  plan: PlanFacts.optional(), consent: ActionFacts.optional(),
});

export const EventBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), raw: z.string(), lang: z.enum(["zh", "en"]).default("zh"), engine: z.string().default("runtime"), config: z.string().optional(), scope: z.string().optional(),
    // the event stream's version (protocol/version.ts, docs/protocol.md): absent in runs from before it was sent
    protocol: z.object({ events: z.number().int() }).optional() }),
  z.object({ kind: z.literal("preparing") }),
  z.object({ kind: z.literal("plan"), steps: z.array(z.object({ purpose: z.string(), objects: z.array(z.string()), consequence: Consequence })) }),
  z.object({ kind: z.literal("step"), text: z.string(), consequence: Consequence.optional(), object: z.string().optional(), status: z.string().optional(), purpose: z.string().optional(),
    // additive (events v1, M0): the step's id (its `step_result` and the trace name it), the action in the user's words
    // (the element by its label and role, never its id), the element it acts on, and the plan step the caller says it is for
    step_id: z.string().optional(), human: z.string().optional(), target: z.object({ id: z.string(), label: z.string(), role: z.string() }).optional(), plan_step: z.number().int().optional() }),
  // how a step ended (M0): ok, unverified (done, not read back), refused (the executor or the user did not let it — the
  // executor's own status in `executor_status`), stale (the screen moved since the caller looked: not done), error
  z.object({ kind: z.literal("step_result"), step_id: z.string(), status: z.enum(["ok", "unverified", "refused", "stale", "error"]), why: z.string().optional(), executor_status: z.string().optional(), consequence: Consequence.optional() }),
  z.object({ kind: z.literal("ask"), ask_id: z.string(), card: CardEvent }),
  z.object({ kind: z.literal("waiting"), ask_id: z.string().optional() }),
  // `voided`: the card was let go without an answer because the user changed the request (a steer, "steer"): the app
  // closes it; an answer sent for it later is refused (additive field, events v1)
  z.object({ kind: z.literal("resumed"), ask_id: z.string().optional(), voided: z.string().optional() }),
  z.object({ kind: z.literal("consent"), object: z.string(), consequence: Consequence, scope: z.enum(["action", "object", "rule"]), picked: z.string().nullable() }),
  z.object({ kind: z.literal("refused"), what: z.string(), why: z.string(), by: z.enum(["user", "executor"]) }),
  z.object({ kind: z.literal("answer_given"), text: z.string() }),
  z.object({ kind: z.literal("task_done"), status: z.string(), reason: z.string(), summary: z.string(), result_card: CardEvent.nullable(), answer: z.string().nullable().optional(), changes: z.object({ created: z.array(z.string()), modified: z.array(z.string()), deleted: z.array(z.string()), external: z.array(z.string()),
    // changed during a screen action with no driver receipt: neither the task's nor another program's (the app may show them later)
    unconfirmed: z.array(z.string()).optional() }).optional().optional() }),
  // the user's response to a result card after the run (respond): recorded; what it does is the runtime's to add
  z.object({ kind: z.literal("result_response"), picked: z.string().nullable(), text: z.string().optional(), effect: z.string() }),
]);
export type EventBody = z.infer<typeof EventBody>;

export const AppEvent = z.object({ seq: z.number().int().min(1), t: z.number(), run_id: z.string() }).and(EventBody);
export type AppEvent = { seq: number; t: number; run_id: string } & EventBody;

/** Append-only, fsync'd per event, then handed to the sink (stdout). Reopened from disk for a reconnect's replay. */
export class EventLog {
  events: AppEvent[] = [];

  constructor(readonly file: string, readonly runId: string, private readonly sink?: (ev: AppEvent) => void) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (!fs.existsSync(file)) return;
    // an event cut off mid-write (the process died inside writeSync) was never sent: it is skipped, kept on a line of
    // its own (the next event must not be glued to it), and its seq is used again (review of #16)
    const raw = fs.readFileSync(file, "utf-8");
    if (raw && !raw.endsWith("\n")) fs.appendFileSync(file, "\n");
    this.events = raw.split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l) as AppEvent]; } catch { return []; } });
  }

  emit(body: EventBody): AppEvent {
    const parsed = EventBody.parse(body);                // an event that does not fit the protocol never reaches the app
    const ev: AppEvent = { seq: this.events.length + 1, t: Date.now() / 1000, run_id: this.runId, ...parsed };
    const fd = fs.openSync(this.file, "a");
    try { fs.writeSync(fd, JSON.stringify(ev) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.events.push(ev);
    this.sink?.(ev);
    return ev;
  }

  /** Everything after `seq` (the last the app received): the reconnect's replay. */
  since(seq: number): AppEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }
}
