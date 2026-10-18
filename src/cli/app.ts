/**
 * The app's entry point (DeskMind Hands.app runs this as a child process; openjev
 * docs/design/harness-app-integration-2026-10-17.md §2): JSON events out on stdout, one per line, each written to the
 * run's event log first (protocol/events.ts); answers to cards come back on stdin as JSON lines.
 *
 *   app-run [--request <file>] [--runs <dir>]   stdin line 1 (or the file): {run_id?, raw, scope?, config?, engine?, lang?, driver?}
 *   respond --run <id> [--runs <dir>]           stdin line 1: {option} | {text}  — the user's answer to the result card
 *   --selftest                                  no model, no network: the packaged binary's health check
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
import { CONFIGS, Gateway } from "../gateway/index.js";
import { ConsentSigner } from "../executor/consent.js";
import { Executor } from "../executor/executor.js";
import { SimComputer } from "../executor/sim.js";
import { HandsDriver } from "../executor/hands.js";
import { SkillStore } from "../skills/agentskills.js";
import type { SkillSource } from "../runtime/loop.js";
import * as os from "node:os";
import { fileURLToPath } from "node:url";
import type { Driver } from "../executor/types.js";
import { FrontierRuntime, type RuntimeUser } from "../runtime/loop.js";
import { loopModel } from "../runtime/model.js";
import { scriptedStream } from "../runtime/scripted.js";
import { EventLog, type AppEvent, type EventBody } from "../protocol/events.js";
import type { Answer, Card } from "../orchestrator/index.js";
import { fileRegistry } from "../registry/fs.js";
import { Workspace } from "../registry/workspace.js";

export interface Request { run_id?: string; raw: string; scope?: string; config?: string; engine?: "runtime"; lang?: "zh" | "en"; driver?: "sim" | "hands"; apps?: string[]; skills?: string }

/** JSON lines in: a line is `{ask_id, option}` or `{ask_id, text}`; the first line may be the request itself. */
export class LineReader {
  private waiting: ((line: string) => void)[] = [];
  private queued: string[] = [];
  constructor(input: NodeJS.ReadableStream) {
    const rl = readline.createInterface({ input, terminal: false });
    rl.on("line", (l) => {
      if (!l.trim()) return;
      // the app's stop can arrive at any moment, card or no card: it never waits in the answer queue
      try { const j = JSON.parse(l); if (j && j.stop === true) { this.onStop?.(); return; } } catch { /* an answer line */ }
      const w = this.waiting.shift(); if (w) w(l); else this.queued.push(l);
    });
    // the app went away (stdin closed): every open card is answered with nothing, so the run ends instead of hanging
    rl.on("close", () => { this.closed = true; for (const w of this.waiting.splice(0)) w(""); });
  }
  closed = false;
  onStop: (() => void) | null = null;
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
      let a: Record<string, unknown>;
      const line = await this.input.next();
      if (!line && this.input.closed) return null;           // the app is gone: no answer, the run ends honestly
      try { a = JSON.parse(line); } catch { continue; }
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
    case "tool.call": return body.name === "computer_act" ? { kind: "step", text: s((body.args as any)?.action), purpose: s((body.args as any)?.purpose ?? ""), consequence: (body.args as any)?.consequence } : null;
    case "fs.act": return { kind: "step", text: `${s(body.cap)} ${s(body.args)}`, status: s(body.status), consequence: body.consequence as never };
    // an action that went out but could not be read back (hands: "dispatched, unverified") is a step with that status,
    // not a refusal; the executor's refusals (stale, stopped, environment, blocked, error) are
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
 *  ~/.deskmind/skills), filtered by structure (the request's apps, the folder's file types) — never by the words of
 *  the request (skills-layer-2026-10-18.md §检索). The base skill is the system prompt already, so it is not a candidate. */
function skillsFor(req: Request, ws?: Workspace): SkillSource {
  const dirs = [path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "skills"), req.skills ?? path.join(os.homedir(), ".deskmind", "skills")].filter((d) => fs.existsSync(d));
  const fileTypes = ws ? [...new Set(Object.keys(ws.entries()).map((p) => p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "").filter(Boolean))] : [];
  const facts = { apps: req.apps ?? [], fileTypes, objects: req.scope ? [req.scope] : [] };
  const sources = dirs.map((d) => new SkillStore(d).source(facts));
  return {
    candidates: (raw) => sources.flatMap((s) => s.candidates(raw)).filter((c) => c.name !== "deskmind-computer-use"),
    read: (name) => sources.map((s) => s.read(name)).find((t) => t !== null) ?? null,
  };
}

