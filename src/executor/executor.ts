/**
 * The executor: the last line. Whatever runtime sits above it, an action gets through only when the screen is
 * unlocked, the observation it was decided on is current, the stop switch is off, and — for anything that modifies
 * the user's things or sends something out — a consent token the app signed covers it.
 *
 *   begin     inventory: everything on screen now is the user's
 *   snapshot  the whole computer, owners stamped
 *   observe   one window close up
 *   act       floor (structure) ⊔ the model's class → guard → driver → re-observe → receipt
 *   verify    the evidence a final judgement needs (every window of interest, after)
 *   stop      the app's stop switch: every later act is refused
 *   end       collect the receipts
 */
import type { Action, ActRequest, ActResult, Consequence, ConsentToken, Driver, Element, Observation, PerformResult, Receipt, Snapshot, WindowInfo } from "./types.js";
import { NEEDS_CONSENT, higher } from "./types.js";
import { ConsentVerifier } from "./consent.js";
import { Ledger } from "./ledger.js";
import type { KeyObject } from "node:crypto";

export interface ExecutorOptions { task: string; publicKey: KeyObject; now?: () => number; onEvent?: (kind: string, body: Record<string, unknown>) => void }

/** What an action touches: the object the guard and the consent are about. */
export function objectOf(a: Action): string {
  switch (a.kind) {
    case "open_window": return `app:${a.app}`;
    case "wait": return "";
    default: return `window:${a.window}`;
  }
}

export class Executor {
  readonly ledger = new Ledger();
  readonly consent: ConsentVerifier;
  readonly receipts: Receipt[] = [];
  private stopped = false;
  private epoch = 0;
  private last: Snapshot | null = null;
  private lastObs = new Map<string, Observation>();

  constructor(readonly driver: Driver, readonly opts: ExecutorOptions) {
    this.consent = new ConsentVerifier(opts.publicKey, opts.now);
  }

  private emit(kind: string, body: Record<string, unknown> = {}) { this.opts.onEvent?.(kind, body); }

  async begin(paths: string[] = []): Promise<Snapshot> {
    const raw = await this.driver.snapshot();
    this.ledger.begin(raw, paths);
    this.epoch = raw.epoch;
    this.last = this.ledger.stamp(raw);
    this.emit("executor.begin", { windows: this.last.windows.length, locked: this.last.locked });
    return this.last;
  }

  async snapshot(): Promise<Snapshot> {
    const s = this.ledger.stamp(await this.driver.snapshot());
    this.epoch = s.epoch;
    this.last = s;
    return s;
  }

  async observe(windowId: string, opts?: { screenshot?: boolean }): Promise<Observation> {
    const o = await this.driver.observe(windowId, opts);
    const stamped: Observation = { ...o, window: { ...o.window, owner: this.ledger.ownerOf(`window:${o.window.id}`) } };
    this.epoch = o.epoch;
    this.lastObs.set(windowId, stamped);
    return stamped;
  }

  stop() { this.stopped = true; this.emit("executor.stopped"); }

  /** The minimum class an action can have, from structure alone. */
  floor(a: Action): { consequence: Consequence; object: string; why: string } {
    const object = objectOf(a);
    if (a.kind === "wait" || a.kind === "focus_window" || a.kind === "scroll") return { consequence: "read", object, why: "changes no content" };
    if (a.kind === "open_window") return { consequence: "create", object, why: "a window of the task's own" };
    const owner = this.ledger.ownerOf(object);
    if (a.kind === "close_window") return owner === "user" ? { consequence: "modify_user", object, why: "closes the user's window" } : { consequence: "create", object, why: "closes the task's own window" };
    const obs = this.lastObs.get(a.window);
    const el = "target" in a && a.target ? obs?.elements.find((e) => e.id === a.target) : undefined;
    if (el?.sends) return { consequence: "external", object, why: `「${el.label}」 sends something out` };
    // Return (any chord with it) or a typed newline in a window that has a sending control: in every compose form the
    // focus is on the text, the default button sends, so this is the same as pressing it (review 10-18, T3)
    const submits = (a.kind === "key" && /\b(return|enter)\b/i.test(a.chord)) || (a.kind === "type" && a.text.includes("\n"));
    const sender = obs?.elements.find((e) => e.sends);
    if (submits && sender) return { consequence: "external", object, why: `Return in a window where 「${sender.label}」 sends` };
    return owner === "user" ? { consequence: "modify_user", object, why: "acts in the user's window" } : { consequence: "create", object, why: "acts in the task's own window" };
  }

