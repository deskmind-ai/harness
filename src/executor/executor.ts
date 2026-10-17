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
import type { Action, ActRequest, ActResult, Consequence, ConsentToken, Driver, Element, Observation, Receipt, Snapshot, WindowInfo } from "./types.js";
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

  begin(paths: string[] = []): Snapshot {
    const raw = this.driver.snapshot();
    this.ledger.begin(raw, paths);
    this.epoch = raw.epoch;
    this.last = this.ledger.stamp(raw);
    this.emit("executor.begin", { windows: this.last.windows.length, locked: this.last.locked });
    return this.last;
  }

  snapshot(): Snapshot {
    const s = this.ledger.stamp(this.driver.snapshot());
    this.epoch = s.epoch;
    this.last = s;
    return s;
  }

  observe(windowId: string, opts?: { screenshot?: boolean }): Observation {
    const o = this.driver.observe(windowId, opts);
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
    const el = "target" in a && a.target ? this.lastObs.get(a.window)?.elements.find((e) => e.id === a.target) : undefined;
    if (el?.sends) return { consequence: "external", object, why: `「${el.label}」 sends something out` };
    if (a.kind === "key" && /\b(return|enter)\b/i.test(a.chord)) {
      // Return in a window whose focused element sends: the same as pressing it
      const focused = this.lastObs.get(a.window)?.elements.find((e) => e.focused);
      if (focused?.sends) return { consequence: "external", object, why: `Return on 「${focused.label}」 sends` };
    }
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

  act(req: ActRequest): ActResult {
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
    const now = this.driver.snapshot();
    if (now.locked) return done({ ...base, status: "environment", why: "the screen is locked", epoch: now.epoch });
    if (req.epoch !== now.epoch) return done({ ...base, status: "stale", why: `decided on epoch ${req.epoch}, the computer is at ${now.epoch}; observe again`, epoch: now.epoch });
    const target = "window" in req.action ? req.action.window : null;
    if (target && !now.windows.some((w) => w.id === target)) return done({ ...base, status: "stale", why: `window ${target} is gone`, epoch: now.epoch });
    if (NEEDS_CONSENT.has(consequence)) {
      const why = this.consent.check(req.action, f.object, consequence, this.opts.task, req.consent);
      if (why) {
        const challenge = this.consent.challenge(req.action, f.object, consequence, describeAction(req.action, this.lastObs.get("window" in req.action ? req.action.window : ""), consequence));
        this.emit("executor.consent_needed", { why, consequence, object: f.object });
        return done({ ...base, status: "needs_consent", why, challenge, epoch: now.epoch });
      }
    }
    const before = "window" in req.action ? this.lastObs.get(req.action.window) ?? null : null;
    const r = this.driver.perform(req.action);
    if (r.new_window) this.ledger.created(`window:${r.new_window.id}`);
    const after = this.driver.snapshot();
    this.epoch = after.epoch;
    const status = r.status === "ok" ? "ok" : r.status === "unverified" ? "unverified" : r.status === "blocked" ? "blocked" : r.status === "unsupported" ? "refused" : "error";
    const out: ActResult = { ...base, status, why: r.why, epoch: after.epoch };
    const win = r.window ?? ("window" in req.action ? req.action.window : r.new_window?.id);
    if (win && after.windows.some((w) => w.id === win)) {
      const obs = this.observe(win);
      out.after = obs;
      out.changed = diffObs(before, obs, after.windows.filter((w) => !now.windows.some((x) => x.id === w.id)).map((w) => w.id));
    }
    return done(out);
  }

  /** The evidence for a final judgement: the computer now, and every window the task touched or created, observed
   *  again. Who judges is the runtime's `verify` role; what it judges on is this. */
  verify(): { snapshot: Snapshot; windows: Observation[]; receipts: Receipt[] } {
    const s = this.snapshot();
    const touched = new Set<string>();
    for (const r of this.receipts) if ("window" in r.request.action && r.result.status === "ok") touched.add(r.request.action.window);
    for (const o of this.ledger.taskObjects()) if (o.startsWith("window:")) touched.add(o.slice(7));
    const windows = [...touched].filter((id) => s.windows.some((w) => w.id === id)).map((id) => this.observe(id));
    return { snapshot: s, windows, receipts: this.receipts };
  }

  end(): { receipts: Receipt[]; task_objects: string[] } {
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
