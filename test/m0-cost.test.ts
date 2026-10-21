/**
 * Review fix to M0 slice C: one definition of a model call's input tokens for the agent loop and the gateway's judges —
 * everything the model read, the prompt-cache part included (pi-ai's `usage.input` leaves it out; OpenAI-compatible
 * `prompt_tokens` counts it) — with the cache part as its own field and priced, at the input rate when no cache price is
 * known (marked estimated).
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { Gateway, costOf, priceEstimated } from "../src/gateway/index.js";
import { AgentLoop } from "../src/runtime/loop.js";
import { within, type ModelCallRecord } from "../src/otel/context.js";
import * as R from "../src/protocol/roles.js";

const model = { id: "deepseek-flash", name: "deepseek-flash", api: "openai-completions", provider: "deepseek", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as never;

/** One turn that reads 1000 tokens, 900 of them from the cache (as pi-ai reports it: input 100, cacheRead 900). */
const cachedTurn: StreamFn = ((m: any) => {
  const s = createAssistantMessageEventStream();
  const msg: AssistantMessage = { role: "assistant", api: m.api, provider: m.provider, model: m.id, usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, totalTokens: 1010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now(), content: [{ type: "text", text: "done" }] };
  queueMicrotask(() => { s.push({ type: "done", reason: "stop", message: msg }); s.end(msg); });
  return s;
}) as never;

describe("a model call's input tokens and cost, one definition", () => {
  const expected = 100 * 0.3e-6 + 900 * 0.3e-6 + 10 * 1.2e-6;      // no cache price for deepseek-flash: the input rate

  it("the agent loop counts what it read from the cache, prices it, and says the price is an estimate", async () => {
    const calls: ModelCallRecord[] = [];
    const port = { begin: async () => ({ ended: false, snapshot: { epoch: 1, locked: false, front_app: "", windows: [] }, recovered: null, workspace: null, skills: [], skillsOffered: false, files: [] }), steers: () => [], end: async () => ({}) } as never;
    await within({ onModelCall: (r) => calls.push(r) }, () => new AgentLoop({ port, raw: "x", model: { model, streamFn: cachedTurn }, budget: { turns: 1 } }).run());
    expect(calls[0]).toMatchObject({ role: "loop", tokens_in: 1000, cache_read: 900, tokens_out: 10, cost_estimated: true });
    expect(calls[0]!.cost_usd).toBeCloseTo(expected, 12);
  });

  it("the gateway reads the cache part of prompt_tokens, with the same tokens and cost", async () => {
    const server = http.createServer((_q, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: '{"choice":"a"}' }, finish_reason: "stop" }], usage: { prompt_tokens: 1000, completion_tokens: 10, prompt_cache_hit_tokens: 900 } })); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const saved = { url: process.env.DEEPSEEK_URL, key: process.env.DEEPSEEK_API_KEY };
    process.env.DEEPSEEK_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; process.env.DEEPSEEK_API_KEY = "test";
    try {
      const calls: ModelCallRecord[] = [];
      const gw = new Gateway(Object.fromEntries(R.ROLES.map((r) => [r, { backend: "openai", model: "deepseek|deepseek-flash" }])) as never);
      const rep = await within({ onModelCall: (r) => calls.push(r) }, () => gw.ask("intent", "s", "u", R.choiceAnswer(["a", "b"])));
      expect(rep.outcome).toBe("answered");
      expect(calls[0]).toMatchObject({ tokens_in: 1000, cache_read: 900, tokens_out: 10, cost_estimated: true });
      expect(calls[0]!.cost_usd).toBeCloseTo(expected, 12);
    } finally {
      process.env.DEEPSEEK_URL = saved.url; process.env.DEEPSEEK_API_KEY = saved.key;
      if (saved.url === undefined) delete process.env.DEEPSEEK_URL;
      if (saved.key === undefined) delete process.env.DEEPSEEK_API_KEY;
      server.close();
    }
  });

  it("a known cache price is used and not marked an estimate; no cache read, no estimate", () => {
    expect(costOf("deepseek|deepseek-flash", 1000, 0, 0)).toBeCloseTo(1000 * 0.3e-6, 12);
    expect(priceEstimated("deepseek|deepseek-flash", 0)).toBe(false);
    expect(priceEstimated("deepseek|deepseek-flash", 5)).toBe(true);
    expect(costOf("deepseek|deepseek-flash", 100, 0, 500)).toBeCloseTo(100 * 0.3e-6, 12);   // the cache part is part of the input
  });
});
