/**
 * The frontier runtime: the agent loop (runtime/loop.ts) and the executor's service (executor/service.ts), joined only
 * by the `ExecutorPort` (protocol/port.ts). This is the one place that knows both sides: the service gets the
 * executor, the signer, the card asker, the skills and the files; the loop gets the port and the model.
 *
 * Where the loop runs (executor split P2, deskmind#90 item 6):
 *   - in a child process (`agent` given): `harness.mjs runtime`, served the port over MCP on its stdin/stdout
 *     (host/agent.ts has the topology). The default for the app and the evaluation;
 *   - in this process: when the caller hands a model object (`model`: tests), or DESKMIND_EXECUTOR_INPROC=1 (the
 *     fallback; the app's helper sets it from models.env), as in P1.
 * Either way the port the loop calls is traced here (host/port-trace.ts): the trace's tool.call / tool.result and the
 * app's step events come from the executor's side.
 *
 * The app's controls go to the executor's side: stop (the executor refuses every later action and lets go of an open
 * card; the loop is told — in a child, by a notification — and stops calling the model), steer (the executor applies
 * it between steps and voids an open card; a child is told words are waiting), and the result card's answer (undo).
 */
import type { Gateway } from "../gateway/index.js";
import type { Answer, Card, CardAsker } from "../protocol/cards.js";
import type { ConsentProvider, ConsentToken } from "../protocol/consent.js";
import type { ExecutorPort, TaskResult, TaskStatus } from "../protocol/port.js";
import type { Registry } from "../registry/capability.js";
import type { Workspace } from "../registry/workspace.js";
import type { Executor } from "../executor/executor.js";
import { ExecutorService, type SkillSource } from "../executor/service.js";
import type { Lang } from "../executor/text.js";
import type { AgentLoop, LoopOptions } from "../runtime/loop.js";
import { serve, McpExecutorServer } from "../cli/mcp.js";
import { AGENT_EXITED, AgentProcess, inProcess, loopFromSpec, type AgentSpec } from "./agent.js";
import { tracedPort } from "./port-trace.js";
import { ReportMirror } from "../transport/report.js";
import { current as traceContext } from "../otel/context.js";

export type { SkillSource, ConsentProvider };
export type RuntimeUser = CardAsker;
export type RuntimeStatus = TaskStatus;
export type RuntimeResult = TaskResult;

export interface RuntimeOptions {
  task: string; raw: string;
  executor: Executor; signer: ConsentProvider; user: RuntimeUser; gateway: Gateway;
  /** The loop's model as an object: the loop runs in this process (tests). */
  model?: LoopOptions["model"];
  /** The loop as its own process (P2): its model (`<provider>|<model>`, or a script), its logs (runtime.jsonl,
   *  model_calls.jsonl, runtime.log for its stderr), and the command that starts it (default: this harness's
   *  `runtime`). With DESKMIND_EXECUTOR_INPROC=1 the same loop runs in this process, its logs the same. */
  agent?: { model: AgentSpec["model"]; log?: string; modelLog?: string; stderr?: string; command?: string[] };
  /** Where the loop runs, whatever the environment says (the selftest checks both). Default: as described above. */
  mode?: "process" | "inproc";
  workspace?: Workspace; registry?: Registry; skills?: SkillSource;
  /** The loop's (tool_calls, turns) and the executor's (asks, verify_retries). */
  budget?: Partial<{ tool_calls: number; turns: number; asks: number; verify_retries: number }>;
  onEvent?: (kind: string, body: Record<string, unknown>) => void;
  signal?: AbortSignal;
  /** The language of what the user reads on cards (default zh). */
  lang?: Lang;
  /** The user's standing rules (rule-tier consent tokens the app signed), handed to the executor at begin. */
  rules?: ConsentToken[];
}