  /** What `act` would decide before doing anything: the class and whether consent is needed (for a runtime that
   *  wants to ask first). */
  preview(req: Omit<ActRequest, "consent">): { consequence: Consequence; object: string; needs_consent: boolean; floor_why: string } {
    const f = this.floor(req.action);
    const consequence = higher(f.consequence, req.consequence ?? "read");
    const needs = NEEDS_CONSENT.has(consequence) && this.consent.check(req.action, f.object, consequence, this.opts.task) !== null;
    return { consequence, object: f.object, needs_consent: needs, floor_why: f.why };
  }

  async act(req: ActRequest): Promise<ActResult> {
    const f = this.floor(req.action);
    const consequence = higher(f.consequence, req.consequence ?? "read");
    const base = { consequence, object: f.object };
    const done = (r: ActResult): ActResult => {
      const { consent, ...rest } = req;
      this.receipts.push({ seq: this.receipts.length + 1, t: this.opts.now?.() ?? Date.now(), request: { ...rest, ...(consent ? { consent: { scope: consent.scope, nonce: consent.nonce } } : {}) }, result: r });
      this.emit("executor.act", { action: req.action, status: r.status, consequence: r.consequence, object: r.object, why: r.why ?? "" });
      return r;
    };
    if (this.stopped) return done({ ...base, status: "stopped", why: "the app stopped the task", epoch: this.epoch });
    const now = await this.driver.snapshot();
    if (now.locked) return done({ ...base, status: "environment", why: "the screen is locked", epoch: now.epoch });
    if (req.epoch !== now.epoch) return done({ ...base, status: "stale", why: `decided on epoch ${req.epoch}, the computer is at ${now.epoch}; observe again`, epoch: now.epoch });
    const target = "window" in req.action ? req.action.window : null;
    if (target && !now.windows.some((w) => w.id === target)) return done({ ...base, status: "stale", why: `window ${target} is gone`, epoch: now.epoch });
    // an element is addressed only through the window's last observation: a guessed id would skip the structural
    // floor (a `sends` button never seen is not known to send), so it is refused, not executed (review 10-18, T2)
    const obs = target ? this.lastObs.get(target) : undefined;
    if ("target" in req.action && req.action.target && !obs?.elements.some((e) => e.id === (req.action as { target: string }).target)) return done({ ...base, status: "stale", why: `element ${req.action.target} is not in the last observation of ${target}; observe the window first`, epoch: now.epoch });
    if (target && (req.action.kind === "key" || req.action.kind === "type") && !obs) return done({ ...base, status: "stale", why: `window ${target} was never observed; observe it first`, epoch: now.epoch });
    if (NEEDS_CONSENT.has(consequence)) {
      const why = this.consent.check(req.action, f.object, consequence, this.opts.task, req.consent);
      if (why) {
        const challenge = this.consent.challenge(req.action, f.object, consequence, describeAction(req.action, this.lastObs.get("window" in req.action ? req.action.window : ""), consequence));
        this.emit("executor.consent_needed", { why, consequence, object: f.object });
        return done({ ...base, status: "needs_consent", why, challenge, epoch: now.epoch });
      }
    }
    const before = "window" in req.action ? this.lastObs.get(req.action.window) ?? null : null;
    // a real driver can fail on either side of the action: that is a result the model reads, never an exception
    let r: PerformResult;
    try { r = await this.driver.perform(req.action); } catch (e) { r = { status: "error", why: e instanceof Error ? e.message : String(e) }; }
    if (r.new_window) this.ledger.created(`window:${r.new_window.id}`);
    let after: Snapshot;
    try { after = await this.driver.snapshot(); } catch (e) { return done({ ...base, status: r.status === "ok" ? "unverified" : "error", why: `${r.why ?? ""}; after the action the computer could not be read: ${e instanceof Error ? e.message : e}`.replace(/^; /, ""), epoch: this.epoch }); }
    this.epoch = after.epoch;
    if (after.locked) return done({ ...base, status: r.status === "ok" ? "unverified" : "environment", why: `${r.why ?? ""}; the screen is locked`.replace(/^; /, ""), epoch: after.epoch });
    const status = r.status === "ok" ? "ok" : r.status === "unverified" ? "unverified" : r.status === "blocked" ? "blocked" : r.status === "unsupported" ? "refused" : "error";
    const out: ActResult = { ...base, status, why: r.why, epoch: after.epoch };
    const win = r.window ?? ("window" in req.action ? req.action.window : r.new_window?.id);
    if (win && after.windows.some((w) => w.id === win)) {
      try {
        const obs = await this.observe(win);
        out.after = obs;
        out.changed = diffObs(before, obs, after.windows.filter((w) => !now.windows.some((x) => x.id === w.id)).map((w) => w.id));
      } catch (e) {
        if (out.status === "ok") out.status = "unverified";
        out.why = `${out.why ?? ""}; the window could not be read back: ${e instanceof Error ? e.message : e}`.replace(/^; /, "");
      }
    }
    return done(out);
  }

