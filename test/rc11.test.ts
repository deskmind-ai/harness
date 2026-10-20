/**
 * Two rc.10 real-machine findings: an anonymous container vanishing re-asked a mail send (run_52d8ea2a); nine pages
 * opened with open_window in the user's Chrome window asked nine cards (run_93d40dbe).
 */
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/index.js";
import type { Answer, Card } from "../src/orchestrator/index.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor, anonymous } from "../src/executor/executor.js";
import { OUTGOING_QUESTION, Judge } from "../src/executor/judge.js";
import { SimComputer } from "../src/executor/sim.js";
import { FrontierRuntime } from "../src/runtime/loop.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";
import type { Action, Driver, Element, WindowInfo } from "../src/executor/types.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
const model = { model: { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as any };

class Desk implements Driver {
  epoch = 1; log: Action[] = [];
  constructor(public w: { info: WindowInfo; elements: Element[] }) {}
  snapshot() { return { epoch: this.epoch, locked: false, front_app: "Safari", windows: [this.w.info] }; }
  observe() { return { epoch: this.epoch, window: this.w.info, modal: null, elements: this.w.elements.map((e) => ({ ...e })), text: "" }; }
  perform(a: Action) { this.log.push(a); this.epoch += 1; return { status: "ok" as const, window: this.w.info.id }; }
}

describe("anonymous containers are not bound to a send", () => {
  const compose = (extra: Element[] = [], pixels = false): Element[] => [
    { id: pixels ? "ocr:0" : "elem_1", role: pixels ? "listitem" : "statictext", label: "许诺 <xu@example.com>", actions: pixels ? ["click"] : [], rect: [10, 10, 200, 20] },
    { id: pixels ? "ocr:1" : "elem_2", role: pixels ? "listitem" : "textarea", label: "回复内容", value: pixels ? undefined : "我看一下再说", actions: pixels ? ["click"] : ["set_value", "type"], rect: [10, 100, 400, 80] },
    { id: pixels ? "ocr:2" : "elem_3", role: pixels ? "listitem" : "button", label: "发送", actions: ["click"], rect: [420, 100, 60, 30] },
    ...extra,
  ];
  const run = async (before: Element[], after: Element[], pixelSendBinding: "strict" | "match" = "strict") => {
    const gw = new Gateway(table);
    gw.script = Array(20).fill((_r: string, _s: string, u: string) => (u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: "sends" } : { choice: "matches" }));
    const desk = new Desk({ info: { id: "com.apple.Safari#30514", app: "com.apple.Safari", title: "Mailora" }, elements: before });
    const app = ConsentSigner.fresh();
    const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, judge: new Judge([{ name: "frontier", gateway: gw }]), raw: "回复许诺并发送", pixelSendBinding });
    await ex.begin(); await ex.plan({ steps: [] });
    const o = await ex.observe("com.apple.Safari#30514");
    const send: Action = { kind: "click", window: "com.apple.Safari#30514", target: before.find((e) => e.label === "发送")!.id };
    const r1 = await ex.act({ action: send, epoch: o.epoch, consent: app.forObject("window:com.apple.Safari#30514", "modify_user", "t1") });
    desk.w.elements = after;
    const r2 = await ex.act({ action: send, epoch: o.epoch, consent: app.forAction(r1.challenge!) });
    return { r2, sent: desk.log.length };
  };
  // hands reports the role description beside the label (AXRoleDescription): a label equal to it names nothing
  const group: Element = { id: "elem_9", role: "group", label: "组", role_description: "组", actions: ["click"], rect: [62, 16, 20, 20] };

  it("an anonymous 「组」 vanishing (rc.10's trace) no longer asks again; the send goes out", async () => {
    const { r2, sent } = await run(compose([group]), compose());
    expect([r2.status, sent]).toEqual(["ok", 1]);
  });

  it("a new recipient chip — an anonymous group with the address beside it — appearing asks again", async () => {
    const chip: Element[] = [{ id: "elem_20", role: "group", label: "", actions: ["click"], rect: [220, 10, 120, 20] }, { id: "elem_21", role: "statictext", label: "b@evil.com", actions: [], rect: [280, 10, 80, 20] }];
    const { r2, sent } = await run(compose([group]), compose([group, ...chip]));
    expect([r2.status, sent]).toEqual(["needs_consent", 0]);
  });

  it("without hands' role_description a 「组」 label is a name: it vanishing still asks (until hands sends it)", async () => {
    const { role_description: _r, ...bare } = group;
    const { r2 } = await run(compose([bare as Element]), compose());
    expect(r2.status).toBe("needs_consent");
  });

  it("a labelled recipient vanishing still asks again", async () => {
    const { r2, sent } = await run(compose([group]), compose([group]).slice(1));
    expect([r2.status, sent]).toEqual(["needs_consent", 0]);
  });

  it("strict, a screen-read window: an unlabelled container vanishing does not ask; a text row vanishing does", async () => {
    const blank: Element = { id: "gen:1", role: "group", label: "", actions: ["click"], rect: [0, 0, 500, 300] };
    expect((await run(compose([blank], true), compose([], true))).r2.status).toBe("ok");
    expect((await run(compose([blank], true), compose([blank], true).slice(1))).r2.status).toBe("needs_consent");
  });

  it("what counts as anonymous: a container, no value, a label that is empty or only its role's description, no selection, not a sender, nothing beyond a click", () => {
    expect(anonymous(group)).toBe(true);
    expect(anonymous({ ...group, label: "", role_description: undefined })).toBe(true);
    expect(anonymous({ ...group, role: "AXGroup", label: "group", role_description: undefined, label_from_role: true })).toBe(true);
    expect(anonymous({ ...group, role_description: undefined })).toBe(false);          // no word table: 「组」 alone is a name
    expect(anonymous({ ...group, role: "button", label: "" })).toBe(false);            // an unnamed button is not a container
    expect(anonymous({ ...group, role: "row", label: "" })).toBe(false);
    expect(anonymous({ ...group, label: "收件人" })).toBe(false);
    expect(anonymous({ ...group, value: "x" })).toBe(false);
    expect(anonymous({ ...group, focused: true })).toBe(false);
    expect(anonymous({ ...group, sends: true })).toBe(false);
    expect(anonymous({ ...group, actions: ["click", "set_value"] })).toBe(false);
  });
});

