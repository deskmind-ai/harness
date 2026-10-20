/**
 * The frontier runtime: one model runs the whole loop (see, think, act) through tools, on pi-agent-core. Our part is
 * what the survey found no harness has (design notes docs/research/harness-survey-2026-10-18.md): the executor's guard on
 * every action, consent the app signs, a step check after every state change, and an end that needs an independent
 * verdict — in pi's hooks: beforeToolCall (stop switch, budget), afterToolCall (step check, no-progress), finishTurn
 * (no finish without a verdict).
 *
 * Tools: computer_snapshot / computer_observe / computer_act (the executor), plan (one consent for the user's objects
 * a plan names), fs_* (the file capabilities, same ownership rule), ask_user, answer, read_skill, finish.
 */
import { Type, type Static, type TSchema, type Message } from "@earendil-works/pi-ai";
import { compact } from "./compact.js";
import { T, type Lang } from "./text.js";
import type { Model } from "@earendil-works/pi-ai";
import { runAgentLoop, type AgentContext, type AgentEvent, type AgentLoopConfig, type AgentTool, type AgentToolResult, type StreamFn } from "@earendil-works/pi-agent-core";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Gateway } from "../gateway/index.js";
import type { Answer, Card, CardOption } from "../orchestrator/index.js";
import type { Capability, Registry } from "../registry/capability.js";
import * as P from "../orchestrator/prompts.js";
import * as R from "../protocol/roles.js";
import type { Workspace } from "../registry/workspace.js";
import { canon, siteOf } from "../executor/consent.js";
import type { ConsentSigner } from "../executor/consent.js";
import { Executor, appName, describeAction, windowLabel } from "../executor/executor.js";
import { Crash } from "../registry/capability.js";
import { defaultJudge } from "../executor/judge.js";
import { CONSEQUENCES, NEEDS_CONSENT, higher, rank, type Action, type ActResult, type Challenge, type Consequence, type ConsentToken, type Reading, type Snapshot } from "../executor/types.js";

export interface RuntimeUser { ask(card: Card): Promise<Answer | null> | Answer | null }
/** What signs consent: the app (keychain) in production, a ConsentSigner in tests and the CLI. */
export type ConsentProvider = Pick<ConsentSigner, "forAction" | "forObject" | "forSite">;
const LOOK_ONLY = "the task is done as far as actions go; only look for evidence (computer_snapshot, computer_observe, reading files), or finish unconfirmed";
/** A URL on a card: readable (decoded), without the scheme, cut at 120 characters (the query stays visible up to there). */

/** A plan step as the model writes it; `opens`: the URLs it opens with open_window, and in which app. */
export interface PlanStepIn { purpose: string; objects: string[]; consequence: Consequence; opens?: { app: string; url: string }[] }

export interface SkillSource { candidates(raw: string): { name: string; description: string }[]; read(name: string): string | null }

export const RUNTIME_BUDGET = { tool_calls: 40, turns: 30, asks: 3, verify_retries: 2 };
export type RuntimeStatus = "succeeded" | "unconfirmed" | "failed" | "cancelled" | "environment" | "stopped";

export interface RuntimeOptions {
  task: string; raw: string;
  executor: Executor; signer: ConsentProvider; user: RuntimeUser; gateway: Gateway;
  model: { model: Model<any>; apiKey?: string; streamFn: StreamFn };
  workspace?: Workspace; registry?: Registry; skills?: SkillSource;
  budget?: Partial<typeof RUNTIME_BUDGET>;
  onEvent?: (kind: string, body: Record<string, unknown>) => void;
  signal?: AbortSignal;
  /** The language of what the user reads on cards (default zh). */
  lang?: Lang;
  /** The user's standing rules (rule-tier consent tokens the app signed), handed to the executor at begin. */
  rules?: ConsentToken[];
}

export interface RuntimeResult {
  status: RuntimeStatus; reason: string; summary: string; answer: string | null;
  counters: Record<string, number>; consents: { scope: string; object: string; consequence: Consequence }[];
  effects: string[]; verdicts: { verdict: string; reason: string }[];
  /** Shown with the result, not blocking: 「好的」, and 「撤回」 when every effect can be taken back. */
  result_card: Card | null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
export const BASE_SKILL = path.resolve(here, "..", "..", "skills", "deskmind-computer-use", "SKILL.md");
const body = (md: string) => md.replace(/^---[\s\S]*?---\s*/, "");
const J = (x: unknown) => JSON.stringify(x);
const text = (s: string): AgentToolResult => ({ content: [{ type: "text", text: s }], details: undefined });
const err = (s: string): AgentToolResult => ({ content: [{ type: "text", text: s }], details: undefined, isError: true });
/** A tool with its parameter type inferred from the schema (AgentTool<any> loses it). */
const tool = <T extends TSchema>(t: { name: string; label: string; description: string; parameters: T; execute: (id: string, p: Static<T>) => Promise<AgentToolResult> }): AgentTool<any> => t as AgentTool<any>;

const lit = <T extends string>(xs: readonly T[]) => Type.Union(xs.map((k) => Type.Literal(k)));
const ActionSchema = Type.Object({
  kind: lit(["click", "double_click", "set_value", "type", "select", "key", "scroll", "open_window", "close_window", "focus_window", "wait"] as const),
  window: Type.Optional(Type.String({ description: "窗口 id（open_window、wait 不用）" })),
  target: Type.Optional(Type.String({ description: "元素 id，来自 computer_observe" })),
  value: Type.Optional(Type.String()), text: Type.Optional(Type.String()), option: Type.Optional(Type.String()),
  chord: Type.Optional(Type.String({ description: "按键，如 cmd+s、return" })), dy: Type.Optional(Type.Number()),
  app: Type.Optional(Type.String({ description: "open_window：应用名" })), url: Type.Optional(Type.String()), ms: Type.Optional(Type.Number()),
});

/** An action the schema allows but the kind does not: said to the model, never sent to the executor (a window-less click
 *  used to reach the guard as "window:undefined" and cost the user a card). */
function checkAction(a: Action): string | null {
  const need = (k: string) => (k in a && (a as Record<string, unknown>)[k] !== undefined && (a as Record<string, unknown>)[k] !== "" ? null : `${a.kind} 需要 ${k}`);
  switch (a.kind) {
    case "wait": return need("ms");
    case "open_window": return need("app");
    case "close_window": case "focus_window": return need("window");
    case "scroll": return need("window") ?? need("dy");
    case "key": return need("window") ?? need("chord");
    case "click": case "double_click": return need("window") ?? need("target");
    case "set_value": return need("window") ?? need("target") ?? need("value");
    case "type": return need("window") ?? need("target") ?? need("text");
    case "select": return need("window") ?? need("target") ?? need("option");
    case "file": return need("capability") ?? need("args");
  }
}

export class FrontierRuntime {
  readonly counters: Record<string, number> = {};
  readonly consents: RuntimeResult["consents"] = [];
  readonly effects: string[] = [];
  readonly verdicts: RuntimeResult["verdicts"] = [];
  private tokens = new Map<string, ConsentToken>();       // object → consent from an approved plan
  /** Consents to open pages of some sites in a window (open_window with an http(s) URL): the plan's sites there
   *  (modify_user), and each host the user approved on a card after the task took in content (external) */
  private siteTokens: ConsentToken[] = [];
  /** After a verdict that only the evidence is missing: the model may look, not act (finish's lookOnly). */
  private lookOnly = false;
  /** The user's yes to one action, kept when the executor then found the screen changed (stale) and the model retries
   *  the same action: the executor still holds the token to what the user saw, so it is not asked again for nothing. */
  private retryTokens = new Map<string, ConsentToken>();
  private status: RuntimeStatus | null = null;
  /** The request as it stands: the app can change it mid-run (steer); the verdict judges against the latest. */
  raw: string;
  private steers: string[] = [];
  /** What the user answered to the model's questions: evidence for the verdict, like their words. */
  private answers: { question: string; text: string }[] = [];
  private reason = "";
  private summary = "";
  private answer: string | null = null;
  private lastSig = "";
  private repeats = 0;
  private readonly budget: typeof RUNTIME_BUDGET;
  private readonly abort = new AbortController();
  private crash: Crash | null = null;
  private readonly t: ReturnType<typeof T>;

