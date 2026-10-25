/**
 * H1 (M3–M6 plan §1.2, owner 10-25 decision 1): a window the task's own launch brought up (hands `opened_window`, never
 * seen in this task before) is acted in without a card under POLICY.taskOpened "task" — unless the outgoing judge says
 * the step deletes or changes the user's existing content there, sends something out, cannot tell, or does not answer —
 * and every such step still passes the intent judge. Its content stays the user's: closing it asks, undo leaves it open.
 *
 * Invariant: an object the user had when the task began (on screen at begin, or hidden then and brought back by a
 * launch) is never changed or closed without the user's consent, under either policy.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { INTENT_QUESTION, OUTGOING_OPTIONS, OUTGOING_QUESTION, type Judge } from "../src/executor/judge.js";
import type { Action, Driver, Element, Observation, Snapshot, WindowInfo } from "../src/executor/types.js";
import type { TaskOpenedPolicy } from "../src/orchestrator/index.js";

type Says = "opened_window" | "new_window" | "none";
type Launch = { window: WindowInfo; says: Says };

/** A desk whose launches bring up what a test says: a window restored from the app's last session (opened_window), one
 *  the app made (new_window), or a hidden window of the user's that comes back (listed again, reported either way). The
 *  desk is the ground truth of what landed where (`effects`). */
class Desk implements Driver {
  epoch = 1;
  performed: { action: Action; opts?: { foreground_ok?: boolean } }[] = [];
  effects: { action: Action; window: string }[] = [];
  launches: Record<string, Launch> = {};
  constructor(public wins: WindowInfo[]) {}
  snapshot(): Snapshot { return { epoch: this.epoch, locked: false, front_app: "DeskMind", windows: [...this.wins] }; }
  observe(id: string): Observation {
    const w = this.wins.find((x) => x.id === id);
    if (!w) throw new Error(`no window ${id}`);
    // a copy per look, as a real driver gives one: a later change to ELS is a change on screen, not in an old observation
    return { epoch: this.epoch, window: w, modal: null, elements: ELS.map((e) => ({ ...e })), text: "收件箱：张三 · 会议时间" };
  }
  perform(action: Action, opts?: { foreground_ok?: boolean }) {
    this.performed.push({ action, ...(opts ? { opts } : {}) });
    if (action.kind === "open_window") {
      // the executor hands the driver the bundle id it settled on when a window of the app was ever listed (forDriver)
      const l = Object.values(this.launches).find((x) => x.window.app === action.app || x.window.bundle === action.app);
      if (!l) return { status: "ok" as const };
      if (!this.wins.some((w) => w.id === l.window.id)) this.wins.push(l.window);
      // as hands sends them (executor.py:1268 / :321): an opened_window carries id, app, app_name and title — no bundle;
      // a new_window and the snapshot's windows carry the bundle. A test cannot pass on a field hands does not send
      return { status: "ok" as const, window: l.window.id, ...(l.says === "none" ? {} : l.says === "opened_window" ? { opened_window: handsOpened(l.window) } : { new_window: l.window }) };
    }
    if (action.kind === "close_window") { this.wins = this.wins.filter((w) => w.id !== action.window); this.effects.push({ action, window: action.window }); return { status: "ok" as const }; }
    if ("window" in action && action.kind !== "scroll" && action.kind !== "focus_window") this.effects.push({ action, window: action.window });
    return { status: "ok" as const, window: "window" in action ? action.window : undefined };
  }
}
const ELS: Element[] = [
  { id: "row", role: "row", label: "张三 · 会议时间", actions: ["click"] },
  { id: "del", role: "button", label: "删除", actions: ["click"] },
  { id: "search", role: "textField", label: "搜索", actions: ["set_value", "type"], value: "" },
  { id: "body", role: "textArea", label: "正文", actions: ["type", "set_value"], value: "" },
  { id: "dd", role: "popUpButton", label: "排序", actions: ["select"], options: ["日期", "发件人"] },
  { id: "closebtn", role: "AXCloseButton", label: "", actions: ["click"] },
];
const win = (id: string, app: string, title = ""): WindowInfo => ({ id, app, app_name: app, bundle: `com.example.${app}`, title });
/** hands' `opened_window` field set: exactly the keys of hands' contract fixture (fixtures/contracts/opened_window.json,
 *  mirrored in test/fixtures/contracts — hands#70: was_running false, sent only on a proven not-running launch). */
const handsOpened = (w: WindowInfo): WindowInfo => ({ id: w.id, app: w.app, app_name: w.app_name ?? w.app, bundle: w.bundle ?? w.app, title: w.title, was_running: false, ...(w.browser ? { browser: true } : {}) });

/** A judge that answers the outgoing question with `outgoing` (null: no answer) and the intent question with `intent`,
 *  and records which questions were asked. */
function fakeJudge(outgoing: string | null, intent: string | null) {
  const asked: string[] = [];
  const judge = {
    choose: async (q: string) => {
      const name = q === OUTGOING_QUESTION ? "outgoing" : q === INTENT_QUESTION ? "intent" : "other";
      asked.push(name);
      const choice = name === "outgoing" ? outgoing : name === "intent" ? intent : "pass";
      return choice ? { choice, by: "fake", confidence: 1, reason: "" } : null;
    },
  } as unknown as Judge;
  return { judge, asked };
}

type Source = "user" | "back" | "opened" | "made";
type Kind = "click" | "set_value" | "type" | "key" | "select" | "close_window" | "scroll" | "key_close" | "key_quit" | "key_undo" | "close_button";
const KINDS: Kind[] = ["click", "set_value", "type", "key", "select", "close_window", "scroll", "key_close", "key_quit", "key_undo", "close_button"];
/** The kinds that close the window, quit the app or undo in it (review of #75, A): read off the action's structure. */
const CLOSING = new Set<Kind>(["close_window", "key_close", "key_quit", "key_undo", "close_button"]);
const action = (kind: Kind, window: string): Action =>
  kind === "click" ? { kind, window, target: "del" } : kind === "set_value" ? { kind, window, target: "search", value: "会议" }
  : kind === "type" ? { kind, window, target: "body", text: "好的" } : kind === "key" ? { kind, window, chord: "cmd+a" }
  : kind === "key_close" ? { kind: "key", window, chord: "cmd+w" } : kind === "key_quit" ? { kind: "key", window, chord: "Cmd+Q" } : kind === "key_undo" ? { kind: "key", window, chord: "shift+cmd+z" }
  : kind === "close_button" ? { kind: "click", window, target: "closebtn" }
  : kind === "select" ? { kind, window, target: "dd", option: "发件人" } : kind === "close_window" ? { kind, window } : { kind, window, dy: 3 };

/** A desk and an executor with one window of the given provenance on it (plus a window of the user's for company),
 *  the plan accepted, the window observed. */
async function stage(source: Source, policy: TaskOpenedPolicy, judge: Judge | undefined) {
  const theirs = win("Notes#1", "Notes", "购物清单");
  const target = source === "made" ? win("Mail#9", "Mail") : win("Mail#7", "Mail", "收件箱");
  const desk = new Desk(source === "user" || source === "back" ? [theirs, target] : [theirs]);
  desk.launches["Mail"] = { window: target, says: source === "made" ? "new_window" : "opened_window" };
  const app = ConsentSigner.fresh(), events: { k: string; b: Record<string, unknown> }[] = [];
  const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, raw: "打开邮件，删掉张三那封", taskOpened: policy, onEvent: (k, b) => events.push({ k, b }), ...(judge ? { judge } : {}) });
  await ex.begin(); await ex.plan({ steps: [] });
  if (source === "back") desk.wins = desk.wins.filter((w) => w !== target);                 // the user hid it after begin
  if (source !== "user") { desk.epoch += 1; expect((await ex.act({ action: { kind: "open_window", app: "Mail" }, epoch: ex.currentEpoch })).status).toBe("ok"); }
  const o = await ex.observe(target.id);
  return { desk, ex, app, events, target, o };
}

