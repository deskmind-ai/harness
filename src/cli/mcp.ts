/**
 * The execution layer as an MCP service (stdio, JSON-RPC 2.0): seven tools over the Executor, so any runtime (Codex,
 * Claude Code, our own) gets the same ownership, consequence floor, consent, start gate, intent check and completion
 * verdict. The judge and the verdict use the gateway config; the runtime above only sees refusals and reasons.
 *
 *   pnpm mcp -- --driver sim|hands [--scope <dir>] [--config ds-flash] [--consent auto|none]
 *
 * Consent: with `--consent none` (the default) a consequential action returns `needs_consent` with the challenge, and
 * the host has to come back with a token the app signed (the MCP elicitation path is for the app integration). With
 * `--consent auto` this process signs every challenge itself and logs it: development on one's own Mac only, never in
 * the app.
 *
 * Only what MCP needs is implemented here (initialize, tools/list, tools/call, ping); no SDK, no other transport.
 */
import * as readline from "node:readline";
import { parseArgs } from "node:util";
import { CONFIGS, Gateway } from "../gateway/index.js";
import { ConsentSigner } from "../executor/consent.js";
import { Executor } from "../executor/executor.js";
import { defaultJudge } from "../executor/judge.js";
import { SimComputer } from "../executor/sim.js";
import { HandsDriver } from "../executor/hands.js";
import type { Action, Consequence, Driver, PlanProposal } from "../executor/types.js";
import { fileRegistry } from "../registry/fs.js";
import { Workspace } from "../registry/workspace.js";

type Json = Record<string, unknown>;
const schema = (properties: Json, required: string[] = []) => ({ type: "object", properties, required });

export const TOOLS = [
  { name: "begin", description: "开始任务：记下现在屏幕上的一切（都是用户的），返回整台电脑的状态。raw 是用户的原话，判官会用。", inputSchema: schema({ raw: { type: "string" } }, ["raw"]) },
  { name: "snapshot", description: "整台电脑的状态：锁屏、最前面的应用、所有窗口（id、应用、标题、归谁）。只读。", inputSchema: schema({}) },
  { name: "observe", description: "一个窗口的元素、弹窗、文字。动作要用这里的元素 id 和 epoch。只读。", inputSchema: schema({ window: { type: "string" } }, ["window"]) },
  { name: "plan", description: "动手前的计划：步骤（目的、对象、后果类别）和有歧义处的理解与依据。碰用户的东西、往外发之前必须有。依据不够的理解会被退回，先问用户。", inputSchema: schema({ steps: { type: "array" }, readings: { type: "array" } }, ["steps"]) },
  { name: "act", description: "做一个动作（界面动作带 window/target/epoch；文件动作 kind=file 带 capability 和 args）。改用户的东西、往外发要先有计划和同意。", inputSchema: schema({ action: { type: "object" }, epoch: { type: "number" }, consequence: { type: "string" }, purpose: { type: "string" }, consent: { type: "object" } }, ["action"]) },
  { name: "verify", description: "结束前的独立核对：判官读现在的状态，回答 pass / fail / unknown。unknown 不算做成。", inputSchema: schema({ summary: { type: "string" } }, ["summary"]) },
  { name: "stop", description: "停止开关：之后的动作一律拒绝。", inputSchema: schema({}) },
  { name: "end", description: "收尾：回执和任务创建的对象。", inputSchema: schema({}) },
];

export class McpExecutorServer {
  private ex: Executor | null = null;
  constructor(private readonly o: { driver: () => Driver; gateway: Gateway; workspace?: Workspace; consent: "auto" | "none"; log?: (line: string) => void }) {}

