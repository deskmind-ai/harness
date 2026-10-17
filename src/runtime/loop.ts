/**
 * The frontier runtime: one model runs the whole loop (see, think, act) through tools, on pi-agent-core. Our part is
 * what the survey found no harness has (openjev docs/research/harness-survey-2026-10-18.md): the executor's guard on
 * every action, consent the app signs, a step check after every state change, and an end that needs an independent
 * verdict — in pi's hooks: beforeToolCall (stop switch, budget), afterToolCall (step check, no-progress), finishTurn
 * (no finish without a verdict).
 *
 * Tools: computer_snapshot / computer_observe / computer_act (the executor), plan (one consent for the user's objects
 * a plan names), fs_* (the file capabilities, same ownership rule), ask_user, answer, read_skill, finish.
 */
import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { runAgentLoop, type AgentContext, type AgentEvent, type AgentLoopConfig, type AgentTool, type AgentToolResult, type StreamFn } from "@earendil-works/pi-agent-core";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Gateway } from "../gateway/index.js";
import type { Answer, Card, CardOption } from "../orchestrator/index.js";
import * as P from "../orchestrator/prompts.js";
import { VerifyAnswer } from "../protocol/roles.js";
import type { Registry } from "../registry/capability.js";
import type { Workspace } from "../registry/workspace.js";
import { canon } from "../executor/consent.js";
import type { ConsentSigner } from "../executor/consent.js";
import { Executor, describeAction } from "../executor/executor.js";
import { CONSEQUENCES, NEEDS_CONSENT, higher, rank, type Action, type ActResult, type Challenge, type Consequence, type ConsentToken } from "../executor/types.js";

export interface RuntimeUser { ask(card: Card): Promise<Answer | null> | Answer | null }
/** What signs consent: the app (keychain) in production, a ConsentSigner in tests and the CLI. */
export type ConsentProvider = Pick<ConsentSigner, "forAction" | "forObject">;
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
}

export interface RuntimeResult {
  status: RuntimeStatus; reason: string; summary: string; answer: string | null;
  counters: Record<string, number>; consents: { scope: string; object: string; consequence: Consequence }[];
  effects: string[]; verdicts: { verdict: string; reason: string }[];
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
  kind: lit(["click", "set_value", "type", "select", "key", "scroll", "open_window", "close_window", "focus_window", "wait"] as const),
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
    case "click": return need("window") ?? need("target");
    case "set_value": return need("window") ?? need("target") ?? need("value");
    case "type": return need("window") ?? need("target") ?? need("text");
    case "select": return need("window") ?? need("target") ?? need("option");
  }
}

export class FrontierRuntime {
  readonly counters: Record<string, number> = {};
  readonly consents: RuntimeResult["consents"] = [];
  readonly effects: string[] = [];
  readonly verdicts: RuntimeResult["verdicts"] = [];
  private tokens = new Map<string, ConsentToken>();       // object → consent from an approved plan
  private status: RuntimeStatus | null = null;
  private reason = "";
  private summary = "";
  private answer: string | null = null;
  private lastSig = "";
  private repeats = 0;
  private readonly budget: typeof RUNTIME_BUDGET;
  private readonly abort = new AbortController();

  constructor(readonly o: RuntimeOptions) {
    this.budget = { ...RUNTIME_BUDGET, ...(o.budget ?? {}) };
    o.signal?.addEventListener("abort", () => this.stop("the app stopped the task"));
  }

  private count(k: string, by = 1) { this.counters[k] = (this.counters[k] ?? 0) + by; }
  private emit(kind: string, b: Record<string, unknown> = {}) { this.o.onEvent?.(kind, b); }

  /** The app's stop: the executor refuses every later action, and the loop is aborted. */
  stop(why = "stopped") { this.o.executor.stop(); if (!this.status) { this.status = "stopped"; this.reason = why; } this.abort.abort(); }

  private end(status: RuntimeStatus, reason: string): AgentToolResult {
    this.status = status; this.reason = reason;
    return { ...text(`结束：${status}（${reason}）`), terminate: true };
  }

  // --- consent -------------------------------------------------------------------------------------------------------
  private async askCard(card: Card): Promise<{ option: CardOption | null; text: string } | null> {
    this.count("cards"); this.count(`cards:${card.kind}`);
    this.emit("card", { kind: card.kind, text: card.text, options: card.options.map((o) => o.kind) });
    const a = await this.o.user.ask(card);
    if (a === null) return null;
    if ("option" in a) { const o = card.options[a.option]; return o ? { option: o, text: o.text } : null; }
    return { option: null, text: a.text };
  }

