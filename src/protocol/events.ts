/**
 * The app protocol (hands.sock, next version; design notes docs/design/harness-app-integration-2026-10-17.md §2 and the
 * 10-18 revision): every persistent event carries a sequence number and is written to disk before it is sent, so an
 * app that reconnects says the last `seq` it saw and gets the rest (`EventLog.since`). The app ignores kinds it does
 * not know, so adding one never breaks an older app.
 *
 * Version: `start` carries `protocol: {events: 1}` (protocol/version.ts; the compatibility rule is in docs/protocol.md).
 *
 * Kinds: start, preparing, plan, step, step_result, ask, ask_void, waiting, resumed, consent, refused, steered, verify,
 * changes, model_call, judge, shot_ready, answer_given, task_done,
 * result_response, result_card_closed.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";
import { STOP_CAUSES } from "./computer.js";

const Consequence = z.enum(["read", "create", "modify_user", "external"]);
const FrameEv = z.object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() });
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
    step_id: z.string().optional(), human: z.string().optional(), plan_step: z.number().int().optional(),
    // the element: its id, its name and role; where it is in its window as fractions 0–1 (for the cursor over a picture of
    // the window) and on screen in points, when the driver says
    target: z.object({ id: z.string(), label: z.string(), role: z.string(), rect_norm: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(), frame: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional() }).optional() }),
  // how a step ended (M0): ok, unverified (done, not read back), refused (the executor or the user did not let it — the
  // executor's own status in `executor_status`), stale (the screen moved since the caller looked: not done), error
  z.object({ kind: z.literal("step_result"), step_id: z.string(), status: z.enum(["ok", "unverified", "refused", "stale", "error"]), why: z.string().optional(), executor_status: z.string().optional(), consequence: Consequence.optional(),
    // the window after the step as a small PNG (relative to the run folder; only steps that changed something), and
    // where the window and the element were on screen before acting (hands' receipt)
    // shot_pending: the picture is still being written there (a shot_ready follows when it is)
    shot: z.string().optional(), shot_pending: z.boolean().optional(), target_frame: FrameEv.optional(), window_frame: FrameEv.optional(),
    // (M2 H2, additive) could this step have done something — the executor's one answer (executor/possibly.ts: an
    // intent in its journal and no receipt that says nothing happened), whatever `status` says. Absent: count it as yes
    possibly_done: z.boolean().optional() }),
  // a step's picture is on disk now (M0): it is taken after the step's result was sent, so it may come after later events
  // — even after task_done, while the process lives; if none comes, the file at step_result.shot is the answer
  z.object({ kind: z.literal("shot_ready"), step_id: z.string(), shot: z.string() }),
  z.object({ kind: z.literal("ask"), ask_id: z.string(), card: CardEvent }),
  z.object({ kind: z.literal("waiting"), ask_id: z.string().optional() }),
  // `voided`: the card was let go without an answer because the user changed the request (a steer, "steer"): the app
  // closes it; an answer sent for it later is refused (additive field, events v1)
  // `why` (M0, without ask_id): how the wait for the user to stop typing ended — "" they paused, "stopped" the app stopped
  // the task, "timed_out" they kept on (the step is refused, the task goes on)
  z.object({ kind: z.literal("resumed"), ask_id: z.string().optional(), voided: z.string().optional(), why: z.enum(["", "stopped", "timed_out"]).optional() }),
  // an open card let go without an answer (M0): the user changed the request (steer), stopped the task (stop), or the app
  // went away (ended). An answer sent for it later is refused
  // timeout (M2, additive): an action card left unanswered for 10 minutes (wall clock). Nobody answers for the user:
  // the task waits where it is, holding the computer, until a reask (「现在回答」: a new card), a steer or a stop
  z.object({ kind: z.literal("ask_void"), ask_id: z.string(), why: z.enum(["steer", "stop", "ended", "timeout"]) }),
  // the user's mid-run words reached the task (M0): applied between two steps; from here the judges read them
  z.object({ kind: z.literal("steered"), text: z.string() }),
  // a verdict on a "done" claim (M0): pass ends the task succeeded; unknown with missing_kind "evidence" means only looking
  // is allowed from here (the app says "checking the result"), and refusals of actions meanwhile are expected
  z.object({ kind: z.literal("verify"), verdict: z.enum(["pass", "fail", "unknown"]), by: z.string().optional(), reason: z.string(), missing_kind: z.enum(["action", "evidence"]).optional(), judge_id: z.string().optional() }),
  // the task's changes so far (M0), after each step that changed something: the same shape as task_done.changes, plus the
  // windows the task made
  z.object({ kind: z.literal("changes"), created: z.array(z.string()), modified: z.array(z.string()), deleted: z.array(z.string()), external: z.array(z.string()), unconfirmed: z.array(z.string()), created_windows: z.array(z.string()).optional() }),
  z.object({ kind: z.literal("consent"), object: z.string(), consequence: Consequence, scope: z.enum(["action", "object", "rule"]), picked: z.string().nullable() }),
  z.object({ kind: z.literal("refused"), what: z.string(), why: z.string(), by: z.enum(["user", "executor"]) }),
  z.object({ kind: z.literal("answer_given"), text: z.string() }),
  // one model call (M0): the acting model's turns (role "loop"), the judges' and the rewrites' — tokens, cost (USD, by the
  // price table when the service says none), latency, and the step and judge question it served
  z.object({ kind: z.literal("model_call"), call_id: z.string(), role: z.string(), model: z.string(), outcome: z.string(), tokens_in: z.number(), tokens_out: z.number(), cost_usd: z.number(), latency_ms: z.number(), step_id: z.string().optional(), judge_id: z.string().optional(),
    // of tokens_in (everything the model read), from the service's prompt cache; cost_estimated: the cache part priced at
    // the input rate (no cache price known)
    cache_read: z.number().optional(), cost_estimated: z.boolean().optional() }),
  // one judge question (M0): which question (intent, outgoing, provenance, verify, evidence), the answer and the tier
  // that settled it (null: no tier could), every tier asked and what it said, the shadow comparison when one ran
  z.object({ kind: z.literal("judge"), judge_id: z.string(), question: z.string(), answer: z.string().nullable(), by: z.string().nullable(), confidence: z.number().optional(),
    tiers: z.array(z.object({ tier: z.string(), outcome: z.string(), choice: z.string().nullable(), confidence: z.number().optional(), settled: z.boolean() })),
    shadow: z.object({ tier: z.string(), top: z.string().nullable(), agree: z.boolean().nullable() }).optional(), step_id: z.string().optional(), ms: z.number().optional() }),
  // the result card (M2 H2): there whenever the task changed something, however it ended — its undo option only when
  // every change can be taken back (the text says why not otherwise)
  // `reason` is display text, never matched; `cause` (additive, events v1) says in structure why the task stopped, set
  // only where the code knew it (protocol/computer.ts STOP_CAUSES): screen_locked, last_step_unknown, user_stopped.
  // Absent: a plain error or a normal end
  z.object({ kind: z.literal("task_done"), status: z.string(), reason: z.string(), cause: z.enum(STOP_CAUSES).optional(), summary: z.string(), result_card: CardEvent.nullable(), answer: z.string().nullable().optional(), changes: z.object({ created: z.array(z.string()), modified: z.array(z.string()), deleted: z.array(z.string()), external: z.array(z.string()),
    // changed during a screen action with no driver receipt: neither the task's nor another program's (the app may show them later)
    unconfirmed: z.array(z.string()).optional() }).optional().optional(),
    // the run's model calls in sum (M0): every call of every role, the acting model's included
    usage: z.object({ calls: z.number(), tokens_in: z.number(), tokens_out: z.number(), cost_usd: z.number(), by_role: z.record(z.object({ calls: z.number(), tokens_in: z.number(), tokens_out: z.number(), cost_usd: z.number(), latency_ms: z.number() })) }).optional(),
    /** Some of the runtime's model-call reports were dropped (its notifications came faster than the executor takes
     *  them): `usage` is lower than what was spent (executor split P2). */
    usage_incomplete: z.boolean().optional(),
    /** (M2 H2, additive) The result card offers undo and the process waits for its answer until then: seconds since
     *  the epoch, like `t`, by the wall clock. Absent: no undo offered, or no wait (no --linger, or a signal). */
    undo_until: z.number().optional() }),
  // the user's response to a result card after the run (respond): recorded; what it does is the runtime's to add
  // `undone` / `total` / `refused` (M0): the undo in fields — how many steps were taken back of how many, and why it
  // stopped (null: all of them); absent when nothing was undone
  // the result card's undo window ended by this process's clock (M2 H2, additive): from here every respond it still
  // reads is answered "expired" (result_response, nothing undone); the session stops forwarding and ends its stdin
  z.object({ kind: z.literal("result_card_closed"), why: z.enum(["expired"]) }),
  z.object({ kind: z.literal("result_response"), picked: z.string().nullable(), text: z.string().optional(), effect: z.string(), undone: z.number().int().optional(), total: z.number().int().optional(), refused: z.string().nullable().optional(),
    // the step an undo failed in, unforeseen (an I/O error): perhaps partly taken back; the steps after it in the undo untouched
    unsure: z.string().optional() }),
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
