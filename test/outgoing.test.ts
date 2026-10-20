/**
 * "Will this send something out?" (docs/outgoing-check-2026-10-20.md): the judge decides for screen actions that change
 * something, the name list and Return are only evidence, the judge only raises, no answer is external, a lower tier
 * settles only「会发出去」alone and its「不会」is compared with the top's answer every time. Scripted gateways, fake
 * drivers: no model is called.
 */
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/index.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor, pixelSendBindingFrom, sameScreen, type ExecutorOptions } from "../src/executor/executor.js";
import { INTENT_QUESTION, Judge, OUTGOING_QUESTION, TierStats, type JudgeTier } from "../src/executor/judge.js";
import { McpExecutorServer } from "../src/cli/mcp.js";
import type { Action, Driver, Element, WindowInfo } from "../src/executor/types.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
const isOutgoing = (u: string) => u.includes(OUTGOING_QUESTION.slice(0, 12));

interface FakeWin { info: WindowInfo; elements: Element[]; text: string }
/** A desktop of fixed windows: actions are logged and move the epoch, the windows' contents never change — as a window
 *  read by text recognition, which does not read the input box back. `open_window` opens `opens` as the task's. */
class FakeDesk implements Driver {
  epoch = 1;
  log: Action[] = [];
  /** false: actions do not move the epoch (hands#49 counts only input into the task's apps) */
  bumps = true;
  constructor(public wins: FakeWin[], private readonly opens?: FakeWin) {}
  snapshot() { return { epoch: this.epoch, locked: false, front_app: this.wins[0]?.info.app ?? "", windows: this.wins.map((w) => w.info) }; }
  observe(id: string) { const w = this.wins.find((x) => x.info.id === id)!; return { epoch: this.epoch, window: w.info, modal: null, elements: w.elements, text: w.text }; }
  perform(a: Action) {
    this.log.push(a); if (this.bumps) this.epoch += 1;
    if (a.kind === "open_window" && this.opens) { this.wins.push(this.opens); return { status: "ok" as const, window: this.opens.info.id, new_window: this.opens.info }; }
    return { status: "ok" as const, window: "window" in a ? a.window : undefined };
  }
}

/** A chat app hands reads from the screen: text recognition's rows (the「发送」 among them, a listitem hands' name list
 *  does not mark) and the search box hands always offers. */
const chat = (): FakeWin => ({
  info: { id: "chat", app: "聊天", title: "张三" },
  elements: [
    { id: "ocr:0", role: "listitem", label: "张三：明天开会吗？", actions: ["click"] },
    { id: "ocr:1", role: "listitem", label: "输入消息…", actions: ["click", "type"] },
    { id: "ocr:2", role: "listitem", label: "发送", actions: ["click"] },
    { id: "gen:search", role: "textField", label: "搜索", actions: ["click", "type"] },
  ],
  text: "张三：明天开会吗？\n输入消息…\n发送",
});

/** One judge tier (or two) over scripted gateways; `outgoing` answers the outgoing question, the intent check matches. */
function judged(outgoing: (u: string) => unknown, extra: Partial<{ lower: (u: string) => unknown; stats: TierStats; events: Record<string, unknown>[] }> = {}) {
  const top = new Gateway(table), prompts: string[] = [];
  top.script = Array(80).fill((_r: string, _s: string, u: string) => { prompts.push(u); return isOutgoing(u) ? outgoing(u) : { choice: "matches" }; });
  const tiers: JudgeTier[] = [];
  let low: Gateway | null = null;
  if (extra.lower) { low = new Gateway(table); low.script = Array(80).fill((_r: string, _s: string, u: string) => extra.lower!(u)); tiers.push({ name: "brain", gateway: low, floor: 0.9 }); }
  tiers.push({ name: "frontier", gateway: top });
  return { judge: new Judge(tiers, { stats: extra.stats, onEvent: (k, b) => extra.events?.push({ k, ...b }) }), top, low, prompts };
}

async function setup(wins: FakeWin[], judge?: Judge, opens?: FakeWin, more: Partial<ExecutorOptions> = {}) {
  const desk = new FakeDesk(wins, opens), app = ConsentSigner.fresh();
  const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, judge, raw: "回张三：明天见", ...more });
  await ex.begin();
  await ex.plan({ steps: [] });
  return { desk, app, ex };
}

describe("outgoing check: a window read from the screen", () => {
  it("typing then Return asks for a send, with the typed text on the card; changed text asks again", async () => {
    const { judge, prompts } = judged(() => ({ choice: "sends", reason: "聊天窗口里打了字再回车，就是发消息" }));
    const { desk, app, ex } = await setup([chat()], judge);
    const mine = app.forObject("window:chat", "modify_user", "t1");
    let o = await ex.observe("chat");
    // typing (no newline) is not a send question: the user's window, consented by the plan's object token
    expect((await ex.act({ action: { kind: "type", window: "chat", target: "ocr:1", text: "明天见" }, epoch: o.epoch, consent: mine })).status).toBe("ok");
    o = await ex.observe("chat");
    const ret: Action = { kind: "key", window: "chat", chord: "return" };
    const r = await ex.act({ action: ret, epoch: o.epoch, consent: mine });
    expect(r).toMatchObject({ status: "needs_consent", consequence: "external" });
    expect(r.challenge!.text).toContain("明天见");                       // the screen did not show it; the card does
    expect(desk.log.filter((a) => a.kind === "key")).toEqual([]);
    // the judge saw the evidence: the typed text, the key, where the elements came from, the old hint as a hint
    const asked = prompts.filter(isOutgoing).at(-1)!;
    expect(asked).toContain("明天见");
    expect(asked).toContain("return");
    expect(asked).toContain("画面");
    expect(asked).toContain("回车或换行");
    expect(asked).not.toContain("回张三");                                // facts only, not the user's words
    // the user approves that card; the task then types more before pressing Return: another send, asked again
    const token = app.forAction(r.challenge!);
    expect((await ex.act({ action: { kind: "type", window: "chat", target: "ocr:1", text: "，不见不散" }, epoch: r.epoch, consent: mine })).status).toBe("ok");
    o = await ex.observe("chat");
    const again = await ex.act({ action: ret, epoch: o.epoch, consent: token });
    expect(again.status).toBe("needs_consent");
    expect(again.challenge!.text).toContain("不见不散");
    expect(desk.log.filter((a) => a.kind === "key")).toEqual([]);
    const ok = await ex.act({ action: ret, epoch: o.epoch, consent: app.forAction(again.challenge!) });
    expect(ok.status).toBe("ok");
    expect(desk.log.at(-1)).toEqual(ret);
  });

  it("a click on the「发送」text recognition read is a send (a listitem the name list does not mark)", async () => {
    const { judge } = judged(() => ({ choice: "sends" }));
    const { ex, app } = await setup([chat()], judge);
    const o = await ex.observe("chat");
    const r = await ex.act({ action: { kind: "click", window: "chat", target: "ocr:2" }, epoch: o.epoch, consent: app.forObject("window:chat", "modify_user", "t1") });
    expect(r).toMatchObject({ status: "needs_consent", consequence: "external" });
    // without a judge the old floor has nothing to go on here: the gap the judge closes
    const { ex: bare } = await setup([chat()]);
    await bare.observe("chat");
    expect(bare.floor({ kind: "click", window: "chat", target: "ocr:2" }).consequence).toBe("modify_user");
  });

  it("hands' `source` is taken when present: an element with an ax-looking id but source pixels is from the screen", async () => {
    const { judge, prompts } = judged(() => ({ choice: "stays" }));
    const w = chat(); w.elements = [{ id: "e1", role: "button", label: "确定", actions: ["click"], source: "pixels" }];
    const { ex } = await setup([w], judge);
    const o = await ex.observe("chat");
    await ex.classify({ kind: "click", window: "chat", target: "e1" }, o.epoch);
    expect(prompts.filter(isOutgoing).at(-1)).toContain("画面");
  });
});