  constructor(readonly o: RuntimeOptions) {
    this.raw = o.raw;
    this.t = T(o.lang);
    o.executor.opts.lang = o.lang ?? "zh";
    if (o.workspace && o.registry && !o.executor.opts.files) o.executor.attachFiles(o.workspace, o.registry);
    o.executor.setRequest(o.raw);
    if (!o.executor.opts.judge) o.executor.opts.judge = defaultJudge(o.gateway, (k, b) => this.emit(k, b));
    this.budget = { ...RUNTIME_BUDGET, ...(o.budget ?? {}) };
    o.signal?.addEventListener("abort", () => this.stop("the app stopped the task"));
  }

  private count(k: string, by = 1) { this.counters[k] = (this.counters[k] ?? 0) + by; }
  private emit(kind: string, b: Record<string, unknown> = {}) { this.o.onEvent?.(kind, b); }

  /** The user changed what they want mid-run (the protocol's steer): the new words replace the request for every
   *  later judgement, and the model hears them before its next turn. Effects so far stay. */
  steer(raw: string) {
    this.raw = raw;
    this.o.executor.setRequest(raw);
    this.steers.push(raw);
    this.count("steers");
    this.emit("steer", { raw });
  }

  /** The app's stop: the executor refuses every later action, and the loop is aborted. */
  stop(why = "stopped") { this.o.executor.stop(); if (!this.status) { this.status = "stopped"; this.reason = why; } this.abort.abort(); }

  /** What `f` gives, unless the app stops the task first: then null at once, without waiting for it (a card the user
   *  is answering, a driver's look that may take minutes). `f` is not started at all once stopped. */
  private untilStopped<T>(f: () => Promise<T>): Promise<T | null> {
    const stop = this.abort.signal;
    if (stop.aborted) return Promise.resolve(null);
    const p = f();
    // left behind at a stop, it may still fail (the driver's process is killed at the end): nobody waits for it then
    p.catch(() => undefined);
    return Promise.race([p, new Promise<null>((r) => stop.addEventListener("abort", () => r(null), { once: true }))]);
  }

  private end(status: RuntimeStatus, reason: string): AgentToolResult {
    // a stop is final: the card it cancelled comes back unanswered, and that is not a failure of its own
    if (this.status !== "stopped") { this.status = status; this.reason = reason; }
    return { ...text(`结束：${status}（${reason}）`), terminate: true };
  }

  // --- consent -------------------------------------------------------------------------------------------------------
  private async askCard(card: Card): Promise<{ option: CardOption | null; text: string } | null> {
    this.count("cards"); this.count(`cards:${card.kind}`);
    this.emit("card", { kind: card.kind, text: card.text, options: card.options.map((o) => o.kind) });
    // the stop does not wait for the card: an open card is left unanswered and the run ends (review of #16)
    const a = await this.untilStopped(() => Promise.resolve(this.o.user.ask(card)));
    if (a === null) return null;
    if ("option" in a) { const o = card.options[a.option]; return o ? { option: o, text: o.text } : null; }
    return { option: null, text: a.text };
  }

  /** The user is asked for this one action; a yes becomes a signed, single-use token. */
  private async consentFor(c: Challenge): Promise<ConsentToken | "declined" | "cancel" | null> {
    const card: Card = { kind: "action", text: c.text, free_text: false, blocking: true, options: [{ kind: "approve", text: this.t.ok }, { kind: "skip_step", text: this.t.skipStep }, { kind: "cancel", text: this.t.cancel }] };
    const got = await this.askCard(card);
    this.emit("consent.asked", { object: c.object, consequence: c.consequence, picked: got?.option?.kind ?? null });
    if (!got) return null;
    if (got.option?.kind === "approve") {
      // a host asked about after the task took in content: the yes is for that site for the rest of the task
      if (c.site) { const t = this.o.signer.forSite(c.object, [c.site], this.o.task, c.consequence); this.siteTokens.push(t); this.consents.push({ scope: "site", object: c.object, consequence: c.consequence }); return t; }
      const t = this.o.signer.forAction(c); this.consents.push({ scope: "action", object: c.object, consequence: c.consequence }); return t;
    }
    if (got.option?.kind === "cancel") return "cancel";
    this.count("declined");
    return "declined";
  }

  /** A declined card is an answer the model has to work with; asking for consent over and over is not (the asks
   *  budget bounds it, as it bounds questions). */
  private declined(msg: string): AgentToolResult {
    if ((this.counters["declined"] ?? 0) >= this.budget.asks) return this.end("failed", "the user declined repeatedly");
    return err(msg);
  }

