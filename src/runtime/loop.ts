/**
 * The frontier runtime: one model runs the whole loop (see, think, act) through tools, on pi-agent-core. It is a plain
 * caller of the executor (executor split P1, deskmind#90 item 6): every tool is one call on the `ExecutorPort`
 * (protocol/port.ts), and everything that keeps the user safe — consent and its signing, the cards, the start gate,
 * the intent check, skills, the verdict and the task's status — happens behind the port. What is left here is the
 * loop's own business: the model, the tools it is offered, the context and its compaction, the user's mid-run words
 * reaching the model, and the loop's budget (tool calls, turns).
 *
 * Tools: computer_snapshot / computer_observe / computer_act, plan, fs_* (the file capabilities the port lists),
 * ask_user, answer, read_skill, finish.
 */
import { Type, type Static, type TSchema, type Message } from "@earendil-works/pi-ai";
import type { Model } from "@earendil-works/pi-ai";
import { runAgentLoop, type AgentContext, type AgentEvent, type AgentLoopConfig, type AgentTool, type AgentToolResult, type StreamFn } from "@earendil-works/pi-agent-core";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { compact } from "./compact.js";
import { costOf, priceEstimated } from "../gateway/index.js";
import { current as traceContext, within, type SpanLike } from "../otel/context.js";
import { chatAttrs, span } from "../otel/trace.js";
import { CONSEQUENCES, type Consequence } from "../protocol/consent.js";
import type { Action, Reading } from "../protocol/computer.js";
import type { Begun, ExecutorPort, FinishOutcome, PlanStepIn, TaskResult, TaskStatus, ToolReply } from "../protocol/port.js";

export type { PlanStepIn };
/** The task's status and result are the executor's (protocol/port.ts); the old names stay for older imports. */
export type RuntimeStatus = TaskStatus;
export type RuntimeResult = TaskResult;

/** The loop's own budget: tool calls and model turns. Questions and verdict retries are the executor's. */
export const RUNTIME_BUDGET = { tool_calls: 40, turns: 30 };

export interface LoopOptions {
  /** The executor, as the runtime may reach it. */
  port: ExecutorPort;
  /** The user's request, as the model first hears it. */
  raw: string;
  model: { model: Model<any>; apiKey?: string; streamFn: StreamFn };
  budget?: Partial<typeof RUNTIME_BUDGET>;
  onEvent?: (kind: string, body: Record<string, unknown>) => void;
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

export class AgentLoop {
  readonly counters: Record<string, number> = {};
  /** The task is over for the loop: the executor said so (a reply with `done`), the app stopped it, or the loop gave up. */
  private over = false;
  /** Why the loop gave up (a budget, a model error), for the executor when it has not settled the status itself. */
  private failure: string | null = null;
  private readonly budget: typeof RUNTIME_BUDGET;
  private readonly abort = new AbortController();

  constructor(readonly o: LoopOptions) {
    this.budget = { ...RUNTIME_BUDGET, ...(o.budget ?? {}) };
  }

  private count(k: string, by = 1) { this.counters[k] = (this.counters[k] ?? 0) + by; }
  private emit(kind: string, b: Record<string, unknown> = {}) { this.o.onEvent?.(kind, b); }

  /** The app stopped the task (the executor has been told): no more model turns or tool calls. */
  stop() { this.over = true; this.abort.abort(); }

  /** The user's mid-run words a reply carried this turn: they reach the model again as a user message before its next
   *  turn, whole — compaction cuts old tool results, never the user's words. */
  private heard: string[] = [];

  private giveUp(reason: string) { if (!this.over) { this.over = true; this.failure = reason; } }

  /** A port reply as the model reads it; a reply that ends the task ends the loop. */
  private reply(r: ToolReply): AgentToolResult {
    if (r.done) this.over = true;
    if (r.steers?.length) this.heard.push(...r.steers);
    return { ...(r.isError ? err(r.text) : text(r.text)), ...(r.done ? { terminate: true } : {}) };
  }

  /** The model turn in progress, as a span (when the run is traced): the tool calls of the turn are its children. */
  private turnSpan: SpanLike | null = null;

  /** Every tool as a span of its own under the turn (execute_tool, per the GenAI conventions): what the executor does
   *  for it nests below. */
  private traced(tools: AgentTool<any>[]): AgentTool<any>[] {
    return tools.map((t) => ({ ...t, execute: (id: string, p: unknown, ...rest: unknown[]) => within(this.turnSpan ? { span: this.turnSpan } : {}, () =>
      span(`execute_tool ${t.name}`, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": t.name, "gen_ai.tool.call.id": id, "gen_ai.tool.type": "function" }, async (s) => {
        const r = await (t.execute as (...a: unknown[]) => Promise<AgentToolResult>)(id, p, ...rest);
        if (r.isError) s?.set({ "deskmind.tool.error": true });
        return r;
      })) }) as AgentTool<any>);
  }