describe("outgoing check: accessibility windows", () => {
  const compose = (owner: "user" | "task"): FakeWin => ({
    info: { id: owner === "user" ? "mailw" : "mine", app: "邮件", title: "新邮件" },
    elements: [
      { id: "to", role: "textField", label: "收件人", value: "zhang@example.com", actions: ["set_value"] },
      { id: "body", role: "textArea", label: "正文", value: "附件是合同", actions: ["set_value", "type"] },
      { id: "b7", role: "button", label: "", actions: ["click"] },                       // an icon-only send button
    ],
    text: "",
  });

  it("an unlabelled button the judge says sends is external", async () => {
    const { judge } = judged(() => ({ choice: "sends" }));
    const { ex, app } = await setup([compose("user")], judge);
    const o = await ex.observe("mailw");
    const r = await ex.act({ action: { kind: "click", window: "mailw", target: "b7" }, epoch: o.epoch, consent: app.forObject("window:mailw", "modify_user", "t1") });
    expect(r).toMatchObject({ status: "needs_consent", consequence: "external" });
    expect(r.challenge!.text).toContain("附件是合同");                    // the filled-in fields, as before
  });

  it("a judge with no answer is a send", async () => {
    const { judge } = judged(() => ({ outcome: "error", error: "down" }));
    const { ex, app } = await setup([compose("user")], judge);
    const o = await ex.observe("mailw");
    const action: Action = { kind: "click", window: "mailw", target: "b7" };
    expect(await ex.classify(action, o.epoch)).toMatchObject({ consequence: "external", by: "no_answer" });
    expect((await ex.act({ action, epoch: o.epoch, consent: app.forObject("window:mailw", "modify_user", "t1") })).status).toBe("needs_consent");
  });

  it("a site search's Return the judge says stays is not a send: no card, though the window has a「提交」the name list marks", async () => {
    const site: FakeWin = {
      info: { id: "site", app: "浏览器", title: "帮助中心" },
      elements: [
        { id: "q", role: "textField", label: "搜索本站", actions: ["set_value", "type"] },
        { id: "submit", role: "button", label: "提交", actions: ["click"], sends: true },
      ],
      text: "帮助中心",
    };
    const { judge, prompts } = judged(() => ({ choice: "stays", reason: "站内搜索" }));
    const { ex, desk } = await setup([], judge, site);
    const opened = await ex.act({ action: { kind: "open_window", app: "浏览器" }, epoch: (await ex.snapshot()).epoch });
    expect(opened.status).toBe("ok");
    let o = await ex.observe("site");
    expect((await ex.act({ action: { kind: "type", window: "site", target: "q", text: "退款" }, epoch: o.epoch })).status).toBe("ok");
    o = await ex.observe("site");
    const ret: Action = { kind: "key", window: "site", chord: "return" };
    expect(ex.floor(ret).consequence).toBe("external");                       // the old rule would have asked
    const r = await ex.act({ action: ret, epoch: o.epoch });
    expect(r).toMatchObject({ status: "ok", consequence: "create" });
    expect(desk.log.at(-1)).toEqual(ret);
    const asked = prompts.filter(isOutgoing).at(-1)!;
    expect(asked).toContain("退款");                                        // the typed text is evidence
    expect(asked).toMatch(/"窗口里有名字命中发送词表的控件": true/);           // and so is the name list
  });

  it("the judge only raises: a model that said external stays external, and is not asked about", async () => {
    const { judge, top } = judged(() => ({ choice: "stays" }));
    const { ex } = await setup([compose("task")], judge);
    const o = await ex.observe("mine");
    const before = top.script.length;
    expect(await ex.classify({ kind: "click", window: "mine", target: "b7" }, o.epoch, "external")).toMatchObject({ consequence: "external", by: "model" });
    expect(top.script.length).toBe(before);
  });
});

describe("outgoing check: tiers", () => {
  const button = (n: number): FakeWin => ({ info: { id: "w", app: "应用", title: "窗口" }, elements: Array.from({ length: n }, (_, i) => ({ id: `b${i}`, role: "button", label: `按钮${i}`, actions: ["click"] })), text: "" });

  it("Brain's「不会」is not final: it goes up, the top decides, and the agreement is counted per Brain answer", async () => {
    const stats = new TierStats();
    const answers = ["stays", "sends"];
    const { judge } = judged(() => ({ choice: answers.shift() }), { lower: () => ({ choice: "stays", scores: { stays: 0.97, sends: 0.03 } }), stats });
    const { ex } = await setup([button(2)], judge);
    const o = await ex.observe("w");
    expect(await ex.classify({ kind: "click", window: "w", target: "b0" }, o.epoch)).toMatchObject({ consequence: "modify_user", by: "frontier" });
    expect(await ex.classify({ kind: "click", window: "w", target: "b1" }, o.epoch)).toMatchObject({ consequence: "external", by: "frontier" });
    const kind = TierStats.kindOf(OUTGOING_QUESTION, { 对象: "window:w" });
    expect(stats.snapshot().brain![kind]).toMatchObject({ asked: 2, settled: 0, escalated: { stays: { compared: 2, agreed: 1 } } });
  });

  it("Brain's「会发出去」above its floor settles alone", async () => {
    const { judge, top } = judged(() => ({ choice: "stays" }), { lower: () => ({ choice: "sends", scores: { sends: 0.95, stays: 0.05 } }) });
    const { ex } = await setup([button(1)], judge);
    const o = await ex.observe("w");
    const before = top.script.length;
    expect(await ex.classify({ kind: "click", window: "w", target: "b0" }, o.epoch)).toMatchObject({ consequence: "external", by: "brain" });
    expect(top.script.length).toBe(before);
  });

  it("the routing rule does not take this question away from Brain, however rarely it settles", async () => {
    const events: Record<string, unknown>[] = [];
    const { judge, low } = judged(() => ({ choice: "stays" }), { lower: () => ({ choice: "stays", scores: { stays: 0.99 } }), stats: new TierStats(), events });
    const { ex } = await setup([button(12)], judge);
    const o = await ex.observe("w");
    for (let i = 0; i < 12; i++) await ex.classify({ kind: "click", window: "w", target: `b${i}` }, o.epoch);
    expect(80 - low!.script.length).toBe(12);
    expect(events.some((e) => e.k === "judge.skipped")).toBe(false);
  });

  it("its kind differs from the intent check's (the routing table groups by the first 12 characters)", () => {
    expect(TierStats.kindOf(OUTGOING_QUESTION)).not.toBe(TierStats.kindOf(INTENT_QUESTION));
  });

  it("an existing question keeps its old rule: a lower tier settles only the first option, and is skipped when it rarely does", async () => {
    const stats = new TierStats();
    const low = new Gateway(table), top = new Gateway(table);
    low.script = Array(20).fill(() => ({ choice: "b", scores: { b: 0.99 } }));
    top.script = Array(20).fill(() => ({ choice: "b" }));
    const judge = new Judge([{ name: "low", gateway: low, floor: 0.9 }, { name: "top", gateway: top }], { stats });
    for (let i = 0; i < 9; i++) expect((await judge.choose("某个老问题", { i }, [{ id: "a", text: "a" }, { id: "b", text: "b" }]))?.by).toBe("top");
    expect(20 - low.script.length).toBe(8);                                     // the 9th skipped the lower tier
    expect(stats.snapshot().low!["某个老问题"]!.escalated).toEqual({ b: { compared: 8, agreed: 8 } });
  });
});