  // --- tools ---------------------------------------------------------------------------------------------------------
  private tools(): AgentTool<any>[] {
    const ex = this.o.executor, ws = this.o.workspace, reg = this.o.registry;
    const tools: AgentTool<any>[] = [];
    tools.push(tool({
      name: "computer_snapshot", label: "看整台电脑", description: "整台电脑的状态：锁屏没有、最前面的应用、所有窗口（id、应用、标题、归谁 owner、浏览器标签页）。只读。",
      parameters: Type.Object({}), execute: async () => text(J(await ex.snapshot())),
    }));
    tools.push(tool({
      name: "computer_observe", label: "看一个窗口", description: "一个窗口的元素（id、角色、标签、值、能做的动作）、弹窗、文字。只读。动作要用这里的元素 id 和 epoch。",
      parameters: Type.Object({ window: Type.String() }),
      execute: async (_id, p: { window: string }) => { try { return text(J(await ex.observe(p.window))); } catch (e) { return err(String(e instanceof Error ? e.message : e)); } },
    }));
    tools.push(tool({
      name: "computer_act", label: "动手", description: "在界面上做一个动作。带上观察时的 epoch 和你判断的后果类别 consequence（read / create / modify_user / external；执行层只会往上调）。改用户的东西、往外发会先征得用户同意。",
      parameters: Type.Object({ action: ActionSchema, epoch: Type.Number(), consequence: lit(CONSEQUENCES), purpose: Type.String({ description: "这一步为了什么，一句话" }) }),
      execute: async (_id, p: { action: Static<typeof ActionSchema>; epoch: number; consequence: Consequence; purpose: string }) => this.act(p),
    }));
    tools.push(tool({
      name: "plan", label: "计划", description: "动手前列出步骤：目的、涉及的对象（窗口 id / 标签页 id / 文件路径）、后果类别。要碰用户的东西或往外发，必须先有计划。readings：原话里能有不止一种理解的地方，每处写你选的理解、其他理解、以及区分它们的依据（看到的东西：窗口标题、文件名、文件里的一行、用户的回答；原话本身不算）。依据不够的，程序会先问用户。程序把计划给用户过目，同意后改用户东西的步骤不再逐步打扰。某一步要用 open_window 打开网址的，在这一步的 opens 里写上应用和网址：网址可能会开在用户已有的浏览器窗口里，写上了，计划卡会一并问用户，之后打开网址就不再逐次打扰。",
      parameters: Type.Object({ steps: Type.Array(Type.Object({ purpose: Type.String(), objects: Type.Array(Type.String()), consequence: lit(CONSEQUENCES), opens: Type.Optional(Type.Array(Type.Object({ app: Type.String(), url: Type.String() }), { description: "这一步用 open_window 打开的网址：应用和网址" })) })), readings: Type.Optional(Type.Array(Type.Object({ point: Type.String(), reading: Type.String(), alternatives: Type.Array(Type.String()), evidence: Type.Array(Type.String()) }))) }),
      execute: async (_id, p: { steps: PlanStepIn[]; readings?: Reading[] }) => this.plan(p.steps, p.readings ?? []),
    }));
    tools.push(tool({
      name: "ask_user", label: "问用户", description: "只有用户知道的信息（要写什么、哪一个、放哪）才问；能自己看到的不要问。options 是从证据里拿的候选，2–6 个，可以为空。",
      parameters: Type.Object({ question: Type.String(), options: Type.Array(Type.String()) }),
      execute: async (_id, p: { question: string; options: string[] }) => {
        if ((this.counters["asks"] ?? 0) >= this.budget.asks) return err("问得太多了：先按已知的做，或者 finish 说明缺什么");
        this.count("asks");
        const card: Card = { kind: "missing", text: p.question, free_text: true, blocking: true, options: [...p.options.slice(0, 6).map((t) => ({ kind: "value" as const, text: t })), { kind: "delegate", text: this.t.delegate }, { kind: "cancel", text: this.t.cancel }] };
        const got = await this.askCard(card);
        if (!got) return this.end("failed", "no answer from the user");
        if (got.option?.kind === "cancel") return this.end("cancelled", "the user stopped the task");
        this.emit("answer", { question: p.question, text: got.text });
        this.answers.push({ question: p.question, text: got.option?.kind === "delegate" ? "由你决定" : got.text });
        // only what the user wrote themselves is theirs to send; an option the model offered is the model's text
        this.o.executor.addAnswer(p.question, got.option?.kind === "delegate" ? "由你决定" : got.text, { userWrote: !got.option });
        return text(got.option?.kind === "delegate" ? "用户说：由你决定。" : `用户回答：${got.text}`);
      },
    }));
    tools.push(tool({
      name: "answer", label: "回答", description: "把答案告诉用户（用户问的是问题时）。然后再 finish。",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_id, p: { text: string }) => { this.answer = p.text; this.emit("answer.given", { text: p.text }); return text("已记下答案。"); },
    }));
    if (this.o.skills) tools.push(tool({
      name: "read_skill", label: "读教程", description: "读一份教程的全文（开头列出的候选之一）。",
      parameters: Type.Object({ name: Type.String() }),
      execute: async (_id, p: { name: string }) => { const t = this.o.skills!.read(p.name); this.count("skills_read"); if (t) this.o.executor.addSkill(p.name, t); return t ? text(t) : err(`没有叫 ${p.name} 的教程`); },
    }));
    tools.push(tool({
      name: "finish", label: "结束", description: "结束任务。done = 做成了（程序会独立核对，没过会告诉你缺什么）；unconfirmed = 做了但确认不了；cannot = 做不到；stopped = 用户用自己的话让你停下 / 取消 / 先不做了（选项里的「先别做了」程序会自己处理，这个用于用户写在回答里的）。summary 写清楚改了什么、哪些是用户的东西、答案是什么。",
      parameters: Type.Object({ outcome: Type.Union([Type.Literal("done"), Type.Literal("unconfirmed"), Type.Literal("cannot"), Type.Literal("stopped")]), summary: Type.String(), missing: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, p: { outcome: "done" | "unconfirmed" | "cannot" | "stopped"; summary: string; missing?: string[] }) => this.finish(p),
    }));
    if (ws && reg) for (const cap of reg.list()) {
      if (cap.channel === "gui") continue;
      const props: Record<string, ReturnType<typeof Type.String>> = {};
      for (const [k, f] of Object.entries(cap.schema.properties)) props[k] = Type.String({ description: f.description });
      tools.push(tool({
        name: "fs_" + cap.id.split(".").slice(1).join("_"), label: cap.id, description: `${cap.description} 路径相对任务目录。`,
        parameters: Type.Object(props), execute: async (_id, args) => {
          // looking for evidence only: a write is refused before anything is made for it (a rewrite asks a model)
          if (this.lookOnly && cap.effect !== "observe") { this.count("refused_look_only"); return err(LOOK_ONLY); }
          const full = await this.derive(cap, args as Record<string, string>);
          if (typeof full === "string") return err(full);
          return this.act({ action: { kind: "file", capability: cap.id, args: full }, epoch: ex.currentEpoch, consequence: "read", purpose: cap.description.split("；")[0]! });
        },
      }));
    }
    return tools;
  }

