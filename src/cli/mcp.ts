/**
 * The executor as an MCP service (stdio, JSON-RPC 2.0): the executor port (protocol/port.ts) as tools
 * (protocol/tools.ts), so any runtime (Codex, Claude Code, our own) gets the same ownership, consequence floor, consent,
 * start gate, intent check, completion verdict and undo. The judges use the gateway config; a caller only sees replies,
 * refusals and reasons — never a card, a token or a key.
 *
 * Two ways it runs:
 *   - hosted (executor split P2): the executor process (`harness.mjs executor`, cli/app.ts) serves one task's port to
 *     its runtime child over the child's stdin/stdout (host/agent.ts);
 *   - standalone, for a foreign caller:  pnpm mcp -- --driver sim|hands [--scope <dir>] [--config ds-flash] [--consent auto|none]
 *     `begin {raw}` starts the task. Cards are the app's in production; here, `--consent none` (the default) answers
 *     none of them (a step that needs the user's yes is declined), and `--consent auto` approves every card that has an
 *     approve option and logs it: development on one's own Mac only, never in the app.
 *
 * Only what MCP needs is implemented here (initialize, tools/list, tools/call, ping); no SDK, no other transport.
 * `initialize` answers MCP 2025-06-18 (or 2024-11-05 when the client asks for it) and names DeskMind's own interface
 * versions under `capabilities.experimental.deskmind` ({tools, events, control}; docs/protocol.md). A client that sets
 * `capabilities.experimental.deskmind.steer: "push"` in its initialize is told by a `notifications/deskmind/steer`
 * when the user's words are waiting (it then calls `steers`); any other caller calls `steers` at each of its turns.
 *
 * Requests are handled one after another, in order — except `stop` (the caller's stop switch) and `ping`, handled the
 * moment they arrive, so an act waiting for the user (or the judge) sees the stop before its effect (review of #16).
 */
import { parseArgs } from "node:util";
import { validateToolArguments, type Tool } from "@earendil-works/pi-ai";
import { CONFIGS, Gateway } from "../gateway/index.js";
import { ConsentSigner } from "../executor/consent.js";
import { Executor } from "../executor/executor.js";
import { ExecutorService } from "../executor/service.js";
import { SimComputer } from "../executor/sim.js";
import { HandsDriver } from "../executor/hands.js";
import type { Driver } from "../executor/types.js";
import type { CardAsker } from "../protocol/cards.js";
import type { ExecutorPort, FinishOutcome, ToolReply } from "../protocol/port.js";
import { PORT_TOOLS, mcpTools } from "../protocol/tools.js";
import { fileRegistry } from "../registry/fs.js";
import { Workspace } from "../registry/workspace.js";
import { MCP_PROTOCOL_VERSION, MCP_PROTOCOL_VERSIONS, PROTOCOL } from "../protocol/version.js";
import { JsonRpcPeer, MAX_LINE, type Json } from "../transport/jsonrpc.js";

/** The tools/list entries (name, description, inputSchema). */
export const TOOLS = mcpTools();
const BY_NAME = new Map(PORT_TOOLS.map((t) => [t.name, { name: t.name, description: t.description, parameters: t.parameters } as Tool]));

/** One task's port, and the stop switch beside it. */
export interface McpSession { port: ExecutorPort; stop(why: string): void }

/** One tools/call as the server saw it: when it arrived, how long it waited behind earlier ones, how long it took. */
export interface CallRecord { id: unknown; tool: string; queued_ms: number; ms: number; isError: boolean; done?: boolean }

type Standalone = { driver: () => Driver; gateway: Gateway; workspace?: Workspace; consent: "auto" | "none"; log?: (line: string) => void };
type Hosted = { session: McpSession; log?: (line: string) => void;
  /** What our runtime child needs to start (host/agent.ts AgentSpec), handed over in the initialize result's `_meta`
   *  ("deskmind/agent") — not in its environment or on its command line. */
  agent?: Json };
export type ServerOptions = (Standalone | Hosted) & {
  /** Every tools/call, after it is answered (the trace's per-call timing). */
  onCall?: (c: CallRecord) => void;
  /** The `_meta` a tools/call carried (our runtime sends its counters there). */
  onMeta?: (meta: Json) => void;
  /** A notification from the caller (our runtime's reports: transport/report.ts). */
  onNotification?: (method: string, params: Json) => void;
  /** Runs each tools/call (the run's context, the caller's span in progress as the parent). */
  around?: <T>(meta: Json | undefined, fn: () => Promise<T>) => Promise<T>;
};

/** A card asker for the standalone server: approve (and log) under `--consent auto`; otherwise answer nothing. */
function standaloneUser(consent: "auto" | "none", log?: (line: string) => void): CardAsker {
  return {
    ask(card) {
      const i = consent === "auto" ? card.options.findIndex((o) => o.kind === "approve") : -1;
      log?.(JSON.stringify({ k: consent === "auto" ? "auto_consent" : "card_unanswered", kind: card.kind, text: card.text, picked: i >= 0 ? "approve" : null }));
      return i >= 0 ? { option: i } : null;
    },
  };
}