describe("outgoing check: classify over MCP", () => {
  it("the read-only classify tool answers what act then decides, and act does not ask the judge again", async () => {
    const gw = new Gateway(table);
    let outgoingAsked = 0;
    gw.script = Array(20).fill((role: string, _s: string, u: string) => (isOutgoing(u) ? (outgoingAsked += 1, { choice: "sends" }) : role === "verify" ? { choice: "pass" } : { choice: "matches" }));
    const desk = new FakeDesk([{ info: { id: "w", app: "邮件", title: "新邮件" }, elements: [{ id: "b7", role: "button", label: "", actions: ["click"] }], text: "" }]);
    const s = new McpExecutorServer({ driver: () => desk, gateway: gw, consent: "none" });
    let n = 0;
    const call = async (name: string, args: unknown = {}) => ((await s.handle({ jsonrpc: "2.0", id: ++n, method: "tools/call", params: { name, arguments: args } as never })) as any).result.structuredContent;
    await call("begin", { raw: "把合同发给张三" });
    await call("plan", { steps: [] });
    const o = await call("observe", { window: "w" });
    const action = { kind: "click", window: "w", target: "b7" };
    const c = await call("classify", { action, epoch: o.epoch });
    expect(c).toMatchObject({ consequence: "external", object: "window:w", by: "frontier", needs_consent: true });
    const r = await call("act", { action, epoch: o.epoch, consequence: "read" });          // a caller's low class changes nothing
    expect(r).toMatchObject({ status: "needs_consent", consequence: c.consequence, object: c.object });
    expect(outgoingAsked).toBe(1);
    expect(desk.log).toEqual([]);
  });
});

describe("outgoing check: in the agent loop", () => {
  it("a site search's Return in the user's window, cleared by the judge, goes under the plan's object consent: no extra card", async () => {
    const { FrontierRuntime } = await import("../src/runtime/loop.js");
    const { scriptedStream } = await import("../src/runtime/scripted.js");
    const site: FakeWin = {
      info: { id: "site", app: "浏览器", title: "帮助中心" },
      elements: [{ id: "q", role: "textField", label: "搜索本站", actions: ["set_value", "type"] }, { id: "submit", role: "button", label: "提交", actions: ["click"], sends: true }],
      text: "帮助中心",
    };
    const desk = new FakeDesk([site]), app = ConsentSigner.fresh();
    const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey });
    const gw = new Gateway(table);
    gw.script = Array(40).fill((role: string, _s: string, u: string) => (role === "verify" ? { choice: "pass", reason: "ok" } : isOutgoing(u) ? { choice: "stays" } : { choice: "matches" }));
    const lastEpoch = (ms: any[]) => { const m = [...ms].reverse().find((x) => x.role === "toolResult"); const j = JSON.parse(m.content[0].text.split("\n")[0]); return j.after?.epoch ?? j.epoch; };
    const act = (action: Record<string, unknown>) => (ms: any[]) => ({ calls: [{ name: "computer_act", args: { action, epoch: lastEpoch(ms), consequence: "modify_user", purpose: "搜索" } }] });
    const steps: any[] = [
      { calls: [{ name: "plan", args: { steps: [{ purpose: "在帮助中心搜索退款", objects: ["window:site"], consequence: "modify_user" }] } }] },
      { calls: [{ name: "computer_observe", args: { window: "site" } }] },
      act({ kind: "type", window: "site", target: "q", text: "退款" }),
      { calls: [{ name: "computer_observe", args: { window: "site" } }] },
      act({ kind: "key", window: "site", chord: "return" }),
      { calls: [{ name: "finish", args: { outcome: "done", summary: "搜了退款" } }] },
    ];
    const cards: { kind: string }[] = [];
    const user = { ask: (c: any) => { cards.push(c); return { option: c.options.findIndex((o: any) => o.kind === "approve") }; } };
    const model = { model: { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as any };
    const rt = new FrontierRuntime({ task: "t1", raw: "在帮助中心搜一下退款", executor: ex, signer: app, user, gateway: gw, model: { ...model, streamFn: scriptedStream(steps) } });
    const r = await rt.run();
    expect(cards.map((c) => c.kind)).toEqual(["plan"]);
    expect(desk.log.at(-1)).toEqual({ kind: "key", window: "site", chord: "return" });
    expect(r.status).toBe("succeeded");
  });
});

