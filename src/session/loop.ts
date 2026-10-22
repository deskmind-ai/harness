/**
 * One reply of the session model (docs/protocol.md 「会话（第 1 版）」): pi-agent-core's runAgentLoop over the built
 * context, streaming the text as it comes. Its one tool (H2) is computer_task: a turn that calls it waits for the task
 * (the tool's execute is the host's), then the model speaks again with the result.
 *
 * How it ends: done (the model finished), stopped (the caller's signal: the user's stop, the session's end),
 * truncated (the reply reached MAX_ASSISTANT_CHARS, or the model its output limit), or error — the service's failure
 * mapped to a code the app shows (key_invalid, quota, network, bad_config) by the HTTP status pi-ai reports.
 */
import { runAgentLoop, type AgentContext, type AgentEvent, type AgentLoopConfig, type AgentTool, type StreamFn } from "@earendil-works/pi-agent-core";
import { toToolDeclaration, type AssistantMessage, type Message, type Model, type Tool } from "@earendil-works/pi-ai";
import { costOf, priceEstimated, redactKeys } from "../gateway/index.js";
import type { BuiltContext } from "./context.js";
import type { ErrorCode } from "./log.js";

export interface SessionModel { model: Model<any>; apiKey?: string; streamFn: StreamFn }

/** One model call of a reply (a reply that starts a computer task takes two or more: one per turn). tokens_in is
 *  everything the model read (the prompt cache's part included, also in cache_read), cost in USD (the price table when
 *  the service says none), when it was sent and how long it took, and how many characters went with it. */
export interface CallRecord { started_at: number; model: string; latency_ms: number; tokens_in: number; tokens_out: number; cache_read: number; cost_usd: number; cost_estimated?: boolean; sent_chars: number; stop: string; error?: string }

export interface ReplyResult {
  /** The last turn's text (a turn that called a tool handed its text to `onTurnEnd`). */
  text: string;
  ended: "done" | "stopped" | "truncated" | "error";
  error?: { code: ErrorCode; text: string };
  /** `<provider>|<model>` of the model that answered. */
  model: string;
  /** The last model call. */
  call: CallRecord;
  /** Every model call of the reply, in order. */
  calls: CallRecord[];
}

/** A service's error message as pi-ai formats it ("401 …", "429: {…}") → the code the app shows. */
export function classifyError(message: string): ErrorCode {
  const status = Number(/^\s*(\d{3})\b/.exec(message)?.[1] ?? 0);
  if (status === 401 || status === 403) return "key_invalid";
  if (status === 402 || status === 429) return "quota";
  if (status === 404) return "bad_config";
  return "network";
}

/** A service's words, cut and stripped of every key (gateway redactKeys, as modelCheck). */
export const scrub = (e: string) => redactKeys(e).replace(/\s+/g, " ").trim().slice(0, 300);

const textOf = (m: AssistantMessage) => m.content.map((c) => (c.type === "text" ? c.text : "")).join("");

/** The context as pi-ai messages: a task the model started is its tool call (computer_task) and the result. The tools
 *  are declared on the leading system message (pi-ai's transcript), so none is added mid-conversation. */
export function toMessages(context: BuiltContext, model: Model<any>, tools: Tool[] = []): Message[] {
  const now = Date.now();
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  return [
    { role: "system", content: context.system, ...(tools.length ? { toolsAdded: tools.map(toToolDeclaration) } : {}), timestamp: now } as unknown as Message,
    ...context.messages.map((m): Message => {
      if (m.role === "user") return { role: "user", content: m.text, timestamp: now };
      if (m.role === "tool") return { role: "toolResult", toolCallId: m.call_id, toolName: COMPUTER_TASK, content: [{ type: "text", text: m.text }], isError: false, timestamp: now } as Message;
      const content: AssistantMessage["content"] = [...(m.text ? [{ type: "text" as const, text: m.text }] : []), ...(m.calls ?? []).map((c) => ({ type: "toolCall" as const, id: c.id, name: COMPUTER_TASK, arguments: { goal: c.goal } }))];
      return { role: "assistant", api: model.api, provider: model.provider, model: model.id, content, stopReason: m.calls?.length ? "toolUse" : "stop", timestamp: now, usage };
    }),
  ];
}

