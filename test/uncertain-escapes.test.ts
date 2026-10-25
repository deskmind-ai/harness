/**
 * Ways a possibly-done step escaped the run-level uncertain list (review of harness#66 at eb0d51e), and what the
 * list's card says. The invariant: after any step of this run comes back unverified (or is found unknown after a
 * restart) with consequence modify_user or external, no further modify_user or external action happens without a
 * card that names the uncertain step(s).
 *
 * Fail on eb0d51e: A (a retried send key in the task's own window went with no card: the typed text was dropped as
 * if the send were known to have gone); C (a send that may have gone before a crash was not on the list after the
 * restart); the re-plan re-issued object consents; the card listed every step in full; an English card cut text
 * with 「…（共 N 字）」 and joined with 「：」. The service-clear and lock-after cases pass on eb0d51e: they catch the
 * mutants that survived there (dropping the service's clear; leaving a lock after the act out of the list).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/index.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { ExecutorService } from "../src/executor/service.js";
import { Judge, OUTGOING_QUESTION, type JudgeTier } from "../src/executor/judge.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import type { Action, ConsentToken, Driver, Element, PerformResult, WindowInfo } from "../src/executor/types.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as never;
const UNSURE = "hands perform: no answer in 120000 ms";

function uncertain(sim: SimComputer, pick: (a: Action) => boolean, n = 1) {
  const real = sim.perform.bind(sim);
  sim.perform = ((a: Action) => { if (n > 0 && pick(a)) { n -= 1; return { status: "unverified", why: UNSURE } as PerformResult; } return real(a); }) as typeof sim.perform;
}

/** A chat window of the task's own, read from its pixels: a message box and a send key, no button marked as sending. */
class Chat implements Driver {
  epoch = 1; log: Action[] = []; unsure = 0; shown = false;
  info: WindowInfo = { id: "chat", app: "聊天", title: "张三" };
  elements: Element[] = [{ id: "ocr:1", role: "listitem", label: "输入消息…", actions: ["click", "type"] }];
  snapshot() { return { epoch: this.epoch, locked: false, front_app: "聊天", windows: this.shown ? [this.info] : [] }; }
  observe() { return { epoch: this.epoch, window: this.info, modal: null, elements: this.elements, text: "输入消息…" }; }
  perform(a: Action) { this.log.push(a); this.epoch += 1; if (this.unsure > 0) { this.unsure -= 1; return { status: "unverified" as const, why: UNSURE }; } return { status: "ok" as const, window: "chat" }; }
}

