import { describe, expect, it } from "vitest";
import { CONFIGS, Gateway, PROVIDERS, providerOf } from "../src/gateway/index.js";

describe("provider table", () => {
  it("names DeepSeek's API by its default URL and key variable, model after the bar", () => {
    const saved = process.env.DEEPSEEK_URL; delete process.env.DEEPSEEK_URL;
    const p = providerOf("deepseek|deepseek-flash");
    if (saved !== undefined) process.env.DEEPSEEK_URL = saved;
    expect(p).toMatchObject({ name: "deepseek", url: "https://api.deepseek.com/v1", model: "deepseek-flash" });
    expect(PROVIDERS.deepseek!.keyEnv).toBe("DEEPSEEK_API_KEY");
    expect(CONFIGS["ds-flash"]!.goal).toEqual({ backend: "openai", model: "deepseek|deepseek-flash" });
  });
  it("rejects a model string without a provider", () => {
    expect(providerOf("deepseek-flash")).toHaveProperty("error");
    expect(providerOf("nobody|x")).toHaveProperty("error");
  });
  it("falls back to json_object for every service that refuses json_schema", () => {
    expect(Gateway.schemaRejected('HTTP 400: {"error":{"message":"Invalid schema for response_format"}}')).toBe(true);
    expect(Gateway.schemaRejected('HTTP 400: {"error":{"message":"This response_format type is unavailable now"}}')).toBe(true);
    expect(Gateway.schemaRejected("HTTP 429: rate limited")).toBe(false);
    expect(Gateway.schemaRejected("HTTP 503: Service temporarily unavailable")).toBe(false);
  });
});

describe("service URLs", () => {
  it("adds /v1 to a bare host and keeps a service's own version segment", async () => {
    const { versionedBase } = await import("../src/gateway/index.js");
    expect(versionedBase("https://api.deepseek.com")).toBe("https://api.deepseek.com/v1");
    expect(versionedBase("https://api.deepseek.com/v1/")).toBe("https://api.deepseek.com/v1");
    expect(versionedBase("https://ark.cn-beijing.volces.com/api/v3")).toBe("https://ark.cn-beijing.volces.com/api/v3");
    const saved = process.env.VOLCENGINE_URL; delete process.env.VOLCENGINE_URL;
    expect(providerOf("volcengine|doubao-seed-evolving")).toMatchObject({ url: "https://ark.cn-beijing.volces.com/api/v3", model: "doubao-seed-evolving" });
    if (saved !== undefined) process.env.VOLCENGINE_URL = saved;
  });
  it("a role that wants a fast answer turns reasoning off where the service has a switch", async () => {
    const { extraBodyFor } = await import("../src/gateway/index.js");
    expect(extraBodyFor("volcengine", false)).toEqual({ thinking: { type: "disabled" } });
    expect(extraBodyFor("volcengine", undefined)).toEqual({});
    expect(extraBodyFor("yy", false)).toEqual({});
  });
  it("a first judge tier is any backend:model the gateway can reach", async () => {
    const { firstTier } = await import("../src/executor/judge.js");
    expect(firstTier("openai:volcengine|doubao-seed-2-1-lite-260915", "0.8")).toEqual({ name: "first:doubao-seed-2-1-lite-260915", backend: "openai", model: "volcengine|doubao-seed-2-1-lite-260915", floor: 0.8 });
    expect(firstTier(undefined)).toBeNull();
    expect(firstTier("nonsense")).toBeNull();
  });
});