describe("H1: a window the task's launch brought up — the table (source × judge × action kind → card or not)", () => {
  const outgoingAnswers = ["stays", "alters", "sends", "unsure", null] as const;
  const intentAnswers = ["matches", "mismatch", "insufficient", null] as const;

  /** What §1.2 says should happen: the status act ends with and the class, by rule, not by the implementation. */
  function expected(source: Source, policy: TaskOpenedPolicy, kind: Kind, outgoing: string | null, intent: string | null, judge: boolean): { status: string; consequence: string } {
    if (kind === "scroll") return { status: "ok", consequence: "read" };
    const protectedWindow = source === "user" || source === "back" || (source === "opened" && policy === "user");
    // a send is a send wherever it is: the judge is asked of a click in any window; of every changing action in a window
    // DeskMind opened; the hints decide elsewhere (none here). Closing, quitting and undoing are structure, not a question,
    // in such a window — a click on the close button is still a click the outgoing judge sees, as any click is
    const asked = judge && kind !== "close_window" && (kind === "click" || kind === "close_button" || (source === "opened" && policy === "task" && !CLOSING.has(kind)));
    // 「会删改」raises only under "task"; the "user" arm is the behaviour before 10-25 (review of #75, C)
    const raised = asked ? (outgoing === "sends" || outgoing === "unsure" || outgoing === null ? "external" : outgoing === "alters" && policy === "task" ? "modify_user" : null) : null;
    let cls: string;
    if (raised === "external") cls = "external";
    // closing, quitting and undoing ask for the user's windows and for one DeskMind opened (it may hold their state, and
    // the user's edits); the task's own closes freely
    else if (protectedWindow || (CLOSING.has(kind) && source === "opened") || raised === "modify_user") cls = "modify_user";
    else if (source === "made") return { status: "ok", consequence: "create" };
    else if (!judge) cls = "modify_user";                      // a window DeskMind opened, nobody to clear the step: asks
    else {
      // a window DeskMind opened under "task", the outgoing judge said stays: the intent judge decides in the card's place
      if (intent === "mismatch") return { status: "refused", consequence: "create" };
      if (intent === "matches") return { status: "ok", consequence: "create" };
      return { status: "needs_consent", consequence: "modify_user" };
    }
    // a class that asks: the intent judge reads the step first (as before H1), a mismatch is refused, anything else is the card
    if (judge && intent === "mismatch") return { status: "refused", consequence: cls };
    return { status: "needs_consent", consequence: cls };
  }

  it("every cell, under both policies, with and without a judge", async () => {
    const rows: string[] = [], want: string[] = [];
    for (const policy of ["task", "user"] as TaskOpenedPolicy[]) for (const source of ["user", "back", "opened", "made"] as Source[]) for (const kind of KINDS) {
      const cells: { outgoing: string | null; intent: string | null; judge: boolean }[] = [{ outgoing: null, intent: null, judge: false }];
      for (const o of outgoingAnswers) for (const i of intentAnswers) cells.push({ outgoing: o, intent: i, judge: true });
      for (const c of cells) {
        const fj = c.judge ? fakeJudge(c.outgoing, c.intent) : null;
        const { desk, ex, target, o } = await stage(source, policy, fj?.judge);
        const before = desk.effects.length;
        const r = await ex.act({ action: action(kind, target.id), epoch: o.epoch });
        const e = expected(source, policy, kind, c.outgoing, c.intent, c.judge);
        const label = `${policy}/${source}/${kind}/${c.judge ? `${c.outgoing}+${c.intent}` : "no judge"}`;
        rows.push(`${label} → ${r.status} ${r.consequence} effect=${desk.effects.length > before}`);
        want.push(`${label} → ${e.status} ${e.consequence} effect=${e.status === "ok" && kind !== "scroll"}`);
        // the two readers of a step in a window DeskMind opened: the outgoing judge on every changing kind, and the intent
        // judge every time — before the card where the class asks one, in its place where the judge cleared the step
        if (c.judge && source === "opened" && policy === "task" && kind !== "scroll" && !CLOSING.has(kind)) expect([label, fj!.asked.includes("outgoing"), fj!.asked.includes("intent")]).toEqual([label, true, true]);
        // a step in a window the user had (or one taken as theirs) is never read by the intent judge without a card to follow
        if (c.judge && kind !== "scroll" && (source === "user" || source === "back" || (source === "opened" && policy === "user"))) expect([label, r.status]).toEqual([label, c.intent === "mismatch" ? "refused" : "needs_consent"]);
        if (r.status === "ok" && source === "opened" && policy === "task" && kind !== "scroll") expect([label, desk.performed.at(-1)!.opts]).toEqual([label, { foreground_ok: true }]);
      }
    }
    expect(rows).toEqual(want);
  }, 60_000);

  it("the judge's option exists, and the question still starts as it did (TierStats routes by its first words)", () => {
    expect(OUTGOING_OPTIONS.map((o) => o.id)).toEqual(["sends", "alters", "stays", "unsure"]);
    expect(OUTGOING_QUESTION.slice(0, 12)).toBe("这一步会不会把内容发出去");
    // the option's three backstops, where structure cannot see: closing / quitting from a menu or a plain button, and a
    // save over an existing file on disk (another's app's Save As, the overwrite sheet's 替换) — review of #75
    const alters = OUTGOING_OPTIONS.find((o) => o.id === "alters")!.text;
    for (const word of ["关掉窗口", "退出应用", "另存为", "替换"]) { expect(alters).toContain(word); expect(OUTGOING_QUESTION).toContain(word); }
  });

  it("a save over the user's file from a window DeskMind opened (the overwrite sheet's 替换): the judge is the guard — alters asks, stays runs", async () => {
    ELS.push({ id: "replace", role: "button", label: "替换", actions: ["click"], in_modal: true });
    try {
      for (const [answer, status] of [["alters", "needs_consent"], ["stays", "ok"]] as const) {
        const { desk, ex, target, o } = await stage("opened", "task", fakeJudge(answer, "matches").judge);
        const before = desk.effects.length;
        const r = await ex.act({ action: { kind: "click", window: target.id, target: "replace" }, epoch: o.epoch });
        expect([answer, r.status, desk.effects.length > before]).toEqual([answer, status, status === "ok"]);
      }
    } finally { ELS.pop(); }
  });

  it("the card for a change the judge raised names the window as one DeskMind opened; the step the judge cleared is journaled so, without 「改动你的东西」", async () => {
    const raised = await stage("opened", "task", fakeJudge("alters", "matches").judge);
    const r = await raised.ex.act({ action: action("click", raised.target.id), epoch: raised.o.epoch });
    expect(r.status).toBe("needs_consent");
    expect(r.challenge!.text).toContain("DeskMind 打开的 Mail「收件箱」");
    expect(r.challenge!.text).toContain("点「删除」");
    expect(r.challenge!.text).toContain("这会改动你的东西");
    const cleared = await stage("opened", "task", fakeJudge("stays", "matches").judge);
    const ok = await cleared.ex.act({ action: action("click", cleared.target.id), epoch: cleared.o.epoch });
    expect(ok.status).toBe("ok");
    const step = cleared.ex.possiblySteps().at(-1)!;
    expect(step.text).toBe("在 DeskMind 打开的 Mail「收件箱」 点「删除」");
    expect(cleared.events.some((e) => e.k === "executor.opened_cleared")).toBe(true);
    // undo still leaves the window open, and the click, like any screen action, is not taken back
    expect(cleared.ex.undoable().steps.map((s) => ({ can: s.can, left_open: s.left_open ?? null }))).toEqual([{ can: false, left_open: null }, { can: true, left_open: "Mail" }]);
  });

  it("a window the user had at begin stays theirs even when the launch lists it again as opened_window (brought back), under both policies", async () => {
    for (const policy of ["task", "user"] as TaskOpenedPolicy[]) {
      const { ex, target, o } = await stage("back", policy, fakeJudge("stays", "matches").judge);
      expect(ex.protects(`window:${target.id}`)).toBe(true);
      expect(ex.opened(`window:${target.id}`)).toBe(false);
      expect((await ex.act({ action: action("set_value", target.id), epoch: o.epoch })).status).toBe("needs_consent");
    }
  });
});

