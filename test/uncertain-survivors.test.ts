/** The mutants that survived harness#66 @ 03f9488 (the reviewer's probes, adopted as they were).
 *  M3: the gate takes a card that named only some of the uncertain steps. M14: a file action covered by a stored rule
 *  goes with no card while a step is uncertain (actFile's gate). Both pass on 03f9488 and fail on the mutant. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { SimComputer } from "../src/executor/sim.js";
import { fileRegistry } from "../src/registry/fs.js";
import { Workspace, build } from "../src/registry/workspace.js";
import type { Action, Driver, Element, PerformResult, WindowInfo } from "../src/executor/types.js";

class Desk implements Driver {
  epoch = 1; replies: PerformResult[] = [];
  info: WindowInfo = { id: "w", app: "表单", title: "报销" };
  elements: Element[] = ["甲", "乙", "丙"].map((l, i) => ({ id: `b${i}`, role: "button", label: l, actions: ["click"] }));
  snapshot() { return { epoch: this.epoch, locked: false, front_app: "表单", windows: [this.info] }; }
  observe() { return { epoch: this.epoch, window: this.info, modal: null, elements: this.elements, text: "" }; }
  perform() { this.epoch += 1; return this.replies.shift() ?? { status: "ok" as const, window: "w" }; }
}

it("M3: a card that named step A does not cover an action after step B also became uncertain", async () => {
  const d = new Desk(), app = ConsentSigner.fresh();
  const ex = new Executor(d, { task: "t1", publicKey: app.publicKey });
  await ex.begin(); await ex.plan({ steps: [] });
  const click = (label: string) => ({ kind: "click", window: "w", target: d.elements.find((e) => e.label === label)!.id }) as Action;
  const press = async (label: string, reply: PerformResult) => {
    const o = await ex.observe("w");
    const asked = await ex.act({ action: click(label), epoch: o.epoch, consequence: "modify_user" });
    d.replies.push(reply);
    return ex.act({ action: click(label), epoch: asked.epoch, consequence: "modify_user", consent: app.forAction(asked.challenge!) });
  };
  const u = { status: "unverified" as const, why: "no answer in time" };
  await press("甲", u);                                           // A uncertain
  let o = await ex.observe("w");
  const c1 = await ex.act({ action: click("乙"), epoch: o.epoch, consequence: "modify_user" });   // card naming {A}
  expect(c1.status).toBe("needs_consent");
  const t1 = app.forAction(c1.challenge!);
  await press("丙", u);                                           // B uncertain, after c1 was issued
  expect(ex.uncertainCount).toBe(2);
  o = await ex.observe("w");
  const r = await ex.act({ action: click("乙"), epoch: o.epoch, consequence: "modify_user", consent: t1 });
  expect(r.status).toBe("needs_consent");                         // M3 (some): ok
});

it("M14: a file write covered by a stored rule asks while a step is uncertain", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv9-m14-"));
  build(root, { "plan.txt": "开头\n" });
  const ws = new Workspace(root), journal = path.join(root, "..", `${path.basename(root)}.jsonl`), app = ConsentSigner.fresh();
  const mk = (crash = false) => new Executor(new SimComputer(root), { task: "t1", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() }, journal, ...(crash ? { crashAfterFirstEffect: true } : {}) });
  const first = mk(true);
  await first.begin(); await first.plan({ steps: [] });
  await expect(first.act({ action: { kind: "file", capability: "fs.append_line", args: { target: "plan.txt", line: "x" } }, epoch: 0, consent: app.forObject("path:plan.txt", "modify_user", "t1") })).rejects.toThrow();
  const ex = mk();
  await ex.begin([], [app.forRule("改计划不用问", "path:*", "modify_user")]);
  await ex.plan({ steps: [] });
  expect(ex.uncertainCount).toBe(1);
  const r = await ex.act({ action: { kind: "file", capability: "fs.append_line", args: { target: "plan.txt", line: "y" } }, epoch: ex.currentEpoch });
  expect(r.status).toBe("needs_consent");                         // M14 (no gate in actFile): ok, by the rule
});
