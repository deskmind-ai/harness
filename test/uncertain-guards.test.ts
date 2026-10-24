/** rv10: kill tests for two guards of 09499d0 that no test exercises (mutants Ma and Mf survive the whole suite).
 *  Ma: act()'s screen path with the old order (consent.check before the uncertain gate) — a stored rule is recorded in
 *      rulesUsed though the gate refused the step. Mf: recordOut without the byte bound.
 *  Copy into test/ of a harness worktree; both pass on 09499d0. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { ConsentSigner } from "../src/executor/consent.js";
import { SimComputer } from "../src/executor/sim.js";
import { fileRegistry } from "../src/registry/fs.js";
import { Workspace, build } from "../src/registry/workspace.js";
import { provenanceJudge } from "./helpers/provenance-judge.js";
import { Executor } from "../src/executor/executor.js";
import type { Action, Driver, Element, PerformResult, WindowInfo } from "../src/executor/types.js";

class Compose implements Driver {
  epoch = 1; replies: PerformResult[] = [];
  info: WindowInfo = { id: "w", app: "Mail", title: "Re" };
  elements: Element[];
  constructor(body: string) {
    this.elements = [
      { id: "body", role: "textArea", label: "Message", value: body, actions: ["set_value", "type"] },
      { id: "send", role: "button", label: "Send", actions: ["click"], sends: true },
      { id: "flag", role: "button", label: "Flag", actions: ["click"] },
    ];
  }
  snapshot() { return { epoch: this.epoch, locked: false, front_app: "Mail", windows: [this.info] }; }
  observe() { return { epoch: this.epoch, window: this.info, modal: null, elements: this.elements, text: "" }; }
  perform() { this.epoch += 1; return this.replies.shift() ?? { status: "ok" as const, window: "w" }; }
}

it("Ma: a screen action covered by a stored rule, while a step is uncertain: asks, and the rule is not recorded", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv10-ma-")), journal = path.join(dir, "j.jsonl");
  fs.writeFileSync(journal, JSON.stringify({ t: 1, kind: "intent", action: { kind: "click", window: "w", target: "flag" }, object: "window:w", consequence: "modify_user", text: "点 Flag" }) + "\n");
  const app = ConsentSigner.fresh();
  const ex = new Executor(new Compose("hi"), { task: "t1", publicKey: app.publicKey, journal });
  await ex.begin([], [app.forRule("邮件随便改", "window:*", "modify_user")]);
  await ex.plan({ steps: [] });
  expect(ex.uncertainCount).toBe(1);
  const o = await ex.observe("w");
  const r = await ex.act({ action: { kind: "click", window: "w", target: "flag" } as Action, epoch: o.epoch, consequence: "modify_user" });
  expect(r.status).toBe("needs_consent");
  expect([...ex.consent.rulesUsed]).toEqual([]);
});

it("Mf: what went out is kept to 4096 bytes, cut on a code point, with the true count", async () => {
  const body = "😀".repeat(1500) + "长".repeat(10);              // 6030 bytes, 1510 code points
  const d = new Compose(body), app = ConsentSigner.fresh();
  const ex = new Executor(d, { task: "t1", publicKey: app.publicKey });
  await ex.begin(); await ex.plan({ steps: [] });
  const send = { kind: "click", window: "w", target: "send" } as Action;
  const o = await ex.observe("w");
  const asked = await ex.act({ action: send, epoch: o.epoch });
  d.replies.push({ status: "unverified", why: "x" });
  await ex.act({ action: send, epoch: asked.epoch, consent: app.forAction(asked.challenge!) });
  const intent = (ex as unknown as { jlines: Record<string, unknown>[] }).jlines.find((l) => l.kind === "intent")!;
  const item = (intent.outgoing as { value: string; chars: number }[]).find((x) => x.value.startsWith("😀"))!;
  expect(Buffer.byteLength(item.value)).toBeLessThanOrEqual(4096);
  expect(item.value).toBe("😀".repeat(1024));
  expect(item.chars).toBe(1510);
});


/** A task that read a file (material), with a plan's approved content for www.google.com, and a judge that clears an
 *  open only when its question carries that content. `uncertain()`: a step of the run becomes uncertain. */
async function planned() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv10-prov-"));
  build(root, { "合同.txt": "合同金额 98000 元\n" });
  const sim = new SimComputer(root), app = ConsentSigner.fresh();
  const { judge, prompts } = provenanceJudge((u) => ({ choice: u.includes("搜索「天气」") ? "none" : "has" }));
  const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, judge, raw: "搜一下天气", files: { workspace: new Workspace(root), registry: fileRegistry() } });
  await ex.begin(); await ex.plan({ steps: [] });
  await ex.act({ action: { kind: "file", capability: "fs.read_text", args: { target: "合同.txt" } }, epoch: ex.currentEpoch });
  const site = () => app.forSite("app:Google Chrome", ["www.google.com"], "t1", "modify_user", undefined, { "www.google.com": ["搜索「天气」"] });
  const open = () => ex.act({ action: { kind: "open_window", app: "Google Chrome", url: "https://www.google.com/search?q=weather" }, epoch: ex.currentEpoch });
  const uncertain = async () => {
    const real = sim.perform.bind(sim);
    let n = 1;
    sim.perform = ((a: Action) => (n-- > 0 ? { status: "unverified", why: "no answer" } : real(a))) as typeof sim.perform;
    const r = await ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: ex.currentEpoch, consequence: "modify_user" });
    const asked = r.status === "needs_consent" ? await ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: ex.currentEpoch, consequence: "modify_user", consent: app.forAction(r.challenge!) }) : r;
    expect(asked.status).toBe("unverified");
    expect(ex.uncertainCount).toBe(1);
  };
  return { ex, site, open, uncertain, prompts };
}

