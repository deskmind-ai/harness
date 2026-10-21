/**
 * What the runtime reports to the executor about itself, across the process boundary (executor split P2 on top of M0):
 * the executor owns the run's records — model_calls.jsonl, the `model_call` events and task_done's usage, the
 * OpenTelemetry trace (trace.otel.jsonl) — and the runtime's part of them (its model turns, its turn / chat /
 * execute_tool spans) used to reach them through the in-process context (otel/context.ts). Now:
 *
 *   runtime → executor   notifications/deskmind/model_call  {record}                    one acting-model call (role "loop")
 *                        notifications/deskmind/span        {op:"start", id, name, kind, parent, attrs, at}
 *                                                           {op:"end", id, attrs, status, at}
 *   tools/call _meta     "deskmind/span": the runtime's span in progress (its execute_tool span): the executor's spans
 *                        for that call (step, classify, judge, perform) are its children.
 *
 * The runtime side is a tracer (`RemoteTracer`) and a model-call recorder put in the runtime's own context, so the loop
 * runs unchanged; the executor side (`ReportMirror`) starts and ends the same spans on the run's tracer (its own span
 * ids, mapped) and hands the records to the run's recorder. Notifications and requests share one ordered pipe, so a
 * span's start is read before the call that names it, and a turn's record before the next call.
 */
import { randomBytes } from "node:crypto";
import { within, type ModelCallRecord, type SpanLike, type TraceContext, type TracerLike } from "../otel/context.js";
import type { Json, JsonRpcPeer } from "./jsonrpc.js";

export const MODEL_CALL_NOTIFICATION = "notifications/deskmind/model_call";
export const SPAN_NOTIFICATION = "notifications/deskmind/span";
export const SPAN_META = "deskmind/span";

/** What the executor asks the runtime to report (in its spec): the run is traced (the run's root span id, the parent
 *  of the runtime's turns) and/or its model calls are recorded. */
export interface ReportSpec { span?: string; spans?: boolean; models?: boolean }

class RemoteSpan implements SpanLike {
  readonly spanId = randomBytes(8).toString("hex");
  attrs: Record<string, unknown> = {};
  status: { code: 0 | 1 | 2; message?: string } = { code: 0 };
  ended = false;
  set(attrs: Record<string, unknown>) { for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) this.attrs[k] = v; }
  fail(message: string) { this.status = { code: 2, message: message.slice(0, 300) }; }
}

/** The runtime's tracer: each span's start and end goes to the executor. */
export class RemoteTracer implements TracerLike {
  constructor(private readonly peer: JsonRpcPeer, private readonly root: SpanLike | null) {}
  start(name: string, o: { kind?: "internal" | "client"; attrs?: Record<string, unknown>; parent?: SpanLike | null; at?: number } = {}): SpanLike {
    const s = new RemoteSpan();
    const parent = o.parent === undefined ? (currentSpan() ?? this.root) : o.parent;
    this.peer.notify(SPAN_NOTIFICATION, { op: "start", id: s.spanId, name, kind: o.kind ?? "internal", ...(parent ? { parent: parent.spanId } : {}), attrs: o.attrs ?? {}, at: o.at ?? Date.now() });
    return s;
  }
  end(span: SpanLike, at?: number) {
    const s = span as RemoteSpan;
    if (s.ended) return;
    s.ended = true;
    this.peer.notify(SPAN_NOTIFICATION, { op: "end", id: s.spanId, attrs: s.attrs, status: s.status, at: at ?? Date.now() });
  }
}

let currentSpan: () => SpanLike | undefined = () => undefined;

/** The runtime's context: the remote tracer (the run's root span as the parent of its turns) and the model-call
 *  recorder, as the spec asks. `run` executes inside it. */
