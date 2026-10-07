/**
 * The model gateway: one call site for every model role. The role -> model table is the only thing that changes
 * between configurations (B0-luna, B0-mix, a later local one).
 *
 * Backends: openrouter (chat completions with response_format json_schema; key from OPENROUTER_API_KEY, never
 * logged), claude_cli (`claude -p`, local development on synthetic data only), scripted (tests).
 *
 * A reply's outcome is answered | refusal | invalid | error | timeout; only `answered` carries data, and that data has
 * passed the role's zod schema. Every backend gets the same instruction with the JSON Schema text in the system
 * prompt (the Python harness learnt that the hard way: Sonnet had it, Luna did not, and Luna renamed the fields).
 */
import { spawnSync } from "node:child_process";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import type { Role } from "../protocol/roles.js";

export type Backend = "openrouter" | "claude_cli" | "scripted";
export type RoleTable = Record<Role, { backend: Backend; model: string }>;

const all = (backend: Backend, model: string): RoleTable =>
  Object.fromEntries((["goal", "plan", "bind", "intent", "choice", "skill", "verify"] as Role[]).map((r) => [r, { backend, model }])) as RoleTable;

export const CONFIGS: Record<string, RoleTable> = {
  "B0-luna": all("openrouter", "openai/gpt-6-luna"),
  "B0-mix": { ...all("openrouter", "openai/gpt-6.1-sol"), choice: { backend: "openrouter", model: "openai/gpt-6-luna" } },
  "dev-claude": all("claude_cli", "sonnet"),
};

/** USD per token (in, out); from openrouter.ai/api/v1/models on 2026-10-07, used only when a reply carries no cost. */
const PRICES: Record<string, [number, number]> = {
  "openai/gpt-6-luna": [0.1e-6, 0.5e-6],
  "openai/gpt-6.1-sol": [2e-6, 10e-6],
  "openai/gpt-6-sol": [2e-6, 10e-6],
  "anthropic/claude-sonnet-5.5": [2e-6, 10e-6],
  "anthropic/claude-opus-5.5": [4e-6, 20e-6],
};

export type Outcome = "answered" | "refusal" | "invalid" | "error" | "timeout";

export interface Reply<T = unknown> {
  outcome: Outcome;
  data?: T;
  role: Role;
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
  latencyMs: number;
  error: string;
}

export interface CallRecord {
  kind: "model.call";
  run_id: string;
  role: Role;
  backend: Backend;
  model: string;
  outcome: Outcome;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
  error: string;
  system_chars: number;
  user_chars: number;
  answer: unknown;
}

export type Scripted = (role: Role, system: string, user: string) => unknown;

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

function extractJson(text: string): unknown {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.includes("\n") ? t.slice(t.indexOf("\n") + 1) : t.slice(3);
    t = t.slice(0, t.lastIndexOf("```") >= 0 ? t.lastIndexOf("```") : undefined);
  }
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b < 0) throw new Error("no JSON object in the answer");
  return JSON.parse(t.slice(a, b + 1));
}

interface RoleStats { calls: number; tokens_in: number; tokens_out: number; cost_usd: number; latency_ms: number[]; outcomes: Record<string, number> }

export class Gateway {
  readonly table: RoleTable;
  readonly name: string;
  spentUsd = 0;
  calls = 0;
  readonly byRole = new Map<Role, RoleStats>();
  script: Scripted[] = [];

  constructor(
    config: string | RoleTable,
    private readonly opts: { log?: (r: CallRecord) => void; timeoutMs?: number; maxCostUsd?: number } = {},
  ) {
    if (typeof config === "string") {
      const t = CONFIGS[config];
      if (!t) throw new Error(`unknown config ${config}`);
      this.table = t;
      this.name = config;
    } else {
      this.table = config;
      this.name = "custom";
    }
  }