it("Mg: while a step is uncertain, acceptPlanSites takes nothing", async () => {
  const { ex, site, uncertain } = await planned();
  await uncertain();
  expect(ex.acceptPlanSites(site())).toEqual([]);
  expect((ex as unknown as { planSites: Map<string, unknown> }).planSites.size).toBe(0);
});

it("Mh: while a step is uncertain, the provenance question carries no plan content, so the open asks", async () => {
  const { ex, site, open, uncertain, prompts } = await planned();
  expect(ex.acceptPlanSites(site())).toEqual(["www.google.com"]);     // accepted before anything was uncertain
  await uncertain();
  const r = await open();
  expect(r.status).toBe("needs_consent");
  expect(prompts.at(-1)).not.toContain("搜索「天气」");
});

it("Mi: an answer cleared on the plan's content before a step became uncertain is not reused after it", async () => {
  const { ex, site, open, uncertain, prompts } = await planned();
  ex.acceptPlanSites(site());
  const url: Action = { kind: "open_window", app: "Google Chrome", url: "https://www.google.com/search?q=weather" };
  // classified (the judge asked and its answer kept) before anything was uncertain, nothing read since
  expect((await ex.classify(url, ex.currentEpoch, "create")).consequence).not.toBe("external");
  expect(prompts).toHaveLength(1);
  await uncertain();                                                   // no new material: the same question's key
  const r = await open();
  expect(r.status).toBe("needs_consent");                              // asked again, without the content: a card
  expect(prompts).toHaveLength(2);
});

class Flagger implements Driver {
  epoch = 1;
  info: WindowInfo = { id: "w", app: "Mail", title: "Re" };
  elements: Element[] = [{ id: "flag", role: "button", label: "Flag", actions: ["click"] }];
  snapshot() { return { epoch: this.epoch, locked: false, front_app: "Mail", windows: [this.info] }; }
  observe() { return { epoch: this.epoch, window: this.info, modal: null, elements: this.elements, text: "" }; }
  perform() { this.epoch += 1; return { status: "ok" as const, window: "w" }; }
}

for (const lang of ["zh", "en"] as const) it(`E1: an earlier build's outgoing (already cut, no chars) is shown as it was written (${lang})`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv10-old-")), journal = path.join(dir, "j.jsonl");
  const oldValue = "长".repeat(80) + "…（共 300 字）";
  fs.writeFileSync(journal, JSON.stringify({ t: 1, kind: "intent", action: { kind: "click", window: "w", target: "send" }, object: "window:w", consequence: "external", text: "点 发送", outgoing: [{ kind: "field", label: "Message", value: oldValue }] }) + "\n");
  const app = ConsentSigner.fresh();
  const ex = new Executor(new Flagger(), { task: "t1", publicKey: app.publicKey, journal, lang });
  await ex.begin(); await ex.plan({ steps: [] });
  const o = await ex.observe("w");
  const r = await ex.act({ action: { kind: "click", window: "w", target: "flag" } as Action, epoch: o.epoch, consequence: "modify_user" });
  expect(r.status).toBe("needs_consent");
  expect(r.challenge!.facts!.uncertain![0]!.outgoing[0]!.value).toBe(oldValue);
  expect(r.challenge!.text).not.toMatch(/共 (?!300)\d+ 字|\d+ characters in all/);
});

/** rv11 e1-shapes: odd journal shapes of `outgoing` (an earlier build's, a hand-edited one) are read, never thrown on. */
const shapes: [string, unknown, (v: string) => void][] = [
  ["chars as a string (treated as none)", [{ kind: "field", label: "M", value: "x".repeat(200), chars: "200" }], (v) => expect(v).toBe("x".repeat(200))],
  ["value a number, no label", [{ value: 12345 }], (v) => expect(v).toBe("12345")],
  ["a long value with no chars", [{ kind: "field", label: "M", value: "长".repeat(1500) }], (v) => expect(v).toBe("长".repeat(200) + "…")],
  ["a null entry", [null], () => undefined],
  ["a string entry", ["hello"], (v) => expect(v).toBe("hello")],
];
for (const [name, outgoing, check] of shapes) it(`E1 shape: ${name}`, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv11-e1-")), journal = path.join(dir, "j.jsonl");
  fs.writeFileSync(journal, JSON.stringify({ t: 1, kind: "intent", action: { kind: "click", window: "w", target: "send" }, object: "window:w", consequence: "external", text: "点 发送", outgoing }) + "\n");
  const app = ConsentSigner.fresh();
  const ex = new Executor(new Flagger(), { task: "t1", publicKey: app.publicKey, journal, lang: "zh" });
  await ex.begin(); await ex.plan({ steps: [] });
  const o = await ex.observe("w");
  const r = await ex.act({ action: { kind: "click", window: "w", target: "flag" } as Action, epoch: o.epoch, consequence: "modify_user" });
  expect(r.status).toBe("needs_consent");
  const out = r.challenge!.facts!.uncertain![0]!.outgoing;
  if (outgoing && (outgoing as unknown[])[0] === null) expect(out).toEqual([]);
  else check(out[0]!.value);
  expect(r.challenge!.text).not.toMatch(/共 \d+ 字/);
});
