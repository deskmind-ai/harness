/**
 * The execution layer's three lines, with no model at all: ownership from structure, the consequence floor, consent
 * tokens (signed by an app, verified here, bound to the action, spent once), the stop switch, the lock screen and
 * stale observations. A runtime above this layer cannot get an unconsented change through, whatever it is.
 */
import { describe, expect, it } from "vitest";
import { ConsentSigner, digestOf } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import type { Action } from "../src/executor/types.js";

function mailSim() {
  const sim = new SimComputer();
  const w = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: ["m2"], inbox: [
    { id: "m1", from: "林晓", subject: "Q3 预算", body: ["你好，关于Q3 预算，", "会议时间：14:00", "谢谢"], time: "14:00" },
    { id: "m2", from: "林晓", subject: "周会纪要", body: ["会议时间：10:00"], time: "10:00" },
    { id: "m3", from: "苏然", subject: "Q3 预算", body: ["会议时间：09:30"], time: "09:30" },
  ] });
  return { sim, w };
}

function setup() {
  const app = ConsentSigner.fresh();
  const { sim, w } = mailSim();
  const events: string[] = [];
  const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, onEvent: (k) => events.push(k) });
  return { app, sim, w, ex, events };
}

const find = (ex: Executor, win: string, label: string) => { const o = ex.observe(win); const e = o.elements.find((x) => x.label.includes(label))!; return { o, e }; };

describe("executor: ownership and the consequence floor", () => {
  it("windows on screen at begin are the user's; a window the task opens is the task's", () => {
    const { ex, w } = setup();
    const s = ex.begin();
    expect(s.windows.find((x) => x.id === w.id)?.owner).toBe("user");
    const r = ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: s.epoch });
    expect(r.status).toBe("ok");
    expect(r.consequence).toBe("create");
    const s2 = ex.snapshot();
    const mine = s2.windows.find((x) => x.app === "编辑器")!;
    expect(mine.owner).toBe("task");
    // acting in the task's own window is "create"; in the user's it is at least "modify_user"
    const { o, e } = find(ex, mine.id, "新建文档");
    expect(ex.preview({ action: { kind: "click", window: mine.id, target: e.id }, epoch: o.epoch })).toMatchObject({ consequence: "create", needs_consent: false });
    const { o: o2, e: e2 } = find(ex, w.id, "林晓 · Q3 预算");
    expect(ex.preview({ action: { kind: "click", window: w.id, target: e2.id }, epoch: o2.epoch })).toMatchObject({ consequence: "modify_user", needs_consent: true });
  });

  it("a model may raise the class, never lower it", () => {
    const { ex, w } = setup();
    ex.begin();
    const { o, e } = find(ex, w.id, "林晓 · Q3 预算");
    expect(ex.preview({ action: { kind: "click", window: w.id, target: e.id }, epoch: o.epoch, consequence: "read" }).consequence).toBe("modify_user");
    expect(ex.preview({ action: { kind: "click", window: w.id, target: e.id }, epoch: o.epoch, consequence: "external" }).consequence).toBe("external");
  });

  it("an element marked as sending floors at external, even in the task's own window", () => {
    const { ex, sim, app } = setup();
    const s = ex.begin();
    // the task opens its own mail window (the sim lets a test add one after begin)
    const mine = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "a1", from: "顾青", subject: "合同", body: ["x"], time: "10:00" }] });
    ex.ledger.created(`window:${mine.id}`);
    expect(ex.snapshot().windows.find((x) => x.id === mine.id)?.owner).toBe("task");
    void s;
    let { o, e } = find(ex, mine.id, "顾青 · 合同");
    expect(ex.act({ action: { kind: "click", window: mine.id, target: e.id }, epoch: o.epoch }).status).toBe("ok");
    ({ o, e } = find(ex, mine.id, "回复"));
    expect(ex.act({ action: { kind: "click", window: mine.id, target: e.id }, epoch: o.epoch }).status).toBe("ok");
    ({ o, e } = find(ex, mine.id, "回复内容"));
    expect(ex.act({ action: { kind: "set_value", window: mine.id, target: e.id, value: "收到" }, epoch: o.epoch }).status).toBe("ok");
    ({ o, e } = find(ex, mine.id, "发送"));
    const send: Action = { kind: "click", window: mine.id, target: e.id };
    const r = ex.act({ action: send, epoch: o.epoch });
    expect(r.status).toBe("needs_consent");
    expect(r.consequence).toBe("external");
    expect(r.challenge?.text).toContain("发送");
    expect(sim.mailState(mine.id).replies).toEqual([]);
    // the app signs the challenge; the same action with the token goes through; the token is spent
    const token = app.forAction(r.challenge!);
    const ok = ex.act({ action: send, epoch: r.epoch, consent: token });
    expect(ok.status).toBe("ok");
    expect(sim.mailState(mine.id).replies).toEqual([{ to: "a1", body: "收到" }]);
    const again = ex.act({ action: send, epoch: ok.epoch, consent: token });
    expect(again.status).not.toBe("ok");
  });
});

