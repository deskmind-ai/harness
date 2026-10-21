/**
 * The runtime as a child process of the executor (executor split P2, deskmind#90 item 6).
 *
 *   executor process (harness.mjs executor | app-run)             runtime process (harness.mjs runtime)
 *     run dir, events.jsonl, trace.jsonl, journal,                  the agent loop (runtime/loop.ts) and its model;
 *     signing key, judges + gateway, the run's records              runtime.jsonl (its events, mcp.rtt), runtime.log
 *     (model_calls.jsonl, trace.otel.jsonl), skills, cards,         (its stderr); its model calls and spans are
 *     the driver (hands child)                                      reported to the executor (transport/report.ts)
 *        │  stdin  ─── notifications: deskmind/stop, deskmind/steer ──▶  │
 *        │  stdout ◀── MCP requests: initialize, tools/call (port) ────  │
 *        │  stdout ◀── notifications: deskmind/model_call, deskmind/span │
 *
 * The executor is the MCP server (cli/mcp.ts) and implements the port; the child is a plain client
 * (transport/mcp-port.ts). What the child needs to start (the request, its model, its budget, its log files) comes in
 * the initialize result's `_meta` over the pipe — not on its command line or in its environment, which `ps eww` shows
 * to the same user. Its environment is an allowlist (agentEnv): no DeskMind secrets, only its own provider's key.
 * Not a sandbox: the child runs as the same user and could read the user's files; see docs/protocol.md.
 *
 * Lifetimes: the child exits when its stdin ends (the executor is gone, even by kill -9), so it is never left behind;
 * the executor treats the child exiting before it called `end`, or its pipe breaking, as "agent exited": the task
 * fails with that reason, after any call it was serving has finished (an action at the driver gets its receipt).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ExecutorPort } from "../protocol/port.js";
import { AgentLoop, RUNTIME_BUDGET, type LoopOptions } from "../runtime/loop.js";
import { loopModel } from "../runtime/model.js";
import { PROVIDERS } from "../gateway/index.js";
import { scriptedStream, type Step } from "../runtime/scripted.js";
import { JsonRpcPeer, MAX_LINE } from "../transport/jsonrpc.js";
import type { ReportSpec } from "../transport/report.js";
import { STEER_NOTIFICATION, STOP_NOTIFICATION } from "../transport/mcp-port.js";

/** A scripted step that survives JSON (no functions): tool calls with arguments, or text. */
export type JsonStep = Exclude<Step, (...a: never[]) => unknown>;

export interface AgentSpec {
  /** The user's request, as the model first hears it. */
  raw: string;
  /** The chat model's restatement of the request (a computer task the session started: docs/protocol.md 「会话」),
   *  shown to the loop under its own label — never as the user's words; the executor and its judges never read it. */
  context?: string;
  /** The loop's model: `<provider>|<model>` (keys from the environment), or a script (tests, the selftest). */
  model: string | { scripted: JsonStep[] };
  budget?: Partial<typeof RUNTIME_BUDGET>;
  /** runtime.jsonl: the loop's events. */
  log?: string;
  /** model_calls.jsonl: one line per model turn (when the executor does not record them: the evaluation). */
  modelLog?: string;
  /** What to report to the executor (its spans, its model calls): transport/report.ts. */
  report?: ReportSpec;
}

/** Where the spec travels: the initialize result's `_meta` (review of #50: an environment variable is readable by the
 *  same user's other processes and shares the ~1 MB argument/environment limit with a long pasted request). */
export const SPEC_META = "deskmind/agent";

/** What the runtime child's environment holds (review of #50: it used to inherit everything, the Brain token and other
 *  providers' keys included): the system's basics, Node's own settings, proxies, and the one provider its model is on —
 *  that provider's key and URL. Nothing of DeskMind's own (hands, Brain, the in-process switch). */
export function agentEnv(model: AgentSpec["model"], env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = new Set(["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "USER", "LOGNAME", "TZ", "LANG", "LANGUAGE", "NODE_OPTIONS", "NODE_PATH", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
    "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy"]);
  if (typeof model === "string") { const p = PROVIDERS[model.split("|")[0]!]; if (p) { keep.add(p.keyEnv); keep.add(p.urlEnv); } }
  return Object.fromEntries(Object.entries(env).filter(([k, v]) => v !== undefined && (keep.has(k) || k.startsWith("LC_"))));
}
/** Why a task ended when its runtime process went away before calling `end`. */
export const AGENT_EXITED = "agent exited";

/** The fallback: the runtime in the executor's process, as in P1. The app's helper sets it from models.env. */
export const inProcess = () => process.env.DESKMIND_EXECUTOR_INPROC === "1";