describe("H1: the property — an object the user had at begin is never changed without consent", () => {
  /** A small deterministic generator (mulberry32). */
  const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;

  it("random launches, actions, judge answers and consents, under both policies: every effect on a protected window carries a consent; refused steps have no effect", async () => {
    for (let seed = 1; seed <= 60; seed++) {
      const r = rng(seed);
      const policy: TaskOpenedPolicy = seed % 2 ? "task" : "user";
      const u1 = win("Notes#1", "Notes", "购物清单"), u2 = win("Music#2", "Music"), hidden = win("Mail#3", "Mail", "收件箱");
      const opened = win("Chat#4", "Chat", "群聊"), made = win("Editor#5", "Editor");
      const desk = new Desk([u1, u2, hidden]);
      desk.launches["Mail"] = { window: hidden, says: pick(r, ["opened_window", "new_window", "none"] as const) };
      desk.launches["Chat"] = { window: opened, says: "opened_window" };
      desk.launches["Editor"] = { window: made, says: "new_window" };
      const protectedIds = new Set([u1.id, u2.id, hidden.id]);                     // the ground truth: what the user had at begin
      let outgoing: string | null = "stays", intent: string | null = "matches";
      const judge = { choose: async (q: string) => { const c = q === OUTGOING_QUESTION ? outgoing : q === INTENT_QUESTION ? intent : "pass"; return c ? { choice: c, by: "fake", confidence: 1, reason: "" } : null; } } as unknown as Judge;
      const app = ConsentSigner.fresh();
      const ex = new Executor(desk, { task: "p", publicKey: app.publicKey, raw: "随便做点什么", taskOpened: policy, judge });
      await ex.begin(); await ex.plan({ steps: [] });
      if (r() < 0.5) desk.wins = desk.wins.filter((w) => w !== hidden);              // the user hides their mail window
      const consentedEffects: { window: string; kind: string; closing: boolean; consent: boolean; label: string }[] = [];
      for (let step = 0; step < 25; step++) {
        outgoing = pick(r, ["stays", "stays", "alters", "sends", "unsure", null] as const);
        intent = pick(r, ["matches", "matches", "mismatch", "insufficient", null] as const);
        const launch = r() < 0.2;
        if (launch) { desk.epoch += 1; await ex.act({ action: { kind: "open_window", app: pick(r, ["Mail", "Chat", "Editor"]) }, epoch: ex.currentEpoch }); continue; }
        if (!desk.wins.length) continue;
        const w = pick(r, desk.wins);
        const kind = pick(r, KINDS);
        const o = await ex.observe(w.id);
        const a = action(kind, w.id);
        const label = `seed ${seed} step ${step} ${policy} ${w.id} ${kind} ${outgoing}+${intent}`;
        let before = desk.effects.length;
        const res = await ex.act({ action: a, epoch: o.epoch });
        for (const e of desk.effects.slice(before)) consentedEffects.push({ window: e.window, kind: e.action.kind, closing: CLOSING.has(kind), consent: false, label });
        if (res.status === "refused") expect([label, desk.effects.length]).toEqual([label, before]);
        if (res.status === "needs_consent" && r() < 0.6) {
          // the user says yes on the card: the effect may land now, with the token
          before = desk.effects.length;
          const again = await ex.act({ action: a, epoch: o.epoch, consent: app.forAction(res.challenge!) });
          for (const e of desk.effects.slice(before)) consentedEffects.push({ window: e.window, kind: e.action.kind, closing: CLOSING.has(kind), consent: true, label });
          if (again.status === "ok" && res.consequence !== "read") expect([label, desk.effects.length > before || kind === "scroll"]).toEqual([label, true]);
        }
      }
      // the oracle, from the desk: a change in a window the user had at begin (listed then, hidden or not since) needs
      // a consent; under policy "user" so does one in the window the launch opened for the user's app
      // a consent; so does closing the window the launch opened for the user's app (it may hold their state), and under
      // policy "user" every change in it
      for (const e of consentedEffects) {
        const needs = protectedIds.has(e.window) || (e.window === opened.id && (policy === "user" || e.closing));
        if (needs) expect([e.label, e.consent]).toEqual([e.label, true]);
      }
      // the ground truth and the record agree: every effect the desk saw is accounted for
      expect(consentedEffects.length).toBe(desk.effects.length);
    }
  }, 120_000);
});

describe("H1: the plan card (service level) — a plan on a window DeskMind opened", () => {
  async function planRun(policy: TaskOpenedPolicy, declared: "create" | "modify_user", objects: string[] = ["窗口 Mail#7"]) {
    const { Gateway } = await import("../src/gateway/index.js");
    const { FrontierRuntime } = await import("../src/host/frontier.js");
    const { scriptedStream } = await import("../src/runtime/scripted.js");
    const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as never;
    const mail = win("Mail#7", "Mail", "收件箱");
    const desk = new Desk([win("Notes#1", "Notes", "购物清单")]);
    desk.launches["Mail"] = { window: mail, says: "opened_window" };
    const app = ConsentSigner.fresh(), events: { k: string; b: Record<string, unknown> }[] = [];
    const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, taskOpened: policy, judge: fakeJudge("stays", "matches").judge, onEvent: (k, b) => events.push({ k, b }) });
    const gw = new Gateway(table); gw.script = Array(10).fill(() => ({ choice: "pass", reason: "ok" }));
    const cards: { kind: string; text: string }[] = [];
    const model = { model: { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } } as never;
    const steps = [
      { calls: [{ name: "computer_act", args: { action: { kind: "open_window", app: "Mail" }, epoch: 1, consequence: "create", purpose: "打开邮件" } }] },
      { calls: [{ name: "plan", args: { steps: [{ purpose: "删掉张三那封", objects, consequence: declared }] } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "x" } }] },
    ];
    const rt = new FrontierRuntime({ task: "t1", raw: "打开邮件，删掉张三那封", executor: ex, signer: app, user: { ask: (c: { kind: string; text: string; options: { kind: string }[] }) => { cards.push(c); return { option: c.options.findIndex((o) => o.kind === "approve") }; } }, gateway: gw, model: { ...(model as object), streamFn: scriptedStream(steps as never) } as never, onEvent: (k: string, b: Record<string, unknown>) => events.push({ k, b }) });
    await rt.run();
    return { cards, events };
  }

  it("policy task: no plan card, whatever class the caller wrote for the step; the trace says why and names the window", async () => {
    for (const declared of ["create", "modify_user"] as const) {
      const { cards, events } = await planRun("task", declared);
      expect([declared, cards.map((c) => c.kind)]).toEqual([declared, []]);
      const no = events.find((e) => e.k === "plan.no_card");
      expect([declared, no?.b]).toEqual([declared, { why: "within_request", task_opened: ["window:Mail#7"], task_opened_policy: "task" }]);
    }
  });

  it("policy task: a step naming the window and an element id or a row's words (which resolve to nothing) is judged by the window; one naming nothing that resolves, or the user's window too, keeps the card", async () => {
    expect((await planRun("task", "modify_user", ["窗口 Mail#7", "元素 Mail#7:0:row:m3", "张三 · 报销单"])).cards.map((c) => c.kind)).toEqual([]);
    // (an element id carries the window's id, so canonObjects resolves it to the window; a row's words alone resolve to nothing)
    expect((await planRun("task", "modify_user", ["张三 · 报销单"])).cards.map((c) => c.kind)).toEqual(["plan"]);
    expect((await planRun("task", "modify_user", ["窗口 Mail#7", "窗口 Notes#1"])).cards.map((c) => c.kind)).toEqual(["plan"]);
  });

  it("policy user: the plan card as before, naming the window DeskMind opened as 「改你的东西」", async () => {
    const { cards, events } = await planRun("user", "create");
    expect(cards.map((c) => c.kind)).toEqual(["plan"]);
    expect(cards[0]!.text).toContain("DeskMind 打开的 Mail「收件箱」");
    expect(cards[0]!.text).toContain("改你的东西");
    expect(events.some((e) => e.k === "plan.no_card")).toBe(false);
  });
});

