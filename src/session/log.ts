/**
 * A chat session's history (docs/protocol.md 「会话（第 1 版）」): `<dir>/sessions/<session_id>/session.jsonl`, the
 * same pattern as a run's events (protocol/events.ts EventLog): every stored event gets the next `seq`, is fsync'd,
 * then sent; an app that comes back says the last `seq` it saw (`attach{after_seq}`) and gets the rest (`since`).
 * The stream's id is the session id.
 *
 * Stored: the final user and assistant messages and the model's errors. Not stored (sent without `seq`): the session's
 * start, the reply's deltas, and refusals of a control line (not_yet, busy, too_long) — they answer one line, the
 * history does not need them. A reply cut off by a killed process was never stored: it is not in the history.
 *
 * The folder is the user's words: mode 0700, the file 0600, on this Mac only.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { z } from "zod";
import { STOP_CAUSES } from "../protocol/computer.js";

/** Where sessions live when the command line does not say: the app's own folder. */
export const DEFAULT_DIR = path.join(os.homedir(), "Library", "Application Support", "DeskMind");

/** A session id names a folder: letters, digits, `_` and `-` only (no path can be built from it). */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What one message may hold, in characters: what the user writes, what a reply may grow to. */
export const MAX_USER_CHARS = 32_000;
export const MAX_ASSISTANT_CHARS = 64_000;

/** The model's errors (stored) and the refusals of a control line (sent, not stored). H2 adds computer_busy (another
 *  session holds the computer), card_open (say / steer while the running task's card waits), no_task (a task control
 *  naming no task of this session), undo_expired (a respond after another task started on this Mac) and bad_control
 *  (a control line without what it needs: a respond with no valid option index). */
