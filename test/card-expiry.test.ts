/**
 * M2 H1 — "When time runs out, nobody answers for the user" (owner 10-24). An action card (consent for one action) left
 * unanswered for 10 minutes by the wall clock is voided (`ask_void{why:"timeout"}`); the task stays where it is,
 * holding the computer and acting on nothing, until the user taps 「现在回答」 (`reask`: the screen is read again and the
 * card asked again), steers, or stops. An answer that arrives after the void is refused with a reason and never used.
 * Plan, question and choice cards never expire. A Mac that slept past the deadline expires the card at once on waking.
 *
 * Every test runs app-run in process on the simulated desktop with a fake clock (wall time and timers apart, as on a
 * Mac whose timers stop in sleep); the session test goes through the session's controls. The oracle is the simulated
 * desktop's ground truth: what the driver was asked to perform, and whether the reply went out.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { appRun, LineReader, StdioUser } from "../src/cli/app.js";
import { EventLog, type AppEvent } from "../src/protocol/events.js";
import { parseControl } from "../src/protocol/control.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import { OUTGOING_QUESTION } from "../src/executor/judge.js";
import { Gateway } from "../src/gateway/index.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";
import type { Clock } from "../src/executor/clock.js";
import type { Action } from "../src/executor/types.js";
import { SessionHost } from "../src/session/host.js";
import { readHolder } from "../src/session/computer.js";
import type { ExecutorHandle, Launcher } from "../src/session/task.js";
import type { Card } from "../src/protocol/cards.js";

/** Wall time (`now`) and timers apart: `advance` moves both and fires what is due; `sleep` moves the wall clock only —
 *  the Mac slept, and its timers (Node's run on a clock that stops in sleep) did not move. */
class FakeClock implements Clock {
  wall = Date.UTC(2026, 9, 24, 9, 0, 0);
  private mono = 0;
  private timers: { at: number; f: () => void }[] = [];
  now() { return this.wall; }
  schedule(ms: number, f: () => void) { const t = { at: this.mono + ms, f }; this.timers.push(t); return () => { this.timers = this.timers.filter((x) => x !== t); }; }
  advance(ms: number) {
    const end = this.mono + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((x) => x !== due);
      this.wall += due.at - this.mono; this.mono = due.at;
      due.f();
    }
    this.wall += end - this.mono; this.mono = end;
  }
  sleep(ms: number) { this.wall += ms; }
  get pending() { return this.timers.length; }
}

const MIN = 60_000;
/** The owner's deadline (10-24): ten minutes by the wall clock. */
const CARD_EXPIRY_MS = 10 * MIN;
const roles = ["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"];
const MODEL = { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as never;
const gateway = () => {
  const gw = new Gateway(Object.fromEntries(roles.map((r) => [r, { backend: "scripted", model: "scripted" }])) as never);
  gw.script = Array(200).fill((role: string, _s: string, u: string) => (role === "verify" ? { choice: "pass", reason: "做完了" } : u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: /"目标名字命中发送词表":\s*true/.test(u) ? "sends" : "stays" } : { choice: "matches" }));
  return gw;
};
const lastJson = (ms: any[]) => { const m = [...ms].reverse().find((x) => x.role === "toolResult"); try { return JSON.parse(m.content[0].text.split("\n")[0]); } catch { return {}; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => unknown, ms = 5000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(2); } };

/** A simulated mail app with one message, and the runtime's steps: a plan (reply, send) the app approves, the reply
 *  written, then the send — the one action that asks its own card. `after`: the runtime's turns after the send's reply
 *  (a send that came back undone is looked at again and tried again: a new card). */
