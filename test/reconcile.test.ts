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
import { fsCopy, fsMove } from "../src/registry/fs.js";
import { LineReader, appRun } from "../src/cli/app.js";
import { defaultJudge } from "../src/executor/judge.js";
import type { AppEvent } from "../src/protocol/events.js";
import { PassThrough } from "node:stream";

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
async function crashed(between: Record<string, string>, journalAt?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "recon-"));
  build(root, { "plan.txt": "开头\n", "keep.txt": "留着" });
  const ws = new Workspace(root);
  const journal = journalAt ?? path.join(root, "..", `recon-journal-${path.basename(root)}.jsonl`);
  if (journalAt) fs.mkdirSync(path.dirname(journalAt), { recursive: true });
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
    expect(u.cards.length).toBe(1);
    const card = u.cards[0]!;
    expect(card.card.kind).toBe("action");                                  // an approval card in the app
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
    // the interrupted write is one of the run's uncertain steps (review of harness#66): the append the plan covers
    // still asks, on a card that names it
    expect(u.cards.map((c) => c.card.kind)).toEqual(["action", "plan", "action"]);
    expect(u.cards[0]!.card.text).toContain("那一步是否生效：不知道");
    expect(u.cards[2]!.card.text).toMatch(/^之前「.*」结果不确定，可能已经发出或生效了。/);
    expect(r.status).toBe("succeeded");
    expect(env.ws.read("plan.txt")).toBe("全被改了\n版本 2.1 发布\n");
    expect(intentsAfterRecovery(env.journal).length).toBe(1);
    expect(r.consents).toContainEqual({ scope: "reconcile", object: "path:plan.txt", consequence: "modify_user" });
    expect((seen[0]![1] as any).content).toContain("选择在现在的内容上继续");
    const ev = judged[0]!.证据;
    const rec = ev["中断恢复记录（执行层查到的事实）"];
    expect(rec.那一步是否生效).toContain("不知道");
    expect(rec.用户的决定).toContain("选择在现在的内容上继续");
    // the file as the restart found it, and as it is when the judge reads it (after the user's go-ahead and the append)
    const file = rec["那一步要改的文件：那一步之前、恢复时、核对时"][0];
    expect(file).toMatchObject({ 路径: "plan.txt", 那一步之前的内容: "开头\n", 恢复时的内容: "全被改了\n", 核对时的内容: "全被改了\n版本 2.1 发布\n" });
    // the start of the task as it first began, not as the restart found it
    const startKey = Object.keys(ev).find((k) => k.startsWith("任务开始时的目录"))!;
    expect(startKey).toContain("第一次开始时记下的");
    expect(ev[startKey].contents["plan.txt"]).toBe("开头\n");
    // the task's own target is not among the changes "keeping them is not a violation"
    expect(Object.keys(ev).find((k) => k.includes("保留它们不算违反需求"))).toBeUndefined();
    // ...nor among those "neither the start nor the task's": the task wrote it after the change, with the user's go-ahead
    expect(ev[Object.keys(ev).find((k) => k.startsWith("本任务改过的文件"))!]).toEqual(["plan.txt"]);
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
    expect(u.cards.length).toBe(0);
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

