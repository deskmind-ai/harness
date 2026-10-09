/** Interaction cards (openjev docs/design/interaction-cards-2026-10-09.md): every interaction offers options with a
 *  fixed meaning; the runtime acts on the meaning only. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Gateway, type Scripted } from "../src/gateway/index.js";
import { Orchestrator, type Answer, type Card, type CardUser, type OptionKind } from "../src/orchestrator/index.js";
import { Crash } from "../src/registry/capability.js";
import { fileRegistry } from "../src/registry/fs.js";
import { Workspace, build } from "../src/registry/workspace.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
const byRole = (a: Record<string, unknown>): Scripted => (role) => a[role] ?? { outcome: "error", error: `no scripted answer for ${role}` };

/** A user who picks by meaning: the first option of the wanted kind, or writes text. */
function picker(...picks: (OptionKind | { text: string } | ((c: Card) => Answer | null))[]): CardUser & { cards: Card[] } {
  return {
    cards: [],
    ask(card) {
      this.cards.push(card);
      const p = picks.shift();
      if (p === undefined) return null;
      if (typeof p === "function") return p(card);
      if (typeof p === "object") return p;
      const i = card.options.findIndex((o) => o.kind === p);
      return i >= 0 ? { option: i } : null;
    },
  };
}

function setup(files: Record<string, string | null>, script: Scripted[], u: CardUser, raw: string, hooks: any = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-cards-"));
  build(root, files);
  const ws = new Workspace(root);
  const gw = new Gateway(table); gw.script = script;
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-cards-log-")), "log.jsonl");
  const o = new Orchestrator(log, ws, gw, u, fileRegistry(), { hooks });
  o.start(raw);
  return { o, ws, gw, log };
}

// 「把 清单.txt 复制一份叫 notes.txt」 when notes.txt already exists
const CONFLICT = { "清单.txt": "买牛奶", "notes.txt": "已有内容" };
const ASK_CONFLICT = byRole({ goal: { requirements: [], constraints: [], missing: [{ what: "重名", question: "notes.txt 已经存在，怎么处理？", kind: "information", options: ["覆盖", "换个名字"], options_are: "proposals" }], feasible: "yes" } });

// 「在 todo.txt 末尾加一行「买牛奶」」
const TODO = { "todo.txt": "交房租\n", "other.txt": "x" };
const GOAL = { requirements: [{ id: "r1", statement: "todo.txt 末行是 买牛奶", check: { kind: "deterministic", name: "last_line_is", args: { path: "todo.txt", line: "买牛奶" } }, quotes: ["买牛奶"] }], constraints: [], missing: [], feasible: "yes" };
const PLAN = { nodes: [{ id: "n1", capability: "fs.append_line", depends_on: [], purpose: "追加", requirement_ids: ["r1"] }], outcome: "plan" };
const BIND = { bindings: { target: { kind: "resource_ref", path: "todo.txt" }, line: { kind: "source_span", quote: "买牛奶", occurrence: 1 } }, unresolved: [] };
const MATCH = { verdict: "matches", reason: "ok" };
const AMB = { point: "末尾", reading: "最后一行之后另起一行", alternatives: ["接在最后一行的文字后面"] };

// 「把 日志.log 的内容改成「X」」 — a step without undo
const LOG = { "日志.log": "旧内容" };
const GOALW = { requirements: [{ id: "r1", statement: "日志.log 内容是 X", check: { kind: "deterministic", name: "text_equals", args: { path: "日志.log", text: "X" } }, quotes: ["X"] }], constraints: [], authorized_rewrites: ["日志.log"], missing: [], feasible: "yes" };
const AMBW = { point: "内容", reading: "整个文件只剩 X", alternatives: ["在文件末尾加一行 X"], evidence: ["旧内容"] };
const PLANW = { nodes: [{ id: "n1", capability: "fs.replace_text", depends_on: [], purpose: "改写", requirement_ids: ["r1"] }], outcome: "plan" };
const BINDW = { bindings: { target: { kind: "resource_ref", path: "日志.log" }, text: { kind: "source_span", quote: "X", occurrence: 1 } }, unresolved: [] };

