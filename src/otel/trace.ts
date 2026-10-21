/**
 * The run as an OpenTelemetry trace (owner 10-21: the developer view is one standard call-chain waterfall): spans
 * following the GenAI semantic conventions —
 *
 *   invoke_agent deskmind                     the run
 *     deskmind.turn                           one model turn of the agent loop
 *       chat <model>                          the acting model's call (gen_ai.*: model, input/output tokens)
 *       execute_tool <name>                   one tool call
 *         deskmind.step                       an act / file step (its step_id, outcome)
 *           deskmind.classify                 the class the executor settles (structure, model, judge)
 *             deskmind.judge <question>       one judge question (tier that settled it, shadow agreement)
 *               chat <model>                  a judge tier's model call (deskmind.tier)
 *           deskmind.ask_user                 a card waiting for the user
 *           deskmind.user_busy                waiting for the user to stop typing
 *           deskmind.perform                  the driver (hands) doing it (deskmind.token_kind: the consent used)
 *         deskmind.plan / deskmind.verify     the plan card, the verdict
 *
 * Every span has its parent, start and end, a status, gen_ai.* attributes where the conventions have one, and
 * deskmind.* for ours (tier, consequence, token kind, step and judge ids, cost in USD).
 *
 * Written to `<run>/trace.otel.jsonl`, one OTLP/JSON ExportTraceServiceRequest per line, each holding the span that
 * just ended (the OpenTelemetry collector's file exporter format); `exportTrace` merges a run's lines into one request
 * that Jaeger, Phoenix or Langfuse take on their OTLP/HTTP endpoints. On this Mac only: nothing here sends anything.
 *
 * The parent is the span in progress in the async context (otel/context.ts); a span started outside a run (no
 * tracer there) is not recorded and costs nothing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { current, within, type SpanLike, type TracerLike } from "./context.js";

type Attr = string | number | boolean | string[];
const nowNs = (): bigint => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
const msNs = (ms: number): bigint => BigInt(Math.round(ms * 1e6));

/** An OTLP/JSON attribute value (int64 as a string, as proto3 JSON writes it). */
function value(v: Attr): Record<string, unknown> {
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => ({ stringValue: String(x) })) } };
  if (typeof v === "boolean") return { boolValue: v };
  if (typeof v === "number") return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: v };
}
const attributes = (a: Record<string, unknown>) => Object.entries(a).filter(([, v]) => v !== undefined && v !== null && v !== "").map(([key, v]) => ({ key, value: value(v as Attr) }));

export class Span implements SpanLike {
  readonly spanId = randomBytes(8).toString("hex");
  readonly attrs: Record<string, unknown> = {};
  status: { code: 0 | 1 | 2; message?: string } = { code: 0 };
  ended = false;
  constructor(readonly name: string, readonly kind: "internal" | "client", readonly parentSpanId: string | undefined, readonly start: bigint, attrs: Record<string, unknown> = {}) { this.set(attrs); }
  set(attrs: Record<string, unknown>) { for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) this.attrs[k] = Array.isArray(v) ? v.map(String) : typeof v === "object" ? JSON.stringify(v) : v; }
  /** The span ended in an error (a call that failed, a step the driver could not do); the run going on is not one. */
  fail(message: string) { this.status = { code: 2, message: message.slice(0, 300) }; }
}

export const SERVICE = "deskmind-harness";

export class Tracer implements TracerLike {
  readonly traceId = randomBytes(16).toString("hex");
  private open = new Set<Span>();

  constructor(readonly file: string, readonly resource: Record<string, unknown> = {}) {
    try { fs.mkdirSync(path.dirname(file), { recursive: true }); } catch { /* the trace never stops a run */ }
  }

  start(name: string, o: { kind?: "internal" | "client"; attrs?: Record<string, unknown>; parent?: SpanLike | null; at?: number } = {}): Span {
    const parent = o.parent === undefined ? current().span : o.parent;
    const s = new Span(name, o.kind ?? "internal", parent?.spanId, o.at !== undefined ? msNs(o.at) : nowNs(), o.attrs);
    this.open.add(s);
    return s;
  }

