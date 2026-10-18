import { describe, expect, it } from "vitest";
import { CONFIGS, Gateway, PROVIDERS, providerOf } from "../src/gateway/index.js";

describe("provider table", () => {
  it("names DeepSeek's API by its default URL and key variable, model after the bar", () => {
    const saved = process.env.DEEPSEEK_URL; delete process.env.DEEPSEEK_URL;
    const p = providerOf("deepseek|deepseek-flash");
    if (saved !== undefined) process.env.DEEPSEEK_URL = saved;
    expect(p).toMatchObject({ name: "deepseek", url: "https://api.deepseek.com", model: "deepseek-flash" });
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
