/**
 * The app's entry point (DeskMind Hands.app runs this as a child process; design notes
 * docs/design/harness-app-integration-2026-10-17.md §2): JSON events out on stdout, one per line, each written to the
 * run's event log first (protocol/events.ts); answers to cards come back on stdin as JSON lines.
 *
 *   executor [--request <file>] [--runs <dir>]  stdin line 1 (or the file): {run_id?, raw, scope?, config?, engine?, lang?, driver?};
 *   (app-run: the same, its old name)           then control lines (protocol/control.ts); SIGINT / SIGTERM stop the run.
 *                                               The agent loop runs as a child, `runtime` (below); DESKMIND_EXECUTOR_INPROC=1
 *                                               keeps it in this process (host/frontier.ts)
 *   runtime                                     the agent loop, started by `executor`: MCP client on stdin/stdout (cli/runtime.ts)
 *   respond --run <id> [--runs <dir>]           stdin line 1: {option} | {text}  — the user's answer to the result card
 *   --selftest                                  no model, no network: the packaged binary's health check
 *   model-check --config <name|openai:prov|model> one tiny question to the configured model: {ok, model, ms} or {ok:false, error} — the app's "test" button
 *   trace export --run <id> --out <file> [--runs <dir>]   the run's call chain (trace.otel.jsonl) as one OTLP/JSON request
 *   session [--session <id>] [--dir <d>]        one chat session, long-lived (cli/session.ts; docs/protocol.md 「会话（第 1 版）」)
 *   sessions list [--dir <d>]                   every chat session, the newest first
 *
 * Consent: the executor verifies Ed25519 tokens with a public key; the private key is the app's (keychain / Secure
 * Enclave, docs/0.5-decisions.md D4). Until the app signs, this process holds a fresh pair per run — the model never
 * sees the private key either way, and the app's key replaces `ConsentSigner.fresh()` without any other change.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { configSyntaxProblem, configTable, Gateway, normalizeConfig, redactKeys } from "../gateway/index.js";
import * as R from "../protocol/roles.js";
import { ConsentSigner } from "../executor/consent.js";
import { Executor } from "../executor/executor.js";
import { SimComputer } from "../executor/sim.js";
import { HandsDriver } from "../executor/hands.js";
import { SkillStore } from "../skills/agentskills.js";
import { CARD_EXPIRY_MS, type SkillSource } from "../executor/service.js";
import { WALL_CLOCK, atWallTime, type Clock } from "../executor/clock.js";
import { T } from "../executor/text.js";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { ConsentToken, Driver, Snapshot } from "../executor/types.js";
import type { StopCause } from "../protocol/computer.js";
import { FrontierRuntime, type RuntimeOptions, type RuntimeUser } from "../host/frontier.js";
import { scriptedStream } from "../runtime/scripted.js";
import type { AgentSpec } from "../host/agent.js";
import { runtimeMain } from "./runtime.js";
import { sessionMain } from "./session.js";
import { EventLog, type AppEvent, type EventBody } from "../protocol/events.js";
import { isForeignControl, parseControl, type Control } from "../protocol/control.js";
import { PROTOCOL } from "../protocol/version.js";
import { current as traceContext, within, type ModelCallRecord } from "../otel/context.js";
import { Tracer, exportTrace } from "../otel/trace.js";
import type { Answer, Card } from "../orchestrator/index.js";
import { fileRegistry } from "../registry/fs.js";
import { Workspace } from "../registry/workspace.js";

/** task_done's reason when a stop could not wait for an action the driver had not answered. */
export const STEP_UNKNOWN = "a step was in progress; its result is unknown";

/** `context` (additive; the session's computer tasks): the chat model's restatement of what the user wants. Only the
 *  runtime's first message shows it, labelled 「助手的转述，不是用户原话」; the executor's judges read `raw`, the steers
 *  and the card answers as the user's words, never this. */
export interface Request { run_id?: string; raw: string; context?: string; scope?: string; config?: string; engine?: "runtime"; lang?: "zh" | "en"; driver?: "sim" | "hands"; apps?: string[]; skills?: string; rules?: ConsentToken[] }

/** What next() gives for a stop line while `stopsAsLines` is set: no control line ever reads as this. */
export const STOP_LINE = "\u0000stop";

/** JSON lines in: control lines (protocol/control.ts: answer, stop, respond, steer; v1 also reads the untyped
 *  `{ask_id, option|text}` and `{"stop":true}`); the first line may be the request itself. A stop or a steer is
 *  handled the moment it arrives; answers and responds wait in order for `next()`. */