export function reportingContext(peer: JsonRpcPeer, spec: ReportSpec | undefined, current: () => TraceContext): TraceContext {
  currentSpan = () => current().span;
  if (!spec) return {};
  const root: SpanLike | null = spec.span ? { spanId: spec.span, set() {}, fail() {} } : null;
  return {
    ...(spec.spans ? { tracer: new RemoteTracer(peer, root), ...(root ? { span: root } : {}) } : {}),
    ...(spec.models ? { onModelCall: (r: ModelCallRecord) => { peer.notify(MODEL_CALL_NOTIFICATION, { record: r as unknown as Json }); } } : {}),
  };
}

/** The runtime is a caller, not part of the executor: what it reports is checked before it becomes the run's record
 *  (review of #50). A number is finite, not negative and capped; a string is cut; only the fields a loop record has are
 *  kept, its role is always "loop", and it names no executor step or judge. */
const num = (v: unknown, cap: number) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.min(v, cap) : 0);
const str = (v: unknown, n: number) => (typeof v === "string" ? v.slice(0, n) : "");
export const SPAN_ATTRS_MAX = 8 * 1024;
export const SPANS_MAX = 20_000;

export function loopRecord(r: unknown, window: { from: number; to: number }): ModelCallRecord | null {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const x = r as Record<string, unknown>;
  const started = num(x.started_at, Number.MAX_SAFE_INTEGER);
  const err = str(x.error, 300);
  return {
    kind: "model.call", call_id: /^mc_[0-9a-f]{8}$/.test(String(x.call_id)) ? String(x.call_id) : `mc_${randomBytes(4).toString("hex")}`,
    role: "loop", backend: str(x.backend, 40) || "pi-ai", model: str(x.model, 200), outcome: ["answered", "error", "aborted"].includes(String(x.outcome)) ? String(x.outcome) : "answered",
    tokens_in: Math.round(num(x.tokens_in, 1e8)), tokens_out: Math.round(num(x.tokens_out, 1e8)), cache_read: Math.round(num(x.cache_read, 1e8)),
    cost_usd: num(x.cost_usd, 100), latency_ms: Math.round(num(x.latency_ms, 86_400_000)),
    started_at: Math.min(Math.max(started, window.from), window.to),
    sent_chars: Math.round(num(x.sent_chars, 1e9)), tool_calls: Math.round(num(x.tool_calls, 1000)),
    ...(x.cost_estimated === true ? { cost_estimated: true } : {}), ...(err ? { error: err } : {}),
  };
}

/** A span the runtime may report: its turns, its model calls, its tool calls — nothing named like the executor's own
 *  (deskmind.step, deskmind.judge, a consent). */
const SPAN_NAME = /^(deskmind\.turn|chat [^\n]{1,120}|execute_tool [\w.-]{1,64})$/;

/** Span attributes as reported, within SPAN_ATTRS_MAX: primitive values (and string lists) only, strings cut. */
function spanAttrs(a: unknown): Record<string, unknown> {
  if (!a || typeof a !== "object" || Array.isArray(a)) return {};
  const out: Record<string, unknown> = {};
  let size = 0;
  for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
    if (!/^[\w.]{1,80}$/.test(k)) continue;
    const val = typeof v === "string" ? v.slice(0, 1000) : typeof v === "number" ? (Number.isFinite(v) ? v : undefined) : typeof v === "boolean" ? v
      : Array.isArray(v) ? v.slice(0, 20).map((x) => String(x).slice(0, 100)) : undefined;
    if (val === undefined) continue;
    size += k.length + JSON.stringify(val).length;
    if (size > SPAN_ATTRS_MAX) break;
    out[k] = val;
  }
  return out;
}

/** The executor's side: the runtime's spans on the run's tracer, its records to the run's recorder — checked. */
export class ReportMirror {
  private readonly spans = new Map<string, SpanLike>();
  private readonly seen = new Set<string>();
  private readonly from = Date.now();
  /** What was dropped (a forged name, a duplicate id, too many spans, a record that is not one): for the trace. */
  readonly dropped: Record<string, number> = Object.create(null);
  constructor(private readonly ctx: TraceContext) {}

