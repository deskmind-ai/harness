/**
 * Executor split P1 (deskmind#90 item 6): the runtime is a plain caller of the executor's port, and the executor owns
 * what keeps the user safe. Checked here:
 *   - the judge reads the user's answers whatever the caller reports (the executor holds them);
 *   - a steer is applied between steps only, never during one; an open card is voided and asked again on the new words;
 *   - a steer that needs something beyond the accepted plan gets a new plan card, not a card per step;
 *   - the runtime cannot sign: it holds no signer, the port gives none, and a consent it passes along is not used.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { Gateway } from "../src/gateway/index.js";
import type { Answer, Card, CardAsker } from "../src/protocol/cards.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { ExecutorService } from "../src/executor/service.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import { FrontierRuntime } from "../src/host/frontier.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";
import { EventLog, type AppEvent } from "../src/protocol/events.js";
import { LineReader, StdioUser, toProtocol } from "../src/cli/app.js";

const scriptedTable = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
const model = { model: { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as any };
const RAW = "在信鸽里回复林晓关于“Q3 预算”的邮件：“收到，谢谢”";

/** The last tool result's JSON (the epoch and ids the model would read). */
const last = (messages: Message[]): any => { const m = [...messages].reverse().find((x) => x.role === "toolResult") as any; const t = m?.content?.[0]?.text ?? "{}"; try { return JSON.parse(t.split("\n")[0]); } catch { return {}; } };
const lastText = (messages: Message[]): string => { const m = [...messages].reverse().find((x) => x.role === "toolResult") as any; return m?.content?.[0]?.text ?? ""; };
const epochOf = (ms: Message[]) => { const j = last(ms); return j.after?.epoch ?? j.epoch; };
const act = (action: Record<string, unknown>, consequence: string, purpose = "step") => (ms: Message[]): Step => ({ calls: [{ name: "computer_act", args: { action, epoch: epochOf(ms), consequence, purpose } }] });
const approve = (c: Card): Answer => ({ option: c.options.findIndex((o) => o.kind === "approve") });

function mail() {
  const sim = new SimComputer();
  const w = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [
    { id: "m1", from: "林晓", subject: "Q3 预算", body: ["你好，关于Q3 预算，", "会议时间：14:00", "谢谢"], time: "14:00" },
    { id: "m2", from: "林晓", subject: "周会纪要", body: ["会议时间：10:00"], time: "10:00" },
  ] });
  return { sim, w: w.id };
}

/** A gateway whose judge says "matches" to every intent question, answers the outgoing question as a plain judge would,
 *  passes every verdict, and keeps every prompt by role. */
function judge() {
  const gw = new Gateway(scriptedTable);
  const asked: { role: string; prompt: string }[] = [];
  gw.script = Array(200).fill((role: string, _s: string, u: string) => {
    asked.push({ role, prompt: u });
    if (role === "verify") return { choice: "pass", reason: "ok" };
    if (role === "intent" && u.includes("会不会把")) return { choice: /"目标名字命中发送词表":\s*true/.test(u) ? "sends" : "stays" };
    return { choice: "matches" };
  });
  return { gw, asked };
}

/** A new plan for the mail window: reply and send. */
const replan = (w: string): Step => ({ calls: [{ name: "plan", args: { steps: [{ purpose: "按新要求回复林晓", objects: [`window:${w}`], consequence: "modify_user" }, { purpose: "发送", objects: [`window:${w}`], consequence: "external" }] } }] });

/** The JSON object a judge prompt carries (the user's words and the evidence). */
const wordsOf = (prompt: string): Record<string, unknown> => JSON.parse(prompt.slice(prompt.indexOf("{"), prompt.lastIndexOf("}") + 1));