  async call(name: string, args: Json): Promise<Json> {
    if (name === "begin") {
      const app = ConsentSigner.fresh();
      this.signer = this.o.consent === "auto" ? app : null;
      this.ex = new Executor(this.o.driver(), { task: `mcp_${Date.now().toString(36)}`, publicKey: app.publicKey, raw: String(args.raw ?? ""), judge: defaultJudge(this.o.gateway, (k, b) => this.o.log?.(JSON.stringify({ k, ...b }))), ...(this.o.workspace ? { files: { workspace: this.o.workspace, registry: fileRegistry() } } : {}) });
      return (await this.ex.begin()) as unknown as Json;
    }
    const ex = this.ex;
    if (!ex) return { error: "begin first" };
    switch (name) {
      case "snapshot": return (await ex.snapshot()) as unknown as Json;
      case "observe": return (await ex.observe(String(args.window))) as unknown as Json;
      case "plan": return (await ex.plan(args as unknown as PlanProposal)) as unknown as Json;
      case "act": {
        const req = { action: args.action as Action, epoch: typeof args.epoch === "number" ? args.epoch : ex.currentEpoch, consequence: args.consequence as Consequence | undefined, purpose: args.purpose as string | undefined, consent: args.consent as never };
        let r = await ex.act(req);
        if (r.status === "needs_consent" && r.challenge && this.signer) {
          // development only: this process stands in for the app and signs; every such consent is logged
          this.o.log?.(JSON.stringify({ k: "auto_consent", text: r.challenge.text }));
          r = await ex.act({ ...req, epoch: r.epoch, consent: this.signer.forAction(r.challenge) });
        }
        const { after, ...rest } = r;
        return { ...rest, ...(after ? { after: { epoch: after.epoch, window: after.window, modal: after.modal, elements: after.elements, text: after.text } } : {}) } as unknown as Json;
      }
      case "verify": return (await ex.verdict(String(args.summary ?? ""))) as unknown as Json;
      case "stop": ex.stop(); return { stopped: true };
      case "end": return (await ex.end()) as unknown as Json;
    }
    return { error: `unknown tool ${name}` };
  }
  private signer: ConsentSigner | null = null;

  /** One JSON-RPC request → one response (or null for a notification). */
  async handle(msg: Json): Promise<Json | null> {
    const id = msg.id, method = String(msg.method ?? "");
    const reply = (result: Json) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (method === "initialize") return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "deskmind-executor", version: "0.5" } });
    if (method.startsWith("notifications/")) return null;
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: TOOLS });
    if (method === "tools/call") {
      const p = (msg.params ?? {}) as Json;
      try {
        const out = await this.call(String(p.name), (p.arguments ?? {}) as Json);
        const isError = typeof out.error === "string" || ["refused", "stale", "needs_plan", "error", "stopped", "environment", "blocked"].includes(String(out.status));
        return reply({ content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out, isError });
      } catch (e) {
        return reply({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
    }
    return fail(-32601, `method not found: ${method}`);
  }
}

async function main() {
  const { values: a } = parseArgs({ args: process.argv.slice(2).filter((x) => x !== "--"), options: { driver: { type: "string", default: "sim" }, scope: { type: "string" }, config: { type: "string", default: "ds-flash" }, consent: { type: "string", default: "none" } } });
  if (!CONFIGS[a.config!]) throw new Error(`unknown config ${a.config}`);
  const gw = new Gateway(a.config!);
  const ws = a.scope ? new Workspace(a.scope) : undefined;
  const server = new McpExecutorServer({ driver: () => (a.driver === "hands" ? new HandsDriver(ws ? { workspace: ws.root } : {}) : new SimComputer(ws?.root)), gateway: gw, workspace: ws, consent: a.consent === "auto" ? "auto" : "none", log: (l) => process.stderr.write(l + "\n") });
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const answer = (res: Json | null) => { if (res) process.stdout.write(JSON.stringify(res) + "\n"); };
  // requests run one after another, in order — except stop, which is the stop switch: it is handled the moment it
  // arrives, so an act waiting for the user (or the judge) sees it before its effect (review of #16)
  let queue: Promise<void> = Promise.resolve();
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: Json;
    try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n"); continue; }
    if (isStop(msg)) { answer(await server.handle(msg)); continue; }
    queue = queue.then(() => server.handle(msg).then(answer)).catch((e) => { process.stderr.write(String(e) + "\n"); });
  }
  await queue;
}

/** A tools/call of `stop`. */
export const isStop = (msg: Json) => msg.method === "tools/call" && (msg.params as Json | undefined)?.name === "stop";

const entry = process.argv[1] ?? "";
if (entry.endsWith("mcp.ts") || entry.endsWith("mcp.js")) main().catch((e) => { process.stderr.write(String(e) + "\n"); process.exit(1); });