describe("outgoing check: review of #23", () => {
  it("a class judged on an older observation is not kept under a newer epoch: 「预览」 judged, 「发送」 clicked asks per action", async () => {
    const asked: string[] = [];
    const { judge } = judged((u) => { const s = /"名字": "发送"/.test(u.split("窗口里标了")[0]!); asked.push(s ? "sends" : "stays"); return { choice: s ? "sends" : "stays" }; });
    const w: FakeWin = { info: { id: "w", app: "Mail", title: "回复" }, elements: [{ id: "ax:3", role: "button", label: "预览", actions: ["click"] }], text: "" };
    const { ex, desk, app } = await setup([w], judge);
    await ex.observe("w");                                                              // epoch 1: ax:3 is 预览
    w.elements = [{ id: "ax:3", role: "button", label: "发送", actions: ["click"], sends: true }]; desk.epoch = 2;
    const a: Action = { kind: "click", window: "w", target: "ax:3" };
    expect(await ex.classify(a, 2)).toMatchObject({ consequence: "external" });         // the model took epoch 2 from a snapshot
    expect(asked).toEqual([]);                                                          // nothing asked about an old look
    await ex.observe("w");                                                              // epoch 2: ax:3 is 发送
    const r = await ex.act({ action: a, epoch: 2, consent: app.forObject("window:w", "modify_user", "t1") });
    expect(r).toMatchObject({ status: "needs_consent", consequence: "external" });
    expect(desk.log).toEqual([]);
  });

  it("the text typed so far is part of the cache key: typed more on the same epoch, the judge is asked again", async () => {
    const answers = ["stays", "sends"];
    const { judge } = judged(() => ({ choice: answers.shift() }));
    const { ex, desk, app } = await setup([chat()], judge);
    desk.bumps = false;
    const o = await ex.observe("chat");
    const ret: Action = { kind: "key", window: "chat", chord: "return" };
    expect((await ex.classify(ret, o.epoch)).consequence).toBe("modify_user");
    expect((await ex.act({ action: { kind: "type", window: "chat", target: "ocr:1", text: "明天见" }, epoch: o.epoch, consent: app.forObject("window:chat", "modify_user", "t1") })).status).toBe("ok");
    expect(desk.epoch).toBe(o.epoch);
    expect(await ex.classify(ret, o.epoch)).toMatchObject({ consequence: "external", by: "frontier" });
    expect(answers).toEqual([]);
  });

  it("a target on hands' name list stays external whatever the judge says, and the judge is not asked", async () => {
    let asked = 0;
    const { judge } = judged(() => { asked += 1; return { choice: "stays" }; });
    const w: FakeWin = { info: { id: "w", app: "邮件", title: "新邮件" }, elements: [{ id: "send", role: "button", label: "发送", actions: ["click"], sends: true }], text: "" };
    const { ex } = await setup([w], judge);
    const o = await ex.observe("w");
    expect(await ex.classify({ kind: "click", window: "w", target: "send" }, o.epoch)).toMatchObject({ consequence: "external", by: "structure" });
    expect(asked).toBe(0);
  });

  it("a key without Return is not asked about", async () => {
    let asked = 0;
    const { judge } = judged(() => { asked += 1; return { choice: "sends" }; });
    const { ex } = await setup([chat()], judge);
    const o = await ex.observe("chat");
    expect(await ex.classify({ kind: "key", window: "chat", chord: "cmd+a" }, o.epoch)).toMatchObject({ consequence: "modify_user", by: "structure" });
    expect(await ex.classify({ kind: "key", window: "chat", chord: "cmd+enter" }, o.epoch)).toMatchObject({ consequence: "external" });
    expect(asked).toBe(1);
  });

  it("typed text is taken as gone only after a certain send: not after「拿不准」on an attach button; the card shows it even when the history has the words", async () => {
    const w = chat();
    w.elements.push({ id: "icon:attach", role: "button", label: "附件", actions: ["click"] });
    w.text = "张三：明天见\n输入消息…\n发送";                                            // the history holds the same words
    const { judge } = judged((u) => ({ choice: /"名字": "附件"/.test(u.split("窗口里标了")[0]!) ? "unsure" : "sends" }));   // the target's own name only
    const { ex, app } = await setup([w], judge);
    const mine = app.forObject("window:chat", "modify_user", "t1");
    let o = await ex.observe("chat");
    await ex.act({ action: { kind: "type", window: "chat", target: "ocr:1", text: "明天见" }, epoch: o.epoch, consent: mine });
    o = await ex.observe("chat");
    const attach: Action = { kind: "click", window: "chat", target: "icon:attach" };
    const r1 = await ex.act({ action: attach, epoch: o.epoch, consent: mine });
    expect(r1).toMatchObject({ status: "needs_consent", consequence: "external" });
    expect(r1.challenge!.text).toContain("这次任务打的字：明天见");
    expect((await ex.act({ action: attach, epoch: o.epoch, consent: app.forAction(r1.challenge!) })).status).toBe("ok");
    o = await ex.observe("chat");
    const ret: Action = { kind: "key", window: "chat", chord: "return" };
    const r2 = await ex.act({ action: ret, epoch: o.epoch, consent: mine });
    expect(r2.challenge!.text).toContain("这次任务打的字：明天见");                   // still there after the attach
    expect((await ex.act({ action: ret, epoch: o.epoch, consent: app.forAction(r2.challenge!) })).status).toBe("ok");
    o = await ex.observe("chat");
    const r3 = await ex.act({ action: ret, epoch: o.epoch, consent: mine });
    expect(r3.status).toBe("needs_consent");
    expect(r3.challenge!.text).not.toContain("这次任务打的字");                         // gone with the send the judge called certain
  });

  it("right before a send the window is looked at again: draft A consented, draft B there without an epoch change → asked again, not sent", async () => {
    const { judge } = judged(() => ({ choice: "sends" }));
    const w: FakeWin = { info: { id: "w", app: "邮件", title: "新邮件" }, elements: [
      { id: "body", role: "textArea", label: "正文", value: "草稿 A", actions: ["set_value"] },
      { id: "b7", role: "button", label: "", actions: ["click"] },
    ], text: "" };
    const { ex, desk, app } = await setup([w], judge);
    const o = await ex.observe("w");
    const a: Action = { kind: "click", window: "w", target: "b7" };
    const r = await ex.act({ action: a, epoch: o.epoch, consent: app.forObject("window:w", "modify_user", "t1") });
    expect(r.challenge!.text).toContain("草稿 A");
    w.elements = [{ ...w.elements[0]!, value: "草稿 B" }, w.elements[1]!];              // a sync changed it; the epoch did not move
    const again = await ex.act({ action: a, epoch: o.epoch, consent: app.forAction(r.challenge!) });
    expect(again.status).toBe("needs_consent");
    expect(again.challenge!.text).toContain("草稿 B");
    expect(desk.log).toEqual([]);
    expect((await ex.act({ action: a, epoch: o.epoch, consent: app.forAction(again.challenge!) })).status).toBe("ok");
    expect(desk.log).toEqual([a]);
  });

  it("a stop that arrives during the look before a send is seen before the effect", async () => {
    const { judge } = judged(() => ({ choice: "sends" }));
    const w: FakeWin = { info: { id: "w", app: "邮件", title: "新邮件" }, elements: [{ id: "b7", role: "button", label: "", actions: ["click"] }], text: "" };
    const { ex, desk, app } = await setup([w], judge);
    const o = await ex.observe("w");
    const a: Action = { kind: "click", window: "w", target: "b7" };
    const r = await ex.act({ action: a, epoch: o.epoch });
    const observe = desk.observe.bind(desk);
    desk.observe = (id: string) => { ex.stop(); return observe(id); };
    expect((await ex.act({ action: a, epoch: o.epoch, consent: app.forAction(r.challenge!) })).status).toBe("stopped");
    expect(desk.log).toEqual([]);
  });
});

