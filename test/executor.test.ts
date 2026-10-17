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

function setup(now?: () => number) {
  const app = ConsentSigner.fresh(now);
  const { sim, w } = mailSim();
  const events: string[] = [];
  const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, now, onEvent: (k) => events.push(k) });
  return { app, sim, w, ex, events };
}

const find = async (ex: Executor, win: string, label: string) => { const o = await ex.observe(win); const e = o.elements.find((x) => x.label.includes(label))!; return { o, e }; };
const click = async (ex: Executor, win: string, label: string, extra: Record<string, unknown> = {}) => { const { o, e } = await find(ex, win, label); return ex.act({ action: { kind: "click", window: win, target: e.id }, epoch: o.epoch, ...extra }); };

describe("executor: ownership and the consequence floor", () => {
  it("windows on screen at begin are the user's; a window the task opens is the task's", async () => {
    const { ex, w } = setup();
    const s = await ex.begin();
    expect(s.windows.find((x) => x.id === w.id)?.owner).toBe("user");
    const r = await ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: s.epoch });
    expect(r.status).toBe("ok");
    expect(r.consequence).toBe("create");
    const s2 = await ex.snapshot();
    const mine = s2.windows.find((x) => x.app === "编辑器")!;
    expect(mine.owner).toBe("task");
    // acting in the task's own window is "create"; in the user's it is at least "modify_user"
    const { o, e } = await find(ex, mine.id, "新建文档");
    expect(ex.preview({ action: { kind: "click", window: mine.id, target: e.id }, epoch: o.epoch })).toMatchObject({ consequence: "create", needs_consent: false });
    const { o: o2, e: e2 } = await find(ex, w.id, "林晓 · Q3 预算");
    expect(ex.preview({ action: { kind: "click", window: w.id, target: e2.id }, epoch: o2.epoch })).toMatchObject({ consequence: "modify_user", needs_consent: true });
  });

  it("a model may raise the class, never lower it", async () => {
    const { ex, w } = setup();
    await ex.begin();
    const { o, e } = await find(ex, w.id, "林晓 · Q3 预算");
    expect(ex.preview({ action: { kind: "click", window: w.id, target: e.id }, epoch: o.epoch, consequence: "read" }).consequence).toBe("modify_user");
    expect(ex.preview({ action: { kind: "click", window: w.id, target: e.id }, epoch: o.epoch, consequence: "external" }).consequence).toBe("external");
  });

  it("an element marked as sending floors at external, even in the task's own window", async () => {
    const { ex, sim, app } = setup();
    await ex.begin();
    // the task's own mail window (the sim lets a test add one after begin)
    const mine = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "a1", from: "顾青", subject: "合同", body: ["x"], time: "10:00" }] });
    ex.ledger.created(`window:${mine.id}`);
    expect((await ex.snapshot()).windows.find((x) => x.id === mine.id)?.owner).toBe("task");
    expect((await click(ex, mine.id, "顾青 · 合同")).status).toBe("ok");
    expect((await click(ex, mine.id, "回复")).status).toBe("ok");
    const { o, e } = await find(ex, mine.id, "回复内容");
    expect((await ex.act({ action: { kind: "set_value", window: mine.id, target: e.id, value: "收到" }, epoch: o.epoch })).status).toBe("ok");
    const { o: o2, e: e2 } = await find(ex, mine.id, "发送");
    const send: Action = { kind: "click", window: mine.id, target: e2.id };
    const r = await ex.act({ action: send, epoch: o2.epoch });
    expect(r.status).toBe("needs_consent");
    expect(r.consequence).toBe("external");
    expect(r.challenge?.text).toContain("发送");
    expect(sim.mailState(mine.id).replies).toEqual([]);
    // the app signs the challenge; the same action with the token goes through; the token is spent
    const token = app.forAction(r.challenge!);
    const ok = await ex.act({ action: send, epoch: r.epoch, consent: token });
    expect(ok.status).toBe("ok");
    expect(sim.mailState(mine.id).replies).toEqual([{ to: "a1", body: "收到" }]);
    const again = await ex.act({ action: send, epoch: ok.epoch, consent: token });
    expect(again.status).not.toBe("ok");
  });
});