export const ERROR_CODES = ["no_key", "key_invalid", "network", "quota", "bad_config", "not_yet", "busy", "too_long", "computer_busy", "card_open", "no_task", "undo_expired", "bad_control"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
/** Codes that refuse a control line: sent without a seq, never in the history. */
export const REFUSALS: readonly ErrorCode[] = ["not_yet", "busy", "too_long", "computer_busy", "card_open", "no_task", "undo_expired", "bad_control"];

/** How a computer task ended, as the session keeps it: the executor's task_done status, or `interrupted` (the process
 *  went away and the run has no task_done). */
const Changes = z.object({ created: z.array(z.string()), modified: z.array(z.string()), deleted: z.array(z.string()), external: z.array(z.string()), unconfirmed: z.array(z.string()).optional(),
  /** How many of each kind were left out (each list holds at most MAX_CHANGES). */
  more: z.record(z.number()).optional() });
/** What the model reads of a task's changes: at most this many per kind. */
export const MAX_CHANGES = 20;

export const SessionBody = z.discriminatedUnion("kind", [
  // a final message. `via`: how it came (H2: a computer task); `reply_to`: the user message an assistant one answers;
  // `stopped`: the user stopped the reply (the text is what had come by then); `truncated`: cut at MAX_ASSISTANT_CHARS
  // `client_id` (additive): the app's id for a user message it sent (say / cua, or queued by a say), given back
  z.object({ kind: z.literal("session.message"), msg_id: z.string(), role: z.enum(["user", "assistant"]), text: z.string(), via: z.string().optional(),
    reply_to: z.string().optional(), stopped: z.boolean().optional(), truncated: z.boolean().optional(), model: z.string().optional(), client_id: z.string().optional() }),
  // the model could not answer (no key, a key the service refused, the network, the account's quota, a config that
  // names no service), or a control line was refused. `msg_id`: the reply that failed (its deltas, if any, are void);
  // `control`: the refused line's type
  z.object({ kind: z.literal("session.error"), code: z.enum(ERROR_CODES), text: z.string(), msg_id: z.string().optional(), reply_to: z.string().optional(), control: z.string().optional() }),
  // H2: a computer task began. `raw`: the user's own words it carries (the executor's request.raw); `goal`: the model's
  // restatement (request.context), when the model started it; `by`: slash (the user's /cua) or model (computer_task)
  z.object({ kind: z.literal("session.task"), msg_id: z.string(), run_id: z.string(), raw: z.string(), goal: z.string().optional(), by: z.enum(["slash", "model"]), reply_to: z.string().optional() }),
  // H2: how it ended — what the model was told (status, reason, summary, answer, changes, steers) and whether the result
  // card's undo was open then. `interrupted`: no task_done (the session process went away mid-task)
  // `cause` (additive): task_done's cause as a field, or the session's own when it ends the task with no task_done —
  // last_step_unknown when a step had begun (`step`) and not ended (`step_result`)
  z.object({ kind: z.literal("session.task_end"), run_id: z.string(), status: z.string(), summary: z.string(), undo: z.enum(["open", "none"]), reason: z.string().optional(), cause: z.enum(STOP_CAUSES).optional(),
    answer: z.string().nullable().optional(), changes: Changes.optional(), steers: z.array(z.string()).optional() }),
  // H2: the session closed the run's executor (its stdin): the result card can no longer be answered. linger: it ended by
  // itself (a respond answered, its deadline, no result card); new_task: a computer task started on this Mac; session_end
  z.object({ kind: z.literal("session.task_closed"), run_id: z.string(), why: z.enum(["linger", "new_task", "session_end"]) }),
  // H2: the result card's undo was done (the executor's result_response, in fields)
  z.object({ kind: z.literal("session.task_undo"), run_id: z.string(), undone: z.number().int(), total: z.number().int(), refused: z.string().nullable() }),
  // H2: the user's words sent into a running task (steer, or a queued message sent now)
  z.object({ kind: z.literal("session.steer"), run_id: z.string(), text: z.string(), client_id: z.string().optional() }),
  // H2: the user asked for the last user message to be answered again: the replies to it so far leave the context
  z.object({ kind: z.literal("session.retry"), reply_to: z.string() }),
]);
export type SessionBody = z.infer<typeof SessionBody>;
export type SessionEvent = { seq: number; t: number; session_id: string } & SessionBody;

/** A stored message, as the context reads it: a user's or the assistant's words, or a computer task as the model's tool
 *  call (`call`: its goal) and its result (`result`: what the model is told, task.ts taskView). */
export type StoredMessage =
  | { msg_id: string; role: "user" | "assistant"; text: string; stopped?: boolean }
  | { msg_id: string; role: "call"; call_id: string; goal: string; text: string }
  | { msg_id: string; role: "result"; call_id: string; text: string };

/** The tool call id of a task's computer_task call, as the context writes it. */
export const callId = (runId: string) => `ct_${runId}`;

/** What the model reads of a finished task (and the tool result it got then): status, reason, summary, answer, the
 *  changes (at most MAX_CHANGES per kind), the undo (open | none, later undone n/m or expired), the user's mid-task
 *  words. Never a screenshot, an observation or the trace. */
export function taskView(end: Extract<SessionBody, { kind: "session.task_end" }>, later: { undo?: { undone: number; total: number; refused: string | null }; closed?: boolean } = {}): string {
  const undo = later.undo ? `undone ${later.undo.undone}/${later.undo.total}${later.undo.refused ? ` (stopped: ${later.undo.refused})` : ""}` : end.undo === "open" && later.closed ? "expired" : end.undo;
  return JSON.stringify({ status: end.status, ...(end.reason ? { reason: end.reason } : {}), summary: end.summary, ...(end.answer ? { answer: end.answer } : {}), ...(end.changes ? { changes: end.changes } : {}), undo, ...(end.steers?.length ? { steers: end.steers } : {}) });
}

/** A task_done's changes as the model reads them: at most MAX_CHANGES of each kind, the rest counted. */
export function capChanges(c: Record<string, unknown> | undefined): z.infer<typeof Changes> | undefined {
  if (!c || typeof c !== "object") return undefined;
  const out: Record<string, unknown> = {}, more: Record<string, number> = {};
  for (const k of ["created", "modified", "deleted", "external", "unconfirmed"]) {
    const v = Array.isArray(c[k]) ? (c[k] as unknown[]).filter((x): x is string => typeof x === "string") : [];
    if (k === "unconfirmed" && !v.length) continue;
    out[k] = v.slice(0, MAX_CHANGES);
    if (v.length > MAX_CHANGES) more[k] = v.length - MAX_CHANGES;
  }
  return { ...(out as z.infer<typeof Changes>), ...(Object.keys(more).length ? { more } : {}) };
}

export function sessionDir(dir: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`bad session id ${JSON.stringify(sessionId)}`);
  return path.join(dir, "sessions", sessionId);
}

