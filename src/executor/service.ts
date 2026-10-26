/**
 * The executor's service to a runtime (executor split P1, deskmind#90 item 6): it implements `ExecutorPort`
 * (protocol/port.ts) over the Executor and owns every responsibility that keeps the user safe, so the runtime above it
 * is a plain caller (our agent loop today; Codex or any MCP client once P2 moves the runtime into a child process):
 *
 *   - the signing key: consent is signed here (the app's key in production), never by the caller;
 *   - cards: the start gate's ambiguity cards, the plan card, action consent (act-and-wait: the card is asked, the
 *     answer waited for, the yes signed and the action retried, all inside one `act`), questions (ask_user) and the
 *     answers as the user's words for every judgement, the result card and undo;
 *   - skills: which tutorials may apply, and the ones read (the judges read them too);
 *   - verification: "done" is only a claim; the task's status is "succeeded" only on a passing verdict;
 *   - steer: the user's change of request mid-run, applied between steps only. The judges see the request as it was
 *     and every change; an open card is voided and the step comes back undone, so it is asked again on the new words;
 *     a step on an object or a site beyond the plan the user accepted asks for a new plan (and plan card).
 *
 * Moved from runtime/loop.ts with its behaviour (the card texts, the counters and the events are the same).
 */
import * as R from "../protocol/roles.js";
import * as P from "../orchestrator/prompts.js";
import type { Gateway } from "../gateway/index.js";
import type { Answer, Beyond, Card, CardAsker, CardOption, PlanCardFacts } from "../protocol/cards.js";
import { canon, siteOf, type ConsentProvider } from "../protocol/consent.js";
import type { Begun, Classified, ExecutorPort, FileTool, FinishOutcome, PlanStepIn, TaskResult, TaskStatus, ToolReply } from "../protocol/port.js";
import { Crash, type Capability, type Registry } from "../registry/capability.js";
import type { Workspace } from "../registry/workspace.js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Executor, appName, cardText, describeAction, elementName, stepText, windowLabel } from "./executor.js";
import { current, within } from "../otel/context.js";
import { span } from "../otel/trace.js";
import { defaultJudge } from "./judge.js";
import { stepLines } from "./possibly.js";
import { T, type Lang } from "./text.js";
import { NEEDS_CONSENT, higher, rank, type Action, type ActResult, type Challenge, type Consequence, type ConsentToken, type Reading, type Snapshot } from "./types.js";
import type { StopCause } from "../protocol/computer.js";
import { WALL_CLOCK, atWallTime, type Clock } from "./clock.js";

/** The tutorials a task may read: candidates by structure (never the request's words), and one read in full. */
export interface SkillSource { candidates(raw: string): { name: string; description: string }[]; read(name: string): string | null }

/** The executor's share of a task's budget: questions and cards declined (asks), and verdicts that did not pass
 *  before the run ends unconfirmed (verify_retries). */
export const SERVICE_BUDGET = { asks: 3, verify_retries: 2 };

export interface ServiceOptions {
  task: string; raw: string;
  executor: Executor;
  /** What signs consent: the app (keychain) in production, a ConsentSigner in tests and the CLI. Held here only. */
  signer: ConsentProvider;
  /** Who answers the cards (the app, the simulated user, a test). */
  user: CardAsker;
  gateway: Gateway;
  workspace?: Workspace; registry?: Registry; skills?: SkillSource;
  budget?: Partial<typeof SERVICE_BUDGET>;
  onEvent?: (kind: string, body: Record<string, unknown>) => void;
  /** The language of what the user reads on cards (default zh). */
  lang?: Lang;
  /** The user's standing rules (rule-tier consent tokens the app signed), handed to the executor at begin. */
  rules?: ConsentToken[];
  /** How long a card asking consent for one action stays open, by the wall clock (ms; the app's run: CARD_EXPIRY_MS).
   *  Absent: it waits for its answer however long (the evaluation's simulated user, tests). */
  cardExpiryMs?: number;
  /** The clock the expiry reads (tests: a fake one). Default: the wall clock and the process's timers. */
  clock?: Clock;
}

/** An action card left unanswered this long, by the wall clock (executor/clock.ts), is voided (owner 10-24, M2 H1):
 *  the screen may have moved since it was shown, and a yes has to be to what is there now. */
export const CARD_EXPIRY_MS = 10 * 60_000;

const LOOK_ONLY = "the task is done as far as actions go; only look for evidence (computer_snapshot, computer_observe, reading files), or finish unconfirmed";
const J = (x: unknown) => JSON.stringify(x);
const text = (s: string): ToolReply => ({ text: s });
const err = (s: string): ToolReply => ({ text: s, isError: true });

/** An action the schema allows but the kind does not: said to the caller, never sent to the executor (a window-less
 *  click used to reach the guard as "window:undefined" and cost the user a card). */
export function checkAction(a: Action): string | null {
  const need = (k: string) => (k in a && (a as Record<string, unknown>)[k] !== undefined && (a as Record<string, unknown>)[k] !== "" ? null : `${a.kind} 需要 ${k}`);
  switch (a.kind) {
    case "wait": return need("ms");
    case "open_window": return need("app");
    case "close_window": case "focus_window": return need("window");
    case "scroll": return need("window") ?? need("dy");
    case "key": return need("window") ?? need("chord");
    case "click": case "double_click": return need("window") ?? need("target");
    case "set_value": return need("window") ?? need("target") ?? need("value");
    case "type": return need("window") ?? need("target") ?? need("text");
    case "select": return need("window") ?? need("target") ?? need("option");
    case "file": return need("capability") ?? need("args");
    default: return `unknown action kind ${(a as { kind?: unknown }).kind}`;
  }
}

const withoutFrame = <W extends { frame?: unknown }>(w: W): Omit<W, "frame"> => { const { frame: _f, ...rest } = w; return rest; };

export { placeOf } from "./place.js";
import { placeOf } from "./place.js";

/** A card's outcome: the option picked (or the user's own words), nothing (no answer: stopped, the app went away), or
 *  voided (the user changed the request while it was open). An action card can also have expired (`Expiring`). */
type Got = { option: CardOption | null; text: string } | null | "voided";
type Expiring = Got | "expired";

export class ExecutorService {
  readonly counters: Record<string, number> = {};
  readonly consents: TaskResult["consents"] = [];
  readonly effects: string[] = [];
  readonly verdicts: TaskResult["verdicts"] = [];
  /** The port the runtime gets: the port's methods and nothing else (no signer, no executor behind it to reach). */
  readonly port: ExecutorPort;
  readonly #signer: ConsentProvider;
  readonly #user: CardAsker;
  private tokens = new Map<string, ConsentToken>();       // object → consent from an approved plan
  /** Consents to open pages of some sites in a window (open_window with an http(s) URL): the plan's sites there
   *  (modify_user, with the content the card approved), and each host the user approved on a card after the task read
   *  material (external) */
  private siteTokens: ConsentToken[] = [];
  /** After a verdict that only the evidence is missing: the caller may look, not act (finish's lookOnly). */
  private lookOnly = false;
  /** The user's yes to one action, kept when the executor then found the screen changed (stale) and the caller retries
   *  the same action: the executor still holds the token to what the user saw, so it is not asked again for nothing. */
  private retryTokens = new Map<string, ConsentToken>();
  private status: TaskStatus | null = null;
  private reason = "";
  /** Why the task stopped, in structure: set with status and reason by the branch that knows it, never parsed from them. */
  private cause: StopCause | undefined;
  private summary = "";
  private answerText: string | null = null;
  /** What the user answered to the caller's questions: evidence for the verdict, like their words. */
  private answers: { question: string; text: string }[] = [];
  private lastSig = "";
  private repeats = 0;
  private readonly budget: typeof SERVICE_BUDGET;
  /** The app's stop: an open card is let go, a look in progress is not waited for. */
  private readonly stopped = new AbortController();
  private crash: Crash | null = null;
  private executorEnded = false;
  /** Steers that arrived and are not applied yet (they are, between steps), and the open card a steer voids. */
  private pending: string[] = [];
  private openCard: AbortController | null = null;
  /** The open card is one a steer does not void (reconcile, H5). */
  private openCardHolds = false;
  /** The request changed since the user accepted a plan: a step beyond that plan asks for a new one. */
  private steeredSincePlan = false;
  /** A reply carried a steer: every further step the caller decided before hearing it (the rest of the model's turn)
   *  comes back undone too, until the caller asks for steers again (`steers`, between turns). */
  private reDecide = false;
  /** An action card expired: the task waits in place for the user — 「现在回答」 (reask), a steer, or a stop. */
  private expiredWait: ((how: "reask" | "steer" | null) => void) | null = null;
  /** The open action card's expiry check (true: it is past its deadline, and is expired by asking), while one is open. */
  private expireOpen: (() => boolean) | null = null;
  /** A reask that came for a card past its deadline the tick had not expired yet: taken as soon as it has. */
  private reaskWaiting = false;
  private readonly t: ReturnType<typeof T>;

  /** The options, without the signer and the card asker: those are private fields, out of reach of anything that
   *  holds this object. */
  readonly o: Omit<ServiceOptions, "signer" | "user">;