  /** A value the capability needs that a model makes from the arguments (fs.transform_text: the rewritten text), asked
   *  of the `transform` role once, as the orchestrator does, and stored in the arguments with the source version it
   *  was made from — so the intent check reads it and a source changed before the write fails the precondition. */
  private async derive(cap: Capability, args: Record<string, string>): Promise<Record<string, string> | string> {
    if (!cap.derive || !this.o.workspace) return args;
    const ws = this.o.workspace;
    const bad = cap.typecheck(args) ?? cap.preconditions(ws, args);
    if (bad) return bad;
    const d = cap.derive(ws, args);
    const ctx = this.o.gateway.contextBudget("transform");
    if ([...d.source].length > ctx) return `the source is ${[...d.source].length} characters; the rewriting model reads at most about ${ctx} tokens`;
    this.count("model_calls");
    const rep = await this.o.gateway.ask("transform", P.SYSTEM, P.transformPrompt(this.raw, d.instruction, d.source), R.TransformAnswer, this.o.task);
    this.emit("transform", { cap: cap.id, outcome: rep.outcome, error: rep.error.slice(0, 200) });
    if (rep.outcome !== "answered") return `the rewrite could not be made (${rep.outcome}: ${rep.error.slice(0, 200)})`;
    return { ...args, ...(d.also ?? {}), [d.field]: rep.data!.text };
  }

  private async act(p: { action: Static<typeof ActionSchema> | Extract<Action, { kind: "file" }>; epoch: number; consequence: Consequence; purpose: string }): Promise<AgentToolResult> {
    const a = p.action as unknown as Action;
    const bad = checkAction(a);
    if (bad) return err(bad);
    // looking for evidence only: a wait or a file read; nothing that changes something or brings an app forward
    if (this.lookOnly && !(a.kind === "wait" || (a.kind === "file" && this.o.executor.preview({ action: a, epoch: p.epoch, consequence: "read" }).consequence === "read"))) {
      this.count("refused_look_only");
      return err(LOOK_ONLY);
    }
    // the plan's object token for what the action touches goes along whatever the class: act settles the class itself
    // (the judge is asked only after its own checks that the action is current) and asks for a card when the token
    // does not cover it — a send is never covered by one. Choosing by a class guessed here either paid the judge on
    // stale actions or, by the old send hints, left the token behind for a site search the judge clears
    const pre = this.o.executor.preview({ action: a, epoch: p.epoch, consequence: p.consequence });
    // a URL of a site consented to there (the plan's, or a host approved on a card): that consent, the highest class
    // first; anything else there, the plan's object consent if it named the window — the executor checks either
    const host = a.kind === "open_window" && a.url ? siteOf(a.url) : null;
    const opening = host ? this.siteTokens.filter((t) => t.object === pre.object && t.hosts?.includes(host)).sort((x, y) => rank(y.consequence) - rank(x.consequence))[0] : undefined;
    const consent = this.retryTokens.get(canon(a)) ?? opening ?? this.tokens.get(pre.object);
    let r: ActResult;
    try { r = await this.o.executor.act({ action: a, epoch: p.epoch, consequence: p.consequence, purpose: p.purpose, consent }); }
    catch (e) { if (e instanceof Crash) { this.crash = e; this.abort.abort(); return { ...text("crash"), terminate: true }; } throw e; }
    if (r.status === "needs_consent" && r.challenge) {
      const t = await this.consentFor(r.challenge);
      if (t === null) return this.end("failed", "no answer from the user");
      if (t === "cancel") return this.end("cancelled", "the user stopped the task");
      if (t === "declined") return this.declined(`用户不同意这一步：${r.challenge.text}。换一种不需要它的做法，或者 finish 说明。`);
      r = await this.o.executor.act({ action: a, epoch: r.epoch, consequence: p.consequence, purpose: p.purpose, consent: t });
      if (r.status === "stale") this.retryTokens.set(canon(a), t);
    }
    if (r.status !== "stale" && r.status !== "needs_consent") this.retryTokens.delete(canon(a));
    // a stale action did nothing: the window moved on after the model looked. It is looked at again here, so the model
    // decides on what is there now (its epoch, its element ids) — told only "observe again", models retried the same
    // click on the old look until the run gave up (rc.6 end to end)
    // Not after the app's stop: the run ends there, not after a look a real driver may take minutes over (review of #24)
    let relooked = false;
    if (r.status === "stale" && "window" in a && a.window) {
      const win = a.window;
      try { const fresh = await this.untilStopped(() => this.o.executor.observe(win)); if (fresh) { r = { ...r, after: fresh }; relooked = true; } } catch { /* gone or unreadable: the why says so */ }
    }
    this.count("actions"); this.count(`actions:${r.status}`);
    const cap = a.kind === "file" ? this.o.registry?.get(a.capability) : undefined;
    if (a.kind === "file") this.emit("fs.act", { cap: a.capability, args: a.args, status: r.status, consequence: r.consequence, why: r.why ?? "" });
    if (r.status === "ok" && rank(r.consequence) >= rank("create")) this.effects.push(a.kind === "file" ? describeAction(a, undefined, r.consequence, cap) : `${p.purpose}：${describeAction(a, r.after, r.consequence)}`);
    if (r.status === "needs_plan") {
      this.count("needs_plan");
      // a URL that would land in the user's browser window: say how the plan covers it (structure, not the words)
      const hint = a.kind === "open_window" && a.url ? `\n这个网址会开在用户已有的 ${a.app} 窗口里：在计划里打开网址的那一步写上 opens: [{ app: "${a.app}", url: "…" }]，计划卡会一并问用户。任务读过文件、看过任务目录里文件的开头，或者输入过用户没写的字以后，打开还没同意过的网站仍会单独问。` : "";
      return err(`先交计划：${r.why}${hint}`);
    }
    // the judge's "not what the user asked": the way out is the user's answer, never another guess
    if (r.status === "refused" && (r.why ?? "").includes("意图核对")) { this.count("refused_by_judge"); return err(`${r.why}
不确定用户想怎么做的，用 ask_user 问清楚（给出几种做法当选项），不要换一种猜法再试。`); }
    if (r.status === "environment") return this.end("environment", r.why ?? "environment");
    if (r.status === "stopped") return this.end("stopped", r.why ?? "stopped");
    const { after, challenge: _c, ...rest } = r;
    if (a.kind === "file") return r.status === "ok" ? text(J({ status: "ok", output: r.output ?? {}, consequence: r.consequence })) : err(J({ status: r.status, why: r.why, consequence: r.consequence }));
    const view = { ...rest, ...(after ? { after: { epoch: after.epoch, window: after.window, modal: after.modal, elements: after.elements, text: after.text } } : {}) };
    // the step check: a state change with nothing visibly changed is said so, in the result the model reads
    const noChange = r.status === "ok" && rank(r.consequence) >= rank("create") && r.changed && r.changed.elements === 0 && !r.changed.new_windows?.length;
    // a stale result did nothing: the screen moved under the action, which is not the model going round in circles
    if (r.status !== "stale") {
      const sig = canon({ a, after: after?.elements.map((e) => [e.id, e.value ?? ""]) ?? null });
      this.repeats = sig === this.lastSig ? this.repeats + 1 : 0; this.lastSig = sig;
    }
    const notes = [...(relooked ? ["注意：这一步没有执行——界面在你决定之后变了。after 是刚重新看的这个窗口（新的 epoch 和元素 id），按它重新决定，不要照旧重试。"] : []), ...(noChange ? ["注意：这一步做了，但界面上没有任何变化；预期的变化没出现就换个办法。"] : []), ...(this.repeats >= 1 ? ["注意：同一个动作在同一个界面上重复了，没有进展（原地打转）。换别的路，或者问用户。"] : [])];
    if (this.repeats >= 3) return this.end("failed", "no progress: the same action on an unchanged screen");
    return { ...(r.status === "ok" || r.status === "unverified" ? text(J(view)) : err(J(view))), ...(notes.length ? { content: [{ type: "text", text: J(view) + "\n" + notes.join("\n") }] } : {}) };
  }

