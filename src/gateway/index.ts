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
import { randomUUID } from "node:crypto";
import { current as traceContext, type ModelCallRecord } from "../otel/context.js";
import { chatAttrs } from "../otel/trace.js";
import type { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { ROLES, type Role } from "../protocol/roles.js";

/**
 * openrouter   chat completions with json_schema
 * local_chat   an OpenAI-compatible chat server on this Mac (mlx_lm.server, llama.cpp): a generating local model
 * systemone    DeskMind Brain's /v1/systemone: a choice-only local model; usable for roles whose answer is one of
 *              a fixed set (choice, intent, verify). Probabilities over the options come back as `scores`.
 * claude_cli   `claude -p`, local development on synthetic data only
 * scripted     tests
 */
export type Backend = "openrouter" | "openai" | "local_chat" | "systemone" | "claude_cli" | "scripted";

/**
 * openai: any OpenAI-compatible chat-completions service with a key, named by a provider entry: the model string is
 * `<provider>|<model>` (e.g. `yy|gpt-6-luna`), the provider's URL and key come from the environment and are never
 * logged. Adding a service is one line here, not a new backend.
 */
export const PROVIDERS: Record<string, { urlEnv: string; keyEnv: string; url?: string; noThinking?: Record<string, unknown> }> = {
  yy: { urlEnv: "YY_URL", keyEnv: "YY_API_KEY" },
  openrouter: { urlEnv: "OPENROUTER_URL", keyEnv: "OPENROUTER_API_KEY", url: "https://openrouter.ai/api/v1" },
  // DeepSeek's own API: `deepseek-flash` is DeepSeek-V4.1-Flash-1017 (the API takes the family name, /v1/models lists
  // deepseek-flash and deepseek-v4-pro); it rejects json_schema, so the gateway falls back to json_object
  deepseek: { urlEnv: "DEEPSEEK_URL", keyEnv: "DEEPSEEK_API_KEY", url: "https://api.deepseek.com", noThinking: { thinking: { type: "disabled" } } },
  // Volcengine Ark (doubao): the API lives under /api/v3, not /v1 — a provider URL carries its own version segment.
  // `noThinking` is how this service turns reasoning off: a role that wants a fast answer (think: false) sends it —
  // doubao-seed-2.1-lite answered a judge question in 1.6 s without thinking, 76 s with (10-18)
  volcengine: { urlEnv: "VOLCENGINE_URL", keyEnv: "VOLCENGINE_API_KEY", url: "https://ark.cn-beijing.volces.com/api/v3", noThinking: { thinking: { type: "disabled" } } },
  // any other OpenAI-compatible service the user names in the app's settings (URL, key, model id)
  custom: { urlEnv: "CUSTOM_URL", keyEnv: "CUSTOM_API_KEY" },
  // a local OpenAI-compatible server (mlx_lm.server, llama.cpp) as the actor: the loop model needs a provider with a
  // key variable; the server ignores the key. Used by the localization experiments, not a default.
  local: { urlEnv: "LOCAL_URL", keyEnv: "LOCAL_API_KEY", url: "http://127.0.0.1:8089" },
};
/** A model configuration by name (CONFIGS) or by spec: `openai:<provider>|<model>` — every role on that model. */
export function configTable(spec: string): RoleTable | null {
  if (CONFIGS[spec]) return CONFIGS[spec]!;
  const m = /^(\w+):(.+)$/s.exec(spec);
  return m ? all(m[1] as Backend, m[2]!) : null;
}
/** The request fields a role's wish for a fast answer (`think: false`) becomes on this provider; none when the
 *  service has no switch or the role did not ask. */
export function extraBodyFor(provider: string, think: boolean | undefined): Record<string, unknown> {
  return think === false && PROVIDERS[provider]?.noThinking ? { ...PROVIDERS[provider]!.noThinking } : {};
}
/** A service base URL with its version segment: `https://host` → `https://host/v1`; `…/api/v3` stays. */
export const versionedBase = (url: string) => { const u = url.replace(/\/+$/, ""); return /\/v\d+$/.test(u) ? u : u + "/v1"; };
export function providerOf(model: string): { url: string; key: string | undefined; model: string; name: string } | { error: string } {
  const [name, ...rest] = model.split("|");
  const p = PROVIDERS[name!];
  if (!p || !rest.length) return { error: `openai backend needs <provider>|<model>; providers: ${Object.keys(PROVIDERS).join(", ")}` };
  const url = process.env[p.urlEnv] ?? p.url;
  if (!url) return { error: `${p.urlEnv} not set` };
  return { url: versionedBase(url), key: process.env[p.keyEnv], model: rest.join("|"), name: name! };
}
/** Per role, beyond backend and model: maxOutputTokens, the most it may write in one answer (sent as max_tokens);
 *  contextTokens, how much it can read; timeoutMs, how long one call may take. Unset, the backend's defaults below. */
export type RoleTable = Record<Role, { backend: Backend; model: string; maxOutputTokens?: number; contextTokens?: number; timeoutMs?: number;
  /** false: this role wants a fast plain answer (a judge's choice); providers with a reasoning switch turn it off. */
  think?: boolean }>;

/** What a backend's models can read in one call and how long a call may take, when the table does not say. The
 *  context sizes are those of the models we configure (gpt-6 family 128k, Claude 200k, local MLX models 32k); a choice-only
 *  backend reads a state but writes no text; tests (scripted) are not limited. */
const BACKEND_DEFAULTS: Record<Backend, { contextTokens: number; timeoutMs: number }> = {
  openrouter: { contextTokens: 128_000, timeoutMs: 120_000 },
  openai: { contextTokens: 128_000, timeoutMs: 120_000 },
  local_chat: { contextTokens: 32_000, timeoutMs: 300_000 },
  systemone: { contextTokens: 8_000, timeoutMs: 120_000 },
  claude_cli: { contextTokens: 200_000, timeoutMs: 180_000 },
  scripted: { contextTokens: Infinity, timeoutMs: Infinity },
};

/** Rewriting a whole document (fs.transform_text) writes far more than a decision does: it gets more time. */
const TRANSFORM_TIMEOUT_MS = 600_000;
/** What a local chat server is asked to write at most when the table does not say: a decision is short; a rewritten
 *  document (transform) can be as long as the 32k context leaves room for after reading its source. */
const LOCAL_MAX_TOKENS = 2_000, LOCAL_TRANSFORM_MAX_TOKENS = 16_000;
/** A reply the model stopped because it hit its output limit: never parsed, whatever JSON it happens to hold. */
export const TRUNCATED = "truncated: the answer hit the model's output limit";

const all = (backend: Backend, model: string): RoleTable =>
  Object.fromEntries(ROLES.map((r) => [r, { backend, model, ...(r === "transform" ? { timeoutMs: TRANSFORM_TIMEOUT_MS } : {}) }])) as RoleTable;

export const CONFIGS: Record<string, RoleTable> = {
  "B0-luna": all("openrouter", "openai/gpt-6-luna"),
  "B0-mix": { ...all("openrouter", "openai/gpt-6.1-sol"), choice: { backend: "openrouter", model: "openai/gpt-6-luna" } },
  "dev-claude": all("claude_cli", "sonnet"),
  // YY (an OpenAI-compatible gateway, cheap): the same two models the OpenRouter configs use
  "yy-luna": all("openai", "yy|gpt-6-luna"),
  "yy-sol": all("openai", "yy|gpt-6.1-sol"),
  // the same model through OpenRouter (when YY is down; same provider table, different URL and key)
  "or-luna": all("openai", "openrouter|openai/gpt-6-luna"),
  // DeepSeek V4.1 Flash (10-17 release) through DeepSeek's API: a cheap second frontier for the same comparisons
  "ds-flash": all("openai", "deepseek|deepseek-flash"),
  // doubao on Volcengine Ark: seed-evolving as the frontier; seed-2.1-lite is the fast model DeskMind Brain's system
  // one is built on — as a config it is the whole table (measurement), as a judge tier see DESKMIND_JUDGE_FIRST
  "ark-evolving": all("openai", "volcengine|doubao-seed-evolving"),
  "ark-lite": all("openai", "volcengine|doubao-seed-2-1-lite-260915"),
  // the local actor experiment (docs/localization-2026-10-19.md): the bundled Qwen2.5-7B through mlx_lm.server
  "local-qwen7b": all("openai", "local|mlx-community/Qwen2.5-7B-Instruct-4bit"),
  "local-qwen30b": all("openai", "local|mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit"),
  "yy-mix": { ...all("openai", "yy|gpt-6.1-sol"), choice: { backend: "openai", model: "yy|gpt-6-luna" }, transform: { backend: "openai", model: "yy|gpt-6-luna", timeoutMs: TRANSFORM_TIMEOUT_MS } },
};

/** `--role goal=openrouter:openai/gpt-6-luna --role choice=systemone:http://127.0.0.1:18852` on top of a config. */
export function withOverrides(base: RoleTable, overrides: string[]): RoleTable {
  const t: RoleTable = { ...base };
  for (const o of overrides) {
    const m = /^(\w+)=(\w+):(.+)$/s.exec(o);
    if (!m) throw new Error(`bad --role ${o}; expected role=backend:model`);
    const [, role, backend, model] = m;
    if (!(role! in t)) throw new Error(`unknown role ${role}`);
    // a different model for the role; what the role itself needs (the rewrite's longer time limit) stays
    const { timeoutMs } = base[role as Role];
    t[role as Role] = { backend: backend as Backend, model: model!, ...(timeoutMs ? { timeoutMs } : {}) };
  }
  return t;
}

/** The URL part of a local backend's "model" (e.g. systemone:http://127.0.0.1:18852 or local_chat:http://127.0.0.1:8080|qwen). */
const localUrl = (model: string) => model.split("|")[0]!;
const localModelName = (model: string) => model.split("|")[1] ?? "local";

/** USD per token (in, out, and in read from the service's prompt cache when its price is known); from
 *  openrouter.ai/api/v1/models on 2026-10-07, used only when a reply carries no cost. */
const PRICES: Record<string, [number, number, number?]> = {
  "openai/gpt-6-luna": [0.1e-6, 0.5e-6],
  "openai/gpt-6.1-sol": [2e-6, 10e-6],
  "openai/gpt-6-sol": [2e-6, 10e-6],
  "anthropic/claude-sonnet-5.5": [2e-6, 10e-6],
  "anthropic/claude-opus-5.5": [4e-6, 20e-6],
  // the keyed services, by their `<provider>|<model>` names: DeepSeek V4.1 Flash list price (standard hours, 10-2026);
  // doubao-seed-evolving as third-party price pages list the Ark price (no official USD page found)
  "deepseek|deepseek-flash": [0.30e-6, 1.20e-6],
  "volcengine|doubao-seed-evolving": [0.89e-6, 4.45e-6],
};

/** What a call of `model` cost in USD by the price table, for a reply that carries no cost of its own (the agent
 *  loop's model is priced here too: pi-ai's model entry says 0). 0 when the model is not in the table.
 *
 *  One definition of input tokens for every caller: `tokensIn` is everything the model read, `cacheRead` (part of it)
 *  what it read from the service's prompt cache — OpenAI-compatible `prompt_tokens` already counts that part; pi-ai's
 *  `usage.input` does not, so the agent loop adds `cacheRead` before calling this. A cache-read price the table does not
 *  know is taken at the input rate, and the cost is then an estimate (`priceEstimated`). */
export function costOf(model: string, tokensIn: number, tokensOut: number, cacheRead = 0): number {
  const priced = PRICES[model] ?? PRICES["openai/" + model.split("|").pop()!];
  if (!priced) return 0;
  const cached = Math.min(Math.max(cacheRead, 0), tokensIn);
  return (tokensIn - cached) * priced[0] + cached * (priced[2] ?? priced[0]) + tokensOut * priced[1];
}
/** The table has no cache-read price for `model` and some input came from the cache: its cost is at the input rate. */
export function priceEstimated(model: string, cacheRead: number): boolean {
  const priced = PRICES[model] ?? PRICES["openai/" + model.split("|").pop()!];
  return !!priced && cacheRead > 0 && priced[2] === undefined;
}

export type Outcome = "answered" | "refusal" | "invalid" | "error" | "timeout";

export interface Reply<T = unknown> {
  outcome: Outcome;
  data?: T;
  role: Role;
  model: string;
  tokensIn: number;
  tokensOut: number;
  /** Of tokensIn, read from the service's prompt cache (when the service says). */
  cacheRead?: number;
  costUsd: number;
  latencyMs: number;
  error: string;
}

export interface CallRecord {
  kind: "model.call";
  /** This call's id, and when it was sent (ms since the epoch): the run's trace and the app link calls by it. */
  call_id: string;
  started_at: number;
  /** The executor step and the judge question the call served, when it served one (otel/context). */
  step_id?: string;
  judge_id?: string;
  /** This call asked again after the previous one ended so (Gateway.ask). */
  retry_of?: Outcome;
  run_id: string;
  role: Role;
  backend: Backend;
  model: string;
  outcome: Outcome;
  tokens_in: number;
  tokens_out: number;
  /** Of tokens_in (everything the model read), read from the service's prompt cache. */
  cache_read: number;
  cost_usd: number;
  /** The cost took the cache-read part at the input rate (the table has no cache price for this model). */
  cost_estimated?: boolean;
  latency_ms: number;
  error: string;
  system_chars: number;
  user_chars: number;
  answer: unknown;
}

export type Scripted = (role: Role, system: string, user: string) => unknown;

const OPENROUTER = "https://openrouter.ai/api/v1/chat/completions";

/** The prompt tokens a chat-completions reply says came from the service's cache: OpenAI's
 *  `prompt_tokens_details.cached_tokens`, DeepSeek's `prompt_cache_hit_tokens`. Part of `prompt_tokens`. */
function cachedOf(usage: Record<string, any>): number {
  const n = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
  return typeof n === "number" && n > 0 ? n : 0;
}

/** The first complete JSON object in the text (models sometimes add a second object or prose after it). */
function extractJson(text: string): unknown {
  let t = text.trim();
  if (t.startsWith("```")) {
    t = t.includes("\n") ? t.slice(t.indexOf("\n") + 1) : t.slice(3);
    t = t.slice(0, t.lastIndexOf("```") >= 0 ? t.lastIndexOf("```") : undefined);
  }
  const a = t.indexOf("{");
  if (a < 0) throw new Error("no JSON object in the answer");
  let depth = 0, inStr = false, esc = false;
  for (let i = a; i < t.length; i++) {
    const c = t[i]!;
    if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return JSON.parse(t.slice(a, i + 1));
  }
  throw new Error("unbalanced JSON object in the answer");
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

  /** How much a role's model can read in one call, in tokens. A Chinese character can be a token of its own, so a
   *  text of n characters is taken to need up to n tokens. Used to refuse up front a document the model cannot even
   *  read (fs.transform_text); whether its answer was cut short is the reply's own finish reason (truncated). */
  contextBudget(role: Role): number {
    const { backend, contextTokens } = this.table[role];
    return contextTokens ?? BACKEND_DEFAULTS[backend].contextTokens;
  }

  /** How long one call of this role may take: the role's own setting, else the gateway's, else the backend's. */
  timeoutFor(role: Role): number {
    const { backend, timeoutMs } = this.table[role];
    return timeoutMs ?? this.opts.timeoutMs ?? BACKEND_DEFAULTS[backend].timeoutMs;
  }

  /** One call, asked again once when it timed out on the CLI or came back unreadable: a hung `claude -p` and a reply
   *  with broken JSON are one-off (10-16: a goal call hung 181 s; a goal reply had a missing comma), and both used to
   *  end the run. Only the cloud backends (claude_cli, openrouter): a hosted model's reply varies between calls even at
   *  temperature 0 (batching, routing across servers), and their transport fails now and then; the local server is one
   *  process decoding greedily, so the same prompt gives the same bad JSON again. A cut-off answer would be cut again.
   *  Both attempts are logged; the second says it is a retry. A retry is not counted against the run's model-call
   *  budget (the orchestrator sees one reply). */
  /** `signal`: the caller may abort the call (the judge's race: the cloud answer is no longer needed once the local
   *  tier settled); an aborted call is an error that is never retried. */
  async ask<S extends z.ZodTypeAny>(role: Role, system: string, user: string, schema: S, runId = "", signal?: AbortSignal): Promise<Reply<z.infer<S>>> {
    const first = await this.askOnce(role, system, user, schema, runId, null, signal);
    const { backend } = this.table[role];
    const again = !signal?.aborted && ((first.outcome === "timeout" && backend === "claude_cli")
      || (first.outcome === "invalid" && first.error !== TRUNCATED && (backend === "claude_cli" || backend === "openrouter" || backend === "openai")));
    return again ? this.askOnce(role, system, user, schema, runId, first.outcome, signal) : first;
  }

  private async askOnce<S extends z.ZodTypeAny>(role: Role, system: string, user: string, schema: S, runId: string, retryOf: Outcome | null, signal?: AbortSignal): Promise<Reply<z.infer<S>>> {
    const { backend, model } = this.table[role];
    const jsonSchema = zodToJsonSchema(schema, { $refStrategy: "none" });
    const sys = `${system}\n\n只输出一个 JSON 对象，不要别的文字。字段名必须和这个 JSON Schema 完全一致（例如判别字段叫 kind 就写 kind）：\n${JSON.stringify(jsonSchema)}`;
    const base = { role, model, tokensIn: 0, tokensOut: 0, costUsd: 0, latencyMs: 0, error: "" };
    const startedAt = Date.now();
    let estimated = false;
    // the call's span (otel/trace.ts): a child of the judge question or the step that asked, when the run is traced
    const traced = traceContext();
    const sp = traced.tracer?.start(`chat ${model.includes("|") ? model.split("|").slice(1).join("|") : model}`, { kind: "client" });
    let rep: Reply<z.infer<S>>;
    if (this.opts.maxCostUsd !== undefined && this.spentUsd >= this.opts.maxCostUsd) {
      rep = { ...base, outcome: "error", error: "budget: gateway cost cap reached" };
    } else {
      const t0 = performance.now();
      const timeoutMs = this.timeoutFor(role), maxTokens = this.table[role].maxOutputTokens, think = this.table[role].think;
      let partial: Partial<Reply> = backend === "openrouter" ? await this.openrouter(model, sys, user, jsonSchema, timeoutMs, maxTokens, signal)
        : backend === "openai" ? await this.openaiCompat(model, sys, user, jsonSchema, timeoutMs, maxTokens, think, signal)
        : backend === "local_chat" ? await this.localChat(model, sys, user, jsonSchema, timeoutMs, maxTokens ?? (role === "transform" ? LOCAL_TRANSFORM_MAX_TOKENS : LOCAL_MAX_TOKENS))
        : backend === "systemone" ? await this.systemone(model, system, user, jsonSchema, timeoutMs)
        : backend === "claude_cli" ? this.claudeCli(model, sys, user, timeoutMs)
        : this.scripted(role, sys, user);
      // a transient failure (network, a 5xx, or a 429 rate limit when several runs share one key) is asked again
      // with a growing pause; any other 4xx is final
      const transient = (p: Partial<Reply>) => p.outcome === "timeout" || (p.outcome === "error" && /HTTP 5|HTTP 429|fetch failed|ECONN|socket|network|EAI_AGAIN/i.test(p.error ?? ""));
      for (let i = 0; i < 4 && (backend === "openrouter" || backend === "openai") && transient(partial) && !signal?.aborted; i++) {
        await new Promise((r) => setTimeout(r, /HTTP 429/.test(partial.error ?? "") ? 5000 * (i + 1) * (i + 1) : 2000));
        partial = backend === "openrouter" ? await this.openrouter(model, sys, user, jsonSchema, timeoutMs, maxTokens, signal) : await this.openaiCompat(model, sys, user, jsonSchema, timeoutMs, maxTokens, think, signal);
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
      if (!rep.costUsd) { rep.costUsd = costOf(model, rep.tokensIn, rep.tokensOut, rep.cacheRead ?? 0); estimated = priceEstimated(model, rep.cacheRead ?? 0); }
    }
    this.spentUsd += rep.costUsd;
    this.calls += 1;
    const s = this.byRole.get(role) ?? { calls: 0, tokens_in: 0, tokens_out: 0, cost_usd: 0, latency_ms: [], outcomes: {} };
    s.calls += 1; s.tokens_in += rep.tokensIn; s.tokens_out += rep.tokensOut; s.cost_usd += rep.costUsd;
    s.latency_ms.push(Math.round(rep.latencyMs));
    s.outcomes[rep.outcome] = (s.outcomes[rep.outcome] ?? 0) + 1;
    this.byRole.set(role, s);
    const ctx = traceContext();
    const record: CallRecord = {
      kind: "model.call", call_id: `mc_${randomUUID().slice(0, 8)}`, started_at: startedAt, run_id: runId, role, backend, model, outcome: rep.outcome, tokens_in: rep.tokensIn,
      tokens_out: rep.tokensOut, cache_read: rep.cacheRead ?? 0, cost_usd: Number(rep.costUsd.toFixed(9)), ...(estimated ? { cost_estimated: true } : {}), latency_ms: Math.round(rep.latencyMs),
      error: rep.error.slice(0, 300), system_chars: sys.length, user_chars: user.length, answer: rep.data,
      ...(retryOf ? { retry_of: retryOf } : {}), ...(ctx.step_id ? { step_id: ctx.step_id } : {}), ...(ctx.judge_id ? { judge_id: ctx.judge_id } : {}),
    };
    this.opts.log?.(record);
    if (sp && traced.tracer) {
      sp.set(chatAttrs({ ...record, tier: traced.tier }));
      if (rep.outcome !== "answered") sp.fail(`${rep.outcome}: ${rep.error}`);
      traced.tracer.end(sp);
    }
    // every gateway of the run reports to the run's recorder (a judge tier's has no log of its own)
    try { ctx.onModelCall?.(record as unknown as ModelCallRecord); } catch { /* recording never fails a call */ }
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

  private async openrouter(model: string, system: string, user: string, jsonSchema: unknown, timeoutMs: number, maxTokens?: number, signal?: AbortSignal): Promise<Partial<Reply>> {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) return { outcome: "error", error: "OPENROUTER_API_KEY not set" };
    const body = {
      model, temperature: 0,
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: { type: "json_schema", json_schema: { name: "answer", strict: false, schema: jsonSchema } },
      usage: { include: true },
      ...(maxTokens ? { max_tokens: maxTokens } : {}),
    };
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(OPENROUTER, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, "HTTP-Referer": "https://github.com/deskmind-ai", "X-Title": "DeskMind harness" },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      if (signal?.aborted) return { outcome: "error", error: msg.slice(0, 300) };   // the caller let go (the judge's race)
      return { outcome: msg.includes("Timeout") || msg.includes("abort") ? "timeout" : "error", error: msg.slice(0, 300) };
    }
    let raw: string;
    try { raw = await res.text(); } catch (e) {        // aborted while the body was arriving (the judge's race)
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return { outcome: "error", error: msg.slice(0, 300), latencyMs: performance.now() - t0 };
    }
    const latencyMs = performance.now() - t0;
    if (!res.ok) return { outcome: "error", error: `HTTP ${res.status}: ${raw.slice(0, 300)}`, latencyMs };
    try {
      const out = JSON.parse(raw);
      const ch = out.choices[0];
      const usage = out.usage ?? {};
      const rep: Partial<Reply> = { outcome: "answered", tokensIn: usage.prompt_tokens ?? 0, tokensOut: usage.completion_tokens ?? 0, cacheRead: cachedOf(usage), costUsd: Number(usage.cost ?? 0), latencyMs };
      if (ch.message?.refusal || ch.finish_reason === "content_filter") return { ...rep, outcome: "refusal", error: String(ch.message?.refusal ?? "content_filter").slice(0, 300) };
      if (ch.finish_reason === "length") return { ...rep, outcome: "invalid", error: TRUNCATED };
      rep.data = extractJson(ch.message?.content ?? "");
      return rep;
    } catch (e) {
      return { outcome: "invalid", error: `bad reply: ${e instanceof Error ? e.message : e}: ${raw.slice(0, 300)}`, latencyMs };
    }
  }

  /** An OpenAI-compatible local server (mlx_lm.server): same shape as OpenRouter, no key, no cost. */
  private localChat(model: string, system: string, user: string, jsonSchema: unknown, timeoutMs: number, maxTokens: number): Promise<Partial<Reply>> {
    return this.chatCompletions(localUrl(model), undefined, localModelName(model), system, user, jsonSchema, timeoutMs, maxTokens);
  }

  /** A keyed OpenAI-compatible service (PROVIDERS): the model string names the provider. */
  private openaiCompat(model: string, system: string, user: string, jsonSchema: unknown, timeoutMs: number, maxTokens?: number, think?: boolean, signal?: AbortSignal): Promise<Partial<Reply>> {
    const p = providerOf(model);
    if ("error" in p) return Promise.resolve({ outcome: "error", error: p.error });
    if (!p.key) return Promise.resolve({ outcome: "error", error: `${PROVIDERS[p.name]!.keyEnv} not set` });
    return this.chatCompletions(p.url, p.key, p.model, system, user, jsonSchema, timeoutMs, maxTokens, extraBodyFor(p.name, think), signal);
  }

  /** Models whose service rejects our (non-strict) JSON Schema: asked for a JSON object instead, the schema stays in
   *  the system prompt and zod still validates the answer (gpt-6.1-sol behind a Responses-API proxy insists on
   *  strict schemas with every property required, which our optional fields and records are not; DeepSeek's API
   *  does not offer json_schema at all). */
  private readonly jsonObjectOnly = new Set<string>();
  static schemaRejected(error: string): boolean { return /Invalid schema|response_format|json_schema/i.test(error); }

  private async chatCompletions(url: string, key: string | undefined, model: string, system: string, user: string, jsonSchema: unknown, timeoutMs: number, maxTokens?: number, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Partial<Reply>> {
    const k = `${url}|${model}`;
    const r = await this.chatCompletionsOnce(url, key, model, system, user, this.jsonObjectOnly.has(k) ? null : jsonSchema, timeoutMs, maxTokens, extra, signal);
    if (r.outcome === "error" && r.error && Gateway.schemaRejected(r.error) && !this.jsonObjectOnly.has(k)) {
      this.jsonObjectOnly.add(k);
      return this.chatCompletionsOnce(url, key, model, system, user, null, timeoutMs, maxTokens, extra, signal);
    }
    return r;
  }

  private async chatCompletionsOnce(url: string, key: string | undefined, model: string, system: string, user: string, jsonSchema: unknown | null, timeoutMs: number, maxTokens?: number, extra: Record<string, unknown> = {}, signal?: AbortSignal): Promise<Partial<Reply>> {
    const body = { model, temperature: 0, ...extra, ...(maxTokens ? { max_tokens: maxTokens } : {}),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
      response_format: jsonSchema ? { type: "json_schema", json_schema: { name: "answer", schema: jsonSchema } } : { type: "json_object" } };
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(versionedBase(url) + "/chat/completions", { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return { outcome: msg.includes("Timeout") ? "timeout" : "error", error: msg.slice(0, 300) };
    }
    let raw: string;
    try { raw = await res.text(); } catch (e) {        // aborted while the body was arriving (the judge's race)
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return { outcome: "error", error: msg.slice(0, 300), latencyMs: performance.now() - t0 };
    }
    const latencyMs = performance.now() - t0;
    if (!res.ok) return { outcome: "error", error: `HTTP ${res.status}: ${raw.slice(0, 300)}`, latencyMs };
    try {
      const out = JSON.parse(raw);
      const usage = out.usage ?? {};
      const counts = { tokensIn: usage.prompt_tokens ?? 0, tokensOut: usage.completion_tokens ?? 0, cacheRead: cachedOf(usage), costUsd: Number(usage.cost ?? 0), latencyMs };
      const ch = out.choices[0];
      if (ch.message?.refusal || ch.finish_reason === "content_filter") return { ...counts, outcome: "refusal", error: String(ch.message?.refusal ?? "content_filter").slice(0, 300) };
      if (ch.finish_reason === "length") return { outcome: "invalid", error: TRUNCATED, ...counts };
      return { outcome: "answered", data: extractJson(ch.message.content ?? ""), ...counts };
    } catch (e) {
      return { outcome: "invalid", error: `bad reply: ${e instanceof Error ? e.message : e}: ${raw.slice(0, 300)}`, latencyMs };
    }
  }

  /**
   * DeskMind Brain (/v1/systemone): a choice-only model. The role's schema must be a single-enum answer (choice,
   * intent, verify): the enum values become the options, the state is the user prompt, and the reply carries the
   * probabilities so the orchestrator can apply a calibrated floor later.
   */
  private async systemone(model: string, system: string, user: string, jsonSchema: unknown, timeoutMs: number): Promise<Partial<Reply>> {
    const sch = jsonSchema as { properties?: Record<string, { enum?: string[] }> };
    const field = Object.entries(sch.properties ?? {}).find(([, v]) => Array.isArray(v.enum));
    if (!field) return { outcome: "error", error: "systemone backend needs a role whose answer is one enum field" };
    const [name, { enum: options }] = field;
    // criteria is a map (Brain ≥ the app's 0.3 build and pi-ai's typesafe-system-one agree; the list form was refused
    // on 10-18 with "choice criteria must be a map")
    const body = { state: user, questions: { [name]: { type: "choice", instructions: { goal: system, question: name }, criteria: Object.fromEntries(options!.map((o) => [o, o])) } } };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (process.env.DESKMIND_BRAIN_TOKEN) headers.Authorization = `Bearer ${process.env.DESKMIND_BRAIN_TOKEN}`;
    const t0 = performance.now();
    let res: Response;
    try {
      res = await fetch(localUrl(model).replace(/\/$/, "") + "/v1/systemone", { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      return { outcome: "error", error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
    }
    let raw: string;
    try { raw = await res.text(); } catch (e) {        // aborted while the body was arriving (the judge's race)
      const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return { outcome: "error", error: msg.slice(0, 300), latencyMs: performance.now() - t0 };
    }
    const latencyMs = performance.now() - t0;
    if (!res.ok) return { outcome: "error", error: `HTTP ${res.status}: ${raw.slice(0, 300)}`, latencyMs };
    try {
      const a = JSON.parse(raw).answers[name];
      if (a.scored === false) return { outcome: "invalid", error: "unscored placeholder", latencyMs };
      return { outcome: "answered", data: { [name]: a.choice, scores: a.probabilities }, latencyMs };
    } catch (e) {
      return { outcome: "invalid", error: `bad reply: ${e instanceof Error ? e.message : e}: ${raw.slice(0, 300)}`, latencyMs };
    }
  }

  private claudeCli(model: string, system: string, user: string, timeoutMs: number): Partial<Reply> {
    const p = spawnSync("claude", ["-p", "--model", model, "--append-system-prompt", system], { input: user, encoding: "utf-8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
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
