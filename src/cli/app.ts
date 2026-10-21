/**
 * The app's entry point (DeskMind Hands.app runs this as a child process; design notes
 * docs/design/harness-app-integration-2026-10-17.md §2): JSON events out on stdout, one per line, each written to the
 * run's event log first (protocol/events.ts); answers to cards come back on stdin as JSON lines.
 *
 *   app-run [--request <file>] [--runs <dir>]   stdin line 1 (or the file): {run_id?, raw, scope?, config?, engine?, lang?, driver?};
 *                                               then control lines (protocol/control.ts); SIGINT / SIGTERM stop the run
 *   respond --run <id> [--runs <dir>]           stdin line 1: {option} | {text}  — the user's answer to the result card
 *   --selftest                                  no model, no network: the packaged binary's health check
 *   model-check --config <name|openai:prov|model> one tiny question to the configured model: {ok, model, ms} or {ok:false, error} — the app's "test" button
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
import { configTable, Gateway } from "../gateway/index.js";
import * as R from "../protocol/roles.js";
import { ConsentSigner } from "../executor/consent.js";
import { Executor } from "../executor/executor.js";
import { SimComputer } from "../executor/sim.js";
import { HandsDriver } from "../executor/hands.js";
import { SkillStore } from "../skills/agentskills.js";
import type { SkillSource } from "../executor/service.js";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { ConsentToken, Driver, Snapshot } from "../executor/types.js";
import { FrontierRuntime, type RuntimeOptions, type RuntimeUser } from "../host/frontier.js";
import { loopModel } from "../runtime/model.js";
import { scriptedStream } from "../runtime/scripted.js";
import { EventLog, type AppEvent, type EventBody } from "../protocol/events.js";
import { isForeignControl, parseControl } from "../protocol/control.js";
import { PROTOCOL } from "../protocol/version.js";
import type { Answer, Card } from "../orchestrator/index.js";
import { fileRegistry } from "../registry/fs.js";
import { Workspace } from "../registry/workspace.js";

/** task_done's reason when a stop could not wait for an action the driver had not answered. */
export const STEP_UNKNOWN = "a step was in progress; its result is unknown";

export interface Request { run_id?: string; raw: string; scope?: string; config?: string; engine?: "runtime"; lang?: "zh" | "en"; driver?: "sim" | "hands"; apps?: string[]; skills?: string; rules?: ConsentToken[] }

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
      if (c?.type === "stop") { this.stop(); return; }
      if (c?.type === "steer") { this.onSteer?.(c.text); return; }
      // a type this version does not know (additions keep the version): not for us. Anything else waits for next():
      // the request line, an answer, or a line that is not JSON (the reader of next() says what it makes of it)
      if (!c && isForeignControl(l)) return;
      const w = this.waiting.shift(); if (w) w(l); else this.queued.push(l);
    });
    // the app went away (stdin closed): every open card is answered with nothing, so the run ends instead of hanging
    rl.on("close", () => { this.closed = true; for (const w of this.waiting.splice(0)) w(""); });
  }
  closed = false;
  stopped = false;
  onStop: ((why: string) => void) | null = null;
  onSteer: ((text: string) => void) | null = null;
  /** The app's stop (a stop line, or a signal): once, whoever asks first; every card waiting for its answer is
   *  answered with nothing. */
  stop(why = "stopped by the app") { if (this.stopped) return; this.stopped = true; this.onStop?.(why); for (const w of this.waiting.splice(0)) w(""); }
  next(): Promise<string> { const q = this.queued.shift(); return q !== undefined ? Promise.resolve(q) : this.closed ? Promise.resolve("") : new Promise((r) => this.waiting.push(r)); }
}

/** Every card is an `ask` event; the run waits (`waiting`) for the matching answer line, then goes on (`resumed`).
 *  An answer for another ask_id is not an answer to this card: it is dropped with a `refused` event. */