  /** The evidence for a final judgement: the computer now, and every window the task touched or created, observed
   *  again. Who judges is the runtime's `verify` role; what it judges on is this. */
  async verify(): Promise<{ snapshot: Snapshot; windows: Observation[]; receipts: Receipt[] }> {
    const s = await this.snapshot();
    const touched = new Set<string>();
    for (const r of this.receipts) if ("window" in r.request.action && (r.result.status === "ok" || r.result.status === "unverified")) touched.add(r.request.action.window);
    for (const o of this.ledger.taskObjects()) if (o.startsWith("window:")) touched.add(o.slice(7));
    const windows: Observation[] = [];
    for (const id of touched) if (s.windows.some((w) => w.id === id)) windows.push(await this.observe(id));
    return { snapshot: s, windows, receipts: this.receipts };
  }

  async end(): Promise<{ receipts: Receipt[]; task_objects: string[] }> {
    await this.driver.end?.();
    this.emit("executor.end", { receipts: this.receipts.length });
    return { receipts: this.receipts, task_objects: this.ledger.taskObjects() };
  }
}

function diffObs(before: Observation | null, after: Observation, newWindows: string[]): ActResult["changed"] {
  const b = before?.elements ?? [];
  const key = (e: Element) => `${e.id}|${e.label}|${e.value ?? ""}|${e.enabled ?? true}`;
  const bs = new Set(b.map(key));
  const changed = after.elements.filter((e) => !bs.has(key(e))).length + b.filter((e) => !after.elements.some((x) => key(x) === key(e))).length;
  return { elements: changed, focus: after.elements.find((e) => e.focused)?.label, modal: after.modal?.title ?? null, ...(newWindows.length ? { new_windows: newWindows } : {}) };
}

/** The consent card's text: the action in words, with the element it touches and what that means. */
export function describeAction(a: Action, obs: Observation | undefined, consequence: Consequence): string {
  const el = "target" in a && a.target ? obs?.elements.find((e) => e.id === a.target) : undefined;
  const where = obs ? `${obs.window.app}「${obs.window.title}」` : "window" in a ? a.window : "";
  const what = a.kind === "click" ? `点「${el?.label ?? a.target}」`
    : a.kind === "set_value" ? `把「${el?.label ?? a.target}」设为「${a.value}」`
    : a.kind === "type" ? `在「${el?.label ?? a.target}」里输入「${a.text}」`
    : a.kind === "select" ? `把「${el?.label ?? a.target}」选成「${a.option}」`
    : a.kind === "key" ? `按 ${a.chord}`
    : a.kind === "close_window" ? "关闭窗口" : a.kind === "open_window" ? `打开 ${a.app}` : a.kind === "focus_window" ? "切到窗口" : a.kind === "scroll" ? "滚动" : "等待";
  const cls = consequence === "external" ? "这会把内容发出去" : consequence === "modify_user" ? "这会改动你的东西" : "";
  return `${where ? "在 " + where + " " : ""}${what}${cls ? "（" + cls + "）" : ""}`;
}

export type { WindowInfo };