  constructor(options: ServiceOptions) {
    const { signer, user, ...o } = options;
    this.o = o;
    this.#signer = signer;
    this.#user = user;
    this.t = T(o.lang);
    o.executor.opts.lang = o.lang ?? "zh";
    if (o.workspace && o.registry && !o.executor.opts.files) o.executor.attachFiles(o.workspace, o.registry);
    o.executor.setRequest(o.raw);
    if (!o.executor.opts.judge) o.executor.opts.judge = defaultJudge(o.gateway, (k, b) => this.emit(k, b));
    this.budget = { ...SERVICE_BUDGET, ...(o.budget ?? {}) };
    // once the task's status is settled (a verdict passed, the user cancelled, a stop) or the executor has ended, nothing
    // more is done: a step after the verdict would land unverified, one after a cancel unconsented
    const live = <A extends unknown[]>(f: (...a: A) => Promise<ToolReply>) => (...a: A): Promise<ToolReply> => (this.settled() ?? f(...a));
    const port: ExecutorPort = {
      begin: () => (this.begun ? Promise.reject(new Error("begin was already called for this task")) : this.begin()),
      // where a window is on screen is the app's (its cursor), not the caller's
      snapshot: () => this.o.executor.snapshot(), observe: async (w) => { const { screenshot_png: _px, ...o } = await this.o.executor.observe(w); return { ...o, window: withoutFrame(o.window) }; },
      // (as live: once the task is settled — a stop among them — no judge is asked for it; the caller is told so)
      classify: async (p): Promise<Classified> => { const s = this.settled(); if (s) throw new Error((await s).text); const ex = this.o.executor; const c = await ex.classify(p.action, p.epoch ?? ex.currentEpoch, p.consequence); return { consequence: c.consequence, object: c.object, why: c.why, by: c.by, needs_consent: NEEDS_CONSENT.has(c.consequence) }; },
      // a file action goes through `file`, which makes what a capability derives (a rewrite) itself
      act: live((p) => ((p.action as { kind?: string }).kind === "file" ? Promise.resolve(err("文件动作用 file 工具，不用 act")) : this.step(p.action, p, () => this.act(p)))),
      file: live((p) => this.step({ kind: "file", capability: p.capability, args: p.args }, { purpose: this.o.registry?.get(p.capability)?.description.split("；")[0] ?? p.capability }, () => this.file(p))),
      plan: live((p) => this.plan(p.steps, p.readings ?? [])),
      askUser: live((p) => this.askUser(p)), answer: live((p) => this.answer(p)), readSkill: (p) => this.readSkill(p), finish: live((p) => this.finish(p)),
      steers: async () => { this.reDecide = false; return this.applySteers(); }, end: (p) => this.end(p),
    };
    this.port = Object.freeze(port);
  }

  /** The reply to any step once the task is over: refused, and over. */
  private settled(): Promise<ToolReply> | null {
    if (!this.status && !this.executorEnded) return null;
    this.count("refused_after_end");
    return Promise.resolve({ text: `任务已经结束（${this.status ?? "ended"}）：不再做任何事`, isError: true, done: true });
  }
  private begun = false;

  private count(k: string, by = 1) { this.counters[k] = (this.counters[k] ?? 0) + by; }
  private emit(kind: string, b: Record<string, unknown> = {}) { this.o.onEvent?.(kind, b); }

  // --- control: the app's stop and steer -----------------------------------------------------------------------------

  /** The app's stop: the executor refuses every later action, an open card is left unanswered, the task ends stopped.
   *  `as`: the status when the stop is not the user's (the runtime process died: "failed"); `cause`: the stop's cause when
   *  the caller knows it (the app's stop: user_stopped). */
  stop(why = "stopped", as: TaskStatus = "stopped", cause?: StopCause) { this.o.executor.stop(); if (!this.status) { this.status = as; this.reason = why; this.cause = cause; } this.stopped.abort(); this.openCard?.abort("ended"); this.expiredWait?.(null); }

  /** 「现在回答」 on an expired action card (the protocol's reask): the step it belonged to is tried again on the screen
   *  as it is now — the same screen asks again on a new card, a moved one sends the caller back to look. Nothing to
   *  reask (no card expired, or the task is over): said, nothing else happens. */
  reask() {
    // the card is past its deadline but the tick has not run (the second after waking): it expires now, and this reask
    // is the user's answer to that
    if (!this.expiredWait && this.expireOpen?.()) { this.reaskWaiting = true; this.count("reasks"); this.emit("card.reask", { expired_now: true }); return; }
    if (!this.expiredWait) { this.emit("reask.refused", { why: this.status || this.executorEnded ? "the task already finished" : "no card has expired" }); return; }
    this.count("reasks");
    this.emit("card.reask", {});
    this.expiredWait("reask");
  }

  /** The user changed what they want mid-run (the protocol's steer). Nothing changes mid-step: the words wait until the
   *  step in progress is over (`applySteers`). A card open now is voided at once — its answer was for the old words —
   *  and the step it belonged to comes back undone. */
  steer(raw: string) {
    // the task is over (a verdict passed, a cancel, a stop, the run ended): the words change nothing, and the app is told
    if (this.status || this.executorEnded) { this.emit("steer.refused", { raw, why: "the task already finished" }); return; }
    // the card about an interrupted step is answered first: words are not taken while it is open (H5)
    if (this.openCardHolds) { this.emit("steer.refused", { raw, why: "card_open: answer the card about the interrupted step first" }); return; }
    this.pending.push(raw);
    this.count("steers");
    this.emit("steer", { raw });
    this.openCard?.abort();
    this.expiredWait?.("steer");
  }

  /** Between steps: the pending steers become the request (the judges then read the new words beside the earlier ones);
   *  returns their words, for the caller to hear. */
  private applySteers(): string[] {
    const xs = this.pending.splice(0);
    for (const r of xs) {
      this.o.executor.setRequest(r);
      if (this.o.executor.hasPlan) this.steeredSincePlan = true;
      this.emit("steer.applied", { raw: r });
    }
    if (xs.length) {
      // what held for the old words does not carry over. The plan's consents (its objects, its sites and what the card
      // said goes there) were given for the old request: the user may have just said 「别动这个窗口了」, so they are
      // void, and a step that needs consent asks again — a new plan card first. Hosts the user approved on a card of
      // their own (a per-action site yes, external) stay. Also: a yes to one action the screen then moved under, "only
      // look for evidence" after a verdict, the no-progress count
      if (this.tokens.size || this.siteTokens.some((t) => t.consequence !== "external")) this.emit("plan.void", { objects: [...this.tokens.keys()], sites: this.siteTokens.filter((t) => t.consequence !== "external").map((t) => t.object) });
      this.tokens.clear();
      this.siteTokens = this.siteTokens.filter((t) => t.consequence === "external");
      this.o.executor.forgetPlanSites();
      this.retryTokens.clear();
      this.lookOnly = false;
      this.repeats = 0; this.lastSig = "";
    }
    return xs;
  }

  /** A step asked for while a steer is pending is not done: the reply carries the new words instead. */
  private steered(): ToolReply | null {
    const xs = this.applySteers();
    if (!xs.length) return this.reDecide ? err("用户改了要求（见前面的结果）：这一步是在那之前决定的，没有做。按新要求重新决定。") : null;
    this.reDecide = true;
    return { ...err(`用户改了要求，以这句为准（之前做过的不会消失，按新要求接着做或撤回）：${xs.join("；然后又说：")}\n你刚才要的这一步没有做：按新要求重新决定。`), steers: xs };
  }

  /** What `f` gives, unless the app stops the task first: then null at once, without waiting for it (a driver's look
   *  that may take minutes). `f` is not started at all once stopped. */
  private untilStopped<X>(f: () => Promise<X>): Promise<X | null> {
    const stop = this.stopped.signal;
    if (stop.aborted) return Promise.resolve(null);
    const p = f();
    // left behind at a stop, it may still fail (the driver's process is killed at the end): nobody waits for it then
    p.catch(() => undefined);
    return Promise.race([p, new Promise<null>((r) => stop.addEventListener("abort", () => r(null), { once: true }))]);
  }

  /** The task's end, all three together: a stop is final (the card it cancelled comes back unanswered, a begin it
   *  interrupted finds the screen locked — neither is the end of its own), and a cause never outlives its status. */
  private settle(status: TaskStatus, reason: string, cause?: StopCause) {
    if (this.status !== "stopped") { this.status = status; this.reason = reason; this.cause = cause; }
  }

  private endWith(status: TaskStatus, reason: string, cause?: StopCause): ToolReply {
    this.settle(status, reason, cause);
    return { text: `结束：${status}（${reason}）`, done: true };
  }

  // --- cards -----------------------------------------------------------------------------------------------------------
  /** A card, waiting for the user (its span: the wait in the call chain, and how it was answered). */
  private askCard(card: Card): Promise<Got> { return this.askCardSpan(card, false) as Promise<Got>; }

  /** A card that may expire: one asking consent for one action (owner 10-24: only those; a plan, a question, a choice
   *  and the reconciliation card wait however long). */
  private askExpiring(card: Card): Promise<Expiring> { return this.askCardSpan(card, true); }

  private askCardSpan(card: Card, expires: boolean): Promise<Expiring> {
    return span("deskmind.ask_user", { "deskmind.card.kind": card.kind, "deskmind.card.blocking": card.blocking }, async (s) => {
      const got = await this.askCardNow(card, expires);
      s?.set({ "deskmind.card.answer": got === "voided" || got === "expired" ? got : !got ? "none" : got.option?.kind ?? "text" });
      return got;
    });
  }

