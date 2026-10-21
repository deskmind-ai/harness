/**
 * The session process's core (docs/protocol.md 「会话（第 1 版）」): one per chat session, long-lived. It reads control
 * lines, keeps the history (log.ts), runs one reply at a time (loop.ts) over the built context (context.ts), and writes
 * events: the stored ones with their `seq`, the transient ones (start, deltas, refusals) without.
 *
 * H1 controls: say, stop, attach, end. The H2 ones (cua, steer, answer, respond, queue_*) are read and answered with
 * `session.error{code:"not_yet"}`; any other type is a later version's and is ignored.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { configTable, PROVIDERS, providerOf } from "../gateway/index.js";
import { loopModel } from "../runtime/model.js";
import { PROTOCOL } from "../protocol/version.js";
import { buildContext, WINDOW_SHARE, type Lang } from "./context.js";
import { reply, type SessionModel } from "./loop.js";
import { MAX_ASSISTANT_CHARS, MAX_USER_CHARS, SessionLog, sessionDir, type ErrorCode, type SessionEvent } from "./log.js";

/** The first stdin line: which session, and the settings for this process. `driver` is read for H2. */
export interface SessionHeader { session_id?: string; config?: string; lang?: Lang; driver?: string }

export type SessionControl =
  | { type: "say"; text: string }
  | { type: "stop" }
  | { type: "attach"; after_seq: number }
  | { type: "end" }
  | { type: "reserved"; name: string };

/** The control types H2 adds: read now, answered with not_yet. */
export const RESERVED_CONTROLS = ["cua", "steer", "answer", "respond"] as const;

/** One stdin line → a control, or null (not JSON, not an object, no type, or a type this version does not know). */
export function parseSessionControl(line: string): SessionControl | null {
  let j: unknown;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (typeof o.type !== "string") return null;
  switch (o.type) {
    case "say": return typeof o.text === "string" ? { type: "say", text: o.text } : null;
    case "stop": return { type: "stop" };
    case "attach": return { type: "attach", after_seq: typeof o.after_seq === "number" && Number.isFinite(o.after_seq) && o.after_seq > 0 ? Math.floor(o.after_seq) : 0 };
    case "end": return { type: "end" };
    default: return (RESERVED_CONTROLS as readonly string[]).includes(o.type) || o.type.startsWith("queue_") ? { type: "reserved", name: o.type } : null;
  }
}

export interface HostOptions {
  dir: string;
  sessionId: string;
  config?: string;
  lang?: Lang;
  /** Every event line, stored or not. */
  out: (ev: Record<string, unknown>) => void;
  /** Called once when the session has nothing left to do: the app went away (stdin closed) or said end, and no reply runs. */
  onExit?: () => void;
  /** Tests: a model in place of the config's. */
  model?: SessionModel;
  /** How long deltas are gathered before they are sent (ms). */
  coalesceMs?: number;
}

const newId = () => `msg_${randomUUID().slice(0, 8)}`;

interface Running { msgId: string; replyTo: string; abort: AbortController; sent: string; buffer: string; timer: NodeJS.Timeout | null; done: Promise<void> }

export class SessionHost {
  readonly log: SessionLog;
  readonly resumed: boolean;
  config: string;
  lang: Lang;
  private running: Running | null = null;
  private closing = false;
  private exited = false;

  constructor(private readonly o: HostOptions) {
    this.config = o.config ?? "ds-flash";       // the app's default (cli/app.ts)
    this.lang = o.lang === "en" ? "en" : "zh";
    this.resumed = fs.existsSync(path.join(sessionDir(o.dir, o.sessionId), "session.jsonl"));
    this.log = new SessionLog(o.dir, o.sessionId, (ev) => o.out(ev));
  }

  get busy(): boolean { return this.running !== null; }

  /** A transient event: no seq, not stored. */
  private send(body: Record<string, unknown>) { this.o.out({ t: Date.now() / 1000, session_id: this.o.sessionId, ...body }); }

  private refuse(code: ErrorCode, text: string, control?: string) { this.send({ kind: "session.error", code, text, ...(control ? { control } : {}) }); }

  start() {
    this.send({ kind: "session.start", session_id: this.o.sessionId, protocol: { session: PROTOCOL.session, events: PROTOCOL.events, control: PROTOCOL.control }, last_seq: this.log.lastSeq, resumed: this.resumed });
  }

  /** The header's settings, read after the process started (resume with `--session`, then a header line). */
  configure(h: SessionHeader) { if (h.config) this.config = h.config; if (h.lang === "zh" || h.lang === "en") this.lang = h.lang; }

  handle(line: string) {
    if (this.exited || !line.trim()) return;
    const c = parseSessionControl(line);
    if (!c) return;
    switch (c.type) {
      case "say": return this.say(c.text);
      case "stop": return this.stop();
      case "attach": return this.attach(c.after_seq);
      case "end": return this.end();
      case "reserved": return this.refuse("not_yet", this.lang === "en" ? `${c.name} comes with computer tasks; this version cannot do it yet` : `${c.name} 要等电脑任务接进会话之后才有，这个版本还做不了`, c.name);
    }
  }