/** DeepSeek in thinking mode refuses an assistant tool call sent back without its `reasoning_content` (HTTP 400). A
 *  call the session rebuilt from its history, or the call a /cua stands for, has none: it goes with an empty one, which
 *  the service accepts (a call made in this reply keeps its own). Only for DeepSeek: other services never see the field. */
export function reasoningBack(payload: unknown): unknown {
  const p = payload as { messages?: Record<string, unknown>[] } | null;
  if (!p || !Array.isArray(p.messages)) return undefined;
  for (const m of p.messages) if (m && m.role === "assistant" && Array.isArray(m.tool_calls) && m.reasoning_content === undefined) m.reasoning_content = "";
  return p;
}
/** DeepSeek's own service, or a DeepSeek model behind a proxy (its id names it). */
export const needsReasoningBack = (m: Model<any>) => m.provider === "deepseek" || /deepseek/i.test(m.baseUrl ?? "") || /deepseek/i.test(m.id ?? "");
/** The stream with reasoningBack on every request's payload (after the caller's own onPayload, if any), for DeepSeek. */
export function withReasoningBack(streamFn: StreamFn, model: Model<any>): StreamFn {
  if (!needsReasoningBack(model)) return streamFn;
  return (m, c, opts) => streamFn(m, c, { ...opts, onPayload: async (pl: unknown, mm: Model<any>) => reasoningBack((await opts?.onPayload?.(pl, mm)) ?? pl) } as never);
}

/** A turn that may not start: the session's model at that moment is none (`no_model`: set_config null) or one that
 *  cannot be used (its code: no_key, bad_config). No request is sent. */
export class TurnRefused extends Error { constructor(readonly code: ErrorCode, text: string) { super(text); } }

/** The session model's one tool. */
export const COMPUTER_TASK = "computer_task";

/** `tools`: the tools the model may call (H2: computer_task); a turn that calls one is followed by another turn once the
 *  tool returns. `onTurnStart(n)`: a model turn begins (n from 0); `onTurnEnd(text, calls)`: a turn's message is done —
 *  its final text and how many tool calls it made (before they run). The reply's text is the last turn's. `oneTurn`: one
 *  model turn only (its tool calls still run, so the context stays well formed). `current`: the model each turn uses,
 *  asked right before its request (the session's config can change between turns: set_config) — null is no model:
 *  that turn is not sent (TurnRefused no_model); a turn already streaming keeps the model it began with. Without it,
 *  every turn uses `model`. `onTurnEnd`'s `model` is that turn's `<provider>|<model>`. */