  private async askCardNow(card: Card, expires: boolean): Promise<Expiring> {
    // a steer that came before the card was shown: its answer would be to the old words
    if (this.pending.length) return "voided";
    this.count("cards"); this.count(`cards:${card.kind}`);
    this.emit("card", { kind: card.kind, text: card.text, options: card.options.map((o) => o.kind) });
    const stop = this.stopped.signal;
    if (stop.aborted) return null;
    const open = new AbortController();
    this.openCard = open;
    this.openCardHolds = !!card.reconcile;
    // the deadline, by the wall clock: a Mac that slept past it expires the card within a second of waking (its timers
    // stood still meanwhile). It voids the card like a steer, with the reason "timeout"
    const ms = expires ? this.o.cardExpiryMs : undefined;
    const clock = this.o.clock ?? WALL_CLOCK;
    const deadline = ms !== undefined && ms >= 0 ? clock.now() + ms : null;
    const cancel = deadline !== null ? atWallTime(clock, deadline, () => open.abort("timeout")) : () => {};
    // the tick alone is not enough: the Mac's timers stand still in sleep, and an answer (or a reask) can arrive in the
    // second after waking, before the tick has run (review of #67). Whatever arrives for the card asks this first: past
    // the deadline, the card expires now, and what arrived is not its answer
    // (asked by the asker as an answer arrives, it decides that answer: live, it is taken — not undone by a check a
    // moment later, after the app was told it was answered)
    let askerChecked = false;
    const check = (): boolean => {
      if (deadline !== null && !open.signal.aborted && clock.now() >= deadline) open.abort("timeout");
      return open.signal.aborted && open.signal.reason === "timeout";
    };
    const expired = (): boolean => { const gone = check(); if (!gone) askerChecked = true; return gone; };
    this.expireOpen = check;
    try {
      // the stop does not wait for the card: an open card is left unanswered and the run ends (review of #16); a steer
      // voids it (the asker is told through the signal, and lets the app know). `expired`: the asker asks it before it
      // takes an answer
      // the hold of the card about an interrupted step ends the moment the asker takes its answer — synchronously, so a
      // steer right behind the answer on the same input finds no card holding it (review of #77)
      const p = Promise.resolve(this.#user.ask(card, { signal: open.signal, ...(deadline !== null ? { expired } : {}), taken: () => { if (this.openCard === open) this.openCardHolds = false; } }));
      p.catch(() => undefined);
      const a = await Promise.race([p,
        new Promise<null>((r) => stop.addEventListener("abort", () => r(null), { once: true })),
        new Promise<"voided">((r) => { if (open.signal.aborted) r("voided"); else open.signal.addEventListener("abort", () => r("voided"), { once: true }); })]);
      // (the asker may let go of the card in the same moment as the signal fires, and hand back "nothing" first: the
      // signal decides — a voided card is voided, whichever promise settled first)
      if (a === "voided" || (a === null && open.signal.aborted && !stop.aborted)) {
        const why = open.signal.reason === "timeout" ? "timeout" : "steer";
        this.emit("card.voided", { kind: card.kind, why });
        return why === "timeout" ? "expired" : "voided";
      }
      if (a === null) return null;
      // an asker that does not ask `expired` itself (not the app's): an answer it hands over past the deadline is not used
      if (!askerChecked && expired()) { this.emit("card.voided", { kind: card.kind, why: "timeout", late_answer: true }); return "expired"; }
      if ("option" in a) { const o = card.options[a.option]; return o ? { option: o, text: o.text } : null; }
      return { option: null, text: a.text };
    } finally { cancel(); if (this.openCard === open) { this.openCard = null; this.openCardHolds = false; } if (this.expireOpen === check) this.expireOpen = null; }
  }

  /** After an action card expired: the task stays where it is, acting on nothing, until the user taps 「现在回答」
   *  (reask), changes the request (steer) or stops it (null). The computer stays the task's meanwhile. */
  private afterExpiry(): Promise<"reask" | "steer" | null> {
    const reasked = this.reaskWaiting;
    this.reaskWaiting = false;
    if (this.pending.length) return Promise.resolve("steer");
    if (reasked && !this.stopped.signal.aborted) return Promise.resolve("reask");
    if (this.stopped.signal.aborted) return Promise.resolve(null);
    this.emit("card.expired_wait", {});
    return new Promise((res) => { this.expiredWait = (how) => { this.expiredWait = null; res(how); }; });
  }

  /** The user is asked for this one action; a yes becomes a signed, single-use token. */
  private async consentFor(c: Challenge): Promise<ConsentToken | "declined" | "cancel" | "voided" | "expired" | null> {
    const card: Card = { kind: "action", text: c.text, ...(c.headline ? { headline: c.headline } : {}), ...(c.beyond ? { beyond: c.beyond } : {}), free_text: false, blocking: true, options: [{ kind: "approve", text: this.t.ok }, { kind: "skip_step", text: this.t.skipStep }, { kind: "cancel", text: this.t.cancel }], ...(c.facts ? { consent: c.facts } : {}) };
    const got = await this.askExpiring(card);
    // expired: nothing was answered, nothing is signed; the caller waits for the user
    if (got === "expired") return "expired";
    if (got === "voided") return "voided";
    this.emit("consent.asked", { object: c.object, consequence: c.consequence, picked: got?.option?.kind ?? null });
    if (!got) return null;
    if (got.option?.kind === "approve") {
      // a host asked about after the task read material: the yes is for that site for the rest of the task
      if (c.site && !this.o.executor.uncertainCount) { const t = this.#signer.forSite(c.object, [c.site], this.o.task, c.consequence); this.siteTokens.push(t); this.consents.push({ scope: "site", object: c.object, consequence: c.consequence }); return t; }
      const t = this.#signer.forAction(c); this.consents.push({ scope: "action", object: c.object, consequence: c.consequence }); return t;
    }
    if (got.option?.kind === "cancel") return "cancel";
    this.count("declined");
    return "declined";
  }

  /** A declined card is an answer the caller has to work with; asking for consent over and over is not (the asks
   *  budget bounds it, as it bounds questions). */
  private declined(msg: string): ToolReply {
    if ((this.counters["declined"] ?? 0) >= this.budget.asks) return this.endWith("failed", "the user declined repeatedly");
    return err(msg);
  }

  // --- begin -----------------------------------------------------------------------------------------------------------
  private async begin(): Promise<Begun> {
    this.begun = true;
    const ex = this.o.executor, ws = this.o.workspace;
    const none: Begun = { ended: true, snapshot: null, recovered: null, workspace: null, skills: [], skillsOffered: false, files: [] };
    let snap: Snapshot;
    try { snap = await ex.begin(ws ? Object.keys(ws.entries()) : [], this.o.rules ?? []); }
    catch (e) {
      // the computer could not be read at all (hands missing, no permission): an environment stop, said as such
      this.settle("environment", `cannot read the computer: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
      await this.endExecutor();
      return none;
    }
    // the prompt shows the caller the task folder's files' first lines: content taken in, as much as a read (a URL can
    // carry it out)
    if (ws?.listing().entries.some((e) => e.preview)) ex.noteTakenIn("the task folder's listing with previews", J(ws.listing()));
    this.emit("run.start", { task: this.o.task, raw: this.o.raw, windows: snap.windows.length });
    if (snap.locked) { this.settle("environment", "the screen is locked", "screen_locked"); await this.endExecutor(); return { ...none, snapshot: snap }; }
    // the restart found a step whose effect is unknown on a file changed since: the user settles it before anything else
    // (the executor refuses writes to that file until then, whoever the caller is). Unanswered because the request
    // changed meanwhile, it is asked again when a write reaches that file
    if (ex.reconciliation && !ex.reconciliation.decision) {
      const r = await this.reconcile();
      if (r !== "continue" && r !== "voided") { await this.endExecutor(); return { ...none, snapshot: snap }; }
    }
    const rec = ex.recovered;
    return {
      ended: false, snapshot: snap,
      recovered: rec ? { text: rec.text, finding: rec.finding, external: rec.external, ...(ex.reconciliation?.decision ? { reconciled: ex.reconciliation.decision } : {}) } : null,
      workspace: ws ? { root: ws.root, listing: ws.listing() } : null,
      skills: this.o.skills?.candidates(this.o.raw) ?? [],
      skillsOffered: !!this.o.skills,
      lang: this.o.lang === "en" ? "en" : "zh",
      files: this.fileTools(),
    };
  }

  /** The reconciliation card, from the executor's facts only: the interrupted step, that its effect is unknown, each
   *  file it was writing at that step and now (the lines that differ for a small text file, else the versions). Go on
   *  from what is there now — the user's explicit answer, recorded for every judge — or stop: the run ends cancelled
   *  with reason "needs_reconciliation", nothing written. No answer stops the same way. */
  private async reconcile(): Promise<"continue" | "voided" | ToolReply> {
    const ex = this.o.executor, rc = ex.reconciliation!;
    const t = this.t, q = (x: string) => t.quote(cardText(x.replace(/\s+/g, " ").trim(), 80, this.o.lang));
    const lines = [t.reconcileHead(cardText(rc.step, 160))];
    for (const f of rc.files) {
      lines.push(t.reconcileFile(cardText(f.path, 160)));
      if (f.version_now === "absent") lines.push(`· ${t.reconcileGone}`);
      else if (f.removed && f.added) {
        if (f.removed.length) lines.push(`· ${t.reconcileRemoved(f.removed.slice(0, 5).map(q))}${f.removed.length > 5 ? " …" : ""}`);
        if (f.added.length) lines.push(`· ${t.reconcileAdded(f.added.slice(0, 5).map(q))}${f.added.length > 5 ? " …" : ""}`);
        if (!f.removed.length && !f.added.length) lines.push(`· ${t.reconcileSame}`);
      } else lines.push(`· ${t.reconcileVersions(f.version_at_step.slice(0, 18), f.version_now.slice(0, 18))}`);
    }
    lines.push(t.reconcileAsk);
    // an approval card (kind "action": the app shows Approve / Deny and answers with the approve or the cancel option —
    // a question card's buttons all answer as approve in the app as shipped, deskmind GoalRunView / answerLine)
    const card: Card = { kind: "action", text: lines.join("\n"), headline: lines[0]!, reconcile: true, free_text: false, blocking: true, options: [{ kind: "approve", text: t.reconcileContinue }, { kind: "cancel", text: t.reconcileStop }] };
    const got = await this.askCard(card);
    if (got === "voided") return "voided";
    this.emit("reconcile.asked", { object: rc.object, paths: rc.files.map((f) => f.path), picked: got?.option?.kind ?? null });
    if (got?.option?.kind === "approve") {
      ex.resolveReconciliation(card.text, got.text);
      this.answers.push({ question: card.text, text: got.text });
      this.consents.push({ scope: "reconcile", object: rc.object, consequence: "modify_user" });
      return "continue";
    }
    this.summary = `${rc.step}：中断后不知道是否生效，${rc.files.map((f) => f.path).join("、")} 在那之后被改过；没有再写，等用户查看。`;
    return this.endWith("cancelled", "needs_reconciliation");
  }

  private fileTools(): FileTool[] {
    const reg = this.o.registry;
    if (!this.o.workspace || !reg) return [];
    return reg.list().filter((cap) => cap.channel !== "gui").map((cap) => ({
      name: "fs_" + cap.id.split(".").slice(1).join("_"), capability: cap.id, description: `${cap.description} 路径相对任务目录。`,
      params: Object.fromEntries(Object.entries(cap.schema.properties).map(([k, f]) => [k, { description: f.description }])),
    }));
  }

  // --- steps: one act or file call, from the app's side -------------------------------------------------------------------
  /** The executor's last result inside each step in progress, by step_id (the step's outcome; none when it never
   *  reached the executor). Kept per step, so calls in parallel would not take each other's. */
  private results = new Map<string, ActResult>();
  /** A step that ended on the user's answer to its consent card (declined, stopped, none, voided): that is its why. */
  private answered = new Map<string, string>();

  /** One action the caller asked for, as the app sees it: `step.start` (an id, the action in words, the element it acts
   *  on, the plan step the caller says it belongs to) and `step.end` (how it ended). Everything inside — the judges, the
   *  cards, the driver — runs with the step's id in the context, so the trace names it. A step asked for while a steer is
   *  pending, or one the schema allows but its kind does not, is no step: it is not tried. */
  /** The executor's act; its result is the step's latest outcome (step.end). */
  private async exAct(req: Parameters<Executor["act"]>[0]): Promise<ActResult> {
    const r = await this.o.executor.act(req); const id = current().step_id;
    // a step that tries more than once (a consent card, a reask, a reconciliation): possibly done if any try was
    if (id) { const prev = this.results.get(id); this.results.set(id, prev?.possibly_done !== false && prev && r.possibly_done === false ? { ...r, possibly_done: true } : r); }
    // a step of this run is uncertain (the executor's list, read off the journal: possibly.ts): the standing grants
    // this side holds (the plan's object consents, the sites — the plan's and those approved on a card — and a yes kept
    // for a stale retry) are void for the rest of the run, and are never attached again: every change or send now asks
    // on its own card, which names the uncertain steps (the executor holds the same line whatever it is handed:
    // Executor.uncertainGate — review of harness#66)
    if (this.o.executor.uncertainCount > 0 && (this.tokens.size || this.siteTokens.length || this.retryTokens.size)) {
      this.emit("grants.void", { why: "uncertain", objects: [...this.tokens.keys()], sites: this.siteTokens.map((t) => t.object) });
      this.tokens.clear(); this.siteTokens = []; this.retryTokens.clear();
      this.o.executor.forgetPlanSites();
    }
    return r;
  }

  private async step(a: Action, p: { purpose: string; consequence?: Consequence; epoch?: number; plan_step?: number }, body: () => Promise<ToolReply>): Promise<ToolReply> {
    const s = this.steered(); if (s) return s;
    if (a.kind !== "file") { const bad = checkAction(a); if (bad) return err(bad); }
    const step_id = `st_${randomUUID().slice(0, 8)}`;
    // the element as the caller saw it when it decided: its look at that epoch only (ids are reused between looks)
    const seen = "window" in a ? this.o.executor.observed(a.window) : undefined;
    const obs = seen && seen.epoch === p.epoch ? seen : undefined;
    // a file step's class as the executor settles it by structure (the caller declares none); a screen step's as declared
    let consequence = p.consequence;
    if (a.kind === "file") { try { consequence = this.o.executor.preview({ action: a, epoch: this.o.executor.currentEpoch, consequence: "read" }).consequence; } catch { consequence = undefined; } }
    const el = "target" in a && a.target ? obs?.elements.find((e) => e.id === a.target) : undefined;
    const cap = a.kind === "file" ? this.o.registry?.get(a.capability) : undefined;
    this.emit("step.start", { step_id, action: a, purpose: p.purpose, ...(consequence ? { consequence } : {}), ...("window" in a && a.window ? { object: `window:${a.window}`, object_label: obs ? windowLabel(obs.window, this.o.lang) : this.o.executor.labelOf(`window:${a.window}`) } : {}),
      human: stepText(a, obs, this.o.lang, cap), ...(el ? { target: { id: el.id, label: elementName(el) ?? "", role: el.role, ...placeOf(el.rect, "window" in a ? this.o.executor.frameOf(a.window) : undefined) } } : {}),
      ...(typeof p.plan_step === "number" && Number.isInteger(p.plan_step) && p.plan_step > 0 ? { plan_step: p.plan_step } : {}) });
    return span("deskmind.step", { "deskmind.step_id": step_id, "deskmind.action.kind": a.kind, "deskmind.consequence.declared": consequence, "deskmind.plan_step": p.plan_step }, async (sp) => {
      let reply: ToolReply;
      try { reply = await within({ step_id }, body); }
      catch (e) { this.results.delete(step_id); this.answered.delete(step_id); this.emit("step.end", { step_id, status: "error", why: String(e instanceof Error ? e.message : e).slice(0, 300) }); throw e; }
      const r = this.results.get(step_id) ?? null;
      const user = this.answered.get(step_id);
      this.results.delete(step_id); this.answered.delete(step_id);
      const status = !r ? (reply.isError ? "refused" : "ok") : r.status === "ok" || r.status === "unverified" || r.status === "stale" || r.status === "error" ? r.status : "refused";
      const why = user ?? r?.why ?? (reply.isError ? reply.text.slice(0, 300) : "");
      // possibly_done (executor/possibly.ts): read off the journal by the executor; a step that never reached it did nothing
      this.emit("step.end", { step_id, status, ...(why ? { why } : {}), ...(r ? { executor_status: r.status, consequence: r.consequence } : {}), possibly_done: r ? r.possibly_done !== false : false,
        ...(r?.shot ? { shot: r.shot, ...(r.shot_pending ? { shot_pending: true } : {}) } : {}), ...(r?.target_frame ? { target_frame: r.target_frame } : {}), ...(r?.window_frame ? { window_frame: r.window_frame } : {}) });
      if (r?.shot && r.shot_pending) this.whenShot(step_id, r.shot);
      // what the task has changed so far, after a step that changed something (the app's 改动和产出 while it runs)
      if (r && (status === "ok" || status === "unverified") && r.consequence !== "read") this.emit("changes", this.o.executor.changes() as unknown as Record<string, unknown>);
      sp?.set({ "deskmind.step.status": status, "deskmind.executor_status": r?.status, "deskmind.consequence": r?.consequence, "deskmind.object": r?.object });
      if (status === "error") sp?.fail(why || "error");
      return reply;
    });
  }

  /** A step's picture that the driver writes after its reply (hands takes it off the action's path): `shot.ready` once
   *  the file is there, looked for every 100 ms for up to 20 s; a capture that failed writes nothing and says nothing. */
  private whenShot(step_id: string, rel: string) {
    const dir = this.o.executor.opts.shots;
    if (!dir) return;
    const abs = path.join(path.dirname(dir), rel), until = Date.now() + 20_000;
    const look = () => {
      if (fs.existsSync(abs)) { this.emit("shot.ready", { step_id, shot: rel }); return; }
      if (Date.now() < until) setTimeout(look, 100).unref();
    };
    look();
  }

  // --- acting ----------------------------------------------------------------------------------------------------------
  private async file(p: { capability: string; args: Record<string, string> }): Promise<ToolReply> {
    const s = this.steered(); if (s) return s;
    const cap = this.o.registry?.get(p.capability);
    if (!cap || !this.o.workspace) return err(`没有这个文件能力：${p.capability}`);
    // looking for evidence only: a write is refused before anything is made for it (a rewrite asks a model)
    if (this.lookOnly && cap.effect !== "observe") { this.count("refused_look_only"); return err(LOOK_ONLY); }
    const full = await this.derive(cap, p.args);
    if (typeof full === "string") return err(full);
    return this.act({ action: { kind: "file", capability: cap.id, args: full }, epoch: this.o.executor.currentEpoch, consequence: "read", purpose: cap.description.split("；")[0]! });
  }

  /** A value the capability needs that a model makes from the arguments (fs.transform_text: the rewritten text), asked
   *  of the `transform` role once, as the orchestrator does, and stored in the arguments with the source version it
   *  was made from — so the intent check reads it and a source changed before the write fails the precondition. */
  private async derive(cap: Capability, args: Record<string, string>): Promise<Record<string, string> | string> {
    if (!cap.derive || !this.o.workspace) return args;
    const ws = this.o.workspace;
    const bad = cap.typecheck(args) ?? cap.preconditions(ws, args);
    if (bad) return bad;
    const d = cap.derive(ws, args);
    const ctx = this.o.gateway.contextBudget("transform");
    if ([...d.source].length > ctx) return `the source is ${[...d.source].length} characters; the rewriting model reads at most about ${ctx} tokens`;
    // (a stop before it goes out: not asked; a stop while it is out: aborted)
    if (this.stopped.signal.aborted) return "the task was stopped";
    this.count("model_calls");
    const rep = await this.o.gateway.ask("transform", P.SYSTEM, P.transformPrompt(this.o.executor.opts.raw ?? this.o.raw, d.instruction, d.source), R.TransformAnswer, this.o.task, this.stopped.signal);
    this.emit("transform", { cap: cap.id, outcome: rep.outcome, error: rep.error.slice(0, 200) });
    if (rep.outcome !== "answered") return `the rewrite could not be made (${rep.outcome}: ${rep.error.slice(0, 200)})`;
    return { ...args, ...(d.also ?? {}), [d.field]: rep.data!.text };
  }

  private async act(p: { action: Action; epoch: number; consequence: Consequence; purpose: string }): Promise<ToolReply> {
    const s = this.steered(); if (s) return s;
    const ex = this.o.executor;
    const a = p.action;
    const bad = checkAction(a);
    if (bad) return err(bad);
    // looking for evidence only: a wait or a file read; nothing that changes something or brings an app forward
    if (this.lookOnly && !(a.kind === "wait" || (a.kind === "file" && ex.preview({ action: a, epoch: p.epoch, consequence: "read" }).consequence === "read"))) {
      this.count("refused_look_only");
      return err(LOOK_ONLY);
    }
    // the plan's object token for what the action touches goes along whatever the class: act settles the class itself
    // (the judge is asked only after its own checks that the action is current) and asks for a card when the token
    // does not cover it — a send is never covered by one. Choosing by a class guessed here either paid the judge on
    // stale actions or, by the old send hints, left the token behind for a site search the judge clears
    const pre = ex.preview({ action: a, epoch: p.epoch, consequence: p.consequence });
    // a URL of a site consented to there (the plan's, or a host approved on a card): that consent, the highest class
    // first; anything else there, the plan's object consent if it named the window — the executor checks either
    const host = a.kind === "open_window" && a.url ? siteOf(a.url) : null;
    const opening = host ? this.siteTokens.filter((t) => t.object === pre.object && t.hosts?.includes(host)).sort((x, y) => rank(y.consequence) - rank(x.consequence))[0] : undefined;
    const consent = this.retryTokens.get(canon(a)) ?? opening ?? this.tokens.get(pre.object);
    let r: ActResult;
    try { r = await this.exAct({ action: a, epoch: p.epoch, consequence: p.consequence, purpose: p.purpose, consent }); }
    catch (e) { if (e instanceof Crash) { this.crash = e; this.stopped.abort(); return { text: "crash", done: true }; } throw e; }
    // the executor holds a write on a file an interrupted step left unknown and someone changed since: the user settles
    // it (the card), and only on their "go on" is the step tried again
    if (r.status === "refused" && r.reconcile && !r.reconcile.decision) {
      const g = await this.reconcile();
      if (g === "voided") return this.steered() ?? err("这张卡作废了：这一步没有做。");
      if (g !== "continue") return g;
      try { r = await this.exAct({ action: a, epoch: ex.currentEpoch, consequence: p.consequence, purpose: p.purpose, consent }); }
      catch (e) { if (e instanceof Crash) { this.crash = e; this.stopped.abort(); return { text: "crash", done: true }; } throw e; }
    }
    while (r.status === "needs_consent" && r.challenge) {
      // the user changed the request since accepting the plan, and this step is on something the plan did not name (no
      // token of it covers the object or the site): the new request goes on a new plan card, not on a card per step
      const covered = host ? !!(opening ?? this.retryTokens.get(canon(a))) : !!consent;
      if (this.steeredSincePlan && !covered) {
        this.count("needs_plan"); this.count("needs_plan:steer");
        this.emit("plan.beyond", { object: r.challenge.object, consequence: r.challenge.consequence });
        return err(`用户中途改了要求，这一步要碰的东西不在用户同意过的计划里（${r.challenge.text}）：先按新要求交一份新计划（plan），写上它。`);
      }
      let t = await this.consentFor(r.challenge);
      if (t === "expired") {
        // nobody answers for the user (owner 10-24): the step waits, acting on nothing, until they come back
        const how = await this.afterExpiry();
        if (how === "reask") {
          // 「现在回答」: the same action, decided on the screen the card showed, goes to the executor again without a yes.
          // It reads the computer now: the same screen asks again (a new card, a new deadline); a screen that moved
          // since makes it stale, and the caller is sent back to look (below) — never a yes to what the user did not see
          try { r = await this.exAct({ action: a, epoch: r.epoch, consequence: p.consequence, purpose: p.purpose, consent }); }
          catch (e) { if (e instanceof Crash) { this.crash = e; this.stopped.abort(); return { text: "crash", done: true }; } throw e; }
          continue;
        }
        t = how === "steer" ? "voided" : null;
      }
      // the step's outcome is the user's answer, not the reason consent was asked
      const sid = current().step_id;
      if (sid && (t === "voided" || t === null || t === "cancel" || t === "declined")) this.answered.set(sid, t === "voided" ? "the card was voided: the user changed the request" : t === null ? "no answer from the user" : t === "cancel" ? "the user stopped the task" : "the user declined this step");
      if (t === "voided") return this.steered() ?? err("这张卡作废了：这一步没有做。");
      if (t === null) return this.endWith("failed", "no answer from the user");
      if (t === "cancel") return this.endWith("cancelled", "the user stopped the task", "user_stopped");
      if (t === "declined") return this.declined(`用户不同意这一步：${r.challenge.text}。换一种不需要它的做法，或者 finish 说明。`);
      try { r = await this.exAct({ action: a, epoch: r.epoch, consequence: p.consequence, purpose: p.purpose, consent: t }); }
      catch (e) { if (e instanceof Crash) { this.crash = e; this.stopped.abort(); return { text: "crash", done: true }; } throw e; }
      if (r.status === "stale") this.retryTokens.set(canon(a), t);
      break;                                              // one card per try, as before: only an expiry asks again
    }
    if (r.status !== "stale" && r.status !== "needs_consent") this.retryTokens.delete(canon(a));
    // a stale action did nothing: the window moved on after the caller looked. It is looked at again here, so the caller
    // decides on what is there now (its epoch, its element ids) — told only "observe again", models retried the same
    // click on the old look until the run gave up (rc.6 end to end)
    // Not after the app's stop: the run ends there, not after a look a real driver may take minutes over (review of #24)
    let relooked = false;
    if (r.status === "stale" && "window" in a && a.window) {
      const win = a.window;
      try { const fresh = await this.untilStopped(() => ex.observe(win)); if (fresh) { r = { ...r, after: fresh }; relooked = true; } } catch { /* gone or unreadable: the why says so */ }
    }
    this.count("actions"); this.count(`actions:${r.status}`);
    const cap = a.kind === "file" ? this.o.registry?.get(a.capability) : undefined;
    if (a.kind === "file") this.emit("fs.act", { cap: a.capability, args: a.args, status: r.status, consequence: r.consequence, why: r.why ?? "" });
    if (r.status === "ok" && rank(r.consequence) >= rank("create")) this.effects.push(a.kind === "file" ? describeAction(a, undefined, r.consequence, cap, this.o.lang) : `${p.purpose}${this.o.lang === "en" ? ": " : "："}${describeAction(a, r.after, r.consequence, undefined, this.o.lang)}`);
    if (r.status === "needs_plan") {
      this.count("needs_plan");
      // a URL that would land in the user's browser window: say how the plan covers it (structure, not the words)
      const hint = a.kind === "open_window" && a.url ? `\n这个网址会开在用户已有的 ${a.app} 窗口里：在计划里打开网址的那一步写上 opens: [{ app: "${a.app}", url: "…" }]，计划卡会一并问用户。任务读过文件、看过任务目录里文件的开头或看过窗口以后，打开网址要先核对网址里有没有带着读到的内容（计划里写的网站，核对时算上卡上写的发过去的内容），核对不过就单独问。` : "";
      return err(`先交计划：${r.why}${hint}`);
    }
    // the judge's "not what the user asked": the way out is the user's answer, never another guess
    if (r.status === "refused" && (r.why ?? "").includes("意图核对")) { this.count("refused_by_judge"); return err(`${r.why}
不确定用户想怎么做的，用 ask_user 问清楚（给出几种做法当选项），不要换一种猜法再试。`); }
    if (r.status === "environment") return this.endWith("environment", r.why ?? "environment", r.cause);      // the executor's cause, copied as a field
    if (r.status === "stopped") return this.endWith("stopped", r.why ?? "stopped");
    // the step's picture and where things were on screen are the app's, not the caller's
    const { after, challenge: _c, shot: _s, target_frame: _t, window_frame: _w, shot_pending: _p, possibly_done: _pd, ...rest } = r;
    if (a.kind === "file") return r.status === "ok" ? text(J({ status: "ok", output: r.output ?? {}, consequence: r.consequence })) : err(J({ status: r.status, why: r.why, consequence: r.consequence }));
    const view = { ...rest, ...(after ? { after: { epoch: after.epoch, window: withoutFrame(after.window), modal: after.modal, elements: after.elements, text: after.text } } : {}) };
    // the step check: a state change with nothing visibly changed is said so, in the result the caller reads
    const noChange = r.status === "ok" && rank(r.consequence) >= rank("create") && r.changed && r.changed.elements === 0 && !r.changed.new_windows?.length;
    // a stale result did nothing: the screen moved under the action, which is not the caller going round in circles
    if (r.status !== "stale") {
      const sig = canon({ a, after: after?.elements.map((e) => [e.id, e.value ?? ""]) ?? null });
      this.repeats = sig === this.lastSig ? this.repeats + 1 : 0; this.lastSig = sig;
    }
    const notes = [...(relooked ? ["注意：这一步没有执行——界面在你决定之后变了。after 是刚重新看的这个窗口（新的 epoch 和元素 id），按它重新决定，不要照旧重试。"] : []), ...(noChange ? ["注意：这一步做了，但界面上没有任何变化；预期的变化没出现就换个办法。"] : []), ...(this.repeats >= 1 ? ["注意：同一个动作在同一个界面上重复了，没有进展（原地打转）。换别的路，或者问用户。"] : [])];
    if (this.repeats >= 3) return this.endWith("failed", "no progress: the same action on an unchanged screen");
    const body = J(view) + (notes.length ? "\n" + notes.join("\n") : "");
    return r.status === "ok" || r.status === "unverified" ? text(body) : err(body);
  }

  // --- the plan: the start gate and the plan card ------------------------------------------------------------------------
  private plan(steps: PlanStepIn[], readings: Reading[]): Promise<ToolReply> {
    return span("deskmind.plan", { "deskmind.plan.steps": steps.length, "deskmind.plan.readings": readings.length }, () => this.planNow(steps, readings));
  }

  private async planNow(steps: PlanStepIn[], readings: Reading[]): Promise<ToolReply> {
    const s = this.steered(); if (s) return s;
    const ex = this.o.executor;
    this.count("plans");
    this.emit("plan", { steps, readings });
    // the start gate: readings the judge cannot settle are the user's to settle, one card each, before anything else
    let settled = readings;
    for (;;) {
      const v = await ex.plan({ steps, readings: settled });
      if (v.accepted) break;
      const r = v.open[0]!;
      this.count("asks");
      // each reading's second line from the field the plan role wrote it in (H2), never parsed from its words
      const card: Card = { kind: "ambiguity", text: this.t.ambiguity(r.point), headline: this.t.ambiguity(r.point), free_text: true, blocking: true, options: [
        ...[r.reading, ...r.alternatives].map((t, i) => ({ kind: "reading" as const, text: t, ...(r.details?.[i]?.trim() ? { detail: cardText(r.details[i]!.trim(), 200, this.o.lang) } : {}) })), { kind: "delegate", text: this.t.delegate }, { kind: "cancel", text: this.t.cancel }] };
      const got = await this.askCard(card);
      if (got === "voided") { this.count("asks", -1); return this.steered() ?? err("这张卡作废了：计划没有交上。"); }
      if (!got) return this.endWith("failed", "no answer from the user");
      if (got.option?.kind === "cancel") return this.endWith("cancelled", "the user stopped the task", "user_stopped");
      const chosen = got.option?.kind === "reading" ? got.text : got.option?.kind === "delegate" ? r.reading : null;
      this.emit("reading.settled", { point: r.point, reading: chosen ?? got.text, by: got.option?.kind ?? "words" });
      this.answers.push({ question: this.t.ambiguity(r.point), text: chosen ?? got.text });     // the judges read it like any answer
      ex.addAnswer(this.t.ambiguity(r.point), chosen ?? got.text, { userWrote: chosen === null });
      if (chosen === null) return text(`用户对「${r.point}」的回答：${got.text}。按这个重新理解，再交一次计划。`);
      settled = settled.map((x) => (x === r ? { ...x, reading: chosen, alternatives: [], evidence: [`用户的回答：${chosen}`] } : x));
    }
    // what each step touches, by the executor's own view rather than the class the caller wrote: a step on a window or a
    // file that is the user's changes the user's things, whatever the caller declared (a real run wrote "create" for the
    // music app's window the executor counted as the user's, so no plan card was shown and every step asked on its own
    // card — 「打开网易云播放安溥的宝贝」, 10-20). A declared external stays external; sending still asks per action
    // only looks: nothing to ask, nothing to resolve
    if (steps.every((s) => s.consequence === "read" && !s.opens?.length)) { this.emit("plan.no_card", { why: "only_looks" }); this.steeredSincePlan = false; return text("计划记下了；这些步骤不需要用户同意，直接做。"); }
    const snap = await ex.snapshot();           // one look for the whole plan
    // a URL a step opens lands where the executor's floor for that open_window says: in the user's browser window when
    // the app has one (「搜索今天北京天气」, rc.10: nine cards for nine pages in the user's Chrome). That window is one
    // of the step's objects, by the executor's view — listed on the card, and covered by a consent to open pages of the
    // step's sites there, nothing else (not the whole window: review of #33). An open the floor calls a send (a new host
    // after the task read material) lands there too: declared, it is the user's window all the same
    const opensInto = steps.map((s) => {
      const into = new Map<string, Set<string>>();
      for (const o of s.opens ?? []) {
        const f = ex.floor({ kind: "open_window", app: o.app, url: o.url });
        // the site (http or https; the full hostname): another subdomain asks on its own
        const host = siteOf(o.url);
        if (host && (f.consequence === "modify_user" || f.consequence === "external") && f.object.startsWith("window:")) { const hs = into.get(f.object) ?? new Set<string>(); hs.add(host); into.set(f.object, hs); }
      }
      return into;
    });
    // every http(s) site a step declares (owner 10-21 refinement): where the floor says it lands, and what it sends there
    // (escaped like a URL on the card: it is the caller's text). The card says every one of them and what goes there, and
    // accepting signs exactly that: the host is known and the stated content approved — the executor still asks the
    // provenance judge when there is material, the approved content beside the user's words (review of #35). A declared
    // open the floor already calls a send (read material) makes the step one the user approves
    const sitesOf = steps.map((s) => (s.opens ?? []).flatMap((o) => {
      const host = siteOf(o.url);
      if (!host) return [];
      const f = ex.floor({ kind: "open_window", app: o.app, url: o.url });
      return [{ host, object: f.object, sends: f.consequence === "external", what: o.sends?.trim() ? cardText(o.sends.trim(), 120) : null }];
    }));
    const objectsOf = await Promise.all(steps.map((s) => this.canonObjects(s.objects, snap)));
    // only what is there: a window or tab on screen, a file in the task folder (a raw "window:…" the caller wrote that
    // names nothing would otherwise be called the user's by the ledger and signed — review of #31)
    const there = new Set([...snap.windows.flatMap((w) => [`window:${w.id}`, ...(w.tabs ?? []).map((t) => `tab:${t.id}`)]), ...(this.o.workspace ? Object.keys(this.o.workspace.entries()).map((p) => `path:${p}`) : [])]);
    // the user's to ask about, by the executor's structure: theirs by the ledger, and not a window DeskMind opened for
    // their app under POLICY.taskOpened "task" (M3–M6 plan §1.2: rule 1 is for what the user had when the task began)
    const theirs = (o: string) => there.has(o) && ex.protects(o);
    // a step declared "read" stays a look (the floor of looking is read; an action it turns into asks on its own)
    // (a URL opened into the user's window is no look, whatever the step was declared)
    // a step the caller calls modify_user that names a window, tab or file on screen and nothing the user's to ask about
    // (the task's own window, or one DeskMind opened under POLICY.taskOpened "task") is no reason for a plan card: rule 1 of
    // §1.2 is for what the user had at begin. The caller's class is taken again at act time (classify: the model only
    // raises), so the step still asks on its own card there; here it only no longer re-asks on the plan (practice run
    // 10-25: 「删掉张三那封」 drew a plan card and then the action card). Names that resolve to nothing (an element id, a
    // row's words) sign nothing and decide nothing here either: the step they belong to is judged by the objects that did
    // resolve — a step naming none keeps the caller's class. Only under POLICY.taskOpened "task": the "user" arm is the
    // behaviour before 10-25 (review of #75, C)
    const lowered = (s: PlanStepIn, i: number) => (ex.taskOpenedPolicy === "task" && s.consequence === "modify_user" && objectsOf[i]!.some((o) => there.has(o)) && !objectsOf[i]!.some(theirs) ? "create" : s.consequence);
    const classes = steps.map((s, i) => (s.consequence === "external" ? s.consequence : [...opensInto[i]!.keys()].some(theirs) ? higher(s.consequence, "modify_user") : s.consequence === "read" ? s.consequence : objectsOf[i]!.some(theirs) ? higher(s.consequence, "modify_user") : lowered(s, i)));
    const signFor = [...new Set(objectsOf.flatMap((os, i) => (classes[i] === "read" ? [] : os.filter(theirs))))];
    // an app the hands driver can only operate in front: hands#54 lists bundle ids on the snapshot (`needs_foreground`,
    // known once the app was observed or brought forward), matched against a window's app or its id's "bundle#" prefix;
    // a per-window flag is read too. Said plainly on the card, and in the trace
    const named = new Set([...objectsOf.flat(), ...opensInto.flatMap((m) => [...m.keys()])]);
    // for the trace only (plan.classes): which of the user's windows the plan's pages land in, and the sites there. The
    // consent itself is signed per place from sitesOf below
    const intoYours: Record<string, string[]> = {};
    for (const m of opensInto) for (const [w, hs] of m) if (theirs(w)) intoYours[w] = [...new Set([...(intoYours[w] ?? []), ...hs])];
    const fgList = (snap.needs_foreground ?? []).map((b) => b.toLowerCase());
    const inFront = (w: { id: string; app: string; needs_foreground?: boolean }) => !!w.needs_foreground || fgList.some((b) => b === w.app.toLowerCase() || w.id.toLowerCase().startsWith(b + "#"));
    const fgApps = [...new Set(snap.windows.filter((w) => named.has(`window:${w.id}`) && inFront(w)).map((w) => appName(w)))];
    if (fgApps.length) this.emit("plan.foreground", { apps: fgApps });
    // the windows DeskMind opened for the user's app that the plan names (for the trace: under POLICY.taskOpened "user"
    // each would have made this a card — M3–M6 plan §1.2, H1)
    const opened = [...named].filter((o) => there.has(o) && ex.opened(o));
    this.emit("plan.classes", { declared: steps.map((s) => s.consequence), settled: classes, objects: signFor, opens: intoYours, ...(opened.length ? { task_opened: opened, task_opened_policy: ex.taskOpenedPolicy } : {}) });
    const toSites = sitesOf.map((ds) => ds.some((d) => d.sends));
    // a plan that needs no card covers the request as it stands too: a step beyond it then asks on its own card again
    if (!classes.some((c) => NEEDS_CONSENT.has(c)) && !toSites.some(Boolean)) {
      this.emit("plan.no_card", { why: "within_request", ...(opened.length ? { task_opened: opened, task_opened_policy: ex.taskOpenedPolicy } : {}) });
      this.steeredSincePlan = false; return text("计划记下了；这些步骤不需要用户同意，直接做。");
    }
    // a step that sends from the user's window also changes the user's things on the way (the row picked, the reply
    // opened, the body filled): the card says both, and only what the card says changes the user's things is signed
    // (review of #31: 「回复并发送」 signed the mail window under a line that said only 「会发出去」)
    const mine = (i: number) => objectsOf[i]!.some(theirs);
    // the objects as the user knows them, from the snapshot — the app and its window's title, a tab's title and site, a
    // file's path in the task folder — not the caller's words (「窗口 com.netease.163music#30144」 told the user nothing,
    // review of #31); what did not resolve is shown as the caller wrote it, and is not signed
    // only what resolved to a window, a tab or a file appears on the card: an element id (ocr:26, elem_12) or words that
    // name nothing tell the user nothing, and sign nothing (owner's run run_ac5345ce: 「…main window、ocr:26」)
    const shown = (o: string): string | null => {
      const id = o.slice(o.indexOf(":") + 1);
      if (o.startsWith("window:")) { const w = snap.windows.find((x) => x.id === id); if (w) return windowLabel(w, this.o.lang); }
      if (o.startsWith("tab:")) for (const w of snap.windows) { const t = w.tabs?.find((x) => x.id === id); if (t) { let site = ""; try { site = new URL(t.url).host; } catch { /* no site */ } return `${this.t.quote(t.title)}${site ? (this.o.lang === "en" ? ` (${site})` : `（${site}）`) : ""}`; } }
      if (o.startsWith("path:") && there.has(o)) return this.t.quote(id);       // a name, quoted as the language quotes it
      return null;
    };
    const listed = steps.map((_s, i) => [
      ...objectsOf[i]!.map(shown).filter((x): x is string => x !== null),
      ...[...opensInto[i]!.keys()].filter(theirs).map((w) => this.t.openInYours(appName(snap.windows.find((x) => `window:${x.id}` === w)!))),
    ]);
    // a card says what it signs: every declared site, with what goes there, on the step's line
    const siteList = (i: number) => [...new Map(sitesOf[i]!.map((d) => [d.host, this.t.site(d.host, d.what)])).values()];
    // every step in full, without line-end markers (H2: the class is in plan.steps[].class and the headline): what it
    // touches, and the sites it sends to
    const lines = steps.map((s, i) => `${i + 1}. ${s.purpose}${listed[i]!.length ? this.t.listed(listed[i]!) : ""}${sitesOf[i]!.length ? this.t.sendsTo(siteList(i)) : ""}`);
    void mine;
    // the same card in fields (M0), for an app that lays it out: only what the text says, by the same rules
    // who owns it (the content of a window DeskMind opened is the user's, even where the step inside asks no card)
    const owner = (o: string): "user" | "task" | null => (there.has(o) ? ex.ledger.ownerOf(o) : null);
    const facts: PlanCardFacts = {
      steps: steps.map((s, i) => {
        const objects: PlanCardFacts["steps"][number]["objects"] = [];
        const changes = classes[i] === "modify_user" || classes[i] === "external";
        for (const o of objectsOf[i]!) {
          const label = shown(o), who = owner(o);
          if (label === null || !who) continue;
          objects.push({ ref: o, label, owner: who, marks: [...(theirs(o) && changes ? ["changes" as const] : []), ...(classes[i] === "external" ? ["sends" as const] : []), ...(opensInto[i]!.has(o) ? ["opens_pages" as const] : [])] });
        }
        for (const w of opensInto[i]!.keys()) {
          if (!theirs(w) || objects.some((x) => x.ref === w)) continue;
          const win = snap.windows.find((x) => `window:${x.id}` === w)!;
          objects.push({ ref: w, label: windowLabel(win, this.o.lang), owner: "user", marks: ["opens_pages"] });
        }
        return { purpose: s.purpose, class: classes[i]!, objects, sites: [...new Map(sitesOf[i]!.map((d) => [d.host, { host: d.host, sends: d.what, asks_each: d.sends }])).values()] };
      }),
      foreground: fgApps.length ? { apps: fgApps, note: this.t.foreground(fgApps) } : null,
    };
    // what a yes signs, worked out once, before the card (H2): the card's headline and beyond[] are made from it, and the
    // signing below walks the very same lists — the card names what is signed, no more and no fewer. A step of this run
    // is uncertain: nothing is signed (every change or send then asks on its own card), and the card says so
    const uncertain = ex.uncertainCount > 0;
    const siteGrants = new Map<string, { hosts: Set<string>; sends: Record<string, string[]> }>();
    for (const ds of sitesOf) for (const d of ds) {
      const g = siteGrants.get(d.object) ?? { hosts: new Set<string>(), sends: {} };
      g.hosts.add(d.host);
      if (d.what && !(g.sends[d.host] ??= []).includes(d.what)) g.sends[d.host]!.push(d.what);
      siteGrants.set(d.object, g);
    }
    const signed = { objects: uncertain ? [] : signFor, sites: uncertain ? [] : [...siteGrants] };
    // exactly what the yes signs: each object token's object; each site token's place (forSite signs the landing object
    // with its hosts) when it is the user's — a page opened into their Chrome changes their window; and each site at
    // its place (one host at two places is two entries, as it is two tokens' worth)
    const objectsShown = [...signed.objects, ...signed.sites.map(([o]) => o).filter((o) => theirs(o) && !signed.objects.includes(o))];
    const placeLabel = (o: string) => shown(o) ?? this.o.executor.labelOf(o);
    const beyond: Beyond[] = [
      ...[...new Set(objectsShown)].map((o) => ({ kind: "object" as const, ref: o, label: placeLabel(o) })),
      ...signed.sites.flatMap(([o, g]) => [...g.hosts].map((h) => ({ kind: "site" as const, ref: h, label: h, at: o, at_label: placeLabel(o), ...(g.sends[h]?.length ? { sends: true as const } : {}) }))),
    ];
    const headline = this.t.planHeadline(beyond.filter((b) => b.kind === "object").map((b) => b.label),
      beyond.filter((b) => b.kind === "site").map((b) => ({ host: b.label, at: b.at_label!, sends: !!b.sends })), uncertain, fgApps);
    const card: Card = { kind: "plan", text: `${this.t.planTitle}\n${lines.join("\n")}${fgApps.length ? "\n" + this.t.foreground(fgApps) : ""}\n${this.t.planAsk}`, headline, beyond, free_text: true, blocking: true, options: [{ kind: "approve", text: this.t.okPlan }, { kind: "cancel", text: this.t.cancel }], plan: facts };
    const got = await this.askCard(card);
    if (got === "voided") return this.steered() ?? err("这张卡作废了：计划没有交上。");
    if (!got) return this.endWith("failed", "no answer from the user");
    if (got.option?.kind === "cancel") return this.endWith("cancelled", "the user stopped the task", "user_stopped");
    if (!got.option) return text(`用户没有同意，而是说：${got.text}。按这个改计划。`);
    // the user's objects the plan names, by the executor's view: covered up to modify_user (never a send). An object the
    // plan does not name is not covered: an action on it asks on its own card
    // a step of this run is uncertain: the plan is accepted, but no standing grant is signed for it — every change or
    // send asks on its own card naming that step (the executor would not take one anyway: uncertainGate), so the plan
    // says no more than holds
    for (const obj of signed.objects) {
      const t = this.#signer.forObject(obj, "modify_user", this.o.task);
      this.tokens.set(obj, t);
      this.consents.push({ scope: "object", object: obj, consequence: "modify_user" });
    }
    // the sites the plan declares, wherever they land, with what the card said goes to each: one token per place the floor
    // puts them (the user's window, or the app a window of the task's own opens in), at modify_user — it covers pages
    // landing in the user's window, never a send. The executor checks it and gives the approved content to the
    // provenance judge (review of #35: the plan approves its stated content, it does not bypass the question)
    for (const [obj, g] of signed.sites) {
      const t = this.#signer.forSite(obj, [...g.hosts], this.o.task, "modify_user", undefined, g.sends);
      this.siteTokens.push(t);
      ex.acceptPlanSites(t);
      this.consents.push({ scope: "site", object: obj, consequence: "modify_user" });
    }
    // the plan the user accepted covers the request as it stands now
    this.steeredSincePlan = false;
    this.emit("plan.confirmed", { objects: [...this.tokens.keys()], sites: uncertain ? {} : Object.fromEntries([...siteGrants].map(([w, g]) => [w, { hosts: [...g.hosts], sends: g.sends }])), ...(uncertain ? { grants: "none: a step of this run is uncertain" } : {}) });
    if (uncertain) return text("用户同意了计划。但这次任务里有一步结果不确定，所以改用户东西或往外发的每一步都会单独问用户，卡片上会写出那一步。");
    return text("用户同意了计划。改用户东西的步骤可以做了；往外发的步骤到时候会再确认一次。");
  }

  /** The objects a plan names, in the executor's own terms: a caller writes 「窗口 editor-1（用户的编辑器）」 or a bare
   *  path; the consent has to be keyed by `window:<id>` / `tab:<id>` / `path:<p>` or it covers nothing. Matched
   *  against the ids on screen and the files in the folder, by structure, never by meaning. */
  private async canonObjects(objects: string[], given?: Snapshot): Promise<string[]> {
    const snap = given ?? await this.o.executor.snapshot();
    const ids = snap.windows.flatMap((w) => [`window:${w.id}`, ...(w.tabs ?? []).map((t) => `tab:${t.id}`)]);
    const paths = this.o.workspace ? Object.keys(this.o.workspace.entries()).map((p) => `path:${p}`) : [];
    const out = new Set<string>();
    const bare = (k: string) => k.slice(k.indexOf(":") + 1);
    for (const o of objects) {
      const keys = [...ids, ...paths];
      // an exact name is the object; a name inside the caller's words counts only when it is the one name there (a
      // name inside another hit's name is that hit: "a.txt" in "data.txt"). Several names are ambiguous and sign
      // nothing — the step asks on its own when it comes (review of #16: path:data.txt also signed a.txt)
      const exact = keys.filter((k) => o === k || o === bare(k));
      const within = keys.filter((k) => o.includes(bare(k)));
      const hits = exact.length ? exact : within.filter((k) => !within.some((x) => x !== k && bare(x).includes(bare(k))));
      if (hits.length === 1 || (exact.length && hits.length)) hits.forEach((h) => out.add(h));
      else { if (hits.length > 1) this.emit("plan.ambiguous_object", { object: o, matches: hits }); out.add(o); }
    }
    return [...out];
  }

  // --- questions, answers, skills ----------------------------------------------------------------------------------------
  private async askUser(p: { question: string; options: string[] }): Promise<ToolReply> {
    const s = this.steered(); if (s) return s;
    if ((this.counters["asks"] ?? 0) >= this.budget.asks) return err("问得太多了：先按已知的做，或者 finish 说明缺什么");
    this.count("asks");
    const card: Card = { kind: "missing", text: p.question, headline: p.question, free_text: true, blocking: true, options: [...p.options.slice(0, 6).map((t) => ({ kind: "value" as const, text: t })), { kind: "delegate", text: this.t.delegate }, { kind: "cancel", text: this.t.cancel }] };
    const got = await this.askCard(card);
    if (got === "voided") { this.count("asks", -1); return this.steered() ?? err("这张卡作废了：问题没有答。"); }
    if (!got) return this.endWith("failed", "no answer from the user");
    if (got.option?.kind === "cancel") return this.endWith("cancelled", "the user stopped the task", "user_stopped");
    this.emit("answer", { question: p.question, text: got.text });
    this.answers.push({ question: p.question, text: got.option?.kind === "delegate" ? "由你决定" : got.text });
    // only what the user wrote themselves is theirs to send; an option the caller offered is the caller's text
    this.o.executor.addAnswer(p.question, got.option?.kind === "delegate" ? "由你决定" : got.text, { userWrote: !got.option });
    return text(got.option?.kind === "delegate" ? "用户说：由你决定。" : `用户回答：${got.text}`);
  }

  private async answer(p: { text: string }): Promise<ToolReply> {
    // an answer decided before the user changed what they asked is not given: it would stand in the result
    const s = this.steered(); if (s) return s;
    this.answerText = p.text;
    this.emit("answer.given", { text: p.text });
    return text("已记下答案。");
  }

  private async readSkill(p: { name: string }): Promise<ToolReply> {
    const t = this.o.skills?.read(p.name) ?? null;
    this.count("skills_read");
    if (t) this.o.executor.addSkill(p.name, t);
    return t ? text(t) : err(`没有叫 ${p.name} 的教程`);
  }

  // --- the finish gate -------------------------------------------------------------------------------------------------
  private async finish(p: { outcome: FinishOutcome; summary: string; missing?: string[] }): Promise<ToolReply> {
    const s = this.steered(); if (s) return s;
    this.summary = p.summary;
    this.emit("finish.claimed", { outcome: p.outcome, summary: p.summary, missing: p.missing ?? [] });
    if (p.outcome === "cannot") return this.endWith("failed", "cannot: " + p.summary.slice(0, 200));
    // the user said stop in their own words (a card's free text): the run is cancelled like a picked "先别做了" — not a
    // success, so there is nothing to verify and nothing to gain by claiming it (doubao ended three such runs "done").
    // The caller's outcome field says so (a role's structured answer, not text read here): the user's stop
    if (p.outcome === "stopped") return this.endWith("cancelled", "the user stopped the task: " + p.summary.slice(0, 200), "user_stopped");
    if (p.outcome === "unconfirmed") return this.endWith("unconfirmed", (p.missing ?? []).join("; ") || p.summary.slice(0, 200));
    // "done" is a claim: the verdict comes from an independent judge reading the final state the executor hands over
    const v = await this.verify(p.summary);
    // the user changed the request while the judge read: its verdict was on the old words, and is not kept
    const late = this.steered(); if (late) return late;
    this.verdicts.push(v);
    // a judge tier that answers without words (DeskMind Brain's system one) still gets named, so the app's history
    // never shows an empty "verified:"
    if (v.verdict === "pass") return this.endWith("succeeded", "verified: " + (v.reason.trim() || `by ${v.by ?? "judge"}`).slice(0, 200));
    this.count("verify_failed");
    // done as far as actions go, only the evidence is missing (the judge says so in the verdict's answer, not in words we
    // read): from here the caller may only look — clicking a screen-read app for evidence brought it to the front again
    // and again until the owner stopped the run (run_ac5345ce). A verdict that something is still to do lifts it
    this.lookOnly = v.verdict === "unknown" && v.missing_kind === "evidence";
    if ((this.counters["verify_failed"] ?? 0) > this.budget.verify_retries) return this.endWith("unconfirmed", this.lookOnly ? this.t.checkYourself(v.reason.slice(0, 200)) : `verification did not pass: ${v.reason.slice(0, 200)}`);
    if (this.lookOnly) return err(`核对没有通过（unknown，缺的是证据）：${v.reason}\n该做的动作已经做完了。接下来只能看：computer_snapshot、computer_observe、读文件，找能证明结果的东西；找不到就 finish unconfirmed，说明缺什么。不要再点、输入、切换或打开窗口。`);
    return err(`核对没有通过（${v.verdict}）：${v.reason}\n没做成就接着做；确认不了就 finish unconfirmed 并说明缺什么。不要再直接说 done。`);
  }

  /** The independent verdict: the computer and files after, every window the task touched, what it did, its claim — and
   *  the user's words, their answers among them, which the executor holds whatever the caller reports. */
  private verify(summary: string): Promise<{ verdict: string; reason: string; by?: string; missing_kind?: "action" | "evidence"; claims_contradicted?: string[] }> {
    return span("deskmind.verify", {}, async (s) => {
      const v = await this.verifyNow(summary);
      s?.set({ "deskmind.verdict": v.verdict, "deskmind.tier": v.by, "deskmind.missing_kind": v.missing_kind });
      return v;
    });
  }

  private async verifyNow(summary: string): Promise<{ verdict: string; reason: string; by?: string; missing_kind?: "action" | "evidence"; claims_contradicted?: string[] }> {
    this.count("model_calls");
    const v = await this.o.executor.verdict(summary, { 本任务做过的动作: this.effects, ...(this.answers.length ? { "用户对提问的回答（和原话一样是证据）": this.answers } : {}), ...(this.answerText !== null ? { 给用户的答案: this.answerText } : {}) });
    return { verdict: v.verdict, reason: v.reason, by: v.by, ...(v.missing_kind ? { missing_kind: v.missing_kind } : {}), ...(v.claims_contradicted ? { claims_contradicted: v.claims_contradicted } : {}) };
  }

  // --- the end, the result card and undo ----------------------------------------------------------------------------------
  private async endExecutor() { if (this.executorEnded) return; this.executorEnded = true; await this.o.executor.end().catch(() => undefined); }

  private async end(p: { failure?: string } = {}): Promise<TaskResult> {
    if (this.crash) throw this.crash;                       // the process dies here: the journal is what survives
    if (!this.status) { this.status = "failed"; this.reason = p.failure ?? "the model stopped without finishing"; }
    await this.endExecutor();
    return this.result();
  }

  /** The card shown with a result that changed something — however the task ended (M2 H2, owner 10-24: succeeded,
   *  failed, stopped, cancelled, unconfirmed, the screen locked; before, only a success had one, and a stopped task's
   *  changes had no undo at all). "Changed something" has one rule (executor/possibly.ts): a step with an intent in the
   *  journal and no receipt that says nothing happened — the executor's record, never the caller's. What was done, and undo when every step has one (a file action through its
   *  capability, a window the task opened); a screen action, a step whose effect is not known, or one in flight makes
   *  the run irreversible, and the card then says why instead of offering it. Whether the undo can still be answered
   *  (the window: the executor lingering, another task, the session) is not the card's: the session's records say. */
  resultCard(): Card | null {
    const ex = this.o.executor;
    // the possibly-done steps, from the journal (executor/possibly.ts): one still out at the driver among them
    const u = ex.undoable();
    if (!u.steps.length) return null;
    const reversible = u.reversible;
    const options: CardOption[] = [{ kind: "approve", text: this.t.fine }];
    if (reversible) options.push({ kind: "undo", text: this.t.undo });
    const consented = this.consents.filter((c) => c.scope !== "action" || c.consequence === "external").map((c) => c.object);
    const rules = [...ex.consent.rulesUsed];
    // the steps as every card lists them (executor/possibly.ts stepLines): done, or not known — the same lines a card
    // the session writes for this journal would have
    const { did, unsure } = stepLines(ex.possiblySteps());
    const why = u.steps.find((x) => !x.can)?.why ?? this.t.undoable;
    const text = [...(this.status && this.status !== "succeeded" ? [this.t.notFinished(this.status)] : []),
      ...(did.length ? [this.t.did(did.slice(-6))] : []), ...(unsure.length ? [this.t.didUnsure(unsure.slice(-6))] : []),
      ...(consented.length ? [this.t.changedYours([...new Set(consented)].map((o) => ex.labelOf(o)))] : []), ...(rules.length ? [this.t.byRule(rules)] : []), ...(reversible ? [] : [this.t.noUndo(why)]),
      // undo takes the run back but leaves open what a launch brought up of the user's apps: said, not implied
      ...(reversible && u.steps.some((x) => x.left_open) ? [this.t.undoKeepsOpen([...new Set(u.steps.flatMap((x) => (x.left_open ? [x.left_open] : [])))])] : [])].join("\n");
    return { kind: "result", text, headline: this.t.resultHeadline(did.length, unsure.length) || text.split("\n")[0]!, options, free_text: false, blocking: false };
  }

  /** The user's answer to the result card: undo takes everything back (all or nothing) and the run ends cancelled. */
  async respond(answer: Answer): Promise<{ undone: number; total: number; refused: string | null; unsure?: string } | null> {
    const card = this.resultCard();
    if (!card || !("option" in answer)) return null;
    const pick = card.options[answer.option];
    this.emit("result.response", { picked: pick?.kind ?? null });
    if (pick?.kind !== "undo") return null;
    const u = await this.o.executor.undo();
    if (!u.refused) { this.settle("cancelled", "the user undid the result"); this.effects.push(`撤回了 ${u.undone} 步`); }
    else this.emit("note", { text: u.undone ? `撤回了 ${u.undone} 步后停下：${u.refused}` : `没有撤回：${u.refused}` });
    this.emit("result.undo", u);
    return u;
  }

  private result(): TaskResult {
    const r: TaskResult = { status: this.status!, reason: this.reason, ...(this.cause ? { cause: this.cause } : {}), summary: this.summary, answer: this.answerText, counters: { ...this.counters }, consents: this.consents, effects: this.effects, verdicts: this.verdicts, result_card: this.resultCard() };
    this.emit("run.end", { status: r.status, reason: r.reason, ...(r.cause ? { cause: r.cause } : {}) });
    return r;
  }
}