  private async plan(steps: PlanStepIn[], readings: Reading[]): Promise<AgentToolResult> {
    this.count("plans");
    this.emit("plan", { steps, readings });
    // the start gate: readings the judge cannot settle are the user's to settle, one card each, before anything else
    let settled = readings;
    for (;;) {
      const v = await this.o.executor.plan({ steps, readings: settled });
      if (v.accepted) break;
      const r = v.open[0]!;
      this.count("asks");
      const card: Card = { kind: "ambiguity", text: this.t.ambiguity(r.point), free_text: true, blocking: true, options: [
        ...[r.reading, ...r.alternatives].map((t) => ({ kind: "reading" as const, text: t })), { kind: "delegate", text: this.t.delegate }, { kind: "cancel", text: this.t.cancel }] };
      const got = await this.askCard(card);
      if (!got) return this.end("failed", "no answer from the user");
      if (got.option?.kind === "cancel") return this.end("cancelled", "the user stopped the task");
      const chosen = got.option?.kind === "reading" ? got.text : got.option?.kind === "delegate" ? r.reading : null;
      this.emit("reading.settled", { point: r.point, reading: chosen ?? got.text, by: got.option?.kind ?? "words" });
      this.answers.push({ question: this.t.ambiguity(r.point), text: chosen ?? got.text });     // the judges read it like any answer
      this.o.executor.addAnswer(this.t.ambiguity(r.point), chosen ?? got.text, { userWrote: chosen === null });
      if (chosen === null) return text(`用户对「${r.point}」的回答：${got.text}。按这个重新理解，再交一次计划。`);
      settled = settled.map((x) => (x === r ? { ...x, reading: chosen, alternatives: [], evidence: [`用户的回答：${chosen}`] } : x));
    }
    // what each step touches, by the executor's own view rather than the class the model wrote: a step on a window or a
    // file that is the user's changes the user's things, whatever the model declared (a real run wrote "create" for the
    // music app's window the executor counted as the user's, so no plan card was shown and every step asked on its own
    // card — 「打开网易云播放安溥的宝贝」, 10-20). A declared external stays external; sending still asks per action
    // only looks: nothing to ask, nothing to resolve
    if (steps.every((s) => s.consequence === "read" && !s.opens?.length)) return text("计划记下了；这些步骤不需要用户同意，直接做。");
    const snap = await this.o.executor.snapshot();           // one look for the whole plan
    // a URL a step opens lands where the executor's floor for that open_window says: in the user's browser window when
    // the app has one (「搜索今天北京天气」, rc.10: nine cards for nine pages in the user's Chrome). That window is one
    // of the step's objects, by the executor's view — listed on the card with the sites it opens, and covered by a
    // consent to open pages of those sites there, nothing else (not the whole window: review of #33). An open the
    // floor calls a send (a new host after the task took in content) is not covered here: it asks on its own card
    const opensInto = steps.map((s) => {
      const into = new Map<string, Set<string>>();
      for (const o of s.opens ?? []) {
        const f = this.o.executor.floor({ kind: "open_window", app: o.app, url: o.url });
        // the site (http or https; the full hostname): another subdomain asks on its own
        const host = siteOf(o.url);
        if (host && f.consequence === "modify_user" && f.object.startsWith("window:")) { const hs = into.get(f.object) ?? new Set<string>(); hs.add(host); into.set(f.object, hs); }
      }
      return into;
    });
    const objectsOf = await Promise.all(steps.map((s) => this.canonObjects(s.objects, snap)));
    // only what is there: a window or tab on screen, a file in the task folder (a raw "window:…" the model wrote that names
    // nothing would otherwise be called the user's by the ledger and signed — review of #31)
    const there = new Set([...snap.windows.flatMap((w) => [`window:${w.id}`, ...(w.tabs ?? []).map((t) => `tab:${t.id}`)]), ...(this.o.workspace ? Object.keys(this.o.workspace.entries()).map((p) => `path:${p}`) : [])]);
    const theirs = (o: string) => there.has(o) && this.o.executor.ledger.ownerOf(o) === "user";
    // a step declared "read" stays a look (the floor of looking is read; an action it turns into asks on its own)
    // (a URL opened into the user's window is no look, whatever the step was declared)
    const classes = steps.map((s, i) => (s.consequence === "external" ? s.consequence : [...opensInto[i]!.keys()].some(theirs) ? higher(s.consequence, "modify_user") : s.consequence === "read" ? s.consequence : objectsOf[i]!.some(theirs) ? higher(s.consequence, "modify_user") : s.consequence));
    const signFor = [...new Set(objectsOf.flatMap((os, i) => (classes[i] === "read" ? [] : os.filter(theirs))))];
    // an app the hands driver can only operate in front: hands#54 lists bundle ids on the snapshot (`needs_foreground`,
    // known once the app was observed or brought forward), matched against a window's app or its id's "bundle#" prefix;
    // a per-window flag is read too. Said plainly on the card, and in the trace
    const named = new Set([...objectsOf.flat(), ...opensInto.flatMap((m) => [...m.keys()])]);
    // pages to open, per user's window, across the plan: one consent each, for those sites
    const openGrants = new Map<string, Set<string>>();
    for (const m of opensInto) for (const [w, hs] of m) if (theirs(w)) { const g = openGrants.get(w) ?? new Set<string>(); for (const h of hs) g.add(h); openGrants.set(w, g); }
    const fgList = (snap.needs_foreground ?? []).map((b) => b.toLowerCase());
    const inFront = (w: { id: string; app: string; needs_foreground?: boolean }) => !!w.needs_foreground || fgList.some((b) => b === w.app.toLowerCase() || w.id.toLowerCase().startsWith(b + "#"));
    const fgApps = [...new Set(snap.windows.filter((w) => named.has(`window:${w.id}`) && inFront(w)).map((w) => appName(w)))];
    if (fgApps.length) this.emit("plan.foreground", { apps: fgApps });
    this.emit("plan.classes", { declared: steps.map((s) => s.consequence), settled: classes, objects: signFor, opens: Object.fromEntries([...openGrants].map(([w, h]) => [w, [...h]])) });
    if (!classes.some((c) => NEEDS_CONSENT.has(c))) return text("计划记下了；这些步骤不需要用户同意，直接做。");
    // a step that sends from the user's window also changes the user's things on the way (the row picked, the reply
    // opened, the body filled): the card says both, and only what the card says changes the user's things is signed
    // (review of #31: 「回复并发送」 signed the mail window under a line that said only 「会发出去」)
    const mine = (i: number) => objectsOf[i]!.some(theirs);
    // the objects as the user knows them, from the snapshot — the app and its window's title, a tab's title and site, a
    // file's path in the task folder — not the model's words (「窗口 com.netease.163music#30144」 told the user nothing,
    // review of #31); what did not resolve is shown as the model wrote it, and is not signed
    // only what resolved to a window, a tab or a file appears on the card: an element id (ocr:26, elem_12) or words that
    // name nothing tell the user nothing, and sign nothing (owner's run run_ac5345ce: 「…main window、ocr:26」)
    const shown = (o: string): string | null => {
      const id = o.slice(o.indexOf(":") + 1);
      if (o.startsWith("window:")) { const w = snap.windows.find((x) => x.id === id); if (w) return windowLabel(w, this.o.lang); }
      if (o.startsWith("tab:")) for (const w of snap.windows) { const t = w.tabs?.find((x) => x.id === id); if (t) { let site = ""; try { site = new URL(t.url).host; } catch { /* no site */ } return `「${t.title}」${site ? `（${site}）` : ""}`; } }
      if (o.startsWith("path:") && there.has(o)) return id;
      return null;
    };
    const listed = steps.map((_s, i) => [
      ...objectsOf[i]!.map(shown).filter((x): x is string => x !== null),
      ...[...opensInto[i]!].filter(([w]) => theirs(w)).map(([w, us]) => this.t.openInYours(appName(snap.windows.find((x) => `window:${x.id}` === w)!), [...us])),
    ]);
    const lines = steps.map((s, i) => `${i + 1}. ${s.purpose}${listed[i]!.length ? "（" + listed[i]!.join("、") + "）" : ""}${classes[i] === "modify_user" ? this.t.modifyYours : classes[i] === "external" ? (mine(i) ? this.t.modifyAndExternal : this.t.external) : ""}`);
    const card: Card = { kind: "plan", text: `${this.t.planTitle}\n${lines.join("\n")}${fgApps.length ? "\n" + this.t.foreground(fgApps) : ""}\n${this.t.planAsk}`, free_text: true, blocking: true, options: [{ kind: "approve", text: this.t.okPlan }, { kind: "cancel", text: this.t.cancel }] };
    const got = await this.askCard(card);
    if (!got) return this.end("failed", "no answer from the user");
    if (got.option?.kind === "cancel") return this.end("cancelled", "the user stopped the task");
    if (!got.option) return text(`用户没有同意，而是说：${got.text}。按这个改计划。`);
    // the user's objects the plan names, by the executor's view: covered up to modify_user (never a send). An object the
    // plan does not name is not covered: an action on it asks on its own card
    for (const obj of signFor) {
      const t = this.o.signer.forObject(obj, "modify_user", this.o.task);
      this.tokens.set(obj, t);
      this.consents.push({ scope: "object", object: obj, consequence: "modify_user" });
    }
    for (const [obj, hosts] of openGrants) {
      const t = this.o.signer.forSite(obj, [...hosts], this.o.task, "modify_user");
      this.siteTokens.push(t);
      this.consents.push({ scope: "site", object: obj, consequence: "modify_user" });
    }
    this.emit("plan.confirmed", { objects: [...this.tokens.keys()], opens: Object.fromEntries([...openGrants].map(([w, h]) => [w, [...h]])) });
    return text("用户同意了计划。改用户东西的步骤可以做了；往外发的步骤到时候会再确认一次。");
  }

