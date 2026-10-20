/**
 * The plan's consent by the executor's own view (10-20, 「打开网易云播放安溥的宝贝」): the model declared its steps
 * "create", the executor counted the window as the user's, so no plan card was shown and every step asked on its own
 * card. Now the plan card lists the user's things the steps touch by the executor's floor, and its approval covers
 * them; a send still asks per action; an app that can only be operated in front is said so on the card.
 */
import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { Gateway } from "../src/gateway/index.js";
import type { Answer, Card } from "../src/orchestrator/index.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { OUTGOING_QUESTION } from "../src/executor/judge.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import { FrontierRuntime } from "../src/runtime/loop.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
const model = { model: { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as any };
const last = (ms: Message[]): any => { const m = [...ms].reverse().find((x) => x.role === "toolResult") as any; try { return JSON.parse(m.content[0].text.split("\n")[0]); } catch { return {}; } };
const act = (action: Record<string, unknown>, consequence: string) => (ms: Message[]): Step => ({ calls: [{ name: "computer_act", args: { action, epoch: last(ms).after?.epoch ?? last(ms).epoch, consequence, purpose: "step" } }] });
const look = (w: string): Step => ({ calls: [{ name: "computer_observe", args: { window: w } }] });
const finish: Step = { calls: [{ name: "finish", args: { outcome: "done", summary: "做完了" } }] };

function run(sim: SimComputer, steps: Step[], raw = "给林晓那封 Q3 预算的邮件加旗标") {
  const app = ConsentSigner.fresh();
  const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey });
  const gw = new Gateway(table);
  gw.script = Array(80).fill((role: string, _s: string, u: string) => (role === "verify" ? { choice: "pass", reason: "ok" } : u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: /"目标名字命中发送词表":\s*true/.test(u) ? "sends" : "stays" } : { choice: "matches" }));
  const cards: Card[] = [], events: { k: string; b: Record<string, unknown> }[] = [];
  const user = { ask: (c: Card): Answer => { cards.push(c); return { option: c.options.findIndex((o) => o.kind === "approve") }; } };
  const rt = new FrontierRuntime({ task: "t1", raw, executor: ex, signer: app, user, gateway: gw, model: { ...model, streamFn: scriptedStream(steps) }, onEvent: (k, b) => events.push({ k, b }) });
  return { rt, cards, events };
}
const mailSim = () => {
  const sim = new SimComputer();
  const w = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "m1", from: "林晓", subject: "Q3 预算", body: ["会议时间：14:00"], time: "14:00" }] });
  return { sim, w: w.id };
};
/** The plan as the real run's model wrote it: steps on the user's window declared "create". */
const planCreate = (w: string, extra: { purpose: string; objects: string[]; consequence: string }[] = []): Step => ({ calls: [{ name: "plan", args: { steps: [
  { purpose: "打开林晓的 Q3 预算邮件", objects: [`窗口 ${w}`], consequence: "create" },
  { purpose: "加旗标", objects: [`窗口 ${w}`], consequence: "create" },
  ...extra,
] } }] });

