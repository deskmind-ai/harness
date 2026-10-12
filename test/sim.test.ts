/** The simulated user (evaluation only): options shown with what they do, and a pick must rest on a fact it holds. */
import { describe, expect, it } from "vitest";
import type { Card } from "../src/orchestrator/index.js";
import type { UserFacts } from "../src/eval/score.js";
import { confirmPrompt, questionPrompt, readPick } from "../src/eval/sim.js";

const facts: UserFacts = { intent: "目标文件已存在时，用户不想覆盖", answer: "那就算了", choice_texts: [], approve: "no" };
const conflict: Card = { kind: "missing", text: "notes.txt 已经存在，怎么处理？", free_text: true, blocking: true, options: [
  { kind: "proposal", text: "用 清单.txt 的内容覆盖现有的 notes.txt" }, { kind: "proposal", text: "保留现有的 notes.txt，副本换一个名字" },
  { kind: "delegate", text: "由你决定" }, { kind: "cancel", text: "先别做了" }] };
const plan: Card = { kind: "plan", text: "我打算这样做：…", free_text: true, blocking: true, options: [
  { kind: "approve", text: "可以" }, { kind: "cancel", text: "先别做了" }] };

describe("simulated user", () => {
  it("shows what each option does, and the facts it may rest on", () => {
    const p = questionPrompt(facts, conflict);
    expect(p).toContain("[停下，这件事不做了] 先别做了");
    expect(p).toContain("[按这个做法做] 保留现有的 notes.txt");
    expect(p).toContain("被问到时你会说：那就算了");
    // a confirmation does not carry the question's answer, but does carry a 'no' the user holds
    expect(confirmPrompt(facts, plan)).not.toContain("那就算了");
    expect(confirmPrompt(facts, plan)).toContain("你不同意助手照现在这样做");
  });

  it("takes a pick only with a fact the user holds", () => {
    expect(readPick({ fact: "那就算了", option: 3 }, conflict, facts)).toEqual({ option: 3 });
    expect(readPick({ fact: "用户不想覆盖", option: 1 }, conflict, facts)).toEqual({ option: 1 });      // a part of a fact
    // copied as listed: with the label, or several lines of the list
    expect(readPick({ fact: "你真正的意思：目标文件已存在时，用户不想覆盖\n被问到时你会说：那就算了", option: 3 }, conflict, facts)).toEqual({ option: 3 });
    expect(readPick({ fact: "被问到时你会说：那就算了\n副本换个名字", option: 1 }, conflict, facts)).toBe("unsupported");
    expect(readPick({ fact: "副本换个名字就行", option: 1 }, conflict, facts)).toBe("unsupported");   // not something it holds
    expect(readPick({ option: 1 }, conflict, facts)).toBe("unsupported");
    expect(readPick({ option: 9, fact: "那就算了" }, conflict, facts)).toBe("unsupported");
  });

  it("a content pick that leaves out what the user would say becomes their own words", () => {
    const sort: UserFacts = { intent: "正式纪要放「项目/项目名/纪要」；带「草稿」的放「草稿箱」", answer: "正式纪要放「项目/项目名/纪要」；带「草稿」的放「草稿箱」", choice_texts: [], approve: "if_matches" };
    const how: Card = { kind: "missing", text: "纪要怎么归类？", free_text: true, blocking: true, options: [
      { kind: "proposal", text: "全放一个文件夹" }, { kind: "proposal", text: "按项目分文件夹" }, { kind: "delegate", text: "由你决定" }, { kind: "cancel", text: "先别做了" }] };
    expect(readPick({ fact: "正式纪要放「项目/项目名/纪要」", left_out: "带「草稿」的放「草稿箱」", option: 1 }, how, sort)).toEqual({ text: sort.answer });
    expect(readPick({ fact: "正式纪要放「项目/项目名/纪要」", left_out: "", option: 1 }, how, sort)).toEqual({ option: 1 });
    // on a confirmation, what is left out is what the user says
    expect(readPick({ fact: "正式纪要放「项目/项目名/纪要」", left_out: "草稿要放进「草稿箱」", option: 0 }, { ...plan, options: plan.options }, sort)).toEqual({ text: "草稿要放进「草稿箱」" });
    // a reading answers one narrow point: taken on its fact alone
    const which: Card = { kind: "ambiguity", text: "「这些纪要」指哪些？", free_text: true, blocking: true, options: [
      { kind: "reading", text: "只指具体会议的纪要" }, { kind: "reading", text: "模板也算" }, { kind: "delegate", text: "由你决定" }, { kind: "cancel", text: "先别做了" }] };
    expect(readPick({ fact: "正式纪要放「项目/项目名/纪要」", left_out: "带「草稿」的放「草稿箱」", option: 0 }, which, sort)).toEqual({ option: 0 });
    // stopping carries no content: nothing can be left out
    expect(readPick({ fact: "那就算了", left_out: "不想覆盖", option: 3 }, conflict, facts)).toEqual({ option: 3 });
  });

  it("free text where the card takes it; nothing parsed is no answer", () => {
    expect(readPick({ text: "那就算了" }, conflict, facts)).toEqual({ text: "那就算了" });
    expect(readPick({ text: "那就算了" }, { ...conflict, free_text: false }, facts)).toBe("unsupported");
    expect(readPick(null, conflict, facts)).toBeNull();
  });
});