describe("possibly-done steps that escaped the list", () => {
  it("A: a send key retried in the task's own window after an unverified send asks, naming it (the typed text is kept)", async () => {
    const top = new Gateway(table);
    top.script = Array(80).fill((_r: string, _s: string, u: string) => (u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: "sends" } : { choice: "matches" }));
    const chat = new Chat(), app = ConsentSigner.fresh();
    const ex = new Executor(chat, { task: "t1", publicKey: app.publicKey, judge: new Judge([{ name: "frontier", gateway: top } as JudgeTier]), raw: "回张三：明天见" });
    await ex.begin(); await ex.plan({ steps: [] });
    chat.shown = true; chat.epoch++; await ex.snapshot(); ex.ledger.created("window:chat");
    let o = await ex.observe("chat");
    expect((await ex.act({ action: { kind: "type", window: "chat", target: "ocr:1", text: "明天见" }, epoch: o.epoch })).status).toBe("ok");
    o = await ex.observe("chat");
    const key: Action = { kind: "key", window: "chat", chord: "cmd+shift+d" };
    const k1 = await ex.act({ action: key, epoch: o.epoch });
    expect([k1.status, k1.consequence]).toEqual(["needs_consent", "external"]);
    chat.unsure = 1;
    expect((await ex.act({ action: key, epoch: k1.epoch, consent: app.forAction(k1.challenge!) })).status).toBe("unverified");
    o = await ex.observe("chat");
    const k2 = await ex.act({ action: key, epoch: o.epoch });
    expect(k2.status).toBe("needs_consent");
    expect(k2.challenge!.text).toMatch(/^之前「.*cmd\+shift\+d.*」结果不确定/);
    expect(chat.log.filter((a) => a.kind === "key")).toHaveLength(1);           // pressed once, not twice
  });

  it("C: a send that may have gone out before a crash is on the list after the restart, and after the next restart", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "uncertain-crash-")), journal = path.join(root, "journal.jsonl");
    const app = ConsentSigner.fresh(), sim = new SimComputer();
    const user = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "u1", from: "林晓", subject: "Q3 预算", body: ["x"], time: "09:00" }] });
    const first = new Executor(sim, { task: "t1", publicKey: app.publicKey, journal });
    await first.begin(); await first.plan({ steps: [] });
    const click = async (ex: Executor, label: string, consent?: ConsentToken) => { const o = await ex.observe(user.id); const e = o.elements.find((x) => x.label.includes(label))!; return ex.act({ action: { kind: "click", window: user.id, target: e.id }, epoch: o.epoch, ...(consent ? { consent } : {}) }); };
    const planned = app.forObject(`window:${user.id}`, "modify_user", "t1");
    expect((await click(first, "林晓 · Q3 预算", planned)).status).toBe("ok");      // the row selected, receipted
    const crashing = new Executor(sim, { task: "t1", publicKey: app.publicKey, journal, crashAfterFirstEffect: true });
    await crashing.begin(); await crashing.plan({ steps: [] });
    expect(crashing.uncertainCount).toBe(0);
    await expect(click(crashing, "加旗标", planned)).rejects.toThrow("crash after"); // flagged; the receipt never written
    for (let restart = 0; restart < 2; restart += 1) {
      const next = new Executor(sim, { task: "t1", publicKey: app.publicKey, journal });
      await next.begin(); await next.plan({ steps: [] });
      expect(next.uncertainCount).toBe(1);
      const card = await click(next, "旗标", app.forObject(`window:${user.id}`, "modify_user", "t1"));   // 取消旗标 now: it went
      expect(card.status).toBe("needs_consent");
      expect(card.challenge!.text).toMatch(/^之前「.*旗标.*」结果不确定/);
    }
  });

  it("a lock right after the act joins the list (the mutant that left it out survived)", async () => {
    const sim = new SimComputer(), app = ConsentSigner.fresh();
    const user = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "u1", from: "林晓", subject: "Q3 预算", body: ["x"], time: "09:00" }] });
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey });
    await ex.begin(); await ex.plan({ steps: [] });
    const planned = app.forObject(`window:${user.id}`, "modify_user", "t1");
    const real = sim.perform.bind(sim);
    let lock = true;
    sim.perform = ((a: Action) => { const r = real(a); if (lock) { lock = false; sim.lock(true); } return r; }) as typeof sim.perform;
    lock = false;
    let o = await ex.observe(user.id);
    await ex.act({ action: { kind: "click", window: user.id, target: o.elements.find((e) => e.label.includes("林晓"))!.id }, epoch: o.epoch, consent: planned });
    lock = true;
    o = await ex.observe(user.id);
    const r = await ex.act({ action: { kind: "click", window: user.id, target: o.elements.find((e) => e.label.includes("加旗标"))!.id }, epoch: o.epoch, consent: planned });
    expect([r.status, r.cause]).toEqual(["unverified", "screen_locked"]);
    expect(ex.uncertainCount).toBe(1);
  });

  it("a card lists at most five lines, the same step once with how many times, and counts the rest", async () => {
    // a window of the user's with six buttons, every click answered unverified
    class Desk implements Driver {
      epoch = 1;
      info: WindowInfo = { id: "w", app: "表单", title: "报销" };
      elements: Element[] = ["甲", "乙", "丙", "丁", "戊", "己"].map((l, i) => ({ id: `b${i}`, role: "button", label: l, actions: ["click"] }));
      snapshot() { return { epoch: this.epoch, locked: false, front_app: "表单", windows: [this.info] }; }
      observe() { return { epoch: this.epoch, window: this.info, modal: null, elements: this.elements, text: "" }; }
      perform() { this.epoch += 1; return { status: "unverified" as const, why: UNSURE }; }
    }
    const desk = new Desk(), app = ConsentSigner.fresh();
    const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey });
    await ex.begin(); await ex.plan({ steps: [] });
    const press = async (label: string) => {
      const o = await ex.observe("w");
      const a: Action = { kind: "click", window: "w", target: o.elements.find((e) => e.label === label)!.id };
      const asked = await ex.act({ action: a, epoch: o.epoch, consequence: "modify_user" });
      expect(asked.status).toBe("needs_consent");
      return { asked, done: await ex.act({ action: a, epoch: asked.epoch, consequence: "modify_user", consent: app.forAction(asked.challenge!) }) };
    };
    for (const l of ["乙", "丙", "丁", "戊", "己", "甲", "甲", "甲"]) expect((await press(l)).done.status).toBe("unverified");
    expect(ex.uncertainCount).toBe(8);
    const { asked } = await press("甲");
    const text = asked.challenge!.text;
    const lines = text.split("\n").filter((l) => l.startsWith("之前「"));
    expect(lines).toHaveLength(5);                                                      // six different steps, five lines
    expect(new Set(lines).size).toBe(5);
    expect(text).toContain("（3 次）");                                                  // 甲 three times: one line
    expect(text).toContain("另有 1 条结果不确定的步骤");
    expect(asked.challenge!.facts?.uncertain_total).toBe(8);
  });

  it("an English card cuts and joins in English", async () => {
    const sim = new SimComputer(), app = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, lang: "en" });
    sim.addMail({ app: "Mail", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [] });
    await ex.begin(); await ex.plan({ steps: [] });
    const mine = sim.addMail({ app: "Mail", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "a1", from: "Gu", subject: "contract", body: ["x"], time: "10:00" }] });
    ex.ledger.created(`window:${mine.id}`);
    const el = async (label: string) => { const o = await ex.observe(mine.id); return { o, e: o.elements.find((x) => x.label.includes(label))! }; };
    let { o, e } = await el("Gu"); await ex.act({ action: { kind: "click", window: mine.id, target: e.id }, epoch: o.epoch });
    ({ o, e } = await el("回复")); await ex.act({ action: { kind: "click", window: mine.id, target: e.id }, epoch: o.epoch });
    ({ o, e } = await el("回复内容"));
    await ex.act({ action: { kind: "set_value", window: mine.id, target: e.id, value: "x".repeat(300) }, epoch: o.epoch });
    ({ o, e } = await el("发送"));
    const asked = await ex.act({ action: { kind: "click", window: mine.id, target: e.id }, epoch: o.epoch });
    uncertain(sim, (a) => a.kind === "click");
    await ex.act({ action: { kind: "click", window: mine.id, target: e.id }, epoch: asked.epoch, consent: app.forAction(asked.challenge!) });
    ({ o, e } = await el("发送"));
    const again = await ex.act({ action: { kind: "click", window: mine.id, target: e.id }, epoch: o.epoch });
    const head = again.challenge!.text.split("\n")[0]!;
    expect(head).toMatch(/^Earlier, \u201c.*: .*\u201d has an unknown result/);
    expect(again.challenge!.text).not.toMatch(/（共 \d+ 字）|」：/);
    expect(again.challenge!.text).toMatch(/characters in all\)/);
  });
});

