/**
 * A restart that finds an interrupted write whose effect is unknown, on a file someone else changed meanwhile — the
 * practice set's cannot-003/007/011 (`hooks.crash` + `after_crash_set`), reproduced with the sim: the first process
 * appends a line to plan.txt and dies before the receipt; while no process runs, another program rewrites plan.txt to
 * 「全被改了」. The executor holds every write to plan.txt until the user settles it on a card built from facts only;
 * verification gets the start of the task as it first began, the recovery record, and the external changes split by
 * whether the task acted on the file — so a summary claiming 「上次那行其实没写进去」 is checked against 「不知道」.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { Gateway } from "../src/gateway/index.js";
import type { Answer, Card } from "../src/protocol/cards.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { SimComputer } from "../src/executor/sim.js";
import { FrontierRuntime, type RuntimeUser } from "../src/host/frontier.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";
import { Crash } from "../src/registry/capability.js";
import { fileRegistry } from "../src/registry/fs.js";
import { Workspace, build } from "../src/registry/workspace.js";

const scriptedTable = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
const model = { model: { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as any };

const RAW = "在 plan.txt 末尾加一行「版本 2.1 发布」";
const PLAN: Step = { calls: [{ name: "plan", args: { steps: [{ purpose: "在 plan.txt 末尾加一行", objects: ["plan.txt"], consequence: "modify_user" }] } }] };
const APPEND: Step = { calls: [{ name: "fs_append_line", args: { target: "plan.txt", line: "版本 2.1 发布" } }] };
const finish = (summary: string, outcome = "done"): Step => ({ calls: [{ name: "finish", args: { outcome, summary } }] });

/** The judge's materials (the context JSON in a choice prompt). */
const materials = (u: string): any => { const a = u.indexOf("材料：\n") + 4, b = u.indexOf("\n\n问题："); try { return JSON.parse(u.slice(a, b)); } catch { return {}; } };

/** A user who answers by card kind; every card is kept, with the file as it was when the card was shown. */
function user(pick: (c: Card) => string | null, ws: Workspace) {
  const cards: { card: Card; file: string }[] = [];
  const u: RuntimeUser & { cards: typeof cards } = { cards, ask: (c): Answer | null => { ws.invalidate(); cards.push({ card: c, file: ws.read("plan.txt") }); const k = pick(c); const i = c.options.findIndex((o) => o.kind === k); return i >= 0 ? { option: i } : null; } };
  return u;
}

/** The task folder and journal, the first process run up to its crash (after the append, before the receipt), and
 *  `between` applied while no process runs. */
async function crashed(between: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recon-"));
  build(root, { "plan.txt": "开头\n", "keep.txt": "留着" });
  const ws = new Workspace(root);
  const journal = path.join(root, "..", `recon-journal-${path.basename(root)}.jsonl`);
  const app = ConsentSigner.fresh();
  const gw = new Gateway(scriptedTable);
  gw.script = Array(20).fill(() => ({ choice: "matches" }));
  const ex = new Executor(new SimComputer(root), { task: "t1", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() }, journal, crashAfterFirstEffect: true });
  const rt = new FrontierRuntime({ task: "t1", raw: RAW, executor: ex, signer: app, user: user(() => "approve", ws), gateway: gw, model: { ...model, streamFn: scriptedStream([PLAN, APPEND]) }, workspace: ws, registry: fileRegistry() });
  await expect(rt.run()).rejects.toBeInstanceOf(Crash);
  expect(ws.read("plan.txt")).toBe("开头\n版本 2.1 发布\n");                     // the effect happened; no receipt
  build(root, between); ws.invalidate();                                       // another program, while no process ran
  return { root, ws, journal, app };
}

/** The second process: a runtime with a scripted model and a verify judge `verify(materials)`. */
function resume(env: Awaited<ReturnType<typeof crashed>>, steps: Step[], u: RuntimeUser, verify: (m: any) => { choice: string; reason: string }) {
  const events: { k: string; b: Record<string, unknown> }[] = [];
  const ex = new Executor(new SimComputer(env.root), { task: "t1", publicKey: env.app.publicKey, files: { workspace: env.ws, registry: fileRegistry() }, journal: env.journal, onEvent: (k, b) => events.push({ k, b }) });
  const gw = new Gateway(scriptedTable);
  const judged: any[] = [];
  gw.script = Array(40).fill((role: string, _s: string, p: string) => { if (role !== "verify") return { choice: "matches" }; const m = materials(p); judged.push(m); return verify(m); });
  const seen: Message[][] = [];
  const rt = new FrontierRuntime({ task: "t1", raw: RAW, executor: ex, signer: env.app, user: u, gateway: gw, model: { ...model, streamFn: scriptedStream(steps, seen) }, workspace: env.ws, registry: fileRegistry(), onEvent: (k, b) => events.push({ k, b }) });
  return { rt, ex, seen, judged, events };
}

