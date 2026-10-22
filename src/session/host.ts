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
 *
 * Terminal records (one rule, every path): the app learns that a run ended only from its session.task_end and
 * session.task_closed (or from this process exiting). A session that cannot store one — or cannot set the machine
 * lock back after an answer it did not send (respond), which would leave the Mac held for a run that acts no more —
 * does not carry on as if it had:
 * it halts — every executor is let finish what it is doing (its stop, an undo) within the stop budget, then its group
 * is ended and confirmed gone, the machine lock removed only while it still names that run (compare-and-set), and the
 * process exits non-zero (onExit with the reason). The next open's recover writes what is missing.
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
import { acquire, endTree, free, held, inProcess, landed, linger, readHolder, reapLater, release, undo, type Holder } from "./computer.js";
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
  | ({ type: "end_if_idle" } & ClientId)
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
    case "end_if_idle": return { type: "end_if_idle", ...cid };
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
   *  or task runs. `failure`: it halted instead — a terminal record could not be stored (the process exits non-zero). */
  onExit?: (failure?: string) => void;
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

/** Why a session is not idle (end_if_idle's refusal names each that holds), in this order: `busy` a reply is under
 *  way (or a /cua's task and the reply after it), `queue` words wait in the queue (held ones too), `task` a task is not
 *  closed (running, its card open, its result card lingering for undo, or exiting by itself), `recovering` recover is
 *  still writing an old run's records (waiting for an old executor). */
export const NOT_IDLE = ["busy", "queue", "task", "recovering"] as const;
export type NotIdle = (typeof NOT_IDLE)[number];

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
type TaskClosed = Extract<SessionBody, { kind: "session.task_closed" }>;
type TaskUndo = Extract<SessionBody, { kind: "session.task_undo" }>;
interface Task {
  runId: string; handle: ExecutorHandle;
  /** Its process group, as the machine lock names it (0: an executor inside this process). */
  pgid: number;
  /** The machine lock as this task last wrote it: every change of it is made from exactly this (compare-and-set). */
  holder: Holder | null;
  /** An answer to its result card was sent (the executor reads only the first). */
  responded: boolean;
  /** That answer was the card's undo (stored: session.task_respond), and its result_response came. */
  undoAsked?: boolean;
  sawResponse?: boolean;
  /** Its undo was recorded as unknown (no result_response came). */
  undoUnknown?: boolean;
  /** The session is ending and waits for its undo: the stop budget, after which its group is ended. */
  undoTimer?: NodeJS.Timeout;
  /** Its executor said task_done (not only the session, when the app went away). */
  sawDone: boolean;
  /** How many options its result card has (a respond's option must be one of them), and their kinds. */
  options: number;
  optionKinds: string[];
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
  /** Its lock could not be set lingering at task_done: it does not linger (its card is not offered; it exits now). */
  noLinger?: boolean;
  /** Why its executor could not be sent its task (the end its exit records says so). */
  startError?: string;
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
  /** Why the session halted (a terminal record could not be stored), or null. */
  private halted: string | null = null;

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