  /** The model of the session's config: its goal model, keys from the environment. An error says what to fix. */
  private resolveModel(): SessionModel | { code: ErrorCode; text: string } {
    if (this.o.model) return this.o.model;
    const table = configTable(this.config);
    if (!table) return { code: "bad_config", text: `unknown config ${this.config}` };
    const goal = table.goal;
    if (goal.backend !== "openai") return { code: "bad_config", text: `config ${this.config}: the session needs a keyed service (<provider>|<model>), not ${goal.backend}` };
    const p = providerOf(goal.model);
    if ("error" in p) return { code: "bad_config", text: p.error };
    if (!p.key) return { code: "no_key", text: `${PROVIDERS[p.name]!.keyEnv} is not set` };
    return loopModel(goal.model);
  }

  say(text: string) {
    if (this.closing) return;
    if (!text.trim()) return;
    if (text.length > MAX_USER_CHARS) return this.refuse("too_long", `a message is at most ${MAX_USER_CHARS} characters; this one has ${text.length}`, "say");
    if (this.running) return this.refuse("busy", this.lang === "en" ? "a reply is still coming; stop it first or wait" : "上一条回复还没完：先停下它，或者等它说完", "say");
    const user = this.log.emit({ kind: "session.message", msg_id: newId(), role: "user", text });
    const userId = (user as Extract<SessionEvent, { kind: "session.message" }>).msg_id;
    const model = this.resolveModel();
    if ("code" in model) { this.log.emit({ kind: "session.error", code: model.code, text: model.text, reply_to: userId }); return; }
    const context = buildContext(this.log.messages(), { budgetChars: Math.floor((model.model.contextWindow ?? 128_000) * WINDOW_SHARE), lang: this.lang });
    const r: Running = { msgId: newId(), replyTo: userId, abort: new AbortController(), sent: "", buffer: "", timer: null, done: Promise.resolve() };
    this.running = r;
    // the reply has begun (the app shows "thinking" until text comes): an empty delta at offset 0
    this.send({ kind: "session.delta", msg_id: r.msgId, text: "", offset: 0 });
    const onDelta = (d: string) => { r.buffer += d; if (!r.timer) r.timer = setTimeout(() => this.flush(r), this.o.coalesceMs ?? 50); };
    r.done = reply({ model, context, signal: r.abort.signal, maxChars: MAX_ASSISTANT_CHARS, onDelta }).then((res) => {
      if (r.timer) { clearTimeout(r.timer); r.timer = null; }
      if (res.ended === "error") {
        r.buffer = "";
        this.log.emit({ kind: "session.error", code: res.error!.code, text: res.error!.text, msg_id: r.msgId, reply_to: r.replyTo });
      } else {
        this.flush(r);
        // the final text is what the deltas said; a service that sent less than the whole gets the rest as one more delta
        if (res.text.length > r.sent.length && res.text.startsWith(r.sent)) { r.buffer = res.text.slice(r.sent.length); this.flush(r); }
        this.log.emit({ kind: "session.message", msg_id: r.msgId, role: "assistant", text: res.text, reply_to: r.replyTo, model: res.model,
          ...(res.ended === "stopped" ? { stopped: true } : {}), ...(res.ended === "truncated" ? { truncated: true } : {}) });
      }
    }, (e) => {
      this.log.emit({ kind: "session.error", code: "network", text: String(e instanceof Error ? e.message : e).slice(0, 300), msg_id: r.msgId, reply_to: r.replyTo });
    }).finally(() => { this.running = null; this.maybeExit(); });
  }

  private flush(r: Running) {
    if (r.timer) { clearTimeout(r.timer); r.timer = null; }
    if (!r.buffer) return;
    const text = r.buffer; r.buffer = "";
    this.send({ kind: "session.delta", msg_id: r.msgId, text, offset: r.sent.length });
    r.sent += text;
  }

  /** Stop the reply now: what came so far is stored with `stopped: true`. Nothing runs: nothing to do. */
  stop() { this.running?.abort.abort(); }

  /** Replay every stored event after `afterSeq`, then, while a reply is coming, its text so far (one delta at offset 0). */
  attach(afterSeq: number) {
    for (const ev of this.log.since(afterSeq)) this.o.out(ev);
    const r = this.running;
    if (r) { this.flush(r); this.send({ kind: "session.delta", msg_id: r.msgId, text: r.sent, offset: 0 }); }
  }

  /** The app said end (or a signal): stop the reply, store it, exit. */
  end() { this.closing = true; this.stop(); this.maybeExit(); }

  /** stdin closed: when no reply runs, exit; otherwise after it is stored. */
  inputClosed() { this.closing = true; this.maybeExit(); }

  /** Resolves when no reply runs. */
  async idle(): Promise<void> { while (this.running) await this.running.done; }

  private maybeExit() {
    if (!this.closing || this.running || this.exited) return;
    this.exited = true;
    this.o.onExit?.();
  }
}

/** One process per session: `sessions/<sid>/lock` holds the pid. A lock whose process is gone is taken over. */
export function acquireLock(dir: string, sessionId: string): { ok: true; release: () => void } | { ok: false; pid: number } {
  const file = path.join(sessionDir(dir, sessionId), "lock");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });
      return { ok: true, release: () => { try { if (fs.readFileSync(file, "utf-8") === String(process.pid)) fs.unlinkSync(file); } catch { /* gone already */ } } };
    } catch {
      const pid = Number(fs.readFileSync(file, "utf-8").trim());
      let alive = false;
      try { if (pid > 0 && pid !== process.pid) { process.kill(pid, 0); alive = true; } } catch (e) { alive = (e as NodeJS.ErrnoException).code === "EPERM"; }
      if (alive) return { ok: false, pid };
      try { fs.unlinkSync(file); } catch { /* someone else took it over: the next try says */ }
    }
  }
  return { ok: false, pid: 0 };
}