describe("outgoing check: re-review of #23", () => {
  const relabel = () => {
    const asked: string[] = [];
    const { judge } = judged((u) => { const s = /"名字": "发送"/.test(u.split("窗口里标了")[0]!); asked.push(s ? "sends" : "stays"); return { choice: s ? "sends" : "stays" }; });
    const w: FakeWin = { info: { id: "w", app: "Mail", title: "回复" }, elements: [{ id: "ax:3", role: "button", label: "预览", actions: ["click"] }], text: "" };
    return { judge, w, asked };
  };

  it("two observations on one epoch: a class judged on the first is not used after the second (「预览」→「发送」 relabelled by another app)", async () => {
    const { judge, w, asked } = relabel();
    const { ex, desk, app } = await setup([w], judge);
    const o = await ex.observe("w");
    const a: Action = { kind: "click", window: "w", target: "ax:3" };
    expect((await ex.classify(a, o.epoch)).consequence).toBe("modify_user");
    w.elements = [{ id: "ax:3", role: "button", label: "发送", actions: ["click"] }];   // no `sends` mark, epoch unchanged
    const o2 = await ex.observe("w");
    expect(o2.epoch).toBe(o.epoch);
    const r = await ex.act({ action: a, epoch: o.epoch, consent: app.forObject("window:w", "modify_user", "t1") });
    expect(r).toMatchObject({ status: "needs_consent", consequence: "external" });
    expect(asked).toEqual(["stays", "sends"]);
    expect(desk.log).toEqual([]);
  });

  it("relabelled and not looked at again: the look right before the effect finds the target changed, and nothing is done", async () => {
    const { judge, w } = relabel();
    const { ex, desk, app } = await setup([w], judge);
    const o = await ex.observe("w");
    const a: Action = { kind: "click", window: "w", target: "ax:3" };
    expect((await ex.classify(a, o.epoch)).consequence).toBe("modify_user");
    w.elements = [{ id: "ax:3", role: "button", label: "发送", actions: ["click"], sends: true }];
    const r = await ex.act({ action: a, epoch: o.epoch, consent: app.forObject("window:w", "modify_user", "t1") });
    expect(r.status).toBe("stale");
    expect(desk.log).toEqual([]);
  });

  it("a new incoming message or other window text right before a send does not ask again; the consented draft goes out (pixel policy: match)", async () => {
    const { judge } = judged(() => ({ choice: "sends" }));
    const w = chat();
    const { ex, desk, app } = await setup([w], judge, undefined, { pixelSendBinding: "match" });
    const mine = app.forObject("window:chat", "modify_user", "t1");
    let o = await ex.observe("chat");
    await ex.act({ action: { kind: "type", window: "chat", target: "ocr:1", text: "明天见" }, epoch: o.epoch, consent: mine });
    o = await ex.observe("chat");
    const ret: Action = { kind: "key", window: "chat", chord: "return" };
    const r = await ex.act({ action: ret, epoch: o.epoch, consent: mine });
    expect(r.status).toBe("needs_consent");
    w.elements = [...w.elements, { id: "ocr:9", role: "listitem", label: "李四：在吗", actions: ["click"] }];
    w.text = "张三：明天开会吗？\n李四：在吗\n对方正在输入…\n输入消息…\n发送";
    expect((await ex.act({ action: ret, epoch: o.epoch, consent: app.forAction(r.challenge!) })).status).toBe("ok");
    expect(desk.log.at(-1)).toEqual(ret);
  });

  it("the model's own「往外发」on a name-list Send still takes the typed text as sent", async () => {
    const { judge } = judged(() => ({ choice: "sends" }));
    const w: FakeWin = { info: { id: "w", app: "邮件", title: "新邮件" }, elements: [
      { id: "body", role: "textArea", label: "正文", actions: ["type"] },
      { id: "send", role: "button", label: "发送", actions: ["click"], sends: true },
    ], text: "" };
    const { ex, app } = await setup([w], judge);
    const mine = app.forObject("window:w", "modify_user", "t1");
    let o = await ex.observe("w");
    await ex.act({ action: { kind: "type", window: "w", target: "body", text: "合同见附件" }, epoch: o.epoch, consent: mine });
    o = await ex.observe("w");
    const send: Action = { kind: "click", window: "w", target: "send" };
    const r = await ex.act({ action: send, epoch: o.epoch, consequence: "external", consent: mine });
    expect(r.challenge!.text).toContain("这次任务打的字：合同见附件");
    expect((await ex.act({ action: send, epoch: o.epoch, consequence: "external", consent: app.forAction(r.challenge!) })).status).toBe("ok");
    o = await ex.observe("w");
    const after = await ex.act({ action: send, epoch: o.epoch, consequence: "external", consent: mine });
    expect(after.challenge!.text).not.toContain("这次任务打的字");
  });

  it("an action token is not spent by a look that refused: the draft changed and changed back, the user's yes still holds", async () => {
    const { judge } = judged(() => ({ choice: "sends" }));
    const draft = (v: string): Element[] => [{ id: "body", role: "textArea", label: "正文", value: v, actions: ["set_value"] }, { id: "b7", role: "button", label: "", actions: ["click"] }];
    const w: FakeWin = { info: { id: "w", app: "邮件", title: "新邮件" }, elements: draft("草稿 A"), text: "" };
    const { ex, desk, app } = await setup([w], judge);
    const o = await ex.observe("w");
    const a: Action = { kind: "click", window: "w", target: "b7" };
    const r = await ex.act({ action: a, epoch: o.epoch });
    const yes = app.forAction(r.challenge!);
    w.elements = draft("草稿 B");
    expect((await ex.act({ action: a, epoch: o.epoch, consent: yes })).status).toBe("needs_consent");
    w.elements = draft("草稿 A");
    await ex.observe("w");
    expect((await ex.act({ action: a, epoch: o.epoch, consent: yes })).status).toBe("ok");
    expect(desk.log).toEqual([a]);
    expect((await ex.act({ action: a, epoch: (await ex.observe("w")).epoch, consent: yes })).status).toBe("needs_consent");   // once only
  });
});

describe("outgoing check: third review of #23", () => {
  it("a card approved for 张三 does not send to 李四: the conversation switched in a window whose title never changes", async () => {
    const { judge } = judged(() => ({ choice: "sends" }));
    let who = "张三";
    const w: FakeWin = { info: { id: "w", app: "微信", title: "微信" }, elements: [], text: "" };
    const fill = () => { w.elements = [
      { id: "ocr:0", role: "listitem", label: who, actions: ["click"] },
      { id: "ocr:1", role: "listitem", label: "输入消息…", actions: ["click", "type"] },
      { id: "ocr:2", role: "listitem", label: "发送", actions: ["click"] },
    ]; w.text = `${who}\n输入消息…\n发送`; };
    fill();
    const { ex, desk, app } = await setup([w], judge);
    const mine = app.forObject("window:w", "modify_user", "t1");
    let o = await ex.observe("w");
    await ex.act({ action: { kind: "type", window: "w", target: "ocr:1", text: "明天见" }, epoch: o.epoch, consent: mine });
    o = await ex.observe("w");
    const send: Action = { kind: "click", window: "w", target: "ocr:2" };
    const r1 = await ex.act({ action: send, epoch: o.epoch, consent: mine });
    expect(r1.challenge!.text).toContain("张三");
    const yes = app.forAction(r1.challenge!);
    who = "李四"; fill(); desk.epoch += 1;
    o = await ex.observe("w");
    const r2 = await ex.act({ action: send, epoch: o.epoch, consent: yes });
    expect(r2.status).toBe("needs_consent");
    expect(r2.challenge!.text).toContain("李四");
    expect(desk.log.filter((a) => a.kind === "click")).toEqual([]);
    // and the same switch between the consent check and the effect (no new epoch): the last look asks again
    const r3 = await ex.act({ action: send, epoch: o.epoch, consent: app.forAction(r2.challenge!) });
    expect(r3.status).toBe("ok");
    who = "王五"; fill();
    const o4 = await ex.observe("w");
    const r4 = await ex.act({ action: send, epoch: o4.epoch, consent: mine });
    const yes4 = app.forAction(r4.challenge!);
    who = "赵六"; fill();                                                                   // after the check, before the effect
    const r5 = await ex.act({ action: send, epoch: o4.epoch, consent: yes4 });
    expect(r5.status).toBe("needs_consent");
    expect(desk.log.filter((a) => a.kind === "click").length).toBe(1);
  });

  it("other keys and menu choices are asked about where something could be sent: a Send control, or text the task typed", async () => {
    let asked = 0;
    const { judge } = judged(() => { asked += 1; return { choice: "sends" }; });
    const w: FakeWin = { info: { id: "w", app: "邮件", title: "新邮件" }, elements: [
      { id: "body", role: "textArea", label: "正文", actions: ["type"] },
      { id: "when", role: "popUpButton", label: "发送时间", value: "稍后", options: ["稍后", "立即发送"], actions: ["select"] },
    ], text: "" };
    const { ex, app } = await setup([w], judge);
    let o = await ex.observe("w");
    expect((await ex.classify({ kind: "select", window: "w", target: "when", option: "立即发送" }, o.epoch)).consequence).toBe("modify_user");   // nothing typed, no Send control
    expect(asked).toBe(0);
    await ex.act({ action: { kind: "type", window: "w", target: "body", text: "合同见附件" }, epoch: o.epoch, consent: app.forObject("window:w", "modify_user", "t1") });
    o = await ex.observe("w");
    expect((await ex.classify({ kind: "select", window: "w", target: "when", option: "立即发送" }, o.epoch)).consequence).toBe("external");
    expect((await ex.classify({ kind: "key", window: "w", chord: "cmd+shift+d" }, o.epoch)).consequence).toBe("external");
    expect(asked).toBe(2);
  });

  it("Return after the focus moved from the search box to the message box (no new epoch) is not done on the old decision", async () => {
    const { judge } = judged(() => ({ choice: "stays" }));
    const focus = (on: "search" | "msg"): Element[] => [
      { id: "search", role: "textField", label: "搜索", actions: ["type"], focused: on === "search" },
      { id: "msg", role: "textArea", label: "消息", actions: ["type"], focused: on === "msg" },
    ];
    const w: FakeWin = { info: { id: "w", app: "聊天", title: "聊天" }, elements: focus("search"), text: "" };
    const { ex, desk, app } = await setup([w], judge);
    const o = await ex.observe("w");
    w.elements = focus("msg");
    const r = await ex.act({ action: { kind: "key", window: "w", chord: "return" }, epoch: o.epoch, consent: app.forObject("window:w", "modify_user", "t1") });
    expect(r.status).toBe("stale");
    expect(desk.log).toEqual([]);
  });

  it("the target is found again by what it is: text recognition's ids shifted by a new message, the click goes to the same「发送」", async () => {
    const { judge } = judged(() => ({ choice: "stays" }));
    const w: FakeWin = { info: { id: "w", app: "聊天", title: "聊天" }, elements: [
      { id: "ocr:0", role: "listitem", label: "张三：在吗", actions: ["click"] },
      { id: "ocr:1", role: "listitem", label: "加好友", actions: ["click"] },
    ], text: "" };
    const { ex, desk, app } = await setup([w], judge);
    const o = await ex.observe("w");
    w.elements = [{ id: "ocr:0", role: "listitem", label: "张三：在吗", actions: ["click"] }, { id: "ocr:1", role: "listitem", label: "张三：？", actions: ["click"] }, { id: "ocr:2", role: "listitem", label: "加好友", actions: ["click"] }];
    const r = await ex.act({ action: { kind: "click", window: "w", target: "ocr:1" }, epoch: o.epoch, consent: app.forObject("window:w", "modify_user", "t1") });
    expect(r.status).toBe("ok");
    expect(desk.log).toEqual([{ kind: "click", window: "w", target: "ocr:2" }]);
  });

  it("the user back at the keyboard during the last look: the action waits for them, and ends blocked when they do not pause", async () => {
    const { judge } = judged(() => ({ choice: "stays" }));
    const w: FakeWin = { info: { id: "w", app: "聊天", title: "聊天" }, elements: [{ id: "b", role: "button", label: "收藏", actions: ["click"] }], text: "" };
    const desk = new FakeDesk([w]), app = ConsentSigner.fresh();
    let active = false;
    const snap = desk.snapshot.bind(desk);
    desk.snapshot = () => ({ ...snap(), user_active: active });
    const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, judge, raw: "x", userWait: { ms: 30, pollMs: 5 } });
    await ex.begin(); await ex.plan({ steps: [] });
    const o = await ex.observe("w");
    const observe = desk.observe.bind(desk);
    desk.observe = (id: string) => { active = true; return observe(id); };
    const r = await ex.act({ action: { kind: "click", window: "w", target: "b" }, epoch: o.epoch, consent: app.forObject("window:w", "modify_user", "t1") });
    expect(r.status).toBe("blocked");
    expect(desk.log).toEqual([]);
  });
});