describe("executor: consent tokens", () => {
  it("a token for another action, a forged one, an expired one and a lower class are refused", () => {
    const { ex, w, sim } = setup();
    let now = 1_000_000;
    const app = ConsentSigner.fresh(() => now);
    const ex2 = new Executor(sim, { task: "t1", publicKey: app.publicKey, now: () => now });
    ex2.begin();
    const { o, e } = find(ex2, w.id, "林晓 · Q3 预算");
    const click: Action = { kind: "click", window: w.id, target: e.id };
    const r = ex2.act({ action: click, epoch: o.epoch });
    expect(r.status).toBe("needs_consent");
    const other = app.forAction({ ...r.challenge!, digest: digestOf({ kind: "close_window", window: w.id }, `window:${w.id}`, "modify_user") });
    expect(ex2.act({ action: click, epoch: r.epoch, consent: other }).why).toContain("another action");
    const forged = { ...app.forAction(r.challenge!), sig: Buffer.from("nope").toString("base64") };
    expect(ex2.act({ action: click, epoch: r.epoch, consent: forged }).why).toContain("signature");
    const stranger = ConsentSigner.fresh().forAction(r.challenge!);
    expect(ex2.act({ action: click, epoch: r.epoch, consent: stranger }).why).toContain("signature");
    const expired = app.forAction(r.challenge!, 10);
    now += 11;
    expect(ex2.act({ action: click, epoch: r.epoch, consent: expired }).why).toContain("expired");
    const low = app.forObject(`window:${w.id}`, "create", "t1");
    expect(ex2.act({ action: click, epoch: r.epoch, consent: low }).why).toContain("covers create");
    expect(sim.mailState(w.id).selected).toBeNull();
    void ex;
  });

  it("an object-scoped token covers every action on that object in this task, not in another", () => {
    const { ex, w, app, sim } = setup();
    ex.begin();
    const token = app.forObject(`window:${w.id}`, "modify_user", "t1");
    let { o, e } = find(ex, w.id, "林晓 · Q3 预算");
    expect(ex.act({ action: { kind: "click", window: w.id, target: e.id }, epoch: o.epoch, consent: token }).status).toBe("ok");
    ({ o, e } = find(ex, w.id, "加旗标"));
    expect(ex.act({ action: { kind: "click", window: w.id, target: e.id }, epoch: o.epoch, consent: token }).status).toBe("ok");
    expect(sim.mailState(w.id).flagged).toContain("m1");
    // sending is external: the object token (modify_user) does not reach it
    ({ o, e } = find(ex, w.id, "回复"));
    expect(ex.act({ action: { kind: "click", window: w.id, target: e.id }, epoch: o.epoch, consent: token }).status).toBe("ok");
    ({ o, e } = find(ex, w.id, "发送"));
    expect(ex.act({ action: { kind: "click", window: w.id, target: e.id }, epoch: o.epoch, consent: token }).status).toBe("needs_consent");
    const otherTask = new Executor(sim, { task: "t2", publicKey: app.publicKey });
    otherTask.begin();
    ({ o, e } = find(otherTask, w.id, "取消"));
    expect(otherTask.act({ action: { kind: "click", window: w.id, target: e.id }, epoch: o.epoch, consent: token }).why).toContain("another task");
  });

  it("a rule token is kept and covers later actions matching its pattern", () => {
    const { ex, w, app, sim } = setup();
    ex.begin();
    const rule = app.forRule("关我的邮件窗口不用问", `window:${w.id}`, "modify_user");
    expect(ex.act({ action: { kind: "close_window", window: w.id }, epoch: ex.snapshot().epoch, consent: rule }).status).toBe("ok");
    expect(sim.wins.length).toBe(0);
  });
});

describe("executor: stop, lock, stale", () => {
  it("after stop every action is refused; a locked screen is an environment stop; a stale epoch is refused", () => {
    const { ex, w, sim } = setup();
    const s = ex.begin();
    const { o, e } = find(ex, w.id, "取消旗标");
    void e;
    sim.lock();
    const locked = ex.act({ action: { kind: "wait", ms: 1 }, epoch: o.epoch });
    expect(locked.status).toBe("environment");
    sim.lock(false);
    const stale = ex.act({ action: { kind: "wait", ms: 1 }, epoch: s.epoch });
    expect(stale.status).toBe("stale");
    const fresh = ex.snapshot();
    expect(ex.act({ action: { kind: "wait", ms: 1 }, epoch: fresh.epoch }).status).toBe("ok");
    ex.stop();
    expect(ex.act({ action: { kind: "wait", ms: 1 }, epoch: ex.snapshot().epoch }).status).toBe("stopped");
    expect(ex.receipts.map((r) => r.result.status)).toEqual(["environment", "stale", "ok", "stopped"]);
  });

  it("verify hands back the windows the task touched, observed again", () => {
    const { ex, app, sim } = setup();
    const s = ex.begin();
    const r = ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: s.epoch });
    const mine = r.after!.window.id;
    const { o, e } = find(ex, mine, "新建文档");
    expect(ex.act({ action: { kind: "click", window: mine, target: e.id }, epoch: o.epoch }).status).toBe("ok");
    const v = ex.verify();
    expect(v.windows.map((x) => x.window.id)).toEqual([mine]);
    expect(v.windows[0]!.elements.some((x) => x.label === "正文")).toBe(true);
    expect(v.receipts.length).toBe(2);
    void app; void sim;
  });
});
