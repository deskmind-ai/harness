/**
 * The runtime as a child process of the executor (executor split P2, deskmind#90 item 6).
 *
 *   executor process (harness.mjs executor | app-run)             runtime process (harness.mjs runtime)
 *     run dir, events.jsonl, trace.jsonl, journal,                  the agent loop (runtime/loop.ts) and its model;
 *     signing key, judges + gateway (judge_calls.jsonl),            runtime.jsonl (its events), model_calls.jsonl
 *     skills, cards, the driver (hands child)                       (its model turns), runtime.log (its stderr)
 *        │  stdin  ─── notifications: deskmind/stop, deskmind/steer ──▶  │
 *        │  stdout ◀── MCP requests: initialize, tools/call (port) ────  │
 *
 * The executor is the MCP server (cli/mcp.ts) and implements the port; the child is a plain client
 * (transport/mcp-port.ts). What the child needs to start (the request, its model, its budget, its log files) comes in
 * the environment variable DESKMIND_AGENT_SPEC, not on the command line, so `ps` does not show the user's words.
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
import { scriptedStream, type Step } from "../runtime/scripted.js";
import { JsonRpcPeer } from "../transport/jsonrpc.js";
import { STEER_NOTIFICATION, STOP_NOTIFICATION } from "../transport/mcp-port.js";

/** A scripted step that survives JSON (no functions): tool calls with arguments, or text. */
export type JsonStep = Exclude<Step, (...a: never[]) => unknown>;

export interface AgentSpec {
  /** The user's request, as the model first hears it. */
  raw: string;
  /** The loop's model: `<provider>|<model>` (keys from the environment), or a script (tests, the selftest). */
  model: string | { scripted: JsonStep[] };
  budget?: Partial<typeof RUNTIME_BUDGET>;
  /** runtime.jsonl: the loop's events. */
  log?: string;
  /** model_calls.jsonl: one line per model turn. */
  modelLog?: string;
}

export const SPEC_ENV = "DESKMIND_AGENT_SPEC";
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
    port, raw: spec.raw, model: model ?? modelFromSpec(spec.model), budget: spec.budget ?? {},
    onEvent: (k, b) => { log(k, b); if (k === "model.call") models(k, b); onEvent?.(k, b); },
  });
}

/** How to start `harness.mjs runtime` from here: the bundle runs itself; from the sources, app.ts under tsx. */
export function agentCommand(): string[] {
  const self = fileURLToPath(import.meta.url);
  // the tsc build (dist/src/host/agent.js): its app.js beside; the bundle (harness.mjs): itself
  if (path.basename(self) === "agent.js") return [process.execPath, path.resolve(path.dirname(self), "..", "cli", "app.js"), "runtime"];
  if (!self.endsWith(".ts")) return [process.execPath, self, "runtime"];
  const tsx = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  return [process.execPath, "--import", tsx, path.resolve(path.dirname(self), "..", "cli", "app.ts"), "runtime"];
}

/** The runtime child; whoever holds it serves the port on `peer` (cli/mcp.ts serve). */
export class AgentProcess {
  readonly peer: JsonRpcPeer;
  readonly exited: Promise<{ code: number | null; signal: string | null }>;
  private readonly proc: ChildProcess;
  readonly startedAt = Date.now();

  constructor(spec: AgentSpec, o: { command?: string[]; stderr?: string } = {}) {
    const [cmd, ...args] = o.command ?? agentCommand();
    const err = o.stderr ? fs.openSync(o.stderr, "a") : "inherit";
    this.proc = spawn(cmd!, args, { stdio: ["pipe", "pipe", err], env: { ...process.env, [SPEC_ENV]: JSON.stringify(spec) } });
    if (typeof err === "number") fs.closeSync(err);
    this.exited = new Promise((res) => {
      this.proc.on("exit", (code, signal) => res({ code, signal }));
      this.proc.on("error", (e) => res({ code: null, signal: `spawn: ${e.message}` }));     // could not start at all
    });
    this.peer = new JsonRpcPeer(this.proc.stdout!, this.proc.stdin!);
  }

  get pid() { return this.proc.pid; }

  /** The app's stop, to the loop: no more model turns. */
  stop(why: string) { this.peer.notify(STOP_NOTIFICATION, { why }); }
  /** The user's words are waiting at the executor: the loop asks for them at its next turn. Always sent (our own
   *  runtime asks for the push in its initialize; one sent before that is read after it, in order). */
  steer() { this.peer.notify(STEER_NOTIFICATION); }
  kill() { if (this.proc.exitCode === null && this.proc.signalCode === null) this.proc.kill("SIGKILL"); }
}