describe("outgoing check: the loop after a stale", () => {
  const run = async (steps: (desk: FakeDesk) => any[], w: FakeWin, outgoing = "sends") => {
    const { FrontierRuntime } = await import("../src/runtime/loop.js");
    const { scriptedStream } = await import("../src/runtime/scripted.js");
    const desk = new FakeDesk([w]), app = ConsentSigner.fresh();
    const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey });
    const gw = new Gateway(table);
    gw.script = Array(80).fill((role: string, _s: string, u: string) => (role === "verify" ? { choice: "pass", reason: "ok" } : isOutgoing(u) ? { choice: outgoing } : { choice: "matches" }));
    const cards: { kind: string }[] = [];
    const user = { ask: (c: any) => { cards.push(c); return { option: c.options.findIndex((o: any) => o.kind === "approve") }; } };
    const model = { model: { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as any };
    const rt = new FrontierRuntime({ task: "t1", raw: "回张三：明天见", executor: ex, signer: app, user, gateway: gw, model: { ...model, streamFn: scriptedStream(steps(desk)) } });
    return { r: await rt.run(), cards, desk };
  };
  const plan = { calls: [{ name: "plan", args: { steps: [{ purpose: "回复", objects: ["window:w"], consequence: "modify_user" }] } }] };
  const look = { calls: [{ name: "computer_observe", args: { window: "w" } }] };
  const click = (target: string) => (ms: any[]) => { const m = [...ms].reverse().find((x) => x.role === "toolResult"); const j = JSON.parse(m.content[0].text.split("\n")[0]); return { calls: [{ name: "computer_act", args: { action: { kind: "click", window: "w", target }, epoch: j.after?.epoch ?? j.epoch, consequence: "modify_user", purpose: "发送" } }] }; };

  it("the user's yes is kept across a stale retry of the same send: one card, then sent", async () => {
    const w: FakeWin = { info: { id: "w", app: "邮件", title: "回复张三" }, elements: [{ id: "body", role: "textArea", label: "正文", value: "明天见", actions: ["type"] }, { id: "b7", role: "button", label: "", actions: ["click"] }], text: "" };
    let looks = 0;
    const { r, cards, desk } = await run((desk) => {
      const observe = desk.observe.bind(desk);
      // the second look (the last look of the approved send) finds a new name-list control: stale; it stays after that
      desk.observe = (id: string) => { looks += 1; if (looks === 2) w.elements = [...w.elements, { id: "sf", role: "button", label: "发送文件", actions: ["click"], sends: true }]; return observe(id); };
      return [plan, look, click("b7"), look, click("b7"), { calls: [{ name: "finish", args: { outcome: "done", summary: "发了" } }] }];
    }, w);
    expect(cards.map((c) => c.kind)).toEqual(["plan", "action"]);
    expect(desk.log).toEqual([{ kind: "click", window: "w", target: "b7" }]);
    expect(r.status).toBe("succeeded");
  });

  it("stale results do not count as going round in circles", async () => {
    const w: FakeWin = { info: { id: "w", app: "邮件", title: "回复" }, elements: [{ id: "b", role: "button", label: "收藏", actions: ["click"] }], text: "" };
    let flip = false;
    const { r } = await run((desk) => {
      const observe = desk.observe.bind(desk);
      // every look sees the window's name-list control come or go: each last look finds a change
      desk.observe = (id: string) => { flip = !flip; w.elements = [{ id: "b", role: "button", label: "收藏", actions: ["click"] }, ...(flip ? [{ id: "s", role: "button", label: "发送", actions: ["click"], sends: true }] : [])]; return observe(id); };
      return [plan, look, click("b"), click("b"), click("b"), click("b"), { calls: [{ name: "finish", args: { outcome: "cannot", summary: "窗口一直在变" } }] }];
    }, w, "stays");
    expect(r.reason).not.toContain("no progress");
    expect(r.reason).toContain("cannot");
  });
});