describe("review of #75", () => {
  it("A: closing, quitting or undoing in a window DeskMind opened asks, whatever the judge says — structure, not a question", async () => {
    const out: string[] = [];
    for (const chord of ["cmd+w", "cmd+q", "cmd+z", "shift+cmd+w", "cmd+shift+z"]) {
      const { desk, ex, target, o } = await stage("opened", "task", fakeJudge("stays", "matches").judge);
      const before = desk.effects.length;
      const r = await ex.act({ action: { kind: "key", window: target.id, chord }, epoch: o.epoch });
      out.push(`${chord} ${r.status} ${r.consequence} effect=${desk.effects.length > before}`);
    }
    expect(out).toEqual(["cmd+w", "cmd+q", "cmd+z", "shift+cmd+w", "cmd+shift+z"].map((c) => `${c} needs_consent modify_user effect=false`));
    // the close button too; and cmd+q in the task's own window of an app the user has a window of
    const closeBtn = await stage("opened", "task", fakeJudge("stays", "matches").judge);
    expect((await closeBtn.ex.act({ action: { kind: "click", window: closeBtn.target.id, target: "closebtn" }, epoch: closeBtn.o.epoch })).status).toBe("needs_consent");
    const desk = new Desk([win("Mail#1", "Mail", "收件箱")]);
    desk.launches["Mail"] = { window: win("Mail#2", "Mail"), says: "new_window" };
    const app = ConsentSigner.fresh();
    const ex = new Executor(desk, { task: "t", publicKey: app.publicKey, raw: "x", taskOpened: "task", judge: fakeJudge("stays", "matches").judge });
    await ex.begin(); await ex.plan({ steps: [] });
    desk.epoch += 1; await ex.act({ action: { kind: "open_window", app: "Mail" }, epoch: ex.currentEpoch });
    const o = await ex.observe("Mail#2");
    expect(ex.ledger.ownerOf("window:Mail#2")).toBe("task");
    expect((await ex.act({ action: { kind: "key", window: "Mail#2", chord: "cmd+q" }, epoch: o.epoch })).status).toBe("needs_consent");           // quits the user's Mail#1 too
    expect((await ex.act({ action: { kind: "key", window: "Mail#2", chord: "cmd+w" }, epoch: o.epoch })).status).toBe("ok");                       // closes only its own
  });

  it("B: the user's Mail on screen at begin, quit mid-task, relaunched by the task with a new window id: still the user's", async () => {
    const desk = new Desk([win("Mail#7", "Mail", "收件箱")]);
    const app = ConsentSigner.fresh(), events: { k: string; b: Record<string, unknown> }[] = [];
    const ex = new Executor(desk, { task: "t", publicKey: app.publicKey, raw: "打开邮件，删掉张三那封", taskOpened: "task", judge: fakeJudge("stays", "matches").judge, onEvent: (k, b) => events.push({ k, b }) });
    await ex.begin(); await ex.plan({ steps: [] });
    desk.wins = []; desk.epoch += 1;                                   // the user quits Mail
    const restored = win("Mail#8", "Mail", "收件箱");                  // the same mailbox, a new window id
    desk.launches["Mail"] = { window: restored, says: "opened_window" };
    await ex.act({ action: { kind: "open_window", app: "Mail" }, epoch: ex.currentEpoch });
    const o = await ex.observe(restored.id);
    const before = desk.effects.length;
    const r = await ex.act({ action: { kind: "click", window: restored.id, target: "del" }, epoch: o.epoch });
    expect([ex.protects("window:Mail#8"), ex.opened("window:Mail#8"), r.status, desk.effects.length > before]).toEqual([true, false, "needs_consent", false]);
    expect(events.find((e) => e.k === "executor.window_not_opened")?.b).toEqual({ id: "Mail#8", why: "a window of this app was seen in this task" });
    expect(ex.undoable().steps.some((s) => s.left_open)).toBe(false);
  });

  it("B': an opened_window from a url launch, or of a browser, is never one DeskMind opened", async () => {
    for (const [why, launch, url] of [["a url launch", { window: win("Mail#3", "Mail"), says: "opened_window" as Says }, "https://x.test"], ["a browser", { window: { ...win("Safari#3", "Safari"), browser: true }, says: "opened_window" as Says }, undefined]] as const) {
      const desk = new Desk([]);
      desk.launches[launch.window.app] = launch;
      const app = ConsentSigner.fresh(), events: { k: string; b: Record<string, unknown> }[] = [];
      const ex = new Executor(desk, { task: "t", publicKey: app.publicKey, raw: "x", taskOpened: "task", judge: fakeJudge("stays", "matches").judge, onEvent: (k, b) => events.push({ k, b }) });
      await ex.begin(); await ex.plan({ steps: [] });
      desk.epoch += 1;
      const epoch = (await ex.snapshot()).epoch;
      const open: Action = { kind: "open_window", app: launch.window.app, ...(url ? { url } : {}) };
      let r = await ex.act({ action: open, epoch });
      // a url for an app with no window on screen is taken to land in the user's window: the card is answered here
      if (r.status === "needs_consent") r = await ex.act({ action: open, epoch, consent: app.forAction(r.challenge!) });
      expect([why, r.status, ex.opened(`window:${launch.window.id}`), ex.protects(`window:${launch.window.id}`)]).toEqual([why, "ok", false, true]);
      expect([why, events.find((e) => e.k === "executor.window_not_opened")?.b.why]).toEqual([why, why]);
    }
  });

  it("C: under POLICY.taskOpened \"user\" the plan grades as before: a declared modify_user on the task's own window still draws the card; the judge's「会删改」does not raise", async () => {
    // the plan
    const { Gateway } = await import("../src/gateway/index.js");
    const { FrontierRuntime } = await import("../src/host/frontier.js");
    const { scriptedStream } = await import("../src/runtime/scripted.js");
    const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as never;
    for (const [policy, want] of [["user", ["plan"]], ["task", []]] as const) {
      const desk = new Desk([win("Notes#1", "Notes", "购物清单")]);
      desk.launches["Mail"] = { window: win("Mail#7", "Mail"), says: "new_window" };
      const app = ConsentSigner.fresh();
      const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, taskOpened: policy, judge: fakeJudge("stays", "matches").judge });
      const gw = new Gateway(table); gw.script = Array(10).fill(() => ({ choice: "pass", reason: "ok" }));
      const cards: { kind: string }[] = [];
      const model = { model: { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } } as never;
      const steps = [
        { calls: [{ name: "computer_act", args: { action: { kind: "open_window", app: "Mail" }, epoch: 1, consequence: "create", purpose: "打开邮件" } }] },
        { calls: [{ name: "plan", args: { steps: [{ purpose: "删掉张三那封", objects: ["窗口 Mail#7"], consequence: "modify_user" }] } }] },
        { calls: [{ name: "finish", args: { outcome: "done", summary: "x" } }] },
      ];
      const rt = new FrontierRuntime({ task: "t1", raw: "打开邮件，删掉张三那封", executor: ex, signer: app, user: { ask: (c: { kind: string; options: { kind: string }[] }) => { cards.push(c); return { option: c.options.findIndex((o) => o.kind === "approve") }; } }, gateway: gw, model: { ...(model as object), streamFn: scriptedStream(steps as never) } as never });
      await rt.run();
      expect([policy, cards.map((c) => c.kind)]).toEqual([policy, want]);
    }
    // the judge's answer in the task's own window
    for (const [policy, status] of [["user", "ok"], ["task", "needs_consent"]] as const) {
      const { desk, ex, target, o } = await stage("made", policy, fakeJudge("alters", "matches").judge);
      const before = desk.effects.length;
      const r = await ex.act({ action: action("click", target.id), epoch: o.epoch });
      expect([policy, r.status, desk.effects.length > before]).toEqual([policy, status, status === "ok"]);
    }
  });
});