describe("executor port: the judge reads the user's answers", () => {
  it("an answer to ask_user reaches the verdict though the caller never reports it (a bare port caller, no agent loop)", async () => {
    const { sim } = mail();
    const signer = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: signer.publicKey });
    const { gw, asked } = judge();
    const svc = new ExecutorService({ task: "t1", raw: "把林晓那封邮件标上旗标", executor: ex, signer, user: { ask: () => ({ text: "周会纪要那封，不是预算那封" }) }, gateway: gw });
    const port = svc.port;
    expect((await port.begin()).ended).toBe(false);
    expect((await port.askUser({ question: "林晓有两封邮件，标哪一封？", options: [] })).text).toContain("周会纪要那封");
    // the caller's claim says nothing of the answer, and it passes no evidence of its own: the port has no field for it
    const r = await port.finish({ outcome: "done", summary: "标好了" });
    expect(r.done).toBe(true);
    const verdict = asked.filter((a) => a.role === "verify");
    expect(verdict).toHaveLength(1);
    const words = wordsOf(verdict[0]!.prompt);
    expect(JSON.stringify(words["用户对提问的回答（和原话一样是用户的话）"])).toContain("周会纪要那封，不是预算那封");
    expect((await port.end()).status).toBe("succeeded");
  });

  it("through the agent loop too: the model's summary leaves the answer out, the verdict still has it", async () => {
    const { sim } = mail();
    const signer = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: signer.publicKey });
    const { gw, asked } = judge();
    const steps: Step[] = [
      { calls: [{ name: "ask_user", args: { question: "回复里写什么？", options: [] } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "看过了" } }] },
    ];
    const rt = new FrontierRuntime({ task: "t1", raw: "看一下林晓的邮件", executor: ex, signer, user: { ask: () => ({ text: "写：下周二再约" }) }, gateway: gw, model: { ...model, streamFn: scriptedStream(steps) } });
    const r = await rt.run();
    expect(r.status).toBe("succeeded");
    expect(asked.find((a) => a.role === "verify")!.prompt).toContain("写：下周二再约");
  });
});

