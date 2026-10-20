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
  const group: Element = { id: "elem_9", role: "group", label: "组", actions: ["click"], rect: [62, 16, 20, 20] };

  it("an anonymous 「组」 vanishing (rc.10's trace) no longer asks again; the send goes out", async () => {
    const { r2, sent } = await run(compose([group]), compose());
    expect([r2.status, sent]).toEqual(["ok", 1]);
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

  it("what counts as anonymous: no value, no own label, no selection, not a sender, nothing beyond a click", () => {
    expect(anonymous(group)).toBe(true);
    expect(anonymous({ ...group, label: "" })).toBe(true);
    expect(anonymous({ ...group, role: "AXGroup", label: "group" })).toBe(true);
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

  it("a step with opens into the user's Chrome: the card says so as 改你的东西, and later pages open without cards", async () => {
    const { rt, cards, events, chrome } = run([
      { calls: [{ name: "plan", args: { steps: [{ purpose: "打开天气搜索结果", objects: [], consequence: "create", opens: [{ app: "Google Chrome", url: "https://www.google.com/search?q=今天北京天气" }] }, { purpose: "读天气", objects: [], consequence: "read" }] } }] },
      snap, open("https://www.google.com/search?q=今天北京天气"), snap, open("https://wttr.in/Beijing?lang=zh"), finish,
    ]);
    await rt.run();
    expect(cards.map((c) => c.kind)).toEqual(["plan"]);
    expect(cards[0]!.text).toContain("1. 打开天气搜索结果（在你的 Google Chrome 窗口里打开网页）——改你的东西");
    expect(events.find((e) => e.k === "plan.classes")!.b).toMatchObject({ settled: ["modify_user", "read"], objects: [`window:${chrome}`] });
    const acts = events.filter((e) => e.k === "tool.result" && e.b.name === "computer_act").map((e) => JSON.parse((e.b.text as string).split("\n")[0]!).status);
    expect(acts).toEqual(["ok", "ok"]);
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
