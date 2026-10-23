/**
 * After a step of this run comes back unverified while changing the user's things or sending something out (it may
 * already have taken effect: hands answered too late, or not at all — harness#66), no further modify_user or external
 * action happens without a card that names the uncertain step(s). A run-level fact: no matching by object or action,
 * no clearing on a later success, and no standing grant (plan object consent, site token, a token kept for a retry)
 * covers it. Read-only actions and the task's own windows (create) are unaffected.
 *
 * Each case fails on 494f62a (which matched by object or action): the site token carried again opened without a card
 * (B1), a send from another compose window had no warning (B2), a plan-approved change went through on its object
 * consent, and a different send's card did not name the earlier step and its content.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import type { Action, ConsentToken, PerformResult } from "../src/executor/types.js";

const UNSURE = "hands perform: no answer in 120000 ms: the step may have taken effect after that; observe the window before doing it again";

/** The driver answers the next `n` actions `pick` matches with unverified, doing nothing (hands did not answer in time). */
function uncertain(sim: SimComputer, pick: (a: Action) => boolean, n = 1) {
  const real = sim.perform.bind(sim);
  sim.perform = ((a: Action) => {
    if (n > 0 && pick(a)) { n -= 1; return { status: "unverified", why: UNSURE } as PerformResult; }
    return real(a);
  }) as typeof sim.perform;
}

/** A mail run: the task's own compose windows (made after begin), each answering 顾青's mail. */
async function mailRun() {
  const sim = new SimComputer(), app = ConsentSigner.fresh(), events: { k: string; b: Record<string, unknown> }[] = [];
  const user = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "u1", from: "林晓", subject: "Q3 预算", body: ["x"], time: "09:00" }] });
  const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, onEvent: (k, b) => events.push({ k, b }) });
  await ex.begin(); await ex.plan({ steps: [] });
  const el = async (w: string, label: string) => { const o = await ex.observe(w); return { o, e: o.elements.find((x) => x.label.includes(label))! }; };
  const click = async (w: string, label: string, extra: { consent?: ConsentToken; purpose?: string } = {}) => { const { o, e } = await el(w, label); return ex.act({ action: { kind: "click", window: w, target: e.id }, epoch: o.epoch, ...extra }); };
  /** a compose window of the task's own with `body` typed into the reply, ready to send */
  const compose = async (body: string) => {
    const w = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "a1", from: "顾青", subject: "合同", body: ["x"], time: "10:00" }] }).id;
    ex.ledger.created(`window:${w}`);
    await click(w, "顾青 · 合同"); await click(w, "回复");
    const { o, e } = await el(w, "回复内容");
    expect((await ex.act({ action: { kind: "set_value", window: w, target: e.id, value: body }, epoch: o.epoch })).status).toBe("ok");
    return w;
  };
  /** send from `w`: the card, the user's yes, the send; the card returned */
  const send = async (w: string, purpose?: string) => {
    const asked = await click(w, "发送", purpose ? { purpose } : {});
    expect(asked.status).toBe("needs_consent");
    const done = await click(w, "发送", { consent: app.forAction(asked.challenge!) });
    return { card: asked.challenge!, done };
  };
  return { sim, app, ex, user, events, el, click, compose, send };
}

