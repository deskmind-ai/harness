/**
 * The protections of the execution path, driven by a scripted (adversarial) model against real files in a temp dir.
 * Port of openjev experiments/protocol-demo-2026-10-07/test_guards.py onto the 2.0 slice.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Gateway, type Scripted } from "../src/gateway/index.js";
import { Orchestrator, type User } from "../src/orchestrator/index.js";
import { Crash } from "../src/registry/capability.js";
import { fileRegistry } from "../src/registry/fs.js";
import { Workspace, build } from "../src/registry/workspace.js";

const scriptedTable = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;

const user = (answers: string[] = [], approve = true): User & { asked: string[] } => ({
  asked: [],
  clarify(q) { this.asked.push(q); return answers.shift() ?? "按我原来说的做。"; },
  authorize: () => approve,
});

// Scripted answers for the task 「在 todo.txt 末尾加一行「买牛奶」」
const GOAL = { requirements: [{ id: "r1", statement: "todo.txt 末行是 买牛奶", check: { kind: "deterministic", name: "last_line_is", args: { path: "todo.txt", line: "买牛奶" } }, quotes: ["买牛奶"] }], constraints: [], missing: [], feasible: "yes" };
const PLAN = { nodes: [{ id: "n1", capability: "fs.append_line", depends_on: [], purpose: "追加", requirement_ids: ["r1"] }], outcome: "plan" };
const BIND = { bindings: { target: { kind: "resource_ref", path: "todo.txt" }, line: { kind: "source_span", quote: "买牛奶", occurrence: 1 } }, unresolved: [] };
const MATCH = { verdict: "matches", reason: "ok" };
const byRole = (answers: Record<string, unknown>): Scripted => (role) => answers[role] ?? { outcome: "error", error: `no scripted answer for ${role}` };
const HAPPY = byRole({ goal: GOAL, plan: PLAN, bind: BIND, intent: MATCH });

function setup(files: Record<string, string | null>, script: Scripted[], u = user(), hooks: any = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-guard-"));
  build(root, files);
  const ws = new Workspace(root);
  const gw = new Gateway(scriptedTable);
  gw.script = script;
  const log = path.join(root, ".log.jsonl");
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

  it("「随便」 does not unblock a missing-intent question; the run stops instead of deciding for the user", async () => {
    const ask = byRole({ goal: { requirements: [], constraints: [], missing: [{ what: "哪个文件", question: "要改名的是哪个文件？" }], feasible: "yes" } });
    const guess = byRole({ goal: GOAL, plan: PLAN, bind: BIND, intent: MATCH });
    const u = user(["你看着办吧"]);
    const { o, ws } = setup(TODO, [ask, guess, guess, guess, guess], u);
    const s = await o.run();
    expect(u.asked.length).toBe(1);
    expect(s.status).toBe("waiting_user");
    expect(ws.read("todo.txt")).toBe("交房租\n");
  });

  it("a goal with only 'unchanged' constraints never succeeds without an effect", async () => {
    const triv = byRole({ goal: { ...GOAL, requirements: [{ id: "r1", statement: "不动", check: { kind: "deterministic", name: "unchanged", args: { path: "other.txt" } }, quotes: ["todo.txt"] }] }, plan: { nodes: [], outcome: "plan" } });
    const { o } = setup(TODO, [triv, triv, triv]);
    const s = await o.run();
    expect(s.status).not.toBe("succeeded");
  });
});