describe("user_busy is nothing done only on the driver's word", () => {
  it("with performed: false it is blocked; without it, unverified and on the list", async () => {
    for (const performed of [false, undefined]) {
      const chat = new Chat(), app = ConsentSigner.fresh();
      (chat as unknown as { perform: (a: Action) => PerformResult }).perform = (a: Action): PerformResult => { chat.log.push(a); chat.epoch += 1; return { status: "user_busy" as const, why: "the user is active", ...(performed === false ? { performed: false } : {}) }; };
      const ex = new Executor(chat, { task: "t1", publicKey: app.publicKey });
      await ex.begin(); await ex.plan({ steps: [] });
      chat.shown = true; chat.epoch++; await ex.snapshot();
      const o = await ex.observe("chat");
      const a: Action = { kind: "click", window: "chat", target: "ocr:1" };
      const asked = await ex.act({ action: a, epoch: o.epoch, consequence: "modify_user" });
      const r = await ex.act({ action: a, epoch: asked.epoch, consequence: "modify_user", consent: app.forAction(asked.challenge!) });
      expect([r.status, ex.uncertainCount]).toEqual(performed === false ? ["blocked", 0] : ["unverified", 1]);
    }
  });
});

describe("the service's standing grants after an uncertain step", () => {
  async function svcRun() {
    const sim = new SimComputer(), signer = ConsentSigner.fresh(), events: { k: string; b: Record<string, unknown> }[] = [];
    const user = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "u1", from: "林晓", subject: "Q3 预算", body: ["x"], time: "09:00" }] });
    const gw = new Gateway(table); gw.script = Array(80).fill(() => ({ choice: "matches" }));
    const ex = new Executor(sim, { task: "t", publicKey: signer.publicKey });
    const svc = new ExecutorService({ task: "t", raw: "给林晓那封邮件加旗标", executor: ex, signer, user: { ask: () => ({ option: 0 }) }, gateway: gw, onEvent: (k, b) => events.push({ k, b }) });
    await svc.port.begin();
    const step = { purpose: "给林晓那封邮件加旗标", objects: [`window:${user.id}`], consequence: "modify_user" as const };
    await svc.port.plan({ steps: [step] });
    const grants = () => ({ objects: (svc as unknown as { tokens: Map<string, unknown> }).tokens.size, sites: (svc as unknown as { siteTokens: unknown[] }).siteTokens.length });
    return { sim, ex, svc, user, events, step, grants };
  }

  it("are void once a change comes back unverified (the mutant that kept them survived), and a new plan signs none", async () => {
    const { sim, ex, svc, user, events, step, grants } = await svcRun();
    expect(grants().objects).toBe(1);
    let o = await ex.observe(user.id);
    await svc.port.act({ action: { kind: "click", window: user.id, target: o.elements.find((e) => e.label.includes("林晓"))!.id }, epoch: o.epoch, consequence: "modify_user", purpose: "选中" });
    uncertain(sim, (a) => a.kind === "click");
    o = await ex.observe(user.id);
    await svc.port.act({ action: { kind: "click", window: user.id, target: o.elements.find((e) => e.label.includes("加旗标"))!.id }, epoch: o.epoch, consequence: "modify_user", purpose: "加旗标" });
    expect(ex.uncertainCount).toBe(1);
    expect(events.some((e) => e.k === "grants.void")).toBe(true);
    expect(grants()).toEqual({ objects: 0, sites: 0 });
    await svc.port.plan({ steps: [step] });                                         // planned again
    expect(grants()).toEqual({ objects: 0, sites: 0 });
    expect(events.filter((e) => e.k === "plan.confirmed").at(-1)!.b.objects).toEqual([]);
  });
});