  /** The last process went away mid-task or while an executor lingered (or halted). Each task gets what its history
   *  lacks, in order: its session.task_end, from its run's task_done when the run has one (undo none: its executor is
   *  gone), else `interrupted`; its session.task_undo when an undo was asked for (session.task_respond with undo) and
   *  never recorded, from the run's result_response, else `unknown` (it was cut off: never left to read as expired);
   *  its session.task_closed (session_end: that executor is gone with its process). An executor that still runs (the
   *  lock names it) is let finish first, as halt does: one that never said task_done is asked to stop (SIGTERM to it
   *  alone: its own stop, the step in flight's receipt), one carrying out an undo is left to finish it, within the stop
   *  budget; then what is left of its group is ended. A record that cannot be stored halts this process too, once
   *  every old executor is ended: the next open tries again. */
  private recover() {
    const ended = new Set<string>(), closed = new Set<string>(), asked = new Set<string>(), undone = new Set<string>(), started: string[] = [];
    for (const e of this.log.events) {
      if (e.kind === "session.task") started.push(e.run_id);
      if (e.kind === "session.task_end") ended.add(e.run_id);
      if (e.kind === "session.task_closed") closed.add(e.run_id);
      if (e.kind === "session.task_respond" && e.undo) asked.add(e.run_id);
      if (e.kind === "session.task_undo") undone.add(e.run_id);
    }
    for (const runId of started) {
      const need = { end: !ended.has(runId), undo: asked.has(runId) && !undone.has(runId), close: !closed.has(runId) };
      if (!need.end && !need.undo && !need.close) continue;
      // (each run on its own: one whose records cannot be stored does not keep the others' executors running)
      try {
        const doneAlready = readRunEvents(this.runFile(runId)).some((e) => e.kind === "task_done");
        const own = readHolder(this.o.dir);
        if (((need.end && !doneAlready) || need.undo) && own?.run_id === runId && own.session_id === this.o.sessionId && own.pgid > 0 && held(own)) {
          // the executor itself is asked to stop when it never said task_done (after it, a signal ends it at once and
          // would cut an undo short); the lock stays its group's until all of it is gone
          if (!doneAlready) { try { process.kill(own.pid, "SIGTERM"); } catch { /* gone meanwhile */ } }
          this.recoverPending += 1;
          this.recovering.push(this.awaitOld(runId, own, need).finally(() => {
            this.recoverPending -= 1;
            // what waited for recover (words queued meanwhile) goes on now
            try { this.afterActivity(); } catch (e) { process.stderr.write(`session: the queue could not be sent: ${errText(e)}\n`); }
            this.maybeExit();
          }));
          continue;
        }
        this.recordRecovered(runId, need);
      } catch (e) { process.stderr.write(`session: recovering ${runId}: ${errText(e)}\n`); }
    }
  }

  private runFile(runId: string) { return path.join(this.runs, runId, "events.jsonl"); }
  private stored(kind: string, runId: string) { return this.log.events.some((e) => e.kind === kind && (e as { run_id?: string }).run_id === runId); }

  /** What a run's history lacks, from its run's events (recover): its end, its undo, its closure — stopping at the first
   *  that cannot be stored (the session halts). */
  private recordRecovered(runId: string, need: { end: boolean; undo: boolean; close: boolean }) {
    const evs = readRunEvents(this.runFile(runId));
    if (need.end && !this.stored("session.task_end", runId)) {
      const done = [...evs].reverse().find((e) => e.kind === "task_done");
      const steers = evs.filter((e) => e.kind === "steered").map((e) => String(e.text));
      if (!this.terminal(done ? endFrom(runId, done, "none", steers) : interrupted(runId, steers, evs))) return;
    }
    if (need.undo && !this.stored("session.task_undo", runId)) {
      const r = [...evs].reverse().find((e) => e.kind === "result_response" && typeof e.undone === "number" && typeof e.total === "number");
      if (!this.terminal(r ? { kind: "session.task_undo", run_id: runId, undone: r.undone as number, total: r.total as number, refused: typeof r.refused === "string" ? r.refused : null }
        : undoUnknown(runId))) return;
    }
    if (need.close && !this.stored("session.task_closed", runId)) this.terminal({ kind: "session.task_closed", run_id: runId, why: "session_end" });
  }