describe("executor port: steer", () => {
  it("is applied between steps, never during one: a step in progress finishes on the old words, the next one comes back undone", async () => {
    const { sim, w } = mail();
    const signer = ConsentSigner.fresh();
    const events: { kind: string; body: Record<string, unknown> }[] = [];
    const ex = new Executor(sim, { task: "t1", publicKey: signer.publicKey, onEvent: (kind, body) => events.push({ kind, body }) });
    const { gw, asked } = judge();
    let rt!: FrontierRuntime;
    let rawDuring: string | undefined;
    // the user's words arrive while the driver is performing the click on Reply
    const perform = sim.perform.bind(sim);
    sim.perform = (a) => {
      if (a.kind === "click" && a.target.endsWith(":reply") && rawDuring === undefined) { rt.steer("回复内容改成：好的，周五见"); rawDuring = ex.opts.raw; }
      return perform(a);
    };
    const seen: Message[][] = [];
    const steps: Step[] = [
      { calls: [{ name: "plan", args: { steps: [{ purpose: "打开林晓的 Q3 预算邮件并回复", objects: [`window:${w}`], consequence: "modify_user" }, { purpose: "发送回复", objects: [`window:${w}`], consequence: "external" }] } }] },
      { calls: [{ name: "computer_observe", args: { window: w } }] },
      act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "modify_user"),
      // two steps decided in one turn, before the user's words came: the second is not done
      (ms) => ({ calls: [
        { name: "computer_act", args: { action: { kind: "click", window: w, target: `${w}:0:reply` }, epoch: epochOf(ms), consequence: "modify_user", purpose: "回复" } },
        { name: "computer_act", args: { action: { kind: "set_value", window: w, target: `${w}:0:compose_body`, value: "收到，谢谢" }, epoch: epochOf(ms), consequence: "modify_user", purpose: "写正文" } },
      ] }),
      { calls: [{ name: "computer_observe", args: { window: w } }] },
      // the plan's consent went with the old words: a new plan first
      act({ kind: "set_value", window: w, target: `${w}:0:compose_body`, value: "好的，周五见" }, "modify_user"),
      (ms) => { expect(lastText(ms)).toContain("先按新要求交一份新计划"); return replan(w); },
      { calls: [{ name: "computer_observe", args: { window: w } }] },
      act({ kind: "set_value", window: w, target: `${w}:0:compose_body`, value: "好的，周五见" }, "modify_user"),
      act({ kind: "click", window: w, target: `${w}:0:send` }, "external"),
      { calls: [{ name: "finish", args: { outcome: "done", summary: "已回复：好的，周五见" } }] },
    ];
    rt = new FrontierRuntime({ task: "t1", raw: RAW, executor: ex, signer, user: { ask: approve }, gateway: gw, model: { ...model, streamFn: scriptedStream(steps, seen) }, onEvent: (kind, body) => events.push({ kind, body }) });
    const r = await rt.run();
    expect(r.status).toBe("succeeded");
    // during the click the request was still the old one; the click went through
    expect(rawDuring).toBe(RAW);
    expect(events.filter((e) => e.kind === "executor.act" && e.body.status !== "needs_consent").map((e) => [(e.body.action as any).kind, e.body.status])).toEqual([["click", "ok"], ["click", "ok"], ["set_value", "ok"], ["click", "ok"]]);
    // the step decided before the words came back undone, with the new words; the old body was never typed
    const toolResults = seen[4]!.filter((m) => m.role === "toolResult").map((m: any) => m.content[0].text as string);
    expect(toolResults.at(-1)).toContain("用户改了要求");
    expect(toolResults.at(-1)).toContain("这一步没有做");
    expect(sim.mailState(w).replies).toEqual([{ to: "m1", body: "好的，周五见" }]);
    // applied once, between the two steps; the words reach the model once more as a user message of their own (which
    // compaction never cuts), once
    expect(events.filter((e) => e.kind === "steer.applied")).toHaveLength(1);
    expect(seen.at(-1)!.filter((m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes("用户改了要求")).map((m: any) => m.content)).toEqual(["用户改了要求，以这句为准（之前做过的不会消失，按新要求接着做或撤回）：回复内容改成：好的，周五见"]);
    // the send's intent check read the new words and, beside them, what the user asked first
    const send = asked.filter((a) => a.role === "intent" && a.prompt.includes("即将执行的动作")).at(-1)!;
    const words = wordsOf(send.prompt);
    expect(words.用户原文).toBe("回复内容改成：好的，周五见");
    expect(words["用户中途改要求之前说的（从早到晚；和用户原文不一致时以用户原文为准）"]).toEqual([RAW]);
  });

  it("voids the card open when it comes; the step comes back undone and its card is asked again on the new words", async () => {
    const { sim, w } = mail();
    const signer = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: signer.publicKey });
    const { gw } = judge();
    const events: string[] = [];
    let rt!: FrontierRuntime;
    const cards: Card[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    // the user answers the plan card, then changes the request while the send's card is open (and never answers it)
    const user: CardAsker = {
      ask: (c, o) => {
        cards.push(c); signals.push(o?.signal);
        if (c.kind === "action" && cards.filter((x) => x.kind === "action").length === 1) { setTimeout(() => rt.steer("正文改成：好的，周五见，再发"), 5); return new Promise<Answer | null>(() => {}); }
        return approve(c);
      },
    };
    const seen: Message[][] = [];
    const steps: Step[] = [
      { calls: [{ name: "plan", args: { steps: [{ purpose: "回复林晓", objects: [`window:${w}`], consequence: "modify_user" }, { purpose: "发送", objects: [`window:${w}`], consequence: "external" }] } }] },
      { calls: [{ name: "computer_observe", args: { window: w } }] },
      act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "modify_user"),
      act({ kind: "click", window: w, target: `${w}:0:reply` }, "modify_user"),
      act({ kind: "set_value", window: w, target: `${w}:0:compose_body`, value: "收到，谢谢" }, "modify_user"),
      act({ kind: "click", window: w, target: `${w}:0:send` }, "external"),
      // the send came back undone with the new words
      (ms) => { expect(lastText(ms)).toContain("用户改了要求"); return replan(w); },
      { calls: [{ name: "computer_observe", args: { window: w } }] },
      act({ kind: "set_value", window: w, target: `${w}:0:compose_body`, value: "好的，周五见" }, "modify_user"),
      act({ kind: "click", window: w, target: `${w}:0:send` }, "external"),
      { calls: [{ name: "finish", args: { outcome: "done", summary: "已回复" } }] },
    ];
    rt = new FrontierRuntime({ task: "t1", raw: RAW, executor: ex, signer, user, gateway: gw, model: { ...model, streamFn: scriptedStream(steps, seen) }, onEvent: (k) => events.push(k) });
    const r = await rt.run();
    expect(r.status).toBe("succeeded");
    // the plan's consent went with the old words: a new plan card, then the send asked again
    expect(cards.map((c) => c.kind)).toEqual(["plan", "action", "plan", "action"]);
    // the first send card was let go (its asker told through the signal); the second shows the new body
    expect(signals[1]!.aborted).toBe(true);
    expect(signals[3]!.aborted).toBe(false);
    expect(events).toContain("card.voided");
    expect(events).toContain("plan.void");
    expect(cards[1]!.text).toContain("收到，谢谢");
    expect(cards[3]!.text).toContain("好的，周五见");
    // nothing went out on the voided card: one reply, with the new body
    expect(sim.mailState(w).replies).toEqual([{ to: "m1", body: "好的，周五见" }]);
    expect(r.consents.filter((c) => c.scope === "action")).toHaveLength(1);
  });

  it("beyond the accepted plan: a step on an object the plan did not name asks for a new plan card, not a card per step", async () => {
    const run = async (withSteer: boolean) => {
      const { sim, w } = mail();
      const e = sim.addEditor("编辑器", { title: "会议.txt", text: "周四开会", path: null }).id;
      const signer = ConsentSigner.fresh();
      const ex = new Executor(sim, { task: "t1", publicKey: signer.publicKey });
      const { gw } = judge();
      let rt!: FrontierRuntime;
      const cards: Card[] = [];
      const seen: Message[][] = [];
      const planW: Step = { calls: [{ name: "plan", args: { steps: [{ purpose: "回复林晓", objects: [`window:${w}`], consequence: "modify_user" }] } }] };
      const look: Step = { calls: [{ name: "computer_observe", args: { window: e } }] };
      const edit = act({ kind: "set_value", window: e, target: `${e}:0:textarea`, value: "周五开会" }, "modify_user");
      const done: Step = { calls: [{ name: "finish", args: { outcome: "done", summary: "改好了" } }] };
      const steps: Step[] = withSteer ? [
        planW,
        // the words come while the model decides its next look; they reach it before its next turn
        () => { rt.steer("另外把编辑器里的「会议.txt」正文改成：周五开会"); return look; },
        (ms) => { expect((ms.at(-1) as any).content).toContain("用户改了要求"); return edit(ms.slice(0, -1)); },   // beyond the plan: a new plan first
        (ms) => { expect(lastText(ms)).toContain("先按新要求交一份新计划"); return { calls: [{ name: "plan", args: { steps: [{ purpose: "改编辑器里的正文", objects: [`window:${e}`], consequence: "modify_user" }] } }] }; },
        look, edit, done,
      ] : [planW, look, edit, done];
      rt = new FrontierRuntime({ task: "t1", raw: RAW, executor: ex, signer, user: { ask: (c) => { cards.push(c); return approve(c); } }, gateway: gw, model: { ...model, streamFn: scriptedStream(steps, seen) } });
      const r = await rt.run();
      return { r, cards, text: sim.state(e).doc.text, counters: rt.counters, seen };
    };
    // the same step without a steer: the user's other window asks on its own action card (as before P1)
    const plain = await run(false);
    expect(plain.cards.map((c) => c.kind)).toEqual(["plan", "action"]);
    expect(plain.text).toBe("周五开会");
    // after a steer: no action card for it; a new plan names it, the user accepts that card, and the step goes through
    const steered = await run(true);
    expect(steered.r.status, JSON.stringify([steered.r.reason, steered.seen.at(-1)!.filter((m: any) => m.role === "toolResult").map((m: any) => m.content[0].text.slice(0, 200))])).toBe("succeeded");
    expect(steered.cards.map((c) => c.kind)).toEqual(["plan", "plan"]);
    expect(steered.cards[1]!.text).toContain("会议.txt");
    expect(steered.counters["needs_plan:steer"]).toBe(1);
    expect(steered.text).toBe("周五开会");
  });

  it("the rest of a turn decided before the words came is not done either; the next turn goes on as usual", async () => {
    const { sim, w } = mail();
    const signer = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: signer.publicKey });
    const { gw } = judge();
    let rt!: FrontierRuntime;
    const cards: Card[] = [];
    // the send's card is voided by the steer; the model had already decided a second step in the same turn
    const user: CardAsker = { ask: (c) => { cards.push(c); if (c.kind === "action") { setTimeout(() => rt.steer("先别发，只选中那封邮件"), 5); return new Promise<Answer | null>(() => {}); } return approve(c); } };
    const seen: Message[][] = [];
    const steps: Step[] = [
      { calls: [{ name: "plan", args: { steps: [{ purpose: "回复林晓", objects: [`window:${w}`], consequence: "modify_user" }, { purpose: "发送", objects: [`window:${w}`], consequence: "external" }] } }] },
      { calls: [{ name: "computer_observe", args: { window: w } }] },
      act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "modify_user"),
      act({ kind: "click", window: w, target: `${w}:0:reply` }, "modify_user"),
      act({ kind: "set_value", window: w, target: `${w}:0:compose_body`, value: "收到，谢谢" }, "modify_user"),
      (ms) => ({ calls: [
        { name: "computer_act", args: { action: { kind: "click", window: w, target: `${w}:0:send` }, epoch: epochOf(ms), consequence: "external", purpose: "发送" } },
        { name: "computer_act", args: { action: { kind: "click", window: w, target: `${w}:0:row:m2` }, epoch: epochOf(ms), consequence: "modify_user", purpose: "再看下一封" } },
        { name: "finish", args: { outcome: "done", summary: "已回复" } },
      ] }),
      { calls: [{ name: "finish", args: { outcome: "done", summary: "选中了那封邮件，没有发" } }] },
    ];
    rt = new FrontierRuntime({ task: "t1", raw: RAW, executor: ex, signer, user, gateway: gw, model: { ...model, streamFn: scriptedStream(steps, seen) } });
    const r = await rt.run();
    expect(r.status).toBe("succeeded");
    const results = seen[6]!.filter((m) => m.role === "toolResult").slice(-3).map((m: any) => m.content[0].text as string);
    expect(results[0]).toContain("用户改了要求");
    expect(results[1]).toContain("在那之前决定的，没有做");
    expect(results[2]).toContain("在那之前决定的，没有做");
    expect(sim.mailState(w).selected).toBe("m1");
    expect(sim.mailState(w).replies).toEqual([]);
    expect(r.verdicts).toHaveLength(1);
  });

  it("act takes no file action: a file goes through `file`, which makes what the capability derives itself", async () => {
    const { sim } = mail();
    const signer = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: signer.publicKey });
    const svc = new ExecutorService({ task: "t1", raw: RAW, executor: ex, signer, user: { ask: () => null }, gateway: judge().gw });
    await svc.port.begin();
    const rep = await svc.port.act({ action: { kind: "file", capability: "fs.transform_text", args: { path: "a.txt", text: "mine" } }, epoch: 0, consequence: "read", purpose: "x" });
    expect(rep).toMatchObject({ isError: true });
    expect(ex.receipts).toHaveLength(0);
  });

  it("app-run: a voided card is closed for the app (resumed, voided) and a late answer to it answers nothing", async () => {
    const input = new PassThrough();
    const sent: AppEvent[] = [];
    const log = new EventLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "port-test-")), "e.jsonl"), "r1", (ev) => sent.push(ev));
    const reader = new LineReader(input);
    const u = new StdioUser(log, reader);
    const card: Card = { kind: "action", text: "点「发送」", free_text: false, blocking: true, options: [{ kind: "approve", text: "可以" }, { kind: "cancel", text: "先别做了" }] };
    const voids = new AbortController();
    const p1 = u.ask(card, { signal: voids.signal });
    await new Promise((r) => setTimeout(r, 10));
    const first = (sent.find((e) => e.kind === "ask") as Extract<AppEvent, { kind: "ask" }>).ask_id;
    voids.abort();
    expect(await p1).toBeNull();
    expect(sent.at(-2)).toMatchObject({ kind: "resumed", ask_id: first, voided: "steer" });
    expect(sent.at(-1)).toMatchObject({ kind: "ask_void", ask_id: first, why: "steer" });      // M0: the card's own ending
    // the next card: the answer the user gave the voided one arrives first and is refused; then the real answer
    const p2 = u.ask(card);
    await new Promise((r) => setTimeout(r, 10));
    const second = (sent.filter((e) => e.kind === "ask").at(-1) as Extract<AppEvent, { kind: "ask" }>).ask_id;
    input.write(JSON.stringify({ type: "answer", ask_id: first, option: 0 }) + "\n");
    input.write(JSON.stringify({ type: "answer", ask_id: second, option: 1 }) + "\n");
    expect(await p2).toEqual({ option: 1 });
    expect(sent.some((e) => e.kind === "refused" && e.what === `answer for ${first}`)).toBe(true);
    // after a void, an answer that names no card (the old untyped form) may be the voided card's: it answers nothing
    const p3 = u.ask(card);
    await new Promise((r) => setTimeout(r, 10));
    const third = (sent.filter((e) => e.kind === "ask").at(-1) as Extract<AppEvent, { kind: "ask" }>).ask_id;
    input.write(JSON.stringify({ option: 0 }) + "\n");
    input.write(JSON.stringify({ type: "answer", ask_id: third, option: 1 }) + "\n");
    expect(await p3).toEqual({ option: 1 });
    expect(sent.some((e) => e.kind === "refused" && e.what === "an answer without ask_id")).toBe(true);
  });
});