export class LineReader {
  private waiting: ((line: string) => void)[] = [];
  private queued: string[] = [];
  constructor(input: NodeJS.ReadableStream) {
    const rl = readline.createInterface({ input, terminal: false });
    rl.on("line", (l) => {
      if (!l.trim()) return;
      // the app's stop can arrive at any moment, card or no card: it never waits in the answer queue
      // it also lets go of a card waiting for its answer: that card is answered with nothing (review of #16)
      const c = parseControl(l);
      // the session's stop as the app ends or leaves (app_gone) is nobody's request: no cause, as for stdin closing
      if (c?.type === "stop") {
        // a wait that asked to hear every stop (the result card's): told in order with the lines, latched or not
        if (this.stopsAsLines) this.deliver(STOP_LINE);
        if (c.app_gone) this.stop("the app went away (the session stopped its task)"); else this.stop("stopped by the app", "user_stopped"); return;
      }
      if (c?.type === "steer") { if (this.steerTo) this.steerTo(c.text); else this.earlySteers.push(c.text); return; }
      // 「现在回答」 on an expired card: at once, like a steer (nothing waits in the answer queue while a card is expired)
      if (c?.type === "reask") { this.onReask?.(); return; }
      // a card's answer, once a card router is there (StdioUser): routed once, as it arrives — to the open card, or
      // refused with the reason. It never waits in the queue. (Before that, the queue holds the request line itself.)
      if (c?.type === "answer" && this.onAnswer) { this.onAnswer(c); return; }
      // a type this version does not know (additions keep the version): not for us. Anything else waits for next():
      // the request line, an answer, or a line that is not JSON (the reader of next() says what it makes of it)
      if (!c && isForeignControl(l)) return;
      this.deliver(l);
    });
    // the app went away (stdin closed): every open card is answered with nothing (let go: "ended"), then whoever runs
    // the task is told (appRun: a stop)
    rl.on("close", () => { this.closed = true; for (const w of this.waiting.splice(0)) w(""); this.onClosed?.(); this.onEnd?.("ended"); });
  }
  private deliver(l: string) { const w = this.waiting.shift(); if (w) w(l); else this.queued.push(l); }
  /** While set (the result card's wait), every stop line — the first, or one after the task's stop has latched — also
   *  comes through next() as STOP_LINE, in its place among the lines: the wait's own stop, armed per wait (review of
   *  #68: a task already stopped ignored later stops, and its card's undo stayed open). */
  stopsAsLines = false;
  closed = false;
  onClosed: (() => void) | null = null;
  stopped = false;
  onStop: ((why: string, cause?: StopCause) => void) | null = null;
  onReask: (() => void) | null = null;
  /** Every answer line, as it arrives (StdioUser's router): it decides each one's outcome there and then. */
  onAnswer: ((a: Extract<Control, { type: "answer" }>) => void) | null = null;
  /** The task stopped ("stop") or the app went away ("ended"): told after the stop's own handlers, and again when stdin
   *  closes (the router keeps the first). */
  onEnd: ((why: "stop" | "ended") => void) | null = null;
  /** Steer lines go to this handler; one read before it is set (the request and a steer in the same stdin batch) waits
   *  and is handed over when it is set, never dropped. */
  get onSteer(): ((text: string) => void) | null { return this.steerTo; }
  set onSteer(h: ((text: string) => void) | null) { this.steerTo = h; if (h) for (const t of this.earlySteers.splice(0)) h(t); }
  private steerTo: ((text: string) => void) | null = null;
  private earlySteers: string[] = [];
  /** The app's stop (a stop line, or a signal): once, whoever asks first; every card waiting for its answer is
   *  answered with nothing. `cause`: user_stopped for a stop line or SIGINT (the user's ^C); none when the app went
   *  away (stdin or stdout closed, a stop line with app_gone, SIGTERM: the helper or a new session process ending it),
   *  which is a stop nobody asked for. */
  stopCause: StopCause | undefined;
  stopWhy = "";
  stop(why = "stopped by the app", cause?: StopCause) {
    if (this.stopped) return;
    this.stopped = true; this.stopWhy = why; this.stopCause = cause;
    // the open card first, with the stop's own reason (stop / ended), then whoever runs the task
    this.onEnd?.(this.closed ? "ended" : "stop");
    this.onStop?.(why, cause);
    for (const w of this.waiting.splice(0)) w("");
  }
  /** The answer lines that came before a router was there (in the request's stdin chunk): taken out, in order. */
  takeAnswers(): Extract<Control, { type: "answer" }>[] {
    const out: Extract<Control, { type: "answer" }>[] = [];
    this.queued = this.queued.filter((l) => { const c = parseControl(l); if (c?.type === "answer") { out.push(c); return false; } return true; });
    return out;
  }
  /** The next line that waits in order (the request, an answer, a respond). `signal`: stop waiting when it fires (a
   *  card voided by a steer) — the waiter is taken out of the queue, so the next line goes to whoever waits next. */
  next(signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) return Promise.resolve("");          // a line waiting in the queue stays for the next reader
    const q = this.queued.shift();
    if (q !== undefined) return Promise.resolve(q);
    if (this.closed) return Promise.resolve("");
    return new Promise((r) => {
      const w = (l: string) => { signal?.removeEventListener("abort", gone); r(l); };
      const gone = () => { const i = this.waiting.indexOf(w); if (i >= 0) this.waiting.splice(i, 1); r(""); };
      this.waiting.push(w);
      signal?.addEventListener("abort", gone, { once: true });
    });
  }
}

/** Every card is an `ask` event; the run waits (`waiting`) for its answer, then goes on (`resumed`).
 *
 *  Replies are routed once, as each line arrives, by one function (`route`) against one registry of cards (review of
 *  #67: the 2nd bug of "every reply gets exactly one outcome", redesigned). A reply goes to the card that is open now
 *  — taken there and then, so a second one for it finds it answered — or is refused at once with the reason from the
 *  registry: that card closed (expired, voided by a steer, stopped, the app gone, answered), no such card is open, it
 *  names no card after a void, the task stopped or ended. Replies never wait in a queue, and no wait reads stdin: an
 *  open card is closed by its signal (steer, timeout), the task's stop or stdin's end, and the router stays on after
 *  the task — late replies are refused, never dropped. */
export class StdioUser implements RuntimeUser {
  constructor(private readonly log: EventLog, private readonly input: LineReader) {
    input.onAnswer = (a) => this.route(a);
    input.onEnd = (why) => this.end(why);
    // answers read before this router existed (with the request, in one chunk): routed now — no card is open yet
    for (const a of input.takeAnswers()) this.route(a);
    if (input.stopped || input.closed) this.end(input.closed ? "ended" : "stop");
  }
  /** A card of this run was voided (steer, timeout): from then on an answer must name its card (ask_id). */
  private voided = false;
  /** The cards no longer open, and how they closed: timeout, steer, stop, ended, answered. */
  private readonly closed = new Map<string, string>();
  /** The card open now: its id, what checks its deadline, and how it is answered or let go. */
  private open: { id: string; card: Card; expired?: () => boolean; settle: (a: Answer | null) => void } | null = null;
  /** The task stopped ("stop"), the app went away ("ended"), or the task is over ("done"): every reply is refused. */
  private over: "stop" | "ended" | "done" | null = null;

  private refuse(a: { ask_id?: string }, why: string) {
    const what = a.ask_id !== undefined ? `answer for ${a.ask_id}` : "an answer without ask_id";
    const card = a.ask_id ?? "a card";
    const text = why === "timeout" ? `card ${card} expired before it was answered (nobody answers for the user): reask asks it again`
      : why === "answered" ? `card ${card} was answered already`
      : why === "stop" ? `the task was stopped; card ${card} is closed`
      : why === "ended" ? `the app went away; card ${card} is closed`
      : why === "done" ? `the task is over; card ${card} is closed`
      : why === "unnamed" ? `a card was voided: an answer must name its card${this.open ? `; the open card is ${this.open.id}` : ""}`
      : why === "none" ? (a.ask_id !== undefined ? `no card ${card} is open${this.open ? `; the open card is ${this.open.id}` : ""}` : "it names no card, and none is open")
      : `card ${card} was voided (${why})`;
    this.log.emit({ kind: "refused", what, why: text, by: "executor" });
  }

