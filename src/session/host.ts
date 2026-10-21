/**
 * The session process's core (docs/protocol.md 「会话（第 1 版）」): one per chat session, long-lived. It reads control
 * lines, keeps the history (log.ts), runs one reply at a time (loop.ts) over the built context (context.ts), and writes
 * events: the stored ones with their `seq`, the transient ones (start, deltas, refusals, the queue) without.
 *
 * Computer tasks (H2): the model has one tool, computer_task({goal}); the user has `/cua` (the `cua` control). Either
 * takes the machine lock (task.ts), records `session.task`, and starts the executor (`harness.mjs executor --linger 600`)
 * with the user's own words since the last task as `raw` and the model's goal as `context`. The executor's events go to
 * stdout as they are (plus `session_id`); answer, respond, stop and steer go to its stdin. While a task runs the model
 * waits in its tool call; what the user types meanwhile is queued, and sent to the model after the task (not after a
 * stop). The task's end is `session.task_end` (what the model is told); its executor lingers for the result card (undo)
 * until it ends by itself, another computer task starts on this Mac, or the session ends (`session.task_closed`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { configTable, PROVIDERS, providerOf, redactKeys } from "../gateway/index.js";
import { loopModel } from "../runtime/model.js";
import { PROTOCOL } from "../protocol/version.js";
import { buildContext, WINDOW_SHARE, type Lang } from "./context.js";
import { COMPUTER_TASK, reply, type ReplyResult, type SessionModel } from "./loop.js";
import { MAX_ASSISTANT_CHARS, MAX_USER_CHARS, SESSION_ID, SessionLog, capChanges, sessionDir, taskView, type ErrorCode, type SessionBody, type SessionEvent } from "./log.js";
import { EXIT_WAIT_MS, LINGER_S, alive, computerLastFile, computerOwner, cutRaw, lastTask, linkLock, setLastTask, spawnExecutor, takeComputer, type ComputerLock, type ExecutorHandle, type Launcher } from "./task.js";
import type { ModelCallRecord } from "../otel/context.js";

/** The first stdin line: which session, and the settings for this process. `driver` and `scope` (H2) go into every
 *  computer task's request: the executor's driver (sim | hands) and the task folder. */
export interface SessionHeader { session_id?: string; config?: string; lang?: Lang; driver?: string; scope?: string }

export type SessionControl =
  | { type: "say"; text: string }
  | { type: "stop"; run_id?: string }
  | { type: "attach"; after_seq: number; run_id?: string }
  | { type: "end" }
  | { type: "cua"; text: string; scope?: string }
  | { type: "steer"; text: string; run_id?: string }
  | { type: "answer"; run_id?: string; line: Record<string, unknown> }
  | { type: "respond"; run_id?: string; line: Record<string, unknown> }
  | { type: "retry" }
  | { type: "queue_edit"; id: string; text: string }
  | { type: "queue_cancel"; id: string }
  | { type: "queue_send_now"; id: string };

/** One stdin line → a control, or null (not JSON, not an object, no type, a type this version does not know, or a
 *  known type without its required fields). */
export function parseSessionControl(line: string): SessionControl | null {
  let j: unknown;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  if (typeof o.type !== "string") return null;
  const runId = typeof o.run_id === "string" ? { run_id: o.run_id } : {};
  const str = (k: string) => typeof o[k] === "string";
  switch (o.type) {
    case "say": return str("text") ? { type: "say", text: o.text as string } : null;
    case "stop": return { type: "stop", ...runId };
    case "attach": return { type: "attach", after_seq: typeof o.after_seq === "number" && Number.isFinite(o.after_seq) && o.after_seq > 0 ? Math.floor(o.after_seq) : 0, ...runId };
    case "end": return { type: "end" };
    case "cua": return str("text") ? { type: "cua", text: o.text as string, ...(str("scope") ? { scope: o.scope as string } : {}) } : null;
    case "steer": return str("text") ? { type: "steer", text: o.text as string, ...runId } : null;
    // the executor's own control lines (control v1), forwarded as they came: extra fields (run_id) are ignored there
    case "answer": return { type: "answer", ...runId, line: o };
    case "respond": return { type: "respond", ...runId, line: o };
    case "retry": return { type: "retry" };
    case "queue_edit": return str("id") && str("text") ? { type: "queue_edit", id: o.id as string, text: o.text as string } : null;
    case "queue_cancel": return str("id") ? { type: "queue_cancel", id: o.id as string } : null;
    case "queue_send_now": return str("id") ? { type: "queue_send_now", id: o.id as string } : null;
    default: return null;
  }
}