export class StdioUser implements RuntimeUser {
  constructor(private readonly log: EventLog, private readonly input: LineReader) {}
  async ask(card: Card): Promise<Answer | null> {
    const ask_id = `ask_${randomUUID().slice(0, 8)}`;
    this.log.emit({ kind: "ask", ask_id, card: { kind: card.kind, text: card.text, options: card.options.map((o) => ({ kind: o.kind, text: o.text })), free_text: card.free_text, blocking: card.blocking } });
    this.log.emit({ kind: "waiting", ask_id });
    for (;;) {
      const line = await this.input.next();
      if (!line && (this.input.closed || this.input.stopped)) return null;     // the app is gone or stopped the task: no answer, the run ends honestly
      const a = parseControl(line);
      if (a?.type !== "answer") continue;
      if (a.ask_id !== undefined && a.ask_id !== ask_id) { this.log.emit({ kind: "refused", what: `answer for ${a.ask_id}`, why: `the open card is ${ask_id}`, by: "executor" }); continue; }
      this.log.emit({ kind: "resumed", ask_id });
      if (typeof a.option === "number" && a.option >= 0 && a.option < card.options.length) return { option: a.option };
      if (typeof a.text === "string" && a.text.trim()) return { text: a.text };
      return null;
    }
  }
}

/** The runtime's internal events, mapped onto the protocol. Unknown kinds are not sent. */
export function toProtocol(kind: string, body: Record<string, unknown>): EventBody | null {
  // a model fills optional fields with "" and 0: the step the app shows is the action without them
  const s = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x, (_, v) => (v === "" || v === 0 ? undefined : v)));
  switch (kind) {
    case "tool.call": return body.name === "computer_act" ? { kind: "step", text: s((body.args as any)?.action), purpose: s((body.args as any)?.purpose ?? ""), consequence: (body.args as any)?.consequence, ...((body.args as any)?.action?.window ? { object: `window:${(body.args as any).action.window}` } : {}) } : null;
    case "fs.act": return { kind: "step", text: `${s(body.cap)} ${s(body.args)}`, status: s(body.status), consequence: body.consequence as never };
    // an action that went out but could not be read back (hands: "dispatched, unverified") is a step with that status,
    // not a refusal; the executor's refusals (stale, stopped, environment, blocked, error) are
    case "executor.user_wait": return { kind: "waiting" };            // the user is at the keyboard: the app says "paused while you use your Mac"
    case "executor.user_resumed": return { kind: "resumed" };
    case "executor.act": return body.status === "ok" || body.status === "needs_consent" ? null
      : body.status === "unverified" ? { kind: "step", text: s(body.action), consequence: body.consequence as never, object: s(body.object), status: "unverified" }
      : { kind: "refused", what: s(body.action), why: `${s(body.status)}${body.why ? ": " + s(body.why) : ""}`, by: "executor" };
    case "plan": return { kind: "plan", steps: body.steps as never };
    case "consent.asked": return { kind: "consent", object: s(body.object), consequence: body.consequence as never, scope: "action", picked: (body.picked as string | null) ?? null };
    case "plan.confirmed": return null;
    case "answer.given": return { kind: "answer_given", text: s(body.text) };
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
    try { fs.appendFileSync(file, JSON.stringify({ t: Date.now(), kind, ...(cut(body ?? {}) as Record<string, unknown>) }) + "\n"); } catch { /* the trace never stops a run */ }
  };
}

/** `signals` (the CLI only): SIGINT / SIGTERM stop the run through the same one-time stop as a stop line. When the
 *  run has not ended `deadlineMs` after the signal: if an action is still out at the driver (it may land after a stop),
 *  wait up to `waitMs` more for its receipt; then write task_done (stopped) — with the action under
 *  changes.unconfirmed if it never answered — and exit. A second signal writes task_done and exits at once.
 *  `inject` (tests): a driver, a gateway, a model in place of the config's. */