describe("reconciliation on resume: a second restart", () => {
  it("is still pending after the process died with the card open, and after 「先停下」 and a restart with the same journal; settled only by 「继续」", async () => {
    const env = await crashed({ "plan.txt": "全被改了\n" });
    const exec = () => new Executor(new SimComputer(env.root), { task: "t1", publicKey: env.app.publicKey, files: { workspace: env.ws, registry: fileRegistry() }, journal: env.journal });
    // process 2 raises the card and dies before an answer
    const p2 = exec(); await p2.begin();
    expect(p2.reconciliation?.decision).toBeNull();
    // process 3: still pending, the write still held
    const p3 = exec(); await p3.begin(); await p3.plan({ steps: [] });
    expect(p3.reconciliation).toMatchObject({ object: "path:plan.txt", decision: null, files: [{ path: "plan.txt", text_at_step: "开头\n" }] });
    expect(p3.recovered).toMatchObject({ finding: "unknown", writes: ["plan.txt"] });
    expect(p3.externalChanges.map((c) => c.path)).toEqual(["plan.txt"]);
    expect((await p3.act({ action: { kind: "file", capability: "fs.append_line", args: { target: "plan.txt", line: "版本 2.1 发布" } }, epoch: p3.currentEpoch })).status).toBe("refused");
    // process 4 through the runtime: the user stops — still pending
    const stop = user(() => "cancel", env.ws);
    expect((await resume(env, [finish("x")], stop, () => ({ choice: "pass", reason: "ok" })).rt.run()).reason).toBe("needs_reconciliation");
    // process 5: asked again; this time 「继续」, and the append goes through once
    const go = user(() => "approve", env.ws);
    const r5 = await resume(env, [PLAN, APPEND, finish("在现在的内容末尾加了一行")], go, () => ({ choice: "pass", reason: "ok" })).rt.run();
    expect(go.cards[0]!.card.text).toContain("那一步是否生效：不知道");
    expect(r5.status).toBe("succeeded");
    expect(env.ws.read("plan.txt")).toBe("全被改了\n版本 2.1 发布\n");
    expect(intentsAfterRecovery(env.journal).length).toBe(1);
    // process 6: settled — nothing pending
    const p6 = exec(); await p6.begin();
    expect(p6.reconciliation).toBeNull();
    expect(stop.cards.length).toBe(1);
  });
});

describe("the app's answer to the reconciliation card (deskmind HarnessEvents.answerLine, GoalRunView as shipped)", () => {
  /** The shipped app's answer line, line for line from Swift: approve → the approve-kind option whichever button; else the
   *  option whose text is the reply; an empty reply → the cancel-kind option (or 0); else the words. */
  const answerLine = (reply: string, approve: boolean, ask: { ask_id: string; card: { options: { kind: string; text: string }[] } }) => {
    const opts = ask.card.options;
    if (approve) { const i = opts.findIndex((o) => o.kind === "approve"); if (i >= 0) return { ask_id: ask.ask_id, option: i }; }
    const t = reply.trim();
    const j = opts.map((o) => o.text).indexOf(t);
    if (j >= 0) return { ask_id: ask.ask_id, option: j };
    if (!t) return approve ? null : { ask_id: ask.ask_id, option: Math.max(0, opts.findIndex((o) => o.kind === "cancel")) };
    return { ask_id: ask.ask_id, text: t };
  };
  /** HarnessEvents.approvalKinds: these show Approve (send("", true)) / Deny (send("", false)); any other kind shows each
   *  option as a button that sends (option, true). */
  const APPROVAL = new Set(["plan", "action", "result_check"]);
  const click = (ask: any, button: "approve" | "deny") => APPROVAL.has(ask.card.kind)
    ? answerLine("", button === "approve", ask)
    : answerLine(ask.card.options.find((o: any) => o.kind === (button === "approve" ? "approve" : "cancel")).text, true, ask);

  async function viaApp(button: "approve" | "deny") {
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), "recon-app-"));
    const env = await crashed({ "plan.txt": "全被改了\n" }, path.join(runs, "run_recon", "journal.jsonl"));
    const gw = new Gateway(scriptedTable);
    gw.script = Array(40).fill((role: string) => (role === "verify" ? { choice: "pass", reason: "ok" } : { choice: "matches" }));
    const input = new PassThrough();
    const sent: AppEvent[] = [], lines: unknown[] = [];
    let first = true;
    await appRun({ run_id: "run_recon", raw: RAW, scope: env.root, driver: "sim", config: "ds-flash" }, {
      runs, input: new LineReader(input), linger: 0,
      out: (ev) => {
        sent.push(ev);
        if (ev.kind !== "ask") return;
        // the reconciliation card gets the button under test; the cards after it (the plan) are approved
        const line = click(ev, first ? button : "approve"); first = false;
        lines.push(line);
        setTimeout(() => input.write(JSON.stringify(line) + "\n"), 5);
      },
      inject: { gateway: gw, model: { ...model, streamFn: scriptedStream([PLAN, APPEND, finish("在现在的内容末尾加了一行")]) } },
    });
    return { env, sent, lines };
  }

  it("the card is an approval card: Deny sends the cancel option — the run stops needs_reconciliation, nothing written", async () => {
    const { env, sent, lines } = await viaApp("deny");
    const ask = sent.find((e) => e.kind === "ask") as any;
    expect(APPROVAL.has(ask.card.kind)).toBe(true);
    expect(ask.card.text).toContain("不同意：先停下");
    expect(lines[0]).toEqual({ ask_id: ask.ask_id, option: ask.card.options.findIndex((o: any) => o.kind === "cancel") });
    const done = sent.find((e) => e.kind === "task_done") as any;
    expect(done).toMatchObject({ status: "cancelled", reason: "needs_reconciliation" });
    expect(env.ws.read("plan.txt")).toBe("全被改了\n");
  });

  it("Approve sends the approve option — the run goes on from the content as it is now", async () => {
    const { env, sent, lines } = await viaApp("approve");
    const ask = sent.find((e) => e.kind === "ask") as any;
    expect(lines[0]).toEqual({ ask_id: ask.ask_id, option: ask.card.options.findIndex((o: any) => o.kind === "approve") });
    expect((sent.find((e) => e.kind === "task_done") as any).status).toBe("succeeded");
    expect(env.ws.read("plan.txt")).toBe("全被改了\n版本 2.1 发布\n");
  });
});