describe("review of #75, delta round", () => {
  it("B2: as hands sends it — snapshot windows carry the bundle, opened_window does not (id, app, app_name, title)", async () => {
    const mailAtBegin: WindowInfo = { id: "com.apple.mail#7", app: "邮件", app_name: "邮件", bundle: "com.apple.mail", title: "收件箱" };
    const desk = new Desk([mailAtBegin]);
    const app = ConsentSigner.fresh();
    const ex = new Executor(desk, { task: "t", publicKey: app.publicKey, raw: "打开邮件，删掉张三那封", taskOpened: "task", judge: fakeJudge("stays", "matches").judge });
    await ex.begin(); await ex.plan({ steps: [] });
    desk.wins = []; desk.epoch += 1;
    const restored = { id: "com.apple.mail#8", app: "邮件", app_name: "邮件", title: "收件箱" } as WindowInfo;
    const orig = desk.perform.bind(desk);
    desk.perform = ((a: Action, op?: { foreground_ok?: boolean }) => { if (a.kind === "open_window") { desk.performed.push({ action: a }); desk.wins.push(restored); return { status: "ok" as const, window: restored.id, opened_window: { ...restored, was_running: false } }; } return orig(a, op); }) as typeof desk.perform;
    await ex.act({ action: { kind: "open_window", app: "邮件" }, epoch: ex.currentEpoch });
    const o = await ex.observe(restored.id);
    const before = desk.effects.length;
    const r = await ex.act({ action: { kind: "click", window: restored.id, target: "del" }, epoch: o.epoch });
    expect([ex.protects("window:com.apple.mail#8"), r.status, desk.effects.length > before]).toEqual([true, "needs_consent", false]);
    // and the other way round: the app known at begin only by a window whose id carries the bundle, the launch naming it by its English name
    const desk2 = new Desk([{ id: "com.apple.mail#7", app: "邮件", bundle: "com.apple.mail", title: "收件箱" }]);
    const ex2 = new Executor(desk2, { task: "t", publicKey: app.publicKey, raw: "x", taskOpened: "task", judge: fakeJudge("stays", "matches").judge });
    await ex2.begin(); await ex2.plan({ steps: [] });
    desk2.wins = []; desk2.epoch += 1;
    const back = { id: "com.apple.mail#9", app: "Mail", app_name: "Mail", title: "Inbox" } as WindowInfo;
    desk2.perform = (() => { desk2.wins.push(back); return { status: "ok" as const, window: back.id, opened_window: handsOpened(back) }; }) as typeof desk2.perform;
    await ex2.act({ action: { kind: "open_window", app: "Mail" }, epoch: ex2.currentEpoch });
    expect([ex2.opened("window:com.apple.mail#9"), ex2.protects("window:com.apple.mail#9")]).toEqual([false, true]);
  });

  it("D: the content fact — a field holding anything is the user's, even text the task itself just typed (nothing is credited to the task: Codex round 3)", async () => {
    const { desk, ex, target, o } = await stage("opened", "task", undefined);
    const seen: Record<string, unknown>[] = [];
    (ex as unknown as { opts: { judge: Judge; raw: string } }).opts.judge = { choose: async (q: string, ctx: Record<string, unknown>) => { if (q === OUTGOING_QUESTION) seen.push(ctx); return { choice: q === OUTGOING_QUESTION ? "stays" : "matches", by: "fake", confidence: 1, reason: "" }; } } as unknown as Judge;
    expect((await ex.act({ action: { kind: "type", window: target.id, target: "search", text: "的" }, epoch: o.epoch })).status).toBe("ok");
    const fact = () => { const el = seen.at(-1)!["目标元素"] as Record<string, unknown>; return [el["目标里已有内容"], "已有内容是本次任务打的" in el]; };
    expect(fact()).toEqual([false, false]);                              // an empty field, and no "task's own" fact exists any more
    const search = ELS.find((e) => e.id === "search")!; (search as { value?: string }).value = "的";
    desk.epoch += 1; const o2 = await ex.observe(target.id);
    await ex.act({ action: { kind: "type", window: target.id, target: "search", text: "会议" }, epoch: o2.epoch });
    expect(fact()).toEqual([true, false]);                               // the task's own text in the box: still "holds content" — the judge asks
    (search as { value?: string }).value = "";
  });
});

describe("Codex review of #75", () => {
  it("P1-1: floors before fallbacks — a send-marked control in a window DeskMind opened is a send with or without a judge", async () => {
    ELS.push({ id: "sendbtn", role: "button", label: "", actions: ["click"], sends: true });
    try {
      for (const judge of [undefined, fakeJudge("stays", "matches").judge]) {
        const { desk, ex, target, o } = await stage("opened", "task", judge);
        const before = desk.effects.length;
        const r = await ex.act({ action: { kind: "click", window: target.id, target: "sendbtn" }, epoch: o.epoch });
        expect([!!judge, r.status, r.consequence, desk.effects.length > before]).toEqual([!!judge, "needs_consent", "external", false]);
      }
      // the same floor for Return in a window that has such a control, no judge attached
      const { desk, ex, target, o } = await stage("opened", "task", undefined);
      const r = await ex.act({ action: { kind: "key", window: target.id, chord: "return" }, epoch: o.epoch });
      expect([r.status, r.consequence, desk.effects.length]).toEqual(["needs_consent", "external", 0]);
    } finally { ELS.pop(); }
  });

  it("P1-2: a cleared write re-checks the field right before acting — content that arrived while judging (no epoch moved) stops it", async () => {
    for (const kind of ["set_value", "type"] as const) {
      const search = ELS.find((e) => e.id === "search")!;
      (search as { value?: string }).value = "";
      // the judge answers, and meanwhile the field fills with the user's synced content, the epoch unmoved
      const judge = { choose: async (q: string) => { if (q === OUTGOING_QUESTION) (search as { value?: string }).value = "用户同步过来的草稿"; return { choice: q === OUTGOING_QUESTION ? "stays" : "matches", by: "fake", confidence: 1, reason: "" }; } } as unknown as Judge;
      const { desk, ex, target, o } = await stage("opened", "task", judge);
      const before = desk.effects.length;
      const a: Action = kind === "set_value" ? { kind, window: target.id, target: "search", value: "会议" } : { kind, window: target.id, target: "search", text: "会议" };
      const r = await ex.act({ action: a, epoch: o.epoch });
      expect([kind, r.status, desk.effects.length > before]).toEqual([kind, "stale", false]);
      // either reading of the same fact ends it: the field's content differs, or the target no longer resolves by identity
      expect(r.why).toMatch(/content changed|no longer one of a kind/);
      (search as { value?: string }).value = "";
      // and with the field as it was judged, the write goes through
      const quiet = await stage("opened", "task", fakeJudge("stays", "matches").judge);
      expect((await quiet.ex.act({ action: kind === "set_value" ? { kind, window: quiet.target.id, target: "search", value: "会议" } : { kind, window: quiet.target.id, target: "search", text: "会议" }, epoch: quiet.o.epoch })).status).toBe("ok");
    }
  });
});