describe("interaction cards", () => {
  it("a question offers the candidates, 「由你决定」 and 「先别做了」; picking stop cancels the run and writes nothing", async () => {
    const u = picker("cancel");
    const { o, ws } = setup(CONFLICT, [ASK_CONFLICT], u, "把 清单.txt 复制一份叫 notes.txt");
    const s = await o.run();
    expect(u.cards[0]!.options.map((x) => x.kind)).toEqual(["proposal", "proposal", "delegate", "cancel"]);
    expect(s.status).toBe("cancelled");
    expect(ws.read("notes.txt")).toBe("已有内容");
  });

  it("an open ambiguity is a card of readings", async () => {
    const u = picker("reading");
    const open = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: [] }] } });
    const carries = byRole({ goal: { ...GOAL, assumptions: [{ ...AMB, evidence: [] }] }, plan: PLAN, bind: BIND, intent: MATCH });
    const { o } = setup(TODO, [open, carries, carries, carries, carries], u, "在 todo.txt 末尾加一行「买牛奶」");
    const s = await o.run();
    expect(u.cards[0]!.kind).toBe("ambiguity");
    expect(u.cards[0]!.options.map((x) => x.kind)).toEqual(["reading", "reading", "delegate", "cancel"]);
    expect(s.status).toBe("succeeded");
  });

  it("plan card: another reading is the user's choice; the goal is derived again with it, not asked again", async () => {
    const u = picker("reading");
    const first = byRole({ goal: { ...GOALW, assumptions: [AMBW] }, choice: { choice: "r0" }, plan: PLANW, bind: BINDW, intent: MATCH });
    const GOALA = { ...GOAL, requirements: [{ id: "r1", statement: "日志.log 末行是 X", check: { kind: "deterministic", name: "last_line_is", args: { path: "日志.log", line: "X" } }, quotes: ["X"] }] };
    const follows = byRole({ goal: { ...GOALA, assumptions: [{ ...AMBW, reading: AMBW.alternatives[0], alternatives: [AMBW.reading], evidence: [] }] },
      plan: { nodes: [{ id: "n1", capability: "fs.append_line", depends_on: [], purpose: "追加", requirement_ids: ["r1"] }], outcome: "plan" },
      bind: { bindings: { target: { kind: "resource_ref", path: "日志.log" }, line: { kind: "source_span", quote: "X", occurrence: 1 } }, unresolved: [] }, intent: MATCH });
    const { o, ws } = setup(LOG, [first, first, first, first, follows, follows, follows, follows, follows], u, "把 日志.log 的内容改成「X」");
    const s = await o.run();
    const plan = u.cards.find((c) => c.kind === "plan")!;
    expect(plan.options.map((x) => x.kind)).toEqual(["approve", "reading", "skip_step", "cancel"]);
    expect(u.cards.length).toBe(1);
    expect(s.status).toBe("succeeded");
    expect(s.assumptions).toEqual([AMBW.alternatives[0]]);
    expect(ws.read("日志.log")).toBe("旧内容\nX\n");
  });

  it("plan card: dropping the step that cannot be undone plans the rest again without it", async () => {
    const u = picker("skip_step", "approve");
    const two = { nodes: [{ id: "n1", capability: "fs.replace_text", depends_on: [], purpose: "改写", requirement_ids: ["r1"] }, { id: "n2", capability: "fs.append_line", depends_on: [], purpose: "追加", requirement_ids: ["r2"] }], outcome: "plan" };
    const GOAL2 = { ...GOALW, requirements: [...GOALW.requirements, { id: "r2", statement: "todo.txt 末行是 买牛奶", check: { kind: "deterministic", name: "last_line_is", args: { path: "todo.txt", line: "买牛奶" } }, quotes: ["买牛奶"] }] };
    let plans = 0, binds = 0;
    const sc: Scripted = (role) => role === "goal" ? { ...GOAL2, assumptions: [AMBW] } : role === "choice" ? { choice: "r0" } : role === "plan" ? (plans++ === 0 ? two : PLAN)
      : role === "bind" ? (plans === 1 && binds++ === 0 ? BINDW : BIND) : role === "intent" ? MATCH : role === "verify" ? { verdict: "pass" } : { outcome: "error", error: "none" };
    const { o, ws, log } = setup({ ...LOG, ...TODO }, Array(30).fill(sc), u, "把 日志.log 的内容改成「X」，在 todo.txt 末尾加一行「买牛奶」");
    await o.run();
    expect(fs.readFileSync(log, "utf-8")).toContain('"kind":"plan.revise"');
    expect(plans).toBe(2);
    expect(ws.read("日志.log")).toBe("旧内容");                       // the dropped step never ran
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
  });

  it("plan card: the user's own words are an answer; the goal is derived again with them", async () => {
    const u = picker({ text: "只在末尾加一行就好" });
    const w = byRole({ goal: { ...GOALW, assumptions: [AMBW] }, choice: { choice: "r0" }, plan: PLANW, bind: BINDW, intent: MATCH });
    const { o } = setup(LOG, Array(8).fill(w), u, "把 日志.log 的内容改成「X」");
    const s = await o.run();
    expect(s.answers).toContain("只在末尾加一行就好");
    expect(s.counters["calls:goal"]).toBeGreaterThanOrEqual(2);
  });

  it("action card: stop cancels before the consequential step", async () => {
    const u = picker("cancel");
    const goal = { requirements: [{ id: "r1", statement: "other.txt 不在了", check: { kind: "deterministic", name: "file_absent", args: { path: "other.txt" } }, quotes: ["other.txt"] }], constraints: [], missing: [], feasible: "yes" };
    const t = byRole({ goal, plan: { nodes: [{ id: "n1", capability: "fs.trash", depends_on: [], purpose: "删", requirement_ids: ["r1"] }], outcome: "plan" }, bind: { bindings: { target: { kind: "resource_ref", path: "other.txt" } }, unresolved: [] }, intent: MATCH });
    const { o, ws } = setup(TODO, Array(6).fill(t), u, "把 other.txt 删掉");
    const s = await o.run();
    expect(u.cards[0]!.kind).toBe("action");
    expect(s.status).toBe("cancelled");
    expect(ws.exists("other.txt")).toBe(true);
  });

  it("result check: 「不对，撤回」 undoes what was written", async () => {
    const u = picker("undo");
    const goal = { ...GOAL, requirements: [...GOAL.requirements, { id: "r2", statement: "用户认可", check: { kind: "user_confirmation" }, quotes: ["买牛奶"] }] };
    const h = byRole({ goal, plan: PLAN, bind: BIND, intent: MATCH });
    const { o, ws } = setup(TODO, Array(8).fill(h), u, "在 todo.txt 末尾加一行「买牛奶」");
    const s = await o.run();
    expect(u.cards.at(-1)!.kind).toBe("result_check");
    expect(s.status).toBe("cancelled");
    expect(ws.read("todo.txt")).toBe("交房租\n");
  });

  it("can't-do card: the user may say it differently; 「好的，先这样」 ends it", async () => {
    const lack = byRole({ goal: { requirements: [], constraints: [], missing: [], feasible: "needs_capability_we_lack", infeasible_reason: "没有打印能力" } });
    const u1 = picker("cancel");
    const s1 = await setup(TODO, [lack], u1, "把 todo.txt 打印出来").o.run();
    expect(u1.cards[0]!.kind).toBe("cannot");
    expect(s1.status).toBe("failed");
    const u2 = picker({ text: "那就在末尾加一行「买牛奶」" });
    const s2 = await setup(TODO, [lack, byRole({ goal: GOAL, plan: PLAN, bind: BIND, intent: MATCH }), byRole({ plan: PLAN }), byRole({ bind: BIND }), byRole({ intent: MATCH })], u2, "把 todo.txt 打印出来").o.run();
    expect(s2.answers).toContain("那就在末尾加一行「买牛奶」");
  });

  it("result card: shown when the result rests on an unconfirmed reading; undo takes the writes back", async () => {
    const u = picker();
    let choices = 0;     // the evidence judge, then the ask decision (harness#2): act and report
    const sc: Scripted = (role) => role === "goal" ? { ...GOAL, assumptions: [{ ...AMB, evidence: ["交房租"] }] } : role === "choice" ? (choices++ === 0 ? { choice: "r0" } : { choice: "act" })
      : role === "plan" ? PLAN : role === "bind" ? BIND : role === "intent" ? MATCH : { outcome: "error", error: "none" };
    const { o, ws } = setup(TODO, Array(10).fill(sc), u, "在 todo.txt 末尾加一行「买牛奶」");
    const s = await o.run();
    expect(s.status).toBe("succeeded");
    const card = s.result_card!;
    expect(card.blocking).toBe(false);
    expect(card.options.map((x) => x.kind)).toEqual(["approve", "undo", "undo_and_reading", "never_ask_this"]);
    o.respond(card, { option: 1 });
    expect(ws.read("todo.txt")).toBe("交房租\n");
    expect(o.summary().status).toBe("cancelled");
  });

  it("result card: 「这种以后不用告诉我」 is kept as the user's preference", async () => {
    let choices = 0;
    const sc: Scripted = (role) => role === "goal" ? { ...GOAL, assumptions: [{ ...AMB, evidence: ["交房租"] }] } : role === "choice" ? (choices++ === 0 ? { choice: "r0" } : { choice: "act" })
      : role === "plan" ? PLAN : role === "bind" ? BIND : role === "intent" ? MATCH : { outcome: "error", error: "none" };
    const { o } = setup(TODO, Array(10).fill(sc), picker(), "在 todo.txt 末尾加一行「买牛奶」");
    const s = await o.run();
    o.respond(s.result_card!, { option: s.result_card!.options.findIndex((x) => x.kind === "never_ask_this") });
    expect(o.summary().preferences.length).toBe(1);
  });

  it("undo refuses when someone changed the file since, and changes nothing", async () => {
    const { o, ws } = setup(TODO, Array(6).fill(byRole({ goal: GOAL, plan: PLAN, bind: BIND, intent: MATCH })), picker(), "在 todo.txt 末尾加一行「买牛奶」");
    await o.run();
    fs.appendFileSync(ws.abs("todo.txt"), "别人加的\n"); ws.invalidate();
    const r = o.undoRun();
    expect(r.refused).toBeTruthy();
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n别人加的\n");
  });

  it("a reading picked on the plan card survives a restart: no second card, the goal follows it", async () => {
    const u = picker("reading");
    const first = byRole({ goal: { ...GOALW, assumptions: [AMBW] }, choice: { choice: "r0" }, plan: PLANW, bind: BINDW, intent: MATCH });
    let replies = 0;
    const hooks = { after_reply: () => { if (++replies === 6) throw new Crash("after the card"); } };
    const { o, ws, gw, log } = setup(LOG, Array(8).fill(first), u, "把 日志.log 的内容改成「X」", hooks);
    await expect(o.run()).rejects.toBeInstanceOf(Crash);
    expect(u.cards.map((c) => c.kind)).toEqual(["plan"]);               // the card was answered before the crash
    const GOALA = { ...GOAL, requirements: [{ id: "r1", statement: "日志.log 末行是 X", check: { kind: "deterministic", name: "last_line_is", args: { path: "日志.log", line: "X" } }, quotes: ["X"] }] };
    gw.script = Array(8).fill(byRole({ goal: { ...GOALA, assumptions: [{ ...AMBW, reading: AMBW.alternatives[0], alternatives: [AMBW.reading], evidence: [] }] },
      plan: { nodes: [{ id: "n1", capability: "fs.append_line", depends_on: [], purpose: "追加", requirement_ids: ["r1"] }], outcome: "plan" },
      bind: { bindings: { target: { kind: "resource_ref", path: "日志.log" }, line: { kind: "source_span", quote: "X", occurrence: 1 } }, unresolved: [] }, intent: MATCH }));
    const u2 = picker();
    const s = await new Orchestrator(log, ws, gw, u2, fileRegistry()).run();
    expect(u2.cards.length).toBe(0);
    expect(s.status).toBe("succeeded");
    expect(ws.read("日志.log")).toBe("旧内容\nX\n");
  });

  const RAW_TWO = "在 todo.txt 末尾加一行「买牛奶」，再在 记录.txt 里记一笔「买牛奶」";
  const GOAL_TWO = { ...GOAL, requirements: [...GOAL.requirements, { id: "r2", statement: "记录.txt 存在", check: { kind: "deterministic", name: "file_exists", args: { path: "记录.txt" } }, quotes: ["记录.txt"] }] };
  // --- review fixes (screenspot, harness#4) ---------------------------------------------------------------------------
  it("a step reconciled after a crash (no receipt) can still be undone; nothing throws", async () => {
    const h = byRole({ goal: GOAL, plan: PLAN, bind: BIND, intent: MATCH });
    const { o, ws, gw, log } = setup(TODO, Array(6).fill(h), picker(), "在 todo.txt 末尾加一行「买牛奶」", { crash_on_first_effect: true });
    await expect(o.run()).rejects.toBeInstanceOf(Crash);
    gw.script = Array(6).fill(h);
    const o2 = new Orchestrator(log, ws, gw, picker(), fileRegistry());
    const s = await o2.run();
    expect(s.status).toBe("succeeded");
    expect(Object.values(s.ops)).toEqual(["ok"]);
    const r = o2.undoRun();
    expect(r).toMatchObject({ undone: 1, refused: null });
    expect(ws.read("todo.txt")).toBe("交房租\n");
  });

  it("undo checks every step first: if one cannot be taken back, nothing is touched", async () => {
    const two = { nodes: [{ id: "n1", capability: "fs.append_line", depends_on: [], purpose: "追加", requirement_ids: ["r1"] }, { id: "n2", capability: "fs.create_text", depends_on: [], purpose: "记一笔", requirement_ids: ["r1"] }], outcome: "plan" };
    let binds = 0;
    const sc: Scripted = (role) => role === "goal" ? GOAL_TWO : role === "plan" ? two : role === "bind" ? (binds++ % 2 === 0 ? BIND : { bindings: { parent: { kind: "literal", value: ".", authority: "任务目录" }, name: { kind: "source_span", quote: "记录.txt", occurrence: 1 }, text: { kind: "source_span", quote: "买牛奶", occurrence: 1 } }, unresolved: [] }) : role === "intent" ? MATCH : { outcome: "error", error: "none" };
    const { o, ws, log } = setup(TODO, Array(12).fill(sc), picker(), RAW_TWO);
    await o.run();
    expect(ws.exists("记录.txt")).toBe(true);
    fs.writeFileSync(ws.abs("记录.txt"), "别人改过"); ws.invalidate();
    const r = o.undoRun();
    expect(r.undone).toBe(0);
    expect(r.refused).toBeTruthy();
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");                // the other step was not undone either
  });

  it("an undo that stops part-way gets its own status, saying how far it got", async () => {
    const two = { nodes: [{ id: "n1", capability: "fs.append_line", depends_on: [], purpose: "追加", requirement_ids: ["r1"] }, { id: "n2", capability: "fs.create_text", depends_on: [], purpose: "记一笔", requirement_ids: ["r1"] }], outcome: "plan" };
    let binds = 0, choices = 0;
    const sc: Scripted = (role) => role === "goal" ? { ...GOAL_TWO, assumptions: [{ ...AMB, evidence: ["交房租"] }] } : role === "choice" ? (choices++ === 0 ? { choice: "r0" } : { choice: "act" }) : role === "plan" ? two
      : role === "bind" ? (binds++ % 2 === 0 ? BIND : { bindings: { parent: { kind: "literal", value: ".", authority: "任务目录" }, name: { kind: "source_span", quote: "记录.txt", occurrence: 1 }, text: { kind: "source_span", quote: "买牛奶", occurrence: 1 } }, unresolved: [] }) : role === "intent" ? MATCH : { outcome: "error", error: "none" };
    const { o, ws } = setup(TODO, Array(12).fill(sc), picker(), RAW_TWO);
    const s = await o.run();
    // the newest step is undone first; make the older one fail only when it is reached (after the check passed)
    const reg = (o as any).registry;
    const append = reg.get("fs.append_line");
    const orig = append.undo;
    append.undo = () => "disk said no";
    try { o.respond(s.result_card!, { option: s.result_card!.options.findIndex((x) => x.kind === "undo") }); } finally { append.undo = orig; }
    const after = o.summary();
    expect(after.status).toBe("partially_undone");
    expect(after.reason).toContain("undid 1 of 2");
    expect(ws.exists("记录.txt")).toBe(false);
  });

  it("undo and another reading: if the undo cannot happen, the user's reading is still kept", async () => {
    let choices = 0;
    const sc: Scripted = (role) => role === "goal" ? { ...GOAL, assumptions: [{ ...AMB, evidence: ["交房租"] }] } : role === "choice" ? (choices++ === 0 ? { choice: "r0" } : { choice: "act" })
      : role === "plan" ? PLAN : role === "bind" ? BIND : role === "intent" ? MATCH : { outcome: "error", error: "none" };
    const { o, ws, log } = setup(TODO, Array(10).fill(sc), picker(), "在 todo.txt 末尾加一行「买牛奶」");
    const s = await o.run();
    fs.appendFileSync(ws.abs("todo.txt"), "别人加的\n"); ws.invalidate();
    o.respond(s.result_card!, { option: s.result_card!.options.findIndex((x) => x.kind === "undo_and_reading") });
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n别人加的\n");
    const events = fs.readFileSync(log, "utf-8");
    expect(events).toContain('"kind":"ambiguity.settled"');
    expect(events).not.toContain('"kind":"run.redo"');
  });

  it("undo and another reading: the redo starts with fresh budgets", async () => {
    let choices = 0;
    const sc: Scripted = (role) => role === "goal" ? { ...GOAL, assumptions: [{ ...AMB, evidence: ["交房租"] }] } : role === "choice" ? (choices++ === 0 ? { choice: "r0" } : { choice: "act" })
      : role === "plan" ? PLAN : role === "bind" ? BIND : role === "intent" ? MATCH : { outcome: "error", error: "none" };
    const { o, log } = setup(TODO, Array(10).fill(sc), picker(), "在 todo.txt 末尾加一行「买牛奶」");
    const s = await o.run();
    o.respond(s.result_card!, { option: s.result_card!.options.findIndex((x) => x.kind === "undo_and_reading") });
    const redo = fs.readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === "run.redo");
    expect(redo.actions).toBeGreaterThanOrEqual(1);
    expect((o as any).st.budgetBase.actions).toBe(redo.actions);
  });

  it("a dropped step is refused by code: the planner may not bring it back, and it is never run", async () => {
    const u = picker("skip_step", "approve", "approve");
    const two = { nodes: [{ id: "n1", capability: "fs.replace_text", depends_on: [], purpose: "改写", requirement_ids: ["r1"] }, { id: "n2", capability: "fs.append_line", depends_on: [], purpose: "追加", requirement_ids: ["r2"] }], outcome: "plan" };
    const GOAL2 = { ...GOALW, requirements: [...GOALW.requirements, { id: "r2", statement: "todo.txt 末行是 买牛奶", check: { kind: "deterministic", name: "last_line_is", args: { path: "todo.txt", line: "买牛奶" } }, quotes: ["买牛奶"] }] };
    let plans = 0, binds = 0;
    // the planner keeps proposing the dropped step
    const sc: Scripted = (role) => role === "goal" ? { ...GOAL2, assumptions: [AMBW] } : role === "choice" ? { choice: "r0" } : role === "plan" ? (plans++, two)
      : role === "bind" ? (binds++ % 2 === 0 ? BINDW : BIND) : role === "intent" ? MATCH : { outcome: "error", error: "none" };
    const { o, ws, log } = setup({ ...LOG, ...TODO }, Array(30).fill(sc), u, "把 日志.log 的内容改成「X」，在 todo.txt 末尾加一行「买牛奶」");
    await o.run();
    expect(fs.readFileSync(log, "utf-8")).toContain("includes a step the user dropped");
    expect(ws.read("日志.log")).toBe("旧内容");
  });

  it("plan revisions are counted from the log, so a restart does not reset them", async () => {
    const u = picker("skip_step");
    const sc = byRole({ goal: { ...GOALW, assumptions: [AMBW] }, choice: { choice: "r0" }, plan: PLANW, bind: BINDW, intent: MATCH });
    const { o, ws, gw, log } = setup(LOG, Array(6).fill(sc), u, "把 日志.log 的内容改成「X」");
    await o.run();
    const o2 = new Orchestrator(log, ws, gw, picker(), fileRegistry());
    expect((o2 as any).st.get("plan_revisions")).toBe(1);
  });

  it("a reading picked on a plan card is recorded with purpose plan", async () => {
    const u = picker("reading");
    const first = byRole({ goal: { ...GOALW, assumptions: [AMBW] }, choice: { choice: "r0" }, plan: PLANW, bind: BINDW, intent: MATCH });
    const { o, log } = setup(LOG, [first, first, first, first, first], u, "把 日志.log 的内容改成「X」");
    await o.run().catch(() => undefined);
    const reply = fs.readFileSync(log, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.kind === "interaction.reply" && e.body.picked === "reading");
    expect(reply.body).toMatchObject({ kind: "clarify", purpose: "plan" });
  });
});