const SCRIPTED_MODEL = { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as never;

export function modelFromSpec(m: AgentSpec["model"]): LoopOptions["model"] {
  return typeof m === "string" ? loopModel(m) : { model: SCRIPTED_MODEL, streamFn: scriptedStream(m.scripted) };
}

/** A JSON-lines file appender (long strings cut); a write that fails never stops the run. */
export function jsonl(file: string | undefined): (kind: string, body: Record<string, unknown>) => void {
  if (!file) return () => {};
  const cut = (v: unknown): unknown => typeof v === "string" ? (v.length > 4000 ? v.slice(0, 4000) + `…(+${v.length - 4000})` : v)
    : Array.isArray(v) ? v.map(cut) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, cut(x)])) : v;
  return (kind, body) => { try { fs.appendFileSync(file, JSON.stringify({ t: Date.now(), kind, ...(cut(body) as Record<string, unknown>) }) + "\n"); } catch { /* the log never stops a run */ } };
}

/** The agent loop the spec describes, on `port`, its events to its own logs (and `onEvent`). */
export function loopFromSpec(spec: AgentSpec, port: ExecutorPort, model?: LoopOptions["model"], onEvent?: (kind: string, body: Record<string, unknown>) => void): AgentLoop {
  const log = jsonl(spec.log), models = jsonl(spec.modelLog);
  return new AgentLoop({
    port, raw: spec.raw, ...(typeof spec.context === "string" && spec.context.trim() ? { context: spec.context } : {}), model: model ?? modelFromSpec(spec.model), budget: spec.budget ?? {},
    onEvent: (k, b) => { log(k, b); if (k === "model.call") models(k, b); onEvent?.(k, b); },
  });
}

/** How to start `harness.mjs runtime` from here: the bundle runs itself; from the sources, app.ts under tsx. */
export function agentCommand(): string[] { return selfCommand(["runtime"]); }

/** How to run this harness with `args` (`runtime`; the session's `executor`): the bundle (harness.mjs) runs itself; the
 *  tsc build (dist/src/host/agent.js) its app.js beside; the sources app.ts under tsx. */
export function selfCommand(args: string[]): string[] {
  const self = fileURLToPath(import.meta.url);
  if (path.basename(self) === "agent.js") return [process.execPath, path.resolve(path.dirname(self), "..", "cli", "app.js"), ...args];
  if (!self.endsWith(".ts")) return [process.execPath, self, ...args];
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return [process.execPath, "--import", tsx, path.resolve(path.dirname(self), "..", "cli", "app.ts"), ...args];
}

/** The runtime child; whoever holds it serves the port on `peer` (cli/mcp.ts serve) and hands it `spec` in the
 *  initialize result. What it writes to stdout that is not JSON goes to its log (runtime.log), not dropped unseen; a line
 *  over 16 MB breaks the protocol (the connection is closed and the run ends "agent exited (protocol: line too long)");
 *  notifications beyond 500 a second (bursts of 2000) are dropped and counted. */
export class AgentProcess {
  readonly peer: JsonRpcPeer;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  private readonly proc: ChildProcess;
  readonly startedAt = Date.now();

  constructor(readonly spec: AgentSpec, o: { command?: string[]; stderr?: string } = {}) {
    const [cmd, ...args] = o.command ?? agentCommand();
    const err = o.stderr ? fs.openSync(o.stderr, "a") : "inherit";
    this.proc = spawn(cmd!, args, { stdio: ["pipe", "pipe", err], env: agentEnv(spec.model) });
    if (typeof err === "number") fs.closeSync(err);
    this.exited = new Promise((res) => {
      this.proc.on("exit", (code, signal) => res({ code, signal }));
      this.proc.on("error", (e) => res({ code: null, signal: `spawn: ${e.message}` }));     // could not start at all
    });
    this.peer = new JsonRpcPeer(this.proc.stdout!, this.proc.stdin!, { maxLine: MAX_LINE, oversize: "close", notifyPerSec: 500, notifyBurst: 2000 });
    const stderrFile = o.stderr;
    this.peer.onParseError = (line) => {
      const note = `[runtime stdout, not JSON-RPC] ${line.slice(0, 2000)}\n`;
      try { if (stderrFile) fs.appendFileSync(stderrFile, note); else process.stderr.write(note); } catch { /* the log never stops a run */ }
    };
  }

  get pid() { return this.proc.pid; }

  /** The app's stop, to the loop: no more model turns. */
  stop(why: string) { this.peer.notify(STOP_NOTIFICATION, { why }); }
  /** The user's words are waiting at the executor: the loop asks for them at its next turn. Always sent (our own
   *  runtime asks for the push in its initialize; one sent before that is read after it, in order). */
  steer() { this.peer.notify(STEER_NOTIFICATION); }
  kill() { if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGKILL"); }
}
