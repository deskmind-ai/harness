/**
 * The app protocol (hands.sock, next version; design notes docs/design/harness-app-integration-2026-10-17.md §2 and the
 * 10-18 revision): every persistent event carries a sequence number and is written to disk before it is sent, so an
 * app that reconnects says the last `seq` it saw and gets the rest (`EventLog.since`). The app ignores kinds it does
 * not know, so adding one never breaks an older app.
 *
 * Kinds: start, preparing, plan, step, ask, waiting, resumed, consent, refused, answer_given, task_done.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { z } from "zod";

const Consequence = z.enum(["read", "create", "modify_user", "external"]);
export const CardEvent = z.object({
  kind: z.string(), text: z.string(),
  options: z.array(z.object({ kind: z.string(), text: z.string() })),
  free_text: z.boolean(), blocking: z.boolean(),
});

export const EventBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start"), raw: z.string(), lang: z.enum(["zh", "en"]).default("zh"), engine: z.string().default("runtime"), config: z.string().optional(), scope: z.string().optional() }),
  z.object({ kind: z.literal("preparing") }),
  z.object({ kind: z.literal("plan"), steps: z.array(z.object({ purpose: z.string(), objects: z.array(z.string()), consequence: Consequence })) }),
  z.object({ kind: z.literal("step"), text: z.string(), consequence: Consequence.optional(), object: z.string().optional(), status: z.string().optional(), purpose: z.string().optional() }),
  z.object({ kind: z.literal("ask"), ask_id: z.string(), card: CardEvent }),
  z.object({ kind: z.literal("waiting"), ask_id: z.string().optional() }),
  z.object({ kind: z.literal("resumed"), ask_id: z.string().optional() }),
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