describe("outgoing check: fourth review of #23", () => {
  it("the same name elsewhere is not the header: approved for 张三, switched to a group whose history shows「张三」 (accessibility ids)", async () => {
    const { judge } = judged(() => ({ choice: "sends" }));
    let conv = "张三";
    const w: FakeWin = { info: { id: "w", app: "Chat", title: "Chat" }, elements: [], text: "" };
    const fill = () => { w.elements = [
      { id: "ax:side1", role: "row", label: "张三", actions: ["click"] }, { id: "ax:side2", role: "row", label: "周末群", actions: ["click"] },
      { id: "ax:header", role: "statictext", label: conv, actions: [] },
      { id: "ax:input", role: "textarea", label: "消息", actions: ["type"], value: "明天见" },
      { id: "ax:send", role: "button", label: "发送", actions: ["click"] },
      ...(conv === "周末群" ? [{ id: "ax:m1", role: "statictext", label: "张三", actions: [] }, { id: "ax:m2", role: "statictext", label: "周六几点？", actions: [] }] : []),
    ]; };
    fill();
    const { ex, desk, app } = await setup([w], judge);
    let o = await ex.observe("w");
    const a: Action = { kind: "click", window: "w", target: "ax:send" };
    const r1 = await ex.act({ action: a, epoch: o.epoch, consent: app.forObject("window:w", "modify_user", "t1") });
    const yes = app.forAction(r1.challenge!);
    conv = "周末群"; fill(); desk.epoch += 1;
    o = await ex.observe("w");
    expect((await ex.act({ action: a, epoch: o.epoch, consent: yes })).status).toBe("needs_consent");
    expect(desk.log).toEqual([]);
  });

  it("the same name elsewhere is not the header: read from the screen, told apart by place", async () => {
    const { judge } = judged(() => ({ choice: "sends" }));
    let conv = "张三";
    const w: FakeWin = { info: { id: "w", app: "微信", title: "微信" }, elements: [], text: "" };
    const fill = () => { w.elements = [
      { id: "ocr:0", role: "listitem", label: conv, actions: ["click"], rect: [300, 10, 60, 20] },
      { id: "ocr:1", role: "listitem", label: "发送", actions: ["click"], rect: [700, 600, 40, 20] },
      ...(conv === "周末群" ? [{ id: "ocr:2", role: "listitem", label: "张三", actions: ["click"], rect: [300, 200, 40, 20] } as Element] : []),
    ]; };
    fill();
    const { ex, desk, app } = await setup([w], judge);
    let o = await ex.observe("w");
    const r1 = await ex.act({ action: { kind: "click", window: "w", target: "ocr:1" }, epoch: o.epoch, consent: app.forObject("window:w", "modify_user", "t1") });
    const yes = app.forAction(r1.challenge!);
    conv = "周末群"; fill(); desk.epoch += 1;
    o = await ex.observe("w");
    expect((await ex.act({ action: { kind: "click", window: "w", target: "ocr:1" }, epoch: o.epoch, consent: yes })).status).toBe("needs_consent");
    expect(desk.log).toEqual([]);
  });

  it("two identical「发送」 renumbered at the last look: the click goes to the one decided on, found by place", async () => {
    const { judge } = judged(() => ({ choice: "sends" }));
    let flip = false;
    const w: FakeWin = { info: { id: "w", app: "微信", title: "微信" }, elements: [], text: "" };
    const fill = () => {
      const a: Omit<Element, "id">[] = [{ role: "statictext", label: "张三", actions: [], rect: [0, 0, 10, 10] }, { role: "button", label: "发送", actions: ["click"], rect: [0, 100, 10, 10] }];
      const b: Omit<Element, "id">[] = [{ role: "statictext", label: "李四", actions: [], rect: [500, 0, 10, 10] }, { role: "button", label: "发送", actions: ["click"], rect: [500, 100, 10, 10] }];
      w.elements = (flip ? [...b, ...a] : [...a, ...b]).map((e, i) => ({ id: `ocr:${i}`, ...e }));
    };
    fill();
    const { ex, desk, app } = await setup([w], judge);
    const o = await ex.observe("w");
    const a: Action = { kind: "click", window: "w", target: "ocr:1" };
    const r1 = await ex.act({ action: a, epoch: o.epoch, consent: app.forObject("window:w", "modify_user", "t1") });
    const observe = desk.observe.bind(desk);
    desk.observe = (id: string) => { flip = true; fill(); return observe(id); };
    expect((await ex.act({ action: a, epoch: o.epoch, consent: app.forAction(r1.challenge!) })).status).toBe("ok");
    expect(desk.log).toEqual([{ kind: "click", window: "w", target: "ocr:3" }]);          // 张三's pane, at x = 0
  });

  it("two identical「发送」 that cannot be told apart (no place): not one of a kind, nothing is done", async () => {
    const { judge } = judged(() => ({ choice: "sends" }));
    const w: FakeWin = { info: { id: "w", app: "微信", title: "微信" }, elements: [{ id: "ocr:0", role: "listitem", label: "发送", actions: ["click"] }, { id: "ocr:1", role: "listitem", label: "发送", actions: ["click"] }], text: "" };
    const { ex, desk, app } = await setup([w], judge);
    const o = await ex.observe("w");
    expect((await ex.act({ action: { kind: "click", window: "w", target: "ocr:1" }, epoch: o.epoch, consent: app.forObject("window:w", "modify_user", "t1") })).status).toBe("stale");
    expect(desk.log).toEqual([]);
  });

  it("not one of a kind when decided is not settled by one of them going away before the effect", async () => {
    const { judge } = judged(() => ({ choice: "stays" }));
    const w: FakeWin = { info: { id: "w", app: "微信", title: "微信" }, elements: [{ id: "ocr:0", role: "listitem", label: "发送", actions: ["click"] }, { id: "ocr:1", role: "listitem", label: "发送", actions: ["click"] }], text: "" };
    const { ex, desk } = await setup([], judge, w);                                         // the task's own window: no card on the way
    await ex.act({ action: { kind: "open_window", app: "微信" }, epoch: (await ex.snapshot()).epoch });
    const o = await ex.observe("w");
    w.elements = [{ id: "ocr:0", role: "listitem", label: "发送", actions: ["click"] }];
    expect((await ex.act({ action: { kind: "click", window: "w", target: "ocr:1" }, epoch: o.epoch })).status).toBe("stale");
    desk.log.shift();                                                                       // the open_window
    expect(desk.log).toEqual([]);
  });

  it("asked again at the last look, the user's yes covers the caller's retry of the same action (its own ids)", async () => {
    const { judge } = judged(() => ({ choice: "sends" }));
    let extra = 0, badge = "";
    const w: FakeWin = { info: { id: "w", app: "微信", title: "微信" }, elements: [], text: "" };
    const fill = () => { w.elements = [{ role: "statictext", label: "张三" + badge, actions: [] }, ...Array.from({ length: extra }, (_, i) => ({ role: "statictext", label: `新消息${i}`, actions: [] })), { role: "textarea", label: "输入消息…", actions: ["click", "type"] }, { role: "button", label: "发送", actions: ["click"] }].map((e, i) => ({ id: `ocr:${i}`, ...e })); };
    fill();
    const { ex, desk, app } = await setup([w], judge);
    const mine = app.forObject("window:w", "modify_user", "t1");
    let o = await ex.observe("w");
    await ex.act({ action: { kind: "type", window: "w", target: "ocr:1", text: "明天见" }, epoch: o.epoch, consent: mine });
    o = await ex.observe("w");
    const a: Action = { kind: "click", window: "w", target: "ocr:2" };
    const r1 = await ex.act({ action: a, epoch: o.epoch, consent: mine });
    const observe = desk.observe.bind(desk);
    let once = true;
    desk.observe = (id: string) => { if (once) { once = false; extra = 1; badge = "(1)"; fill(); } return observe(id); };
    const r2 = await ex.act({ action: a, epoch: r1.epoch, consent: app.forAction(r1.challenge!) });
    expect(r2.status).toBe("needs_consent");
    expect(r2.challenge!.text).toContain("「发送」");                                     // the card names the element decided on
    const r3 = await ex.act({ action: a, epoch: r2.epoch, consent: app.forAction(r2.challenge!) });
    expect(r3.status).toBe("ok");
    expect(desk.log.filter((x) => x.kind === "click")).toEqual([{ kind: "click", window: "w", target: "ocr:3" }]);
  });
});