  /** One reply's one outcome, decided now. */
  private route(a: Extract<Control, { type: "answer" }>) {
    // a card past its deadline expires first (the tick may not have run: the second after waking — review of #67);
    // its signal's handler closes it here and now
    this.open?.expired?.();
    const o = this.open;
    if (o && (a.ask_id === o.id || (a.ask_id === undefined && !this.voided))) {
      this.closeOpen("answered");
      this.log.emit({ kind: "resumed", ask_id: o.id });
      if (typeof a.option === "number" && a.option >= 0 && a.option < o.card.options.length) return o.settle({ option: a.option });
      if (typeof a.text === "string" && a.text.trim()) return o.settle({ text: a.text });
      return o.settle(null);
    }
    const why = a.ask_id !== undefined ? this.closed.get(a.ask_id) ?? this.over ?? "none" : this.over ?? (this.voided ? "unnamed" : "none");
    this.refuse(a, why);
  }

  private closeOpen(why: string) { if (this.open) { this.closed.set(this.open.id, why); this.open = null; } }

  /** The task stopped or the app went away: the open card is let go (said so); from now on every reply is refused. */
  private end(why: "stop" | "ended" | "done") {
    if (!this.over) this.over = why;
    const o = this.open;
    if (!o) return;
    // any end of the task closes the open card, said so (a task that ends otherwise than by a stop: "ended")
    this.closeOpen(why);
    this.log.emit({ kind: "ask_void", ask_id: o.id, why: why === "done" ? "ended" : why });
    o.settle(null);
  }

  /** The task is over (task_done): replies after it are refused as such. */
  taskOver() { this.end("done"); }

  ask(card: Card, o: { signal?: AbortSignal; expired?: () => boolean } = {}): Promise<Answer | null> {
    const ask_id = `ask_${randomUUID().slice(0, 8)}`;
    // registered (the open record, its settle, its signal; the deadline is the service's, set before this call) BEFORE
    // anything announces it: the app may answer inside the very `ask` it is handed (an in-process sink, a synchronous
    // stdin) — review of #67. Closing goes the other way: unregistered first, then said (ask_void / resumed)
    let settle!: (x: Answer | null) => void;
    const p = new Promise<Answer | null>((resolve) => {
      let settled = false;
      settle = (x) => { if (settled) return; settled = true; o.signal?.removeEventListener("abort", voided); resolve(x); };
    });
    // the user changed the request (steer), nobody answered in time (timeout), or the task ended under it ("ended":
    // the runtime died, the executor failed): the card is let go, the app told
    const voided = () => {
      if (this.open?.id !== ask_id) return;
      const reason = o.signal!.reason;
      const why = reason === "ended" ? "ended" : reason === "timeout" ? "timeout" : "steer";
      this.closeOpen(why);
      if (why === "ended") this.log.emit({ kind: "ask_void", ask_id, why: "ended" });
      else { this.voided = true; this.log.emit({ kind: "resumed", ask_id, voided: why }); this.log.emit({ kind: "ask_void", ask_id, why }); }
      settle(null);
    };
    this.open = { id: ask_id, card, ...(o.expired ? { expired: o.expired } : {}), settle };
    o.signal?.addEventListener("abort", voided, { once: true });
    this.log.emit({ kind: "ask", ask_id, card: { kind: card.kind, text: card.text, options: card.options.map((o) => ({ kind: o.kind, text: o.text })), free_text: card.free_text, blocking: card.blocking, ...(card.plan ? { plan: card.plan } : {}), ...(card.consent ? { consent: card.consent } : {}) } });
    // (answered or let go inside its own announcement: nothing more is said of it)
    if (this.open?.id !== ask_id) return p;
    this.log.emit({ kind: "waiting", ask_id });
    if (this.open?.id !== ask_id) return p;
    // stopped or gone before it was shown, or already voided: let go at once
    if (this.over === "stop" || this.over === "ended") this.end(this.over);
    else if (o.signal?.aborted) voided();
    return p;
  }
}