describe("executor port: the runtime cannot sign", () => {
  it("no runtime source names a signer or a signing call", () => {
    const dir = path.resolve(import.meta.dirname, "..", "src", "runtime");
    const files = fs.readdirSync(dir, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    const hits = files.flatMap((f) => fs.readFileSync(path.join(dir, f), "utf-8").split("\n").map((l, i) => [f, i + 1, l] as const)
      .filter(([, , l]) => /ConsentSigner|ConsentProvider|forAction|forObject|forSite|privateKey|ConsentToken|\bsigner\b/.test(l)).map(([f, i]) => `${f}:${i}`));
    expect(hits).toEqual([]);
  });

  it("the port is its methods and nothing else: no signer, no executor to reach through it", () => {
    const { sim } = mail();
    const signer = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: signer.publicKey });
    const svc = new ExecutorService({ task: "t1", raw: RAW, executor: ex, signer, user: { ask: () => null }, gateway: judge().gw });
    const port = svc.port as unknown as Record<string, unknown>;
    expect(Object.isFrozen(port)).toBe(true);
    expect(Object.keys(port).sort()).toEqual(["act", "answer", "askUser", "begin", "classify", "end", "file", "finish", "observe", "plan", "readSkill", "snapshot", "steers"]);
    expect(Object.values(port).every((v) => typeof v === "function")).toBe(true);
    // the service keeps the signer in a private field: not a property anyone can read
    expect(Object.values(svc).some((v) => v === signer)).toBe(false);
    expect((svc as any).signer).toBeUndefined();
    // and the loop is built from the port, the model and the budget only
    const rt = new FrontierRuntime({ task: "t1", raw: RAW, executor: ex, signer, user: { ask: () => null }, gateway: judge().gw, model: { ...model, streamFn: scriptedStream([]) } });
    expect(Object.keys((rt as any).loop.o).sort()).toEqual(["budget", "model", "onEvent", "port", "raw"]);
  });

  it("a consent a caller passes along with an action is not used: the executor asks the user itself", async () => {
    const { sim, w } = mail();
    const signer = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: signer.publicKey });
    const cards: Card[] = [];
    const svc = new ExecutorService({ task: "t1", raw: RAW, executor: ex, signer, user: { ask: (c) => { cards.push(c); return { option: c.options.findIndex((o) => o.kind === "skip_step") }; } }, gateway: judge().gw });
    const port = svc.port;
    await port.begin();
    await port.plan({ steps: [{ purpose: "看看", objects: [], consequence: "read" }] });
    const obs = await port.observe(w);
    // a valid token for this very window, signed with the app's own key: a caller that somehow had one still cannot use it
    const forged = signer.forObject(`window:${w}`, "modify_user", "t1");
    const rep = await port.act({ action: { kind: "click", window: w, target: `${w}:0:row:m1` }, epoch: obs.epoch, consequence: "modify_user", purpose: "选中邮件", consent: forged } as any);
    expect(cards.map((c) => c.kind)).toEqual(["action"]);
    expect(rep.text).toContain("用户不同意这一步");
    expect(sim.mailState(w).selected).toBeNull();
    // the token itself was good: handed to the executor directly, it covers the click
    const again = await ex.observe(w);
    expect((await ex.act({ action: { kind: "click", window: w, target: `${w}:0:row:m1` }, epoch: again.epoch, consequence: "modify_user", consent: forged })).status).toBe("ok");
  });
});

