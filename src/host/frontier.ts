/**
 * The frontier runtime as it runs today: the agent loop (runtime/loop.ts) in the same process as the executor's service
 * (executor/service.ts), joined only by the `ExecutorPort` (executor split P1, deskmind#90 item 6). This is the one place
 * that knows both sides: the loop gets the port and the model; the service gets the executor, the signer, the card
 * asker, the skills and the files. In P2 the loop moves into a child process speaking MCP, and this pairing becomes the
 * executor process starting it.
 *
 * The app's controls go to the executor's side: stop (both sides: the executor refuses every later action, the loop
 * stops calling the model), steer (the executor applies it between steps and voids an open card), and the result
 * card's answer (undo).
 */
import type { Gateway } from "../gateway/index.js";
import type { Answer, Card, CardAsker } from "../protocol/cards.js";
import type { ConsentProvider, ConsentToken } from "../protocol/consent.js";
import type { TaskResult, TaskStatus } from "../protocol/port.js";
import type { Registry } from "../registry/capability.js";
import type { Workspace } from "../registry/workspace.js";
import type { Executor } from "../executor/executor.js";
import { ExecutorService, type SkillSource } from "../executor/service.js";
import type { Lang } from "../executor/text.js";
import { AgentLoop, type LoopOptions } from "../runtime/loop.js";

export type { SkillSource, ConsentProvider };
export type RuntimeUser = CardAsker;
export type RuntimeStatus = TaskStatus;
export type RuntimeResult = TaskResult;

export interface RuntimeOptions {
  task: string; raw: string;
  executor: Executor; signer: ConsentProvider; user: RuntimeUser; gateway: Gateway;
  model: LoopOptions["model"];
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

export class FrontierRuntime {
  private readonly service: ExecutorService;
  private readonly loop: AgentLoop;

  constructor(readonly o: RuntimeOptions) {
    const { tool_calls, turns, asks, verify_retries } = o.budget ?? {};
    const def = <K extends string, V>(x: Record<K, V | undefined>) => Object.fromEntries(Object.entries(x).filter(([, v]) => v !== undefined)) as Partial<Record<K, V>>;
    this.service = new ExecutorService({ task: o.task, raw: o.raw, executor: o.executor, signer: o.signer, user: o.user, gateway: o.gateway, workspace: o.workspace, registry: o.registry, skills: o.skills, budget: def({ asks, verify_retries }), onEvent: o.onEvent, lang: o.lang, rules: o.rules });
    this.loop = new AgentLoop({ port: this.service.port, raw: o.raw, model: o.model, budget: def({ tool_calls, turns }), onEvent: o.onEvent });
    o.signal?.addEventListener("abort", () => this.stop("the app stopped the task"));
  }

  /** Both sides' counters (model_calls adds the loop's turns and the executor's judges and rewrites). */
  get counters(): Record<string, number> { return sum(this.service.counters, this.loop.counters); }

  /** The user changed what they want mid-run (the protocol's steer): to the executor, which applies it between steps. */
  steer(raw: string) { this.service.steer(raw); }

  /** The app's stop: the executor refuses every later action and lets go of an open card; the loop stops. */
  stop(why = "stopped") { this.service.stop(why); this.loop.stop(); }

  async run(): Promise<TaskResult> {
    const r = await this.loop.run();
    return { ...r, counters: sum(r.counters, this.loop.counters) };
  }

  resultCard(): Card | null { return this.service.resultCard(); }
  respond(answer: Answer) { return this.service.respond(answer); }
}