describe("pages opened in the user's browser window are planned once", () => {
  const run = (steps: Step[]) => {
    const sim = new SimComputer();
    const chrome = sim.addBrowser("Google Chrome", [{ title: "收件箱 - Gmail", url: "https://mail.google.com" }]).id;
    const app = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey });
    const gw = new Gateway(table);
    gw.script = Array(40).fill((role: string) => (role === "verify" ? { choice: "pass", reason: "ok" } : { choice: "matches" }));
    const cards: Card[] = [], events: { k: string; b: Record<string, unknown> }[] = [];
    const rt = new FrontierRuntime({ task: "t1", raw: "搜索今天北京天气", executor: ex, signer: app, user: { ask: (c: Card): Answer => { cards.push(c); return { option: c.options.findIndex((o) => o.kind === "approve") }; } }, gateway: gw, model: { ...model, streamFn: scriptedStream(steps) }, onEvent: (k, b) => events.push({ k, b }) });
    return { rt, cards, events, chrome };
  };
  const open = (url: string) => (ms: any[]): Step => {
    const m = [...ms].reverse().find((x) => x.role === "toolResult"); let epoch = 1;
    try { const j = JSON.parse(m.content[0].text.split("\n")[0]); epoch = j.after?.epoch ?? j.epoch ?? 1; } catch { /* plan result */ }
    return { calls: [{ name: "computer_act", args: { action: { kind: "open_window", app: "Google Chrome", url }, epoch, consequence: "create", purpose: "打开网页" } }] };
  };
  const snap: Step = { calls: [{ name: "computer_snapshot", args: {} }] };
  const finish: Step = { calls: [{ name: "finish", args: { outcome: "done", summary: "查到了" } }] };

  const opens = [{ app: "Google Chrome", url: "https://www.google.com/search?q=今天北京天气" }, { app: "Google Chrome", url: "https://wttr.in/Beijing?lang=zh" }];

  it("a step with opens into the user's Chrome: the card lists the sites as 改你的东西, and pages of those sites open without cards", async () => {
    const { rt, cards, events, chrome } = run([
      { calls: [{ name: "plan", args: { steps: [{ purpose: "打开天气搜索结果", objects: [], consequence: "create", opens }, { purpose: "读天气", objects: [], consequence: "read" }] } }] },
      snap, open("https://www.google.com/search?q=今天北京天气"), snap, open("https://wttr.in/Beijing?lang=zh"), finish,
    ]);
    await rt.run();
    expect(cards.map((c) => c.kind)).toEqual(["plan"]);
    expect(cards[0]!.text).toContain("1. 打开天气搜索结果（在你的 Google Chrome 窗口里打开 www.google.com、wttr.in 的网页）——改你的东西");
    // the consent is to open those sites' pages there, not the whole window
    expect(events.find((e) => e.k === "plan.classes")!.b).toMatchObject({ settled: ["modify_user", "read"], objects: [], opens: { [`window:${chrome}`]: ["www.google.com", "wttr.in"] } });
    const acts = events.filter((e) => e.k === "tool.result" && e.b.name === "computer_act").map((e) => JSON.parse((e.b.text as string).split("\n")[0]!).status);
    expect(acts).toEqual(["ok", "ok"]);
  });

  it("a site the plan did not list, and anything else in that window (a click, typing), still ask on their own cards", async () => {
    const { rt, cards, chrome } = run([
      { calls: [{ name: "plan", args: { steps: [{ purpose: "打开天气搜索结果", objects: [], consequence: "create", opens }] } }] },
      snap, open("https://www.bing.com/search?q=今天北京天气"),
      (ms: any[]) => ({ calls: [{ name: "computer_observe", args: { window: chrome } }] }),
      (ms: any[]) => { const m = [...ms].reverse().find((x) => x.role === "toolResult"); const j = JSON.parse(m.content[0].text.split("\n")[0]); return { calls: [{ name: "computer_act", args: { action: { kind: "click", window: chrome, target: `${chrome}:0:newtab` }, epoch: j.epoch, consequence: "create", purpose: "新标签页" } }] }; },
      finish,
    ]);
    await rt.run();
    expect(cards.map((c) => c.kind)).toEqual(["plan", "action", "action"]);
    expect(cards[1]!.text).toContain("Google Chrome");
  });

  it("without opens (as the run's plan was written), each page asks on its own card — the behaviour opens replaces", async () => {
    const { rt, cards } = run([
      { calls: [{ name: "plan", args: { steps: [{ purpose: "打开天气搜索结果", objects: [], consequence: "create" }] } }] },
      snap, open("https://www.google.com/search?q=今天北京天气"), snap, open("https://wttr.in/Beijing?lang=zh"), finish,
    ]);
    await rt.run();
    expect(cards.map((c) => c.kind)).toEqual(["action", "action"]);
  });

  it("before any plan, the refusal tells the model how to plan it: opens with the app", async () => {
    const { rt, events } = run([snap, open("https://www.google.com/search?q=今天北京天气"), finish]);
    await rt.run();
    const res = events.find((e) => e.k === "tool.result" && e.b.name === "computer_act")!.b.text as string;
    expect(res).toContain("先交计划");
    expect(res).toContain('opens: [{ app: "Google Chrome"');
  });
});