function mailSim() {
  const sim = new SimComputer();
  const w = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "m1", from: "林晓", subject: "Q3 预算", body: ["你好，关于Q3 预算，", "谢谢"], time: "14:00" }] }).id;
  return { sim, w };
}
const epochOf = (m: any[]) => lastJson(m).after?.epoch ?? lastJson(m).epoch;
const act = (action: Record<string, unknown>, consequence: string, plan_step: number) => (m: any[]): Step => ({ calls: [{ name: "computer_act", args: { action, epoch: epochOf(m), consequence, purpose: "回复", plan_step } }] });
function mailSteps(w: string, sendTries = 1): Step[] {
  const send = act({ kind: "click", window: w, target: `${w}:0:send` }, "external", 2);
  // the send button as the last look shows it (its id changes when the window is laid out again)
  const sendSeen = (m: any[]): Step => act({ kind: "click", window: w, target: (lastJson(m).elements ?? []).find((e: { id: string }) => e.id.endsWith(":send"))?.id ?? `${w}:0:send` }, "external", 2)(m);
  return [
    { calls: [{ name: "computer_snapshot", args: {} }] },
    { calls: [{ name: "plan", args: { steps: [{ purpose: "打开林晓的邮件并写回复", objects: [`window:${w}`], consequence: "modify_user" }, { purpose: "发送回复", objects: [`window:${w}`], consequence: "external" }] } }] },
    { calls: [{ name: "computer_observe", args: { window: w } }] },
    act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "modify_user", 1),
    act({ kind: "click", window: w, target: `${w}:0:reply` }, "modify_user", 1),
    act({ kind: "set_value", window: w, target: `${w}:0:compose_body`, value: "收到，谢谢" }, "modify_user", 1),
    send,
    // a send that came back undone (the screen moved, or the request changed): look again, then try it again
    ...Array.from({ length: sendTries - 1 }, (): Step[] => [{ calls: [{ name: "computer_observe", args: { window: w } }] }, sendSeen]).flat(),
    { calls: [{ name: "finish", args: { outcome: "done", summary: "回复并发送了" } }] },
  ];
}

type Entry = { event: AppEvent } | { control: Record<string, unknown> } | { perform: Action };

/** app-run in process: the plan card is approved by the app; everything else is the test's to do (`send`). Every
 *  event, every control line the app sent and every action the driver was asked to perform go on one timeline. */
function start(o: { clock: FakeClock; sendTries?: number; steps?: (w: string) => Step[]; expiryMs?: number; holdPlan?: boolean }) {
  const { sim, w } = mailSim();
  const timeline: Entry[] = [];
  const perform = sim.perform.bind(sim);
  sim.perform = (a: Action) => { timeline.push({ perform: a }); return perform(a); };
  const input = new PassThrough();
  const events: AppEvent[] = [];
  const send = (c: Record<string, unknown>) => { timeline.push({ control: c }); input.write(JSON.stringify(c) + "\n"); };
  const out = (e: AppEvent) => {
    events.push(e); timeline.push({ event: e });
    if (e.kind === "ask" && e.card.kind === "plan" && !o.holdPlan) setTimeout(() => send({ type: "answer", ask_id: e.ask_id, option: e.card.options.findIndex((x) => x.kind === "approve") }), 1);
  };
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "expiry-"));
  let finished = false;
  const done = appRun({ run_id: "run_x", raw: "回复林晓：收到，谢谢", config: "ds-flash", lang: "zh" }, {
    runs, out, input: new LineReader(input), linger: 0,
    inject: { driver: sim, gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream(o.steps?.(w) ?? mailSteps(w, o.sendTries)) }, clock: o.clock, ...(o.expiryMs !== undefined ? { cardExpiryMs: o.expiryMs } : {}) },
  }).then(() => { finished = true; });
  const actionCards = () => events.filter((e): e is Extract<AppEvent, { kind: "ask" }> => e.kind === "ask" && e.card.kind === "action");
  const approveOf = (a: Extract<AppEvent, { kind: "ask" }>) => a.card.options.findIndex((x) => x.kind === "approve");
  const sent = () => sim.mailState(w).replies.length;
  const sendClicks = () => timeline.filter((x): x is { perform: Action } => "perform" in x && x.perform.kind === "click" && /:send$/.test((x.perform as { target?: string }).target ?? "")).length;
  const voids = (why?: string) => events.filter((e): e is Extract<AppEvent, { kind: "ask_void" }> => e.kind === "ask_void" && (!why || e.why === why));
  const taskDone = () => events.find((e): e is Extract<AppEvent, { kind: "task_done" }> => e.kind === "task_done");
  return { sim, w, events, timeline, send, done, finished: () => finished, actionCards, approveOf, sent, sendClicks, voids, taskDone, input };
}
type Run = ReturnType<typeof start>;