describe("executor port: nothing after the end", () => {
  /** A bare port caller on the mail window with an accepted plan for it. */
  async function settledOn(how: "done" | "cancel") {
    const { sim, w } = mail();
    const signer = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: signer.publicKey });
    const cards: string[] = [];
    const events: { kind: string; body: Record<string, unknown> }[] = [];
    const svc = new ExecutorService({ task: "t1", raw: "把林晓的邮件标上旗标", executor: ex, signer, gateway: judge().gw, onEvent: (kind, body) => events.push({ kind, body }),
      user: { ask: (c) => { cards.push(c.kind); return c.kind === "plan" ? approve(c) : { option: c.options.findIndex((o) => o.kind === "cancel") }; } } });
    const port = svc.port;
    await port.begin();
    expect((await port.plan({ steps: [{ purpose: "标旗标", objects: [`window:${w}`], consequence: "modify_user" }] })).text).toContain("用户同意了计划");
    const settle = how === "done" ? await port.finish({ outcome: "done", summary: "done" }) : await port.askUser({ question: "继续吗", options: ["是"] });
    expect(settle.done).toBe(true);
    return { sim, w, ex, port, svc, cards, events };
  }

  for (const how of ["done", "cancel"] as const) {
    it(`after ${how === "done" ? "a passing verdict" : "the user cancelled"}, no step is done, even one the plan's token covers`, async () => {
      const { sim, w, ex, port, cards } = await settledOn(how);
      const o = await port.observe(w);
      const r = await port.act({ action: { kind: "click", window: w, target: `${w}:0:row:m1` }, epoch: o.epoch, consequence: "modify_user", purpose: "after the end" });
      expect(r).toMatchObject({ isError: true, done: true });
      for (const rep of [await port.plan({ steps: [] }), await port.askUser({ question: "?", options: [] }), await port.answer({ text: "x" }), await port.finish({ outcome: "done", summary: "again" }), await port.file({ capability: "fs.write_text", args: {} })]) expect(rep).toMatchObject({ done: true });
      expect(sim.mailState(w).selected).toBeNull();
      expect(ex.receipts).toHaveLength(0);
      expect(cards).toEqual(how === "done" ? ["plan"] : ["plan", "missing"]);
      expect((await port.end()).status).toBe(how === "done" ? "succeeded" : "cancelled");
      // and after end, still nothing
      expect(await port.act({ action: { kind: "wait", ms: 1 }, epoch: 0, consequence: "read", purpose: "x" })).toMatchObject({ done: true });
    });
  }

  it("begin is called once", async () => {
    const { port } = await settledOn("done");
    await expect(port.begin()).rejects.toThrow(/already/);
  });

  it("a steer after the task is over is refused, and the app is told", async () => {
    const { svc, events } = await settledOn("done");
    svc.steer("算了，换成周会纪要那封");
    const e = events.find((x) => x.kind === "steer.refused")!;
    expect(e.body).toMatchObject({ raw: "算了，换成周会纪要那封", why: "the task already finished" });
    expect(toProtocol(e.kind, e.body)).toEqual({ kind: "refused", what: "steer: 算了，换成周会纪要那封", why: "the task already finished", by: "executor" });
    expect(events.some((x) => x.kind === "steer")).toBe(false);
  });
});