export async function appRun(req: Request, o: { runs: string; out: (ev: AppEvent) => void; input: LineReader; linger: number;
  signals?: { onSignal: (h: (sig: string) => void) => void; exit: () => void; exitNow: () => void; deadlineMs?: number; waitMs?: number };
  inject?: { driver?: Driver; gateway?: Gateway; model?: RuntimeOptions["model"] } }) {
  const runId = req.run_id ?? `run_${randomUUID().slice(0, 8)}`;
  const log = new EventLog(path.join(o.runs, runId, "events.jsonl"), runId, o.out);
  const config = req.config ?? "ds-flash";   // the app's default: DeepSeek; the yy gateway is for in-house testing
  log.emit({ kind: "start", raw: req.raw, lang: req.lang ?? "zh", engine: req.engine ?? "runtime", config, ...(req.scope ? { scope: req.scope } : {}), protocol: { events: PROTOCOL.events } });
  const table = configTable(config);
  if (!table) { log.emit({ kind: "task_done", status: "failed", reason: `unknown config ${config}`, summary: "", result_card: null }); return; }
  const gw = o.inject?.gateway ?? new Gateway(table, { log: (r) => fs.appendFileSync(path.join(o.runs, runId, "model_calls.jsonl"), JSON.stringify(r) + "\n") });
  const signer = ConsentSigner.fresh();
  const trace = traceWriter(path.join(o.runs, runId, "trace.jsonl"));
  const ws = req.scope ? new Workspace(req.scope) : undefined;
  // the journal lives beside the run's events: an app-run started again with the same run_id finds what the last
  // process did without a receipt and tells the model (D10)
  const executor = new Executor(o.inject?.driver ?? driverFor(req.driver, req.scope), { task: runId, publicKey: signer.publicKey, journal: path.join(o.runs, runId, "journal.jsonl"), onEvent: (k, b) => { trace(k, b); const e = toProtocol(k, b); if (e) log.emit(e); } });
  log.emit({ kind: "preparing" });
  const rt = new FrontierRuntime({
    task: runId, raw: req.raw, executor, signer, user: new StdioUser(log, o.input), gateway: gw, model: o.inject?.model ?? loopModel(table.goal.model),
    ...(ws ? { workspace: ws, registry: fileRegistry() } : {}),
    skills: skillsFor(req, ws, () => executor.beginSnapshot), lang: req.lang ?? "zh", ...(req.rules ? { rules: req.rules } : {}),
    // a real desktop takes more looks than the check set's folders: a pixel-mode app needs an observation per step
    // and the old engine used ~20 actions on the music sample; the evaluation keeps the default budget
    budget: req.driver === "hands" ? { tool_calls: 90, turns: 60 } : {},
    onEvent: (k, b) => { trace(k, b); const e = toProtocol(k, b); if (e) log.emit(e); },
  });
  // one stop for the run, whoever asks (a stop line, a signal): one refused event, the first asker's reason
  let stopReason = "";
  const stopRun = (why: string) => { if (stopReason) return; stopReason = why; log.emit({ kind: "refused", what: "the task", why, by: "user" }); rt.stop(why); };
  o.input.onStop = stopRun;
  if (o.input.stopped) stopRun("stopped by the app");     // a stop line read together with the request, before this
  // control v1 reads steer lines; the app does not send them yet, and the runtime does not take them from the app
  // until a steer reaches the judges and lets go of an open card (docs/0.5-decisions.md, later)
  o.input.onSteer = (text) => trace("control.steer", { text, note: "steer not supported yet" });
  // one task_done per run: a signal's deadline may write it before the runtime returns
  let done = false, signals = 0, ended = () => {};
  const whenDone = new Promise<void>((res) => { ended = res; });
  const taskDone = (body: EventBody) => { if (done) return; done = true; log.emit(body); ended(); };
  // the run did not end by itself in time: an action still out at the driver may land after this, so the stop is not
  // called clean — the action is listed as unconfirmed and the reason says its result is unknown
  const forceDone = () => {
    if (done) return;
    const f = executor.inFlight, c = executor.changes();
    taskDone({ kind: "task_done", status: "stopped", reason: f ? STEP_UNKNOWN : stopReason || "stopped", summary: "", result_card: null, changes: f ? { ...c, unconfirmed: [...c.unconfirmed, f.object] } : c } as EventBody);
  };
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
  o.signals?.onSignal((sig) => {
    const sg = o.signals!;
    if (done) return sg.exit();
    if (++signals > 1) { forceDone(); return sg.exitNow(); }
    o.input.stop(`stopped by ${sig}`);
    void (async () => {
      await sleep(sg.deadlineMs ?? 800);
      if (!done && executor.inFlight) {
        await Promise.race([executor.settled(), sleep(sg.waitMs ?? 10_000)]);
        // the receipt came: the runtime writes its own task_done a moment later
        if (!executor.inFlight) await Promise.race([whenDone, sleep(500)]);
      }
      forceDone(); sg.exit();
    })();
  });
  const r = await rt.run();
  const card = r.result_card ? { kind: r.result_card.kind, text: r.result_card.text, options: r.result_card.options.map((x) => ({ kind: x.kind, text: x.text })), free_text: r.result_card.free_text, blocking: r.result_card.blocking } : null;
  taskDone({ kind: "task_done", status: r.status, reason: r.reason, summary: r.summary, result_card: card as never, answer: r.answer, changes: executor.changes() } as never);
  if (signals) return o.signals!.exit();
  // the result card is answered while this process is alive (undo needs the executor's receipts): wait `--linger`
  // seconds for `{"type":"respond","option":<index>}` (v0: `{"respond":<index>}`) on stdin, then exit
  if (card && o.linger > 0) {
    const line = await Promise.race([o.input.next(), new Promise<string>((res) => setTimeout(() => res(""), o.linger * 1000))]);
    if (line) {
      const a = parseControl(line);
      if (a?.type === "respond" && typeof a.option === "number") {
        const u = await rt.respond({ option: a.option });
        log.emit({ kind: "result_response", picked: card.options[a.option]?.kind ?? "other", effect: u ? (u.refused ? `undone ${u.undone}/${u.total}, stopped: ${u.refused}` : `undone ${u.undone}/${u.total}`) : "noted" } as never);
      }
    }
  }
}