export class McpExecutorServer {
  private session: McpSession | null;
  /** The client asked to be told when steers are waiting (initialize). */
  steerPush = false;
  constructor(private readonly o: ServerOptions) { this.session = "session" in o ? o.session : null; }

  private open(raw: string): McpSession {
    const o = this.o as Standalone;
    const signer = ConsentSigner.fresh();
    const task = `mcp_${Date.now().toString(36)}`;
    const ws = o.workspace;
    const svc = new ExecutorService({
      task, raw, executor: new Executor(o.driver(), { task, publicKey: signer.publicKey }), signer, user: standaloneUser(o.consent, o.log), gateway: o.gateway,
      ...(ws ? { workspace: ws, registry: fileRegistry() } : {}),
      onEvent: (k, b) => o.log?.(JSON.stringify({ k, ...b })),
    });
    return { port: svc.port, stop: (why) => svc.stop(why) };
  }

  /** One tool call → what the caller reads (`text`), the structured result, and whether it is an error. */
  async call(name: string, args: Json): Promise<{ text: string; out: Json; isError: boolean }> {
    const tool = BY_NAME.get(name);
    if (!tool) return { text: `unknown tool ${name}`, out: { error: `unknown tool ${name}` }, isError: true };
    let a: Json;
    try { a = validateToolArguments(tool, { type: "toolCall", id: "", name, arguments: args as never }) as Json; }
    catch (e) { const m = e instanceof Error ? e.message : String(e); return { text: m, out: { error: m }, isError: true }; }
    if (name === "begin" && !this.session) this.session = this.open(String(a.raw));
    const s = this.session;
    if (!s) return { text: "begin first", out: { error: "begin first" }, isError: true };
    const port = s.port;
    const obj = (x: unknown) => { const o = bounded(x as Json); return { text: JSON.stringify(o), out: o, isError: false }; };
    const reply = (r: ToolReply) => { const t = r.text.length > REPLY_MAX ? `${r.text.slice(0, REPLY_MAX)}…(cut: ${r.text.length - REPLY_MAX} more characters)` : r.text; return { text: t, out: { ...r, text: t } as unknown as Json, isError: !!r.isError }; };
    switch (name) {
      case "begin": return obj(await port.begin());
      case "snapshot": return obj(await port.snapshot());
      case "observe": return obj(await port.observe(String(a.window)));
      case "classify": return obj(await port.classify(a as never));
      case "act": return reply(await port.act(a as never));
      case "file": return reply(await port.file(a as never));
      case "plan": return reply(await port.plan(a as never));
      case "ask_user": return reply(await port.askUser(a as never));
      case "answer": return reply(await port.answer(a as never));
      case "read_skill": return reply(await port.readSkill(a as never));
      case "finish": return reply(await port.finish(a as { outcome: FinishOutcome; summary: string; missing?: string[] }));
      case "steers": return obj({ steers: await port.steers() });
      case "end": return obj(await port.end(typeof a.failure === "string" ? { failure: a.failure } : {}));
      case "stop":
        // the executor's own runtime does not stop the task: the user does (the app's stop). It ends by finish / end,
        // or by exiting (review of #50: a stop from the child read like the user's, with no refused event)
        if ("session" in this.o) return { text: "stop is the user's: end the task with finish or end", out: { error: "stop is refused for the executor's runtime" }, isError: true };
        s.stop("stopped by the caller"); return obj({ stopped: true });
    }
    return { text: `unknown tool ${name}`, out: { error: `unknown tool ${name}` }, isError: true };
  }