/** The runtime's internal events, mapped onto the protocol. Unknown kinds are not sent. */
export function toProtocol(kind: string, body: Record<string, unknown>): EventBody | null {
  // a model fills optional fields with "" and 0: the step the app shows is the action without them
  const s = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x, (_, v) => (v === "" || v === 0 ? undefined : v)));
  switch (kind) {
    // a step is the executor's (step.start / step.end, ExecutorService.step), so it reaches the app whoever the caller
    // is; `text` stays the action as before (a file action: its capability and arguments), for the app as shipped
    case "step.start": { const a = body.action as { kind?: string; capability?: unknown; args?: unknown };
      return { kind: "step", text: a?.kind === "file" ? `${s(a.capability)} ${s(a.args)}` : s(a), purpose: s(body.purpose ?? ""), ...(body.consequence ? { consequence: body.consequence as never } : {}), ...(body.object ? { object: s(body.object) } : {}),
        step_id: s(body.step_id), ...(body.human ? { human: s(body.human) } : {}), ...(body.target ? { target: body.target as never } : {}), ...(typeof body.plan_step === "number" ? { plan_step: body.plan_step } : {}) }; }
    case "step.end": return { kind: "step_result", step_id: s(body.step_id), status: body.status as never, ...(body.why ? { why: s(body.why).slice(0, 500) } : {}), ...(body.executor_status ? { executor_status: s(body.executor_status) } : {}), ...(body.consequence ? { consequence: body.consequence as never } : {}), ...(typeof body.possibly_done === "boolean" ? { possibly_done: body.possibly_done } : {}),
      ...(body.shot ? { shot: s(body.shot), ...(body.shot_pending ? { shot_pending: true } : {}) } : {}), ...(body.target_frame ? { target_frame: body.target_frame as never } : {}), ...(body.window_frame ? { window_frame: body.window_frame as never } : {}) };
    case "shot.ready": return { kind: "shot_ready", step_id: s(body.step_id), shot: s(body.shot) };
    case "executor.user_wait": return { kind: "waiting" };            // the user is at the keyboard: the app says "paused while you use your Mac"
    case "executor.user_resumed": return { kind: "resumed", why: body.stopped ? "stopped" : body.timed_out ? "timed_out" : "" };
    case "steer.applied": return { kind: "steered", text: s(body.raw) };
    case "executor.verdict": return { kind: "verify", verdict: body.verdict as never, ...(body.by ? { by: s(body.by) } : {}), reason: s(body.reason ?? "").slice(0, 500), ...(body.missing_kind ? { missing_kind: body.missing_kind as never } : {}), ...(body.judge_id ? { judge_id: s(body.judge_id) } : {}) };
    case "changes": { const c = body as Record<string, string[]>; return { kind: "changes", created: c.created ?? [], modified: c.modified ?? [], deleted: c.deleted ?? [], external: c.external ?? [], unconfirmed: c.unconfirmed ?? [], ...(c.created_windows?.length ? { created_windows: c.created_windows } : {}) }; }
    // the executor's refusals (stale, stopped, environment, blocked, error) also stand as their own line; an action that
    // went out but could not be read back (unverified) is the step's result, not a refusal
    case "executor.act": return body.status === "ok" || body.status === "needs_consent" || body.status === "unverified" ? null
      : { kind: "refused", what: s(body.action), why: `${s(body.status)}${body.why ? ": " + s(body.why) : ""}`, by: "executor" };
    case "plan": return { kind: "plan", steps: body.steps as never };
    case "consent.asked": return { kind: "consent", object: s(body.object), consequence: body.consequence as never, scope: "action", picked: (body.picked as string | null) ?? null };
    case "plan.confirmed": return null;
    case "answer.given": return { kind: "answer_given", text: s(body.text) };
    case "judge.answer": { const a = body.answer as { choice: string; by: string; confidence?: number } | null;
      return { kind: "judge", judge_id: s(body.judge_id), question: s(body.name ?? "other"), answer: a?.choice ?? null, by: a?.by ?? null, ...(typeof a?.confidence === "number" ? { confidence: a.confidence } : {}),
        tiers: (body.tiers as never) ?? [], ...(body.shadow ? { shadow: body.shadow as never } : {}), ...(body.step_id ? { step_id: s(body.step_id) } : {}), ...(typeof body.ms === "number" ? { ms: body.ms } : {}) }; }
    // the user's words came after the task was over: said, not dropped
    case "steer.refused": return { kind: "refused", what: `steer: ${s(body.raw)}`, why: s(body.why), by: "executor" };
    // 「现在回答」 with no card expired (or after the task): said, nothing happens
    case "reask.refused": return { kind: "refused", what: "reask", why: s(body.why), by: "executor" };
    default: return null;
  }
}

/** The tutorials the model may read: the shipped ones beside this code and the user's (`skills` in the request, or
 *  ~/.deskmind/skills), filtered by structure (the apps, the folder's file types) — never by the words of the request
 *  (skills-layer-2026-10-18.md §检索). The apps are the request's when it names them; the app no longer guesses them
 *  (rc.10), so otherwise they are facts of the computer as the task began: the frontmost app and every app with a
 *  window, by every name the driver gives (bundle id, localized name). Read when the candidates are asked for, after
 *  begin. The base skill is the system prompt already, so it is not a candidate. */
export function skillsFor(req: Request, ws?: Workspace, computer?: () => Snapshot | null, dirsOverride?: string[]): SkillSource {
  const dirs = (dirsOverride ?? [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills"), req.skills ?? path.join(os.homedir(), ".deskmind", "skills")]).filter((d) => fs.existsSync(d));
  const fileTypes = ws ? [...new Set(Object.keys(ws.entries()).map((p) => p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "").filter(Boolean))] : [];
  const appsNow = (): string[] => {
    if (req.apps?.length) return req.apps;
    const s = computer?.();
    if (!s) return [];
    return [...new Set([s.front_app, ...s.windows.flatMap((w) => [w.app, w.app_name, w.bundle])].filter((x): x is string => !!x))];
  };
  const sources = () => { const facts = { apps: appsNow(), fileTypes, objects: req.scope ? [req.scope] : [] }; return dirs.map((d) => new SkillStore(d).source(facts)); };
  return {
    candidates: (raw) => sources().flatMap((s) => s.candidates(raw)).filter((c) => c.name !== "deskmind-computer-use"),
    read: (name) => sources().map((s) => s.read(name)).find((t) => t !== null) ?? null,
  };
}

function driverFor(name: Request["driver"], scope?: string): Driver {
  if (name === "hands") return new HandsDriver(scope ? { workspace: path.resolve(scope) } : {});
  return new SimComputer(scope);
}

/** Every executor and runtime event as it was emitted, beside the run's protocol events: the app shows only the
 *  protocol (steps, cards, refusals), and a problem on a real Mac -- why a consent was asked again, what an action's
 *  `why` was -- could not be read from the run afterwards (rc.8, 10-20). What it holds is the user's: their words
 *  (the request, their free answers on cards), what was read from their windows, the judge's prompts. It stays on
 *  this Mac, like the run's other files, and nothing sends it anywhere. The harness removes no run folders itself:
 *  the app's helper keeps the ten newest under its harness-runs folder and deletes the rest after each run
 *  (deskmind Runner.pruneHarnessRuns), trace included; a run started from the command line is kept until deleted. Long strings and long
 *  lists are cut, with a "…(+n)" mark of what was left out, so a prompt or an observation does not make it huge. */
export function traceWriter(file: string): (kind: string, body: Record<string, unknown>) => void {
  const cut = (v: unknown): unknown => typeof v === "string" ? (v.length > 4000 ? v.slice(0, 4000) + `…(+${v.length - 4000})` : v)
    : Array.isArray(v) ? (v.length > 200 ? [...v.slice(0, 200).map(cut), `…(+${v.length - 200})`] : v.map(cut))
    : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, cut(x)])) : v;
  return (kind, body) => {
    // the step in progress (otel/context): an executor event, a judge's, a model call's — each names the step it served
    // and the span in progress (otel/trace.ts): the line's place in the call chain of trace.otel.jsonl
    const c = traceContext();
    try { fs.appendFileSync(file, JSON.stringify({ t: Date.now(), kind, ...(c.step_id ? { step_id: c.step_id } : {}), ...(c.span ? { span_id: c.span.spanId } : {}), ...(cut(body ?? {}) as Record<string, unknown>) }) + "\n"); } catch { /* the trace never stops a run */ }
  };
}