/** Append-only, fsync'd per event, then handed to the sink. Reopened from disk on resume and for a replay. */
export class SessionLog {
  events: SessionEvent[] = [];
  readonly file: string;
  /** A failed write could not be cut back: the file may end mid-line. */
  private partial = false;

  constructor(readonly dir: string, readonly sessionId: string, private readonly sink?: (ev: SessionEvent) => void) {
    const d = sessionDir(dir, sessionId);
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    for (const p of [path.dirname(d), d]) { try { fs.chmodSync(p, 0o700); } catch { /* not ours to change: leave it */ } }
    this.file = path.join(d, "session.jsonl");
    if (!fs.existsSync(this.file)) return;
    // an event cut off mid-write (the process died inside writeSync) was never sent: skipped, kept on a line of its
    // own, and its seq is used again (as EventLog)
    const raw = fs.readFileSync(this.file, "utf-8");
    if (raw && !raw.endsWith("\n")) fs.appendFileSync(this.file, "\n");
    // a seq used again (a failed write that could not be cut back, then the next event with its seq): the later line
    // is the event; the earlier ones from that seq on were reported as failed and never sent
    const events: SessionEvent[] = [];
    for (const l of raw.split("\n")) {
      if (!l.trim()) continue;
      let ev: SessionEvent;
      try { ev = JSON.parse(l) as SessionEvent; } catch { continue; }
      if (typeof ev?.seq === "number") while (events.length && events[events.length - 1]!.seq >= ev.seq) events.pop();
      events.push(ev);
    }
    this.events = events;
  }

  get lastSeq(): number { return this.events.length; }

  emit(body: SessionBody): SessionEvent {
    const parsed = SessionBody.parse(body);
    const ev = { seq: this.events.length + 1, t: Date.now() / 1000, session_id: this.sessionId, ...parsed } as SessionEvent;
    // all or nothing: a write that fails or is short, or lands and then cannot be synced, is cut off again — an event
    // the caller was told failed is never in the file (stored once more later, or said to have happened when it did
    // not); one synced is stored, whatever closing the file says. A cut that failed leaves a partial line: the next
    // event starts on a line of its own (the reader skips the partial one).
    const line = (this.partial ? "\n" : "") + JSON.stringify(ev) + "\n";
    const fd = fs.openSync(this.file, "a", 0o600);
    let size = -1, synced = false, failure: unknown = null;
    try {
      size = fs.fstatSync(fd).size;
      const want = Buffer.byteLength(line), n = fs.writeSync(fd, line);
      if (n !== want) throw Object.assign(new Error(`short write to ${path.basename(this.file)}: ${n} of ${want} bytes`), { code: "ENOSPC" });
      fs.fsyncSync(fd);
      synced = true;
      this.partial = false;
    } catch (e) {
      failure = e;
      if (size >= 0) { try { fs.ftruncateSync(fd, size); } catch { this.partial = true; } }
      throw e;
    } finally {
      // (the first error is the one thrown: a close that fails after it does not hide it)
      try { fs.closeSync(fd); } catch (e) { if (!synced && !failure) throw e; }
    }
    this.events.push(ev);
    this.sink?.(ev);
    return ev;
  }