describe("executor port: a steer withdraws the plan's consent", () => {
  it("「别动这个窗口了」: the window the plan covered asks again (a new plan first), nothing is done on the old yes", async () => {
    const { sim, w } = mail();
    const signer = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: signer.publicKey });
    const cards: string[] = [];
    const svc = new ExecutorService({ task: "t1", raw: RAW, executor: ex, signer, gateway: judge().gw, user: { ask: (c) => { cards.push(c.kind); return approve(c); } } });
    const port = svc.port;
    await port.begin();
    await port.plan({ steps: [{ purpose: "回复林晓", objects: [`window:${w}`], consequence: "modify_user" }] });
    let o = await port.observe(w);
    // covered by the plan: no card
    expect((await port.act({ action: { kind: "click", window: w, target: `${w}:0:row:m1` }, epoch: o.epoch, consequence: "modify_user", purpose: "选中" })).isError).toBeFalsy();
    svc.steer("别动这个窗口了");
    expect(await port.steers()).toEqual(["别动这个窗口了"]);
    o = await port.observe(w);
    const r = await port.act({ action: { kind: "click", window: w, target: `${w}:0:row:m2` }, epoch: o.epoch, consequence: "modify_user", purpose: "选中另一封" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("先按新要求交一份新计划");
    expect(sim.mailState(w).selected).toBe("m1");
    expect(cards).toEqual(["plan"]);
  });
});

