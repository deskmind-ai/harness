/**
 * The session process's core (docs/protocol.md 「会话（第 1 版）」): one per chat session, long-lived. It reads control
 * lines, keeps the history (log.ts), runs one reply at a time (loop.ts) over the built context (context.ts), and writes
 * events: the stored ones with their `seq`, the transient ones (start, deltas, refusals, the queue, duplicates) without.
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
import { EXIT_WAIT_MS, LINGER_S, alive, cutRaw, linkLock, spawnExecutor, type ExecutorHandle, type Launcher } from "./task.js";
import { acquire, endTree, free, held, inProcess, linger, readHolder, reapLater, release, undo, type Holder } from "./computer.js";
import type { ModelCallRecord } from "../otel/context.js";
import { STOP_CAUSES, type StopCause } from "../protocol/computer.js";

/** The first stdin line: which session, and the settings for this process. `driver` and `scope` (H2) go into every
 *  computer task's request: the executor's driver (sim | hands) and the task folder. */
export interface SessionHeader { session_id?: string; config?: string; lang?: Lang; driver?: string; scope?: string }

/** `client_id` (additive, optional, on say / cua / steer): the app's own id for the words it sends. The session gives
 *  it back on whatever becomes of them — the stored user message (or session.steer), the queue entry they wait in, and
 *  a refusal of the line — so the app knows its words' fate from the session, never from the helper's ack. */
export type ClientId = { client_id?: string };

export type SessionControl =
  | ({ type: "say"; text: string } & ClientId)
  | { type: "stop"; run_id?: string }
  | { type: "attach"; after_seq: number; run_id?: string }
  | { type: "end" }
  | ({ type: "cua"; text: string; scope?: string } & ClientId)
  | ({ type: "steer"; text: string; run_id?: string } & ClientId)
  | { type: "answer"; run_id?: string; line: Record<string, unknown> }
  | { type: "respond"; run_id?: string; line: Record<string, unknown> }
  | { type: "retry" }
  | { type: "queue_edit"; id: string; text: string }
  | { type: "queue_cancel"; id: string }
  | { type: "queue_send_now"; id: string };

/** The longest client_id kept (a longer one is ignored, as if absent). */
export const MAX_CLIENT_ID = 100;

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
  const cid = typeof o.client_id === "string" && o.client_id && o.client_id.length <= MAX_CLIENT_ID ? { client_id: o.client_id } : {};
  switch (o.type) {
    case "say": return str("text") ? { type: "say", text: o.text as string, ...cid } : null;
    case "stop": return { type: "stop", ...runId };
    case "attach": return { type: "attach", after_seq: typeof o.after_seq === "number" && Number.isFinite(o.after_seq) && o.after_seq > 0 ? Math.floor(o.after_seq) : 0, ...runId };
    case "end": return { type: "end" };
    case "cua": return str("text") ? { type: "cua", text: o.text as string, ...(str("scope") ? { scope: o.scope as string } : {}), ...cid } : null;
    case "steer": return str("text") ? { type: "steer", text: o.text as string, ...runId, ...cid } : null;
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
  /** A task of this reply was stopped by the user: no more tasks in it; `final`: the model's last turn (its words about
   *  the stop) is under way, and the reply ends after it. */
  stopped: boolean; final: boolean;
}

type TaskEnd = Extract<SessionBody, { kind: "session.task_end" }>;
interface Task {
  runId: string; handle: ExecutorHandle;
  /** Its process group, as the machine lock names it (0: an executor inside this process). */
  pgid: number;
  /** The machine lock as this task last wrote it: every change of it is made from exactly this (compare-and-set). */
  holder: Holder | null;
  /** An answer to its result card was sent (the executor reads only the first). */
  responded: boolean;
  /** Its executor said task_done (not only the session, when the app went away). */
  sawDone: boolean;
  /** How many options its result card has (a respond's option must be one of them). */
  options: number;
  /** running: until task_done; lingering: its result card can be answered; ending: it exits by itself; closed. */
  state: "running" | "lingering" | "ending" | "closed";
  /** The card waiting for the user (an ask with no resumed / ask_void yet). */
  card: string | null;
  steers: string[];
  end: TaskEnd | null;
  ended: Promise<TaskEnd>;
  resolve: (e: TaskEnd) => void;
  exitTimer: NodeJS.Timeout | null;
  /** Steps it began (`step`) with no `step_result` yet: an end the session writes itself while one is open says its
   *  result is unknown (cause last_step_unknown). */
  openSteps: Set<string>;
  /** Closed (its stdin) but its session.task_closed could not be stored then: stored when its executor exits. */
  unrecordedClose: "new_task" | "session_end" | null;
  /** Its lock could not be set lingering at task_done: it does not linger (its card is not offered; it exits now). */
  noLinger?: boolean;
}