  // --- tools ---------------------------------------------------------------------------------------------------------
  private tools(b: Begun): AgentTool<any>[] {
    const port = this.o.port;
    const tools: AgentTool<any>[] = [];
    tools.push(tool({
      name: "computer_snapshot", label: "看整台电脑", description: "整台电脑的状态：锁屏没有、最前面的应用、所有窗口（id、应用、标题、归谁 owner、浏览器标签页）。只读。",
      parameters: Type.Object({}), execute: async () => text(J(await port.snapshot())),
    }));
    tools.push(tool({
      name: "computer_observe", label: "看一个窗口", description: "一个窗口的元素（id、角色、标签、值、能做的动作）、弹窗、文字。只读。动作要用这里的元素 id 和 epoch。",
      parameters: Type.Object({ window: Type.String() }),
      execute: async (_id, p: { window: string }) => { try { return text(J(await port.observe(p.window))); } catch (e) { return err(String(e instanceof Error ? e.message : e)); } },
    }));
    tools.push(tool({
      name: "computer_act", label: "动手", description: "在界面上做一个动作。带上观察时的 epoch 和你判断的后果类别 consequence（read / create / modify_user / external；执行层只会往上调）。改用户的东西、往外发会先征得用户同意。",
      parameters: Type.Object({ action: ActionSchema, epoch: Type.Number(), consequence: lit(CONSEQUENCES), purpose: Type.String({ description: "这一步为了什么，一句话" }), plan_step: Type.Optional(Type.Number({ description: "这一步属于计划里的第几步（从 1 数）；没有计划就不填" })) }),
      execute: async (_id, p: { action: Static<typeof ActionSchema>; epoch: number; consequence: Consequence; purpose: string; plan_step?: number }) => this.reply(await port.act({ action: p.action as unknown as Action, epoch: p.epoch, consequence: p.consequence, purpose: p.purpose, ...(p.plan_step !== undefined ? { plan_step: p.plan_step } : {}) })),
    }));
    tools.push(tool({
      name: "plan", label: "计划", description: "动手前列出步骤：目的、涉及的对象（窗口 id / 标签页 id / 文件路径）、后果类别。要碰用户的东西或往外发，必须先有计划。readings：原话里能有不止一种理解的地方，每处写你选的理解、其他理解、以及区分它们的依据（看到的东西：窗口标题、文件名、文件里的一行、用户的回答；原话本身不算）。依据不够的，程序会先问用户。程序把计划给用户过目，同意后改用户东西的步骤不再逐步打扰。某一步要用 open_window 打开网址的，在这一步的 opens 里写上应用、网址，以及网址会把什么发到那个网站（sends，一句话，比如「搜索『北京天气』」）：计划卡会列出这些网站和发过去的内容。用户同意计划后，网址里只有用户的话、常识和卡上写的内容时就不再逐次打扰；网址里带着读到的文件或窗口内容，仍会单独问。",
      parameters: Type.Object({ steps: Type.Array(Type.Object({ purpose: Type.String(), objects: Type.Array(Type.String()), consequence: lit(CONSEQUENCES), opens: Type.Optional(Type.Array(Type.Object({ app: Type.String(), url: Type.String(), sends: Type.Optional(Type.String({ description: "网址会把什么发到这个网站，一句话，比如「搜索『北京天气』」" })) }), { description: "这一步用 open_window 打开的网址：应用、网址、发过去的内容" })) })), readings: Type.Optional(Type.Array(Type.Object({ point: Type.String(), reading: Type.String(), alternatives: Type.Array(Type.String()), evidence: Type.Array(Type.String()) }))) }),
      execute: async (_id, p: { steps: PlanStepIn[]; readings?: Reading[] }) => this.reply(await port.plan({ steps: p.steps, readings: p.readings ?? [] })),
    }));
    tools.push(tool({
      name: "ask_user", label: "问用户", description: "只有用户知道的信息（要写什么、哪一个、放哪）才问；能自己看到的不要问。options 是从证据里拿的候选，2–6 个，可以为空。",
      parameters: Type.Object({ question: Type.String(), options: Type.Array(Type.String()) }),
      execute: async (_id, p: { question: string; options: string[] }) => this.reply(await port.askUser(p)),
    }));
    tools.push(tool({
      name: "answer", label: "回答", description: "把答案告诉用户（用户问的是问题时）。然后再 finish。",
      parameters: Type.Object({ text: Type.String() }),
      execute: async (_id, p: { text: string }) => this.reply(await port.answer(p)),
    }));
    if (b.skillsOffered) tools.push(tool({
      name: "read_skill", label: "读教程", description: "读一份教程的全文（开头列出的候选之一）。",
      parameters: Type.Object({ name: Type.String() }),
      execute: async (_id, p: { name: string }) => this.reply(await port.readSkill(p)),
    }));
    tools.push(tool({
      name: "finish", label: "结束", description: "结束任务。done = 做成了（程序会独立核对，没过会告诉你缺什么）；unconfirmed = 做了但确认不了；cannot = 做不到；stopped = 用户用自己的话让你停下 / 取消 / 先不做了（选项里的「先别做了」程序会自己处理，这个用于用户写在回答里的）。summary 写清楚改了什么、哪些是用户的东西、答案是什么。",
      parameters: Type.Object({ outcome: Type.Union([Type.Literal("done"), Type.Literal("unconfirmed"), Type.Literal("cannot"), Type.Literal("stopped")]), summary: Type.String(), missing: Type.Optional(Type.Array(Type.String())) }),
      execute: async (_id, p: { outcome: FinishOutcome; summary: string; missing?: string[] }) => this.reply(await port.finish(p)),
    }));
    for (const f of b.files) {
      const props: Record<string, ReturnType<typeof Type.String>> = {};
      for (const [k, d] of Object.entries(f.params)) props[k] = Type.String({ description: d.description });
      tools.push(tool({
        name: f.name, label: f.capability, description: f.description,
        parameters: Type.Object(props), execute: async (_id, args) => this.reply(await port.file({ capability: f.capability, args: args as Record<string, string> })),
      }));
    }
    return tools;
  }

