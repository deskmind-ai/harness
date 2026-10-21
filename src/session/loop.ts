/**
 * One reply of the session model (docs/protocol.md 「会话（第 1 版）」): pi-agent-core's runAgentLoop over the built
 * context, with no tools (H1: the session talks; computer tasks come in H2), streaming the text as it comes.
 *
 * How it ends: done (the model finished), stopped (the caller's signal: the user's stop, the session's end),
 * truncated (the reply reached MAX_ASSISTANT_CHARS, or the model its output limit), or error — the service's failure
 * mapped to a code the app shows (key_invalid, quota, network, bad_config) by the HTTP status pi-ai reports.
 */
import { runAgentLoop, type AgentContext, type AgentEvent, type AgentLoopConfig, type StreamFn } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import { costOf, priceEstimated, redactKeys } from "../gateway/index.js";
import type { BuiltContext } from "./context.js";
import type { ErrorCode } from "./log.js";

export interface SessionModel { model: Model<any>; apiKey?: string; streamFn: StreamFn }

export interface ReplyResult {
  text: string;
  ended: "done" | "stopped" | "truncated" | "error";
  error?: { code: ErrorCode; text: string };
  /** `<provider>|<model>` of the model that answered. */
  model: string;
  /** The call, as a model_call record wants it: tokens_in is everything the model read (the prompt cache's part
   *  included, also in cache_read), cost in USD (the price table when the service says none), when it was sent and how
   *  long it took, and how many characters went with it. */
  call: { started_at: number; latency_ms: number; tokens_in: number; tokens_out: number; cache_read: number; cost_usd: number; cost_estimated?: boolean; sent_chars: number; stop: string };
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

export async function reply(o: { model: SessionModel; context: BuiltContext; signal: AbortSignal; maxChars: number; onDelta: (text: string) => void }): Promise<ReplyResult> {
  const { model } = o.model;
  const spec = `${model.provider}|${model.id}`;
  const now = Date.now();
  const messages: Message[] = [
    { role: "system", content: o.context.system, timestamp: now } as unknown as Message,
    ...o.context.messages.map((m): Message => m.role === "user"
      ? { role: "user", content: m.text, timestamp: now }
      : { role: "assistant", api: model.api, provider: model.provider, model: model.id, content: [{ type: "text", text: m.text }], stopReason: "stop", timestamp: now,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }),
  ];
  const context: AgentContext = { messages, tools: [] };
  // the caller's stop, or our own cut at maxChars
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  if (o.signal.aborted) inner.abort(); else o.signal.addEventListener("abort", onAbort, { once: true });
  let text = "", truncated = false, final: AssistantMessage | null = null;
  const config: AgentLoopConfig = {
    model, ...(o.model.apiKey ? { apiKey: o.model.apiKey } : {}), convertToLlm: (m) => m as never,
    // a chat reply should start soon: fewer and shorter retries than the task loop's
    maxRetries: 2, maxRetryDelayMs: 8_000, timeoutMs: 120_000,
    finishTurn: async () => ({ action: "end" }),
  };
  const emit = async (e: AgentEvent) => {
    if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") {
      if (truncated) return;
      let d = e.assistantMessageEvent.delta;
      if (text.length + d.length > o.maxChars) { d = d.slice(0, o.maxChars - text.length); truncated = true; inner.abort(); }
      text += d;
      if (d) o.onDelta(d);
    }
    if (e.type === "message_end" && e.message.role === "assistant") final = e.message as AssistantMessage;
  };
  const startedAt = Date.now();
  const sentChars = JSON.stringify(messages).length;
  const call = (f: AssistantMessage | null) => {
    const u = f?.usage, cacheRead = u?.cacheRead ?? 0, tokensIn = (u?.input ?? 0) + cacheRead, tokensOut = u?.output ?? 0;
    const cost = Number((u?.cost?.total || costOf(spec, tokensIn, tokensOut, cacheRead)).toFixed(9));
    return { started_at: startedAt, latency_ms: Date.now() - startedAt, tokens_in: tokensIn, tokens_out: tokensOut, cache_read: cacheRead, cost_usd: cost,
      ...(!u?.cost?.total && priceEstimated(spec, cacheRead) ? { cost_estimated: true } : {}), sent_chars: sentChars, stop: f?.stopReason ?? "none" };
  };
  try {
    await runAgentLoop([], context, config, emit, inner.signal, o.model.streamFn);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text, ended: "error", error: { code: classifyError(msg), text: scrub(msg) }, model: spec, call: call(null) };
  } finally {
    o.signal.removeEventListener("abort", onAbort);
  }
  const f = final as AssistantMessage | null;
  if (truncated) return { text, ended: "truncated", model: spec, call: call(f) };
  // the model finished: a stop that came after that does not make it a stopped reply
  if (f && f.stopReason !== "error" && f.stopReason !== "aborted") {
    // a service that sent no deltas (or fewer than the whole): the final message is the reply
    const whole = textOf(f) || text;
    const cut = whole.length > o.maxChars ? whole.slice(0, o.maxChars) : whole;
    return { text: cut, ended: f.stopReason === "length" || cut.length < whole.length ? "truncated" : "done", model: spec, call: call(f) };
  }
  if (o.signal.aborted) return { text, ended: "stopped", model: spec, call: call(f) };
  const msg = f?.errorMessage ?? "no answer";
  return { text, ended: "error", error: { code: classifyError(msg), text: scrub(msg) }, model: spec, call: call(f) };
}