  /** Everything after `seq` (the last the app received). */
  since(seq: number): SessionEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }

  /** The conversation as stored, in order: every final message, and each computer task as the model's call and its
   *  result (a task with no end yet has no result: it is still running). A retry takes the replies to its user message
   *  out (the tasks stay: they happened). */
  messages(): StoredMessage[] {
    const undo = new Map<string, { undone: number; total: number; refused: string | null }>(), closed = new Set<string>();
    const ends = new Map<string, Extract<SessionEvent, { kind: "session.task_end" }>>();
    for (const e of this.events) {
      if (e.kind === "session.task_undo") undo.set(e.run_id, { undone: e.undone, total: e.total, refused: e.refused });
      if (e.kind === "session.task_closed") closed.add(e.run_id);
      if (e.kind === "session.task_end") ends.set(e.run_id, e);
    }
    const out: StoredMessage[] = [];
    for (const e of this.events) {
      if (e.kind === "session.message") out.push({ msg_id: e.msg_id, role: e.role, text: e.text, ...(e.stopped ? { stopped: true } : {}) });
      else if (e.kind === "session.task") {
        // the result right after its call, wherever its end was stored (a resumed session stores it later)
        out.push({ msg_id: e.msg_id, role: "call", call_id: callId(e.run_id), goal: e.goal ?? e.raw, text: e.goal ?? e.raw });
        const end = ends.get(e.run_id);
        if (end) out.push({ msg_id: `end_${e.run_id}`, role: "result", call_id: callId(e.run_id), text: taskView(end, { undo: undo.get(e.run_id), closed: closed.has(e.run_id) }) });
      }
      else if (e.kind === "session.retry") {
        const at = out.findIndex((m) => m.msg_id === e.reply_to);
        if (at >= 0) for (let i = out.length - 1; i > at; i--) if (out[i]!.role === "assistant") out.splice(i, 1);
      }
    }
    return out;
  }

  /** The user's own messages since the last computer task began, oldest first (none: []). */
  userWordsSinceTask(): string[] {
    const words: string[] = [];
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i]!;
      if (e.kind === "session.task") break;
      if (e.kind === "session.message" && e.role === "user") words.unshift(e.text);
    }
    return words;
  }
}

/** One row of `sessions list`. */
export interface SessionSummary { session_id: string; title: string; updated_at: number; last_message: { role: "user" | "assistant"; text: string } | null }

const cut = (s: string, n: number) => { const a = Array.from(s.replace(/\s+/g, " ").trim()); return a.length > n ? a.slice(0, n).join("") + "…" : a.join(""); };

/** Every session under `dir`, the newest first: its title (the first user message, 40 characters), when it last
 *  changed (the last stored event's `t`, seconds), and its last message (200 characters). Read only. */
export function listSessions(dir: string): SessionSummary[] {
  const root = path.join(dir, "sessions");
  if (!fs.existsSync(root)) return [];
  const out: SessionSummary[] = [];
  for (const id of fs.readdirSync(root)) {
    if (!SESSION_ID.test(id)) continue;
    const file = path.join(root, id, "session.jsonl");
    if (!fs.existsSync(file)) continue;
    const evs = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l) as SessionEvent]; } catch { return []; } });
    const msgs = evs.filter((e): e is Extract<SessionEvent, { kind: "session.message" }> => e.kind === "session.message");
    const first = msgs.find((m) => m.role === "user"), last = msgs[msgs.length - 1];
    out.push({ session_id: id, title: first ? cut(first.text, 40) : "", updated_at: evs.length ? evs[evs.length - 1]!.t : fs.statSync(file).mtimeMs / 1000, last_message: last ? { role: last.role, text: cut(last.text, 200) } : null });
  }
  return out.sort((a, b) => b.updated_at - a.updated_at);
}
