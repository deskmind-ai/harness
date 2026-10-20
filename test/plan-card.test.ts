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
