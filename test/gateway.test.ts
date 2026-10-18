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

describe("model configurations by name or spec", () => {
  it("a CONFIGS name, or openai:<provider>|<model> for every role; anything else is unknown", async () => {
    const { configTable } = await import("../src/gateway/index.js");
    expect(configTable("ds-flash")!.goal).toEqual({ backend: "openai", model: "deepseek|deepseek-flash" });
    const t = configTable("openai:custom|my-model")!;
    expect(t.goal).toEqual({ backend: "openai", model: "custom|my-model" });
    expect(t.verify).toEqual({ backend: "openai", model: "custom|my-model" });
    expect(configTable("nonsense")).toBeNull();
    expect(PROVIDERS.custom).toEqual({ urlEnv: "CUSTOM_URL", keyEnv: "CUSTOM_API_KEY" });
  });
  it("model-check reports an unreachable model without leaking the key", async () => {
    const { modelCheck } = await import("../src/cli/app.js");
    expect(await modelCheck("no-such-config")).toEqual({ ok: false, error: "unknown config no-such-config" });
    const saved = { url: process.env.CUSTOM_URL, key: process.env.CUSTOM_API_KEY };
    process.env.CUSTOM_URL = "http://127.0.0.1:9"; process.env.CUSTOM_API_KEY = "sk-secretsecretsecret";
    const r = await modelCheck("openai:custom|m");
    expect(r.ok).toBe(false); expect(r.model).toBe("custom|m"); expect(r.error ?? "").not.toContain("secretsecret");
    if (saved.url === undefined) delete process.env.CUSTOM_URL; else process.env.CUSTOM_URL = saved.url;
    if (saved.key === undefined) delete process.env.CUSTOM_API_KEY; else process.env.CUSTOM_API_KEY = saved.key;
  }, 30_000);   // the gateway retries a connection failure a few times before giving up
});