/** `signals` (the CLI only): SIGINT / SIGTERM stop the run through the same one-time stop as a stop line. When the
 *  run has not ended `deadlineMs` after the signal: if an action is still out at the driver (it may land after a stop),
 *  wait up to `waitMs` more for its receipt; then write task_done (stopped) — with the action under
 *  changes.unconfirmed if it never answered — and exit. A second signal writes task_done and exits at once.
 *  `inject` (tests): a driver, a gateway, a model in place of the config's. */
export async function appRun(req: Request, o: { runs: string; out: (ev: AppEvent) => void; input: LineReader; linger: number;
  signals?: { onSignal: (h: (sig: string) => void) => void; exit: () => void; exitNow: () => void; deadlineMs?: number; waitMs?: number };
  inject?: { driver?: Driver; gateway?: Gateway; model?: RuntimeOptions["model"]; agent?: AgentSpec["model"]; cardExpiryMs?: number; clock?: Clock } }) {
  const runId = req.run_id ?? `run_${randomUUID().slice(0, 8)}`;
  const log = new EventLog(path.join(o.runs, runId, "events.jsonl"), runId, o.out);
  const config = req.config ?? "ds-flash";   // the app's default: DeepSeek; the yy gateway is for in-house testing
  const trace = traceWriter(path.join(o.runs, runId, "trace.jsonl"));
  // the run as an OpenTelemetry trace (otel/trace.ts): trace.otel.jsonl beside the events, on this Mac only
  const tracer = new Tracer(path.join(o.runs, runId, "trace.otel.jsonl"), { "deskmind.run_id": runId });
  const root = tracer.start("invoke_agent deskmind", { parent: null, attrs: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "deskmind", "gen_ai.conversation.id": runId, "deskmind.run_id": runId, "deskmind.config": config, "deskmind.lang": req.lang ?? "zh", "deskmind.driver": req.driver ?? "sim" } });
  const closeTrace = (status: string, reason: string) => { root.set({ "deskmind.status": status, "deskmind.reason": reason.slice(0, 300) }); tracer.closeAll(undefined, root); tracer.end(root); };
  log.emit({ kind: "start", raw: req.raw, lang: req.lang ?? "zh", engine: req.engine ?? "runtime", config, ...(req.scope ? { scope: req.scope } : {}), protocol: { events: PROTOCOL.events } });
  const table = configTable(config);
  if (!table) { log.emit({ kind: "task_done", status: "failed", reason: `unknown config ${config}`, summary: "", result_card: null }); closeTrace("failed", `unknown config ${config}`); return; }
  // every model call of the run (the run's gateway, a judge tier's, the acting model's turns) reaches the recorder through
  // the run's context (otel/context): model_calls.jsonl, the trace, a model_call event while the run is on, the sum
  const gw = o.inject?.gateway ?? new Gateway(table);
  const usage = { calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, by_role: Object.create(null) as Record<string, { calls: number; tokens_in: number; tokens_out: number; cost_usd: number; latency_ms: number }> };     // keyed by a record's role: no prototype to reach through it
  const onModelCall = (r: ModelCallRecord) => {
    try { fs.appendFileSync(path.join(o.runs, runId, "model_calls.jsonl"), JSON.stringify(r) + "\n"); } catch { /* recording never stops a run */ }
    const { answer: _a, ...brief } = r;
    trace("model.call", brief);
    const b = (usage.by_role[r.role] ??= { calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_ms: 0 });
    for (const x of [usage, b]) { x.calls += 1; x.tokens_in += r.tokens_in; x.tokens_out += r.tokens_out; x.cost_usd = Number((x.cost_usd + r.cost_usd).toFixed(9)); }
    b.latency_ms += r.latency_ms;
    // a raced judge call can answer after the run: on disk and in the trace, never after task_done
    if (!done) log.emit({ kind: "model_call", call_id: r.call_id, role: r.role, model: r.model, outcome: r.outcome, tokens_in: r.tokens_in, tokens_out: r.tokens_out, cost_usd: r.cost_usd, latency_ms: r.latency_ms, ...(r.step_id ? { step_id: r.step_id } : {}), ...(typeof r.cache_read === "number" ? { cache_read: r.cache_read } : {}), ...(r.cost_estimated ? { cost_estimated: true } : {}), ...(r.judge_id ? { judge_id: r.judge_id } : {}) });
  };
  const signer = ConsentSigner.fresh();
  const ws = req.scope ? new Workspace(req.scope) : undefined;
  // undo copies: this run's in a folder of its own; a run killed before any exit path ran left its folder behind —
  // swept now, by its owner process being gone
  if (ws) { ws.undoOwner = runId; ws.sweepTemp({ except: runId }); }   // dead runs' undo copies, old tool outputs, a dead process's volume probe
  // one task_done per run, and it is the last running event: what the runtime or an action still out at the driver says
  // after it (a stop's deadline wrote it) is in the trace only. The words of a steer that came too late are still said
  let done = false;
  const send = (k: string, b: Record<string, unknown>) => { trace(k, b); const e = toProtocol(k, b); if (e && (!done || k === "steer.refused" || k === "shot.ready")) log.emit(e); };
  // the journal lives beside the run's events: an app-run started again with the same run_id finds what the last
  // process did without a receipt and tells the model (D10)
  const executor = new Executor(o.inject?.driver ?? driverFor(req.driver, req.scope), { task: runId, publicKey: signer.publicKey, journal: path.join(o.runs, runId, "journal.jsonl"), shots: path.join(o.runs, runId, "shots"), onEvent: send });
  // the chat model's restatement (a session's computer task) is not the user's words, and it may carry what an earlier
  // task read (its summary went back to the chat model): read material, so an open of a site not approved asks the
  // provenance judge, anchored on raw — a run never starts with nothing read when the request was written by a model
  if (typeof req.context === "string" && req.context.trim()) executor.noteTakenIn("the chat model's restatement (request.context)", req.context);
  log.emit({ kind: "preparing" });
  // the cards' replies: routed as they arrive, from here until the process exits (before and after task_done)
  const user = new StdioUser(log, o.input);
  const rt = new FrontierRuntime({
    task: runId, raw: req.raw, ...(typeof req.context === "string" && req.context.trim() ? { context: req.context } : {}), executor, signer, user, gateway: gw,
    // the agent loop: its own process (P2), its own files beside the run's; a model handed in (tests) runs in this one
    ...(o.inject?.model ? { model: o.inject.model } : {}),
    agent: { model: o.inject?.agent ?? table.goal.model, log: path.join(o.runs, runId, "runtime.jsonl"), stderr: path.join(o.runs, runId, "runtime.log") },
    ...(ws ? { workspace: ws, registry: fileRegistry() } : {}),
    skills: skillsFor(req, ws, () => executor.beginSnapshot), lang: req.lang ?? "zh", ...(req.rules ? { rules: req.rules } : {}),
    // a real desktop takes more looks than the check set's folders: a pixel-mode app needs an observation per step
    // and the old engine used ~20 actions on the music sample; the evaluation keeps the default budget
    budget: req.driver === "hands" ? { tool_calls: 90, turns: 60 } : {},
    onEvent: send,
    // an action card nobody answers is voided after 10 minutes by the wall clock; the task then waits for the user
    cardExpiryMs: o.inject?.cardExpiryMs ?? CARD_EXPIRY_MS, ...(o.inject?.clock ? { clock: o.inject.clock } : {}),
  });
  // one stop for the run, whoever asks (a stop line, a signal): one refused event, the first asker's reason
  let stopReason = "";
  let stopCause: StopCause | undefined;
  const stopRun = (why: string, cause?: StopCause) => { if (stopReason) return; stopReason = why; stopCause = cause; log.emit({ kind: "refused", what: "the task", why, by: "user" }); rt.stop(why, cause); };
  o.input.onStop = stopRun;
  if (o.input.stopped) stopRun(o.input.stopWhy, o.input.stopCause);     // a stop line read together with the request, before this
  // the app went away (stdin closed) while the task runs: a stop, the same path as a stop line (owner 10-21: the helper
  // exits → its running tasks stop) — the step in flight gets its receipt, task_done says stopped, the process exits.
  // After task_done (the result card's linger) it only ends the wait
  const appGone = () => { if (!done) o.input.stop("the app went away (stdin closed)"); };
  o.input.onClosed = appGone;
  if (o.input.closed) appGone();
  // the user's words mid-run: to the executor, which applies them between steps (the judges then read the request as
  // it was and every change), voids an open card, and asks for a new plan card when the new words go beyond the plan
  // (after the task is over — a verdict passed, a stop, the result card's linger — the executor refuses them: a refused event)
  o.input.onSteer = (text) => { trace("control.steer", { text }); if (text.trim()) rt.steer(text); };
  // 「现在回答」 on an expired action card: the executor asks it again on the screen as it is now (after the task is
  // over it is refused, in the trace only: nothing but a late steer's refusal follows task_done)
  o.input.onReask = () => { trace("control.reask", {}); rt.reask(); };
  // one task_done per run: a signal's deadline may write it before the runtime returns
  let signals = 0, ended = () => {};
  const whenDone = new Promise<void>((res) => { ended = res; });
  const taskDone = (body: EventBody) => { if (done) return; done = true; user.taskOver(); log.emit(body); ended(); };
  // the run did not end by itself in time: an action still out at the driver may land after this, so the stop is not
  // called clean — the action is listed as unconfirmed and the reason says its result is unknown
  const forceDone = () => {
    if (done) return;
    const f = executor.inFlight, c = executor.changes();
    closeTrace("stopped", f ? STEP_UNKNOWN : stopReason || "stopped");
    const cause: StopCause | undefined = f ? "last_step_unknown" : stopCause;
    // a task that changed something has its result card here too (M2 H2): the executor's, which names a step still in
    // flight as unknown and offers no undo then
    // (the process exits right after: nobody can answer an undo, so none is offered — review of #68)
    const rc = rt.resultCard();
    taskDone({ kind: "task_done", status: "stopped", reason: f ? STEP_UNKNOWN : stopReason || "stopped", ...(cause ? { cause } : {}), summary: "", result_card: rc ? cardEvent(rc, false, req.lang) : null, changes: f ? { ...c, unconfirmed: [...c.unconfirmed, f.object] } : c, usage, ...(rt.usageIncomplete ? { usage_incomplete: true } : {}) } as EventBody);
  };
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
  o.signals?.onSignal((sig) => {
    const sg = o.signals!;
    // (after task_done: the card's wait is cut by the signal — a new task ending a lingering one — so the window closes)
    if (done) { executor.discardUndoCopies(); return sg.exit(); }
    if (++signals > 1) { forceDone(); executor.discardUndoCopies(); return sg.exitNow(); }
    o.input.stop(`stopped by ${sig}`, sig === "SIGINT" ? "user_stopped" : undefined);
    void (async () => {
      await sleep(sg.deadlineMs ?? 800);
      if (!done && executor.inFlight) {
        await Promise.race([executor.settled(), sleep(sg.waitMs ?? 10_000)]);
        // the receipt came: the runtime writes its own task_done a moment later
        if (!executor.inFlight) await Promise.race([whenDone, sleep(500)]);
      }
      forceDone(); executor.discardUndoCopies(); sg.exit();
    })();
  });
  const r = await within({ onModelCall, tracer, span: root }, () => rt.run());
  if (!done) closeTrace(r.status, r.reason);
  // the result card is answered while this process is alive (undo needs the executor's receipts): it waits `--linger`
  // seconds by the wall clock (a Mac asleep meanwhile ends the wait within a second of waking: executor/clock.ts) for
  // `{"type":"respond","option":<index>}` (v0: `{"respond":<index>}`) on stdin, then exits. Not after a signal: the
  // process exits then. The undo's deadline is said on task_done (undo_until, seconds like `t`), from the same clock
  const clock = o.inject?.clock ?? WALL_CLOCK;
  // (stdin closed already: the app went away, nothing can answer — no wait, no deadline said)
  const lingers = !!r.result_card && o.linger > 0 && !signals && !o.input.closed;
  // undo is offered only while something waits to carry it out (review of #68): with no wait — no --linger, after a
  // signal, stdin closed — the card has no undo option, and says why
  const card = r.result_card ? cardEvent(r.result_card, lingers, req.lang) : null;
  const until = lingers ? clock.now() + o.linger * 1000 : 0;
  const undoUntil = lingers && card!.options.some((x) => x.kind === "undo") ? { undo_until: until / 1000 } : {};
  // the card waits from the moment task_done says so: from here a stop closes it (armed before task_done is written)
  if (lingers) o.input.stopsAsLines = true;
  taskDone({ kind: "task_done", status: r.status, reason: r.reason, ...(r.cause ? { cause: r.cause } : {}), summary: r.summary, result_card: card as never, ...undoUntil, answer: r.answer, changes: executor.changes(), usage, ...(rt.usageIncomplete ? { usage_incomplete: true } : {}) } as never);
  // the undo window closes when this process stops waiting for the card: its undo copies go then (an undo restored and
  // removed its own already)
  if (signals) { executor.discardUndoCopies(); return o.signals!.exit(); }
  // Any other line in that time (a late answer to a card that is gone, a line that is not JSON) is passed over and the
  // wait goes on: only a respond, the app closing stdin (or stopping), or the deadline ends it (deskmind S0: undo was
  // dead when the first line after task_done was not the respond)
  if (lingers) {
    const deadline = new AbortController();
    const cancel = atWallTime(clock, until, () => deadline.abort());
    // every respond that reaches this process gets exactly one result_response (review of #68: the session and this
    // process each read their own clock, so a respond the session forwarded a moment before undo_until can arrive
    // after this deadline). At the deadline the card closes — said (result_card_closed{why:"expired"}), so the session
    // stops forwarding and ends this stdin — and every respond still read is answered "expired", nothing undone,
    // until stdin ends (at most EXPIRED_GRACE_MS, for a reader that never ends it)
    const expired = (picked: string) => log.emit({ kind: "result_response", picked, effect: "expired: nothing was undone", ...(picked === "undo" ? { undone: 0, total: executor.undoable().steps.length, refused: "expired" } : {}) } as never);
    try {
      for (;;) {
        const line = await o.input.next(deadline.signal);
        // a stop while the card waits closes it and its undo, whatever stopped before (the task's own stop latched
        // earlier: that one ended the task, this one ends the wait); one that comes during an undo under way is read
        // only after it — an undo is never cut short (its result_response is written)
        if (line === STOP_LINE || (!deadline.signal.aborted && !line && (o.input.closed || o.input.stopped))) break;
        if (deadline.signal.aborted) {
          log.emit({ kind: "result_card_closed", why: "expired" } as never);
          const grace = new AbortController();
          const t = setTimeout(() => grace.abort(), EXPIRED_GRACE_MS);
          try {
            // (the line read as the deadline fired, then every one until stdin ends)
            let l: string = line;
            for (;;) {
              const a = l ? parseControl(l) : null;
              if (a?.type === "respond" && typeof a.option === "number") expired(card!.options[a.option]?.kind ?? "other");
              l = await o.input.next(grace.signal);
              if (grace.signal.aborted || l === STOP_LINE || (!l && (o.input.closed || o.input.stopped))) break;
            }
          } finally { clearTimeout(t); }
          break;
        }
        const a = parseControl(line);
        if (a?.type !== "respond" || typeof a.option !== "number") continue;
        // the deadline, asked as the answer arrives: the Mac's timers stop in sleep, and an undo sent in the second after
        // waking past it would otherwise be carried out (review of #68). Past it, nothing is undone, and that is said
        if (clock.now() >= until) { deadline.abort(); expired(card!.options[a.option]?.kind ?? "other"); continue; }
        const u = await rt.respond({ option: a.option });
        log.emit({ kind: "result_response", picked: card!.options[a.option]?.kind ?? "other", effect: u ? (u.refused ? `undone ${u.undone}/${u.total}, stopped: ${u.refused}` : `undone ${u.undone}/${u.total}`) : "noted", ...(u ? { undone: u.undone, total: u.total, refused: u.refused, ...(u.unsure ? { unsure: u.unsure } : {}) } : {}) } as never);
        break;
      }
    } finally { cancel(); o.input.stopsAsLines = false; }
  }
  executor.discardUndoCopies();
}