export interface HostOptions {
  dir: string;
  sessionId: string;
  config?: string;
  lang?: Lang;
  /** Every computer task's executor driver and task folder (the header's). */
  driver?: string;
  scope?: string;
  /** Every event line, stored or not. */
  out: (ev: Record<string, unknown>) => void;
  /** Called once when the session has nothing left to do: the app went away (stdin closed) or said end, and no reply
   *  or task runs. */
  onExit?: () => void;
  /** Tests: a model in place of the config's. */
  model?: SessionModel;
  /** How long deltas are gathered before they are sent (ms). */
  coalesceMs?: number;
  /** Tests: how an executor is started (default: this harness's `executor` as a child process). */
  launch?: Launcher;
  /** The executor's linger for its result card, seconds (default 600). */
  linger?: number;
  /** How often `computer.last` is looked at while an executor lingers (ms, default 500). */
  watchMs?: number;
  /** How long the app going away waits for a stopped task's task_done (ms, default 12 000). */
  exitWaitMs?: number;
}

const newId = () => `msg_${randomUUID().slice(0, 8)}`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** At most this many computer tasks per user message. */
export const MAX_TASKS = 3;

interface Running {
  msgId: string; replyTo: string; abort: AbortController; sent: string; buffer: string; timer: NodeJS.Timeout | null; done: Promise<void>;
  /** Computer tasks this reply started, and how many it may; the user's words they carry (found at the first). */
  tasks: number; maxTasks: number; raw: string | null;
  /** The turn in progress already stored its text (it called a tool). */
  cut: boolean;
}

type TaskEnd = Extract<SessionBody, { kind: "session.task_end" }>;
interface Task {
  runId: string; handle: ExecutorHandle; lock: ComputerLock | null; undoLock: ComputerLock | null;
  /** running: until task_done; lingering: its result card can be answered; ending: it exits by itself; closed. */
  state: "running" | "lingering" | "ending" | "closed";
  /** The card waiting for the user (an ask with no resumed / ask_void yet). */
  card: string | null;
  steers: string[];
  end: TaskEnd | null;
  ended: Promise<TaskEnd>;
  resolve: (e: TaskEnd) => void;
  exitTimer: NodeJS.Timeout | null;
}

export interface QueueItem { id: string; text: string; held?: boolean; note?: string }

export class SessionHost {
  readonly log: SessionLog;
  readonly resumed: boolean;
  config: string;
  lang: Lang;
  private running: Running | null = null;
  /** The task that runs now (at most one per session; the machine lock makes it one per Mac). */
  private current: Task | null = null;
  private readonly tasks = new Map<string, Task>();
  private queue: QueueItem[] = [];
  /** A /cua whose task or follow-up reply is not over. */
  private flows = 0;
  private closing = false;
  private exited = false;
  private watching = false;

  constructor(private readonly o: HostOptions) {
    this.config = o.config ?? "ds-flash";       // the app's default (cli/app.ts)
    this.lang = o.lang === "en" ? "en" : "zh";
    this.resumed = fs.existsSync(path.join(sessionDir(o.dir, o.sessionId), "session.jsonl"));
    this.log = new SessionLog(o.dir, o.sessionId, (ev) => o.out(ev));
  }

  get busy(): boolean { return this.running !== null || this.current !== null || this.flows > 0; }
  private get runs() { return path.join(sessionDir(this.o.dir, this.o.sessionId), "runs"); }
  private get linger() { return this.o.linger ?? LINGER_S; }
  private t(zh: string, en: string) { return this.lang === "en" ? en : zh; }

  /** A transient event: no seq, not stored. */
  private send(body: Record<string, unknown>) { this.o.out({ t: Date.now() / 1000, session_id: this.o.sessionId, ...body }); }

  /** Every error's text, stored or not, passes here: no key value from the environment ever reaches the app or the file. */
  private refuse(code: ErrorCode, text: string, control?: string) { this.send({ kind: "session.error", code, text: redactKeys(text), ...(control ? { control } : {}) }); }
  private fail(code: ErrorCode, text: string, ids: { msg_id?: string; reply_to: string }) { this.log.emit({ kind: "session.error", code, text: redactKeys(text).slice(0, 300), ...ids }); }

  /** The session interface's version only: this process speaks no other (the run's events and controls are app-run's).
   *  Then, on a resumed session, every task the last process left without an end gets one (recover). */
  start() {
    this.send({ kind: "session.start", session_id: this.o.sessionId, protocol: { session: PROTOCOL.session }, last_seq: this.log.lastSeq, resumed: this.resumed });
    if (this.resumed) this.recover();
  }