  /** End the span (now, or at `at` ms since the epoch) and write it. A span ends once. */
  end(span: SpanLike, at?: number) {
    const s = span as Span;
    if (s.ended) return;
    s.ended = true;
    this.open.delete(s);
    if (s.status.code === 0) s.status = { code: 1 };
    const end = at !== undefined ? msNs(at) : nowNs();
    const otlp = {
      traceId: this.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}), name: s.name,
      kind: s.kind === "client" ? 3 : 1, startTimeUnixNano: String(s.start), endTimeUnixNano: String(end > s.start ? end : s.start),
      attributes: attributes(s.attrs), status: s.status,
    };
    try { fs.appendFileSync(this.file, JSON.stringify(request([otlp], this.resource)) + "\n"); } catch { /* the trace never stops a run */ }
  }

  /** Spans still open when the run ends (a stop that did not wait, a step whose receipt never came): ended now, as
   *  errors that say so, so the tree has no holes. Children first. */
  closeAll(message = "the run ended before this span", keep?: SpanLike) {
    for (const s of [...this.open].reverse()) if (s !== keep) { s.fail(message); this.end(s); }
  }
}

/** One OTLP/JSON ExportTraceServiceRequest holding `spans`. */
export function request(spans: unknown[], resource: Record<string, unknown> = {}) {
  return { resourceSpans: [{ resource: { attributes: attributes({ "service.name": SERVICE, ...resource }) }, scopeSpans: [{ scope: { name: "deskmind.harness", version: "1" }, spans }] }] };
}

/** Run `fn` inside a child span of the span in progress: everything it awaits is under it. `fn` gets the span (null
 *  when no run is being traced) to add attributes or mark a failure; a throw marks it failed and goes on up. */
export async function span<T>(name: string, attrs: Record<string, unknown>, fn: (s: SpanLike | null) => Promise<T> | T, o: { kind?: "internal" | "client" } = {}): Promise<T> {
  const tracer = current().tracer;
  if (!tracer) return fn(null);
  const s = tracer.start(name, { attrs, ...(o.kind ? { kind: o.kind } : {}) });
  try {
    const r = await within({ span: s }, () => fn(s));
    tracer.end(s);
    return r;
  } catch (e) {
    s.fail(e instanceof Error ? e.message : String(e));
    tracer.end(s);
    throw e;
  }
}

/** The GenAI attributes of one model call (gen_ai.* per the semantic conventions; ours under deskmind.*). The provider
 *  is the `<provider>|<model>` spec's provider, else the backend. */
export function chatAttrs(r: { model: string; backend?: string; role: string; tokens_in: number; tokens_out: number; cost_usd: number; outcome: string; call_id?: string; tier?: string; cache_read?: number; cost_estimated?: boolean }): Record<string, unknown> {
  const [provider, ...rest] = r.model.includes("|") ? r.model.split("|") : [r.backend ?? "unknown", r.model];
  const model = rest.join("|") || r.model;
  return {
    "gen_ai.operation.name": "chat", "gen_ai.provider.name": provider, "gen_ai.system": provider, "gen_ai.request.model": model, "gen_ai.response.model": model,
    "gen_ai.usage.input_tokens": r.tokens_in, "gen_ai.usage.output_tokens": r.tokens_out, "gen_ai.usage.cache_read.input_tokens": r.cache_read, "gen_ai.usage.cost": r.cost_usd,
    "deskmind.cost_estimated": r.cost_estimated || undefined,
    "deskmind.role": r.role, "deskmind.cost_usd": r.cost_usd, "deskmind.outcome": r.outcome, "deskmind.call_id": r.call_id, "deskmind.tier": r.tier,
  };
}

/** A run's spans as one OTLP/JSON request (what `harness.mjs trace export` writes): every line's spans, in the order
 *  they ended, under one resource. Lines cut off mid-write are skipped. */
export function exportTrace(file: string): { request: ReturnType<typeof request>; spans: number } {
  const spans: unknown[] = [];
  let resource: unknown[] | undefined;
  for (const line of fs.readFileSync(file, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as ReturnType<typeof request>;
      for (const rs of r.resourceSpans ?? []) { resource ??= rs.resource?.attributes; for (const ss of rs.scopeSpans ?? []) spans.push(...(ss.spans ?? [])); }
    } catch { /* a torn last line */ }
  }
  const req = request(spans);
  if (resource) req.resourceSpans[0]!.resource.attributes = resource as never;
  return { request: req, spans: spans.length };
}
