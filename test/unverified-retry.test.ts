/**
 * A step that came back unverified may already have taken effect (hands answered too late, or not at all — harness#66).
 * Doing it again must not slip past the user: the action token is one-shot, so a retried send asks again — and that card
 * must say the last attempt may already have gone out, or the user approves a second send. An open of a site whose
 * per-site token covers the rest of the task is asked again after an unverified open there, saying the same.
 * Both fail on main: the card says nothing of the earlier attempt, and the second open goes without a card.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import type { Action, PerformResult } from "../src/executor/types.js";

/** The driver's answer to `pick` actions: unverified, nothing done (as when hands did not answer in time). */
function uncertain(sim: SimComputer, pick: (a: Action) => boolean) {
  const real = sim.perform.bind(sim);
  let left = 1;
  sim.perform = ((a: Action) => {
    if (left > 0 && pick(a)) { left -= 1; return { status: "unverified", why: "hands perform: no answer in 120000 ms: the step may have taken effect after that; observe the window before doing it again" } as PerformResult; }
    return real(a);
  }) as typeof sim.perform;
}

describe("a retry after an unverified step", () => {
  it("a send asked again says the last attempt may already have gone out, with what the model says of now", async () => {
    const sim = new SimComputer(), app = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey });
    sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [] });
    await ex.begin(); await ex.plan({ steps: [] });
    const mine = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "a1", from: "顾青", subject: "合同", body: ["x"], time: "10:00" }] });
    ex.ledger.created(`window:${mine.id}`);
    const el = async (label: string) => { const o = await ex.observe(mine.id); return { o, e: o.elements.find((x) => x.label.includes(label))! }; };
    let { o, e } = await el("顾青 · 合同");
    await ex.act({ action: { kind: "click", window: mine.id, target: e.id }, epoch: o.epoch });
    ({ o, e } = await el("回复"));
    await ex.act({ action: { kind: "click", window: mine.id, target: e.id }, epoch: o.epoch });
    ({ o, e } = await el("回复内容"));
    await ex.act({ action: { kind: "set_value", window: mine.id, target: e.id, value: "收到" }, epoch: o.epoch });
    ({ o, e } = await el("发送"));
    const send: Action = { kind: "click", window: mine.id, target: e.id };
    uncertain(sim, (a) => a.kind === "click" && a.target === e.id);
    const first = await ex.act({ action: send, epoch: o.epoch });
    expect(first.status).toBe("needs_consent");
    expect(first.challenge!.text).not.toContain("结果不确定");               // nothing uncertain yet
    const sent = await ex.act({ action: send, epoch: first.epoch, consent: app.forAction(first.challenge!) });
    expect(sent.status).toBe("unverified");
    ({ o, e } = await el("发送"));
    const retry = await ex.act({ action: { kind: "click", window: mine.id, target: e.id }, epoch: o.epoch, purpose: "发件箱里没有这封回复，再发一次" });
    expect(retry.status).toBe("needs_consent");
    expect(retry.challenge!.text).toMatch(/^注意：上一次「.*」结果不确定，可能已经发出或生效了/);
    expect(retry.challenge!.text).toContain("模型对现在情况的说法：发件箱里没有这封回复，再发一次");
    expect(retry.challenge!.facts?.prior_unverified).toMatchObject({ model_says: "发件箱里没有这封回复，再发一次" });
  });

  it("an open of a site approved for the task is asked again after an unverified open there, saying so", async () => {
    const { Workspace, build } = await import("../src/registry/workspace.js");
    const { fileRegistry } = await import("../src/registry/fs.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "unsure-site-")); build(root, { "合同.txt": "合同金额 98000 元\n" });
    const sim = new SimComputer(root), app = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, raw: "搜索合同模板", files: { workspace: new Workspace(root), registry: fileRegistry() } });
    await ex.begin(); await ex.plan({ steps: [] });
    await ex.act({ action: { kind: "file", capability: "fs.read_text", args: { target: "合同.txt" } }, epoch: ex.currentEpoch });     // material read: a new site is a send
    const open = (q: string, consent?: Parameters<Executor["act"]>[0]["consent"]) => ex.act({ action: { kind: "open_window", app: "Google Chrome", url: "https://www.google.com/search?q=" + q }, epoch: ex.currentEpoch, consent });
    const r = await open("a");
    expect(r.status).toBe("needs_consent");
    uncertain(sim, (a) => a.kind === "open_window");
    const first = await open("a", app.forSite(r.challenge!.object, [r.challenge!.site!], "t1", r.challenge!.consequence));
    expect(first.status).toBe("unverified");
    const again = await open("b");                           // the site token would cover it for the rest of the task
    expect(again.status).toBe("needs_consent");
    expect(again.challenge!.text).toMatch(/^注意：上一次「.*」结果不确定/);
    // approved again and done: the host is covered again, and no card warns of the settled attempt
    const ok = await open("b", app.forSite(again.challenge!.object, [again.challenge!.site!], "t1", again.challenge!.consequence));
    expect(ok.status).toBe("ok");
    expect((await open("c")).status).toBe("ok");
  });
});