/** Nothing reached the driver between the entry at `from` and the first control line after it (or the end). */
function performsAfterUntilControl(r: Run, from: number): Action[] {
  const out: Action[] = [];
  for (const x of r.timeline.slice(from + 1)) { if ("control" in x) break; if ("perform" in x) out.push(x.perform); }
  return out;
}
const indexOfEvent = (r: Run, pred: (e: AppEvent) => boolean) => r.timeline.findIndex((x) => "event" in x && pred(x.event));

describe("H1: an expired action card — nobody answers for the user", () => {
  it("answered before the deadline: used as always; no void, no timer left behind", async () => {
    const clock = new FakeClock();
    const r = start({ clock });
    await waitFor(() => r.actionCards().length === 1);
    expect(clock.pending).toBe(1);                       // the card's deadline runs while it is open
    clock.advance(CARD_EXPIRY_MS - 1);
    await sleep(10);
    expect(r.voids()).toEqual([]);
    const card = r.actionCards()[0]!;
    r.send({ type: "answer", ask_id: card.ask_id, option: r.approveOf(card) });
    await r.done;
    expect(r.taskDone()).toMatchObject({ status: "succeeded" });
    expect(r.sent()).toBe(1);
    expect(clock.pending).toBe(0);                       // the card's deadline went with the card
  });

  it("the deadline passes: the card is voided (timeout), the task waits in place acting on nothing, and holds there however long", async () => {
    const clock = new FakeClock();
    const r = start({ clock });
    await waitFor(() => r.actionCards().length === 1);
    const card = r.actionCards()[0]!;
    clock.advance(CARD_EXPIRY_MS);
    await waitFor(() => r.voids("timeout").length === 1);
    expect(r.voids("timeout")[0]!.ask_id).toBe(card.ask_id);
    expect(r.events.find((e) => e.kind === "resumed" && e.ask_id === card.ask_id)).toMatchObject({ voided: "timeout" });
    // an hour later: still waiting — no task_done, no new card, nothing performed, nothing sent
    clock.advance(60 * MIN);
    await sleep(50);
    expect(r.finished()).toBe(false);
    expect(r.taskDone()).toBeUndefined();
    expect(r.actionCards()).toHaveLength(1);
    expect(performsAfterUntilControl(r, indexOfEvent(r, (e) => e.kind === "ask_void"))).toEqual([]);
    expect(r.sent()).toBe(0);
    r.send({ type: "stop" });
    await r.done;
  });

  it("an answer after the void is refused with its reason and never used; 「现在回答」 asks a new card, and only that card's yes sends", async () => {
    const clock = new FakeClock();
    const r = start({ clock });
    await waitFor(() => r.actionCards().length === 1);
    const first = r.actionCards()[0]!;
    clock.advance(CARD_EXPIRY_MS);
    await waitFor(() => r.voids("timeout").length === 1);
    // the late yes: refused at once, with the reason, and nothing happens
    r.send({ type: "answer", ask_id: first.ask_id, option: r.approveOf(first) });
    await waitFor(() => r.events.some((e) => e.kind === "refused" && e.what === `answer for ${first.ask_id}`));
    expect((r.events.find((e) => e.kind === "refused" && e.what === `answer for ${first.ask_id}`) as any).why).toContain("expired");
    await sleep(30);
    expect(r.sendClicks()).toBe(0);
    expect(r.sent()).toBe(0);
    // 「现在回答」: the same screen, so the same step on a new card (a new ask_id, its own deadline)
    r.send({ type: "reask" });
    await waitFor(() => r.actionCards().length === 2);
    const second = r.actionCards()[1]!;
    expect(second.ask_id).not.toBe(first.ask_id);
    expect(second.card.consent).toMatchObject({ action: "click", target: "发送", consequence: "external" });
    // the old card's yes again, now that a new card is open: still refused, still nothing sent
    r.send({ type: "answer", ask_id: first.ask_id, option: r.approveOf(first) });
    await waitFor(() => r.events.filter((e) => e.kind === "refused" && e.what === `answer for ${first.ask_id}`).length === 2);
    expect(r.sent()).toBe(0);
    r.send({ type: "answer", ask_id: second.ask_id, option: r.approveOf(second) });
    await r.done;
    expect(r.taskDone()).toMatchObject({ status: "succeeded" });
    expect(r.sent()).toBe(1);
    expect(r.sendClicks()).toBe(1);
  });

  it("reask while a card is open, or twice: only an expired card is asked again; each new card expires on its own", async () => {
    const clock = new FakeClock();
    const r = start({ clock });
    await waitFor(() => r.actionCards().length === 1);
    r.send({ type: "reask" });                            // the card is open: nothing to ask again
    await waitFor(() => r.events.some((e) => e.kind === "refused" && e.what === "reask"));
    expect((r.events.find((e) => e.kind === "refused" && e.what === "reask") as any).why).toBe("no card has expired");
    expect(r.actionCards()).toHaveLength(1);
    clock.advance(CARD_EXPIRY_MS);
    await waitFor(() => r.voids("timeout").length === 1);
    r.send({ type: "reask" });
    await waitFor(() => r.actionCards().length === 2);
    r.send({ type: "reask" });                            // the second card is open: refused, no third
    await waitFor(() => r.events.filter((e) => e.kind === "refused" && e.what === "reask").length === 2);
    expect(r.actionCards()).toHaveLength(2);
    clock.advance(CARD_EXPIRY_MS);
    await waitFor(() => r.voids("timeout").length === 2);
    r.send({ type: "reask" });
    await waitFor(() => r.actionCards().length === 3);
    expect(new Set(r.actionCards().map((a) => a.ask_id)).size).toBe(3);
    expect(r.sendClicks()).toBe(0);
    const third = r.actionCards()[2]!;
    r.send({ type: "answer", ask_id: third.ask_id, option: r.approveOf(third) });
    await r.done;
    expect(r.sent()).toBe(1);
  });

  it("the screen moved while the card was expired: 「现在回答」 sends the step back to be decided on a fresh look (no yes carried over), then asks anew", async () => {
    const clock = new FakeClock();
    const r = start({ clock, sendTries: 2 });
    await waitFor(() => r.actionCards().length === 1);
    clock.advance(CARD_EXPIRY_MS);
    await waitFor(() => r.voids("timeout").length === 1);
    r.sim.relayout(r.w);                                 // someone used the Mac meanwhile
    r.send({ type: "reask" });
    // the step comes back stale (nothing done), the runtime looks again and tries again: a new card on the new screen
    await waitFor(() => r.actionCards().length === 2);
    expect(r.events.some((e) => e.kind === "step_result" && e.status === "stale")).toBe(true);
    expect(r.sendClicks()).toBe(0);
    const second = r.actionCards()[1]!;
    r.send({ type: "answer", ask_id: second.ask_id, option: r.approveOf(second) });
    await r.done;
    expect(r.sent()).toBe(1);
  });

  it("expired, then a steer: the step is not done; the runtime hears the new words — no reask needed", async () => {
    const clock = new FakeClock();
    const r = start({ clock });
    await waitFor(() => r.actionCards().length === 1);
    clock.advance(CARD_EXPIRY_MS);
    await waitFor(() => r.voids("timeout").length === 1);
    r.send({ type: "steer", text: "先别发了" });
    await r.done;
    expect(r.events.some((e) => e.kind === "steered" && e.text === "先别发了")).toBe(true);
    expect(r.sendClicks()).toBe(0);
    expect(r.sent()).toBe(0);
    expect(r.actionCards()).toHaveLength(1);
  });

  it("expired, then stopped (or the app goes away): the task ends stopped, nothing sent, no new card", async () => {
    for (const how of ["stop", "gone"] as const) {
      const clock = new FakeClock();
      const r = start({ clock });
      await waitFor(() => r.actionCards().length === 1);
      clock.advance(CARD_EXPIRY_MS);
      await waitFor(() => r.voids("timeout").length === 1);
      if (how === "stop") r.send({ type: "stop" }); else r.input.end();
      await r.done;
      expect(r.taskDone()!.status, how).toBe("stopped");
      expect(r.sendClicks()).toBe(0);
      expect(r.actionCards()).toHaveLength(1);
      expect(r.voids()).toHaveLength(1);                  // the expired card is not voided twice
    }
  });

  it("a Mac that slept past the deadline expires the card at once on waking (the wall clock, not the stopped timers)", async () => {
    const clock = new FakeClock();
    const r = start({ clock });
    await waitFor(() => r.actionCards().length === 1);
    clock.advance(5 * MIN);                              // 5 minutes awake
    clock.sleep(60 * MIN);                               // the lid closed for an hour: no timer fired
    await sleep(20);
    expect(r.voids()).toEqual([]);
    clock.advance(1000);                                 // the first tick after waking
    await waitFor(() => r.voids("timeout").length === 1);
    // and short of the deadline, a sleep expires nothing
    const clock2 = new FakeClock();
    const r2 = start({ clock: clock2 });
    await waitFor(() => r2.actionCards().length === 1);
    clock2.advance(2 * MIN); clock2.sleep(7 * MIN); clock2.advance(1000);
    await sleep(20);
    expect(r2.voids()).toEqual([]);
    for (const x of [r, r2]) { x.send({ type: "stop" }); await x.done; }
  });

  it("only action cards expire: a question and a plan card wait however long; the send's card in the same task expires", async () => {
    const clock = new FakeClock();
    // the runtime asks a question (a missing-information card), plans (the plan card), then sends (an action card);
    // the app leaves each unanswered for 11 hours awake and a day asleep before answering
    const r = start({ clock, holdPlan: true, steps: (w) => [{ calls: [{ name: "ask_user", args: { question: "回复里要不要加上时间？", options: ["不加", "加上"] } }] }, ...mailSteps(w)] });
    const asks = () => r.events.filter((e): e is Extract<AppEvent, { kind: "ask" }> => e.kind === "ask");
    for (const kind of ["missing", "plan"]) {
      await waitFor(() => asks().at(-1)?.card.kind === kind);
      expect(clock.pending, kind).toBe(0);               // no deadline was set for it
      clock.advance(11 * 60 * MIN); clock.sleep(24 * 60 * MIN); clock.advance(1000);
      await sleep(20);
      expect(r.voids(), kind).toEqual([]);
      const a = asks().at(-1)!;
      r.send({ type: "answer", ask_id: a.ask_id, option: kind === "plan" ? r.approveOf(a) : 0 });
    }
    await waitFor(() => r.actionCards().length === 1);
    expect(clock.pending).toBe(1);
    clock.advance(CARD_EXPIRY_MS);
    await waitFor(() => r.voids("timeout").length === 1);
    expect(r.voids().map((v) => v.ask_id)).toEqual([r.actionCards()[0]!.ask_id]);
    r.send({ type: "stop" });
    await r.done;
  });

  it("an answer read at the very moment the card expires is refused, never used", async () => {
    const input = new PassThrough();
    const sent: AppEvent[] = [];
    const reader = new LineReader(input);
    const u = new StdioUser(new EventLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "expiry-")), "e.jsonl"), "r1", (e) => sent.push(e)), reader);
    const card: Card = { kind: "action", text: "点「发送」", free_text: false, blocking: true, options: [{ kind: "approve", text: "可以" }, { kind: "cancel", text: "先别做了" }] };
    const ctl = new AbortController();
    const p = u.ask(card, { signal: ctl.signal });
    await sleep(5);
    const ask = sent.find((e) => e.kind === "ask") as Extract<AppEvent, { kind: "ask" }>;
    // the reader hands the line to the waiting card, and the deadline fires before the card has read it
    const waiting = (reader as unknown as { waiting: ((l: string) => void)[] }).waiting;
    waiting[0]!(JSON.stringify({ type: "answer", ask_id: ask.ask_id, option: 0 }));
    ctl.abort("timeout");
    expect(await p).toBeNull();
    expect(sent.some((e) => e.kind === "resumed" && e.ask_id === ask.ask_id && !e.voided)).toBe(false);
    expect(sent.filter((e) => e.kind === "ask_void")).toEqual([expect.objectContaining({ ask_id: ask.ask_id, why: "timeout" })]);
    expect(sent.find((e) => e.kind === "refused")).toMatchObject({ what: `answer for ${ask.ask_id}`, by: "executor" });
  });

  it("reask is a control line of its own; a reader that does not know it ignores it", () => {
    expect(parseControl(JSON.stringify({ type: "reask" }))).toEqual({ type: "reask" });
    expect(parseControl(JSON.stringify({ type: "reask", run_id: "r" }))).toEqual({ type: "reask" });
  });
});

