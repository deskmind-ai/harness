/**
 * The executor port as an MCP client (executor split P2, deskmind#90 item 6): our runtime, in a child process of the
 * executor, reaches the port through this — each method one `tools/call` on the executor's server (cli/mcp.ts) over
 * the child's stdin/stdout. The loop above (runtime/loop.ts) does not know the difference.
 *
 *   - Replies come back as the port gives them (`structuredContent`); a call that throws in the executor (observe on a
 *     window that cannot be read, end when the executor died) throws here with its text.
 *   - Steer: the executor pushes `notifications/deskmind/steer` when the user's words are waiting (we ask for it in
 *     initialize). `steers()` calls the executor only then, or after a reply that carried words (the executor refuses
 *     further steps until `steers` is called again); otherwise it answers [] without a round trip.
 *   - Every call carries the loop's counters in `_meta` ("deskmind/counters"), so the executor's side knows them live
 *     (the run's counters, the evaluation's hooks) without asking.
 */
import type { Begun, Classified, ExecutorPort, FinishOutcome, TaskResult, ToolReply } from "../protocol/port.js";
import type { Action, Observation, Reading, Snapshot } from "../protocol/computer.js";
import type { Consequence } from "../protocol/consent.js";
import type { PlanStepIn } from "../protocol/port.js";
import { MCP_PROTOCOL_VERSION } from "../protocol/version.js";
import type { Json, JsonRpcPeer } from "./jsonrpc.js";
import { current } from "../otel/context.js";
import { spanMeta } from "./report.js";

export const STEER_NOTIFICATION = "notifications/deskmind/steer";
export const STOP_NOTIFICATION = "notifications/deskmind/stop";

export class McpPort implements ExecutorPort {
  /** The loop's counters, sent with every call. */
  counters: () => Record<string, number> = () => ({});
  /** Each call's round trip as this side saw it (the trace of the runtime). */
  onCall: (c: { id: number; tool: string; ms: number; isError: boolean }) => void = () => {};
  private mustPull = false;
  private n = 0;

  /** The user's request, as begin hands it over (set once the spec has come). */
  constructor(private readonly peer: JsonRpcPeer, public raw: string) {}

  /** The executor said the user's words are waiting: the next `steers()` asks for them. */
  steerWaiting() { this.mustPull = true; }

  async initialize(): Promise<Json> {
    const r = await this.peer.request("initialize", { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { experimental: { deskmind: { steer: "push" } } }, clientInfo: { name: "deskmind-runtime", version: "0.5" } });
    this.peer.notify("notifications/initialized");
    return r;
  }

  private async call(tool: string, args: Json = {}): Promise<{ out: Json; text: string; isError: boolean }> {
    const t0 = Date.now(), id = ++this.n;
    const r = await this.peer.request("tools/call", { name: tool, arguments: args, _meta: { "deskmind/counters": this.counters(), ...spanMeta(current) } });
    const text = ((r.content as { type: string; text?: string }[] | undefined) ?? []).map((c) => c.text ?? "").join("");
    const isError = r.isError === true;
    this.onCall({ id, tool, ms: Date.now() - t0, isError });
    return { out: (r.structuredContent ?? {}) as Json, text, isError };
  }
  /** A call whose reply is an object (not a ToolReply): an error is thrown, as the port in process throws. */
  private async object<T>(tool: string, args: Json = {}): Promise<T> {
    const r = await this.call(tool, args);
    if (r.isError) throw new Error(r.text);
    return r.out as T;
  }
  private async reply(tool: string, args: Json): Promise<ToolReply> {
    const r = await this.call(tool, args);
    const out = r.out as unknown as ToolReply;
    const rep: ToolReply = typeof out.text === "string" ? out : { text: r.text, ...(r.isError ? { isError: true } : {}) };
    if (rep.steers?.length) this.mustPull = true;
    return rep;
  }

  begin(): Promise<Begun> { return this.object("begin", { raw: this.raw }); }
  snapshot(): Promise<Snapshot> { return this.object("snapshot"); }
  observe(window: string): Promise<Observation> { return this.object("observe", { window }); }
  classify(p: { action: Action; epoch?: number; consequence?: Consequence }): Promise<Classified> { return this.object("classify", p as unknown as Json); }
  act(p: { action: Action; epoch: number; consequence: Consequence; purpose: string }) { return this.reply("act", p as unknown as Json); }
  file(p: { capability: string; args: Record<string, string> }) { return this.reply("file", p as unknown as Json); }
  plan(p: { steps: PlanStepIn[]; readings?: Reading[] }) { return this.reply("plan", p as unknown as Json); }
  askUser(p: { question: string; options: string[] }) { return this.reply("ask_user", p as unknown as Json); }
  answer(p: { text: string }) { return this.reply("answer", p as unknown as Json); }
  readSkill(p: { name: string }) { return this.reply("read_skill", p as unknown as Json); }
  finish(p: { outcome: FinishOutcome; summary: string; missing?: string[] }) { return this.reply("finish", p as unknown as Json); }
  async steers(): Promise<string[]> {
    if (!this.mustPull) return [];
    this.mustPull = false;               // a push that arrives during this call asks again at the next turn
    const r = await this.object<{ steers?: string[] }>("steers");
    return r.steers ?? [];
  }
  end(p: { failure?: string } = {}): Promise<TaskResult> { return this.object("end", p as Json); }
}
