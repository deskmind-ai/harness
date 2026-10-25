/**
 * rc.17 (the regression): #75 folded the second direction ("deletes or changes the user's existing content") into the
 * outgoing question; Brain, the local judge trained on the old words, answered「会发出去」(0.93) for a click on
 * 「新建纯文本文稿」 in TextEdit's Open panel, and the card listed every sidebar row as what goes out.
 *
 * Invariants:
 *  1. A local tier answers only questions it was trained on (questionDigest of their words and options, written out
 *     when it was trained); any other question skips it and goes to the tiers above.
 *  2. The outgoing question is back to its words before #75; the second direction is its own question, asked only in a
 *     window DeskMind opened under POLICY.taskOpened "task", after the outgoing question said「不会」, never of Brain.
 *  3. What a card lists as going out never holds an element whose value only repeats its label.
 */
import { describe, expect, it } from "vitest";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { ALTERS_QUESTION, BRAIN_RC16_WORDINGS, EVIDENCE_FORM, INTENT_OPTIONS, INTENT_QUESTION, Judge, OUTGOING_OPTIONS, OUTGOING_QUESTION, PROVENANCE_OPTIONS, PROVENANCE_QUESTION, VERIFY_OPTIONS, VERIFY_QUESTION, ALTERS_OPTIONS, questionDigest, type JudgeTier } from "../src/executor/judge.js";
import type { Action, Driver, Element, Observation, Snapshot, WindowInfo } from "../src/executor/types.js";

/** The outgoing question and options exactly as before #75 (harness 4c7a9d5): Brain's training. */
const PRE75_OUTGOING_DIGEST = "f28565a8062bc1f0";

describe("1. a local tier answers only the questions it was trained on", () => {
  it("the outgoing question is the pre-#75 one, and every question Brain is asked today is in its trained set; the alters question is not", () => {
    expect(questionDigest(OUTGOING_QUESTION, OUTGOING_OPTIONS)).toBe(PRE75_OUTGOING_DIGEST);
    expect(OUTGOING_OPTIONS.map((o) => o.id)).toEqual(["sends", "stays", "unsure"]);
    for (const [name, d] of [["intent", questionDigest(INTENT_QUESTION, INTENT_OPTIONS)], ["outgoing", questionDigest(OUTGOING_QUESTION, OUTGOING_OPTIONS)], ["provenance", questionDigest(PROVENANCE_QUESTION, PROVENANCE_OPTIONS)], ["verify", questionDigest(VERIFY_QUESTION, VERIFY_OPTIONS)], ["evidence", questionDigest("", [], EVIDENCE_FORM)]] as const) {
      expect(BRAIN_RC16_WORDINGS.has(d), `${name}: its words or options changed since Brain was trained — it goes to the tiers above until Brain is trained on it`).toBe(true);
    }
    expect(BRAIN_RC16_WORDINGS.has(questionDigest(ALTERS_QUESTION, ALTERS_OPTIONS))).toBe(false);
  });

  /** A tier that answers from a function and records what it was asked. */
  const tier = (name: string, answer: (q: string) => string, o: Partial<JudgeTier> = {}) => {
    const asked: string[] = [];
    const gateway = { ask: async (_r: string, _s: string, prompt: string) => { const q = prompt.slice(prompt.indexOf("问题：") + 3, prompt.indexOf("\n选项：")); asked.push(q); return { outcome: "answered", data: { choice: answer(q), scores: { x: 0.99 } } }; } };
    return { t: { name, gateway: gateway as never, floor: 0.9, ...o } as JudgeTier, asked };
  };

  it("an untrained question skips the local tier (judge.skipped why untrained) and the top tier answers; a trained one is asked of it", async () => {
    const brain = tier("brain", () => "sends", { local: true, trained: BRAIN_RC16_WORDINGS });
    const top = tier("frontier", (q) => (q === ALTERS_QUESTION ? "keeps" : "stays"));
    const events: [string, Record<string, unknown>][] = [];
    const judge = new Judge([brain.t, top.t], { onEvent: (k, b) => events.push([k, b]) });
    const a = await judge.choose(ALTERS_QUESTION, { 对象: "window:w" }, ALTERS_OPTIONS, undefined, { settle: "alters", route: false });
    expect(a).toMatchObject({ choice: "keeps", by: "frontier" });
    expect(brain.asked).toEqual([]);
    expect(events.find(([k]) => k === "judge.skipped")?.[1]).toMatchObject({ tier: "brain", why: "untrained" });
    // the outgoing question (trained): Brain is asked, and its「会发出去」settles (the safe direction)
    const b = await judge.choose(OUTGOING_QUESTION, { 对象: "window:w" }, OUTGOING_OPTIONS, undefined, { settle: "sends", route: false });
    expect(b).toMatchObject({ choice: "sends", by: "brain" });
    // a question with the same words but other options is another question
    const c = await judge.choose(OUTGOING_QUESTION, { 对象: "window:w2" }, [...OUTGOING_OPTIONS, { id: "extra", text: "x" }], undefined, { settle: "sends", route: false });
    expect(c?.by).toBe("frontier");
    // a tier with no trained set is asked everything (a cloud first tier)
    const first = tier("first", () => "keeps");
    const j2 = new Judge([first.t, tier("frontier", () => "keeps").t]);
    await j2.choose(ALTERS_QUESTION, { 对象: "window:w" }, ALTERS_OPTIONS, undefined, { settle: "alters", route: false });
    expect(first.asked).toHaveLength(1);
  });
});