describe("executor: consent tokens", () => {
  it("a token for another action, a forged one, an expired one and a lower class are refused", async () => {
    let now = 1_000_000;
    const { ex, w, app, sim } = setup(() => now);
    await ex.begin();
    const { o, e } = await find(ex, w.id, "林晓 · Q3 预算");
    const click1: Action = { kind: "click", window: w.id, target: e.id };
    const r = await ex.act({ action: click1, epoch: o.epoch });
    expect(r.status).toBe("needs_consent");
    const other = app.forAction({ ...r.challenge!, digest: digestOf({ kind: "close_window", window: w.id }, `window:${w.id}`, "modify_user") });
    expect((await ex.act({ action: click1, epoch: r.epoch, consent: other })).why).toContain("another action");
    const forged = { ...app.forAction(r.challenge!), sig: Buffer.from("nope").toString("base64") };
    expect((await ex.act({ action: click1, epoch: r.epoch, consent: forged })).why).toContain("signature");
    const stranger = ConsentSigner.fresh().forAction(r.challenge!);
    expect((await ex.act({ action: click1, epoch: r.epoch, consent: stranger })).why).toContain("signature");
    const expired = app.forAction(r.challenge!, 10);
    now += 11;
    expect((await ex.act({ action: click1, epoch: r.epoch, consent: expired })).why).toContain("expired");
    const low = app.forObject(`window:${w.id}`, "create", "t1");
    expect((await ex.act({ action: click1, epoch: r.epoch, consent: low })).why).toContain("covers create");
    expect(sim.mailState(w.id).selected).toBeNull();
  });

  it("an object-scoped token covers every action on that object in this task, not in another", async () => {
    const { ex, w, app, sim } = setup();
    await ex.begin();
    const token = app.forObject(`window:${w.id}`, "modify_user", "t1");
    expect((await click(ex, w.id, "林晓 · Q3 预算", { consent: token })).status).toBe("ok");
    expect((await click(ex, w.id, "加旗标", { consent: token })).status).toBe("ok");
    expect(sim.mailState(w.id).flagged).toContain("m1");
    // sending is external: the object token (modify_user) does not reach it
    expect((await click(ex, w.id, "回复", { consent: token })).status).toBe("ok");
    expect((await click(ex, w.id, "发送", { consent: token })).status).toBe("needs_consent");
    const otherTask = new Executor(sim, { task: "t2", publicKey: app.publicKey });
    await otherTask.begin();
    expect((await click(otherTask, w.id, "取消", { consent: token })).why).toContain("another task");
  });

  it("a rule token is kept and covers later actions matching its pattern", async () => {
    const { ex, w, app, sim } = setup();
    await ex.begin();
    const rule = app.forRule("关我的邮件窗口不用问", `window:${w.id}`, "modify_user");
    expect((await ex.act({ action: { kind: "close_window", window: w.id }, epoch: (await ex.snapshot()).epoch, consent: rule })).status).toBe("ok");
    expect(sim.wins.length).toBe(0);
  });
});

describe("executor: stop, lock, stale", () => {
  it("after stop every action is refused; a locked screen is an environment stop; a stale epoch is refused", async () => {
    const { ex, w, sim } = setup();
    const s = await ex.begin();
    const { o } = await find(ex, w.id, "取消旗标");
    sim.lock();
    expect((await ex.act({ action: { kind: "wait", ms: 1 }, epoch: o.epoch })).status).toBe("environment");
    sim.lock(false);
    expect((await ex.act({ action: { kind: "wait", ms: 1 }, epoch: s.epoch })).status).toBe("stale");
    const fresh = await ex.snapshot();
    expect((await ex.act({ action: { kind: "wait", ms: 1 }, epoch: fresh.epoch })).status).toBe("ok");
    ex.stop();
    expect((await ex.act({ action: { kind: "wait", ms: 1 }, epoch: (await ex.snapshot()).epoch })).status).toBe("stopped");
    expect(ex.receipts.map((r) => r.result.status)).toEqual(["environment", "stale", "ok", "stopped"]);
  });

  it("verify hands back the windows the task touched, observed again", async () => {
    const { ex } = setup();
    const s = await ex.begin();
    const r = await ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: s.epoch });
    const mine = r.after!.window.id;
    expect((await click(ex, mine, "新建文档")).status).toBe("ok");
    const v = await ex.verify();
    expect(v.windows.map((x) => x.window.id)).toEqual([mine]);
    expect(v.windows[0]!.elements.some((x) => x.label === "正文")).toBe(true);
    expect(v.receipts.length).toBe(2);
  });
});