describe("paths spelled in another case (macOS volumes are case-insensitive)", () => {
  const insensitive = (root: string) => fs.existsSync(path.join(root, "PLAN.TXT"));
  async function setup(extra: Record<string, string> = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "case-"));
    build(root, { "plan.txt": "开头\n", "keep.txt": "留着", ...extra });
    const ws = new Workspace(root), app = ConsentSigner.fresh();
    const ex = new Executor(new SimComputer(root), { task: "t1", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() } });
    await ex.begin(); await ex.plan({ steps: [] });
    // the user approves whatever is asked: only the capability's own checks stand between the action and the file
    const file = async (capability: string, args: Record<string, string>) => { const action = { kind: "file", capability, args } as const; let r = await ex.act({ action, epoch: ex.currentEpoch }); if (r.status === "needs_consent" && r.challenge) r = await ex.act({ action, epoch: ex.currentEpoch, consent: app.forAction(r.challenge) }); return r; };
    return { root, ws, ex, file };
  }

  it("a copy onto PLAN.txt is a write on the user's plan.txt, and is refused because it exists", async () => {
    const { root, ws, ex, file } = await setup();
    expect(ex.structure({ kind: "file", capability: "fs.copy", args: { source: "keep.txt", destination: "PLAN.txt" } })).toMatchObject({ consequence: "modify_user", object: "path:plan.txt" });
    const r = await file("fs.copy", { source: "keep.txt", destination: "PLAN.txt" });
    expect(r.status).not.toBe("ok");
    expect(fs.readFileSync(path.join(root, "plan.txt"), "utf-8")).toBe("开头\n");
    expect(fs.readdirSync(root).sort()).toEqual(["keep.txt", "plan.txt"]);
    // and the capability itself never overwrites, even handed the other spelling directly
    if (insensitive(root)) { expect(() => fsCopy.execute(ws, { source: "keep.txt", destination: "PLAN.txt" })).toThrow(); expect(fs.readFileSync(path.join(root, "plan.txt"), "utf-8")).toBe("开头\n"); }
  });

  it("a rename onto PLAN.txt (or of plan.txt to Plan.txt) is refused; the capability refuses it too", async () => {
    const { root, ws, file } = await setup();
    expect((await file("fs.move", { source: "keep.txt", destination: "PLAN.txt" })).status).not.toBe("ok");
    expect(fs.readFileSync(path.join(root, "plan.txt"), "utf-8")).toBe("开头\n");
    expect(fs.readFileSync(path.join(root, "keep.txt"), "utf-8")).toBe("留着");
    if (insensitive(root)) {
      expect(fsMove.execute(ws, { source: "keep.txt", destination: "PLAN.txt" }).status).toBe("error");
      expect(fs.readFileSync(path.join(root, "plan.txt"), "utf-8")).toBe("开头\n");
    }
  });

  it("a case-only rename of a file (readme.md → README.md) is a change to that file: asked like one, then done", async () => {
    const { root, ex, file } = await setup({ "readme.md": "说明" });
    const a = { kind: "file", capability: "fs.move", args: { source: "readme.md", destination: "README.md" } } as const;
    expect(ex.structure(a)).toMatchObject({ consequence: "modify_user", object: "path:readme.md" });
    expect((await ex.act({ action: a, epoch: ex.currentEpoch })).status).toBe("needs_consent");      // the user's file: asked
    const r = await file("fs.move", { source: "readme.md", destination: "README.md" });
    expect(r.status).toBe("ok");
    expect(fs.readdirSync(root).filter((n) => n.toLowerCase() === "readme.md")).toEqual(["README.md"]);
    expect(fs.readFileSync(path.join(root, "README.md"), "utf-8")).toBe("说明");
  });

  it("the reconciliation guard holds a write spelled in another case", async () => {
    const env = await crashed({ "plan.txt": "全被改了\n" });
    const ex = new Executor(new SimComputer(env.root), { task: "t1", publicKey: env.app.publicKey, files: { workspace: env.ws, registry: fileRegistry() }, journal: env.journal });
    await ex.begin(); await ex.plan({ steps: [] });
    const r = await ex.act({ action: { kind: "file", capability: "fs.copy", args: { source: "keep.txt", destination: "PLAN.txt" } }, epoch: ex.currentEpoch });
    expect(r.status).toBe("refused");
    expect(r.reconcile?.object).toBe("path:plan.txt");
  });
});