describe("the plan card by the executor's view", () => {
  it("steps declared create on the user's window: one plan card, then the actions go ahead without cards of their own", async () => {
    const { sim, w } = mailSim();
    const { rt, cards, events } = run(sim, [planCreate(w), look(w), act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "create"), act({ kind: "click", window: w, target: `${w}:0:flag` }, "create"), finish]);
    const r = await rt.run();
    expect(cards.map((c) => c.kind)).toEqual(["plan"]);
    expect(cards[0]!.text).toContain("改你的东西");
    expect(sim.mailState(w).flagged).toEqual(["m1"]);
    expect(r.status).toBe("succeeded");
    expect(events.find((e) => e.k === "plan.classes")!.b).toMatchObject({ declared: ["create", "create"], settled: ["modify_user", "modify_user"], objects: [`window:${w}`] });
  });

  it("a user's window the plan did not name is not covered: an action there asks on its own card", async () => {
    const { sim, w } = mailSim();
    const other = sim.addSettings("系统设置", { 勿扰: false }).id;
    const { rt, cards } = run(sim, [planCreate(w), look(w), act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "create"), look(other), act({ kind: "click", window: other, target: `${other}:0:toggle:勿扰` }, "create"), finish]);
    await rt.run();
    expect(cards.map((c) => c.kind)).toEqual(["plan", "action"]);
    expect(cards[1]!.text).toContain("系统设置");
  });

  it("a send still asks on its own card after the plan card", async () => {
    const { sim, w } = mailSim();
    const steps: Step[] = [
      planCreate(w, [{ purpose: "回复并发送", objects: [`窗口 ${w}`], consequence: "external" }]), look(w),
      act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "create"),
      act({ kind: "click", window: w, target: `${w}:0:reply` }, "create"),
      act({ kind: "set_value", window: w, target: `${w}:0:compose_body`, value: "收到" }, "create"),
      act({ kind: "click", window: w, target: `${w}:0:send` }, "external"),
      finish,
    ];
    const { rt, cards } = run(sim, steps, "回复林晓：收到");
    await rt.run();
    expect(cards.map((c) => c.kind)).toEqual(["plan", "action"]);
    // the sending step on the user's window says both: it changes the user's things on the way, and it sends
    expect(cards[0]!.text.split("\n").find((l) => l.startsWith("3."))).toContain("改你的东西，也会往外发");
    expect(cards[1]!.text).toContain("发出去");
    expect(sim.mailState(w).replies).toEqual([{ to: "m1", body: "收到" }]);
  });

  it("an app that can only be operated in front is said so on the plan card, and in the trace; nothing when not flagged", async () => {
    for (const flag of [true, false]) {
      const { sim, w } = mailSim();
      const snap = sim.snapshot.bind(sim);
      sim.snapshot = () => { const s = snap(); return { ...s, windows: s.windows.map((x) => (x.id === w && flag ? { ...x, needs_foreground: true } : x)) }; };
      const { rt, cards, events } = run(sim, [planCreate(w), look(w), act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "create"), finish]);
      await rt.run();
      expect([flag, cards[0]!.text.includes("只能在前台操作")]).toEqual([flag, flag]);
      expect([flag, events.some((e) => e.k === "plan.foreground")]).toEqual([flag, flag]);
      if (flag) expect(cards[0]!.text).toContain("信鸽");
    }
  });

  it("the snapshot-wide form (needs_foreground: [app]) is read too", async () => {
    const { sim, w } = mailSim();
    const snap = sim.snapshot.bind(sim);
    sim.snapshot = () => ({ ...snap(), needs_foreground: ["信鸽"] });
    const { rt, cards } = run(sim, [planCreate(w), look(w), finish]);
    await rt.run();
    expect(cards[0]!.text).toContain("信鸽 只能在前台操作");
  });

  it("a plan with only a sending step on the user's window says both on its line, and signs the window only because it says so", async () => {
    const { sim, w } = mailSim();
    const steps: Step[] = [
      { calls: [{ name: "plan", args: { steps: [{ purpose: "回复并发送", objects: [`窗口 ${w}`], consequence: "external" }] } }] }, look(w),
      act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "create"),
      finish,
    ];
    const { rt, cards, events } = run(sim, steps, "回复林晓：收到");
    await rt.run();
    expect(cards.map((c) => c.kind)).toEqual(["plan"]);
    expect(cards[0]!.text).toContain("1. 回复并发送（信鸽「收件箱」）——改你的东西，也会往外发");
    expect(events.find((e) => e.k === "plan.classes")!.b).toMatchObject({ settled: ["external"], objects: [`window:${w}`] });
  });

  it("a sending step on the task's own window says only that it sends", async () => {
    const sim = new SimComputer();
    const { rt, cards } = run(sim, [
      { calls: [{ name: "computer_act", args: { action: { kind: "open_window", app: "编辑器" }, epoch: 1, consequence: "create", purpose: "开一个新文档" } }] },
      (ms) => ({ calls: [{ name: "plan", args: { steps: [{ purpose: "发出去", objects: [`window:${last(ms).after.window.id}`], consequence: "external" }] } }] }),
      finish,
    ], "写好发出去");
    await rt.run();
    expect(cards[0]!.text).toContain("——往外发，到时候再确认一次");
    expect(cards[0]!.text).not.toContain("改你的东西");
  });

  it("an object written as window:/path: that names nothing on screen or in the folder is not signed and asks nothing", async () => {
    const { sim } = mailSim();
    const { rt, cards, events } = run(sim, [{ calls: [{ name: "plan", args: { steps: [{ purpose: "改一下", objects: ["window:nope-9", "path:没有的文件.txt"], consequence: "create" }] } }] }, finish], "改一下");
    await rt.run();
    expect(cards).toEqual([]);
    expect(events.find((e) => e.k === "plan.classes")!.b).toMatchObject({ settled: ["create"], objects: [] });
  });

  it("hands#54's shape: needs_foreground lists bundle ids, matched by the window id's bundle prefix; the card names the app", async () => {
    let epoch = 1;
    const win = { id: "com.netease.163music#30144", app: "网易云音乐", title: "" };
    const driver = {
      snapshot: () => ({ epoch, locked: false, front_app: "DeskMind", windows: [win], needs_foreground: ["com.netease.163music"] }),
      observe: () => ({ epoch, window: win, modal: null, elements: [{ id: "gen:搜索框", role: "textField", label: "搜索框", actions: ["set_value"] }], text: "" }),
      perform: () => { epoch += 1; return { status: "ok" as const, window: win.id }; },
    };
    const app = ConsentSigner.fresh();
    const ex = new Executor(driver, { task: "t1", publicKey: app.publicKey });
    const gw = new Gateway(table);
    gw.script = Array(20).fill(() => ({ choice: "pass", reason: "ok" }));
    const cards: Card[] = [];
    const steps: Step[] = [{ calls: [{ name: "plan", args: { steps: [{ purpose: "搜索「宝贝 安溥」", objects: ["窗口 com.netease.163music#30144"], consequence: "create" }] } }] }, finish];
    const rt = new FrontierRuntime({ task: "t1", raw: "打开网易云播放安溥的宝贝", executor: ex, signer: app, user: { ask: (c: Card): Answer => { cards.push(c); return { option: c.options.findIndex((o) => o.kind === "approve") }; } }, gateway: gw, model: { ...model, streamFn: scriptedStream(steps) } });
    await rt.run();
    expect(cards[0]!.text).toContain("网易云音乐 只能在前台操作");
    expect(cards[0]!.text).toContain("改你的东西");
  });

  it("steps on the task's own window declared create still need no card", async () => {
    const sim = new SimComputer();
    const { rt, cards } = run(sim, [
      { calls: [{ name: "computer_act", args: { action: { kind: "open_window", app: "编辑器" }, epoch: 1, consequence: "create", purpose: "开一个新文档" } }] },
      (ms) => ({ calls: [{ name: "plan", args: { steps: [{ purpose: "写字", objects: [`window:${last(ms).after.window.id}`], consequence: "create" }] } }] }),
      finish,
    ], "开一个新文档");
    await rt.run();
    expect(cards).toEqual([]);
  });
});