describe("H1 property: random interleavings of the user, the clock and the screen", () => {
  /** A small seeded generator (mulberry32): the same seed, the same schedule. */
  const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  type Move = "wait_9" | "wait_10" | "sleep_60" | "answer_open" | "answer_old" | "reask" | "relayout" | "stop" | "decline_open";

  it("never a send without a yes to a live card; nothing performed between an expiry and the user's next word; every late answer refused", async () => {
    const seeds = Array.from({ length: 32 }, (_, i) => 1000 + i);
    for (const seed of seeds) {
      const rand = rng(seed);
      const clock = new FakeClock();
      const r = start({ clock, sendTries: 6 });
      const moves: Move[] = ["wait_9", "wait_10", "sleep_60", "answer_open", "answer_old", "reask", "relayout", "stop", "decline_open"];
      const done: Move[] = [];
      /** The app's own view (from the events it got): which cards are open, and which it saw let go. */
      const openCard = () => { const a = r.actionCards().at(-1); return a && !r.events.some((e) => (e.kind === "ask_void" || e.kind === "resumed") && e.ask_id === a.ask_id) ? a : null; };
      const yesSentTo: string[] = [];
      /** When the app first saw each action card (fake wall time: the clock moves only in the moves below), and the
       *  cards that were open when the wall clock passed their deadline: each must end voided by the timeout */
      const seen = new Map<string, number>();
      const mustExpire: { id: string; at: number }[] = [];
      for (let i = 0; i < 14 && !r.finished(); i++) {
        await waitFor(() => r.finished() || r.actionCards().length > 0, 3000);
        if (r.finished()) break;
        for (const a of r.actionCards()) if (!seen.has(a.ask_id)) seen.set(a.ask_id, clock.now());
        const m = i === 13 ? "stop" : moves[Math.floor(rand() * moves.length)]!;
        done.push(m);
        const open = openCard();
        const old = r.voids().at(-1);
        const due = () => { if (open && clock.now() >= seen.get(open.ask_id)! + CARD_EXPIRY_MS) mustExpire.push({ id: open.ask_id, at: r.timeline.length }); };
        if (m === "wait_9") { clock.advance(9 * MIN); due(); }
        else if (m === "wait_10") { clock.advance(CARD_EXPIRY_MS); due(); }
        else if (m === "sleep_60") { clock.sleep(60 * MIN); clock.advance(1000); due(); }
        else if (m === "answer_open" && open) { yesSentTo.push(open.ask_id); r.send({ type: "answer", ask_id: open.ask_id, option: r.approveOf(open) }); }
        else if (m === "decline_open" && open) r.send({ type: "answer", ask_id: open.ask_id, option: open.card.options.findIndex((x) => x.kind === "skip_step") });
        else if (m === "answer_old" && old) { yesSentTo.push(old.ask_id); r.send({ type: "answer", ask_id: old.ask_id, option: 0 }); }
        else if (m === "reask") r.send({ type: "reask" });
        else if (m === "relayout") r.sim.relayout(r.w);
        else if (m === "stop") r.send({ type: "stop" });
        await sleep(15);
      }
      if (!r.finished()) { r.send({ type: "stop" }); }
      await r.done;
      const ctx = `seed ${seed}: ${done.join(",")}`;
      // 1. the send went out only on a yes the app gave to a card that was not let go before that yes arrived
      const voidedBefore = (id: string, at: number) => r.timeline.slice(0, at).some((x) => "event" in x && x.event.kind === "ask_void" && x.event.ask_id === id);
      const liveYes = r.timeline.flatMap((x, i) => ("control" in x && x.control.type === "answer" && x.control.option === 0 && !voidedBefore(String(x.control.ask_id), i) ? [String(x.control.ask_id)] : []));
      expect(r.sendClicks(), ctx).toBeLessThanOrEqual(liveYes.length);
      expect(r.sent(), ctx).toBeLessThanOrEqual(r.sendClicks());
      // 2. after every expiry, the driver gets nothing until the app's next line (reask, steer, stop, answer)
      r.timeline.forEach((x, i) => { if ("event" in x && x.event.kind === "ask_void" && x.event.why === "timeout") expect(performsAfterUntilControl(r, i), ctx).toEqual([]); });
      // 3. a yes to a card already let go is refused, by name, and no resumed ever answers it
      r.timeline.forEach((x, i) => {
        if (!("control" in x) || x.control.type !== "answer" || !voidedBefore(String(x.control.ask_id), i)) return;
        const id = String(x.control.ask_id);
        expect(r.events.some((e) => e.kind === "refused" && e.what === `answer for ${id}`), ctx).toBe(true);
      });
      for (const e of r.events) if (e.kind === "resumed" && e.ask_id && !e.voided) expect(voidedBefore(e.ask_id, r.timeline.findIndex((x) => "event" in x && x.event === e)), ctx).toBe(false);
      // 4. nobody's silence is an answer, and no card outlives its deadline: one open when the wall clock passed it was
      //    voided by the timeout (unless its answer had already been taken before that move)
      for (const x of mustExpire) {
        const answered = r.timeline.slice(0, x.at).some((y) => "event" in y && y.event.kind === "resumed" && y.event.ask_id === x.id && !y.event.voided);
        if (!answered) expect(r.voids("timeout").map((v) => v.ask_id), ctx).toContain(x.id);
      }
      // 5. a voided card is voided once, and every ask_id is new
      const ids = r.voids().map((v) => v.ask_id);
      expect(new Set(ids).size, ctx).toBe(ids.length);
      expect(new Set(r.actionCards().map((a) => a.ask_id)).size, ctx).toBe(r.actionCards().length);
      expect(clock.pending, ctx).toBe(0);
    }
  }, 60_000);
});