  /** The last process went away mid-task or while an executor lingered: a task with no session.task_end gets one, from
   *  its run's task_done when the run has one, else `interrupted` (its executor, if it still runs, is stopped first); a
   *  task with no session.task_closed is closed (session_end: that executor is gone with its process). */
  private recover() {
    const ended = new Set<string>(), closed = new Set<string>(), started: string[] = [];
    for (const e of this.log.events) {
      if (e.kind === "session.task") started.push(e.run_id);
      if (e.kind === "session.task_end") ended.add(e.run_id);
      if (e.kind === "session.task_closed") closed.add(e.run_id);
    }
    for (const runId of started) {
      if (!ended.has(runId)) {
        const evs = readRunEvents(path.join(this.runs, runId, "events.jsonl"));
        const done = [...evs].reverse().find((e) => e.kind === "task_done");
        const steers = evs.filter((e) => e.kind === "steered").map((e) => String(e.text));
        if (done) this.log.emit(endFrom(runId, done, "none", steers));
        else {
          const own = computerOwner(this.o.dir);
          if (own?.run_id === runId && own.executor_pid && alive(own.executor_pid)) { try { process.kill(own.executor_pid, "SIGTERM"); } catch { /* gone meanwhile */ } }
          this.log.emit({ kind: "session.task_end", run_id: runId, status: "interrupted", reason: "the session process went away before the task ended", summary: "", undo: "none", ...(steers.length ? { steers } : {}) });
        }
      }
      if (!closed.has(runId)) this.log.emit({ kind: "session.task_closed", run_id: runId, why: "session_end" });
    }
  }

  /** The header's settings, read after the process started (resume with `--session`, then a header line). A value of
   *  the wrong type is refused (bad_config) and changes nothing. */
  configure(h: Record<string, unknown>) {
    const bad = headerProblem(h);
    if (bad) return this.refuse("bad_config", bad);
    if (typeof h.config === "string") this.config = h.config;
    if (h.lang === "zh" || h.lang === "en") this.lang = h.lang;
    if (typeof h.driver === "string") this.o.driver = h.driver;
    if (typeof h.scope === "string") this.o.scope = h.scope;
  }