  /** The objects a plan names, in the executor's own terms: a model writes 「窗口 editor-1（用户的编辑器）」 or a bare
   *  path; the consent has to be keyed by `window:<id>` / `tab:<id>` / `path:<p>` or it covers nothing. Matched
   *  against the ids on screen and the files in the folder, by structure, never by meaning. */
  private async canonObjects(objects: string[], given?: Snapshot): Promise<string[]> {
    const snap = given ?? await this.o.executor.snapshot();
    const ids = snap.windows.flatMap((w) => [`window:${w.id}`, ...(w.tabs ?? []).map((t) => `tab:${t.id}`)]);
    const paths = this.o.workspace ? Object.keys(this.o.workspace.entries()).map((p) => `path:${p}`) : [];
    const out = new Set<string>();
    const bare = (k: string) => k.slice(k.indexOf(":") + 1);
    for (const o of objects) {
      const keys = [...ids, ...paths];
      // an exact name is the object; a name inside the model's words counts only when it is the one name there (a
      // name inside another hit's name is that hit: "a.txt" in "data.txt"). Several names are ambiguous and sign
      // nothing — the step asks on its own when it comes (review of #16: path:data.txt also signed a.txt)
      const exact = keys.filter((k) => o === k || o === bare(k));
      const within = keys.filter((k) => o.includes(bare(k)));
      const hits = exact.length ? exact : within.filter((k) => !within.some((x) => x !== k && bare(x).includes(bare(k))));
      if (hits.length === 1 || (exact.length && hits.length)) hits.forEach((h) => out.add(h));
      else { if (hits.length > 1) this.emit("plan.ambiguous_object", { object: o, matches: hits }); out.add(o); }
    }
    return [...out];
  }