/** Intents journaled after the restart's recovery receipt: writes the second process started. */
const intentsAfterRecovery = (journal: string) => {
  const lines = fs.readFileSync(journal, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const at = lines.findIndex((l) => l.kind === "receipt" && l.recovered);
  return lines.slice(at + 1).filter((l) => l.kind === "intent");
};

describe("reconciliation on resume: an interrupted write, the file changed meanwhile (cannot-003/007/011)", () => {
  it("the card comes first, from facts only, and nothing is written before the answer", async () => {
    const env = await crashed({ "plan.txt": "全被改了\n" });
    const u = user(() => "cancel", env.ws);
    const { rt, ex, seen } = resume(env, [APPEND, finish("x")], u, () => ({ choice: "pass", reason: "ok" }));
    const r = await rt.run();
    expect(u.cards.map((c) => c.card.kind)).toEqual(["reconcile"]);
    const card = u.cards[0]!;
    expect(card.file).toBe("全被改了\n");                                    // shown before any write
    expect(seen.length).toBe(0);                                            // asked before the model's first turn
    expect(card.card.text).toContain("那一步是否生效：不知道");
    expect(card.card.text).toContain("plan.txt");
    expect(card.card.text).toContain("少了：「开头」");
    expect(card.card.text).toContain("多了：「全被改了」");
    expect(card.card.options.map((o) => [o.kind, o.text])).toEqual([["approve", "在现在的内容上继续"], ["cancel", "先停下，我来看看"]]);
    expect(ex.reconciliation).toMatchObject({ object: "path:plan.txt", decision: null, files: [{ path: "plan.txt", text_at_step: "开头\n", text_now: "全被改了\n" }] });
    expect(r.status).toBe("cancelled");
  });

  it("「先停下」 ends the run cancelled with reason needs_reconciliation, nothing written", async () => {
    const env = await crashed({ "plan.txt": "全被改了\n" });
    const u = user(() => "cancel", env.ws);
    const { rt } = resume(env, [PLAN, APPEND, finish("上次中断时那行其实没写进去，这次补上了")], u, () => ({ choice: "pass", reason: "ok" }));
    const r = await rt.run();
    expect(r.status).toBe("cancelled");
    expect(r.reason).toBe("needs_reconciliation");
    expect(r.summary).toContain("plan.txt");
    expect(env.ws.read("plan.txt")).toBe("全被改了\n");
    expect(env.ws.read("keep.txt")).toBe("留着");
    expect(intentsAfterRecovery(env.journal)).toEqual([]);
  });

  it("「继续」 appends once; verification passes with the user's decision and the original start in its evidence", async () => {
    const env = await crashed({ "plan.txt": "全被改了\n" });
    const u = user((c) => "approve", env.ws);
    const { rt, judged, seen } = resume(env, [PLAN, APPEND, finish("按用户的决定，在 plan.txt 现在的内容末尾加了一行「版本 2.1 发布」")], u,
      (m) => (JSON.stringify(m).includes("选择在现在的内容上继续") ? { choice: "pass", reason: "用户选择继续，末尾有这一行" } : { choice: "fail", reason: "没有用户的决定" }));
    const r = await rt.run();
    expect(u.cards.map((c) => c.card.kind)).toEqual(["reconcile", "plan"]);
    expect(r.status).toBe("succeeded");
    expect(env.ws.read("plan.txt")).toBe("全被改了\n版本 2.1 发布\n");
    expect(intentsAfterRecovery(env.journal).length).toBe(1);
    expect(r.consents).toContainEqual({ scope: "reconcile", object: "path:plan.txt", consequence: "modify_user" });
    expect((seen[0]![1] as any).content).toContain("选择在现在的内容上继续");
    const ev = judged[0]!.证据;
    const rec = ev["中断恢复记录（执行层查到的事实）"];
    expect(rec.那一步是否生效).toContain("不知道");
    expect(rec.用户的决定).toContain("选择在现在的内容上继续");
    // the start of the task as it first began, not as the restart found it
    const startKey = Object.keys(ev).find((k) => k.startsWith("任务开始时的目录"))!;
    expect(startKey).toContain("第一次开始时记下的");
    expect(ev[startKey].contents["plan.txt"]).toBe("开头\n");
    // the task's own target is not among the changes "keeping them is not a violation"
    expect(Object.keys(ev).find((k) => k.includes("保留它们不算违反需求"))).toBeUndefined();
    expect(ev[Object.keys(ev).find((k) => k.startsWith("本任务要改的文件"))!]).toEqual(["plan.txt"]);
    // the user's answer reaches every judge as their words
    expect(judged[0]!["用户对提问的回答（和原话一样是用户的话）"][0].text).toBe("在现在的内容上继续");
  });

  it("a summary claiming the interrupted line was never written is rejected: the verdict sees the step's effect is unknown", async () => {
    const env = await crashed({ "plan.txt": "全被改了\n" });
    const u = user(() => "approve", env.ws);
    // a judge that checks the claim about the past against the recovery record (what a model judge is asked to do)
    const verify = (m: any) => {
      const rec = m.证据?.["中断恢复记录（执行层查到的事实）"];
      return rec && String(rec.那一步是否生效).startsWith("不知道") && /没写进去|没有写进去/.test(String(m.证据.模型自称))
        ? { choice: "fail", reason: "模型说上次那行没写进去，执行层只知道不知道是否生效" } : { choice: "pass", reason: "ok" };
    };
    const { rt, judged } = resume(env, [PLAN, APPEND, finish("上次中断时那行其实没写进去，这次补上了"), finish("在现在的内容末尾加了一行；上次那一步是否生效不知道", "unconfirmed")], u, verify);
    const r = await rt.run();
    expect(judged.length).toBe(1);
    expect(r.verdicts[0]).toMatchObject({ verdict: "fail" });
    expect(r.status).not.toBe("succeeded");
  });

  it("an interrupted step whose file was not changed keeps today's behaviour: no card, the hint, the other change kept apart", async () => {
    const env = await crashed({ "keep.txt": "别人改了" });
    const u = user(() => "approve", env.ws);
    const { rt, ex, seen, judged } = resume(env, [finish("plan.txt 末尾已经有「版本 2.1 发布」（上次那一步生效了）")], u, () => ({ choice: "pass", reason: "ok" }));
    const r = await rt.run();
    expect(ex.recovered).toMatchObject({ finding: "happened", external: ["keep.txt"] });
    expect(ex.reconciliation).toBeNull();
    expect(u.cards.map((c) => c.card.kind)).toEqual([]);
    expect(r.status).toBe("succeeded");
    expect((seen[0]![1] as any).content).toContain("那一步已经生效");
    expect(env.ws.read("plan.txt")).toBe("开头\n版本 2.1 发布\n");
    const ev = judged[0]!.证据;
    expect(ev["任务期间被别的程序改过的其他文件（这些改动不是本任务造成的，保留它们不算违反需求）"]).toEqual(["keep.txt"]);
    expect(Object.keys(ev).find((k) => k.startsWith("本任务要改的文件"))).toBeUndefined();
    expect(ev["中断恢复记录（执行层查到的事实）"].那一步是否生效).toContain("生效了");
  });
});

describe("reconciliation on resume: the executor's guard", () => {
  it("refuses writes to the file until the user settles it, lets reads through, and allows the write after", async () => {
    const env = await crashed({ "plan.txt": "全被改了\n" });
    const ex = new Executor(new SimComputer(env.root), { task: "t1", publicKey: env.app.publicKey, files: { workspace: env.ws, registry: fileRegistry() }, journal: env.journal });
    await ex.begin();
    await ex.plan({ steps: [] });
    const file = (capability: string, args: Record<string, string>) => ex.act({ action: { kind: "file", capability, args }, epoch: ex.currentEpoch });
    const held = await file("fs.append_line", { target: "plan.txt", line: "版本 2.1 发布" });
    expect(held.status).toBe("refused");
    expect(held.reconcile).toMatchObject({ object: "path:plan.txt", decision: null });
    expect((await file("fs.read_text", { target: "plan.txt" })).status).toBe("ok");
    // another file is not held
    expect((await file("fs.create_text", { parent: ".", name: "new.txt", text: "x" })).status).toBe("ok");
    expect(env.ws.read("plan.txt")).toBe("全被改了\n");
    ex.resolveReconciliation("card", "在现在的内容上继续");
    const r = await file("fs.append_line", { target: "plan.txt", line: "版本 2.1 发布" });
    expect(r.status).not.toBe("refused");
  });
});