describe("verification: another program's change to a file this task wrote", () => {
  it("is told apart by whether the task wrote it again after the change", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ext-"));
    build(root, { "keep.txt": "留着" });
    const ws = new Workspace(root), app = ConsentSigner.fresh(), gw = new Gateway(scriptedTable);
    const judged: any[] = [];
    gw.script = Array(10).fill((_r: string, _s: string, p: string) => { judged.push(materials(p)); return { choice: "pass", reason: "ok" }; });
    const ex = new Executor(new SimComputer(root), { task: "t1", publicKey: app.publicKey, raw: "新建 note.txt", judge: defaultJudge(gw), files: { workspace: ws, registry: fileRegistry() } });
    await ex.begin(); await ex.plan({ steps: [] });
    const file = (capability: string, args: Record<string, string>) => ex.act({ action: { kind: "file", capability, args }, epoch: ex.currentEpoch });
    expect((await file("fs.create_text", { parent: ".", name: "note.txt", text: "1" })).status).toBe("ok");
    fs.writeFileSync(path.join(root, "note.txt"), "别人改的"); ws.invalidate();
    expect((await file("fs.append_line", { target: "note.txt", line: "2" })).status).toBe("stale");      // the change is found
    await ex.verdict("x");
    const keys1 = Object.keys(judged.at(-1).证据);
    expect(keys1.find((k) => k.startsWith("本任务要改的文件"))).toBeTruthy();
    expect((await file("fs.read_text", { target: "note.txt" })).status).toBe("ok");                       // read again
    expect((await file("fs.append_line", { target: "note.txt", line: "2" })).status).toBe("ok");          // and written
    await ex.verdict("y");
    const ev = judged.at(-1).证据;
    expect(Object.keys(ev).find((k) => k.startsWith("本任务要改的文件"))).toBeUndefined();
    expect(ev[Object.keys(ev).find((k) => k.startsWith("本任务改过的文件"))!]).toEqual(["note.txt"]);
    expect(Object.keys(ev).find((k) => k.includes("保留它们不算违反需求"))).toBeUndefined();
  });
});