  private async finish(p: { outcome: "done" | "unconfirmed" | "cannot" | "stopped"; summary: string; missing?: string[] }): Promise<AgentToolResult> {
    this.summary = p.summary;
    this.emit("finish.claimed", { outcome: p.outcome, summary: p.summary, missing: p.missing ?? [] });
    if (p.outcome === "cannot") return this.end("failed", "cannot: " + p.summary.slice(0, 200));
    // the user said stop in their own words (a card's free text): the run is cancelled like a picked "先别做了" — not a
    // success, so there is nothing to verify and nothing to gain by claiming it (doubao ended three such runs "done")
    if (p.outcome === "stopped") return this.end("cancelled", "the user stopped the task: " + p.summary.slice(0, 200));
    if (p.outcome === "unconfirmed") return this.end("unconfirmed", (p.missing ?? []).join("; ") || p.summary.slice(0, 200));
    // "done" is a claim: the verdict comes from an independent judge reading the final state the executor hands over
    const v = await this.verify(p.summary);
    this.verdicts.push(v);
    // a judge tier that answers without words (DeskMind Brain's system one) still gets named, so the app's history
    // never shows an empty "verified:"
    if (v.verdict === "pass") return this.end("succeeded", "verified: " + (v.reason.trim() || `by ${v.by ?? "judge"}`).slice(0, 200));
    this.count("verify_failed");
    // done as far as actions go, only the evidence is missing (the judge says so in the verdict's answer, not in words we
    // read): from here the model may only look — clicking a screen-read app for evidence brought it to the front again
    // and again until the owner stopped the run (run_ac5345ce). A verdict that something is still to do lifts it
    this.lookOnly = v.verdict === "unknown" && v.missing_kind === "evidence";
    if ((this.counters["verify_failed"] ?? 0) > this.budget.verify_retries) return this.end("unconfirmed", this.lookOnly ? this.t.checkYourself(v.reason.slice(0, 200)) : `verification did not pass: ${v.reason.slice(0, 200)}`);
    if (this.lookOnly) return err(`核对没有通过（unknown，缺的是证据）：${v.reason}\n该做的动作已经做完了。接下来只能看：computer_snapshot、computer_observe、读文件，找能证明结果的东西；找不到就 finish unconfirmed，说明缺什么。不要再点、输入、切换或打开窗口。`);
    return err(`核对没有通过（${v.verdict}）：${v.reason}\n没做成就接着做；确认不了就 finish unconfirmed 并说明缺什么。不要再直接说 done。`);
  }

  /** The independent verdict: the computer and files after, every window the task touched, what it did, its claim. */
  private async verify(summary: string): Promise<{ verdict: string; reason: string; by?: string; missing_kind?: "action" | "evidence" }> {
    this.count("model_calls");
    const v = await this.o.executor.verdict(summary, { 本任务做过的动作: this.effects, ...(this.answers.length ? { "用户对提问的回答（和原话一样是证据）": this.answers } : {}), ...(this.answer !== null ? { 给用户的答案: this.answer } : {}) });
    return { verdict: v.verdict, reason: v.reason, by: v.by, ...(v.missing_kind ? { missing_kind: v.missing_kind } : {}) };
  }

  // --- the loop --------------------------------------------------------------------------------------------------------
  private systemPrompt(): string {
    const base = fs.existsSync(BASE_SKILL) ? body(fs.readFileSync(BASE_SKILL, "utf-8")) : "";
    const cands = this.o.skills?.candidates(this.o.raw) ?? [];
    const skills = cands.length ? "\n\n## 可能适用的教程\n" + cands.map((c) => `- ${c.name}：${c.description}`).join("\n") + "\n适用的用 read_skill 读全文。" : "";
    // the folder's absolute path too: a save sheet in an app (⌘⇧G) needs it, and the model cannot find it out otherwise
    const listing = this.o.workspace?.listing();
    // the files' first lines are shown to the model: content taken in, as much as a read (a URL can carry it out)
    if (listing?.entries.some((e) => e.preview)) this.o.executor.noteTakenIn("the task folder's listing with previews");
    const ws = this.o.workspace ? `\n\n## 任务目录\n用户选定的文件夹，文件工具的路径都相对它；它在这台电脑上的完整路径是 ${this.o.workspace.root}（应用的存储对话框里用这个）。现在的内容：${J(listing)}` : "";
    return `你是桌面助手 DeskMind。只用工具做事；每一轮要么调用工具，要么用 finish 结束。\n\n${base}${skills}${ws}`;
  }