/** After the result card's deadline, how long the process still reads stdin to answer responds already on their way
 *  ("expired") before it exits, when nothing ends stdin (the session ends it as soon as it hears the card closed). */
export const EXPIRED_GRACE_MS = 2000;

/** A result card as the protocol carries it. `offerUndo` false: nothing will wait to carry an undo out, so its option is
 *  left off and the card says why. */
const cardEvent = (c: Card, offerUndo = true, lang?: string) => {
  const drop = !offerUndo && c.options.some((x) => x.kind === "undo");
  return { kind: c.kind, text: drop ? `${c.text}\n${T(lang).noUndo(T(lang).noWait)}` : c.text, options: c.options.filter((x) => !drop || x.kind !== "undo").map((x) => ({ kind: x.kind, text: x.text })), free_text: c.free_text, blocking: c.blocking };
};

export function respond(runId: string, runs: string, answer: Record<string, unknown>, out: (ev: AppEvent) => void) {
  const log = new EventLog(path.join(runs, runId, "events.jsonl"), runId, out);
  log.emit({ kind: "result_response", picked: typeof answer.option === "number" ? String(answer.option) : null, ...(typeof answer.text === "string" ? { text: answer.text } : {}), effect: "recorded; undo for the runtime is not built yet, nothing was changed" });
}