// --- 2 and 4: the rc.17 step, replayed against a Brain that answers「会发出去」to anything it was not trained on --------

/** TextEdit's Open panel as hands reads it: the sidebar rows (value = their own name), a location pop-up, the
 *  「新建纯文本文稿」 button; the window brought up by the task's own launch (opened_window, was_running false). */
const PANEL: Element[] = [
  // as hands reads the sidebar (tree order, rc.17's trace): the outline, then per place a row, a cell, a static text
  { id: "side", role: "outline", label: "边栏", actions: ["click"] },
  ...["最近使用", "共享", "个人收藏", "应用程序", "桌面", "文稿", "Downloads", "iCloud云盘", "网络", "标签", "红色"].flatMap((n, i) => [
    { id: `row:${i}`, role: "row", label: "外框行", actions: ["click"] },
    { id: `cell:${i}`, role: "cell", label: "单元格", actions: ["click"] },
    { id: `text:${i}`, role: "staticText", label: n, value: n, actions: ["click"] },
  ] as Element[]),
  { id: "loc", role: "popUpButton", label: "位置", value: "文本编辑 — iCloud", actions: ["select"], options: ["文本编辑 — iCloud"] },
  { id: "syn:newdoc", role: "button", label: "新建纯文本文稿", actions: ["click"] },
];
class Desk implements Driver {
  epoch = 1;
  wins: WindowInfo[] = [];
  readonly w: WindowInfo = { id: "com.apple.TextEdit#1704", app: "com.apple.TextEdit", app_name: "文本编辑", bundle: "com.apple.TextEdit", title: "打开" };
  snapshot(): Snapshot { return { epoch: this.epoch, locked: false, front_app: "x", windows: [...this.wins] }; }
  observe(): Observation { return { epoch: this.epoch, window: this.w, modal: null, elements: PANEL.map((e) => ({ ...e })), text: "最近使用\n文稿\n桌面" }; }
  perform(a: Action) { this.epoch += 1; if (a.kind === "open_window") { this.wins.push(this.w); return { status: "ok" as const, window: this.w.id, opened_window: { id: this.w.id, app: this.w.app, app_name: "文本编辑", bundle: this.w.bundle!, title: "打开", was_running: false } }; } return { status: "ok" as const, window: this.w.id }; }
}