  // --- the loop --------------------------------------------------------------------------------------------------------
  private systemPrompt(b: Begun): string {
    const base = fs.existsSync(BASE_SKILL) ? body(fs.readFileSync(BASE_SKILL, "utf-8")) : "";
    const skills = b.skills.length ? "\n\n## 可能适用的教程\n" + b.skills.map((c) => `- ${c.name}：${c.description}`).join("\n") + "\n适用的用 read_skill 读全文。" : "";
    // the folder's absolute path too: a save sheet in an app (⌘⇧G) needs it, and the model cannot find it out otherwise
    const ws = b.workspace ? `\n\n## 任务目录\n用户选定的文件夹，文件工具的路径都相对它；它在这台电脑上的完整路径是 ${b.workspace.root}（应用的存储对话框里用这个）。现在的内容：${J(b.workspace.listing)}` : "";
    return `你是桌面助手 DeskMind。只用工具做事；每一轮要么调用工具，要么用 finish 结束。\n\n${base}${skills}${ws}`;
  }

  async run(): Promise<TaskResult> {
    const port = this.o.port;
    const b = await port.begin();
    if (b.ended || !b.snapshot) return port.end();
    const rec = b.recovered;
    const recovery = rec ? `\n\n注意：上一次运行在做「${rec.text}」时中断了，${rec.finding === "happened" ? "那一步已经生效" : rec.finding === "not_happened" ? "那一步没有发生" : "不知道那一步做成没有"}。${rec.external.length ? `中断期间这些文件被别的程序改过：${rec.external.join("、")}——那些改动不是你的，不要撤销；先读一遍，再看用户的要求在现在的内容上还成不成立，拿不准就问用户。` : ""}${rec.reconciled === "continue" ? "用户已经看过中断前后的样子，选择在现在的内容上继续。" : ""}先看现在的状态再决定，不要盲目重做。` : "";
    const context: AgentContext = {
      messages: [
        { role: "system", content: this.systemPrompt(b), timestamp: Date.now() },
        { role: "user", content: `用户的要求：${this.o.raw}\n\n现在整台电脑的状态：${J(b.snapshot)}${recovery}`, timestamp: Date.now() },
      ],
      tools: this.traced(this.tools(b)),
    };
    let turns = 0, calls = 0, nudge = false;
    // one model call per turn: when it was sent (the turn's start) and how much went with it, for its record
    let turnAt = Date.now(), sentChars = 0;
    const config: AgentLoopConfig = {
      model: this.o.model.model, apiKey: this.o.model.apiKey, convertToLlm: (m) => m as never, toolExecution: "sequential",
      // what the model is sent is cut to its window; the transcript keeps everything, the cut is an event
      transformContext: async (messages) => {
        const budget = Math.floor((this.o.model.model.contextWindow ?? 128_000) * 0.6);
        const { messages: out, compaction } = compact(messages as Message[], budget);
        sentChars = JSON.stringify(out).length;
        if (compaction) { this.count("compactions"); this.emit("compaction", compaction as unknown as Record<string, unknown>); }
        return out as typeof messages;
      },
      maxRetries: 4, maxRetryDelayMs: 60_000,            // 429s when several runs share a key: pi-ai backs off
      beforeToolCall: async ({ toolCall }) => {
        if (this.over) return { block: true, reason: "已经结束", terminate: true };
        calls += 1; this.count("tool_calls");
        if (calls > this.budget.tool_calls) { this.giveUp("budget: tool calls"); return { block: true, reason: "预算用完，任务到此为止", terminate: true }; }
        this.emit("tool.call", { name: toolCall.name, args: toolCall.arguments });
        return undefined;
      },
      afterToolCall: async ({ toolCall, result, isError }) => { this.emit("tool.result", { name: toolCall.name, isError, text: result.content.map((c) => (c.type === "text" ? c.text : "[image]")).join("").slice(0, 2000) }); return undefined; },   // a re-ask on a real Mac is read from the trace: 300 cut every observation (rc.9)
      // the user's mid-run words no reply has carried yet: the executor applies them now, between turns
      getSteeringMessages: async () => [...this.heard.splice(0), ...port.steers()].map((r) => ({ role: "user" as const, content: `用户改了要求，以这句为准（之前做过的不会消失，按新要求接着做或撤回）：${r}`, timestamp: Date.now() })),
      finishTurn: async (turn) => {
        turns += 1; this.count("turns");
        if (this.over) return { action: "end" };
        if (turns >= this.budget.turns) { this.giveUp("budget: turns"); return { action: "end" }; }
        if (turn.message.stopReason === "error" || turn.message.stopReason === "aborted") { this.giveUp(`model ${turn.message.stopReason}: ${turn.message.errorMessage ?? ""}`.slice(0, 200)); return { action: "end" }; }
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
    const spec = `${this.o.model.model.provider}|${this.o.model.model.id}`;
    // the call chain (otel/trace.ts), when the run is traced: a span per turn, the model's call in it
    const { tracer, span: runSpan } = traceContext();
    let chat: SpanLike | null = null;
    const endTurn = () => { if (chat && tracer) { chat.fail("the turn ended without an answer"); tracer.end(chat); chat = null; } if (this.turnSpan && tracer) { tracer.end(this.turnSpan); this.turnSpan = null; } };
    const emit = async (e: AgentEvent) => {
      if (e.type === "turn_start") {
        turnAt = Date.now();
        if (tracer) { endTurn(); this.turnSpan = tracer.start("deskmind.turn", { parent: runSpan ?? null, attrs: { "deskmind.turn": turns + 1 } }); chat = tracer.start(`chat ${this.o.model.model.id}`, { kind: "client", parent: this.turnSpan }); }
      }
      if (e.type === "turn_end") endTurn();
      if (e.type === "message_end" && e.message.role === "assistant") {
        this.count("model_calls"); const u = e.message.usage; this.count("tokens_in", u.input + (u.cacheRead ?? 0)); this.count("tokens_out", u.output);
        // the acting model's call, recorded like the gateway's (role "loop"): tokens, cost by the price table when pi-ai
        // says none, latency from the turn's start, and how much was sent. Input tokens are everything the model read:
        // pi-ai's `input` leaves out what came from the prompt cache, so it is added (the gateway's definition)
        const m = e.message;
        const cacheRead = u.cacheRead ?? 0, tokensIn = u.input + cacheRead;
        const priced = !u.cost?.total;
        try {
          traceContext().onModelCall?.({ kind: "model.call", call_id: `mc_${randomUUID().slice(0, 8)}`, started_at: turnAt, role: "loop", backend: "pi-ai", model: spec,
            outcome: m.stopReason === "error" ? "error" : m.stopReason === "aborted" ? "aborted" : "answered", tokens_in: tokensIn, tokens_out: u.output, cache_read: cacheRead,
            cost_usd: Number((u.cost?.total || costOf(spec, tokensIn, u.output, cacheRead)).toFixed(9)), ...(priced && priceEstimated(spec, cacheRead) ? { cost_estimated: true } : {}), latency_ms: Date.now() - turnAt, sent_chars: sentChars,
            tool_calls: m.content.filter((c) => c.type === "toolCall").length, ...(m.errorMessage ? { error: m.errorMessage.slice(0, 300) } : {}) });
        } catch { /* recording never stops the loop */ }
        if (chat && tracer) {
          const cost = Number((u.cost?.total || costOf(spec, tokensIn, u.output, cacheRead)).toFixed(9));
          chat.set({ ...chatAttrs({ model: spec, role: "loop", tokens_in: tokensIn, cache_read: cacheRead, tokens_out: u.output, cost_usd: cost, outcome: m.stopReason }), "gen_ai.response.finish_reasons": [m.stopReason], "deskmind.sent_chars": sentChars });
          if (m.stopReason === "error" || m.stopReason === "aborted") chat.fail(m.errorMessage ?? m.stopReason);
          tracer.end(chat); chat = null;
        }
      }
    };
    try {
      await runAgentLoop([], context, config, emit, this.abort.signal, this.o.model.streamFn);
    } catch (e) {
      this.giveUp(`loop error: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
    endTurn();
    return port.end(this.failure ? { failure: this.failure } : {});
  }
}
