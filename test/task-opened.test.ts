/**
 * H1 (M3–M6 plan §1.2, owner 10-25 decision 1): a window the task's own launch brought up (hands `opened_window`, never
 * seen in this task before) is acted in without a card under POLICY.taskOpened "task" — unless the outgoing judge says
 * the step deletes or changes the user's existing content there, sends something out, cannot tell, or does not answer —
 * and every such step still passes the intent judge. Its content stays the user's: closing it asks, undo leaves it open.
 *
 * Invariant: an object the user had when the task began (on screen at begin, or hidden then and brought back by a
 * launch) is never changed or closed without the user's consent, under either policy.
 */
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
    return { epoch: this.epoch, window: w, modal: null, elements: ELS, text: "收件箱：张三 · 会议时间" };
  }
  perform(action: Action, opts?: { foreground_ok?: boolean }) {
    this.performed.push({ action, ...(opts ? { opts } : {}) });
    if (action.kind === "open_window") {
      // the executor hands the driver the bundle id it settled on when a window of the app was ever listed (forDriver)
      const l = Object.values(this.launches).find((x) => x.window.app === action.app || x.window.bundle === action.app);
      if (!l) return { status: "ok" as const };
      if (!this.wins.some((w) => w.id === l.window.id)) this.wins.push(l.window);
      return { status: "ok" as const, window: l.window.id, ...(l.says === "none" ? {} : { [l.says]: l.window }) };
    }
    if (action.kind === "close_window") { this.wins = this.wins.filter((w) => w.id !== action.window); this.effects.push({ action, window: action.window }); return { status: "ok" as const }; }
    if ("window" in action && action.kind !== "scroll" && action.kind !== "focus_window") this.effects.push({ action, window: action.window });
    return { status: "ok" as const, window: "window" in action ? action.window : undefined };
  }
}
const ELS: Element[] = [
  { id: "row", role: "row", label: "张三 · 会议时间", actions: ["click"] },
  { id: "del", role: "button", label: "删除", actions: ["click"] },
  { id: "search", role: "textField", label: "搜索", actions: ["set_value", "type"] },
  { id: "body", role: "textArea", label: "正文", actions: ["type", "set_value"] },
  { id: "dd", role: "popUpButton", label: "排序", actions: ["select"], options: ["日期", "发件人"] },
  { id: "closebtn", role: "AXCloseButton", label: "", actions: ["click"] },
];
const win = (id: string, app: string, title = ""): WindowInfo => ({ id, app, app_name: app, bundle: `com.example.${app}`, title });

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
  async function planRun(policy: TaskOpenedPolicy, declared: "create" | "modify_user") {
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
      { calls: [{ name: "plan", args: { steps: [{ purpose: "删掉张三那封", objects: ["窗口 Mail#7"], consequence: declared }] } }] },
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