const sum = (a: Record<string, number>, b: Record<string, number>) => { const out = { ...a }; for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v; return out; };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class FrontierRuntime {
  private readonly service: ExecutorService;
  /** The port as the loop reaches it, traced. */
  private readonly port: ExecutorPort;
  /** The loop, when it runs in this process. */
  private readonly loop: AgentLoop | null = null;
  /** The loop's process, once started; its counters as its last call carried them. */
  private agent: AgentProcess | null = null;
  private agentCounters: Record<string, number> = {};
  private stopped: string | null = null;
  /** The `end` the runtime called (its result, or the executor's failure to end: a crash). */
  private ended: Promise<TaskResult> | null = null;
  private onEnded = () => {};

  constructor(readonly o: RuntimeOptions) {
    const { tool_calls, turns, asks, verify_retries } = o.budget ?? {};
    const def = <K extends string, V>(x: Record<K, V | undefined>) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as Partial<Record<K, V>>;
    this.service = new ExecutorService({ task: o.task, raw: o.raw, executor: o.executor, signer: o.signer, user: o.user, gateway: o.gateway, workspace: o.workspace, registry: o.registry, skills: o.skills, budget: def({ asks, verify_retries }), onEvent: o.onEvent, lang: o.lang, rules: o.rules });
    this.port = tracedPort(this.service.port, (k, b) => o.onEvent?.(k, b), (p) => { this.ended = p; this.onEnded(); });
    if (!o.agent && !o.model) throw new Error("FrontierRuntime needs a model (in process) or an agent spec");
    if (o.mode === "inproc" || (o.mode !== "process" && (o.model || inProcess()))) this.loop = loopFromSpec(this.spec(), this.port, o.model);
    o.signal?.addEventListener("abort", () => this.stop("the app stopped the task"));
  }

  private spec(): AgentSpec {
    const { tool_calls, turns } = this.o.budget ?? {};
    const budget = Object.fromEntries(Object.entries({ tool_calls, turns }).filter(([, v]) => v !== undefined));
    const a = this.o.agent;
    return { raw: this.o.raw, model: a?.model ?? "", budget, ...(a?.log ? { log: a.log } : {}), ...(a?.modelLog ? { modelLog: a.modelLog } : {}) };
  }

  /** Where the loop runs: "process" (a child) or "inproc". */
  get mode(): "process" | "inproc" { return this.loop ? "inproc" : "process"; }

  /** Both sides' counters (model_calls adds the loop's turns and the executor's judges and rewrites). */
  get counters(): Record<string, number> { return sum(this.service.counters, this.loop ? this.loop.counters : this.agentCounters); }

  /** The user changed what they want mid-run (the protocol's steer): to the executor, which applies it between steps. */
  steer(raw: string) { this.service.steer(raw); if (this.agent) this.agent.steer(); else this.steeredEarly = true; }
  /** A steer came before the runtime's process was started (read with the request): it is told once it is there, so its
   *  first turn hears the words, as the loop in process does (its first poll) — review of P2. */
  private steeredEarly = false;

  /** The app's stop: the executor refuses every later action and lets go of an open card; the loop stops. */
  stop(why = "stopped") {
    this.service.stop(why);
    if (this.stopped) return;
    this.stopped = why;
    this.loop?.stop(); this.agent?.stop(why);
  }

  async run(): Promise<TaskResult> {
    if (this.loop) {
      const r = await this.loop.run();
      return { ...r, counters: sum(r.counters, this.loop.counters) };
    }
    const r = await this.runProcess();
    return { ...r, counters: sum(r.counters, this.agentCounters) };
  }

  /** The loop in its own process: serve it the port until it calls `end`, or until it goes away. */
  private async runProcess(): Promise<TaskResult> {
    const emit = (k: string, b: Record<string, unknown>) => this.o.onEvent?.(k, b);
    // the run's records (model calls, the trace) are this side's: the runtime reports its part (transport/report.ts)
    const mirror = new ReportMirror(traceContext());
    const report = mirror.spec();
    const server = new McpExecutorServer({
      onNotification: (m, p) => { mirror.notification(m, p); },
      around: (meta, fn) => mirror.around(meta, fn),
      session: { port: this.port, stop: (why) => this.stop(why) },
      onCall: (c) => emit("mcp.call", c as unknown as Record<string, unknown>),
      onMeta: (m) => { const c = m["deskmind/counters"]; if (c && typeof c === "object") this.agentCounters = c as Record<string, number>; },
    });
    const agent = new AgentProcess({ ...this.spec(), ...(report ? { report } : {}) }, { ...(this.o.agent?.command ? { command: this.o.agent.command } : {}), ...(this.o.agent?.stderr ? { stderr: this.o.agent.stderr } : {}) });
    this.agent = agent;
    const served = serve(server, agent.peer, (l) => emit("mcp.error", { text: l }));
    emit("agent.start", { pid: agent.pid ?? null });
    if (this.stopped) agent.stop(this.stopped);         // stopped before the process was there
    if (this.steeredEarly) agent.steer();
    const endCalled = new Promise<"end">((r) => { this.onEnded = () => r("end"); if (this.ended) r("end"); });
    const first = await Promise.race([endCalled, agent.exited.then(() => "gone" as const), agent.peer.closed.then(() => "gone" as const)]);
    if (first === "end") {
      try { return await this.ended!; }
      finally {
        // the runtime reads the reply and exits; one that does not is not waited for
        void Promise.race([agent.exited, sleep(2000)]).then(() => agent.kill());
      }
    }
    // the runtime went away without calling end (it crashed, was killed, or its pipe broke): the task fails with that
    // reason — after the call it may have been in is over (an action out at the driver gets its receipt), an open card
    // let go
    const ex = await Promise.race([agent.exited, sleep(300).then(() => null)]);
    agent.kill();
    const detail = ex ? (ex.signal ?? `code ${ex.code}`) : "pipe closed";
    emit("agent.exit", { code: ex?.code ?? null, signal: ex?.signal ?? null, ms: Date.now() - agent.startedAt });
    // a line it wrote before it went and that is read only now is not served: the run is ending (review of P2)
    served.refuse(AGENT_EXITED);
    this.service.stop(`${AGENT_EXITED} (${detail})`, "failed");
    await served.idle();
    if (this.ended) return this.ended;                   // it asked for the end before it went
    return this.service.port.end({ failure: `${AGENT_EXITED} (${detail})` });
  }
  resultCard(): Card | null { return this.service.resultCard(); }
  respond(answer: Answer) { return this.service.respond(answer); }
}