  async run(): Promise<RuntimeResult> {
    const ex = this.o.executor;
    let snap;
    try { snap = await ex.begin(this.o.workspace ? Object.keys(this.o.workspace.entries()) : [], this.o.rules ?? []); }
    catch (e) {
      // the computer could not be read at all (hands missing, no permission): an environment stop, said as such
      this.status = "environment"; this.reason = `cannot read the computer: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
      await ex.end().catch(() => undefined);
      return this.result();
    }
    this.emit("run.start", { task: this.o.task, raw: this.o.raw, windows: snap.windows.length });
    if (snap.locked) { this.status = "environment"; this.reason = "the screen is locked"; await ex.end().catch(() => undefined); return this.result(); }
    const rec = ex.recovered;
    const recovery = rec ? `\n\n注意：上一次运行在做「${rec.text}」时中断了，${rec.finding === "happened" ? "那一步已经生效" : rec.finding === "not_happened" ? "那一步没有发生" : "不知道那一步做成没有"}。${rec.external.length ? `中断期间这些文件被别的程序改过：${rec.external.join("、")}——那些改动不是你的，不要撤销；先读一遍，再看用户的要求在现在的内容上还成不成立，拿不准就问用户。` : ""}先看现在的状态再决定，不要盲目重做。` : "";
    const context: AgentContext = {
      messages: [
        { role: "system", content: this.systemPrompt(), timestamp: Date.now() },
        { role: "user", content: `用户的要求：${this.o.raw}\n\n现在整台电脑的状态：${J(snap)}${recovery}`, timestamp: Date.now() },
      ],
      tools: this.tools(),
    };
    let turns = 0, calls = 0, nudge = false;
    const config: AgentLoopConfig = {
      model: this.o.model.model, apiKey: this.o.model.apiKey, convertToLlm: (m) => m as never, toolExecution: "sequential",
      // what the model is sent is cut to its window; the transcript keeps everything, the cut is an event
      transformContext: async (messages) => {
        const budget = Math.floor((this.o.model.model.contextWindow ?? 128_000) * 0.6);
        const { messages: out, compaction } = compact(messages as Message[], budget);
        if (compaction) { this.count("compactions"); this.emit("compaction", compaction as unknown as Record<string, unknown>); }
        return out as typeof messages;
      },
      maxRetries: 4, maxRetryDelayMs: 60_000,            // 429s when several runs share a key: pi-ai backs off
      beforeToolCall: async ({ toolCall }) => {
        if (this.status) return { block: true, reason: `已经结束：${this.status}`, terminate: true };
        calls += 1; this.count("tool_calls");
        if (calls > this.budget.tool_calls) { this.status = "failed"; this.reason = "budget: tool calls"; return { block: true, reason: "预算用完，任务到此为止", terminate: true }; }
        this.emit("tool.call", { name: toolCall.name, args: toolCall.arguments });
        return undefined;
      },
      afterToolCall: async ({ toolCall, result, isError }) => { this.emit("tool.result", { name: toolCall.name, isError, text: result.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("").slice(0, 2000) }); return undefined; },   // a re-ask on a real Mac is read from the trace: 300 cut every observation (rc.9)
      getSteeringMessages: async () => this.steers.splice(0).map((r) => ({ role: "user" as const, content: `用户改了要求，以这句为准（之前做过的不会消失，按新要求接着做或撤回）：${r}`, timestamp: Date.now() })),
      finishTurn: async (turn) => {
        turns += 1; this.count("turns");
        if (this.status) return { action: "end" };
        if (turns >= this.budget.turns) { this.status = "failed"; this.reason = "budget: turns"; return { action: "end" }; }
        if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") { this.status = this.status ?? "failed"; this.reason = this.reason || `model ${turn.message.stopReason}: ${turn.message.errorMessage ?? ""}`.slice(0, 200); return { action: "end" }; }
        // a turn that only talked: the run is not over until finish says so with a verdict behind it
        if (!turn.toolResults.length) { nudge = true; return { action: "continue" }; }
        return undefined;
      },
      prepareNextTurn: () => {
        if (!nudge) return undefined;
        nudge = false;
        return { messages: [{ role: "user", content: "请继续：用工具动手，或者用 finish 结束（done 会被核对；确认不了就 unconfirmed）。不要只说话。", timestamp: Date.now() }] };
      },
    };
    const emit = async (e: AgentEvent) => { if (e.type === "message_end" && e.message.role === "assistant") { this.count("model_calls"); const u = e.message.usage; this.count("tokens_in", u.input); this.count("tokens_out", u.output); } };
    try {
      await runAgentLoop([], context, config, emit, this.abort.signal, this.o.model.streamFn);
    } catch (e) {
      if (!this.status) { this.status = "failed"; this.reason = `loop error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200); }
    }
    if (this.crash) throw this.crash;                       // the process dies here: the journal is what survives
    if (!this.status) { this.status = "failed"; this.reason = "the model stopped without finishing"; }
    await ex.end().catch(() => undefined);
    return this.result();
  }

  /** The card shown with a result that changed something: what was done, and undo when every step has one (a file
   *  action through its capability, a window the task opened; a screen action makes the run irreversible, and the
   *  card then says so instead of offering it). */
  resultCard(): Card | null {
    if (this.status !== "succeeded" || !this.effects.length) return null;
    const u = this.o.executor.undoable();
    const options: CardOption[] = [{ kind: "approve", text: this.t.fine }];
    if (u.reversible) options.push({ kind: "undo", text: this.t.undo });
    const consented = this.consents.filter((c) => c.scope !== "action" || c.consequence === "external").map((c) => c.object);
    const rules = [...this.o.executor.consent.rulesUsed];
    const text = [this.t.did(this.effects.slice(-6)), ...(consented.length ? [this.t.changedYours([...new Set(consented)])] : []), ...(rules.length ? [this.t.byRule(rules)] : []), ...(u.reversible ? [] : [this.t.noUndo(u.steps.find((x) => !x.can)?.why ?? this.t.undoable)]),
      // undo takes the run back but leaves open what a launch brought up of the user's apps: said, not implied
      ...(u.reversible && u.steps.some((x) => x.left_open) ? [this.t.undoKeepsOpen([...new Set(u.steps.flatMap((x) => (x.left_open ? [x.left_open] : [])))])] : [])].join("\n");
    return { kind: "result", text, options, free_text: false, blocking: false };
  }

  /** The user's answer to the result card: undo takes everything back (all or nothing) and the run ends cancelled. */
  async respond(answer: Answer): Promise<{ undone: number; total: number; refused: string | null } | null> {
    const card = this.resultCard();
    if (!card || !("option" in answer)) return null;
    const pick = card.options[answer.option];
    this.emit("result.response", { picked: pick?.kind ?? null });
    if (pick?.kind !== "undo") return null;
    const u = await this.o.executor.undo();
    if (!u.refused) { this.status = "cancelled"; this.reason = "the user undid the result"; this.effects.push(`撤回了 ${u.undone} 步`); }
    else this.emit("note", { text: u.undone ? `撤回了 ${u.undone} 步后停下：${u.refused}` : `没有撤回：${u.refused}` });
    this.emit("result.undo", u);
    return u;
  }

  private result(): RuntimeResult {
    const r: RuntimeResult = { status: this.status!, reason: this.reason, summary: this.summary, answer: this.answer, counters: { ...this.counters }, consents: this.consents, effects: this.effects, verdicts: this.verdicts, result_card: this.resultCard() };
    this.emit("run.end", { status: r.status, reason: r.reason });
    return r;
  }
}

export { higher };
