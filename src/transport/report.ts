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

/** The executor's side: the runtime's spans on the run's tracer, its records to the run's recorder. */
export class ReportMirror {
  private readonly spans = new Map<string, SpanLike>();
  constructor(private readonly ctx: TraceContext) {}

  /** What the executor asks the runtime to report, from the run's context. */
  spec(): ReportSpec | undefined {
    const { tracer, span, onModelCall } = this.ctx;
    if (!tracer && !onModelCall) return undefined;
    return { ...(tracer ? { spans: true, ...(span ? { span: span.spanId } : {}) } : {}), ...(onModelCall ? { models: true } : {}) };
  }

  notification(method: string, params: Json): boolean {
    if (method === MODEL_CALL_NOTIFICATION) {
      const r = params.record as ModelCallRecord | undefined;
      if (r && typeof r === "object") try { within(this.ctx, () => this.ctx.onModelCall?.(r)); } catch { /* recording never stops a run */ }
      return true;
    }
    if (method !== SPAN_NOTIFICATION) return false;
    const t = this.ctx.tracer;
    if (!t) return true;
    const id = String(params.id ?? "");
    if (params.op === "start") {
      const p = typeof params.parent === "string" ? this.spans.get(params.parent) : undefined;
      // a parent the executor does not know (the run's root, named by its own id) is the run's span
      const s = t.start(String(params.name ?? "span"), { kind: params.kind === "client" ? "client" : "internal", attrs: (params.attrs ?? {}) as Record<string, unknown>, parent: p ?? this.ctx.span ?? null, ...(typeof params.at === "number" ? { at: params.at } : {}) });
      this.spans.set(id, s);
    } else if (params.op === "end") {
      const s = this.spans.get(id);
      if (!s) return true;
      s.set((params.attrs ?? {}) as Record<string, unknown>);
      const st = params.status as { code?: number; message?: string } | undefined;
      if (st?.code === 2) s.fail(st.message ?? "error");
      t.end(s, typeof params.at === "number" ? params.at : undefined);
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

/** Put the runtime's span in progress on a call's `_meta`. */
export function spanMeta(current: () => TraceContext): Json {
  const s = current().span;
  return s ? { [SPAN_META]: s.spanId } : {};
}