  private drop(why: string) { this.dropped[why] = (this.dropped[why] ?? 0) + 1; }
  private at(v: unknown): number { const now = Date.now(); return typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, this.from), now) : now; }

  /** What the executor asks the runtime to report, from the run's context. */
  spec(): ReportSpec | undefined {
    const { tracer, span, onModelCall } = this.ctx;
    if (!tracer && !onModelCall) return undefined;
    return { ...(tracer ? { spans: true, ...(span ? { span: span.spanId } : {}) } : {}), ...(onModelCall ? { models: true } : {}) };
  }

  notification(method: string, params: Json): boolean {
    if (method === MODEL_CALL_NOTIFICATION) {
      const r = loopRecord(params.record, { from: this.from, to: Date.now() });
      if (!r) { this.drop("model_call"); return true; }
      try { within(this.ctx, () => this.ctx.onModelCall?.(r)); } catch { /* recording never stops a run */ }
      return true;
    }
    if (method !== SPAN_NOTIFICATION) return false;
    const t = this.ctx.tracer;
    if (!t) return true;
    const id = typeof params.id === "string" && /^[0-9a-f]{16}$/.test(params.id) ? params.id : null;
    if (!id) { this.drop("span_id"); return true; }
    if (params.op === "start") {
      const name = typeof params.name === "string" ? params.name : "";
      if (!SPAN_NAME.test(name)) { this.drop("span_name"); return true; }
      if (this.seen.has(id)) { this.drop("span_duplicate"); return true; }
      if (this.seen.size >= SPANS_MAX) { this.drop("span_count"); return true; }
      this.seen.add(id);
      const p = typeof params.parent === "string" ? this.spans.get(params.parent) : undefined;
      // a parent the executor does not know (the run's root, named by its own id) is the run's span
      const s = t.start(name, { kind: name.startsWith("chat ") ? "client" : "internal", attrs: spanAttrs(params.attrs), parent: p ?? this.ctx.span ?? null, at: this.at(params.at) });
      this.spans.set(id, s);
    } else if (params.op === "end") {
      const s = this.spans.get(id);
      if (!s) return true;
      this.spans.delete(id);
      s.set(spanAttrs(params.attrs));
      const st = params.status as { code?: number; message?: string } | undefined;
      if (st?.code === 2) s.fail(str(st.message, 300) || "error");
      t.end(s, this.at(params.at));
    }
    return true;
  }

  /** The context a tools/call runs in: the run's, with the runtime's span in progress (its `_meta`) as the parent. */
  around<T>(meta: Json | undefined, fn: () => Promise<T>): Promise<T> {
    const id = meta?.[SPAN_META];
    const s = typeof id === "string" ? this.spans.get(id) : undefined;
    return within({ ...this.ctx, ...(s ? { span: s } : {}) }, fn);
  }
}

/** The runtime's counters as its calls carry them (`_meta`), checked: known-looking names, finite non-negative
 *  numbers under a cap, never going down (a counter only counts up). Returns the counters to keep. */
export function checkedCounters(prev: Record<string, number>, c: unknown): Record<string, number> {
  if (!c || typeof c !== "object" || Array.isArray(c)) return prev;
  const out: Record<string, number> = Object.assign(Object.create(null), prev);
  let n = 0;
  for (const [k, v] of Object.entries(c as Record<string, unknown>)) {
    if (++n > 64) break;
    if (!/^[a-z][a-z0-9_:.-]{0,40}$/.test(k) || k === "constructor") continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) continue;
    const x = Math.min(v, 1e9);
    if (x >= (out[k] ?? 0)) out[k] = x;
  }
  return { ...out };
}

/** Put the runtime's span in progress on a call's `_meta`. */
export function spanMeta(current: () => TraceContext): Json {
  const s = current().span;
  return s ? { [SPAN_META]: s.spanId } : {};
}