describe("the plan card names the objects as the user knows them (review of #31)", () => {
  it("a window by its app and title, an untitled window as the app's main window, a tab by title and site, a file by its path; unresolved as written", async () => {
    const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
    const { Workspace, build } = await import("../src/registry/workspace.js");
    const { fileRegistry } = await import("../src/registry/fs.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "plancard-"));
    build(root, { "notes/todo.txt": "交房租\n" });
    const ws = new Workspace(root);
    const sim = new SimComputer(root);
    const mailW = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [] }).id;
    const ed = sim.addEditor("编辑器"); ed.title = "";
    const br = sim.addBrowser("Safari", [{ title: "合同续签 - Mailora", url: "http://127.0.0.1:8977/apps/mail.html" }]);
    const tab = br.state.tabs[0].id as string;
    const app = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() } });
    const gw = new Gateway(table);
    gw.script = Array(10).fill(() => ({ choice: "pass", reason: "ok" }));
    const cards: Card[] = [];
    const steps: Step[] = [{ calls: [{ name: "plan", args: { steps: [{ purpose: "整理", objects: [`窗口 ${mailW}`, `window:${ed.id}`, `tab:${tab}`, "notes/todo.txt", "那个不存在的东西"], consequence: "create" }] } }] }, finish];
    const rt = new FrontierRuntime({ task: "t1", raw: "整理一下", executor: ex, signer: app, user: { ask: (c: Card): Answer => { cards.push(c); return { option: c.options.findIndex((o) => o.kind === "approve") }; } }, gateway: gw, model: { ...model, streamFn: scriptedStream(steps) }, workspace: ws, registry: fileRegistry() });
    await rt.run();
    expect(cards[0]!.text).toContain("1. 整理（信鸽「收件箱」、编辑器 的主窗口、「合同续签 - Mailora」（127.0.0.1:8977）、notes/todo.txt、那个不存在的东西）——改你的东西");
    expect(cards[0]!.text).not.toContain(mailW);
  });

  it("one look for the whole plan; none for a plan of looks only", async () => {
    for (const [consequence, want] of [["create", 1], ["read", 0]] as const) {
      const { sim, w } = mailSim();
      const app = ConsentSigner.fresh();
      const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey });
      const gw = new Gateway(table);
      gw.script = Array(10).fill(() => ({ choice: "pass", reason: "ok" }));
      const steps: Step[] = [{ calls: [{ name: "plan", args: { steps: [1, 2, 3].map((n) => ({ purpose: `第 ${n} 步`, objects: [`窗口 ${w}`], consequence })) } }] }, finish];
      let looks = 0, inPlan = false;
      const rt = new FrontierRuntime({ task: "t1", raw: "看看", executor: ex, signer: app, user: { ask: (c: Card): Answer => ({ option: c.options.findIndex((o) => o.kind === "approve") }) }, gateway: gw, model: { ...model, streamFn: scriptedStream(steps) },
        onEvent: (k, b) => { if (k === "tool.result" && b.name === "plan") inPlan = false; } });
      const snap = ex.snapshot.bind(ex);
      ex.snapshot = async () => { if (inPlan) looks += 1; return snap(); };
      const plan = ex.plan.bind(ex);
      ex.plan = async (p) => { const v = await plan(p); inPlan = true; return v; };      // count from the executor's plan to the card
      await rt.run();
      expect([consequence, looks]).toEqual([consequence, want]);
    }
  });
});