describe("Codex review of #75, round 2 — the facts the gate rests on come from one ledger, fed by one pair of driver reads", () => {
  it("1: text ownership does not follow an element id a later observation gives to another field", async () => {
    const facts: Record<string, unknown>[] = [];
    const judge = { choose: async (q: string, ctx: Record<string, unknown>) => {
      let choice = "matches";
      if (q === OUTGOING_QUESTION) { const el = ctx["目标元素"] as Record<string, unknown>; facts.push(el); choice = el["目标里已有内容"] ? "alters" : "stays"; }
      return { choice, by: "fake", confidence: 1, reason: "follow the supplied ownership facts" };
    } } as unknown as Judge;
    const { desk, ex, target, o } = await stage("opened", "task", judge);
    expect((await ex.act({ action: { kind: "type", window: target.id, target: "search", text: "hello" }, epoch: o.epoch })).status).toBe("ok");
    // a later layout gives the search box's id to the user's note, whose text happens to equal what the task typed
    const originalObserve = desk.observe.bind(desk);
    desk.observe = (id) => { const ob = originalObserve(id); return { ...ob, elements: ob.elements.map((e) => (e.id === "search" ? { ...e, id: "search-moved" } : e.id === "body" ? { ...e, id: "search", value: "hello" } : e)) }; };
    desk.epoch += 1;
    const current = await ex.observe(target.id);
    const before = desk.effects.length;
    const r = await ex.act({ action: { kind: "set_value", window: target.id, target: "search", value: "overwrite" }, epoch: current.epoch });
    expect({ holds: facts.at(-1)!["目标里已有内容"], status: r.status, effect: desk.effects.length > before }).toEqual({ holds: true, status: "needs_consent", effect: false });
    // the renumbered search box itself, holding exactly the task's text, asks too: nothing is credited to the task (round 3)
    const o2 = await ex.observe(target.id);
    const searchNow = o2.elements.find((e) => e.id === "search-moved")!; (searchNow as { value?: string }).value = "hello";
    desk.observe = (id) => { const ob = originalObserve(id); return { ...ob, elements: ob.elements.map((e) => (e.id === "search" ? { ...e, id: "search-moved", value: "hello" } : e)) }; };
    desk.epoch += 1;
    const o3 = await ex.observe(target.id);
    expect((await ex.act({ action: { kind: "type", window: target.id, target: "search-moved", text: " world" }, epoch: o3.epoch })).status).toBe("needs_consent");
    expect(facts.at(-1)!["目标里已有内容"]).toBe(true);
  });

  it("2: a user app seen only in act's own snapshots (a wait) is remembered: its later relaunch is the user's", async () => {
    const desk = new Desk([win("Notes#1", "Notes", "购物清单")]);
    const app = ConsentSigner.fresh();
    const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, raw: "打开邮件，删掉张三那封", taskOpened: "task", judge: fakeJudge("stays", "matches").judge });
    await ex.begin(); await ex.plan({ steps: [] });
    desk.wins.push(win("Mail#7", "Mail", "收件箱")); desk.epoch += 1;                   // the user opens Mail; only act's snapshots see it
    expect((await ex.act({ action: { kind: "wait", ms: 0 }, epoch: desk.epoch })).status).toBe("ok");
    desk.wins = desk.wins.filter((w) => w.app !== "Mail"); desk.epoch += 1;            // the user quits Mail
    const restored = win("Mail#8", "Mail", "收件箱");
    desk.launches["Mail"] = { window: restored, says: "opened_window" };
    expect((await ex.act({ action: { kind: "open_window", app: "Mail" }, epoch: desk.epoch })).status).toBe("ok");
    const o = await ex.observe(restored.id);
    const before = desk.effects.length;
    const r = await ex.act({ action: { kind: "click", window: restored.id, target: "del" }, epoch: o.epoch });
    expect({ opened: ex.opened("window:Mail#8"), protects: ex.protects("window:Mail#8"), status: r.status, effect: desk.effects.length > before }).toEqual({ opened: false, protects: true, status: "needs_consent", effect: false });
  });

  it("the executor reads the driver in exactly two places, and both feed the ledger (checked on the source)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(new URL("../src/executor/executor.ts", import.meta.url), "utf-8");
    const snaps = [...src.matchAll(/this\.driver\.snapshot\(/g)].length, looks = [...src.matchAll(/this\.driver\.observe\(/g)].length;
    expect({ snaps, looks }).toEqual({ snaps: 1, looks: 1 });
    const see = src.slice(src.indexOf("private async see()"), src.indexOf("private async watch("));
    const watch = src.slice(src.indexOf("private async watch("), src.indexOf("private async watch(") + 400);
    expect(see).toContain("this.driver.snapshot("); expect(see).toContain("this.noteSeen(");
    expect(watch).toContain("this.driver.observe("); expect(watch).toContain("this.noteSeen(");
    const note = src.slice(src.indexOf("private noteSeen("), src.indexOf("private noteSeen(") + 600);
    expect(note).toContain("this.ledger.saw("); expect(note).toContain('this.journal("seen"');
    // no other module reaches the executor's driver either
    for (const f of ["service.ts", "judge.ts", "consent.ts"]) expect(fs.readFileSync(new URL(`../src/executor/${f}`, import.meta.url), "utf-8")).not.toMatch(/executor\.driver\.(snapshot|observe)/);
  });

  it("property: random looks, snapshots, user actions (apps opened and quit, fields filled, ids renumbered) and task actions under a fact-following judge — no user object changed without a card", async () => {
    const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const pick = <T,>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
    /** content is the user's whenever the field holds anything at all (round 3: nothing is credited to the task) */
    type Field = { key: string; role: string; label: string; value: string };
    /** A desk whose element ids are numbered per observation, whose fields remember who wrote them (the ground truth), and
     *  that knows which windows the user opened (at begin or mid-task): those are theirs whatever a launch calls them. */
    class World implements Driver {
      epoch = 1; gen = 0; wins: WindowInfo[] = []; effects: { action: Action; window: string; userContent: boolean }[] = [];
      /** windows the user opened (at begin or mid-task), and the apps of those among them the harness was ever shown — a
       *  window opened and quit between two reads was never on anyone's screen but the user's; what a later launch restores
       *  is their content all the same, which is why its steps are judged, not free */
      userWins = new Set<string>(); userSeenApps = new Set<string>();
      private shown() { for (const w of this.wins) if (this.userWins.has(w.id)) this.userSeenApps.add(w.app); }
      fields = new Map<string, Field[]>();
      idMap = new Map<string, string>();        // current observation-local id → window:key
      constructor(public r: () => number) {}
      snapshot(): Snapshot { this.shown(); return { epoch: this.epoch, locked: false, front_app: "DeskMind", windows: [...this.wins] }; }
      fieldsOf(w: string) { if (!this.fields.has(w)) this.fields.set(w, [{ key: "search", role: "textField", label: "搜索", value: "" }, { key: "body", role: "textArea", label: "正文", value: "" }]); return this.fields.get(w)!; }
      observe(id: string): Observation {
        const w = this.wins.find((x) => x.id === id); if (!w) throw new Error(`no window ${id}`);
        this.shown(); this.gen += 1; this.idMap = new Map();
        const els: Element[] = [{ id: `del@${this.gen}`, role: "button", label: "删除", actions: ["click"] }];
        for (const f of this.fieldsOf(id)) { const eid = `${f.key}@${this.gen}`; this.idMap.set(eid, `${id}:${f.key}`); els.push({ id: eid, role: f.role, label: f.label, actions: ["type", "set_value"], value: f.value }); }
        return { epoch: this.epoch, window: w, modal: null, elements: els, text: "" };
      }
      perform(a: Action) {
        if (a.kind === "open_window") {
          const id = `${a.app}#${this.gen + 100 + this.wins.length}`;
          const w: WindowInfo = { id, app: a.app, app_name: a.app, title: "收件箱" };
          this.wins.push(w); this.epoch += 1;
          return { status: "ok" as const, window: id, opened_window: handsOpened(w) };          // every launch restores the app's last session
        }
        if (!("window" in a)) return { status: "ok" as const };
        if (a.kind === "close_window") { this.wins = this.wins.filter((w) => w.id !== a.window); this.effects.push({ action: a, window: a.window, userContent: true }); return { status: "ok" as const }; }
        if (a.kind === "type" || a.kind === "set_value") {
          const key = this.idMap.get(a.target)?.split(":")[1]; const f = this.fieldsOf(a.window).find((x) => x.key === key);
          if (!f) return { status: "error" as const, why: "no such field" };
          const userContent = f.value !== "";
          if (a.kind === "set_value") f.value = a.value; else f.value += a.text;
          this.effects.push({ action: a, window: a.window, userContent }); this.epoch += 1; return { status: "ok" as const, window: a.window };
        }
        if (a.kind === "scroll" || a.kind === "focus_window") return { status: "ok" as const, window: a.window };
        this.effects.push({ action: a, window: a.window, userContent: true }); this.epoch += 1; return { status: "ok" as const, window: a.window };
      }
      /** the user acts: opens an app, quits one, writes into a field (no epoch for a sync; the user's own typing moves it) */
      userActs() {
        const k = this.r();
        if (k < 0.2) { const app = pick(this.r, ["Mail", "Notes"]); if (!this.wins.some((w) => w.app === app)) { const id = `${app}#u${this.gen}`; this.wins.push({ id, app, app_name: app, title: "收件箱" }); this.userWins.add(id); this.epoch += 1; } }
        else if (k < 0.35) { const app = pick(this.r, ["Mail", "Notes"]); if (this.wins.some((w) => w.app === app)) { this.wins = this.wins.filter((w) => w.app !== app); this.epoch += 1; } }
        else if (k < 0.7 && this.wins.length) { const w = pick(this.r, this.wins); const f = pick(this.r, this.fieldsOf(w.id)); f.value = pick(this.r, ["用户的笔记", "hello", "牛奶", f.value + "！"]); if (this.r() < 0.5) this.epoch += 1; }
      }
    }
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const world = new World(r);
      world.wins.push({ id: "Notes#1", app: "Notes", app_name: "Notes", title: "购物清单" }); world.userWins.add("Notes#1");
      const judge = { choose: async (q: string, ctx: Record<string, unknown>) => {
        if (q !== OUTGOING_QUESTION) return { choice: "matches", by: "fake", confidence: 1, reason: "" };
        const el = ctx["目标元素"] as Record<string, unknown> | null;
        const holds = el ? el["目标里已有内容"] : false;
        return { choice: holds === true ? "alters" : holds === false ? "stays" : "unsure", by: "fake", confidence: 1, reason: "" };
      } } as unknown as Judge;
      const app = ConsentSigner.fresh();
      const journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "h1p2-")), "journal.jsonl");
      let ex = new Executor(world, { task: "p2", publicKey: app.publicKey, raw: "随便做点什么", taskOpened: "task", judge, journal });
      await ex.begin(); await ex.plan({ steps: [] });
      // `theirs` is taken at the moment of the effect: an app the user opens later does not make an earlier launch theirs
      const record: { window: string; theirs: boolean; consent: boolean; userContent: boolean; kind: string; chord: string; label: string }[] = [];
      const theirsNow = (window: string) => world.userSeenApps.has(window.split("#")[0]!);
      for (let step = 0; step < 30; step++) {
        if (r() < 0.5) world.userActs();
        // the process dies and the task resumes in a new one, on the same journal: what the first saw must still count
        if (r() < 0.08) { ex = new Executor(world, { task: "p2", publicKey: app.publicKey, raw: "随便做点什么", taskOpened: "task", judge, journal }); await ex.begin(); await ex.plan({ steps: [] }); }
        const k = r();
        let a: Action; let epoch: number;
        if (k < 0.15) { a = { kind: "wait", ms: 0 }; epoch = (await ex.snapshot()).epoch; }
        else if (k < 0.3) { a = { kind: "open_window", app: pick(r, ["Mail", "Notes"]) }; epoch = (await ex.snapshot()).epoch; }
        else {
          if (!world.wins.length) continue;
          const w = pick(r, world.wins);
          const o = await ex.observe(w.id); epoch = o.epoch;
          const fields = o.elements.filter((e) => e.actions.includes("type"));
          const kk = r();
          a = kk < 0.4 ? { kind: "type", window: w.id, target: pick(r, fields).id, text: pick(r, ["会议", "x", "好的"]) } : kk < 0.7 ? { kind: "set_value", window: w.id, target: pick(r, fields).id, value: pick(r, ["会议", "hello"]) } : kk < 0.85 ? { kind: "click", window: w.id, target: o.elements[0]!.id } : { kind: "key", window: w.id, chord: pick(r, ["cmd+a", "cmd+w"]) };
        }
        const label = `seed ${seed} step ${step} ${JSON.stringify(a)}`;
        let before = world.effects.length;
        const res = await ex.act({ action: a, epoch });
        for (const e of world.effects.slice(before)) record.push({ window: e.window, theirs: theirsNow(e.window), consent: false, userContent: e.userContent, kind: e.action.kind, chord: e.action.kind === "key" ? e.action.chord : "", label });
        if (res.status === "needs_consent" && r() < 0.6) {
          before = world.effects.length;
          await ex.act({ action: a, epoch, consent: app.forAction(res.challenge!) });
          for (const e of world.effects.slice(before)) record.push({ window: e.window, theirs: theirsNow(e.window), consent: true, userContent: e.userContent, kind: e.action.kind, chord: e.action.kind === "key" ? e.action.chord : "", label });
        }
      }
      // the oracle, from the world: a window of an app the user opened (at begin or mid-task) is theirs, whatever a launch
      // called it; in a window the task launched for an app the user never opened, a write into a field that holds anything
      // and a close need consent (the judge sees the content fact; closing is structure) — a click or another key there
      // runs on the judge's「不会」by design, only a write into an empty field runs free
      for (const e of record) {
        const needs = e.theirs || ((e.kind === "type" || e.kind === "set_value") && e.userContent) || e.kind === "close_window" || /cmd\+w/i.test(e.chord);
        if (needs) expect([e.label, e.kind, e.consent]).toEqual([e.label, e.kind, true]);
      }
    }
  }, 120_000);
});