export interface QueueItem { id: string; text: string; held?: boolean; note?: string; client_id?: string }

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

  constructor(private readonly o: HostOptions) {
    this.config = o.config ?? "ds-flash";       // the app's default (cli/app.ts)
    this.lang = o.lang === "en" ? "en" : "zh";
    this.resumed = fs.existsSync(path.join(sessionDir(o.dir, o.sessionId), "session.jsonl"));
    this.log = new SessionLog(o.dir, o.sessionId, (ev) => { this.noteTaken(ev); o.out(ev); });
    for (const ev of this.log.events) this.noteTaken(ev);
  }

  /** The client_ids of the app's words the history holds (a stored user message or session.steer), with their seq:
   *  read back from session.jsonl on start, kept as new ones are stored. A say / cua / steer naming one of them is a
   *  repeat (the app sent again words whose answer it missed): it is not acted on again (sendsDuplicate). */
  private readonly taken = new Map<string, number>();
  private noteTaken(ev: SessionEvent) {
    const cid = (ev as { client_id?: unknown }).client_id;
    if (typeof cid !== "string" || !cid) return;
    if ((ev.kind === "session.message" && ev.role === "user") || ev.kind === "session.steer") this.taken.set(cid, ev.seq);
  }

  /** The app's words with this client_id were taken already (stored, or waiting in the queue): say so again, with
   *  where they are (`session.duplicate` with the stored seq, or the queue as it is), and do nothing else. */
  private sendsDuplicate(cid: string | undefined, control: string): boolean {
    if (!cid) return false;
    const seq = this.taken.get(cid);
    if (seq !== undefined) { this.send({ kind: "session.duplicate", client_id: cid, control, seq }); return true; }
    if (this.queue.some((q) => q.client_id === cid)) { this.emitQueue(); return true; }
    return false;
  }

  get busy(): boolean { return this.running !== null || this.current !== null || this.flows > 0; }
  private get runs() { return path.join(sessionDir(this.o.dir, this.o.sessionId), "runs"); }
  private get linger() { return this.o.linger ?? LINGER_S; }
  private t(zh: string, en: string) { return this.lang === "en" ? en : zh; }

  /** A transient event: no seq, not stored. */
  private send(body: Record<string, unknown>) { this.o.out({ t: Date.now() / 1000, session_id: this.o.sessionId, ...body }); }

  /** Every error's text, stored or not, passes here: no key value from the environment ever reaches the app or the file. */
  private refuse(code: ErrorCode, text: string, control?: string, cid?: string) {
    this.send({ kind: "session.error", code, text: redactKeys(text), ...(control ? { control } : {}), ...(cid ? { client_id: cid } : {}) });
  }
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
      // (each run on its own: one whose records cannot be stored does not keep the others' executors running)
      try {
        if (!ended.has(runId)) {
          const evs = readRunEvents(path.join(this.runs, runId, "events.jsonl"));
          const done = [...evs].reverse().find((e) => e.kind === "task_done");
          const steers = evs.filter((e) => e.kind === "steered").map((e) => String(e.text));
          if (done) this.log.emit(endFrom(runId, done, "none", steers));
          else {
            // its executor still runs (the lock names it): stopped, and its own end waited for (its changes are the truth)
            const own = readHolder(this.o.dir);
            if (own?.run_id === runId && own.session_id === this.o.sessionId && own.pgid > 0 && held(own)) {
              // the executor itself is asked to stop (its own stop, which ends its driver's step with a receipt); the
              // lock stays its group's until all of it is gone
              try { process.kill(own.pid, "SIGTERM"); } catch { /* gone meanwhile */ }
              this.recovering.push(this.awaitOldEnd(runId, () => held(own), !closed.has(runId)));
              continue;
            }
            this.log.emit(interrupted(runId, steers, evs));
          }
        }
        if (!closed.has(runId)) this.log.emit({ kind: "session.task_closed", run_id: runId, why: "session_end" });
      } catch (e) { process.stderr.write(`session: recovering ${runId}: ${errText(e)}\n`); }
    }
  }

  /** Ends recorded later by recover (an old executor that was still running). Tests wait on it. */
  readonly recovering: Promise<void>[] = [];
  /** Never rejects: the old group is ended first (when it did not end in time), then its end recorded — a record that
   *  cannot be stored is logged (the next resume tries again). */
  private async awaitOldEnd(runId: string, up: () => boolean, close: boolean) {
    const file = path.join(this.runs, runId, "events.jsonl");
    const t0 = Date.now();
    let done: Record<string, unknown> | undefined;
    for (;;) {
      const evs = readRunEvents(file);
      done = [...evs].reverse().find((e) => e.kind === "task_done");
      if (done || !up() || Date.now() - t0 > (this.o.exitWaitMs ?? EXIT_WAIT_MS)) {
        // not ended in time: what is left of its group is ended now (a resumed session's first task must not find it)
        if (!done && up()) { try { const own = readHolder(this.o.dir); if (own?.run_id === runId) endTree(own); } catch { /* the next task finds it */ } }
        if (!done) done = [...readRunEvents(file)].reverse().find((e) => e.kind === "task_done");
        const steers = readRunEvents(file).filter((e) => e.kind === "steered").map((e) => String(e.text));
        if (this.log.events.some((e) => e.kind === "session.task_end" && e.run_id === runId)) return;
        try {
          this.log.emit(done ? endFrom(runId, done, "none", steers) : interrupted(runId, steers, readRunEvents(file)));
          if (close) this.log.emit({ kind: "session.task_closed", run_id: runId, why: "session_end" });
        } catch (e) { process.stderr.write(`session: recovering ${runId}: ${errText(e)}\n`); }
        return;
      }
      await sleep(100);
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
      case "say": return this.say(c.text, c.client_id);
      case "stop": return this.stop(c.run_id);
      case "attach": return c.run_id ? this.attachRun(c.run_id, c.after_seq) : this.attach(c.after_seq);
      case "end": return this.end();
      case "cua": return this.cua(c.text, c.scope, c.client_id);
      case "steer": return this.steer(c.text, c.run_id, c.client_id);
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

  private tooLong(text: string, control: string, cid?: string): boolean {
    if (text.length <= MAX_USER_CHARS) return false;
    this.refuse("too_long", `a message is at most ${MAX_USER_CHARS} characters; this one has ${text.length}`, control, cid);
    return true;
  }
  private refuseBusy(control: string, cid?: string) { this.refuse("busy", this.t("上一条回复还没完：先停下它，或者等它说完", "a reply is still coming; stop it first or wait"), control, cid); }
  private refuseCard(control: string, cid?: string) { this.refuse("card_open", this.t("任务在等你回答卡片：先在卡片上回答", "the task is waiting for your answer on its card; answer it there first"), control, cid); }

  /** `fromQueue`: the queue's own entry sent now (queue_send_now): not a repeat of itself. */
  say(text: string, cid?: string, fromQueue = false) {
    if (this.closing || !text.trim() || (!fromQueue && this.sendsDuplicate(cid, "say")) || this.tooLong(text, "say", cid)) return;
    // a task runs: the words wait in the queue (sent to the model after it), unless a card waits for the user
    if (this.current) {
      if (this.current.card) return this.refuseCard("say", cid);
      this.queue.push({ id: `q_${randomUUID().slice(0, 8)}`, text, ...(cid ? { client_id: cid } : {}) });
      return this.emitQueue();
    }
    if (this.running || this.flows) return this.refuseBusy("say", cid);
    const user = this.log.emit({ kind: "session.message", msg_id: newId(), role: "user", text, ...(cid ? { client_id: cid } : {}) }) as Extract<SessionEvent, { kind: "session.message" }>;
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
    const r: Running = { msgId: newId(), replyTo, abort: new AbortController(), sent: "", buffer: "", timer: null, done: Promise.resolve(), tasks: 0, maxTasks: o.maxTasks ?? MAX_TASKS, raw: null, cut: false, stopped: false, final: false };
    this.running = r;
    const spec = `${model.model.provider}|${model.model.id}`;
    // the reply has begun (the app shows "thinking" until text comes): an empty delta at offset 0
    this.send({ kind: "session.delta", msg_id: r.msgId, text: "", offset: 0 });
    const onDelta = (d: string) => { r.buffer += d; if (!r.timer) r.timer = setTimeout(() => this.flush(r), this.o.coalesceMs ?? 50); };
    // a turn after a task: a new bubble, begun with an empty delta
    const onTurnStart = (n: number) => { r.cut = false; if (r.stopped) r.final = true; if (n > 0) this.send({ kind: "session.delta", msg_id: r.msgId, text: "", offset: 0 }); };
    // a turn that calls computer_task: its words are a message of their own, before the task
    const onTurnEnd = (text: string) => {
      this.settle(r, text);
      if (text) this.log.emit({ kind: "session.message", msg_id: r.msgId, role: "assistant", text, reply_to: r.replyTo, model: spec });
      r.msgId = newId(); r.sent = ""; r.buffer = ""; r.cut = true;
    };
    r.done = reply({ model, context, signal: r.abort.signal, maxChars: MAX_ASSISTANT_CHARS, onDelta, tools: [this.computerTask(r)], onTurnStart, onTurnEnd, endNow: () => this.closing || r.final, ...(o.oneTurn ? { oneTurn: true } : {}) }).then((res) => {
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
        // the user stopped a task of this reply: the reply does not start another (the user's stop is not overruled by
        // the model, whatever a page it read said)
        if (r.stopped) return result(en ? "The user stopped the task. Do not start another one in this reply; tell the user it stopped." : "用户停下了任务。这次回复不能再开任务，告诉用户已经停下。", true);
        if (r.tasks >= r.maxTasks) return result(r.maxTasks === 0
          ? (en ? "This task was started by the user with /cua; its result is above. Do not start another; tell the user the result." : "这个任务是用户用 /cua 直接开的，结果在上面。不要再开任务，直接告诉用户结果。")
          : (en ? `This message has started ${MAX_TASKS} computer tasks already; no more. Tell the user where things stand.` : `这条消息已经开过 ${MAX_TASKS} 个电脑任务了，不能再开。告诉用户现在的情况。`), true);
        if (r.raw === null) { const since = this.log.userWordsSinceTask(); r.raw = cutRaw(since.length ? since : [this.lastUserText()]); }
        const goal = typeof p.goal === "string" ? p.goal.slice(0, 4000) : "";
        const t = this.startTask({ raw: r.raw, ...(goal.trim() ? { goal } : {}), by: "model", replyTo: r.replyTo });
        if ("busy" in t) return result(en ? "The computer is being used by another session. Try again when it is done." : "电脑正被另一个会话使用，等它做完再试。", true);
        // (counted: a start that keeps failing is not tried more than a reply's tasks)
        r.tasks += 1;
        if ("failed" in t) return result(en ? `The task could not start (nothing was done on the computer): ${redactKeys(t.failed).slice(0, 300)}. Tell the user.` : `任务没能开始（电脑上什么都没做）：${redactKeys(t.failed).slice(0, 300)}。告诉用户。`, true);
        const end = await t.ended;
        if (end.status === "stopped") r.stopped = true;
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
  cua(text: string, scope?: string, cid?: string) {
    if (this.closing || !text.trim() || this.sendsDuplicate(cid, "cua") || this.tooLong(text, "cua", cid)) return;
    if (this.current || this.running || this.flows) return this.refuseBusy("cua", cid);
    let userId = "";
    const t = this.startTask({ raw: cutRaw([text]), by: "slash", ...(scope ? { scope } : {}), before: () => {
      userId = (this.log.emit({ kind: "session.message", msg_id: newId(), role: "user", text, via: "cua", ...(cid ? { client_id: cid } : {}) }) as Extract<SessionEvent, { kind: "session.message" }>).msg_id;
      return userId;
    } });
    // (words stored before the failure are the history's: the refusal does not name them again)
    if ("failed" in t) return this.refuse("busy", `the task could not start: ${t.failed}`, "cua", userId ? undefined : cid);
    if ("busy" in t) return this.refuse("computer_busy", this.t("电脑正被另一个会话使用", "the computer is being used by another session"), "cua", cid);
    this.flows += 1;
    void t.ended.then(() => {
      this.flows -= 1;
      if (this.closing) return this.maybeExit();
      this.startReply(userId, { maxTasks: 0, oneTurn: true });
    });
  }

  /** Start a computer task, say the machine is busy, or say why it could not start (`failed`). `before`: what to store
   *  first once the lock is ours (the /cua user message), giving the user message the task answers.
   *
   *  No failure on the way leaves the Mac held: whatever throws while the lock is taken, earlier result cards are
   *  closed or the task is recorded (a disk that is full), this attempt lets go of what it took — its executor (which
   *  never got its task) is ended and the lock it wrote removed, compare-and-set on that holder (computer.ts release) —
   *  and the caller is told `failed` with the reason; nothing says the task began. */
  private startTask(o: { raw: string; goal?: string; by: "slash" | "model"; replyTo?: string; scope?: string; before?: () => string }): Task | { busy: true } | { failed: string } {
    const runId = `run_${randomUUID().slice(0, 8)}`;
    const scope = o.scope ?? this.o.scope;
    const request = { run_id: runId, raw: o.raw, ...(o.goal ? { context: o.goal } : {}), config: this.config, lang: this.lang, ...(this.o.driver ? { driver: this.o.driver } : {}), ...(scope ? { scope } : {}) };
    // The machine lock (computer.ts): in one guarded step, a task acting anywhere on this Mac refuses this one, a
    // lingering one is ended (its undo expires: this session's own, or another's, or the helper's), and the executor is
    // started and named in the lock — before it is sent its task.
    let handle: ExecutorHandle | null = null, spawnError = "";
    let got: ReturnType<typeof acquire>;
    try {
      got = acquire(this.o.dir, { run_id: runId, session_id: this.o.sessionId, by: "session" }, () => {
        try { handle = (this.o.launch ?? spawnExecutor)(request, { runs: this.runs, runId, linger: this.linger }); }
        catch (e) { spawnError = e instanceof Error ? e.message : String(e); return null; }
        return { pid: handle.pid };
      });
    } catch (e) {
      // the lock could not be written (acquire ended a group it had started); an executor it started is let go here too
      const started = handle as ExecutorHandle | null;
      if (started) this.abandon(runId, started, null);
      return { failed: errText(e) };
    }
    if (!("ok" in got)) return { busy: true };
    const holder = got.holder;
    const pgid = holder?.pgid ?? 0;
    const started = handle as ExecutorHandle | null;
    const h: ExecutorHandle = started ?? { write: () => {}, close: () => {}, onLine: () => {}, exited: Promise.resolve({ code: null, signal: `spawn: ${spawnError}` }) };
    if (started && !h.pid) inProcess.set(runId, () => h.close());
    try {
      // this session's result cards can no longer be answered: a new task started (the lock ended a lingering one).
      // Every one is closed even if recording one fails; then the failure stops this start.
      let failure: unknown = null;
      for (const t of [...this.tasks.values()]) if (t.state !== "running") { try { this.closeTask(t, "new_task"); } catch (e) { failure ??= e; } }
      if (failure) throw failure;
      const replyTo = o.before?.() ?? o.replyTo;
      this.log.emit({ kind: "session.task", msg_id: newId(), run_id: runId, raw: o.raw, ...(o.goal ? { goal: o.goal } : {}), by: o.by, ...(replyTo ? { reply_to: replyTo } : {}) });
    } catch (e) {
      // not recorded: the executor never gets its task; it is ended and the lock it took let go now
      this.abandon(runId, h, holder);
      return { failed: errText(e) };
    }
    let resolve!: (e: TaskEnd) => void;
    const ended = new Promise<TaskEnd>((res) => { resolve = res; });
    const task: Task = { runId, handle: h, pgid, holder, responded: false, sawDone: false, options: 0, state: "running", card: null, steers: [], end: null, ended, resolve, exitTimer: null, openSteps: new Set(), unrecordedClose: null };
    this.current = task;
    this.tasks.set(runId, task);
    void h.exited.then((x) => this.onExecutorExit(task, x));
    try {
      h.onLine((l) => this.onExecutorLine(task, l));
      h.start?.();
    } catch (e) {
      // recorded, but the executor could not be given its task: it is ended, and its exit records the end (failed)
      process.stderr.write(`session: the task could not be sent: ${errText(e)}\n`);
      this.abandon(runId, h, holder, false);
    }
    return task;
  }

  /** Let go of what a start that failed took: its executor's stdin is closed, its group ended and the lock it wrote
   *  removed (compare-and-set on `holder`); a group that would not end is ended later (reapLater), and once it exits
   *  the lock is removed if it still names it. `forget`: the session never knew the task (nothing follows its exit). */
  private abandon(runId: string, h: ExecutorHandle, holder: Holder | null, forget = true) {
    try { h.close(); } catch { /* gone */ }
    if (holder && !release(this.o.dir, holder)) reapLater(this.o.dir, runId, holder.pgid, 2000);
    if (forget) void h.exited.then(() => { inProcess.delete(runId); try { free(this.o.dir, runId, holder?.pgid ?? 0); } catch { /* the next task finds its group gone */ } });
  }

  /** An executor's event: to the app as it is (plus the session), and what the session follows of it. */
  private onExecutorLine(task: Task, line: string) {
    let ev: Record<string, unknown>;
    try { const j = JSON.parse(line); if (!j || typeof j !== "object" || Array.isArray(j)) return; ev = j; } catch { return; }
    // done acting: the lock and the task say so before anyone hears of it (an undo sent at once finds it lingering)
    if (ev.kind === "task_done") {
      task.sawDone = true;
      // a lock that cannot say lingering would keep the Mac busy while its card waits: it does not linger then
      if (!this.lockLinger(task)) task.noLinger = true;
      this.cardOf(task, ev);
    }
    this.o.out({ ...ev, session_id: this.o.sessionId });
    switch (ev.kind) {
      case "ask": task.card = typeof ev.ask_id === "string" ? ev.ask_id : null; break;
      case "resumed": case "ask_void": if (ev.ask_id === task.card) task.card = null; break;
      case "steered": if (typeof ev.text === "string") task.steers.push(ev.text); break;
      case "step": if (typeof ev.step_id === "string") task.openSteps.add(ev.step_id); break;
      case "step_result": if (typeof ev.step_id === "string") task.openSteps.delete(ev.step_id); break;
      case "task_done": this.taskDone(task, ev); if (task.noLinger) task.handle.close(); break;
      case "result_response":
        this.lockLinger(task);                           // the answer carried out: it acts no more (first: whatever the record)
        if (typeof ev.undone === "number" && typeof ev.total === "number") {
          try { this.log.emit({ kind: "session.task_undo", run_id: task.runId, undone: ev.undone, total: ev.total, refused: typeof ev.refused === "string" ? ev.refused : null }); }
          catch (e) { process.stderr.write(`session: the undo of ${task.runId} could not be stored: ${errText(e)}\n`); }
        }
        break;
    }
  }

  /** The lock says the task acts no more (a lock file that cannot be written is logged, not thrown into the reader:
   *  false). */
  private lockLinger(task: Task): boolean {
    try { if (task.holder) { const n = linger(this.o.dir, task.holder); if (n) task.holder = n; } return true; }
    catch (e) { process.stderr.write(`computer lock: ${errText(e)}\n`); return false; }
  }

  /** task_done, before it is passed on: its result card's options, and whether it lingers for it. */
  private cardOf(task: Task, ev: Record<string, unknown>) {
    task.card = null;
    if (task.end) return;                                // the session had to end it already (the app went away)
    const card = ev.result_card as { options?: unknown[] } | null | undefined;
    task.options = Array.isArray(card?.options) ? card.options.length : 0;
    if (task.state === "running") task.state = card && this.linger > 0 && !task.noLinger ? "lingering" : "ending";
  }

  private taskDone(task: Task, ev: Record<string, unknown>) {
    if (task.end) return;
    const card = ev.result_card as { options?: { kind?: string }[] } | null | undefined;
    const undo = this.linger > 0 && !task.noLinger && !!card?.options?.some((x) => x.kind === "undo") ? "open" : "none";
    this.recordEnd(task, endFrom(task.runId, ev, undo, task.steers));
  }

  /** The task's end: stored, then the task is over for the session whatever happens to the write — the model's call
   *  returns, the session is free again. An end that could not be stored is not in the history: a resumed session
   *  finds the task without one and takes it from the run (its task_done, else interrupted). */
  private recordEnd(task: Task, body: TaskEnd) {
    if (task.exitTimer) { clearTimeout(task.exitTimer); task.exitTimer = null; }
    try { this.log.emit(body); } catch (e) { process.stderr.write(`session: the end of ${task.runId} could not be stored: ${errText(e)}\n`); }
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
    try {
      // the lock goes once nothing of its group is left (a child still up keeps it: acting, if it never said task_done,
      // until that child ends — or is ended after the stop wait)
      inProcess.delete(task.runId);
      try { free(this.o.dir, task.runId, task.pgid); } catch { /* the next task finds its group gone */ }
      // the lock still says it acts (no task_done of its own, or it died during an undo): what is left of its group is
      // ended after the stop wait (and by the next task, if this process is gone by then: orphaned)
      reapLater(this.o.dir, task.runId, task.pgid, this.o.exitWaitMs ?? EXIT_WAIT_MS);
      if (!task.end) {
        // no task_done: a step it had begun and not ended may or may not have taken effect
        this.recordEnd(task, { kind: "session.task_end", run_id: task.runId, status: "failed", reason: `the executor exited (${x.signal ?? `code ${x.code}`}) before the task ended`, ...unknownIf(task.openSteps.size > 0), summary: "", undo: "none", ...(task.steers.length ? { steers: task.steers } : {}) });
      }
      if (task.state !== "closed") {
        // a lingering executor ended by a new task elsewhere on this Mac (the lock names another run now): undo expired
        const other = task.state === "lingering" && readHolder(this.o.dir)?.run_id !== undefined && readHolder(this.o.dir)?.run_id !== task.runId;
        task.state = "closed";
        this.storeClosed(task, other ? "new_task" : "linger");
      } else if (task.unrecordedClose) this.storeClosed(task, task.unrecordedClose);
    } finally {
      this.tasks.delete(task.runId);
      this.maybeExit();
    }
  }

  /** session.task_closed; one that cannot be stored is logged (the history then lacks it: a resumed session adds
   *  session_end). */
  private storeClosed(task: Task, why: "linger" | "new_task" | "session_end") {
    try { this.log.emit({ kind: "session.task_closed", run_id: task.runId, why }); task.unrecordedClose = null; }
    catch (e) { process.stderr.write(`session: task_closed of ${task.runId} could not be stored: ${errText(e)}\n`); }
  }

  /** Close an executor's stdin: its result card can no longer be answered. The executor is let go first, whatever
   *  happens to the record; a record that cannot be stored throws (after the executor was let go), and is stored again
   *  when the executor exits. */
  private closeTask(task: Task, why: "new_task" | "session_end") {
    if (task.state === "closed") return;
    task.state = "closed";
    try { task.handle.close(); } catch { /* gone */ }
    try { this.log.emit({ kind: "session.task_closed", run_id: task.runId, why }); }
    catch (e) { task.unrecordedClose = why; throw e; }
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

  /** The result card's answer (undo): to the lingering executor, which holds the machine lock as acting again while it
   *  runs (computer.ts undo) — unless another task started on this Mac since (undo expired). */
  respond(line: Record<string, unknown>, runId?: string) {
    const t = runId ? this.tasks.get(runId) : [...this.tasks.values()].reverse().find((x) => x.state === "lingering");
    if (!t || t.state !== "lingering") return this.refuse("no_task", "no result card of this session is waiting", "respond");
    // checked before anything is held: only an option index of its card is a respond the executor acts on
    const opt = line.option;
    if (typeof opt !== "number" || !Number.isInteger(opt) || opt < 0 || opt >= t.options) return this.refuse("bad_control", `a respond needs option: the index of one of the result card's ${t.options} options`, "respond");
    // one respond per card: the executor reads only the first
    if (t.responded) return this.refuse("busy", this.t("这张结果卡已经回答过了", "this result card was answered already"), "respond");
    let u: ReturnType<typeof undo>;
    try { u = t.holder ? undo(this.o.dir, t.holder) : "expired"; }
    catch (e) { return this.refuse("busy", `the machine lock: ${e instanceof Error ? e.message : String(e)}`, "respond"); }
    if (u === "expired") { try { this.closeTask(t, "new_task"); } catch { /* let go; recorded at its exit */ } return this.refuse("undo_expired", this.t("另一个电脑任务开始了，这个任务的撤回已经过期", "another computer task started on this Mac; this task's undo has expired"), "respond"); }
    if (u === "busy") return this.refuse("busy", this.t("这个任务的撤回正在进行", "an answer to this task's card is being carried out"), "respond");
    t.holder = u.ok;
    t.responded = true;
    t.handle.write(JSON.stringify(line));
  }

  /** The user's words into the running task (control v1 steer). */
  steer(text: string, runId?: string, cid?: string, fromQueue = false) {
    if (this.closing || !text.trim() || (!fromQueue && this.sendsDuplicate(cid, "steer")) || this.tooLong(text, "steer", cid)) return;
    const t = this.current;
    if (!t || (runId && runId !== t.runId)) return this.refuse("no_task", "no task is running", "steer", cid);
    if (t.card) return this.refuseCard("steer", cid);
    // stored first: should storing fail, the executor never has words the history (or the queue) does not account for
    this.log.emit({ kind: "session.steer", run_id: t.runId, text, ...(cid ? { client_id: cid } : {}) });
    t.handle.write(JSON.stringify({ type: "steer", text }));
  }

  private sendNow(id: string) {
    const it = this.queue.find((q) => q.id === id);
    if (!it) return this.emitQueue();
    // the session is ending: the entry stays where it is (its words are never dropped on the way out of the queue)
    if (this.closing) return this.refuse("busy", this.t("会话正在结束", "the session is ending"), "queue_send_now", it.client_id);
    // (stored first, then out of the queue: should storing fail, the words are still queued, never in neither place)
    if (this.current) {
      if (this.current.card) return this.refuseCard("queue_send_now", it.client_id);
      this.steer(it.text, undefined, it.client_id, true);
      this.queue = this.queue.filter((q) => q !== it);
      return this.emitQueue();
    }
    if (this.running || this.flows) return this.refuseBusy("queue_send_now", it.client_id);
    this.say(it.text, it.client_id, true);
    this.queue = this.queue.filter((q) => q !== it);
    this.emitQueue();
  }

  private emitQueue() { this.send({ kind: "session.queue", items: this.queue.map((q) => ({ ...q })) }); }

  /** Nothing runs any more: the queued words (not held after a stop) go to the model, in order, as one turn. */
  private afterActivity() {
    if (this.closing || this.running || this.current || this.flows) return;
    const go = this.queue.filter((q) => !q.held);
    if (!go.length) return;
    // each stored, then out of the queue; the queue sent after (should storing fail, what is left is still queued)
    let last = "";
    try {
      for (const q of go) {
        last = (this.log.emit({ kind: "session.message", msg_id: newId(), role: "user", text: q.text, via: "queue", ...(q.client_id ? { client_id: q.client_id } : {}) }) as Extract<SessionEvent, { kind: "session.message" }>).msg_id;
        this.queue = this.queue.filter((x) => x !== q);
      }
    } finally { this.emitQueue(); }
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
   *  and the queue, always (empty included): it is the whole queue, so an app that reconnects after the queue was sent
   *  to the model replaces what it held. */
  attach(afterSeq: number) {
    for (const ev of this.log.since(afterSeq)) this.o.out(ev);
    const r = this.running;
    if (r) { this.flush(r); this.send({ kind: "session.delta", msg_id: r.msgId, text: r.sent, offset: 0 }); }
    this.emitQueue();
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
    t.handle.write(JSON.stringify({ type: "stop", app_gone: true }));
    // no task_done in time: recorded as stopped all the same. Its executor may still be acting: the machine lock stays
    // with it (its pid is in the lock) until it exits
    t.exitTimer = setTimeout(() => {
      t.exitTimer = null;
      if (!t.end) this.recordEnd(t, { kind: "session.task_end", run_id: t.runId, status: "stopped", reason: "the app went away; the task did not confirm the stop in time", ...unknownIf(t.openSteps.size > 0), summary: "", undo: "none", ...(t.steers.length ? { steers: t.steers } : {}) });
      this.maybeExit();
    }, this.o.exitWaitMs ?? EXIT_WAIT_MS);
  }

  /** Resolves when no reply, task or /cua runs. */
  async idle(): Promise<void> { while (this.busy) { if (this.running) await this.running.done; else await sleep(10); } }

  private maybeExit() {
    if (!this.closing || this.running || this.current || this.flows || this.exited) return;
    this.exited = true;
    const open = [...this.tasks.values()];
    for (const t of open) { try { this.closeTask(t, "session_end"); } catch { /* let go; recorded at its exit */ } }
    // the executors read their stdin's end and exit; one that does not is not waited for long
    void Promise.race([Promise.all(open.map((t) => t.handle.exited)), sleep(2000)]).then(() => this.o.onExit?.());
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A run's events.jsonl, as far as it reads. */
function readRunEvents(file: string): Record<string, unknown>[] {
  try { return fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim()).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; }
}

/** cause last_step_unknown when a step was open, else nothing. */
const unknownIf = (open: boolean): { cause?: StopCause } => (open ? { cause: "last_step_unknown" } : {});
/** A run's steps with a `step` and no `step_result`, from its events. */
function openStepsIn(evs: Record<string, unknown>[]): number {
  const open = new Set<unknown>();
  for (const e of evs) { if (e.kind === "step" && typeof e.step_id === "string") open.add(e.step_id); if (e.kind === "step_result") open.delete(e.step_id); }
  return open.size;
}
const interrupted = (runId: string, steers: string[], evs: Record<string, unknown>[]): TaskEnd => ({ kind: "session.task_end", run_id: runId, status: "interrupted", reason: "the session process went away before the task ended", ...unknownIf(openStepsIn(evs) > 0), summary: "", undo: "none", ...(steers.length ? { steers } : {}) });

/** session.task_end from the executor's task_done: its cause is the field copied (one of the known values), never read
 *  out of its reason. */
function endFrom(runId: string, ev: Record<string, unknown>, undo: "open" | "none", steers: string[]): TaskEnd {
  const changes = capChanges(ev.changes as Record<string, unknown> | undefined);
  const cause = (STOP_CAUSES as readonly unknown[]).includes(ev.cause) ? (ev.cause as StopCause) : undefined;
  return { kind: "session.task_end", run_id: runId, status: String(ev.status ?? "failed"), summary: typeof ev.summary === "string" ? ev.summary : "", undo,
    ...(typeof ev.reason === "string" && ev.reason ? { reason: ev.reason.slice(0, 500) } : {}), ...(cause ? { cause } : {}), ...(typeof ev.answer === "string" ? { answer: ev.answer } : {}),
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