export function respond(runId: string, runs: string, answer: Record<string, unknown>, out: (ev: AppEvent) => void) {
  const log = new EventLog(path.join(runs, runId, "events.jsonl"), runId, out);
  log.emit({ kind: "result_response", picked: typeof answer.option === "number" ? String(answer.option) : null, ...(typeof answer.text === "string" ? { text: answer.text } : {}), effect: "recorded; undo for the runtime is not built yet, nothing was changed" });
}

/** No model, no network: the executor on a simulated computer, and one scripted runtime turn that ends as cannot. */
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
  const ok = snap.windows.length === 1 && snap.windows[0]!.owner === "user" && pre.consequence === "modify_user" && pre.needs_consent && r.status === "failed" && r.reason.startsWith("cannot") && (r.counters["tool_calls"] ?? 0) === 2;
  return { ok, node: process.version, windows: snap.windows.length, floor: pre.consequence, runtime: r.status, tool_calls: r.counters["tool_calls"] ?? 0 };
}

/** Can the configured model be reached with the keys in the environment? One choice question; the key never
 *  appears in the answer (a service's error text is cut and stripped of anything that looks like one). */
export async function modelCheck(config: string): Promise<{ ok: boolean; model?: string; ms?: number; error?: string }> {
  const table = configTable(config);
  if (!table) return { ok: false, error: `unknown config ${config}` };
  const t0 = Date.now();
  const rep = await new Gateway(table).ask("choice", "只输出 JSON。", "问题：1+1=2 吗？选项 yes / no。", R.choiceAnswer(["yes", "no"]), "model-check");
  const scrub = (e: string) => e.replace(/(sk-|Bearer )[A-Za-z0-9_-]{8,}/g, "$1…").slice(0, 200);
  return rep.outcome === "answered" ? { ok: true, model: table.choice.model, ms: Date.now() - t0 } : { ok: false, model: table.choice.model, error: scrub(`${rep.outcome}: ${rep.error ?? ""}`) };
}

async function main() {
  const { values: a, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { linger: { type: "string", default: "0" },
    request: { type: "string" }, runs: { type: "string", default: "runs/app" }, run: { type: "string" }, selftest: { type: "boolean", default: false }, config: { type: "string", default: "ds-flash" },
  } });
  const out = (ev: AppEvent) => process.stdout.write(JSON.stringify(ev) + "\n");
  if (a.selftest) { const r = await selftest(); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
  const cmd = positionals[0];
  if (cmd === "model-check") { const r = await modelCheck(a.config!); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
  const input = new LineReader(process.stdin);
  if (cmd === "app-run") {
    // SIGINT / SIGTERM: before the run has started there is nothing to stop; after, the run ends as stopped
    // (task_done written) and the process exits within a second. stdout is drained before exit.
    const exit = () => process.stdout.write("", () => process.exit(0));
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
  console.error("usage: app-run [--request <file>] [--runs <dir>] | respond --run <id> | model-check --config <name> | --selftest");
  process.exit(2);
}

const entry = process.argv[1] ?? "";
if (/app\.(ts|js)$|harness\.mjs$/.test(entry)) main().catch((e) => { console.error(e); process.exit(1); });