function driverFor(name: Request["driver"], scope?: string): Driver {
  if (name === "hands") return new HandsDriver(scope ? { workspace: path.resolve(scope) } : {});
  return new SimComputer(scope);
}

export async function appRun(req: Request, o: { runs: string; out: (ev: AppEvent) => void; input: LineReader; linger: number }) {
  const runId = req.run_id ?? `run_${randomUUID().slice(0, 8)}`;
  const log = new EventLog(path.join(o.runs, runId, "events.jsonl"), runId, o.out);
  const config = req.config ?? "yy-luna";
  log.emit({ kind: "start", raw: req.raw, lang: req.lang ?? "zh", engine: req.engine ?? "runtime", config, ...(req.scope ? { scope: req.scope } : {}) });
  const table = CONFIGS[config];
  if (!table) { log.emit({ kind: "task_done", status: "failed", reason: `unknown config ${config}`, summary: "", result_card: null }); return; }
  const gw = new Gateway(config, { log: (r) => fs.appendFileSync(path.join(o.runs, runId, "model_calls.jsonl"), JSON.stringify(r) + "\n") });
  const signer = ConsentSigner.fresh();
  const ws = req.scope ? new Workspace(req.scope) : undefined;
  const executor = new Executor(driverFor(req.driver, req.scope), { task: runId, publicKey: signer.publicKey, onEvent: (k, b) => { const e = toProtocol(k, b); if (e) log.emit(e); } });
  log.emit({ kind: "preparing" });
  const rt = new FrontierRuntime({
    task: runId, raw: req.raw, executor, signer, user: new StdioUser(log, o.input), gateway: gw, model: loopModel(table.goal.model),
    ...(ws ? { workspace: ws, registry: fileRegistry() } : {}),
    skills: skillsFor(req, ws),
    onEvent: (k, b) => { const e = toProtocol(k, b); if (e) log.emit(e); },
  });
  o.input.onStop = () => { log.emit({ kind: "refused", what: "the task", why: "stopped by the app", by: "user" }); rt.stop("stopped by the app"); };
  const r = await rt.run();
  const card = r.result_card ? { kind: r.result_card.kind, text: r.result_card.text, options: r.result_card.options.map((x) => ({ kind: x.kind, text: x.text })), free_text: r.result_card.free_text, blocking: r.result_card.blocking } : null;
  log.emit({ kind: "task_done", status: r.status, reason: r.reason, summary: r.summary, result_card: card as never, answer: r.answer, changes: executor.changes() } as never);
  // the result card is answered while this process is alive (undo needs the executor's receipts): wait `--linger`
  // seconds for `{ "respond": <option index> }` on stdin, then exit
  if (card && o.linger > 0) {
    const line = await Promise.race([o.input.next(), new Promise<string>((res) => setTimeout(() => res(""), o.linger * 1000))]);
    if (line) {
      try {
        const a = JSON.parse(line) as { respond?: number };
        if (typeof a.respond === "number") {
          const u = await rt.respond({ option: a.respond });
          log.emit({ kind: "result_response", picked: card.options[a.respond]?.kind ?? "other", effect: u ? (u.refused ? `undone ${u.undone}/${u.total}, stopped: ${u.refused}` : `undone ${u.undone}/${u.total}`) : "noted" } as never);
        }
      } catch { /* not an answer */ }
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

async function main() {
  const { values: a, positionals } = parseArgs({ args: process.argv.slice(2), allowPositionals: true, options: { linger: { type: "string", default: "0" },
    request: { type: "string" }, runs: { type: "string", default: "runs/app" }, run: { type: "string" }, selftest: { type: "boolean", default: false },
  } });
  const out = (ev: AppEvent) => process.stdout.write(JSON.stringify(ev) + "\n");
  if (a.selftest) { const r = await selftest(); console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
  const cmd = positionals[0];
  const input = new LineReader(process.stdin);
  if (cmd === "app-run") {
    const req: Request = JSON.parse(a.request ? fs.readFileSync(a.request, "utf-8") : await input.next());
    if (!req.raw) throw new Error("request needs raw");
    await appRun(req, { runs: path.resolve(a.runs!), out, input, linger: Number(a.linger ?? 0) });
    process.exit(0);
  }
  if (cmd === "respond") {
    if (!a.run) throw new Error("respond needs --run <id>");
    respond(a.run, path.resolve(a.runs!), JSON.parse(await input.next()), out);
    process.exit(0);
  }
  console.error("usage: app-run [--request <file>] [--runs <dir>] | respond --run <id> | --selftest");
  process.exit(2);
}

const entry = process.argv[1] ?? "";
if (/app\.(ts|js)$|harness\.mjs$/.test(entry)) main().catch((e) => { console.error(e); process.exit(1); });
