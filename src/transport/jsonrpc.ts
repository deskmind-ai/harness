/**
 * JSON-RPC 2.0 over a pair of streams, one JSON object per line (MCP's stdio transport): both ends can send requests,
 * answer them and send notifications. The executor and its runtime child each hold one (executor split P2,
 * deskmind#90 item 6): the runtime sends `tools/call` requests; the executor answers them and pushes notifications
 * (stop, steer) the other way.
 *
 * When the other side goes away (its stream ends, or a write fails: EPIPE), the peer is closed: every request still
 * waiting is rejected and `closed` resolves with why. Answers to requests already read are still written after the
 * input ends (a caller may send its requests and close its end); once a write fails, later writes are dropped. Nothing
 * here throws on a dead pipe.
 */
import * as readline from "node:readline";

export type Json = Record<string, unknown>;
export type RpcId = number | string;

export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

export class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<RpcId, { resolve: (r: Json) => void; reject: (e: Error) => void }>();
  private done = false;
  private broken = false;
  private closedWith!: (why: string) => void;
  /** Resolves once, with why, when the other side is gone. */
  readonly closed: Promise<string> = new Promise((r) => { this.closedWith = r; });
  /** A request from the other side (it has an id): the handler answers it with `respond`. */
  onRequest: (msg: Json) => void = (msg) => this.respond({ jsonrpc: "2.0", id: msg.id as RpcId, error: { code: -32601, message: `method not found: ${String(msg.method)}` } });
  onNotification: (method: string, params: Json) => void = () => {};
  /** A line that is not JSON: answered with a parse error, as JSON-RPC says. */
  onParseError: (line: string) => void = () => this.write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });

  constructor(input: NodeJS.ReadableStream, private readonly output: NodeJS.WritableStream) {
    const rl = readline.createInterface({ input, terminal: false });
    rl.on("line", (line) => this.read(line));
    rl.on("close", () => this.close("the other side closed its stream"));
    input.on("error", (e: Error) => this.close(`read: ${e.message}`));
    output.on("error", (e: Error) => { this.broken = true; this.close(`write: ${e.message}`); });
  }

  get isClosed() { return this.done; }

  private read(line: string) {
    if (!line.trim()) return;
    let msg: Json;
    try { msg = JSON.parse(line); } catch { this.onParseError(line); return; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) { this.onParseError(line); return; }
    if (typeof msg.method === "string") {
      if (msg.id === undefined || msg.id === null) this.onNotification(msg.method, (msg.params ?? {}) as Json);
      else this.onRequest(msg);
      return;
    }
    // a response to one of ours
    const p = this.pending.get(msg.id as RpcId);
    if (!p) return;
    this.pending.delete(msg.id as RpcId);
    if (msg.error) { const e = msg.error as { code?: number; message?: string }; p.reject(new RpcError(e.code ?? -32603, e.message ?? "error")); }
    else p.resolve((msg.result ?? {}) as Json);
  }

  private write(msg: Json): boolean {
    if (this.broken) return false;
    try { this.output.write(JSON.stringify(msg) + "\n"); return true; }
    catch (e) { this.broken = true; this.close(`write: ${e instanceof Error ? e.message : String(e)}`); return false; }
  }

  request(method: string, params?: Json): Promise<Json> {
    if (this.done) return Promise.reject(new RpcError(-32000, "the other side is gone"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (!this.write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })) { this.pending.delete(id); reject(new RpcError(-32000, "the other side is gone")); }
    });
  }

  notify(method: string, params?: Json): boolean { return this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }); }
  respond(msg: Json): boolean { return this.write(msg); }

  close(why: string) {
    if (this.done) return;
    this.done = true;
    for (const p of this.pending.values()) p.reject(new RpcError(-32000, `the other side is gone (${why})`));
    this.pending.clear();
    this.closedWith(why);
  }
}