// --- through the session ---------------------------------------------------------------------------------------------

const hosts: SessionHost[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) h.end(); await sleep(50); });

describe("H1 through the session: the task keeps the computer while its card is expired", () => {
  it("reask goes to the running task; typing is open again (no card), the Mac stays held, and reask after the end is refused", async () => {
    const clock = new FakeClock();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expiry-ses-"));
    const sims: { sim: SimComputer; w: string }[] = [];
    const launch: Launcher = (req, o) => {
      const m = mailSim(); sims.push(m);
      const input = new PassThrough();
      let ended = false, cb: ((l: string) => void) | null = null;
      const early: string[] = [];
      const out = (e: unknown) => { const l = JSON.stringify(e); if (cb) cb(l); else early.push(l); };
      const exited = appRun(req as never, { runs: o.runs, out, input: new LineReader(input), linger: o.linger,
        inject: { driver: m.sim, gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream(mailSteps(m.w)) }, clock } }).then(() => ({ code: 0, signal: null }));
      const h: ExecutorHandle = { write: (l) => { if (!ended) input.write(l + "\n"); }, close: () => { if (!ended) { ended = true; input.end(); } }, onLine: (f) => { cb = f; for (const l of early.splice(0)) f(l); }, exited };
      return h;
    };
    const evs: any[] = [];
    const h = new SessionHost({ dir, sessionId: "ses_x", out: (e) => {
      evs.push(e);
      if (e.kind === "ask" && (e as any).card.kind === "plan") setTimeout(() => h.handle(JSON.stringify({ type: "answer", run_id: e.run_id, ask_id: e.ask_id, option: 0 })), 1);
    }, coalesceMs: 5, model: { model: MODEL, streamFn: scriptedStream([{ text: "好" }]) }, launch, linger: 0 });
    hosts.push(h);
    h.start();
    const send = (c: Record<string, unknown>) => h.handle(JSON.stringify(c));
    send({ type: "cua", text: "回复林晓：收到，谢谢" });
    const asks = () => evs.filter((e) => e.kind === "ask" && e.card.kind === "action");
    await waitFor(() => asks().length === 1);
    const runId = asks()[0].run_id as string;
    clock.advance(CARD_EXPIRY_MS);
    await waitFor(() => evs.some((e) => e.kind === "ask_void" && e.why === "timeout"));
    // the Mac is still this task's (acting), and nothing was sent
    expect(readHolder(dir)).toMatchObject({ run_id: runId, state: "acting" });
    expect(sims[0]!.sim.mailState(sims[0]!.w).replies).toEqual([]);
    // no card is open now: the user's words are not refused card_open (a steer would go to the task)
    send({ type: "reask", run_id: runId });
    await waitFor(() => asks().length === 2);
    expect(evs.filter((e) => e.kind === "session.error")).toEqual([]);
    const second = asks()[1];
    send({ type: "answer", run_id: runId, ask_id: asks()[0].ask_id, option: 0 });            // the expired card's yes
    await waitFor(() => evs.some((e) => e.kind === "refused" && e.what === `answer for ${asks()[0].ask_id}`));
    expect(sims[0]!.sim.mailState(sims[0]!.w).replies).toEqual([]);
    send({ type: "answer", run_id: runId, ask_id: second.ask_id, option: 0 });
    await waitFor(() => evs.some((e) => e.kind === "session.task_end"));
    expect(sims[0]!.sim.mailState(sims[0]!.w).replies).toHaveLength(1);
    send({ type: "reask", run_id: runId });
    await waitFor(() => evs.some((e) => e.kind === "session.error" && e.control === "reask"));
    expect(evs.find((e) => e.kind === "session.error" && e.control === "reask")).toMatchObject({ code: "no_task" });
  });

  it("while a card is expired, a steer is taken (no card_open) and decides the step", async () => {
    const clock = new FakeClock();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "expiry-ses-"));
    let sim!: ReturnType<typeof mailSim>;
    const launch: Launcher = (req, o) => {
      sim = mailSim();
      const input = new PassThrough();
      let ended = false, cb: ((l: string) => void) | null = null;
      const early: string[] = [];
      const out = (e: unknown) => { const l = JSON.stringify(e); if (cb) cb(l); else early.push(l); };
      const exited = appRun(req as never, { runs: o.runs, out, input: new LineReader(input), linger: o.linger,
        inject: { driver: sim.sim, gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream(mailSteps(sim.w)) }, clock } }).then(() => ({ code: 0, signal: null }));
      return { write: (l) => { if (!ended) input.write(l + "\n"); }, close: () => { if (!ended) { ended = true; input.end(); } }, onLine: (f) => { cb = f; for (const l of early.splice(0)) f(l); }, exited };
    };
    const evs: any[] = [];
    const h = new SessionHost({ dir, sessionId: "ses_y", out: (e) => {
      evs.push(e);
      if (e.kind === "ask" && (e as any).card.kind === "plan") setTimeout(() => h.handle(JSON.stringify({ type: "answer", run_id: e.run_id, ask_id: e.ask_id, option: 0 })), 1);
    }, coalesceMs: 5, model: { model: MODEL, streamFn: scriptedStream([{ text: "好" }]) }, launch, linger: 0 });
    hosts.push(h);
    h.start();
    h.handle(JSON.stringify({ type: "cua", text: "回复林晓：收到，谢谢" }));
    await waitFor(() => evs.some((e) => e.kind === "ask" && e.card.kind === "action"));
    // while it is open, a steer is refused (card_open); once expired, it is taken
    h.handle(JSON.stringify({ type: "steer", text: "先别发了" }));
    expect(evs.filter((e) => e.kind === "session.error").at(-1)).toMatchObject({ code: "card_open" });
    clock.advance(CARD_EXPIRY_MS);
    await waitFor(() => evs.some((e) => e.kind === "ask_void" && e.why === "timeout"));
    h.handle(JSON.stringify({ type: "steer", text: "先别发了" }));
    await waitFor(() => evs.some((e) => e.kind === "session.task_end"));
    expect(evs.some((e) => e.kind === "session.steer" && e.text === "先别发了")).toBe(true);
    expect(sim.sim.mailState(sim.w).replies).toEqual([]);
  });
});