  handle(line: string) {
    if (this.exited || !line.trim()) return;
    const c = parseSessionControl(line);
    if (!c) return;
    switch (c.type) {
      case "say": return this.say(c.text);
      case "stop": return this.stop(c.run_id);
      case "attach": return c.run_id ? this.attachRun(c.run_id, c.after_seq) : this.attach(c.after_seq);
      case "end": return this.end();
      case "cua": return this.cua(c.text, c.scope);
      case "steer": return this.steer(c.text, c.run_id);
      case "answer": return this.answer(c.line, c.run_id);
      case "respond": return this.respond(c.line, c.run_id);
      case "retry": return this.retry();
      case "queue_edit": { const it = this.queue.find((q) => q.id === c.id); if (it && c.text.trim() && c.text.length <= MAX_USER_CHARS) it.text = c.text; return this.emitQueue(); }
      case "queue_cancel": this.queue = this.queue.filter((q) => q.id !== c.id); return this.emitQueue();
      case "queue_send_now": return this.sendNow(c.id);
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

  private tooLong(text: string, control: string): boolean {
    if (text.length <= MAX_USER_CHARS) return false;
    this.refuse("too_long", `a message is at most ${MAX_USER_CHARS} characters; this one has ${text.length}`, control);
    return true;
  }
  private refuseBusy(control: string) { this.refuse("busy", this.t("上一条回复还没完：先停下它，或者等它说完", "a reply is still coming; stop it first or wait"), control); }
  private refuseCard(control: string) { this.refuse("card_open", this.t("任务在等你回答卡片：先在卡片上回答", "the task is waiting for your answer on its card; answer it there first"), control); }

  say(text: string) {
    if (this.closing || !text.trim() || this.tooLong(text, "say")) return;
    // a task runs: the words wait in the queue (sent to the model after it), unless a card waits for the user
    if (this.current) {
      if (this.current.card) return this.refuseCard("say");
      this.queue.push({ id: `q_${randomUUID().slice(0, 8)}`, text });
      return this.emitQueue();
    }
    if (this.running || this.flows) return this.refuseBusy("say");
    const user = this.log.emit({ kind: "session.message", msg_id: newId(), role: "user", text }) as Extract<SessionEvent, { kind: "session.message" }>;
    this.startReply(user.msg_id);
  }

  /** Answer the last user message again: the replies to it so far leave the context (tasks stay: they happened); the
   *  message is not stored twice. */
  retry() {
    if (this.closing) return;
    if (this.current || this.running || this.flows) return this.refuseBusy("retry");
    const last = [...this.log.events].reverse().find((e): e is Extract<SessionEvent, { kind: "session.message" }> => e.kind === "session.message" && e.role === "user");
    if (!last) return;
    this.log.emit({ kind: "session.retry", reply_to: last.msg_id });
    this.startReply(last.msg_id);
  }

  /** One reply to `replyTo` (the newest user message). `maxTasks`: computer tasks it may start; `oneTurn`: the model
   *  speaks one turn (after a /cua). */
  private startReply(replyTo: string, o: { maxTasks?: number; oneTurn?: boolean } = {}) {
    const model = this.resolveModel();
    if ("code" in model) { this.fail(model.code, model.text, { reply_to: replyTo }); return this.afterActivity(); }
    const context = buildContext(this.log.messages(), { budgetChars: Math.floor((model.model.contextWindow ?? 128_000) * WINDOW_SHARE), lang: this.lang });
    const r: Running = { msgId: newId(), replyTo, abort: new AbortController(), sent: "", buffer: "", timer: null, done: Promise.resolve(), tasks: 0, maxTasks: o.maxTasks ?? MAX_TASKS, raw: null, cut: false };
    this.running = r;
    const spec = `${model.model.provider}|${model.model.id}`;
    // the reply has begun (the app shows "thinking" until text comes): an empty delta at offset 0
    this.send({ kind: "session.delta", msg_id: r.msgId, text: "", offset: 0 });
    const onDelta = (d: string) => { r.buffer += d; if (!r.timer) r.timer = setTimeout(() => this.flush(r), this.o.coalesceMs ?? 50); };
    // a turn after a task: a new bubble, begun with an empty delta
    const onTurnStart = (n: number) => { r.cut = false; if (n > 0) this.send({ kind: "session.delta", msg_id: r.msgId, text: "", offset: 0 }); };
    // a turn that calls computer_task: its words are a message of their own, before the task
    const onTurnEnd = (text: string) => {
      this.settle(r, text);
      if (text) this.log.emit({ kind: "session.message", msg_id: r.msgId, role: "assistant", text, reply_to: r.replyTo, model: spec });
      r.msgId = newId(); r.sent = ""; r.buffer = ""; r.cut = true;
    };
    r.done = reply({ model, context, signal: r.abort.signal, maxChars: MAX_ASSISTANT_CHARS, onDelta, tools: [this.computerTask(r)], onTurnStart, onTurnEnd, endNow: () => this.closing, ...(o.oneTurn ? { oneTurn: true } : {}) }).then((res) => {
      if (r.timer) { clearTimeout(r.timer); r.timer = null; }
      this.recordCalls(r, res);
      if (res.ended === "error") {
        r.buffer = "";
        this.fail(res.error!.code, res.error!.text, { msg_id: r.msgId, reply_to: r.replyTo });
      } else if (!r.cut && !(r.tasks && !res.text)) {
        // (a last turn that called a tool stored its words already; nothing said after a task is nothing to store)
        this.settle(r, res.text);
        this.log.emit({ kind: "session.message", msg_id: r.msgId, role: "assistant", text: res.text, reply_to: r.replyTo, model: res.model,
          ...(res.ended === "stopped" ? { stopped: true } : {}), ...(res.ended === "truncated" ? { truncated: true } : {}) });
      }
    }, (e) => {
      this.fail("network", String(e instanceof Error ? e.message : e), { msg_id: r.msgId, reply_to: r.replyTo });
    }).finally(() => { this.running = null; this.afterActivity(); this.maybeExit(); });
  }

  /** The deltas sent for this message say `text`: a service that sent less than the whole gets the rest as one more
   *  delta; one whose final text is not what was streamed gets the whole text again, at offset 0. */
  private settle(r: Running, text: string) {
    this.flush(r);
    if (text.length > r.sent.length && text.startsWith(r.sent)) { r.buffer = text.slice(r.sent.length); this.flush(r); }
    else if (!text.startsWith(r.sent)) { r.sent = text; this.send({ kind: "session.delta", msg_id: r.msgId, text, offset: 0 }); }
  }

  /** The model's one tool: a computer task, the user's own words since the last task as its request, the goal as the
   *  restatement beside them. The call stays pending until the task ends. */
  private computerTask(r: Running): AgentTool<any> {
    const en = this.lang === "en";
    const result = (text: string, isError = false): AgentToolResult<undefined> => ({ content: [{ type: "text", text }], details: undefined, ...(isError ? { isError: true } : {}) });
    return {
      name: COMPUTER_TASK, label: en ? "computer task" : "电脑任务",
      description: en
        ? "Do something on this Mac (apps, files, web pages, messages). goal: your restatement of what the user wants done; the user's own words go to the task as they are. Waits until the task ends and returns {status, reason, summary, answer, changes, undo, steers}. Only status succeeded means it was done."
        : "在这台 Mac 上做事（应用、文件、网页、消息）。goal：你对用户要做的事的转述；用户自己的原话会原样交给任务。等任务结束后返回 {status, reason, summary, answer, changes, undo, steers}。只有 status 是 succeeded 才算做成了。",
      parameters: Type.Object({ goal: Type.String({ description: en ? "what to do, in your words" : "要做的事，你的转述" }) }),
      execute: async (_id: string, p: { goal: string }) => {
        if (this.closing) return result(en ? "the session is ending" : "会话正在结束", true);
        if (r.tasks >= r.maxTasks) return result(r.maxTasks === 0
          ? (en ? "This task was started by the user with /cua; its result is above. Do not start another; tell the user the result." : "这个任务是用户用 /cua 直接开的，结果在上面。不要再开任务，直接告诉用户结果。")
          : (en ? `This message has started ${MAX_TASKS} computer tasks already; no more. Tell the user where things stand.` : `这条消息已经开过 ${MAX_TASKS} 个电脑任务了，不能再开。告诉用户现在的情况。`), true);
        r.raw ??= cutRaw(this.log.userWordsSinceTask() || this.lastUserText());
        const goal = typeof p.goal === "string" ? p.goal.slice(0, 4000) : "";
        const t = this.startTask({ raw: r.raw, ...(goal.trim() ? { goal } : {}), by: "model", replyTo: r.replyTo });
        if ("busy" in t) return result(en ? "The computer is being used by another session. Try again when it is done." : "电脑正被另一个会话使用，等它做完再试。", true);
        r.tasks += 1;
        const end = await t.ended;
        if (this.closing) r.abort.abort();             // the app went away: no more turns
        return result(taskView(end));
      },
    } as AgentTool<any>;
  }

  private lastUserText(): string {
    const m = [...this.log.events].reverse().find((e): e is Extract<SessionEvent, { kind: "session.message" }> => e.kind === "session.message" && e.role === "user");
    return m?.text ?? "";
  }

  /** `/cua <text>`: a computer task with the user's words, no model in between; then the model speaks one turn with
   *  the task's call and result in its context. */
  cua(text: string, scope?: string) {
    if (this.closing || !text.trim() || this.tooLong(text, "cua")) return;
    if (this.current || this.running || this.flows) return this.refuseBusy("cua");
    let userId = "";
    const t = this.startTask({ raw: cutRaw(text), by: "slash", ...(scope ? { scope } : {}), before: () => {
      userId = (this.log.emit({ kind: "session.message", msg_id: newId(), role: "user", text, via: "cua" }) as Extract<SessionEvent, { kind: "session.message" }>).msg_id;
      return userId;
    } });
    if ("busy" in t) return this.refuse("computer_busy", this.t("电脑正被另一个会话使用", "the computer is being used by another session"), "cua");
    this.flows += 1;
    void t.ended.then(() => {
      this.flows -= 1;
      if (this.closing) return this.maybeExit();
      this.startReply(userId, { maxTasks: 0, oneTurn: true });
    });
  }

  /** Start a computer task, or say the machine is busy. `before`: what to store first once the lock is ours (the /cua
   *  user message), giving the user message the task answers. */
  private startTask(o: { raw: string; goal?: string; by: "slash" | "model"; replyTo?: string; scope?: string; before?: () => string }): Task | { busy: true } {
    const runId = `run_${randomUUID().slice(0, 8)}`;
    const lock = takeComputer(this.o.dir, { pid: process.pid, session_id: this.o.sessionId, run_id: runId });
    if ("busy" in lock) return { busy: true };
    // a new computer task on this Mac: undo expires for every lingering executor — this session's now, the other
    // sessions' when they see computer.last change
    for (const t of this.tasks.values()) if (t.state !== "running") this.closeTask(t, "new_task");
    setLastTask(this.o.dir, runId, this.o.sessionId);
    const replyTo = o.before?.() ?? o.replyTo;
    this.log.emit({ kind: "session.task", msg_id: newId(), run_id: runId, raw: o.raw, ...(o.goal ? { goal: o.goal } : {}), by: o.by, ...(replyTo ? { reply_to: replyTo } : {}) });
    const scope = o.scope ?? this.o.scope;
    const request = { run_id: runId, raw: o.raw, ...(o.goal ? { context: o.goal } : {}), config: this.config, lang: this.lang, ...(this.o.driver ? { driver: this.o.driver } : {}), ...(scope ? { scope } : {}) };
    let resolve!: (e: TaskEnd) => void;
    const ended = new Promise<TaskEnd>((res) => { resolve = res; });
    let handle: ExecutorHandle;
    try { handle = (this.o.launch ?? spawnExecutor)(request, { runs: this.runs, runId, linger: this.linger }); }
    catch (e) { handle = { write: () => {}, close: () => {}, onLine: () => {}, exited: Promise.resolve({ code: null, signal: `spawn: ${e instanceof Error ? e.message : String(e)}` }) }; }
    lock.setExecutor(handle.pid);
    const task: Task = { runId, handle, lock, undoLock: null, state: "running", card: null, steers: [], end: null, ended, resolve, exitTimer: null };
    this.current = task;
    this.tasks.set(runId, task);
    handle.onLine((l) => this.onExecutorLine(task, l));
    void handle.exited.then((x) => this.onExecutorExit(task, x));
    return task;
  }

  /** An executor's event: to the app as it is (plus the session), and what the session follows of it. */
  private onExecutorLine(task: Task, line: string) {
    let ev: Record<string, unknown>;
    try { const j = JSON.parse(line); if (!j || typeof j !== "object" || Array.isArray(j)) return; ev = j; } catch { return; }
    this.o.out({ ...ev, session_id: this.o.sessionId });
    switch (ev.kind) {
      case "ask": task.card = typeof ev.ask_id === "string" ? ev.ask_id : null; break;
      case "resumed": case "ask_void": if (ev.ask_id === task.card) task.card = null; break;
      case "steered": if (typeof ev.text === "string") task.steers.push(ev.text); break;
      case "task_done": this.taskDone(task, ev); break;
      case "result_response":
        if (typeof ev.undone === "number" && typeof ev.total === "number") this.log.emit({ kind: "session.task_undo", run_id: task.runId, undone: ev.undone, total: ev.total, refused: typeof ev.refused === "string" ? ev.refused : null });
        task.undoLock?.release(); task.undoLock = null;
        break;
    }
  }

  private taskDone(task: Task, ev: Record<string, unknown>) {
    task.card = null;
    task.lock?.release(); task.lock = null;
    if (task.end) return;                                // the session had to end it already (the app went away)
    const card = ev.result_card as { options?: { kind?: string }[] } | null | undefined;
    const undo = this.linger > 0 && !!card?.options?.some((x) => x.kind === "undo") ? "open" : "none";
    this.recordEnd(task, endFrom(task.runId, ev, undo, task.steers));
    if (task.state === "running") task.state = card && this.linger > 0 ? "lingering" : "ending";
    if (task.state === "lingering") this.watchLast();
  }

  private recordEnd(task: Task, body: TaskEnd) {
    if (task.exitTimer) { clearTimeout(task.exitTimer); task.exitTimer = null; }
    this.log.emit(body);
    task.end = body;
    if (this.current === task) this.current = null;
    // after a stop the queued words are not sent by themselves: the user says whether to
    if (body.status === "stopped" && this.queue.length) {
      for (const q of this.queue) { q.held = true; q.note = this.t("任务已停，要发吗？", "The task was stopped. Send this?"); }
      this.emitQueue();
    }
    task.resolve(body);
  }

  private onExecutorExit(task: Task, x: { code: number | null; signal: string | null }) {
    task.lock?.release(); task.lock = null;
    task.undoLock?.release(); task.undoLock = null;
    if (!task.end) {
      this.recordEnd(task, { kind: "session.task_end", run_id: task.runId, status: "failed", reason: `the executor exited (${x.signal ?? `code ${x.code}`}) before the task ended`, summary: "", undo: "none", ...(task.steers.length ? { steers: task.steers } : {}) });
    }
    if (task.state !== "closed") { task.state = "closed"; this.log.emit({ kind: "session.task_closed", run_id: task.runId, why: "linger" }); }
    this.tasks.delete(task.runId);
    this.watchLast();
    this.maybeExit();
  }

  /** Close an executor's stdin: its result card can no longer be answered. */
  private closeTask(task: Task, why: "new_task" | "session_end") {
    if (task.state === "closed") return;
    task.state = "closed";
    task.handle.close();
    this.log.emit({ kind: "session.task_closed", run_id: task.runId, why });
  }

  /** While an executor lingers, `computer.last` is watched: another run there means a new computer task started on
   *  this Mac, and undo has expired. */
  private watchLast() {
    const any = [...this.tasks.values()].some((t) => t.state === "lingering");
    const file = computerLastFile(this.o.dir);
    if (any && !this.watching) { this.watching = true; fs.watchFile(file, { interval: this.o.watchMs ?? 500, persistent: false }, this.onLast); }
    if (!any && this.watching) { this.watching = false; fs.unwatchFile(file, this.onLast); }
  }
  private readonly onLast = () => this.checkLast();
  private checkLast() {
    const last = lastTask(this.o.dir);
    for (const t of this.tasks.values()) if (t.state === "lingering" && last && last.run_id !== t.runId) this.closeTask(t, "new_task");
    this.watchLast();
  }

  /** The executor's control lines, to the task they name (or the running one). */
  private find(runId: string | undefined, control: string): Task | null {
    const t = runId ? this.tasks.get(runId) : this.current;
    if (t && t.state !== "closed") return t;
    this.refuse("no_task", runId ? `no task ${runId.slice(0, 80)} of this session can take ${control}` : `no task is running`, control);
    return null;
  }

  answer(line: Record<string, unknown>, runId?: string) {
    const t = this.find(runId, "answer");
    if (t) t.handle.write(JSON.stringify(line));
  }

  /** The result card's answer (undo): to the lingering executor, holding the machine lock while it runs — unless
   *  another task started on this Mac since (undo expired). */
  respond(line: Record<string, unknown>, runId?: string) {
    const t = runId ? this.tasks.get(runId) : [...this.tasks.values()].reverse().find((x) => x.state === "lingering");
    if (!t || t.state !== "lingering") return this.refuse("no_task", "no result card of this session is waiting", "respond");
    if (t.undoLock) return;                              // one respond per card: the executor reads only the first
    this.checkLast();
    if (t.state !== "lingering") return this.refuse("undo_expired", this.t("另一个电脑任务开始了，这个任务的撤回已经过期", "another computer task started on this Mac; this task's undo has expired"), "respond");
    const l = takeComputer(this.o.dir, { pid: process.pid, session_id: this.o.sessionId, run_id: t.runId, undo: true });
    if ("busy" in l) return this.refuse("computer_busy", this.t("电脑正被另一个会话使用", "the computer is being used by another session"), "respond");
    l.setExecutor(t.handle.pid);
    t.undoLock = l;
    t.handle.write(JSON.stringify(line));
  }

  /** The user's words into the running task (control v1 steer). */
  steer(text: string, runId?: string) {
    if (this.closing || !text.trim() || this.tooLong(text, "steer")) return;
    const t = this.current;
    if (!t || (runId && runId !== t.runId)) return this.refuse("no_task", "no task is running", "steer");
    if (t.card) return this.refuseCard("steer");
    t.handle.write(JSON.stringify({ type: "steer", text }));
    this.log.emit({ kind: "session.steer", run_id: t.runId, text });
  }

  private sendNow(id: string) {
    const it = this.queue.find((q) => q.id === id);
    if (!it) return this.emitQueue();
    if (this.current) {
      if (this.current.card) return this.refuseCard("queue_send_now");
      this.queue = this.queue.filter((q) => q !== it);
      this.emitQueue();
      return this.steer(it.text);
    }
    if (this.running || this.flows) return this.refuseBusy("queue_send_now");
    this.queue = this.queue.filter((q) => q !== it);
    this.emitQueue();
    this.say(it.text);
  }

  private emitQueue() { this.send({ kind: "session.queue", items: this.queue.map((q) => ({ ...q })) }); }

  /** Nothing runs any more: the queued words (not held after a stop) go to the model, in order, as one turn. */
  private afterActivity() {
    if (this.closing || this.running || this.current || this.flows) return;
    const go = this.queue.filter((q) => !q.held);
    if (!go.length) return;
    this.queue = this.queue.filter((q) => q.held);
    this.emitQueue();
    let last = "";
    for (const q of go) last = (this.log.emit({ kind: "session.message", msg_id: newId(), role: "user", text: q.text, via: "queue" }) as Extract<SessionEvent, { kind: "session.message" }>).msg_id;
    this.startReply(last);
  }

  /** Each model call of the reply, one line in the session's model_calls.jsonl (role "session"; as a run's, cli/app.ts). */
  private recordCalls(r: Running, res: ReplyResult) {
    for (const c of res.calls) {
      const outcome = c.stop === "error" || (res.ended === "error" && c === res.calls[res.calls.length - 1]) ? "error" : c.stop === "aborted" || (res.ended === "stopped" && c === res.calls[res.calls.length - 1]) ? "aborted" : "answered";
      const err = c.error ?? (outcome === "error" ? res.error?.text : undefined);
      const rec: ModelCallRecord = { kind: "model.call", call_id: `mc_${randomUUID().slice(0, 8)}`, started_at: c.started_at, role: "session", backend: "pi-ai", model: res.model,
        outcome, tokens_in: c.tokens_in, tokens_out: c.tokens_out, cache_read: c.cache_read,
        cost_usd: c.cost_usd, ...(c.cost_estimated ? { cost_estimated: true } : {}), latency_ms: c.latency_ms, sent_chars: c.sent_chars, msg_id: r.msgId, reply_to: r.replyTo,
        ...(err ? { error: err } : {}) };
      try {
        const fd = fs.openSync(path.join(sessionDir(this.o.dir, this.o.sessionId), "model_calls.jsonl"), "a", 0o600);
        try { fs.writeSync(fd, JSON.stringify(rec) + "\n"); } finally { fs.closeSync(fd); }
      } catch { /* recording never stops a reply */ }
    }
  }

  private flush(r: Running) {
    if (r.timer) { clearTimeout(r.timer); r.timer = null; }
    if (!r.buffer) return;
    const text = r.buffer; r.buffer = "";
    this.send({ kind: "session.delta", msg_id: r.msgId, text, offset: r.sent.length });
    r.sent += text;
  }

  /** `stop{run_id}`: that task (running, or lingering: its result card is let go). Without: the running task, else
   *  the reply (what came so far is stored with `stopped: true`). */
  stop(runId?: string) {
    if (runId) { const t = this.find(runId, "stop"); if (t) t.handle.write(JSON.stringify({ type: "stop" })); return; }
    if (this.current) return this.current.handle.write(JSON.stringify({ type: "stop" }));
    this.running?.abort.abort();
  }

  /** Replay every stored event after `afterSeq`, then, while a reply is coming, its text so far (one delta at offset 0),
   *  and the queue when it holds anything. */
  attach(afterSeq: number) {
    for (const ev of this.log.since(afterSeq)) this.o.out(ev);
    const r = this.running;
    if (r) { this.flush(r); this.send({ kind: "session.delta", msg_id: r.msgId, text: r.sent, offset: 0 }); }
    if (this.queue.length) this.emitQueue();
  }

  /** A task's events after `afterSeq`, from its run's events.jsonl (with the session id, as they were sent): an app
   *  that reconnects says the last seq it saw of each run. A run this session never started is no_task. */
  attachRun(runId: string, afterSeq: number) {
    if (!this.log.events.some((e) => e.kind === "session.task" && e.run_id === runId)) return this.refuse("no_task", `no task ${runId.slice(0, 80)} in this session`, "attach");
    for (const ev of readRunEvents(path.join(this.runs, runId, "events.jsonl"))) if (typeof ev.seq === "number" && ev.seq > afterSeq) this.o.out({ ...ev, session_id: this.o.sessionId });
  }

  /** The app said end (or a signal): the running task is stopped (as when the app goes away), the reply stopped and
   *  stored, then exit. */
  end() { this.closing = true; this.stopForExit(); this.running?.abort.abort(); this.maybeExit(); }

  /** stdin closed: a running task is stopped and its end waited for (12 s); a reply is let finish and stored; then exit. */
  inputClosed() { this.closing = true; this.stopForExit(); this.maybeExit(); }

  private stopForExit() {
    const t = this.current;
    if (!t || t.exitTimer || t.end) return;
    t.handle.write(JSON.stringify({ type: "stop" }));
    // no task_done in time: recorded as stopped all the same. Its executor may still be acting: the machine lock stays
    // with it (its pid is in the lock) until it exits
    t.exitTimer = setTimeout(() => {
      t.exitTimer = null;
      if (!t.end) this.recordEnd(t, { kind: "session.task_end", run_id: t.runId, status: "stopped", reason: "the app went away; the task did not confirm the stop in time", summary: "", undo: "none", ...(t.steers.length ? { steers: t.steers } : {}) });
      this.maybeExit();
    }, this.o.exitWaitMs ?? EXIT_WAIT_MS);
  }

  /** Resolves when no reply, task or /cua runs. */
  async idle(): Promise<void> { while (this.busy) { if (this.running) await this.running.done; else await sleep(10); } }

  private maybeExit() {
    if (!this.closing || this.running || this.current || this.flows || this.exited) return;
    this.exited = true;
    const open = [...this.tasks.values()];
    for (const t of open) this.closeTask(t, "session_end");
    if (this.watching) { this.watching = false; fs.unwatchFile(computerLastFile(this.o.dir), this.onLast); }
    // the executors read their stdin's end and exit; one that does not is not waited for long
    void Promise.race([Promise.all(open.map((t) => t.handle.exited)), sleep(2000)]).then(() => this.o.onExit?.());
  }
}

/** A run's events.jsonl, as far as it reads. */
function readRunEvents(file: string): Record<string, unknown>[] {
  try { return fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; }
}

/** session.task_end from the executor's task_done. */
function endFrom(runId: string, ev: Record<string, unknown>, undo: "open" | "none", steers: string[]): TaskEnd {
  const changes = capChanges(ev.changes as Record<string, unknown> | undefined);
  return { kind: "session.task_end", run_id: runId, status: String(ev.status ?? "failed"), summary: typeof ev.summary === "string" ? ev.summary : "", undo,
    ...(typeof ev.reason === "string" && ev.reason ? { reason: ev.reason.slice(0, 500) } : {}), ...(typeof ev.answer === "string" ? { answer: ev.answer } : {}),
    ...(changes ? { changes } : {}), ...(steers.length ? { steers } : {}) };
}

/** One process per session: `sessions/<sid>/lock` holds the pid, created whole and at once (task.ts linkLock); a lock
 *  whose process is gone is taken over. */
export function acquireLock(dir: string, sessionId: string): { ok: true; release: () => void } | { ok: false; pid: number } {
  const l = linkLock(path.join(sessionDir(dir, sessionId), "lock"), String(process.pid), (held) => alive(Number(held)));
  return l.ok ? { ok: true, release: l.release } : { ok: false, pid: Number(l.held) || 0 };
}

/** What is wrong with a header (`{session_id?, config?, lang?, driver?, scope?}`), or null. Each field, when present,
 *  is a string; the session id a folder name; lang zh or en. */
export function headerProblem(h: Record<string, unknown>): string | null {
  for (const k of ["session_id", "config", "lang", "driver", "scope"]) if (h[k] !== undefined && typeof h[k] !== "string") return `${k} must be a string`;
  if (typeof h.session_id === "string" && !SESSION_ID.test(h.session_id)) return `bad session id ${JSON.stringify(h.session_id).slice(0, 80)}: letters, digits, _ and - only, at most 64`;
  if (h.lang !== undefined && h.lang !== "zh" && h.lang !== "en") return `lang must be zh or en`;
  return null;
}