  /** Records recover makes later (an old executor that was still running). Tests wait on them. */
  readonly recovering: Promise<void>[] = [];
  /** How many of them are not done: the session is not idle, and does not exit, while one is (end waits for it). */
  private recoverPending = 0;
  /** An old executor that still runs: waited for until it finished what it was doing (its task_done; its undo's
   *  result_response), its group is gone, or the stop budget is over; then what is left of its group is ended and the
   *  run's missing records written (recordRecovered). Never rejects. */
  private async awaitOld(runId: string, own: Holder, need: { end: boolean; undo: boolean; close: boolean }) {
    const t0 = Date.now();
    for (;;) {
      const evs = readRunEvents(this.runFile(runId));
      const finished = need.undo ? evs.some((e) => e.kind === "result_response") : evs.some((e) => e.kind === "task_done");
      if (finished || !held(own) || Date.now() - t0 > (this.o.exitWaitMs ?? EXIT_WAIT_MS)) {
        // not ended in time: what is left of its group is ended now (a resumed session's first task must not find it)
        if (!finished) { try { const cur = readHolder(this.o.dir); if (cur?.run_id === runId && held(cur)) endTree(cur); } catch { /* the next task finds it */ } }
        this.recordRecovered(runId, need);
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
      case "end_if_idle": return this.endIfIdle(c.client_id);
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
    // a task runs, or recover is still writing an old run's records: the words wait in the queue (sent to the model
    // after it — a model never reads a history recover has not finished), unless a card waits for the user
    if (this.current || this.recoverPending) {
      if (this.current?.card) return this.refuseCard("say", cid);
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
    if (this.current || this.running || this.flows || this.recoverPending) return this.refuseBusy("retry");
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
      if (this.halted) return;                           // halted: this process stores nothing more
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
      if (this.halted) return;
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
    if (this.current || this.running || this.flows || this.recoverPending) return this.refuseBusy("cua", cid);
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
      // (acquire can throw after its write landed — closing the guard failed: a lock naming this run is let go too)
      let own: Holder | null = null;
      try { const x = readHolder(this.o.dir); if (x?.run_id === runId) own = x; } catch { /* unreadable: its exit frees it */ }
      if (started) this.abandon(runId, started, own, true, started.pid ?? 0);
      else if (own && !release(this.o.dir, own)) reapLater(this.o.dir, runId, own.pgid, 2000);
      // acquire may have ended this session's lingering executor before it failed: that card is closed (new_task)
      // (a close that cannot be stored halts the session)
      for (const t of [...this.tasks.values()]) if (t.state === "lingering" && t.pgid > 0 && t.holder && !held(t.holder)) this.closeTask(t, "new_task");
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
      // A close that cannot be stored halts the session (every executor of it is ended): this start stops too.
      for (const t of [...this.tasks.values()]) if (t.state !== "running") this.closeTask(t, "new_task");
      if (this.halted) throw new Error(this.halted);
      const replyTo = o.before?.() ?? o.replyTo;
      this.log.emit({ kind: "session.task", msg_id: newId(), run_id: runId, raw: o.raw, ...(o.goal ? { goal: o.goal } : {}), by: o.by, ...(replyTo ? { reply_to: replyTo } : {}) });
    } catch (e) {
      // not recorded: the executor never gets its task; it is ended and the lock it took let go now
      this.abandon(runId, h, holder);
      return { failed: errText(e) };
    }
    let resolve!: (e: TaskEnd) => void;
    const ended = new Promise<TaskEnd>((res) => { resolve = res; });
    const task: Task = { runId, handle: h, pgid, holder, responded: false, sawDone: false, options: 0, optionKinds: [], state: "running", card: null, steers: [], end: null, ended, resolve, exitTimer: null, openSteps: new Set() };
    this.current = task;
    this.tasks.set(runId, task);
    void h.exited.then((x) => this.onExecutorExit(task, x));
    try {
      h.onLine((l) => this.onExecutorLine(task, l));
      h.start?.();
    } catch (e) {
      // recorded, but the executor could not be given its task: it is ended, and its exit records the end (failed)
      task.startError = errText(e);
      process.stderr.write(`session: the task could not be sent: ${task.startError}\n`);
      this.abandon(runId, h, holder, false);
    }
    return task;
  }

  /** Let go of what a start that failed took: its executor's stdin is closed, its group ended and the lock it wrote
   *  removed (compare-and-set on `holder`); a group that would not end is ended later (reapLater), and once it exits
   *  the lock is removed if it still names it. `forget`: the session never knew the task (nothing follows its exit). */
  private abandon(runId: string, h: ExecutorHandle, holder: Holder | null, forget = true, pgid = holder?.pgid ?? 0) {
    try { h.close(); } catch { /* gone */ }
    if (holder && !release(this.o.dir, holder)) reapLater(this.o.dir, runId, holder.pgid, 2000);
    if (forget) void h.exited.then(() => { inProcess.delete(runId); try { free(this.o.dir, runId, pgid); } catch { /* the next task finds its group gone */ } });
  }

  /** An executor's event: to the app as it is (plus the session), and what the session follows of it. */
  private onExecutorLine(task: Task, line: string) {
    if (this.halted) return;                             // halted: its executor is being ended; nothing more is said
    let ev: Record<string, unknown>;
    try { const j = JSON.parse(line); if (!j || typeof j !== "object" || Array.isArray(j)) return; ev = j; } catch { return; }
    // done acting: the lock and the task say so before anyone hears of it (an undo sent at once finds it lingering)
    if (ev.kind === "task_done") {
      task.sawDone = true;
      // a lock that cannot say lingering would keep the Mac busy while its card waits: it does not linger then
      if (!this.lockLinger(task)) task.noLinger = true;
      this.cardOf(task, ev);
    }
    // (a task that does not linger offers no result card: none is shown that could not be answered)
    this.o.out({ ...ev, ...(ev.kind === "task_done" && task.noLinger ? { result_card: null } : {}), session_id: this.o.sessionId });
    switch (ev.kind) {
      case "ask": task.card = typeof ev.ask_id === "string" ? ev.ask_id : null; break;
      case "resumed": case "ask_void": if (ev.ask_id === task.card) task.card = null; break;
      case "steered": if (typeof ev.text === "string") task.steers.push(ev.text); break;
      case "step": if (typeof ev.step_id === "string") task.openSteps.add(ev.step_id); break;
      case "step_result": if (typeof ev.step_id === "string") task.openSteps.delete(ev.step_id); break;
      case "task_done": this.taskDone(task, ev); if (task.noLinger) { try { task.handle.close(); } catch { /* gone */ } } break;
      case "result_response":
        task.sawResponse = true;
        this.lockLinger(task);                           // the answer carried out: it acts no more (first: whatever the record)
        // what the undo did is the run's record of a change to the user's things: one that cannot be stored halts the
        // session (terminal) — never read as "expired" meanwhile; the next open records it from the run
        if (task.undoTimer) { clearTimeout(task.undoTimer); task.undoTimer = undefined; }
        if (typeof ev.undone === "number" && typeof ev.total === "number") this.terminal({ kind: "session.task_undo", run_id: task.runId, undone: ev.undone, total: ev.total, refused: typeof ev.refused === "string" ? ev.refused : null });
        this.maybeExit();                                // a session ending waited for this undo's outcome
        break;
    }
  }

  /** The lock says the task acts no more (a lock file that cannot be written is logged, not thrown into the reader:
   *  false). */
  private lockLinger(task: Task): boolean {
    try { if (task.holder) { const h = task.holder; const n = landed(() => linger(this.o.dir, h)); if (n) task.holder = n; } return true; }
    catch (e) { process.stderr.write(`computer lock: ${errText(e)}\n`); return false; }
  }

  /** task_done, before it is passed on: its result card's options, and whether it lingers for it. */
  private cardOf(task: Task, ev: Record<string, unknown>) {
    task.card = null;
    if (task.end) return;                                // the session had to end it already (the app went away)
    const card = ev.result_card as { options?: unknown[] } | null | undefined;
    task.options = Array.isArray(card?.options) ? card.options.length : 0;
    task.optionKinds = Array.isArray(card?.options) ? card.options.map((x) => String((x as { kind?: unknown } | null)?.kind ?? "")) : [];
    if (task.state === "running") task.state = card && this.linger > 0 && !task.noLinger ? "lingering" : "ending";
  }

  private taskDone(task: Task, ev: Record<string, unknown>) {
    if (task.end) return;
    const card = ev.result_card as { options?: { kind?: string }[] } | null | undefined;
    const undo = this.linger > 0 && !task.noLinger && !!card?.options?.some((x) => x.kind === "undo") ? "open" : "none";
    this.recordEnd(task, endFrom(task.runId, ev, undo, task.steers));
  }

  /** The task's end: stored, then the task is over for the session — the model's call returns. An end that cannot be
   *  stored halts the session (terminal): the next open finds the task without one and takes it from the run (its
   *  task_done, else interrupted). */
  private recordEnd(task: Task, body: TaskEnd) {
    if (task.exitTimer) { clearTimeout(task.exitTimer); task.exitTimer = null; }
    const stored = this.terminal(body);
    task.end = body;
    if (this.current === task) this.current = null;
    // after a stop the queued words are not sent by themselves: the user says whether to
    if (stored && body.status === "stopped" && this.queue.length) {
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
      if (this.halted) return;                           // halted: halt lets go of it; this process records nothing more
      // the lock still says it acts (no task_done of its own, or it died during an undo): what is left of its group is
      // ended after the stop wait (and by the next task, if this process is gone by then: orphaned)
      reapLater(this.o.dir, task.runId, task.pgid, this.o.exitWaitMs ?? EXIT_WAIT_MS);
      if (!task.end) {
        // no task_done: a step it had begun and not ended may or may not have taken effect
        this.recordEnd(task, { kind: "session.task_end", run_id: task.runId, status: "failed", reason: task.startError ? `the task could not be sent to the executor: ${task.startError}` : `the executor exited (${x.signal ?? `code ${x.code}`}) before the task ended`, ...unknownIf(task.openSteps.size > 0), summary: "", undo: "none", ...(task.steers.length ? { steers: task.steers } : {}) });
      }
      if (task.undoTimer) { clearTimeout(task.undoTimer); task.undoTimer = undefined; }
      // it died while carrying out an undo (asked for, no result_response): how much of it was done is not known — said
      // so before its closure, never left to read as "expired"
      if (!this.settleUndo(task)) return;
      if (task.state !== "closed") {
        // a lingering executor ended by a new task elsewhere on this Mac (the lock names another run now): undo expired
        const other = task.state === "lingering" && readHolder(this.o.dir)?.run_id !== undefined && readHolder(this.o.dir)?.run_id !== task.runId;
        task.state = "closed";
        this.terminal({ kind: "session.task_closed", run_id: task.runId, why: other ? "new_task" : "linger" });
      }
    } finally {
      this.tasks.delete(task.runId);
      this.maybeExit();
    }
  }

  /** Close an executor's stdin: its result card can no longer be answered. The executor is let go first, whatever
   *  happens to the record; a record that cannot be stored halts the session (terminal). */
  private closeTask(task: Task, why: "new_task" | "session_end") {
    if (task.state === "closed") return;
    task.state = "closed";
    try { task.handle.close(); } catch { /* gone */ }
    if (!this.settleUndo(task)) return;
    this.terminal({ kind: "session.task_closed", run_id: task.runId, why });
  }

  /** An undo this session asked for whose outcome is not recorded (no result_response, no unknown). A run's closure is
   *  never written while one is open: the session's exit waits for it (maybeExit), and a closure that comes first all
   *  the same (its executor died before its exit was seen: a new task found the Mac free) records it unknown first. */
  private undoOpen(t: Task): boolean { return !!t.undoAsked && !t.sawResponse && !t.undoUnknown; }
  /** Before a run's closure: an undo with no outcome is recorded as unknown. False: it could not be (halted). */
  private settleUndo(t: Task): boolean {
    if (!this.undoOpen(t)) return true;
    t.undoUnknown = true;
    return this.terminal(undoUnknown(t.runId));
  }

  /** A run's terminal record — session.task_end, session.task_closed, or session.task_undo (what an undo did, or that
   *  it was cut off: a change to the user's things, never to be read as "expired" meanwhile) — stored; false when it
   *  could not be, and the session halts. One rule for every path
   *  that writes one (an executor's task_done or exit, a card closed by a new task, an undo that expired, the app going
   *  away, the session's exit, recover): the app learns that a run ended only from these records or from this process
   *  exiting, so a session whose history lacks one does not carry on. */
  private terminal(body: TaskEnd | TaskClosed | TaskUndo): boolean {
    if (this.halted) return false;
    try { this.log.emit(body); return true; }
    catch (e) { this.halt(`${body.kind} of ${body.run_id} could not be stored: ${errText(e)}`); return false; }
  }

  /** Fail-stop: this process stores nothing more, passes on no executor event and handles no later control line (the
   *  line that led here still gets its answer: a refusal). The reply is stopped and every executor's stdin closed; each
   *  executor is let finish what it is still doing — its stop, an undo under way — within the stop budget, then what is
   *  left of its group is ended and confirmed gone, and the machine lock removed only while it is still what this
   *  session wrote for that run (compare-and-set) (letGo); old executors recover is ending are waited for. Then onExit
   *  with the reason: the process exits non-zero, the helper says the session exited, and the next open's recover
   *  writes the missing end, undo and closure. The model's call and a /cua flow waiting on a task are let go with an
   *  end that is not stored. */
  private halt(why: string) {
    if (this.halted) return;
    this.halted = why;
    this.closing = true;
    this.exited = true;
    process.stderr.write(`session: stopping: ${why}; the next open records what is missing\n`);
    const open = [...this.tasks.values()];
    this.current = null;
    for (const t of open) {
      if (t.exitTimer) { clearTimeout(t.exitTimer); t.exitTimer = null; }
      if (t.undoTimer) { clearTimeout(t.undoTimer); t.undoTimer = undefined; }
      t.state = "closed";
      try { t.handle.close(); } catch { /* gone */ }
    }
    this.running?.abort.abort();
    for (const t of open) if (!t.end) { t.end = { kind: "session.task_end", run_id: t.runId, status: "interrupted", reason: "the session stopped: its history could not be written", summary: "", undo: "none" }; t.resolve(t.end); }
    void (async () => {
      await Promise.all(open.map((t) => this.letGo(t)));
      await Promise.allSettled(this.recovering);
      this.o.onExit?.(why);
    })();
  }

  /** Halting: the executor is let finish what it is still doing, then what is left of it is ended. Its stdin is closed
   *  already (halt): an idle one exits at once; one carrying out an undo exits when the undo is done (no signal: after
   *  task_done the executor exits at once on one, which would cut the undo short). One that never said task_done is
   *  also sent SIGTERM — to it alone, not its group, as recover does: its own stop, which waits for the step in flight's
   *  receipt and writes task_done (its driver's processes are its to end). Both within the stop budget (exitWaitMs, as
   *  long as a stop is waited for when the app goes away); then what is left of its group is ended (endTree) and
   *  confirmed gone, and the lock removed only while it is still the holder this session last wrote for the run
   *  (release: run, group, state, gen), or else only when it names this run and nothing of its group is left (free). A
   *  group that will not end keeps the lock. What came of it is read from its run on the next open. Never rejects. */
  private async letGo(t: Task) {
    try {
      const h = t.holder;
      if (t.pgid > 0 && h && !t.sawDone && held(h)) { try { process.kill(h.pid, "SIGTERM"); } catch { /* gone */ } }
      await Promise.race([t.handle.exited, sleep(this.o.exitWaitMs ?? EXIT_WAIT_MS)]);
      if (t.pgid > 0 && h) { if (held(h)) endTree(h); }
      else inProcess.get(t.runId)?.();
      inProcess.delete(t.runId);
      if (!(h && release(this.o.dir, h))) free(this.o.dir, t.runId, t.pgid);
    } catch (e) { process.stderr.write(`session: letting go of ${t.runId}: ${errText(e)}\n`); }
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
    // (a change that landed is taken as made, also when only closing the lock's guard failed after it: an acting lock
    // nobody accounts for would hold the Mac)
    try { const h = t.holder; u = h ? landed(() => undo(this.o.dir, h)) : "expired"; }
    catch (e) { return this.refuse("busy", `the machine lock: ${e instanceof Error ? e.message : String(e)}`, "respond"); }
    if (u === "expired") { this.closeTask(t, "new_task"); return this.refuse("undo_expired", this.t("另一个电脑任务开始了，这个任务的撤回已经过期", "another computer task started on this Mac; this task's undo has expired"), "respond"); }
    if (u === "busy") return this.refuse("busy", this.t("这个任务的撤回正在进行", "an answer to this task's card is being carried out"), "respond");
    // the lock is now the acting holder this answer wrote: every later change of it is made from that (compare-and-set)
    t.holder = u.ok;
    // stored before the executor has it: a session that stops while an undo is under way leaves this in its history,
    // and the next open records what came of the undo (its result_response, else unknown). Not stored: the answer is
    // not sent, the lock is set lingering again (compare-and-set), the card can still be answered. If the lock cannot
    // be set back either, it would say acting for an executor that never got the answer — nothing would ever set it
    // back (no result_response comes) and the Mac would stay busy until the linger ends: the session halts (as for a
    // terminal record), which ends that executor and removes the lock by compare-and-set; the history has no answer,
    // so the next open records no undo
    try { this.log.emit({ kind: "session.task_respond", run_id: t.runId, option: opt, undo: t.optionKinds[opt] === "undo" }); }
    catch (e) {
      this.refuse("busy", `the answer could not be stored: ${errText(e)}`, "respond");
      try { const n = landed(() => linger(this.o.dir, u.ok)); if (n) t.holder = n; }
      catch (x) { this.halt(`the machine lock of ${t.runId} could not be set back to lingering after its answer was not stored: ${errText(x)}`); }
      return;
    }
    t.responded = true;
    t.undoAsked = t.optionKinds[opt] === "undo";
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
    if (this.running || this.flows || this.recoverPending) return this.refuseBusy("queue_send_now", it.client_id);
    this.say(it.text, it.client_id, true);
    this.queue = this.queue.filter((q) => q !== it);
    this.emitQueue();
  }

  private emitQueue() { this.send({ kind: "session.queue", items: this.queue.map((q) => ({ ...q })) }); }

  /** Nothing runs any more: the queued words (not held after a stop) go to the model, in order, as one turn. */
  private afterActivity() {
    if (this.closing || this.running || this.current || this.flows || this.recoverPending) return;
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

  /** What keeps the session from being idle now (empty: idle). Every stdin line is handled whole before the next, and
   *  each control that starts something (say, cua, retry, queue_send_now) has made it a reply, a task or a queue entry
   *  by the time it returns: so a line read before this one is never a start that has not begun yet. */
  notIdle(): NotIdle[] {
    const why: NotIdle[] = [];
    if (this.running || this.flows > 0) why.push("busy");
    if (this.queue.length) why.push("queue");
    if ([...this.tasks.values()].some((t) => t.state !== "closed")) why.push("task");
    if (this.recoverPending > 0) why.push("recovering");
    return why;
  }

  /** `end_if_idle`: end exactly as `end` does, only if the session is idle as this line is handled; otherwise refuse
   *  with not_idle and `why` (each reason that holds, NOT_IDLE). One check, in the order of stdin: no probe, no race. */
  endIfIdle(cid?: string) {
    const why = this.notIdle();
    if (!why.length) return this.end();
    this.send({ kind: "session.error", code: "not_idle", text: this.t(`会话还有事没做完：${why.join("、")}`, `not idle: ${why.join(", ")}`), control: "end_if_idle", why, ...(cid ? { client_id: cid } : {}) });
  }

  /** The app said end (or a signal): the running task is stopped (as when the app goes away), the reply stopped and
   *  stored, then exit (after recover has written what it is still waiting to write). */
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
    // (a recover still waiting for an old executor writes its records first: an exit now would abandon them)
    if (!this.closing || this.running || this.current || this.flows || this.recoverPending || this.exited) return;
    // an undo under way is let finish (its result_response) before any closure, within the stop budget; then what is
    // left of its group is ended, and its exit records the undo unknown (onExecutorExit) — this runs again then
    const undoing = [...this.tasks.values()].filter((t) => this.undoOpen(t));
    if (undoing.length) {
      for (const t of undoing) t.undoTimer ??= setTimeout(() => {
        t.undoTimer = undefined;
        if (this.halted || !this.undoOpen(t)) return;
        try { if (t.holder && t.pgid > 0 && held(t.holder)) endTree(t.holder); else inProcess.get(t.runId)?.(); }
        catch (e) { process.stderr.write(`session: ending ${t.runId}: ${errText(e)}\n`); }
      }, this.o.exitWaitMs ?? EXIT_WAIT_MS);
      return;
    }
    this.exited = true;
    const open = [...this.tasks.values()];
    for (const t of open) this.closeTask(t, "session_end");
    if (this.halted) return;                             // a close could not be stored: halt ends them and exits
    // the executors read their stdin's end and exit; one that does not is not waited for long
    void Promise.race([Promise.all(open.map((t) => t.handle.exited)), sleep(2000)]).then(() => { if (!this.halted) this.o.onExit?.(); });   // (halted meanwhile: halt calls it, with the reason)
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
/** session.task_undo for an undo that began and was cut off with no result_response. */
const undoUnknown = (runId: string): Extract<SessionBody, { kind: "session.task_undo" }> => ({ kind: "session.task_undo", run_id: runId, undone: 0, total: 0, refused: "the undo was cut off before it ended; how much of it was done is not known", unknown: true });
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