describe("run_ac5345ce: evidence missing after the work is done; element ids on the plan card", () => {
  const mailRun = (verdicts: Record<string, unknown>[], steps: (w: string) => Step[]) => {
    const sim = new SimComputer();
    const w = sim.addMail({ app: "信鸽", texts: { replied: "已回复", inbox: "收件箱", reply: "回复", delete: "删除", flag: "加旗标", unflag: "取消旗标", send: "发送", cancel: "取消", confirm: "确认删除", confirmText: "确定删除这封邮件吗？", body: "回复内容", meeting: "会议时间：%s", empty: "选择一封邮件" }, flagged: [], inbox: [{ id: "m1", from: "林晓", subject: "Q3 预算", body: ["x"], time: "14:00" }] }).id;
    const app = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey });
    const gw = new Gateway(table);
    const vs = [...verdicts];
    gw.script = Array(40).fill((role: string) => (role === "verify" ? vs.shift() ?? { choice: "pass", reason: "ok" } : { choice: "matches" }));
    const cards: Card[] = [], events: { k: string; b: Record<string, unknown> }[] = [];
    const rt = new FrontierRuntime({ task: "t1", raw: "给林晓那封邮件加旗标", executor: ex, signer: app, user: { ask: (c: Card): Answer => { cards.push(c); return { option: c.options.findIndex((o) => o.kind === "approve") }; } }, gateway: gw, model: { ...model, streamFn: scriptedStream(steps(w)) }, onEvent: (k, b) => events.push({ k, b }) });
    return { rt, sim, w, cards, events };
  };
  const done: Step = { calls: [{ name: "finish", args: { outcome: "done", summary: "加好了" } }] };
  const look = (w: string): Step => ({ calls: [{ name: "computer_observe", args: { window: w } }] });
  const click = (w: string, target: string) => (ms: any[]): Step => { const m = [...ms].reverse().find((x) => x.role === "toolResult"); const j = JSON.parse(m.content[0].text.split("\n")[0]); return { calls: [{ name: "computer_act", args: { action: { kind: "click", window: w, target }, epoch: j.after?.epoch ?? j.epoch, consequence: "create", purpose: "再点一下找证据" } }] }; };
  const evidence = { choice: "unknown", reason: "从画面读的应用里看不出是否在播放", missing_kind: "evidence" };

  it("an unknown for missing evidence: the model may only look; another click is refused; still unknown → unconfirmed, telling the user what to check", async () => {
    const { rt, sim, w, events } = mailRun([evidence, evidence, evidence], (w) => [done, look(w), click(w, `${w}:0:row:m1`), done, done]);
    const r = await rt.run();
    expect(r.status).toBe("unconfirmed");
    expect(r.reason).toContain("请你看一下：从画面读的应用里看不出是否在播放");
    const results = events.filter((e) => e.k === "tool.result").map((e) => e.b.text as string);
    expect(results.some((t) => t.includes("only look for evidence"))).toBe(true);
    expect(sim.mailState(w).selected).toBeNull();                       // the click never happened
  });

  it("an unknown for an unfinished action: acting goes on as before", async () => {
    const { rt, events } = mailRun([{ choice: "unknown", reason: "还没加旗标", missing_kind: "action" }], (w) => [done, look(w), click(w, `${w}:0:row:m1`), done]);
    await rt.run();
    const results = events.filter((e) => e.k === "tool.result").map((e) => e.b.text as string);
    expect(results.some((t) => t.includes("only look for evidence"))).toBe(false);
  });

  it("the judge's missing_kind reaches the verdict; an answer without it is treated as before (acting allowed)", async () => {
    const { rt, events } = mailRun([{ choice: "unknown", reason: "不知道" }], (w) => [done, look(w), click(w, `${w}:0:row:m1`), done]);
    await rt.run();
    expect(events.filter((e) => e.k === "tool.result").some((e) => (e.b.text as string).includes("only look for evidence"))).toBe(false);
  });

  it("element ids and words that name nothing are not on the plan card", async () => {
    const { rt, cards } = mailRun([], (w) => [{ calls: [{ name: "plan", args: { steps: [{ purpose: "加旗标", objects: [`窗口 ${w}`, "ocr:26", "elem_12", "gen:搜索框"], consequence: "create" }] } }] }, done]);
    await rt.run();
    expect(cards[0]!.text).toContain("1. 加旗标（信鸽「收件箱」）——改你的东西");
    for (const id of ["ocr:26", "elem_12", "gen:搜索框"]) expect(cards[0]!.text).not.toContain(id);
  });
});