describe("review of #75, probe R — the ledger survives the process", () => {
  it("R: the user's Mail seen at begin in process 1, quit, then relaunched by process 2 on the same journal: still the user's", async () => {
    const journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "r75-")), "journal.jsonl");
    const mail: WindowInfo = { id: "com.apple.mail#7", app: "邮件", app_name: "邮件", bundle: "com.apple.mail", title: "收件箱" };
    const desk = new Desk([mail]);
    const app = ConsentSigner.fresh();
    const ex1 = new Executor(desk, { task: "t", publicKey: app.publicKey, raw: "打开邮件，删掉张三那封", taskOpened: "task", journal, judge: fakeJudge("stays", "matches").judge });
    await ex1.begin(); await ex1.plan({ steps: [] });
    desk.wins = []; desk.epoch += 1;                                    // the user quits Mail; process 1 dies
    const events: { k: string; b: Record<string, unknown> }[] = [];
    const ex2 = new Executor(desk, { task: "t", publicKey: app.publicKey, raw: "打开邮件，删掉张三那封", taskOpened: "task", journal, judge: fakeJudge("stays", "matches").judge, onEvent: (k, b) => events.push({ k, b }) });
    await ex2.begin(); await ex2.plan({ steps: [] });
    expect(events.find((e) => e.k === "executor.ledger_reloaded")?.b).toEqual({ seen_lines: 1 });   // process 1's begin (process 2 saw nothing new before reading it)
    const restored = { id: "com.apple.mail#8", app: "邮件", app_name: "邮件", title: "收件箱" } as WindowInfo;
    const orig = desk.perform.bind(desk);
    desk.perform = ((a: Action, op?: { foreground_ok?: boolean }) => { if (a.kind === "open_window") { desk.wins.push({ ...restored, bundle: "com.apple.mail" }); return { status: "ok" as const, window: restored.id, opened_window: { ...restored, was_running: false } }; } return orig(a, op); }) as typeof desk.perform;
    await ex2.act({ action: { kind: "open_window", app: "邮件" }, epoch: ex2.currentEpoch });
    const o = await ex2.observe(restored.id);
    const before = desk.effects.length;
    const r = await ex2.act({ action: { kind: "click", window: restored.id, target: "del" }, epoch: o.epoch });
    expect([ex2.protects("window:com.apple.mail#8"), r.status, desk.effects.length > before]).toEqual([true, "needs_consent", false]);
    // the journal's seen lines carry id and the app's names, nothing else of the window
    const seen = fs.readFileSync(journal, "utf-8").split("\n").filter((l) => l.includes('"seen"')).map((l) => JSON.parse(l) as { windows: Record<string, unknown>[] });
    expect(seen[0]!.windows).toEqual([{ id: "com.apple.mail#7", app: "邮件", app_name: "邮件", bundle: "com.apple.mail" }]);
  });

  it("a journal from before `seen` lines existed fails closed: every window an intent names counts as seen, by its id's bundle prefix", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r75old-")), journal = path.join(dir, "journal.jsonl");
    fs.writeFileSync(journal, JSON.stringify({ t: 1, kind: "intent", action: { kind: "click", window: "com.apple.mail#3", target: "x" }, object: "window:com.apple.mail#3", consequence: "modify_user", text: "点「删除」" }) + "\n" + JSON.stringify({ t: 2, kind: "receipt", status: "ok", seq: 1, driver_status: "ok" }) + "\n");
    const desk = new Desk([]);
    const app = ConsentSigner.fresh(), events: { k: string; b: Record<string, unknown> }[] = [];
    const ex = new Executor(desk, { task: "t", publicKey: app.publicKey, raw: "x", taskOpened: "task", journal, judge: fakeJudge("stays", "matches").judge, onEvent: (k, b) => events.push({ k, b }) });
    await ex.begin(); await ex.plan({ steps: [] });
    expect(events.filter((e) => e.k.startsWith("executor.ledger") || e.k.startsWith("executor.journal")).map((e) => [e.k, e.b])).toEqual([["executor.ledger_reloaded", { seen_lines: 0 }]]);
    const restored = { id: "com.apple.mail#9", app: "邮件", app_name: "邮件", title: "收件箱" } as WindowInfo;
    desk.perform = (() => { desk.wins.push(restored); return { status: "ok" as const, window: restored.id, opened_window: { ...restored, was_running: false } }; }) as typeof desk.perform;
    desk.epoch += 1;
    await ex.act({ action: { kind: "open_window", app: "邮件" }, epoch: (await ex.snapshot()).epoch });
    expect([ex.opened("window:com.apple.mail#9"), ex.protects("window:com.apple.mail#9")]).toEqual([false, true]);
  });
});