  /** One JSON-RPC message → its response (null for a notification). `at`: when it arrived (for the queue time). */
  async handle(msg: Json, at = Date.now()): Promise<Json | null> {
    const id = msg.id, method = String(msg.method ?? "");
    const ok = (result: Json) => ({ jsonrpc: "2.0", id, result });
    const fail = (code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });
    if (method === "initialize") {
      const params = (msg.params ?? {}) as Json;
      // version negotiation (MCP lifecycle): echo a revision we speak, else offer ours
      const asked = params.protocolVersion;
      const protocolVersion = typeof asked === "string" && MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSION;
      const dm = ((params.capabilities as Json | undefined)?.experimental as Json | undefined)?.deskmind as Json | undefined;
      this.steerPush = dm?.steer === "push";
      const agent = "session" in this.o ? this.o.agent : undefined;
      return ok({ protocolVersion, capabilities: { tools: {}, experimental: { deskmind: { tools: PROTOCOL.tools, events: PROTOCOL.events, control: PROTOCOL.control } } }, serverInfo: { name: "deskmind-executor", version: "0.5" }, ...(agent ? { _meta: { "deskmind/agent": agent } } : {}) });
    }
    if (method.startsWith("notifications/")) { this.o.onNotification?.(method, (msg.params ?? {}) as Json); return null; }
    if (method === "ping") return ok({});
    if (method === "tools/list") return ok({ tools: TOOLS });
    if (method === "tools/call") {
      const p = (msg.params ?? {}) as Json;
      const name = String(p.name);
      if (p._meta && typeof p._meta === "object") this.o.onMeta?.(p._meta as Json);
      const t0 = Date.now();
      let res: Json, isError = true, done: boolean | undefined;
      try {
        const run = () => this.call(name, (p.arguments ?? {}) as Json);
        const r = this.o.around ? await this.o.around(p._meta as Json | undefined, run) : await run();
        isError = r.isError; done = (r.out as { done?: boolean }).done;
        res = ok({ content: [{ type: "text", text: r.text }], structuredContent: r.out, isError: r.isError });
      } catch (e) {
        res = ok({ content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
      }
      this.o.onCall?.({ id, tool: name, queued_ms: t0 - at, ms: Date.now() - t0, isError, ...(done ? { done } : {}) });
      return res;
    }
    return fail(-32601, `method not found: ${method}`);
  }
}

/** What one reply may carry (its text; the line holds it twice, as text and as the structured result): one huge window
 *  must not make a line the other side refuses (review of #50). */
export const REPLY_MAX = 4 * 1024 * 1024;

/** An object reply within REPLY_MAX: an observation's elements and text are cut, with a `truncated` marker saying what
 *  was left out; anything else too large is replaced by a marker. */
export function bounded(x: Json): Json {
  const size = (v: unknown) => JSON.stringify(v).length;
  if (!x || typeof x !== "object" || size(x) <= REPLY_MAX) return x;
  const out: Json = { ...x };
  const truncated: Json = {};
  if (typeof out.text === "string" && out.text.length > REPLY_MAX / 4) { truncated.text = out.text.length; out.text = out.text.slice(0, REPLY_MAX / 4) + "…(cut)"; }
  if (Array.isArray(out.elements)) {
    const all = out.elements as unknown[];
    let keep = all.length;
    while (keep > 0 && size({ ...out, elements: all.slice(0, keep) }) > REPLY_MAX) keep = Math.floor(keep * 0.8);
    if (keep < all.length) { truncated.elements = all.length; out.elements = all.slice(0, keep); }
  }
  if (size(out) > REPLY_MAX) return { truncated: { bytes: size(x) }, note: "the reply was too large to send; look at a smaller part" };
  return { ...out, truncated };
}

/** A tools/call of `stop`. */
export const isStop = (msg: Json) => msg.method === "tools/call" && (msg.params as Json | undefined)?.name === "stop";

/** Serve `server` on `peer`: requests one after another in order, `stop` and `ping` at once. `idle()` resolves once
 *  every request received so far has been answered (an act at the driver has its receipt). */
export function serve(server: McpExecutorServer, peer: JsonRpcPeer, log: (line: string) => void = () => {}) {
  let queue: Promise<void> = Promise.resolve();
  let refused: string | null = null;
  peer.onRequest = (msg) => {
    if (refused !== null) { peer.respond({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: refused } }); return; }
    const at = Date.now();
    const answer = (res: Json | null) => { if (res) peer.respond(res); };
    if (isStop(msg) || msg.method === "ping") { void server.handle(msg, at).then(answer, (e) => log(String(e))); return; }
    queue = queue.then(() => server.handle(msg, at).then(answer)).catch((e) => log(String(e)));
  };
  peer.onNotification = (method, params) => { void server.handle({ jsonrpc: "2.0", method, params }); };
  return {
    async idle() { let q: Promise<void>; do { q = queue; await q; } while (q !== queue); },
    /** From now on every request is answered with an error, unserved (the caller is gone; what it sent before still is). */
    refuse(why: string) { refused = why; },
  };
}

async function main() {
  const { values: a } = parseArgs({ args: process.argv.slice(2).filter((x) => x !== "--"), options: { driver: { type: "string", default: "sim" }, scope: { type: "string" }, config: { type: "string", default: "ds-flash" }, consent: { type: "string", default: "none" } } });
  if (!CONFIGS[a.config!]) throw new Error(`unknown config ${a.config}`);
  const gw = new Gateway(a.config!);
  const ws = a.scope ? new Workspace(a.scope) : undefined;
  const log = (l: string) => process.stderr.write(l + "\n");
  const server = new McpExecutorServer({ driver: () => (a.driver === "hands" ? new HandsDriver(ws ? { workspace: ws.root } : {}) : new SimComputer(ws?.root)), gateway: gw, workspace: ws, consent: a.consent === "auto" ? "auto" : "none", log });
  // a foreign caller: a request over 16 MB is answered with an error (or, without a readable id, the connection closed)
  const peer = new JsonRpcPeer(process.stdin, process.stdout, { maxLine: MAX_LINE, oversize: "error" });
  const s = serve(server, peer, log);
  await peer.closed;
  await s.idle();
}

const entry = process.argv[1] ?? "";
if (entry.endsWith("mcp.ts") || entry.endsWith("mcp.js")) main().catch((e) => { process.stderr.write(String(e) + "\n"); process.exit(1); });