describe("the open consent itself", () => {
  it("covers open_window with a URL of a listed site in that window, in that task — not a click, not another site, not another window", async () => {
    const { ConsentSigner: S, ConsentVerifier } = await import("../src/executor/consent.js");
    const app = S.fresh(), v = new ConsentVerifier(app.publicKey);
    const t = app.forOpen("window:chrome-1", ["wttr.in", "www.bing.com"], "t1");
    const open = (url: string): Action => ({ kind: "open_window", app: "Google Chrome", url });
    expect(v.check(open("https://wttr.in/Beijing"), "window:chrome-1", "modify_user", "t1", t)).toBeNull();
    expect(v.check(open("https://evil.example/x"), "window:chrome-1", "modify_user", "t1", t)).toBe("consent does not cover evil.example");
    expect(v.check({ kind: "click", window: "chrome-1", target: "b" }, "window:chrome-1", "modify_user", "t1", t)).toBe("consent covers opening pages only");
    expect(v.check(open("https://wttr.in/Beijing"), "window:chrome-2", "modify_user", "t1", t)).toBe("consent is for another object");
    expect(v.check(open("https://wttr.in/Beijing"), "window:chrome-1", "modify_user", "t2", t)).toBe("consent is for another task");
    expect(v.check(open("https://wttr.in/Beijing"), "window:chrome-1", "external", "t1", t)).toContain("consent covers modify_user");
  });
});
