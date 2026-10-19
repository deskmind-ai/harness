/**
 * The frontier runtime's model: a pi-ai model built from the gateway's provider table (`<provider>|<model>`), so one
 * environment variable pair names a service for both the role gateway and the agent loop. Streaming, tool calls,
 * usage and abort come from pi-ai (design notes docs/research/harness-survey-2026-10-18.md §运行时和模型接口).
 */
import type { Model } from "@earendil-works/pi-ai";
import { stream as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { providerOf } from "../gateway/index.js";

export interface LoopModel { model: Model<"openai-completions">; apiKey: string; streamFn: StreamFn }

/** `yy|gpt-6-luna`, `openrouter|openai/gpt-6.1-sol`. Context window and output limit are what we configure for the
 *  gpt-6 family; a provider's own numbers can be passed in. */
export function loopModel(spec: string, o: { contextWindow?: number; maxTokens?: number } = {}): LoopModel {
  const p = providerOf(spec);
  if ("error" in p) throw new Error(p.error);
  if (!p.key) throw new Error(`no API key in the environment for provider ${p.name}`);
  const model: Model<"openai-completions"> = {
    id: p.model, name: p.model, api: "openai-completions", provider: p.name, baseUrl: p.url, input: ["text", "image"],
    // a local server (mlx_lm, llama.cpp) runs a small model with a small window: the loop's compaction budget follows it
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: o.contextWindow ?? (p.name === "local" ? 32_000 : 128_000), maxTokens: o.maxTokens ?? (p.name === "local" ? 2_000 : 8_000),
  };
  return { model, apiKey: p.key, streamFn: streamCompletions as unknown as StreamFn };
}