describe("after a step of this run came back unverified", () => {
  it("B2: a send of the same reply from another compose window asks, naming the uncertain send and what it sent", async () => {
    const { sim, compose, send } = await mailRun();
    const w1 = await compose("我看一下再说");
    uncertain(sim, (a) => a.kind === "click" && a.window === w1);
    expect((await send(w1)).done.status).toBe("unverified");
    const w2 = await compose("我看一下再说");                        // new window, new element ids
    const { card } = await send(w2, "发件箱里没看到上一封");
    expect(card.text).toMatch(/^之前「.*我看一下再说.*」结果不确定，可能已经发出或生效了。\n先看一眼再决定，别重复做。\n模型的说法，未核实：发件箱里没看到上一封\n/);
    expect(card.facts?.uncertain).toHaveLength(1);
    expect(card.facts?.uncertain?.[0]).toMatchObject({ consequence: "external", object: `window:${w1}` });
    expect(card.facts?.model_says_unchecked).toBe("发件箱里没看到上一封");
  });

  it("a different send, and every change after it, still names the earlier one: a send that went fine clears nothing", async () => {
    const { sim, compose, send } = await mailRun();
    const w1 = await compose("回复A");
    uncertain(sim, (a) => a.kind === "click" && a.window === w1);
    expect((await send(w1)).done.status).toBe("unverified");
    const w2 = await compose("回复B");
    const b = await send(w2);
    expect(b.card.text).toContain("之前「");
    expect(b.card.text).toContain("回复A");
    expect(b.done.status).toBe("ok");                                 // B went out fine
    const w3 = await compose("回复C");
    const c = await send(w3);
    expect(c.card.facts?.uncertain?.map((u) => u.text).join()).toContain("回复A");    // still named: not cleared by B
  });

  it("a plan-approved change asks again (its object consent no longer covers it); looks and the task's own windows do not", async () => {
    const { sim, app, ex, user, click, compose } = await mailRun();
    const planned = app.forObject(`window:${user.id}`, "modify_user", "t1");      // as the service attaches the plan's
    expect((await click(user.id, "林晓 · Q3 预算", { consent: planned })).status).toBe("ok");   // covered, no card
    uncertain(sim, (a) => a.kind === "click" && a.window === user.id);
    const flag = await click(user.id, "加旗标", { consent: planned });
    expect([flag.status, flag.consequence]).toEqual(["unverified", "modify_user"]);
    const again = await click(user.id, "加旗标", { consent: planned });
    expect(again.status).toBe("needs_consent");
    expect(again.challenge!.text).toMatch(/^之前「.*加旗标.*」结果不确定/);
    // the card's yes (an action token issued after the uncertain step) lets that one action go
    expect((await click(user.id, "加旗标", { consent: app.forAction(again.challenge!) })).status).toBe("ok");
    // read-only: a look, a wait; and a change in the task's own window (create): no card
    await ex.observe(user.id);
    expect((await ex.act({ action: { kind: "wait", ms: 1 }, epoch: ex.currentEpoch })).status).toBe("ok");
    await compose("草稿");                                           // set_value in a window of the task's own: ok inside
  });

  it("B1: an open of an approved site asks again, though the site token is carried along as the service does", async () => {
    const { Workspace, build } = await import("../src/registry/workspace.js");
    const { fileRegistry } = await import("../src/registry/fs.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "unsure-site-")); build(root, { "合同.txt": "合同金额 98000 元\n" });
    const sim = new SimComputer(root), app = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, raw: "搜索合同模板", files: { workspace: new Workspace(root), registry: fileRegistry() } });
    await ex.begin(); await ex.plan({ steps: [] });
    await ex.act({ action: { kind: "file", capability: "fs.read_text", args: { target: "合同.txt" } }, epoch: ex.currentEpoch });     // material read: a new site is a send
    const open = (q: string, consent?: ConsentToken) => ex.act({ action: { kind: "open_window", app: "Google Chrome", url: "https://www.google.com/search?q=" + q }, epoch: ex.currentEpoch, consent });
    const r = await open("a");
    expect(r.status).toBe("needs_consent");
    const site = app.forSite(r.challenge!.object, [r.challenge!.site!], "t1", r.challenge!.consequence);
    uncertain(sim, (a) => a.kind === "open_window");
    expect((await open("a", site)).status).toBe("unverified");
    const again = await open("a", site);                             // the service attaches the host's token on every open
    expect(again.status).toBe("needs_consent");
    expect(again.challenge!.text).toMatch(/^之前「.*」结果不确定/);
    expect(again.challenge!.site).toBeUndefined();                   // the yes is for this one open, not the site
    expect((await open("a", app.forAction(again.challenge!))).status).toBe("ok");
    expect((await open("b", site)).status).toBe("needs_consent");   // and the next one asks again
  });
});