describe("outgoing check: the pixel send-binding policy (owner 10-20)", () => {
  /** A chat read from the screen with a draft typed and a send consented; then `change` happens before the effect. */
  const pixelSend = async (policy: "strict" | "match", change: (w: FakeWin) => void) => {
    const { judge } = judged(() => ({ choice: "sends" }));
    const w: FakeWin = { info: { id: "w", app: "微信", title: "微信" }, elements: [
      { id: "ocr:0", role: "listitem", label: "张三", actions: ["click"], rect: [300, 10, 60, 20] },
      { id: "ocr:1", role: "listitem", label: "张三：明天开会吗？", actions: ["click"], rect: [300, 100, 160, 20] },
      { id: "ocr:2", role: "listitem", label: "输入消息…", actions: ["click", "type"], rect: [300, 560, 200, 20] },
      { id: "ocr:3", role: "listitem", label: "发送", actions: ["click"], rect: [700, 600, 40, 20] },
    ], text: "" };
    const shown = () => { w.text = w.elements.map((e) => e.label).join("\n"); };          // hands' text of the screen
    shown();
    const { ex, desk, app } = await setup([w], judge, undefined, { pixelSendBinding: policy });
    const mine = app.forObject("window:w", "modify_user", "t1");
    let o = await ex.observe("w");
    await ex.act({ action: { kind: "type", window: "w", target: "ocr:2", text: "明天见" }, epoch: o.epoch, consent: mine });
    o = await ex.observe("w");
    const send: Action = { kind: "click", window: "w", target: "ocr:3" };
    const r = await ex.act({ action: send, epoch: o.epoch, consent: mine });
    change(w); shown();
    const r2 = await ex.act({ action: send, epoch: o.epoch, consent: app.forAction(r.challenge!) });
    return { r2, sent: desk.log.filter((a) => a.kind === "click").length };
  };
  const incoming = (w: FakeWin) => { w.elements = [...w.elements, { id: "ocr:9", role: "listitem", label: "张三：在吗", actions: ["click"], rect: [300, 140, 100, 20] }]; };
  const toGroup = (w: FakeWin) => { w.elements = [{ ...w.elements[0]!, label: "周末群" }, ...w.elements.slice(1), { id: "ocr:9", role: "listitem", label: "张三", actions: ["click"], rect: [300, 200, 40, 20] }]; };

  it("strict (the default): an incoming message in a chat read from the screen asks again, with what is there now", async () => {
    const { r2, sent } = await pixelSend("strict", incoming);
    expect(r2.status).toBe("needs_consent");
    expect(r2.challenge!.text).toContain("张三：在吗");
    expect(sent).toBe(0);
  });

  it("strict: the same screen read again with a few pixels of jitter does not ask again; a 20 px shift does", async () => {
    const move = (d: number, keepTarget = false) => (w: FakeWin) => { w.elements = w.elements.map((e, i) => (keepTarget && e.label === "发送" ? e : { ...e, rect: [e.rect![0] + (i % 2 ? d : -d), e.rect![1] + d, e.rect![2], e.rect![3]] as [number, number, number, number] })); };
    for (const d of [2, 3]) {
      const { r2, sent } = await pixelSend("strict", move(d));
      expect([d, r2.status, sent]).toEqual([d, "ok", 1]);
    }
    // the conversation scrolled 20 px (the Send button where it was): asked again with what is there now
    const { r2, sent } = await pixelSend("strict", move(20, true));
    expect([r2.status, sent]).toEqual(["needs_consent", 0]);
    // everything 20 px away, the Send button too: it is not found where it was decided, nothing is done
    const all = await pixelSend("strict", move(20));
    expect([all.r2.status, all.sent]).toEqual(["stale", 0]);
  });

  it("strict: an element with two candidates within the jitter cannot be told apart, which counts as changed", () => {
    const el = (c: string, x: number, y: number) => ({ c, at: [x, y] as [number, number] });
    expect(sameScreen([el("a", 10, 10), el("b", 50, 50)], [el("b", 52, 49), el("a", 11, 9)])).toBe(true);
    expect(sameScreen([el("a", 10, 10), el("a", 13, 10)], [el("a", 11, 10), el("a", 14, 10)])).toBe(false);
    expect(sameScreen([el("a", 10, 10)], [el("a", 10, 10), el("b", 0, 0)])).toBe(false);          // nothing added
  });

  it("match: the same incoming message does not ask again", async () => {
    const { r2, sent } = await pixelSend("match", incoming);
    expect(r2.status).toBe("ok");
    expect(sent).toBe(1);
  });

  it("both: the conversation switched from 张三 to 周末群 asks again", async () => {
    for (const p of ["strict", "match"] as const) {
      const { r2, sent } = await pixelSend(p, toGroup);
      expect(r2.status).toBe("needs_consent");
      expect(sent).toBe(0);
    }
  });

  it("windows read from the accessibility tree behave the same under both: a new message allowed, a changed header asks again", async () => {
    for (const p of ["strict", "match"] as const) {
      for (const [change, want] of [["incoming", "ok"], ["header", "needs_consent"]] as const) {
        const { judge } = judged(() => ({ choice: "sends" }));
        const w: FakeWin = { info: { id: "w", app: "Chat", title: "Chat" }, elements: [
          { id: "ax:header", role: "statictext", label: "张三", actions: [] },
          { id: "ax:input", role: "textarea", label: "消息", value: "明天见", actions: ["type"] },
          { id: "ax:send", role: "button", label: "发送", actions: ["click"] },
        ], text: "" };
        const { ex, app } = await setup([w], judge, undefined, { pixelSendBinding: p });
        const o = await ex.observe("w");
        const send: Action = { kind: "click", window: "w", target: "ax:send" };
        const r = await ex.act({ action: send, epoch: o.epoch, consent: app.forObject("window:w", "modify_user", "t1") });
        if (change === "incoming") w.elements = [...w.elements, { id: "ax:m9", role: "statictext", label: "张三：在吗", actions: [] }];
        else w.elements = [{ ...w.elements[0]!, label: "周末群" }, ...w.elements.slice(1)];
        expect([p, change, (await ex.act({ action: send, epoch: o.epoch, consent: app.forAction(r.challenge!) })).status]).toEqual([p, change, want]);
      }
    }
  });

  it("the default is strict; the app's environment variable chooses match only by its exact name", async () => {
    expect([pixelSendBindingFrom(undefined), pixelSendBindingFrom("match"), pixelSendBindingFrom("Match"), pixelSendBindingFrom("loose")]).toEqual(["strict", "match", "strict", "strict"]);
    const prev = process.env.DESKMIND_PIXEL_SEND_BINDING;
    try {
      delete process.env.DESKMIND_PIXEL_SEND_BINDING;
      expect((await setup([chat()])).ex.pixelPolicy).toBe("strict");
      process.env.DESKMIND_PIXEL_SEND_BINDING = "match";
      expect((await setup([chat()])).ex.pixelPolicy).toBe("match");
      expect((await setup([chat()], undefined, undefined, { pixelSendBinding: "strict" })).ex.pixelPolicy).toBe("strict");   // the option wins
    } finally { if (prev === undefined) delete process.env.DESKMIND_PIXEL_SEND_BINDING; else process.env.DESKMIND_PIXEL_SEND_BINDING = prev; }
  });
});
