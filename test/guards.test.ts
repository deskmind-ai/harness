/**
 * The protections of the execution path, driven by a scripted (adversarial) model against real files in a temp dir.
 * Port of openjev experiments/protocol-demo-2026-10-07/test_guards.py onto the 2.0 slice.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Gateway, type Scripted } from "../src/gateway/index.js";
import { BATCH_CONFIRM, Orchestrator, type Answer, type User } from "../src/orchestrator/index.js";
import { Crash } from "../src/registry/capability.js";
import { fileRegistry } from "../src/registry/fs.js";
import { Workspace, build } from "../src/registry/workspace.js";

const scriptedTable = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;

const user = (answers: string[] = [], approve = true): User & { asked: string[] } => ({
  asked: [],
  clarify(q): Answer { this.asked.push(q); return { text: answers.shift() ?? "按我原来说的做。" }; },
  authorize: () => approve,
});

// Scripted answers for the task 「在 todo.txt 末尾加一行「买牛奶」」
const GOAL = { requirements: [{ id: "r1", statement: "todo.txt 末行是 买牛奶", check: { kind: "deterministic", name: "last_line_is", args: { path: "todo.txt", line: "买牛奶" } }, quotes: ["买牛奶"] }], constraints: [], missing: [], feasible: "yes" };
const PLAN = { nodes: [{ id: "n1", capability: "fs.append_line", depends_on: [], purpose: "追加", requirement_ids: ["r1"] }], outcome: "plan" };
const BIND = { bindings: { target: { kind: "resource_ref", path: "todo.txt" }, line: { kind: "source_span", quote: "买牛奶", occurrence: 1 } }, unresolved: [] };
const MATCH = { verdict: "matches", reason: "ok" };
const byRole = (answers: Record<string, unknown>): Scripted => (role) => answers[role] ?? { outcome: "error", error: `no scripted answer for ${role}` };
const HAPPY = byRole({ goal: GOAL, plan: PLAN, bind: BIND, intent: MATCH });

function setup(files: Record<string, string | null>, script: Scripted[], u: User = user(), hooks: any = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-guard-"));
  build(root, files);
  const ws = new Workspace(root);
  const gw = new Gateway(scriptedTable);
  gw.script = script;
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-log-")), "log.jsonl");   // outside the workspace, as in eval runs
  const o = new Orchestrator(log, ws, gw, u, fileRegistry(), { hooks });
  o.start("在 todo.txt 末尾加一行「买牛奶」");
  return { o, ws, gw, log, root, u };
}

const TODO = { "todo.txt": "交房租\n", "other.txt": "x" };

describe("execution guards", () => {
  it("the happy path appends once and ends by code verification", async () => {
    const { o, ws } = setup(TODO, Array(6).fill(HAPPY));
    const s = await o.run();
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
    expect(s.counters["calls:intent"]).toBe(1);
  });

  it("an invented check name in the goal is refused", async () => {
    const bad = byRole({ goal: { ...GOAL, requirements: [{ ...GOAL.requirements[0], check: { kind: "deterministic", name: "rm_rf", args: {} } }] } });
    const { o, ws } = setup(TODO, [bad]);
    const s = await o.run();
    expect(s.status).toBe("failed");
    expect(ws.read("todo.txt")).toBe("交房租\n");
  });

  it("a quote the user never said is refused", async () => {
    const bad = byRole({ goal: { ...GOAL, requirements: [{ ...GOAL.requirements[0], quotes: ["买鸡蛋"] }] } });
    const { o } = setup(TODO, [bad]);
    expect((await o.run()).status).toBe("failed");
  });

  it("a binding whose quote is not verbatim is rejected and re-asked, never executed", async () => {
    const wrong = byRole({ goal: GOAL, plan: PLAN, bind: { bindings: { target: { kind: "resource_ref", path: "todo.txt" }, line: { kind: "source_span", quote: "买鸡蛋", occurrence: 1 } }, unresolved: [] }, intent: MATCH });
    const { o, ws } = setup(TODO, [wrong, wrong, wrong, HAPPY, HAPPY, HAPPY]);
    const s = await o.run();
    expect(s.counters["rejected:bind"]).toBeGreaterThanOrEqual(1);
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
  });

  it("an off-schema model answer is invalid and nothing runs", async () => {
    const off = byRole({ goal: GOAL, plan: PLAN, bind: { bindings: { target: { source: "resource_ref", path: "todo.txt" } }, unresolved: [] } });
    const { o, ws } = setup(TODO, [off, off, off]);
    const s = await o.run();
    expect(s.status).toBe("waiting_user");
    expect(ws.read("todo.txt")).toBe("交房租\n");
  });

  it("a refusal is not a choice", async () => {
    const ref: Scripted = (role) => (role === "goal" ? { outcome: "refusal", error: "policy" } : { outcome: "error", error: "x" });
    const { o, ws } = setup(TODO, [ref]);
    const s = await o.run();
    expect(s.status).toBe("waiting_user");
    expect(s.reason).toContain("refusal");
    expect(ws.read("todo.txt")).toBe("交房租\n");
  });

  it("an intent mismatch unbinds and rebinds; the write waits", async () => {
    const mis = byRole({ goal: GOAL, plan: PLAN, bind: BIND, intent: { verdict: "mismatch", reason: "弄反了" } });
    const { o, ws } = setup(TODO, [mis, mis, mis, mis, HAPPY, HAPPY, HAPPY, HAPPY]);
    const s = await o.run();
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt").split("买牛奶").length - 1).toBe(1);
  });

  it("a related change before the write blocks it; the file is re-read and the task still completes", async () => {
    let fired = false;
    const hooks = { before_execute: (o: Orchestrator) => { if (!fired) { fired = true; fs.writeFileSync(o.ws.abs("todo.txt"), "交房租\n取快递\n"); } } };
    const { o, ws } = setup(TODO, Array(8).fill(HAPPY), user(), hooks);
    const s = await o.run();
    expect(s.counters["rejected:resource_changed"]).toBe(1);
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n取快递\n买牛奶\n");
  });

  it("an unrelated change does not block", async () => {
    const hooks = { before_execute: (o: Orchestrator) => fs.writeFileSync(o.ws.abs("new.tmp"), "x") };
    const { o } = setup(TODO, Array(6).fill(HAPPY), user(), hooks);
    const s = await o.run();
    expect(s.counters.rejected ?? 0).toBe(0);
    expect(s.status).toBe("succeeded");
  });

  it("a crash after the effect is reconciled on restart, not repeated", async () => {
    const { o, ws, gw, log } = setup(TODO, Array(6).fill(HAPPY), user(), { crash_on_first_effect: true });
    await expect(o.run()).rejects.toBeInstanceOf(Crash);
    gw.script = Array(6).fill(HAPPY);
    const o2 = new Orchestrator(log, ws, gw, user(), fileRegistry());
    const s = await o2.run();
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
    expect(Object.values(s.ops)).toEqual(["ok"]);
  });

  it("the crash hook fires at the first write even when the plan reads first", async () => {
    const READ_PLAN = { nodes: [{ id: "n0", capability: "fs.read_text", depends_on: [], purpose: "先读", requirement_ids: ["r1"] }, { ...PLAN.nodes[0], depends_on: ["n0"] }], outcome: "plan" };
    const g: Scripted = (role) => role === "goal" ? GOAL : role === "plan" ? READ_PLAN : role === "bind" ? (BIND_N++ === 0 ? { bindings: { target: { kind: "resource_ref", path: "todo.txt" } }, unresolved: [] } : BIND) : role === "intent" ? MATCH : { outcome: "error", error: "none" };
    let BIND_N = 0;
    const { o } = setup(TODO, Array(10).fill(g), user(), { crash_on_first_effect: true });
    await expect(o.run()).rejects.toBeInstanceOf(Crash);
  });

  it("an unknown effect blocks every later write", async () => {
    const { o, ws, gw, log } = setup(TODO, Array(6).fill(HAPPY), user(), { crash_on_first_effect: true });
    await expect(o.run()).rejects.toBeInstanceOf(Crash);
    fs.writeFileSync(ws.abs("todo.txt"), "全被改了\n");
    gw.script = Array(6).fill(HAPPY);
    const before = gw.calls;
    const o2 = new Orchestrator(log, ws, gw, user(), fileRegistry());
    const s = await o2.run();
    expect(s.status).toBe("needs_reconciliation");
    expect(ws.read("todo.txt")).toBe("全被改了\n");
    expect(gw.calls - before).toBe(0);           // nothing is asked while an effect is unverified
  });

  it("a goal update makes the pending decision stale and the new goal is done instead", async () => {
    let fired = false;
    const hooks = { before_execute: (o: Orchestrator) => { if (!fired) { fired = true; o.updateGoal("在 todo.txt 末尾加一行「买鸡蛋」", "changed"); } } };
    const GOAL2 = { ...GOAL, requirements: [{ ...GOAL.requirements[0], check: { kind: "deterministic", name: "last_line_is", args: { path: "todo.txt", line: "买鸡蛋" } }, quotes: ["买鸡蛋"] }] };
    const BIND2 = { ...BIND, bindings: { ...BIND.bindings, line: { kind: "source_span", quote: "买鸡蛋", occurrence: 1 } } };
    const after = byRole({ goal: GOAL2, plan: PLAN, bind: BIND2, intent: MATCH });
    const { o, ws } = setup(TODO, [HAPPY, HAPPY, HAPPY, HAPPY, after, after, after, after], user(), hooks);
    const s = await o.run();
    expect(s.counters["rejected:stale"]).toBe(1);
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买鸡蛋\n");
  });

  it("a consequential action needs the user's approval and a decline is final", async () => {
    const GOALT = { requirements: [{ id: "r1", statement: "temp 没了", check: { kind: "deterministic", name: "file_absent", args: { path: "todo.txt" } }, quotes: ["todo.txt"] }], constraints: [], missing: [], feasible: "yes" };
    const PLANT = { nodes: [{ id: "n1", capability: "fs.trash", depends_on: [], purpose: "删", requirement_ids: ["r1"] }], outcome: "plan" };
    const BINDT = { bindings: { target: { kind: "resource_ref", path: "todo.txt" } }, unresolved: [] };
    const trash = byRole({ goal: GOALT, plan: PLANT, bind: BINDT, intent: MATCH });
    const u = user([], false);
    const { o, ws } = setup(TODO, Array(6).fill(trash), u);
    const s = await o.run();
    expect(s.counters["ask:authorize"]).toBe(1);
    expect(s.status).not.toBe("succeeded");
    expect(ws.exists("todo.txt")).toBe(true);
  });

  it("missing user intent becomes a question, not a guess", async () => {
    const ask = byRole({ goal: GOAL, plan: PLAN, bind: { bindings: { target: { kind: "resource_ref", path: "todo.txt" } }, unresolved: [{ parameter: "line", reason: "missing_user_intent", question: "加哪一行？" }] } });
    const u = user(["买牛奶"]);
    const { o, ws } = setup(TODO, [ask, ask, ask, HAPPY, HAPPY, HAPPY, HAPPY], u);
    const s = await o.run();
    expect(u.asked).toEqual(["加哪一行？"]);
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
  });

  it("a derived value's source file changing before execution blocks the stale value (B0 test, g3-*-change)", async () => {
    // 「把 src.txt 的内容追加为 todo.txt 的最后一行」: the model derives the line from src.txt's preview; someone edits src.txt
    const GOALD = { requirements: [{ id: "r1", statement: "todo.txt 末行等于 src.txt 的内容", check: { kind: "deterministic", name: "last_line_is_content_of", args: { path: "todo.txt", source: "src.txt" } }, quotes: ["src.txt"] }], constraints: [], missing: [], feasible: "yes" };
    const bindFrom = (v: string) => ({ bindings: { target: { kind: "resource_ref", path: "todo.txt" }, line: { kind: "derived", value: v, from_paths: ["src.txt"], how: "src.txt 的内容" } }, unresolved: [] });
    const stale = byRole({ goal: GOALD, plan: PLAN, bind: bindFrom("买牛奶"), intent: MATCH });
    const fresh = byRole({ goal: GOALD, plan: PLAN, bind: bindFrom("买牛奶（更新）"), intent: MATCH });
    let fired = false;
    const hooks = { before_execute: (o: Orchestrator) => { if (!fired) { fired = true; fs.writeFileSync(o.ws.abs("src.txt"), "买牛奶（更新）"); } } };
    const { o, ws } = setup({ ...TODO, "src.txt": "买牛奶" }, [stale, stale, stale, stale, fresh, fresh, fresh, fresh], user(), hooks);
    const s = await o.run();
    expect(s.counters["rejected:resource_changed"]).toBe(1);
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶（更新）\n");
  });

  it("rewriting a file this run did not create needs the user's approval (「新建」 on an existing file)", async () => {
    const GOALR = { requirements: [{ id: "r1", statement: "report.txt 内容是 X", check: { kind: "deterministic", name: "text_equals", args: { path: "report.txt", text: "X" } }, quotes: ["X"] }], constraints: [], missing: [], feasible: "yes" };
    const PLANR = { nodes: [{ id: "n1", capability: "fs.replace_text", depends_on: [], purpose: "覆盖", requirement_ids: ["r1"] }], outcome: "plan" };
    const BINDR = { bindings: { target: { kind: "resource_ref", path: "report.txt" }, text: { kind: "source_span", quote: "X", occurrence: 1 } }, unresolved: [] };
    const over = byRole({ goal: GOALR, plan: PLANR, bind: BINDR, intent: MATCH });
    const u = user([], false);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-guard-"));
    build(root, { "report.txt": "已有内容" });
    const ws = new Workspace(root);
    const gw = new Gateway(scriptedTable); gw.script = Array(8).fill(over);
    const o = new Orchestrator(path.join(root, ".log.jsonl"), ws, gw, u, fileRegistry());
    o.start("新建 report.txt，内容为「X」");
    const s = await o.run();
    expect(s.counters["ask:authorize"]).toBe(1);
    expect(ws.read("report.txt")).toBe("已有内容");
    expect(s.status).not.toBe("succeeded");
  });

  it("rewriting a file the user named for rewriting needs no extra approval (the request is the authorization)", async () => {
    const GOALW = { requirements: [{ id: "r1", statement: "日志.log 内容是 X", check: { kind: "deterministic", name: "text_equals", args: { path: "日志.log", text: "X" } }, quotes: ["X"] }], constraints: [], authorized_rewrites: ["日志.log"], missing: [], feasible: "yes" };
    const PLANW = { nodes: [{ id: "n1", capability: "fs.replace_text", depends_on: [], purpose: "改写", requirement_ids: ["r1"] }], outcome: "plan" };
    const BINDW = { bindings: { target: { kind: "resource_ref", path: "日志.log" }, text: { kind: "source_span", quote: "X", occurrence: 1 } }, unresolved: [] };
    const w = byRole({ goal: GOALW, plan: PLANW, bind: BINDW, intent: MATCH });
    const u = user([], false);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-guard-"));
    build(root, { "日志.log": "旧内容" });
    const ws = new Workspace(root);
    const gw = new Gateway(scriptedTable); gw.script = Array(6).fill(w);
    const o = new Orchestrator(path.join(root, ".log.jsonl"), ws, gw, u, fileRegistry());
    o.start("把 日志.log 的内容改成「X」");
    const s = await o.run();
    expect(s.counters["ask:authorize"] ?? 0).toBe(0);
    expect(s.status).toBe("succeeded");
    expect(ws.read("日志.log")).toBe("X");
  });

  // --- when to ask (docs/ask-policy.md) ---------------------------------------------------------------------------
  const AMB = { point: "末尾", reading: "最后一行之后另起一行", alternatives: ["接在最后一行的文字后面"] };

  it("ambiguity nothing observed can settle is asked before planning, with the readings as options", async () => {
    const asked: { q: string; options: string[] }[] = [];
    const u: User = { clarify(q, options) { asked.push({ q, options }); return { option: 0 }; }, authorize: () => true };
    const open = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: ["在 todo.txt 末尾加一行"] }] } });  // the request itself is not evidence
    const carries = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: [] }] }, plan: PLAN, bind: BIND, intent: MATCH });   // the new goal carries the picked reading
    const { o, ws } = setup(TODO, [open, carries, carries, carries, carries, carries], u);
    const s = await o.run();
    expect(asked.length).toBe(1);
    expect(asked[0]!.options).toEqual([AMB.reading, ...AMB.alternatives, Orchestrator.DELEGATE]);
    expect(s.counters["calls:plan"]).toBe(1);             // the plan came after the answer, not before
    expect(s.answers).toEqual([AMB.reading]);
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
  });

  it("a reading backed by what is in the directory, with only reversible steps, is acted on and reported", async () => {
    const backed = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: ["交房租"] }] }, choice: { choice: "r0" }, plan: PLAN, bind: BIND, intent: MATCH });
    const u = user([], false);
    const { o, ws } = setup(TODO, Array(6).fill(backed), u);
    const s = await o.run();
    expect(u.asked.length).toBe(0);
    expect(s.counters["ask:authorize"] ?? 0).toBe(0);
    expect(s.status).toBe("succeeded");
    expect(s.assumptions).toEqual([AMB.reading]);
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
  });

  const GOALW = { requirements: [{ id: "r1", statement: "日志.log 内容是 X", check: { kind: "deterministic", name: "text_equals", args: { path: "日志.log", text: "X" } }, quotes: ["X"] }], constraints: [], authorized_rewrites: ["日志.log"], missing: [], feasible: "yes" };
  const PLANW = { nodes: [{ id: "n1", capability: "fs.replace_text", depends_on: [], purpose: "改写", requirement_ids: ["r1"] }], outcome: "plan" };
  const BINDW = { bindings: { target: { kind: "resource_ref", path: "日志.log" }, text: { kind: "source_span", quote: "X", occurrence: 1 } }, unresolved: [] };
  function rewrite(script: Scripted[], u: User) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-guard-"));
    build(root, { "日志.log": "旧内容" });
    const ws = new Workspace(root);
    const gw = new Gateway(scriptedTable); gw.script = script;
    const o = new Orchestrator(path.join(root, ".log.jsonl"), ws, gw, u, fileRegistry());
    o.start("把 日志.log 的内容改成「X」");
    return { o, ws };
  }

  it("a backed reading with a step that cannot be undone shows the plan once; declined, nothing changes", async () => {
    const w = byRole({ goal: { ...GOALW, assumptions: [{ point: "内容", reading: "整个文件只剩 X", alternatives: ["把旧内容里的某处换成 X"], evidence: ["旧内容"] }] }, choice: { choice: "r0" }, plan: PLANW, bind: BINDW, intent: MATCH });
    const texts: string[] = [];
    const { o, ws } = rewrite(Array(6).fill(w), { clarify: () => null, authorize: (t) => { texts.push(t); return false; } });
    const s = await o.run();
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("整个文件只剩 X");
    expect(texts[0]).toContain("日志.log");                // the concrete file and text, not only the purpose
    expect(s.counters.actions ?? 0).toBe(0);
    expect(s.status).toBe("waiting_user");
    expect(ws.read("日志.log")).toBe("旧内容");
  });

  it("the same plan, approved once, runs without further questions", async () => {
    const w = byRole({ goal: { ...GOALW, assumptions: [{ point: "内容", reading: "整个文件只剩 X", alternatives: ["把旧内容里的某处换成 X"], evidence: ["旧内容"] }] }, choice: { choice: "r0" }, plan: PLANW, bind: BINDW, intent: MATCH });
    const texts: string[] = [];
    const { o, ws } = rewrite(Array(6).fill(w), { clarify: () => null, authorize: (t) => { texts.push(t); return true; } });
    const s = await o.run();
    expect(texts.length).toBe(1);
    expect(s.status).toBe("succeeded");
    expect(ws.read("日志.log")).toBe("X");
  });

  it("「随便」 delegates the choice: the whole plan is confirmed once, not every step", async () => {
    const ask = byRole({ goal: { requirements: [], constraints: [], missing: [{ what: "加什么", question: "要加哪一行？", kind: "information" }], feasible: "yes" } });
    const PLAN2 = { nodes: [{ id: "n1", capability: "fs.append_line", depends_on: [], purpose: "追加第一行", requirement_ids: ["r1"] }, { id: "n2", capability: "fs.create_text", depends_on: ["n1"], purpose: "记一笔", requirement_ids: ["r1"] }], outcome: "plan" };
    const bindFor = (n: number) => n === 0 ? BIND : { bindings: { path: { kind: "literal", value: "记录.txt" }, text: { kind: "source_span", quote: "买牛奶", occurrence: 1 } }, unresolved: [] };
    let binds = 0;
    const guess: Scripted = (role) => role === "goal" ? { ...GOAL, user_delegated: true } : role === "plan" ? PLAN2 : role === "bind" ? bindFor(binds++) : role === "intent" ? MATCH : { outcome: "error", error: "none" };
    const texts: string[] = [];
    const u: User & { asked: string[] } = { asked: [], clarify(q) { this.asked.push(q); return { option: 0 }; }, authorize: (t) => { texts.push(t); return true; } };
    const { o, ws } = setup(TODO, [ask, ...Array(10).fill(guess)], u);
    const s = await o.run();
    expect(u.asked.length).toBe(1);
    expect(texts.length).toBe(1);
    expect(texts[0]).toContain("todo.txt");               // bound step: the concrete action
    expect(texts[0]).toContain("记一笔");                 // step bound later: its purpose
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
  });

  it("「随便」 then declining the proposed plan stops and waits; nothing changes", async () => {
    const ask = byRole({ goal: { requirements: [], constraints: [], missing: [{ what: "哪个文件", question: "要改的是哪个文件？", kind: "information" }], feasible: "yes" } });
    const guess = byRole({ goal: { ...GOAL, user_delegated: true }, plan: PLAN, bind: BIND, intent: MATCH });
    const u = user(["你看着办吧"], false);
    const { o, ws } = setup(TODO, [ask, guess, guess, guess, guess, guess, guess], u);
    const s = await o.run();
    expect(u.asked.length).toBe(1);
    expect(s.counters["ask:authorize"]).toBe(1);
    expect(s.status).toBe("waiting_user");
    expect(ws.read("todo.txt")).toBe("交房租\n");
  });

  it("proposed ways to handle a situation are shown as written; invented values are dropped", async () => {
    const shown: string[][] = [];
    const u: User = { clarify(_q, options) { shown.push(options); return null; }, authorize: () => true };
    const props = byRole({ goal: { requirements: [], constraints: [], missing: [{ what: "重名", question: "两份重名，怎么办？", kind: "information", options: ["只留一份", "第二份加后缀"], options_are: "proposals" }], feasible: "yes" } });
    const vals = byRole({ goal: { requirements: [], constraints: [], missing: [{ what: "哪个文件", question: "哪个文件？", kind: "information", options: ["todo.txt", "不存在.txt"] }], feasible: "yes" } });
    await setup(TODO, [props], u).o.run();
    await setup(TODO, [vals], u).o.run();
    expect(shown[0]).toEqual(["只留一份", "第二份加后缀", Orchestrator.DELEGATE]);
    expect(shown[1]).toEqual(["todo.txt", Orchestrator.DELEGATE]);
  });

  it("the user's pick binds the reading: a goal that keeps the model's own reading is rejected and re-derived", async () => {
    const u: User = { clarify: () => ({ option: 1 }), authorize: () => true };
    const open = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: [] }] } });
    const stubborn = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: ["交房租"] }] } });          // still reading 0
    const follows = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, reading: AMB.alternatives[0], alternatives: [AMB.reading], evidence: [] }] }, plan: PLAN, bind: BIND, intent: MATCH });
    const { o, ws } = setup(TODO, [open, stubborn, follows, follows, follows, follows, follows], u);
    const s = await o.run();
    expect(s.counters.goal_retry).toBe(1);
    expect(s.assumptions).toEqual([AMB.alternatives[0]]);
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
  });

  it("a goal that drops the ambiguity the user settled is rejected like one that ignores it", async () => {
    const u: User = { clarify: () => ({ option: 1 }), authorize: () => true };
    const open = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: [] }] } });
    const silent = byRole({ goal: { ...GOAL, assumptions: [] }, plan: PLAN, bind: BIND, intent: MATCH });
    const { o, ws } = setup(TODO, [open, silent, silent, silent], u);
    const s = await o.run();
    expect(s.status).toBe("failed");
    expect(ws.read("todo.txt")).toBe("交房租\n");
  });

  it("a free-text answer the judge reads as another reading settles that reading", async () => {
    const u: User = { clarify: () => ({ text: "接在文字后面就行" }), authorize: () => true };
    const open = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: [] }] }, choice: { choice: "r1" } });
    const follows = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, reading: AMB.alternatives[0], alternatives: [AMB.reading], evidence: [] }] }, plan: PLAN, bind: BIND, intent: MATCH });
    const { o } = setup(TODO, [open, open, open, follows, follows, follows, follows, follows], u);   // goal, goal, judge, goal…
    const s = await o.run();
    expect(s.counters.goal_retry).toBe(1);
    expect(s.assumptions).toEqual([AMB.alternatives[0]]);
    expect(s.status).toBe("succeeded");
  });

  it("a goal that keeps ignoring the user's pick fails without writing", async () => {
    const u: User = { clarify: () => ({ option: 1 }), authorize: () => true };
    const open = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: [] }] } });
    const stubborn = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: [] }] }, plan: PLAN, bind: BIND, intent: MATCH });
    const { o, ws } = setup(TODO, [open, stubborn, stubborn, stubborn], u);
    const s = await o.run();
    expect(s.status).toBe("failed");
    expect(ws.read("todo.txt")).toBe("交房租\n");
  });

  it("after the user picked a reading, the same ambiguity is not asked again even if the model cites nothing", async () => {
    const asked: string[] = [];
    const u: User = { clarify(q) { asked.push(q); return { option: 0 }; }, authorize: () => true };
    const open = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: [] }] }, plan: PLAN, bind: BIND, intent: MATCH });
    const { o, ws } = setup(TODO, Array(8).fill(open), u);
    const s = await o.run();
    expect(asked.length).toBe(1);
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
  });

  it("a free-text answer that picks no reading settles nothing: no write, no second identical question", async () => {
    const asked: string[] = [];
    const u: User = { clarify(q) { asked.push(q); return { text: "按我原来说的做。" }; }, authorize: () => true };
    const g = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: [] }] }, choice: { choice: "r2" }, plan: PLAN, bind: BIND, intent: MATCH });
    const { o, ws } = setup(TODO, Array(8).fill(g), u);
    const s = await o.run();
    expect(asked.length).toBe(1);
    expect(s.status).toBe("waiting_user");
    expect(ws.read("todo.txt")).toBe("交房租\n");
  });

  it("a free-text answer the judge reads as picking the reading settles it", async () => {
    const u: User = { clarify: () => ({ text: "另起一行" }), authorize: () => false };
    const g = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: [] }] }, choice: { choice: "r0" }, plan: PLAN, bind: BIND, intent: MATCH });
    const { o, ws } = setup(TODO, Array(8).fill(g), u);
    const s = await o.run();
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
  });

  it("words of the request, or fragments of a file, are not evidence", async () => {
    const asked: string[] = [];
    const u: User = { clarify(q) { asked.push(q); return null; }, authorize: () => true };
    for (const ev of ["todo", "todo.txt", "房租"]) {
      const g = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: [ev] }] }, choice: { choice: "r0" } });
      await setup(TODO, [g, g], u).o.run();
    }
    expect(asked.length).toBe(3);
  });

  it("evidence the independent judge cannot tell apart is treated as no evidence: the user is asked", async () => {
    const asked: string[] = [];
    const u: User = { clarify(q) { asked.push(q); return null; }, authorize: () => true };
    const g = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: ["交房租"] }] }, choice: { choice: "r2" } });  // 说不清
    const s = await setup(TODO, [g, g], u).o.run();
    expect(asked.length).toBe(1);
    expect(s.status).toBe("waiting_user");
  });

  it("a large batch on an unconfirmed reading is shown first, even when every step can be undone", async () => {
    const nodes = Array.from({ length: BATCH_CONFIRM + 1 }, (_, i) => ({ id: `n${i}`, capability: "fs.append_line", depends_on: i ? [`n${i - 1}`] : [], purpose: `追加 ${i}`, requirement_ids: ["r1"] }));
    const g = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: ["交房租"] }] }, choice: { choice: "r0" }, plan: { nodes, outcome: "plan" }, bind: BIND, intent: MATCH });
    const texts: string[] = [];
    const { o } = setup(TODO, Array(40).fill(g), { clarify: () => null, authorize: (t) => { texts.push(t); return false; } });
    const s = await o.run();
    expect(texts.length).toBe(1);
    expect(s.counters.actions ?? 0).toBe(0);
  });

  it("an approved plan survives a crash: no second question after restart", async () => {
    const w = byRole({ goal: { ...GOALW, assumptions: [{ point: "内容", reading: "整个文件只剩 X", alternatives: ["把旧内容里的某处换成 X"], evidence: ["旧内容"] }] }, choice: { choice: "r0" }, plan: PLANW, bind: BINDW, intent: MATCH });
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-guard-"));
    build(root, { "日志.log": "旧内容" });
    const ws = new Workspace(root);
    const gw = new Gateway(scriptedTable); gw.script = Array(8).fill(w);
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-log-")), "log.jsonl");
    let asks = 0;
    const u: User = { clarify: () => null, authorize: () => { asks++; return true; } };
    const o = new Orchestrator(log, ws, gw, u, fileRegistry(), { hooks: { crash_on_first_effect: true } });
    o.start("把 日志.log 的内容改成「X」");
    await expect(o.run()).rejects.toBeInstanceOf(Crash);
    gw.script = Array(8).fill(w);
    const s = await new Orchestrator(log, ws, gw, u, fileRegistry()).run();
    expect(asks).toBe(1);
    expect(s.status).toBe("succeeded");
    expect(ws.read("日志.log")).toBe("X");
  });

  it("something the system can read for itself is not asked", async () => {
    const look = byRole({ goal: { ...GOAL, missing: [{ what: "todo.txt 现在最后一行是什么", question: "todo.txt 最后一行是什么？", kind: "observable" }] }, plan: PLAN, bind: BIND, intent: MATCH });
    const u = user();
    const { o, ws } = setup(TODO, Array(6).fill(look), u);
    const s = await o.run();
    expect(u.asked.length).toBe(0);
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
  });

  it("an answer survives a restart: goal and plan are re-derived from the log", async () => {
    const needUser = byRole({ plan: { nodes: [], outcome: "need_user", question: "加在哪个文件？" } });
    let replies = 0;
    const hooks = { after_reply: () => { if (++replies === 3) throw new Crash("after the answer"); } };
    const { o, ws, gw, log } = setup(TODO, [byRole({ goal: GOAL }), needUser, HAPPY], user(["todo.txt"]), hooks);
    await expect(o.run()).rejects.toBeInstanceOf(Crash);
    gw.script = Array(6).fill(HAPPY);
    const o2 = new Orchestrator(log, ws, gw, user(), fileRegistry());
    const s = await o2.run();
    expect(s.counters["calls:goal"]).toBe(1);            // the old goal was dropped by the answer, also on replay
    expect(s.answers).toEqual(["todo.txt"]);
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
  });

  it("an approval-kind missing item is not asked as a question", async () => {
    const want = byRole({ goal: { ...GOAL, missing: [{ what: "确认追加", question: "可以追加吗？", kind: "approval" }] }, plan: PLAN, bind: BIND, intent: MATCH });
    const u = user();
    const { o, ws } = setup(TODO, Array(6).fill(want), u);
    const s = await o.run();
    expect(u.asked.length).toBe(0);
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
  });

  it("a goal with only 'unchanged' constraints never succeeds without an effect", async () => {
    const triv = byRole({ goal: { ...GOAL, requirements: [{ id: "r1", statement: "不动", check: { kind: "deterministic", name: "unchanged", args: { path: "other.txt" } }, quotes: ["todo.txt"] }] }, plan: { nodes: [], outcome: "plan" } });
    const { o } = setup(TODO, [triv, triv, triv]);
    const s = await o.run();
    expect(s.status).not.toBe("succeeded");
  });
});