  /** The user is asked for this one action; a yes becomes a signed, single-use token. */
  private async consentFor(c: Challenge): Promise<ConsentToken | "declined" | "cancel" | null> {
    const card: Card = { kind: "action", text: c.text, free_text: false, blocking: true, options: [{ kind: "approve", text: "可以" }, { kind: "skip_step", text: "这一步不要" }, { kind: "cancel", text: "先别做了" }] };
    const got = await this.askCard(card);
    this.emit("consent.asked", { object: c.object, consequence: c.consequence, picked: got?.option?.kind ?? null });
    if (!got) return null;
    if (got.option?.kind === "approve") { const t = this.o.signer.forAction(c); this.consents.push({ scope: "action", object: c.object, consequence: c.consequence }); return t; }
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
      name: "plan", label: "计划", description: "动手前列出步骤：目的、涉及的对象（窗口 id / 标签页 id / 文件路径）、后果类别。有「改用户的东西」或「往外发」的步骤时，程序把计划给用户过目，同意后改用户东西的步骤不再逐步打扰。",
      parameters: Type.Object({ steps: Type.Array(Type.Object({ purpose: Type.String(), objects: Type.Array(Type.String()), consequence: lit(CONSEQUENCES) })) }),
      execute: async (_id, p: { steps: { purpose: string; objects: string[]; consequence: Consequence }[] }) => this.plan(p.steps),
    }));
    tools.push(tool({
      name: "ask_user", label: "问用户", description: "只有用户知道的信息（要写什么、哪一个、放哪）才问；能自己看到的不要问。options 是从证据里拿的候选，2–6 个，可以为空。",
      parameters: Type.Object({ question: Type.String(), options: Type.Array(Type.String()) }),
      execute: async (_id, p: { question: string; options: string[] }) => {
        if ((this.counters["asks"] ?? 0) >= this.budget.asks) return err("问得太多了：先按已知的做，或者 finish 说明缺什么");
        this.count("asks");
        const card: Card = { kind: "missing", text: p.question, free_text: true, blocking: true, options: [...p.options.slice(0, 6).map((t) => ({ kind: "value" as const, text: t })), { kind: "delegate", text: "由你决定" }, { kind: "cancel", text: "先别做了" }] };
        const got = await this.askCard(card);
        if (!got) return this.end("failed", "no answer from the user");
        if (got.option?.kind === "cancel") return this.end("cancelled", "the user stopped the task");
        this.emit("answer", { question: p.question, text: got.text });
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
      execute: async (_id, p: { name: string }) => { const t = this.o.skills!.read(p.name); this.count("skills_read"); return t ? text(t) : err(`没有叫 ${p.name} 的教程`); },
    }));
    tools.push(tool({
      name: "finish", label: "结束", description: "结束任务。done = 做成了（程序会独立核对，没过会告诉你缺什么）；unconfirmed = 做了但确认不了；cannot = 做不到。summary 写清楚改了什么、哪些是用户的东西、答案是什么。",
      parameters: Type.Object({ outcome: Type.Union([Type.Literal("done"), Type.Literal("unconfirmed"), Type.Literal("cannot")]), summary: Type.String(), missing: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, p: { outcome: "done" | "unconfirmed" | "cannot"; summary: string; missing?: string[] }) => this.finish(p),
    }));
    if (ws && reg) for (const cap of reg.list()) {
      if (cap.channel === "gui") continue;
      const props: Record<string, ReturnType<typeof Type.String>> = {};
      for (const [k, f] of Object.entries(cap.schema.properties)) props[k] = Type.String({ description: f.description });
      tools.push(tool({
        name: "fs_" + cap.id.split(".").slice(1).join("_"), label: cap.id, description: `${cap.description} 路径相对任务目录。`,
        parameters: Type.Object(props), execute: async (_id, args) => this.fileAct(cap.id, args as Record<string, string>),
      }));
    }
    return tools;
  }

  private async act(p: { action: Static<typeof ActionSchema>; epoch: number; consequence: Consequence; purpose: string }): Promise<AgentToolResult> {
    const a = p.action as unknown as Action;
    const bad = checkAction(a);
    if (bad) return err(bad);
    const pre = this.o.executor.preview({ action: a, epoch: p.epoch, consequence: p.consequence });
    let consent = this.tokens.get(pre.object);
    if (consent && rank(consent.consequence) < rank(pre.consequence)) consent = undefined;
    let r = await this.o.executor.act({ action: a, epoch: p.epoch, consequence: p.consequence, purpose: p.purpose, consent });
    if (r.status === "needs_consent" && r.challenge) {
      const t = await this.consentFor(r.challenge);
      if (t === null) return this.end("failed", "no answer from the user");
      if (t === "cancel") return this.end("cancelled", "the user stopped the task");
      if (t === "declined") return this.declined(`用户不同意这一步：${r.challenge.text}。换一种不需要它的做法，或者 finish 说明。`);
      r = await this.o.executor.act({ action: a, epoch: r.epoch, consequence: p.consequence, purpose: p.purpose, consent: t });
    }
    this.count("actions"); this.count(`actions:${r.status}`);
    if (r.status === "ok" && rank(r.consequence) >= rank("create")) this.effects.push(`${p.purpose}：${describeAction(a, r.after, r.consequence)}`);
    if (r.status === "environment") return this.end("environment", r.why ?? "environment");
    if (r.status === "stopped") return this.end("stopped", r.why ?? "stopped");
    const { after, ...rest } = r;
    const view = { ...rest, ...(after ? { after: { epoch: after.epoch, window: after.window, modal: after.modal, elements: after.elements, text: after.text } } : {}) };
    // the step check: a state change with nothing visibly changed is said so, in the result the model reads
    const noChange = r.status === "ok" && rank(r.consequence) >= rank("create") && r.changed && r.changed.elements === 0 && !r.changed.new_windows?.length;
    const sig = canon({ a, after: after?.elements.map((e) => [e.id, e.value ?? ""]) ?? null });
    this.repeats = sig === this.lastSig ? this.repeats + 1 : 0; this.lastSig = sig;
    const notes = [...(noChange ? ["注意：这一步做了，但界面上没有任何变化；预期的变化没出现就换个办法。"] : []), ...(this.repeats >= 1 ? ["注意：同一个动作在同一个界面上重复了，没有进展（原地打转）。换别的路，或者问用户。"] : [])];
    if (this.repeats >= 3) return this.end("failed", "no progress: the same action on an unchanged screen");
    return { ...(r.status === "ok" || r.status === "unverified" ? text(J(view)) : err(J(view))), ...(notes.length ? { content: [{ type: "text", text: J(view) + "\n" + notes.join("\n") }] } : {}) };
  }

  private async plan(steps: { purpose: string; objects: string[]; consequence: Consequence }[]): Promise<AgentToolResult> {
    this.count("plans");
    const need = steps.filter((s) => NEEDS_CONSENT.has(s.consequence));
    this.emit("plan", { steps });
    if (!need.length) return text("计划记下了；这些步骤不需要用户同意，直接做。");
    const lines = steps.map((s, i) => `${i + 1}. ${s.purpose}${s.objects.length ? "（" + s.objects.join("、") + "）" : ""}${s.consequence === "modify_user" ? "——改你的东西" : s.consequence === "external" ? "——往外发，到时候再确认一次" : ""}`);
    const card: Card = { kind: "plan", text: `我打算这样做：\n${lines.join("\n")}\n可以吗？`, free_text: true, blocking: true, options: [{ kind: "approve", text: "可以，就这样做" }, { kind: "cancel", text: "先别做了" }] };
    const got = await this.askCard(card);
    if (!got) return this.end("failed", "no answer from the user");
    if (got.option?.kind === "cancel") return this.end("cancelled", "the user stopped the task");
    if (!got.option) return text(`用户没有同意，而是说：${got.text}。按这个改计划。`);
    for (const s of need) if (s.consequence === "modify_user") for (const obj of s.objects) {
      const t = this.o.signer.forObject(obj, "modify_user", this.o.task);
      this.tokens.set(obj, t);
      this.consents.push({ scope: "object", object: obj, consequence: "modify_user" });
    }
    this.emit("plan.confirmed", { objects: [...this.tokens.keys()] });
    return text("用户同意了计划。改用户东西的步骤可以做了；往外发的步骤到时候会再确认一次。");
  }

  /** A file capability as a tool, under the same rule: a path that existed at begin is the user's. */
  private async fileAct(capId: string, args: Record<string, string>): Promise<AgentToolResult> {
    const ws = this.o.workspace!, cap = this.o.registry!.get(capId)!, ex = this.o.executor;
    const bad = cap.typecheck(args);
    if (bad) return err(bad);
    const pre = cap.preconditions(ws, args);
    if (pre) return err(`前置条件不成立：${pre}`);
    const fp = cap.footprint(ws, args);
    const userPaths = fp.writes.filter((p) => ws.exists(p) && ex.ledger.ownerOf(`path:${p}`) === "user");
    const consequence: Consequence = cap.effect === "observe" ? "read" : cap.effect === "external" ? "external" : userPaths.length ? "modify_user" : "create";
    const described = `${cap.description.split("；")[0]}：${Object.entries(args).map(([k, v]) => `${k}=「${v.slice(0, 80)}」`).join("，")}`;
    if (NEEDS_CONSENT.has(consequence)) {
      const object = consequence === "external" ? `cap:${cap.id}` : `path:${userPaths[0]}`;
      const held = this.tokens.get(object);
      const why = ex.consent.check({ kind: "wait", ms: 0 }, object, consequence, this.o.task, held);
      if (why) {
        const c = ex.consent.challenge({ kind: "wait", ms: 0 }, object, consequence, `${described}（${consequence === "external" ? "这会把内容发出去" : "这会改动你的文件 " + userPaths.join("、")}）`);
        const t = await this.consentFor(c);
        if (t === null) return this.end("failed", "no answer from the user");
        if (t === "cancel") return this.end("cancelled", "the user stopped the task");
        if (t === "declined") return this.declined(`用户不同意：${described}`);
        const again = ex.consent.check({ kind: "wait", ms: 0 }, object, consequence, this.o.task, t);
        if (again) return err(`同意凭证无效：${again}`);
      }
    }
    const existed = fp.writes.filter((p) => ws.exists(p));
    const r = cap.execute(ws, args);
    ws.invalidate();
    this.count("actions"); this.count(`fs:${r.status}`);
    if (r.status === "ok") {
      // ownership follows content: a user's file moved elsewhere is still the user's at its new path (review 10-18, T1)
      const gone = existed.filter((p) => !ws.exists(p));
      for (const p of fp.writes) if (!existed.includes(p) && ws.exists(p)) { if (gone.length) ex.ledger.inherits(`path:${p}`, `path:${gone[0]}`); else ex.ledger.created(`path:${p}`); }
      if (cap.effect !== "observe") this.effects.push(described);
    }
    this.emit("fs.act", { cap: cap.id, args, status: r.status, consequence });
    return r.status === "ok" ? text(J({ status: "ok", output: r.output ?? {}, consequence })) : err(J({ status: r.status, why: r.why, consequence }));
  }

  private async finish(p: { outcome: "done" | "unconfirmed" | "cannot"; summary: string; missing?: string[] }): Promise<AgentToolResult> {
    this.summary = p.summary;
    this.emit("finish.claimed", { outcome: p.outcome, summary: p.summary, missing: p.missing ?? [] });
    if (p.outcome === "cannot") return this.end("failed", "cannot: " + p.summary.slice(0, 200));
    if (p.outcome === "unconfirmed") return this.end("unconfirmed", (p.missing ?? []).join("; ") || p.summary.slice(0, 200));
    // "done" is a claim: the verdict comes from an independent judge reading the final state the executor hands over
    const v = await this.verify(p.summary);
    this.verdicts.push(v);
    if (v.verdict === "pass") return this.end("succeeded", "verified: " + v.reason.slice(0, 200));
    this.count("verify_failed");
    if ((this.counters["verify_failed"] ?? 0) > this.budget.verify_retries) return this.end("unconfirmed", `verification did not pass: ${v.reason.slice(0, 200)}`);
    return err(`核对没有通过（${v.verdict}）：${v.reason}\n没做成就接着做；确认不了就 finish unconfirmed 并说明缺什么。不要再直接说 done。`);
  }

  /** The independent verdict: the computer and files after, every window the task touched, what it did, its claim. */
  private async verify(summary: string): Promise<{ verdict: string; reason: string }> {
    const ev = await this.o.executor.verify();
    const evidence: Record<string, unknown> = {
      任务结束时整台电脑: ev.snapshot,
      任务碰过的窗口现在的样子: ev.windows.map((o) => ({ window: o.window, modal: o.modal, text: o.text, elements: o.elements.map((e) => ({ id: e.id, role: e.role, label: e.label, value: e.value })) })),
      本任务做过的动作: this.effects,
      执行层的回执: ev.receipts.map((r) => ({ action: r.request.action, status: r.result.status, consequence: r.result.consequence })),
      ...(this.o.workspace ? { 任务目录现在的内容: this.o.workspace.listing() } : {}),
      ...(this.answer !== null ? { 给用户的答案: this.answer } : {}),
      模型自称: summary,
    };
    const req = { statement: "用户的要求已经做到，最终状态和要求一致；用户问的是问题则答案有依据", check: { kind: "semantic" } };
    // the audit's wording follows Codex's completion audit (ext/goal/templates/goals/continuation.md): completion is
    // unproven until the current state proves every requirement; weak or indirect evidence is not achieved
    const audit = [
      "核对的做法：先从用户的要求里列出每一条具体要求（每个文件、每句话、每个动作、每个问题的答案），再逐条在证据里找能证明它的东西。",
      "证据只认现在的状态（窗口的元素和文字、文件内容、执行回执）；模型自称做完了、动作「发出去了」但没读回结果、只和要求「相符」但证明不了，都不算。",
      "一条要求的证据范围要和它一样宽：用一个窄的检查不能支持一个宽的结论。",
      "每条都被证明才 pass；有一条证据矛盾就 fail；有一条证据不够、没有或间接，就 unknown。reason 里写明哪一条、缺什么。",
    ].join("\n");
    const rep = await this.o.gateway.ask("verify", P.SYSTEM, P.verifyPrompt(req, this.o.raw, evidence) + "\n" + audit, VerifyAnswer, this.o.task);
    this.count("model_calls");
    if (rep.outcome !== "answered") return { verdict: "unknown", reason: `verify ${rep.outcome}: ${rep.error}` };
    return { verdict: rep.data!.verdict, reason: rep.data!.reason };
  }

  // --- the loop --------------------------------------------------------------------------------------------------------
  private systemPrompt(): string {
    const base = fs.existsSync(BASE_SKILL) ? body(fs.readFileSync(BASE_SKILL, "utf-8")) : "";
    const cands = this.o.skills?.candidates(this.o.raw) ?? [];
    const skills = cands.length ? "\n\n## 可能适用的教程\n" + cands.map((c) => `- ${c.name}：${c.description}`).join("\n") + "\n适用的用 read_skill 读全文。" : "";
    const ws = this.o.workspace ? `\n\n## 任务目录\n用户选定的文件夹，文件工具的路径都相对它。现在的内容：${J(this.o.workspace.listing())}` : "";
    return `你是桌面助手 DeskMind。只用工具做事；每一轮要么调用工具，要么用 finish 结束。\n\n${base}${skills}${ws}`;
  }

  async run(): Promise<RuntimeResult> {
    const ex = this.o.executor;
    let snap;
    try { snap = await ex.begin(this.o.workspace ? Object.keys(this.o.workspace.entries()) : []); }
    catch (e) {
      // the computer could not be read at all (hands missing, no permission): an environment stop, said as such
      this.status = "environment"; this.reason = `cannot read the computer: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200);
      await ex.end().catch(() => undefined);
      return this.result();
    }
    this.emit("run.start", { task: this.o.task, raw: this.o.raw, windows: snap.windows.length });
    if (snap.locked) { this.status = "environment"; this.reason = "the screen is locked"; await ex.end().catch(() => undefined); return this.result(); }
    const context: AgentContext = {
      messages: [
        { role: "system", content: this.systemPrompt(), timestamp: Date.now() },
        { role: "user", content: `用户的要求：${this.o.raw}\n\n现在整台电脑的状态：${J(snap)}`, timestamp: Date.now() },
      ],
      tools: this.tools(),
    };
    let turns = 0, calls = 0, nudge = false;
    const config: AgentLoopConfig = {
      model: this.o.model.model, apiKey: this.o.model.apiKey, convertToLlm: (m) => m as never, toolExecution: "sequential",
      maxRetries: 4, maxRetryDelayMs: 60_000,            // 429s when several runs share a key: pi-ai backs off
      beforeToolCall: async ({ toolCall }) => {
        if (this.status) return { block: true, reason: `已经结束：${this.status}`, terminate: true };
        calls += 1; this.count("tool_calls");
        if (calls > this.budget.tool_calls) { this.status = "failed"; this.reason = "budget: tool calls"; return { block: true, reason: "预算用完，任务到此为止", terminate: true }; }
        this.emit("tool.call", { name: toolCall.name, args: toolCall.arguments });
        return undefined;
      },
      afterToolCall: async ({ toolCall, result, isError }) => { this.emit("tool.result", { name: toolCall.name, isError, text: result.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("").slice(0, 300) }); return undefined; },
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
    if (!this.status) { this.status = "failed"; this.reason = "the model stopped without finishing"; }
    await ex.end().catch(() => undefined);
    return this.result();
  }

  private result(): RuntimeResult {
    const r: RuntimeResult = { status: this.status!, reason: this.reason, summary: this.summary, answer: this.answer, counters: { ...this.counters }, consents: this.consents, effects: this.effects, verdicts: this.verdicts };
    this.emit("run.end", { status: r.status, reason: r.reason });
    return r;
  }
}

export { higher };
