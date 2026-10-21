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
import { StringDecoder } from "node:string_decoder";

export type Json = Record<string, unknown>;
export type RpcId = number | string;

export class RpcError extends Error {
  constructor(readonly code: number, message: string) { super(message); }
}

/** Limits on what the other side may send. By default none: the runtime child reading its parent (the executor)
 *  trusts it. A line longer than `maxLine` bytes is never dropped silently (the side waiting for it would hang, review
 *  of #50): `oversize` "close" (the executor reading its child: a protocol violation) rejects every pending request and
 *  closes the peer with `violation` set; "error" (the standalone server reading a foreign caller) answers it with a
 *  JSON-RPC error when the line's id can be read from its start, and otherwise closes. Notifications beyond
 *  `notifyPerSec` (a bucket of `notifyBurst`) are dropped and counted by method. */
export interface PeerLimits { maxLine?: number; oversize?: "close" | "error"; notifyPerSec?: number; notifyBurst?: number }
/** The line cap the executor sets for its runtime and the standalone server for its caller: 16 MB, in UTF-8 bytes. */
export const MAX_LINE = 16 * 1024 * 1024;

/** The top-level `"id"` of a JSON object's beginning (a number or a short string), read without parsing the rest:
 *  the answer to a request too large to read. Undefined when it is not there in `head`. */
export function topLevelId(head: string): RpcId | undefined {
  let depth = 0, i = 0;
  const str = (): string | null => { const m = /^"(?:[^"\\]|\\.)*"/.exec(head.slice(i)); if (!m) return null; i += m[0].length; return m[0]; };
  while (i < head.length) {
    const c = head[i]!;
    if (c === "{" || c === "[") { depth++; i++; continue; }
    if (c === "}" || c === "]") { depth--; i++; continue; }
    if (c === '"') {
      const k = str(); if (k === null) return undefined;
      if (depth === 1 && k === '"id"') {
        const m = /^\s*:\s*(-?\d+(?!\.)|"(?:[^"\\]|\\.){0,200}")\s*[,}]/.exec(head.slice(i));
        if (m) return JSON.parse(m[1]!) as RpcId;
      }
      continue;
    }
    i++;
  }
  return undefined;
}

export class JsonRpcPeer {
  /** Lines dropped for being too long, notifications dropped for coming too fast: the trace says how many. */
  readonly dropped = { long_lines: 0, notifications: 0 };
  /** Notifications dropped for the rate, by method. */
  readonly droppedByMethod: Record<string, number> = Object.create(null);
  /** Why the peer was closed for breaking the protocol (a line over the cap), if it was. */
  violation: string | null = null;
  private tokens: number;
  private refilled = Date.now();
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

  constructor(input: NodeJS.ReadableStream, private readonly output: NodeJS.WritableStream, private readonly limits: PeerLimits = {}) {
    this.tokens = limits.notifyBurst ?? Infinity;
    // lines by hand (not readline): a line over the cap is handled as it streams in, never held whole
    const max = limits.maxLine ?? Infinity, dec = new StringDecoder("utf8");
    let buf = "", skipping = false;
    const tooLong = (head: string): boolean => {          // true: the reader goes on (skipping the rest of the line)
      this.dropped.long_lines++;
      if (limits.oversize === "error") {
        const id = topLevelId(head.slice(0, 4096));
        if (id !== undefined) { this.write({ jsonrpc: "2.0", id, error: { code: -32600, message: `request too large (over ${max} bytes)` } }); return true; }
        this.write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: `line too large (over ${max} bytes)` } });
      }
      this.violation = "line too long";
      this.close("protocol: line too long");
      return false;
    };
    input.on("data", (chunk: Buffer | string) => {
      if (this.violation) return;
      buf += typeof chunk === "string" ? chunk : dec.write(chunk);
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (skipping) { skipping = false; continue; }
        // measured in UTF-8 bytes; the character count first, as a cheap filter (a character is at most 4 bytes)
        if (line.length > max / 4 && Buffer.byteLength(line) > max) { if (!tooLong(line)) { buf = ""; return; } continue; }
        this.read(line.endsWith("\r") ? line.slice(0, -1) : line);
        if (this.violation) return;
      }
      if (!skipping && buf.length > max / 4 && Buffer.byteLength(buf) > max) { if (!tooLong(buf)) { buf = ""; return; } skipping = true; }
      if (skipping) buf = "";
    });
    // after a violation nothing more is read: a request still in the buffer is not served when the stream ends
    input.on("end", () => { if (buf && !skipping && !this.violation) this.read(buf); buf = ""; this.close("the other side closed its stream"); });
    input.on("close", () => this.close("the other side closed its stream"));
    input.on("error", (e: Error) => this.close(`read: ${e.message}`));
    output.on("error", (e: Error) => { this.broken = true; this.close(`write: ${e.message}`); });
  }

  get isClosed() { return this.done; }

  /** One notification within the rate (a token bucket), or dropped. */
  private admit(method: string): boolean {
    const rate = this.limits.notifyPerSec;
    if (rate === undefined) return true;
    const now = Date.now();
    this.tokens = Math.min(this.limits.notifyBurst ?? rate, this.tokens + ((now - this.refilled) / 1000) * rate);
    this.refilled = now;
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    this.dropped.notifications++;
    this.droppedByMethod[method] = (this.droppedByMethod[method] ?? 0) + 1;
    return false;
  }

  private read(line: string) {
    if (this.violation) return;
    if (!line.trim()) return;
    let msg: Json;
    try { msg = JSON.parse(line); } catch { this.onParseError(line); return; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) { this.onParseError(line); return; }
    if (typeof msg.method === "string") {
      if (msg.id === undefined || msg.id === null) { if (this.admit(msg.method)) this.onNotification(msg.method, (msg.params ?? {}) as Json); }
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
