/** Evalset v2 scoring: acceptable-outcome sets, asking as a correct stop, guessing on an open ambiguity. */
import { describe, expect, it } from "vitest";
import { score, talkOf, type Talk, type Task } from "../src/eval/score.js";

const start = { "简历-产品岗-赵敏.pdf": "x", "简历模板.docx": "t" };
const asWritten = { "招聘": null, "招聘/产品": null, "招聘/产品/赵敏-简历.pdf": "x", "简历模板.docx": "t" };
const spelled = { "招聘": null, "招聘/产品岗": null, "招聘/产品岗/赵敏-简历.pdf": "x", "简历模板.docx": "t" };
const allowed = ["简历-产品岗-赵敏.pdf", "招聘", "招聘/产品", "招聘/产品/赵敏-简历.pdf", "招聘/产品岗", "招聘/产品岗/赵敏-简历.pdf"];
const task = (over: Partial<Task> = {}): Task => ({
  id: "t", group: 7, split: "check", raw: "简历放「招聘/岗位」", files: start, category: "ambiguous",
  gold: { expect: "succeeded", tree: asWritten, allowed, outcomes: [{ name: "role", tree: asWritten, allowed }, { name: "role_with_岗", tree: spelled, allowed }] },
  ...over,
});
const ok = { status: "succeeded", counters: { actions: 3 }, ops: { a: "ok" } };
const waiting = { status: "waiting_user", counters: {}, ops: {} };
const talk = (o: Partial<Talk> = {}) => ({ clarify: 0, authorize: 0, askedBeforeFirstWrite: false, wrote: true, ...o });

describe("evalset v2 scoring", () => {
  it("any listed outcome is correct, and the matched one is reported", () => {
    expect(score(task(), start, asWritten, ok, [], talk())).toMatchObject({ correct: true, outcome: "role", wrong_effect: false });
    expect(score(task(), start, spelled, ok, [], talk())).toMatchObject({ correct: true, outcome: "role_with_岗" });
  });

  it("a literal 「岗位」 folder is outside every outcome: wrong action and false success", () => {
    const literal = { "招聘": null, "招聘/岗位": null, "招聘/岗位/赵敏-简历.pdf": "x", "简历模板.docx": "t" };
    expect(score(task(), start, literal, ok, [], talk())).toMatchObject({ correct: false, wrong_effect: true, false_success: true });
  });

  it("asking and stopping with nothing changed is correct only where asked_ok", () => {
    const open = task({ must_ask: true, gold: { ...task().gold, asked_ok: true } });
    expect(score(open, start, start, waiting, [], talk({ clarify: 1, clarified: true, wrote: false }))).toMatchObject({ correct: true, outcome: "asked" });
    expect(score(task(), start, start, waiting, [], talk({ clarify: 1, clarified: true, wrote: false })).correct).toBe(false);
  });

  it("a plan the user turned down is reported apart from asking, and is not counted correct", () => {
    const open = task({ must_ask: true, gold: { ...task().gold, asked_ok: true } });
    expect(score(open, start, start, waiting, [], talk({ authorize: 1, declinedPlan: true, wrote: false }))).toMatchObject({ correct: false, outcome: "declined_plan", declined_plan: true });
  });

  it("writing before any question on an open ambiguity is a wrong action even when the guess was right", () => {
    const open = task({ must_ask: true, gold: { ...task().gold, asked_ok: true } });
    expect(score(open, start, asWritten, ok, [], talk({ askedBeforeFirstWrite: false }))).toMatchObject({ correct: false, wrong_effect: true, guessed: true });
    expect(score(open, start, asWritten, ok, [], talk({ clarify: 1, askedBeforeFirstWrite: true }))).toMatchObject({ correct: true, guessed: false });
  });

  it("interruptions on a task that needs none are counted as unnecessary", () => {
    const r = score(task({ interaction: "none" }), start, asWritten, ok, [], talk({ clarify: 1, authorize: 1, askedBeforeFirstWrite: true }));
    expect(r).toMatchObject({ interruptions: 2, unnecessary: 2 });
    expect(score(task({ interaction: "needed" }), start, asWritten, ok, [], talk({ clarify: 1 })).unnecessary).toBe(0);
  });

  it("v1 tasks (no outcomes, no talk) score as before", () => {
    const v1: Task = { id: "v1", group: 1, split: "dev", raw: "r", files: start, gold: { expect: "succeeded", tree: asWritten, allowed } };
    expect(score(v1, start, asWritten, ok)).toMatchObject({ correct: true, wrong_effect: false, false_success: false });
  });
});

describe("what counts as asking before the first write", () => {
  const u = { clarifies: 0, authorizes: 1 };
  const write = { kind: "execution.intent", command: { writes: ["a.txt"] } };
  it("a confirmation of one consequential action does not count; a question or the shown plan does", () => {
    const action = { kind: "interaction.request", body: { kind: "authorize", purpose: "action" } };
    const plan = { kind: "interaction.request", body: { kind: "authorize", purpose: "plan" } };
    const question = { kind: "interaction.request", body: { kind: "clarify" } };
    expect(talkOf([action, write], u).askedBeforeFirstWrite).toBe(false);
    expect(talkOf([plan, write], u).askedBeforeFirstWrite).toBe(true);
    expect(talkOf([question, write], u).askedBeforeFirstWrite).toBe(true);
  });
  it("the outcome is what the run stopped on: a question answered earlier, then a declined plan, is a declined plan", () => {
    const q = { kind: "interaction.reply", body: { kind: "clarify", text: "x" } };
    const no = { kind: "interaction.reply", body: { kind: "authorize", purpose: "plan", approved: false } };
    expect(talkOf([q, no], u)).toMatchObject({ clarified: false, declinedPlan: true });
    expect(talkOf([no, q], u)).toMatchObject({ clarified: true, declinedPlan: false });
  });
  it("the first write is the first intent with writes, so a crash after it still counts", () => {
    const question = { kind: "interaction.request", body: { kind: "clarify" } };
    expect(talkOf([write, question], u)).toMatchObject({ wrote: true, askedBeforeFirstWrite: false });
  });
});