/** No model, no network: the executor on a simulated computer, and one scripted runtime turn that ends as cannot —
 *  once with the runtime in this process, once as its own process (`runtime`, served over MCP: executor split P2). */
export async function selftest(): Promise<Record<string, unknown>> {
  const sim = new SimComputer();
  const w = sim.addEditor("编辑器");
  const signer = ConsentSigner.fresh();
  const ex = new Executor(sim, { task: "selftest", publicKey: signer.publicKey });
  const snap = await ex.begin();
  const obs = await ex.observe(w.id);
  const pre = ex.preview({ action: { kind: "click", window: w.id, target: obs.elements[0]!.id }, epoch: obs.epoch });
  const gw = new Gateway(Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as never);
  const rt = new FrontierRuntime({
    task: "selftest", raw: "自检", executor: new Executor(new SimComputer(), { task: "selftest", publicKey: signer.publicKey }), signer, user: { ask: () => null }, gateway: gw,
    model: { model: { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as never, streamFn: scriptedStream([{ calls: [{ name: "computer_snapshot", args: {} }] }, { calls: [{ name: "finish", args: { outcome: "cannot", summary: "selftest" } }] }]) },
  });
  const r = await rt.run();
  const t0 = Date.now();
  const child = new FrontierRuntime({
    task: "selftest-process", raw: "自检", executor: new Executor(new SimComputer(), { task: "selftest-process", publicKey: signer.publicKey }), signer, user: { ask: () => null }, gateway: gw, mode: "process",
    agent: { model: { scripted: [{ calls: [{ name: "computer_snapshot", args: {} }] }, { calls: [{ name: "finish", args: { outcome: "cannot", summary: "selftest" } }] }] } },
  });
  const r2 = await child.run();
  const ended = (x: typeof r) => x.status === "failed" && x.reason.startsWith("cannot") && (x.counters["tool_calls"] ?? 0) === 2;
  const ok = snap.windows.length === 1 && snap.windows[0]!.owner === "user" && pre.consequence === "modify_user" && pre.needs_consent && ended(r) && child.mode === "process" && ended(r2);
  return { ok, node: process.version, windows: snap.windows.length, floor: pre.consequence, runtime: r.status, tool_calls: r.counters["tool_calls"] ?? 0, process: { status: r2.status, tool_calls: r2.counters["tool_calls"] ?? 0, ms: Date.now() - t0 } };
}

/** Can the configured model be reached with the keys in the environment? One choice question; the key never
 *  appears in the answer (a service's error text is cut and stripped of anything that looks like one). */
export async function modelCheck(config0: string): Promise<{ ok: boolean; model?: string; ms?: number; error?: string }> {
  // the same check a session's open makes: Test says connected only for a config a session will take
  const bad = configSyntaxProblem(config0);
  if (bad) return { ok: false, error: bad };
  const config = normalizeConfig(config0);
  const table = configTable(config);
  if (!table) return { ok: false, error: `unknown config ${config}` };
  const t0 = Date.now();
  const rep = await new Gateway(table).ask("choice", "只输出 JSON。", "问题：1+1=2 吗？选项 yes / no。", R.choiceAnswer(["yes", "no"]), "model-check");
  const scrub = (e: string) => redactKeys(e).slice(0, 200);
  return rep.outcome === "answered" ? { ok: true, model: table.choice.model, ms: Date.now() - t0 } : { ok: false, model: table.choice.model, error: scrub(`${rep.outcome}: ${rep.error ?? ""}`) };
}

async function main() {
  // the chat session has its own options (cli/session.ts): handed over before this command line is parsed
  const sub = process.argv[2];
  if (sub === "session" || sub === "sessions") { const code = await sessionMain(process.argv.slice(2)); process.stdout.write("", () => process.exit(code)); return; }
  const { values: a, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { linger: { type: "string", default: "0" },
    request: { type: "string" }, runs: { type: "string", default: "runs/app" }, run: { type: "string" }, selftest: { type: "boolean", default: false }, config: { type: "string", default: "ds-flash" },
    out: { type: "string" },
  } });
  // the reader of stdout went away (the session or the app died: EPIPE): events still go to the run's files, never to
  // the dead pipe, and the run is stopped like a stop line (in executor mode, below) instead of crashing mid-action
  let stdoutGone = false, onStdoutGone = () => {};
  process.stdout.on("error", () => { if (stdoutGone) return; stdoutGone = true; onStdoutGone(); });
  const out = (ev: AppEvent) => { if (!stdoutGone) process.stdout.write(JSON.stringify(ev) + "\n"); };
  if (a.selftest) { const r = await selftest(); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
  const cmd = positionals[0];
  if (cmd === "model-check") { const r = await modelCheck(a.config!); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
  if (cmd === "trace" && positionals[1] === "export") {
    // a run's call chain as one OTLP/JSON request, for Jaeger, Phoenix or Langfuse (POST it to their /v1/traces);
    // read from this Mac's run folder, written where --out says, sent nowhere
    if (!a.run || !a.out) { console.error("usage: trace export --run <id> --out <file> [--runs <dir>]"); process.exit(2); }
    const file = path.join(path.resolve(a.runs!), a.run, "trace.otel.jsonl");
    if (!fs.existsSync(file)) { console.error(`no trace for ${a.run}: ${file}`); process.exit(1); }
    const r = exportTrace(file);
    fs.writeFileSync(a.out, JSON.stringify(r.request));
    console.log(JSON.stringify({ ok: true, spans: r.spans, out: path.resolve(a.out) }));
    process.exit(0);
  }
  // the runtime's stdin is the MCP channel: no control-line reader on it (review of P2)
  if (cmd === "runtime") { const code = await runtimeMain(); process.stdout.write("", () => process.exit(code)); return; }
  const input = new LineReader(process.stdin);
  if (cmd === "app-run" || cmd === "executor") {
    // SIGINT / SIGTERM: before the run has started there is nothing to stop; after, the run ends as stopped
    // (task_done written) and the process exits within a second. stdout is drained before exit.
    const exit = () => (stdoutGone ? process.exit(0) : process.stdout.write("", () => process.exit(0)));
    onStdoutGone = () => input.stop("the app went away (stdout closed)");
    const exitNow = () => process.exit(0);           // a second signal: no waiting for stdout either
    let onSignal: (sig: string) => void = () => exitNow();
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => onSignal(sig));
    const req: Request = JSON.parse(a.request ? fs.readFileSync(a.request, "utf-8") : await input.next());
    if (!req.raw) throw new Error("request needs raw");
    await appRun(req, { runs: path.resolve(a.runs!), out, input, linger: Number(a.linger ?? 0), signals: { onSignal: (h) => { onSignal = h; }, exit, exitNow } });
    exit();
    return;
  }
  if (cmd === "respond") {
    if (!a.run) throw new Error("respond needs --run <id>");
    respond(a.run, path.resolve(a.runs!), JSON.parse(await input.next()), out);
    process.exit(0);
  }
  console.error("usage: executor|app-run [--request <file>] [--runs <dir>] | runtime | respond --run <id> | model-check --config <name> | trace export --run <id> --out <file> | session [--session <id>] [--dir <d>] | sessions list [--dir <d>] | --selftest");
  process.exit(2);
}

const entry = process.argv[1] ?? "";
if (/app\.(ts|js)$|harness\.mjs$/.test(entry)) main().catch((e) => { console.error(e); process.exit(1); });