describe("2 and 4. the outgoing question in Brain's words; the alters question apart, never Brain's", () => {
  /** Brain as rc.17 found it: right on the words it was trained on, 「会发出去」 on anything else. */
  const brainLike = (asked: string[]) => ({ ask: async (_r: string, _s: string, prompt: string) => {
    const q = prompt.slice(prompt.indexOf("问题：") + 3, prompt.indexOf("\n选项：")); asked.push(q);
    const trainedOutgoing = q === OUTGOING_QUESTION && prompt.includes(OUTGOING_OPTIONS[1]!.text) && !prompt.includes("alters");
    return { outcome: "answered", data: { choice: q === INTENT_QUESTION ? "matches" : trainedOutgoing ? "stays" : "sends", scores: { x: 0.93 } } };
  } });
  const frontierLike = { ask: async (_r: string, _s: string, prompt: string) => { const q = prompt.slice(prompt.indexOf("问题：") + 3, prompt.indexOf("\n选项：")); return { outcome: "answered", data: { choice: q === ALTERS_QUESTION ? "keeps" : q === INTENT_QUESTION ? "matches" : "stays" } }; } };

  for (const policy of ["task", "user"] as const) {
    it(`the rc.17 click (「新建纯文本文稿」 in the Open panel of a window DeskMind opened, taskOpened "${policy}"): Brain hears only the trained outgoing question; no card under "task"`, async () => {
      const desk = new Desk();
      const brainAsked: string[] = [];
      const judge = new Judge([{ name: "brain", gateway: brainLike(brainAsked) as never, floor: 0.9, local: true, trained: BRAIN_RC16_WORDINGS }, { name: "frontier", gateway: frontierLike as never }]);
      const ex = new Executor(desk, { task: "t1", publicKey: ConsentSigner.fresh().publicKey, raw: "在文本编辑里新建一个文档，写上「你好 DeskMind」，保存为 hello.txt 放到任务目录", taskOpened: policy, judge });
      await ex.begin(); await ex.plan({ steps: [] });
      expect((await ex.act({ action: { kind: "open_window", app: "TextEdit" }, epoch: ex.currentEpoch })).status).toBe("ok");
      const o = await ex.observe(desk.w.id);
      const r = await ex.act({ action: { kind: "click", window: desk.w.id, target: "syn:newdoc" }, epoch: o.epoch });
      // under "task" the step goes without a card; under "user" the window is the user's (a card, as before #75) — never
      // as a send
      expect(r.consequence).not.toBe("external");
      expect(r.status).toBe(policy === "task" ? "ok" : "needs_consent");
      expect(brainAsked.filter((q) => q === ALTERS_QUESTION)).toEqual([]);
      expect(brainAsked.filter((q) => q === OUTGOING_QUESTION)).toHaveLength(1);
    });
  }
});

describe("3. what a card lists as going out: a send control's window as before; a window with none shows only what was typed or set", () => {
  /** The executor on `desk` with a top-only judge saying「会发出去」to the outgoing question (as rc.17's Brain did). */
  async function sendsCard(desk: Driver & { w: WindowInfo }, target: string) {
    const top = { ask: async (_r: string, _s: string, prompt: string) => { const q = prompt.slice(prompt.indexOf("问题：") + 3, prompt.indexOf("\n选项：")); return { outcome: "answered", data: { choice: q === INTENT_QUESTION ? "matches" : "sends" } }; } };
    const ex = new Executor(desk, { task: "t1", publicKey: ConsentSigner.fresh().publicKey, raw: "转发给 alice", judge: new Judge([{ name: "frontier", gateway: top as never }]) });
    await ex.begin(); await ex.plan({ steps: [] });
    (desk as { wins?: WindowInfo[] }).wins?.push(desk.w);
    const o = await ex.observe(desk.w.id);
    const r = await ex.act({ action: { kind: "click", window: desk.w.id, target }, epoch: o.epoch });
    expect(r.status).toBe("needs_consent");
    return r.challenge!;
  }
  it("the Open panel (no send control, the judge alone said 会发出去): the sidebar is not listed as going out", async () => {
    const c = await sendsCard(new Desk(), "syn:newdoc");
    const listed = c.text.slice(c.text.indexOf("要发出去的"));
    for (const n of ["最近使用", "文稿", "Downloads", "红色", "个人收藏"]) expect(listed, n).not.toContain(n);
    expect(c.facts!.outgoing.map((x) => x.value)).not.toContain("文稿");
  });
  it("(review of #79) a forward window with a 发送 control: the recipient, the forwarded item and the draft — static texts whose value is their label — are all listed", async () => {
    const w: WindowInfo = { id: "Mail#9", app: "Mail", app_name: "邮件", title: "转发：Q3 预算" };
    const els: Element[] = [
      { id: "to", role: "textField", label: "发送给：", value: "alice@example.com", actions: ["set_value"] },
      { id: "item", role: "staticText", label: "Q3 预算.pdf", value: "Q3 预算.pdf", actions: [] },
      { id: "draft", role: "staticText", label: "谢谢，见附件", value: "谢谢，见附件", actions: [] },
      { id: "send", role: "button", label: "发送", actions: ["click"], sends: true },
    ];
    const desk = { epoch: 1, wins: [] as WindowInfo[], w, snapshot() { return { epoch: this.epoch, locked: false, front_app: "x", windows: [...this.wins] }; }, observe() { return { epoch: this.epoch, window: w, modal: null, elements: els.map((e) => ({ ...e })), text: "" }; }, perform() { this.epoch += 1; return { status: "ok" as const, window: w.id }; } };
    const c = await sendsCard(desk as never, "send");
    for (const x of ["alice@example.com", "Q3 预算.pdf", "谢谢，见附件"]) expect(c.text, x).toContain(x);
  });
});
