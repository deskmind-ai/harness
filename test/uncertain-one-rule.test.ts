/**
 * One rule for "is this step possibly done": the uncertain list is possibly.ts' (harness#68), not a rule of its own
 * (review of harness#66 round 5 — the second bug of the family). A step is on the list when it needed consent
 * (modify_user / external), its journal says possibly done, and its receipt is not ok: the result card's "unsure" set
 * (stepLines) of consent steps, live and after any number of restarts.
 *
 * Fail on 7895a9b (#66's own rule: only receipts that said unverified, plus a recovery receipt read once): an error
 * or a blocked step with no performed:false was not listed; a second restart after a reconcile_pending lost the step;
 * the card dropped the oldest outbound step past five.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { stepLines } from "../src/executor/possibly.js";
import { SimComputer } from "../src/executor/sim.js";
import { fileRegistry } from "../src/registry/fs.js";
import { Workspace, build } from "../src/registry/workspace.js";
import type { Action, Driver, Element, PerformResult, WindowInfo } from "../src/executor/types.js";

/** A window of the user's with buttons; a click answers `reply` (the next one in the queue), or ok. */
class Desk implements Driver {
  epoch = 1; replies: PerformResult[] = [];
  info: WindowInfo = { id: "w", app: "表单", title: "报销" };
  elements: Element[] = [
    ...["甲", "乙", "丙", "丁", "戊", "己"].map((l, i) => ({ id: `b${i}`, role: "button", label: l, actions: ["click"] })),
    { id: "send", role: "button", label: "发送", actions: ["click"], sends: true },
  ];
  snapshot() { return { epoch: this.epoch, locked: false, front_app: "表单", windows: [this.info] }; }
  observe() { return { epoch: this.epoch, window: this.info, modal: null, elements: this.elements, text: "" }; }
  perform() { this.epoch += 1; return this.replies.shift() ?? { status: "ok" as const, window: "w" }; }
}

async function desk() {
  const d = new Desk(), app = ConsentSigner.fresh();
  const ex = new Executor(d, { task: "t1", publicKey: app.publicKey });
  await ex.begin(); await ex.plan({ steps: [] });
  /** a click with the card's yes; `reply`: what the driver answers */
  const press = async (label: string, reply?: PerformResult) => {
    const o = await ex.observe("w");
    const a: Action = { kind: "click", window: "w", target: o.elements.find((e) => e.label === label)!.id };
    const asked = await ex.act({ action: a, epoch: o.epoch, consequence: "modify_user" });
    expect(asked.status).toBe("needs_consent");
    if (reply) d.replies.push(reply);
    return { asked, done: await ex.act({ action: a, epoch: asked.epoch, consequence: "modify_user", consent: app.forAction(asked.challenge!) }) };
  };
  return { d, ex, app, press };
}

/** The result card's unsure lines for consent steps, and the uncertain list, as texts. */
const both = (ex: Executor) => ({
  card: stepLines(ex.possiblySteps().filter((s) => s.consequence === "modify_user" || s.consequence === "external")).unsure,
  list: ex.uncertainSteps().map((s) => s.text),
});