describe("executor port: review of #41 (Codex)", () => {
  it("app-run: a steer in the same stdin batch as the request waits for its handler instead of being dropped", async () => {
    const input = new PassThrough();
    const reader = new LineReader(input);
    input.write(JSON.stringify({ raw: "整理下载文件夹" }) + "\n" + JSON.stringify({ type: "steer", text: "只整理今天的" }) + "\n");
    expect(JSON.parse(await reader.next())).toEqual({ raw: "整理下载文件夹" });
    await new Promise((r) => setTimeout(r, 10));
    const got: string[] = [];
    reader.onSteer = (t) => got.push(t);
    expect(got).toEqual(["只整理今天的"]);
    input.write(JSON.stringify({ type: "steer", text: "再加上昨天的" }) + "\n");
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(["只整理今天的", "再加上昨天的"]);
  });

  it("an answer decided before a steer is not given: it is refused like any other step, and never reaches the result", async () => {
    const { sim, w } = mail();
    const signer = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: signer.publicKey });
    const { gw } = judge();
    const events: string[] = [];
    let rt!: FrontierRuntime;
    const steps: Step[] = [
      { calls: [{ name: "computer_observe", args: { window: w } }] },
      // the user switches to the meeting time while the model is deciding the budget answer
      () => { rt.steer("不问预算了，告诉我会议几点"); return { calls: [{ name: "answer", args: { text: "预算是 50 万" } }, { name: "finish", args: { outcome: "done", summary: "答了预算" } }] }; },
      { calls: [{ name: "answer", args: { text: "14:00" } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "答了会议时间" } }] },
    ];
    rt = new FrontierRuntime({ task: "t1", raw: "林晓那封 Q3 预算邮件里预算是多少？", executor: ex, signer, user: { ask: approve }, gateway: gw, model: { ...model, streamFn: scriptedStream(steps) }, onEvent: (k, b) => { if (k === "answer.given") events.push(String(b.text)); } });
    const r = await rt.run();
    expect(r.status).toBe("succeeded");
    expect(events).toEqual(["14:00"]);
    expect(r.answer).toBe("14:00");
  });

  it("a long steer reaches the model whole, as a user message compaction never cuts", async () => {
    const { sim, w } = mail();
    const signer = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: signer.publicKey });
    const { gw } = judge();
    const long = "改一下要求：" + "这是用户补充的背景说明。".repeat(45) + "最后一条约束：只回复林晓本人，不要抄送任何人。";
    expect(long.length).toBeGreaterThan(540);
    let rt!: FrontierRuntime;
    const seen: Message[][] = [];
    const look: Step = { calls: [{ name: "computer_observe", args: { window: w } }] };
    const steps: Step[] = [
      look,
      // the steer arrives while the model decides; the step it decided comes back with the words
      (ms) => { rt.steer(long); return act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "modify_user")(ms); },
      // many looks after: the old tool results get cut down to stubs
      ...Array(9).fill(look),
      { calls: [{ name: "finish", args: { outcome: "cannot", summary: "test" } }] },
    ];
    // a small window, so compaction runs
    rt = new FrontierRuntime({ task: "t1", raw: RAW, executor: ex, signer, user: { ask: approve }, gateway: gw, model: { model: { ...model.model, contextWindow: 9000 }, streamFn: scriptedStream(steps, seen) } });
    let compactions = 0;
    await rt.run();
    compactions = rt.counters["compactions"] ?? 0;
    expect(compactions).toBeGreaterThan(0);
    const lastCtx = seen.at(-1)!;
    // the tool result that carried it was cut; the user message is whole, trailing constraint included
    expect(lastCtx.some((m: any) => m.role === "toolResult" && m.content[0].text.includes("已省略") && m.content[0].text.startsWith("用户改了要求"))).toBe(true);
    const user = lastCtx.filter((m: any) => m.role === "user" && typeof m.content === "string" && m.content.includes("用户改了要求"));
    expect(user).toHaveLength(1);
    expect((user[0] as any).content).toContain("最后一条约束：只回复林晓本人，不要抄送任何人。");
  });
});