  async ask<S extends z.ZodTypeAny>(role: Role, system: string, user: string, schema: S, runId = ""): Promise<Reply<z.infer<S>>> {
    const { backend, model } = this.table[role];
    const jsonSchema = zodToJsonSchema(schema, { $refStrategy: "none" });
    const sys = `${system}\n\n只输出一个 JSON 对象，不要别的文字。字段名必须和这个 JSON Schema 完全一致（例如判别字段叫 kind 就写 kind）：\n${JSON.stringify(jsonSchema)}`;
    const base = { role, model, tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0, error: "" };
    let rep: Reply<z.infer<S>>;
    if (this.opts.maxCostUsd !== undefined && this.spentUsd >= this.opts.maxCostUsd) {
      rep = { ...base, outcome: "error", error: "budget: gateway cost cap reached" };
    } else {
      const t0 = performance.now();
      let partial: Partial<Reply> = backend === "openrouter" ? await this.openrouter(model, sys, user, jsonSchema)
        : backend === "claude_cli" ? this.claudeCli(model, sys, user)
        : this.scripted(role, sys, user);
      for (let i = 0; i < 2 && backend === "openrouter" && (partial.outcome === "error" || partial.outcome === "timeout") && !/HTTP 4/.test(partial.error ?? ""); i++) {
        await new Promise((r) => setTimeout(r, 2000));                 // transient network failure: retry, then report
        partial = await this.openrouter(model, sys, user, jsonSchema);
      }
      rep = { ...base, outcome: "error", ...partial, role, model } as Reply<z.infer<S>>;
      rep.latencyMs ||= performance.now() - t0;
      if (rep.outcome === "answered") {
        const parsed = schema.safeParse(rep.data);
        if (parsed.success) rep.data = parsed.data;
        else {
          rep.outcome = "invalid";
          rep.error = parsed.error.issues.map((i) => `$.${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 300);
          rep.data = undefined;
        }
      }
      if (!rep.costUsd && PRICES[model]) {
        const [pi, po] = PRICES[model]!;
        rep.costUsd = rep.tokensIn * pi + rep.tokensOut * po;
      }
    }
    this.spentUsd += rep.costUsd;
    this.calls += 1;
    const s = this.byRole.get(role) ?? { calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_ms: [], outcomes: {} };
    s.calls += 1; s.tokens_in += rep.tokensIn; s.tokens_out += rep.tokensOut; s.cost_usd += rep.costUsd;
    s.latency_ms.push(Math.round(rep.latencyMs));
    s.outcomes[rep.outcome] = (s.outcomes[rep.outcome] ?? 0) + 1;
    this.byRole.set(role, s);
    this.opts.log?.({
      kind: "model.call", run_id: runId, role, backend, model, outcome: rep.outcome, tokens_in: rep.tokensIn,
      tokens_out: rep.tokensOut, cost_usd: Number(rep.costUsd.toFixed(6)), latency_ms: Math.round(rep.latencyMs),
      error: rep.error.slice(0, 300), system_chars: sys.length, user_chars: user.length, answer: rep.data,
    });
    return rep;
  }

  summary() {
    const roles: Record<string, unknown> = {};
    for (const [role, s] of this.byRole) {
      const lat = [...s.latency_ms].sort((a, b) => a - b);
      roles[role] = { ...s, latency_ms: undefined, latency_p50: lat[Math.floor(lat.length / 2)] ?? 0, latency_p90: lat[Math.floor(lat.length * 0.9)] ?? 0 };
    }
    return { config: this.name, calls: this.calls, spent_usd: Number(this.spentUsd.toFixed(4)), roles };
  }

  private async openrouter(model: string, system: string, user: string, jsonSchema: unknown): Promise<Partial<Reply>> {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return { outcome: "error", error: "OPENROUTER_API_KEY not set" };
    const body = {
      model, temperature: 0,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: false, schema: jsonSchema } },
      usage: { include: true },
    };
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(OPENROUTER, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://github.com/deskmind-ai", "X-Title": "DeskMind harness" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 120_000),
      });
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return { outcome: msg.includes("Timeout") || msg.includes("abort") ? "timeout" : "error", error: msg.slice(0, 300) };
    }
    const raw = await res.text();
    const latencyMs = performance.now() - t0;
    if (!res.ok) return { outcome: "error", error: `HTTP ${res.status}: ${raw.slice(0, 300)}`, latencyMs };
    try {
      const out = JSON.parse(raw);
      const ch = out.choices[0];
      const usage = out.usage ?? {};
      const rep: Partial<Reply> = { outcome: "answered", tokensIn: usage.prompt_tokens ?? 0, tokensOut: usage.completion_tokens ?? 0, costUsd: Number(usage.cost ?? 0), latencyMs };
      if (ch.message?.refusal || ch.finish_reason === "content_filter") return { ...rep, outcome: "refusal", error: String(ch.message?.refusal ?? "content_filter").slice(0, 300) };
      rep.data = extractJson(ch.message?.content ?? "");
      return rep;
    } catch (e) {
      return { outcome: "invalid", error: `bad reply: ${e instanceof Error ? e.message : e}: ${raw.slice(0, 300)}`, latencyMs };
    }
  }

  private claudeCli(model: string, system: string, user: string): Partial<Reply> {
    const p = spawnSync("claude", ["-p", "--model", model, "--append-system-prompt", system], { input: user, encoding: "utf-8", timeout: this.opts.timeoutMs ?? 180_000 });
    if (p.error) return { outcome: (p.error as NodeJS.ErrnoException).code === "ETIMEDOUT" ? "timeout" : "error", error: p.error.message };
    if (p.status !== 0) return { outcome: "error", error: (p.stderr ?? "").slice(0, 300) };
    try {
      // the CLI reports no usage; a rough estimate, cost stays 0 (not billed here)
      return { outcome: "answered", data: extractJson(p.stdout), tokensIn: Math.round((system.length + user.length) / 2.5), tokensOut: Math.round(p.stdout.length / 2.5) };
    } catch (e) {
      return { outcome: "invalid", error: e instanceof Error ? e.message : String(e) };
    }
  }

  private scripted(role: Role, system: string, user: string): Partial<Reply> {
    const f = this.script.shift();
    if (!f) return { outcome: "error", error: "scripted gateway: no script left" };
    const out = f(role, system, user);
    const OUTCOMES = ["answered", "refusal", "invalid", "error", "timeout"];
    if (out && typeof out === "object" && "outcome" in out && "error" in out && OUTCOMES.includes((out as Reply).outcome)) return out as Partial<Reply>;
    return { outcome: "answered", data: out };
  }
}
