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

/** Where sessions live when the command line does not say: the app's own folder. */
export const DEFAULT_DIR = path.join(os.homedir(), "Library", "Application Support", "DeskMind");

/** A session id names a folder: letters, digits, `_` and `-` only (no path can be built from it). */
export const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** What one message may hold, in characters: what the user writes, what a reply may grow to. */
export const MAX_USER_CHARS = 32_000;
export const MAX_ASSISTANT_CHARS = 64_000;

/** The model's errors (stored) and the refusals of a control line (sent, not stored). */
export const ERROR_CODES = ["no_key", "key_invalid", "network", "quota", "bad_config", "not_yet", "busy", "too_long"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];
/** Codes that refuse a control line: sent without a seq, never in the history. */
export const REFUSALS: readonly ErrorCode[] = ["not_yet", "busy", "too_long"];

export const SessionBody = z.discriminatedUnion("kind", [
  // a final message. `via`: how it came (H2: a computer task); `reply_to`: the user message an assistant one answers;
  // `stopped`: the user stopped the reply (the text is what had come by then); `truncated`: cut at MAX_ASSISTANT_CHARS
  z.object({ kind: z.literal("session.message"), msg_id: z.string(), role: z.enum(["user", "assistant"]), text: z.string(), via: z.string().optional(),
    reply_to: z.string().optional(), stopped: z.boolean().optional(), truncated: z.boolean().optional(), model: z.string().optional() }),
  // the model could not answer (no key, a key the service refused, the network, the account's quota, a config that
  // names no service), or a control line was refused. `msg_id`: the reply that failed (its deltas, if any, are void);
  // `control`: the refused line's type
  z.object({ kind: z.literal("session.error"), code: z.enum(ERROR_CODES), text: z.string(), msg_id: z.string().optional(), reply_to: z.string().optional(), control: z.string().optional() }),
]);
export type SessionBody = z.infer<typeof SessionBody>;
export type SessionEvent = { seq: number; t: number; session_id: string } & SessionBody;

/** A stored message, as the context reads it. */
export interface StoredMessage { msg_id: string; role: "user" | "assistant"; text: string; stopped?: boolean }

export function sessionDir(dir: string, sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error(`bad session id ${JSON.stringify(sessionId)}`);
  return path.join(dir, "sessions", sessionId);
}

/** Append-only, fsync'd per event, then handed to the sink. Reopened from disk on resume and for a replay. */
export class SessionLog {
  events: SessionEvent[] = [];
  readonly file: string;

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
    this.events = raw.split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l) as SessionEvent]; } catch { return []; } });
  }

  get lastSeq(): number { return this.events.length; }

  emit(body: SessionBody): SessionEvent {
    const parsed = SessionBody.parse(body);
    const ev = { seq: this.events.length + 1, t: Date.now() / 1000, session_id: this.sessionId, ...parsed } as SessionEvent;
    const fd = fs.openSync(this.file, "a", 0o600);
    try { fs.writeSync(fd, JSON.stringify(ev) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    this.events.push(ev);
    this.sink?.(ev);
    return ev;
  }

  /** Everything after `seq` (the last the app received). */
  since(seq: number): SessionEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }

  /** The conversation as stored: every final message, in order. */
  messages(): StoredMessage[] {
    return this.events.flatMap((e) => e.kind === "session.message" ? [{ msg_id: e.msg_id, role: e.role, text: e.text, ...(e.stopped ? { stopped: true } : {}) }] : []);
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