describe("the uncertain list is the result card's unsure set of consent steps", () => {
  const rows: [string, PerformResult | undefined, boolean][] = [
    ["ok", { status: "ok", window: "w" }, false],
    ["performed:false (user_busy)", { status: "user_busy", performed: false, why: "the user is active" }, false],
    ["unsupported", { status: "unsupported", why: "no route" }, false],
    ["unverified", { status: "unverified", why: "no answer in time" }, true],
    ["error, no performed:false (typing stopped 3/9)", { status: "error", why: "typing stopped after 3 of 9 chars" }, true],
    ["blocked, no performed:false", { status: "blocked", why: "a dialog came up" }, true],
    ["user_busy, no performed:false", { status: "user_busy", why: "the user is active" }, true],
  ];
  for (const [name, reply, listed] of rows) {
    it(name, async () => {
      const { ex, press } = await desk();
      await press("甲", reply);
      const { card, list } = both(ex);
      expect(list).toEqual(card);
      expect(list.length).toBe(listed ? 1 : 0);
    });
  }

  async function fileCrash(changeAfter: boolean, unchangedDisk = false) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "one-rule-"));
    build(root, { "plan.txt": "开头\n" });
    const ws = new Workspace(root), journal = path.join(path.dirname(root), `${path.basename(root)}.jsonl`), app = ConsentSigner.fresh();
    const mk = (crash = false) => new Executor(new SimComputer(root), { task: "t1", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() }, journal, ...(crash ? { crashAfterFirstEffect: true } : {}) });
    const first = mk(true);
    await first.begin(); await first.plan({ steps: [] });
    await expect(first.act({ action: { kind: "file", capability: "fs.append_line", args: { target: "plan.txt", line: "x" } }, epoch: 0, consent: app.forObject("path:plan.txt", "modify_user", "t1") })).rejects.toThrow();
    if (changeAfter) { build(root, { "plan.txt": "全被改了\n" }); ws.invalidate(); }
    if (unchangedDisk) { build(root, { "plan.txt": "开头\n" }); ws.invalidate(); }
    return { mk, journal };
  }

  it("no receipt (a crash), on the restart that finds it", async () => {
    const { mk } = await fileCrash(false);
    const ex = mk(); await ex.begin();
    const { card, list } = both(ex);
    expect(list).toEqual(card);
    expect(list).toHaveLength(1);
  });

  it("restart not_happened: not listed", async () => {
    const { mk } = await fileCrash(false, true);       // the line never reached the file
    const ex = mk(); await ex.begin();
    expect(ex.recovered?.finding).toBe("not_happened");
    expect(both(ex)).toEqual({ card: [], list: [] });
  });

  it("intent, reconcile_pending, recovery receipt unknown: listed after 1, 2 and 3 restarts (the reviewer's probe)", async () => {
    const { mk, journal } = await fileCrash(true);
    const counts: number[] = [];
    for (let i = 0; i < 3; i++) {
      const ex = mk(); await ex.begin();
      const { card, list } = both(ex);
      expect(list).toEqual(card);
      counts.push(ex.uncertainCount);
    }
    expect(counts).toEqual([1, 1, 1]);
    expect(fs.readFileSync(journal, "utf-8")).toContain("reconcile_pending");
  });
});

describe("the card's lines", () => {
  it("send S, change 乙..己, send S again: S is named (outbound and newest), the hidden counted as distinct steps", async () => {
    const { press } = await desk();
    const u = { status: "unverified" as const, why: "no answer in time" };
    expect((await press("发送", u)).done.consequence).toBe("external");
    for (const l of ["乙", "丙", "丁", "戊", "己"]) await press(l, u);
    await press("发送", u);
    const { asked } = await press("甲");
    const lines = asked.challenge!.text.split("\n").filter((l) => l.startsWith("之前「"));
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toMatch(/发送.*（2 次）/);                  // S, both times, in place of its last occurrence
    expect(asked.challenge!.text).toContain("另有 1 条结果不确定的步骤");   // six distinct steps, five shown
  });

  it("an outbound step is shown however many changes came after it", async () => {
    const { press } = await desk();
    const u = { status: "unverified" as const, why: "no answer in time" };
    await press("发送", u);
    for (const l of ["甲", "乙", "丙", "丁", "戊", "己"]) await press(l, u);
    const { asked } = await press("甲");
    const lines = asked.challenge!.text.split("\n").filter((l) => l.startsWith("之前「"));
    expect(lines.some((l) => l.includes("发送"))).toBe(true);
    expect(lines.at(-1)).toContain("己");                              // the newest
    expect(lines).toHaveLength(5);
    expect(asked.challenge!.text).toContain("另有 2 条结果不确定的步骤");
  });
});