export async function reply(o: { model: SessionModel; context: BuiltContext; signal: AbortSignal; maxChars: number; onDelta: (text: string) => void;
  tools?: AgentTool<any>[]; onTurnStart?: (n: number) => void; onTurnEnd?: (text: string, calls: number, model: string) => void; oneTurn?: boolean; endNow?: () => boolean;
  current?: () => SessionModel | { code: ErrorCode; text: string } | null }): Promise<ReplyResult> {
  const { model } = o.model;
  // the model of the turn under way (set right before each request)
  let active = o.model;
  let spec = `${model.provider}|${model.id}`;
  const messages = toMessages(o.context, model, o.tools ?? []);
  const context: AgentContext = { messages, tools: o.tools ?? [] };
  // the caller's stop, or our own cut at maxChars
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  if (o.signal.aborted) inner.abort(); else o.signal.addEventListener("abort", onAbort, { once: true });
  let text = "", truncated = false, final: AssistantMessage | null = null, turn = 0;
  const calls: CallRecord[] = [];
  let startedAt = Date.now(), sentChars = JSON.stringify(messages).length;
  const call = (f: AssistantMessage | null): CallRecord => {
    const u = f?.usage, cacheRead = u?.cacheRead ?? 0, tokensIn = (u?.input ?? 0) + cacheRead, tokensOut = u?.output ?? 0;
    const cost = Number((u?.cost?.total || costOf(spec, tokensIn, tokensOut, cacheRead)).toFixed(9));
    return { started_at: startedAt, model: spec, latency_ms: Date.now() - startedAt, tokens_in: tokensIn, tokens_out: tokensOut, cache_read: cacheRead, cost_usd: cost,
      ...(!u?.cost?.total && priceEstimated(spec, cacheRead) ? { cost_estimated: true } : {}), sent_chars: sentChars, stop: f?.stopReason ?? "none", ...(f?.errorMessage ? { error: scrub(f.errorMessage) } : {}) };
  };
  const config: AgentLoopConfig = {
    model, ...(o.model.apiKey ? { apiKey: o.model.apiKey } : {}), convertToLlm: (m) => m as never, toolExecution: "sequential",
    // a chat reply should start soon: fewer and shorter retries than the task loop's
    maxRetries: 2, maxRetryDelayMs: 8_000, timeoutMs: 120_000,
    transformContext: async (m) => { sentChars = JSON.stringify(m).length; return m; },
    // each request: the session's model as it is now (no key ever kept from an earlier turn's service)
    prepareRequest: async () => {
      if (!o.current) return undefined;
      const m = o.current();
      if (m === null) throw new TurnRefused("no_model", "no model is set");
      if ("code" in m) throw new TurnRefused(m.code, m.text);
      active = m; spec = `${m.model.provider}|${m.model.id}`;
      return { model: m.model };
    },
    // a turn that only talked ends the reply; one that called a tool goes on once the tool returned
    // (`oneTurn`: the model speaks once, whatever it calls)
    // (`endNow`: the caller is going away — no turn after the tools)
    finishTurn: async (t) => (!o.oneTurn && !o.endNow?.() && t.message.content.some((c) => c.type === "toolCall") && !truncated ? undefined : { action: "end" }),
  };
  const emit = async (e: AgentEvent) => {
    if (e.type === "turn_start") { startedAt = Date.now(); text = ""; truncated = false; final = null; o.onTurnStart?.(turn++); }
    if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
      if (truncated) return;
      let d = e.assistantMessageEvent.delta;
      if (text.length + d.length > o.maxChars) { d = d.slice(0, o.maxChars - text.length); truncated = true; inner.abort(); }
      text += d;
      if (d) o.onDelta(d);
    }
    if (e.type === "message_end" && e.message.role === "assistant") {
      const f = e.message as AssistantMessage;
      final = f;
      calls.push(call(f));
      const n = f.content.filter((c) => c.type === "toolCall").length;
      if (n && f.stopReason === "toolUse") o.onTurnEnd?.(textOf(f) || text, n, spec);
    }
  };
  try {
    // (the turn's own service, key and DeepSeek patch: `active` is set by prepareRequest before each request)
    const stream: StreamFn = (_m, c, opts) => withReasoningBack(active.streamFn, active.model)(active.model, c, { ...opts, apiKey: active.apiKey } as never);
    await runAgentLoop([], context, config, emit, inner.signal, stream);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof TurnRefused) { const c = call(null); return { text, ended: "error", error: { code: err.code, text: scrub(msg) }, model: spec, call: c, calls }; }
    const c = call(null);
    return { text, ended: "error", error: { code: classifyError(msg), text: scrub(msg) }, model: spec, call: c, calls: [...calls, c] };
  } finally {
    o.signal.removeEventListener("abort", onAbort);
  }
  const f = final as AssistantMessage | null;
  const last = calls[calls.length - 1] ?? call(f);
  if (!calls.length) calls.push(last);
  if (truncated) return { text, ended: "truncated", model: spec, call: last, calls };
  // the model finished: a stop that came after that does not make it a stopped reply
  if (f && f.stopReason !== "error" && f.stopReason !== "aborted") {
    // a service that sent no deltas (or fewer than the whole): the final message is the reply
    const whole = textOf(f) || text;
    const cut = whole.length > o.maxChars ? whole.slice(0, o.maxChars) : whole;
    return { text: cut, ended: f.stopReason === "length" || cut.length < whole.length ? "truncated" : "done", model: spec, call: last, calls };
  }
  if (o.signal.aborted) return { text, ended: "stopped", model: spec, call: last, calls };
  const msg = f?.errorMessage ?? "no answer";
  return { text, ended: "error", error: { code: classifyError(msg), text: scrub(msg) }, model: spec, call: last, calls };
}
