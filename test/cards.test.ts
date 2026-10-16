/** Interaction cards (openjev docs/design/interaction-cards-2026-10-09.md): every interaction offers options with a
 *  fixed meaning; the runtime acts on the meaning only. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Gateway, type Scripted } from "../src/gateway/index.js";
import { Orchestrator, type Answer, type Card, type CardUser, type OptionKind, type Policy } from "../src/orchestrator/index.js";
import { evidenceQuestion } from "../src/orchestrator/prompts.js";
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

function setup(files: Record<string, string | null>, script: Scripted[], u: CardUser, raw: string, hooks: any = {}, policy: Partial<Policy> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-cards-"));
  build(root, files);
  const ws = new Workspace(root);
  const gw = new Gateway(table); gw.script = script;
  const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-cards-log-")), "log.jsonl");
  const o = new Orchestrator(log, ws, gw, u, fileRegistry(), { hooks, policy });
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

  it("can't-do, policy \"ask\" (default): the user may say it differently; 「好的，先这样」 ends it", async () => {
    const lack = byRole({ goal: { requirements: [], constraints: [], missing: [], feasible: "needs_capability_we_lack", infeasible_reason: "没有打印能力" } });
    const u1 = picker("cancel");
    const s1 = await setup(TODO, [lack], u1, "把 todo.txt 打印出来").o.run();
    expect(u1.cards[0]!.kind).toBe("cannot");
    expect(s1.status).toBe("failed");
    expect(s1.result_card).toBeNull();
    expect(s1.policy).toEqual({ cannot: "ask", evidence: "v2" });
    const u2 = picker({ text: "那就在末尾加一行「买牛奶」" });
    const s2 = await setup(TODO, [lack, byRole({ goal: GOAL, plan: PLAN, bind: BIND, intent: MATCH }), byRole({ plan: PLAN }), byRole({ bind: BIND }), byRole({ intent: MATCH })], u2, "把 todo.txt 打印出来").o.run();
    expect(s2.answers).toContain("那就在末尾加一行「买牛奶」");
  });

  it("can't-do, policy \"report\": the card comes with the result, stopping nothing; the user may say it differently or let it be", async () => {
    const lack = byRole({ goal: { requirements: [], constraints: [], missing: [], feasible: "needs_capability_we_lack", infeasible_reason: "没有打印能力" } });
    const u1 = picker();
    const r1 = setup(TODO, [lack], u1, "把 todo.txt 打印出来", {}, { cannot: "report" });
    const s1 = await r1.o.run();
    expect(u1.cards).toEqual([]);                                   // nobody was asked: the run just ended
    expect(s1.status).toBe("failed");
    const card = s1.result_card!;
    expect(card).toMatchObject({ kind: "cannot", blocking: false, free_text: true });
    expect(card.options.map((x) => x.kind)).toEqual(["cancel"]);
    r1.o.respond(card, { option: 0 });                              // 「好的，先这样」
    expect(r1.o.summary().status).toBe("failed");

    const u2 = picker();
    const { o, ws } = setup(TODO, [lack, byRole({ goal: GOAL, plan: PLAN, bind: BIND, intent: MATCH }), byRole({ plan: PLAN }), byRole({ bind: BIND }), byRole({ intent: MATCH })], u2, "把 todo.txt 打印出来", {}, { cannot: "report" });
    const first = await o.run();
    o.respond(first.result_card!, { text: "那就在末尾加一行「买牛奶」" });
    const s2 = await o.run();
    expect(s2.answers).toContain("那就在末尾加一行「买牛奶」");
    expect(s2.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
    expect(u2.cards).toEqual([]);
  });

  it("can't-do, policy \"report\": once the asks budget is spent, only 「好的，先这样」 is left", async () => {
    const lack = byRole({ goal: { requirements: [], constraints: [], missing: [], feasible: "needs_capability_we_lack", infeasible_reason: "没有打印能力" } });
    const { o } = setup(TODO, Array(6).fill(lack), picker(), "把 todo.txt 打印出来", {}, { cannot: "report" });
    let s = await o.run();
    for (const t of ["打印", "还是打印", "就打印"]) { o.respond(s.result_card!, { text: t }); s = await o.run(); }
    expect(s.status).toBe("failed");
    expect(s.result_card!.free_text).toBe(false);
    o.respond(s.result_card!, { text: "再试" });                     // not taken
    expect(o.summary().status).toBe("failed");
  });

  it("can't-do, policy \"report\": a stale card or an empty answer starts nothing (review of harness#6)", async () => {
    const lack = byRole({ goal: { requirements: [], constraints: [], missing: [], feasible: "needs_capability_we_lack", infeasible_reason: "没有打印能力" } });
    // a card kept from the first result, answered after the user's new wording already succeeded: no second run
    const { o, ws } = setup(TODO, [lack, byRole({ goal: GOAL, plan: PLAN, bind: BIND, intent: MATCH }), byRole({ plan: PLAN }), byRole({ bind: BIND }), byRole({ intent: MATCH })], picker(), "把 todo.txt 打印出来", {}, { cannot: "report" });
    const kept = (await o.run()).result_card!;
    o.respond(kept, { text: "那就在末尾加一行「买牛奶」" });
    expect((await o.run()).status).toBe("succeeded");
    o.respond(kept, { text: "那就在末尾加一行「买牛奶」" });
    expect(o.summary().status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
    // an empty answer leaves the can't-do result as it was
    const r = setup(TODO, [lack], picker(), "把 todo.txt 打印出来", {}, { cannot: "report" });
    const card = (await r.o.run()).result_card!;
    r.o.respond(card, { text: "   " });
    expect(r.o.summary()).toMatchObject({ status: "failed", result_card: { kind: "cannot" } });
    // a card kept while the budget lasted is not taken once it is spent
    const b = setup(TODO, Array(6).fill(lack), picker(), "把 todo.txt 打印出来", {}, { cannot: "report" });
    let s = await b.o.run();
    const early = s.result_card!;
    for (const t of ["打印", "还是打印", "就打印"]) { b.o.respond(s.result_card!, { text: t }); s = await b.o.run(); }
    b.o.respond(early, { text: "再试" });
    expect(b.o.summary().status).toBe("failed");
    expect(b.o.st.get("ask:clarify")).toBe(3);
  });

  it("evidence wording: v1 is the question before harness#7 word for word, v2 adds the criteria", () => {
    expect(evidenceQuestion("那份笔记", "v1")).toBe("用户原话里的「那份笔记」指的是哪一种？只根据下面的证据判断；证据区分不了就选「说不清」。");
    expect(evidenceQuestion("那份笔记")).toBe(evidenceQuestion("那份笔记", "v2"));
    expect(evidenceQuestion("那份笔记", "v2")).toContain("只是几个候选并列");
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

  // --- re-review: a run that writes the same path more than once (screenspot, harness#4) ------------------------------
  it("undo after appending twice to the same file restores it", async () => {
    const two = { nodes: [{ id: "n1", capability: "fs.append_line", depends_on: [], purpose: "第一行", requirement_ids: ["r1"] }, { id: "n2", capability: "fs.append_line", depends_on: ["n1"], purpose: "第二行", requirement_ids: ["r1"] }], outcome: "plan" };
    const goal = { ...GOAL, requirements: [{ id: "r1", statement: "todo.txt 末行是 买鸡蛋", check: { kind: "deterministic", name: "last_line_is", args: { path: "todo.txt", line: "买鸡蛋" } }, quotes: ["买鸡蛋"] }] };
    let binds = 0;
    const sc: Scripted = (role) => role === "goal" ? goal : role === "plan" ? two : role === "intent" ? MATCH
      : role === "bind" ? { bindings: { target: { kind: "resource_ref", path: "todo.txt" }, line: { kind: "source_span", quote: binds++ === 0 ? "买牛奶" : "买鸡蛋", occurrence: 1 } }, unresolved: [] } : { outcome: "error", error: "none" };
    const { o, ws } = setup(TODO, Array(12).fill(sc), picker(), "在 todo.txt 末尾加两行「买牛奶」「买鸡蛋」");
    const s = await o.run();
    expect(s.status).toBe("succeeded");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n买鸡蛋\n");
    expect(o.undoRun()).toMatchObject({ undone: 2, total: 2, refused: null });
    expect(ws.read("todo.txt")).toBe("交房租\n");
  });

  it("undo after a move chain A→B→C puts the file back at A", async () => {
    const chain = { nodes: [{ id: "n1", capability: "fs.move", depends_on: [], purpose: "先挪到 b", requirement_ids: ["r1"] }, { id: "n2", capability: "fs.move", depends_on: ["n1"], purpose: "再挪到 c", requirement_ids: ["r1"] }], outcome: "plan" };
    const goal = { requirements: [{ id: "r1", statement: "c.txt 存在", check: { kind: "deterministic", name: "file_exists", args: { path: "c.txt" } }, quotes: ["c.txt"] }], constraints: [], missing: [], feasible: "yes" };
    let binds = 0;
    const sc: Scripted = (role) => role === "goal" ? goal : role === "plan" ? chain : role === "intent" ? MATCH
      : role === "bind" ? (binds++ === 0 ? { bindings: { source: { kind: "resource_ref", path: "a.txt" }, destination: { kind: "source_span", quote: "b.txt", occurrence: 1 } }, unresolved: [] }
        : { bindings: { source: { kind: "source_span", quote: "b.txt", occurrence: 1 }, destination: { kind: "source_span", quote: "c.txt", occurrence: 1 } }, unresolved: [] }) : { outcome: "error", error: "none" };
    const { o, ws } = setup({ "a.txt": "内容" }, Array(12).fill(sc), picker(), "把 a.txt 先改名 b.txt，再改名 c.txt");
    const s = await o.run();
    expect(s.status).toBe("succeeded");
    expect(ws.exists("c.txt")).toBe(true);
    expect(o.undoRun()).toMatchObject({ undone: 2, total: 2, refused: null });
    expect(ws.read("a.txt")).toBe("内容");
    expect(ws.exists("b.txt") || ws.exists("c.txt")).toBe(false);
  });

  it("undo after making a folder and moving files into it removes both", async () => {
    const plan = { nodes: [{ id: "n1", capability: "fs.mkdir", depends_on: [], purpose: "建文件夹", requirement_ids: ["r1"] }, { id: "n2", capability: "fs.move", depends_on: ["n1"], purpose: "移进去", requirement_ids: ["r1"] }], outcome: "plan" };
    const goal = { requirements: [{ id: "r1", statement: "归档/a.txt 存在", check: { kind: "deterministic", name: "file_exists", args: { path: "归档/a.txt" } }, quotes: ["归档"] }], constraints: [], missing: [], feasible: "yes" };
    let binds = 0;
    const sc: Scripted = (role) => role === "goal" ? goal : role === "plan" ? plan : role === "intent" ? MATCH
      : role === "bind" ? (binds++ === 0 ? { bindings: { path: { kind: "source_span", quote: "归档", occurrence: 1 } }, unresolved: [] }
        : { bindings: { source: { kind: "resource_ref", path: "a.txt" }, destination: { kind: "derived", value: "归档/a.txt", from_paths: ["a.txt"], how: "放进归档" } }, unresolved: [] }) : { outcome: "error", error: "none" };
    const { o, ws } = setup({ "a.txt": "内容" }, Array(12).fill(sc), picker(), "把 a.txt 放进新建的「归档」");
    const s = await o.run();
    expect(s.status).toBe("succeeded");
    expect(o.undoRun()).toMatchObject({ undone: 2, total: 2, refused: null });
    expect(ws.read("a.txt")).toBe("内容");
    expect(ws.exists("归档")).toBe(false);
  });
});