describe("Codex review of #75, round 3", () => {
  it("a same-looking body field in another document of the same window, holding the task's earlier text: still a card (nothing is credited to the task)", async () => {
    let value = "", doc = "新建文稿", holds: unknown;
    const judge = { choose: async (q: string, ctx: Record<string, unknown>) => {
      if (q !== OUTGOING_QUESTION) return { choice: "matches", by: "fake", confidence: 1, reason: "" };
      const el = ctx["目标元素"] as Record<string, unknown>; holds = el["目标里已有内容"];
      return { choice: holds ? "alters" : "stays", by: "fake", confidence: 1, reason: "follow the supplied content fact" };
    } } as unknown as Judge;
    const { desk, ex, target } = await stage("opened", "task", judge);
    target.title = doc; desk.epoch += 1;
    const observe = desk.observe.bind(desk);
    desk.observe = (id) => { const ob = observe(id); return { ...ob, window: { ...ob.window, title: doc }, elements: ob.elements.map((e) => (e.id === "body" ? { ...e, value, rect: [10, 10, 300, 400] as [number, number, number, number] } : e)) }; };
    const perform = desk.perform.bind(desk);
    desk.perform = ((a: Action, opts?: { foreground_ok?: boolean }) => { if (a.kind === "set_value" && a.target === "body") value = a.value; return perform(a, opts); }) as typeof desk.perform;
    const o = await ex.observe(target.id);
    expect((await ex.act({ action: { kind: "set_value", window: target.id, target: "body", value: "hello" }, epoch: o.epoch })).status).toBe("ok");
    // the same app window switches to the user's existing document: same role, label and bounds, the same text
    doc = "用户已有的笔记"; target.title = doc; value = "hello"; desk.epoch += 1;
    const current = await ex.observe(target.id), before = desk.effects.length;
    const r = await ex.act({ action: { kind: "set_value", window: target.id, target: "body", value: "overwrite" }, epoch: current.epoch });
    expect({ holds, status: r.status, effect: desk.effects.length > before }).toEqual({ holds: true, status: "needs_consent", effect: false });
  });

  it("recovery pairs intents with receipts and ignores every other line: a `seen` line after the interrupted intent, or a look at begin, hides nothing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r75r3-")), journal = path.join(dir, "journal.jsonl");
    // an earlier process: a receipted intent, then an intent with no receipt, then a `seen` line its last look wrote
    const lines = [
      { t: 1, kind: "seen", windows: [{ id: "com.apple.mail#7", app: "邮件", bundle: "com.apple.mail" }] },
      { t: 2, kind: "intent", action: { kind: "click", window: "com.apple.mail#7", target: "a" }, object: "window:com.apple.mail#7", consequence: "modify_user", text: "点「回复」" },
      { t: 3, kind: "receipt", status: "ok", seq: 1, driver_status: "ok" },
      { t: 4, kind: "intent", action: { kind: "click", window: "com.apple.mail#7", target: "b" }, object: "window:com.apple.mail#7", consequence: "modify_user", text: "点「删除」" },
      { t: 5, kind: "seen", windows: [{ id: "com.apple.notes#2", app: "备忘录", bundle: "com.apple.notes" }] },
    ];
    fs.writeFileSync(journal, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const desk = new Desk([win("Notes#1", "Notes", "购物清单")]);           // a window on screen at restart: the first look writes a `seen` line
    const app = ConsentSigner.fresh(), events: { k: string; b: Record<string, unknown> }[] = [];
    const ex = new Executor(desk, { task: "t", publicKey: app.publicKey, raw: "x", taskOpened: "task", journal, onEvent: (k, b) => events.push({ k, b }) });
    await ex.begin();
    expect(ex.recovered).toMatchObject({ finding: "unknown", text: "点「删除」" });
    // the receipted step is not in doubt; the journal's order is as the earlier process left it, this process's lines after
    const kinds = fs.readFileSync(journal, "utf-8").split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { kind: string }).kind);
    expect(kinds.slice(0, 5)).toEqual(["seen", "intent", "receipt", "intent", "seen"]);
    expect(kinds.slice(5)).toEqual(["receipt", "seen"]);                 // recovery's record of the step in doubt, then this process's first look
    // and both apps the earlier process saw are the user's now
    expect([ex.ledger.seenApp({ id: "com.apple.mail#9", app: "邮件" }), ex.ledger.seenApp({ id: "x#1", app: "备忘录" })]).toEqual([true, true]);
  });
});

describe("Codex review of #75, round 4 — unknown is never the safe value", () => {
  it("an editable field whose value the driver could not read (the screen) is unknown, not empty: the judge gets no 「已有内容」 fact and a flag, and the write asks", async () => {
    let value = "用户原有的正文", fact: unknown, flag: unknown;
    const judge = { choose: async (q: string, ctx: Record<string, unknown>) => {
      if (q !== OUTGOING_QUESTION) return { choice: "matches", by: "fake", confidence: 1, reason: "" };
      const el = ctx["目标元素"] as Record<string, unknown>; fact = el["目标里已有内容"]; flag = el["目标内容读不出来"];
      const choice = fact === true ? "alters" : fact === false ? "stays" : "unsure";
      return { choice, by: "fake", confidence: 1, reason: "follow the supplied content fact" };
    } } as unknown as Judge;
    const { desk, ex, target } = await stage("opened", "task", judge);
    (ex as unknown as { opts: { raw: string } }).opts.raw = "打开邮件，在正文里填写回复";
    const observe = desk.observe.bind(desk), perform = desk.perform.bind(desk);
    desk.observe = (id) => { const o = observe(id); return { ...o, text: "", elements: [{ id: "body", role: "textArea", label: "正文", source: "pixels", actions: ["type", "set_value"] }] }; };
    desk.perform = ((a: Action, opts?: { foreground_ok?: boolean }) => { if (a.kind === "set_value" && a.target === "body") value = a.value; return perform(a, opts); }) as typeof desk.perform;
    const ob = await ex.observe(target.id);
    const result = await ex.act({ action: { kind: "set_value", window: target.id, target: "body", value: "任务的新回复" }, epoch: ob.epoch });
    expect({ fact, flag, status: result.status, value }).toEqual({ fact: undefined, flag: true, status: "needs_consent", value: "用户原有的正文" });
    // a screen-read field with text in it is known to hold content; an accessibility field with "" is known empty
    const { fieldHolds } = await import("../src/executor/executor.js");
    expect([fieldHolds({ id: "ocr:1", role: "textArea", label: "", actions: ["type"], value: "hi" }), fieldHolds({ id: "ocr:2", role: "textArea", label: "", actions: ["type"], value: "" }), fieldHolds({ id: "ax", role: "textArea", label: "", actions: ["type"], value: "" }), fieldHolds({ id: "ax2", role: "textArea", label: "", actions: ["type"] })]).toEqual([true, undefined, false, undefined]);
  });

  it("legacy window history survives a second restart after new seen lines: both sources are read every time", async () => {
    const journal = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pr75legacy-")), "journal.jsonl");
    const lines = [
      { t: 1, kind: "intent", action: { kind: "click", window: "com.apple.mail#3", target: "x" }, object: "window:com.apple.mail#3", consequence: "modify_user", text: "点删除" },
      { t: 2, kind: "receipt", status: "ok", seq: 1, driver_status: "ok" },
    ];
    fs.writeFileSync(journal, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    const app = ConsentSigner.fresh();
    const desk = new Desk([win("Notes#1", "Notes", "购物清单")]);
    const make = () => new Executor(desk, { task: "t", publicKey: app.publicKey, raw: "打开邮件，删掉张三那封", taskOpened: "task", journal, judge: fakeJudge("stays", "matches").judge });
    const first = make();
    await first.begin();
    expect(first.ledger.seenApp({ id: "com.apple.mail#9", app: "邮件" })).toBe(true);
    // the first upgraded process ends without reopening Mail; its begin appended a `seen` line for Notes
    const second = make();
    await second.begin(); await second.plan({ steps: [] });
    const restored: WindowInfo = { id: "com.apple.mail#9", app: "邮件", app_name: "邮件", bundle: "com.apple.mail", title: "收件箱" };
    desk.launches["邮件"] = { window: restored, says: "opened_window" };
    await second.act({ action: { kind: "open_window", app: "邮件" }, epoch: second.currentEpoch });
    const ob = await second.observe(restored.id), before = desk.effects.length;
    const result = await second.act({ action: { kind: "click", window: restored.id, target: "del" }, epoch: ob.epoch });
    expect({ opened: second.opened(`window:${restored.id}`), status: result.status, effect: desk.effects.length > before }).toEqual({ opened: false, status: "needs_consent", effect: false });
  });
});
