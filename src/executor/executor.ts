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
import type { Action, ActRequest, ActResult, Consequence, ConsentToken, Driver, Element, ExternalChange, Observation, PerformResult, PlanProposal, PlanVerdict, Reading, Receipt, Snapshot, WindowInfo } from "./types.js";
import * as P from "../orchestrator/prompts.js";
import { Crash, type Capability, type Registry } from "../registry/capability.js";
import { reconcile as reconcileVersions } from "../registry/reconcile.js";
import * as fs from "node:fs";
import type { Workspace } from "../registry/workspace.js";
import { NEEDS_CONSENT, higher } from "./types.js";
import { ConsentVerifier } from "./consent.js";
import { Ledger } from "./ledger.js";
import { INTENT_OPTIONS, INTENT_QUESTION, VERIFY_OPTIONS, VERIFY_QUESTION, type Judge } from "./judge.js";
import { T, type Lang } from "../runtime/text.js";
import type { KeyObject } from "node:crypto";

export interface ExecutorOptions {
  task: string; publicKey: KeyObject; now?: () => number; onEvent?: (kind: string, body: Record<string, unknown>) => void;
  /** The independent judge (judge.ts): asked before every action that changes the user's things or sends something
   *  out whether it is what the user asked for. Without one, consent alone gates those actions. */
  judge?: Judge;
  /** The user's words, for the judge; the runtime updates it when the user changes the request (steer). */
  raw?: string;
  /** The language of what the user reads (consent card texts). */
  lang?: Lang;
  /** A journal (jsonl): every state-changing action is written down before it runs and receipted after, so a process
   *  that died in between is found on restart (an intent without a receipt) and reconciled, never repeated blindly. */
  journal?: string;
  /** Test hook: die after the first effect, before its receipt (what a power cut at the wrong moment does). */
  crashAfterFirstEffect?: boolean;
  /** The task folder and the file capabilities: files are objects like windows (owner, version, last seen). */
  files?: { workspace: Workspace; registry: Registry };
}

/** What an action touches: the object the guard and the consent are about. */
export function objectOf(a: Action, fp?: { reads: string[]; writes: string[] }, cap?: Capability): string {
  switch (a.kind) {
    case "open_window": return `app:${a.app}`;
    case "wait": return "";
    case "file": return cap?.effect === "external" ? `cap:${a.capability}` : fp?.writes[0] ? `path:${fp.writes[0]}` : fp?.reads[0] ? `path:${fp.reads[0]}` : `cap:${a.capability}`;
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
  /** Each window as the task first saw it: what "that row was X and is now gone" is proved against. */
  private firstObs = new Map<string, Observation>();
  /** Files: the version of each path as the task last saw it (begin, a read, its own write), the versions the task
   *  itself wrote (content ownership), and what other programs changed meanwhile. */
  private seen: Record<string, string> = {};
  private taskContent = new Set<string>();           // "path@version" the task wrote
  /** The folder as the task found it (small files with their text): what "unchanged" and "renamed from" are proved against. */
  private startTree: { versions: Record<string, string>; contents: Record<string, string> } | null = null;
  readonly externalChanges: ExternalChange[] = [];
  /** The plan the user's things may be touched under: none until one passed the judge (and, upstream, the user). */
  private planAccepted: PlanProposal | null = null;
  /** What undo needs of each file action (by receipt seq): the capability's own record and what it noted beforehand. */
  private fileReceipts = new Map<number, { cap: Capability; args: Record<string, string>; exec: { status: string; versions_after: Record<string, string>; undo?: Record<string, unknown> }; undo_prep?: Record<string, unknown> }>();

  /** What a restart found: an action the previous process started and never receipted, and what became of it. */
  recovered: { action: Action; finding: "happened" | "not_happened" | "unknown"; text: string } | null = null;
  private crashed = false;

  constructor(readonly driver: Driver, readonly opts: ExecutorOptions) {
    this.consent = new ConsentVerifier(opts.publicKey, opts.now);
  }

  private journal(kind: "intent" | "receipt", body: Record<string, unknown>) {
    if (!this.opts.journal) return;
    const fd = fs.openSync(this.opts.journal, "a");
    try { fs.writeSync(fd, JSON.stringify({ t: this.opts.now?.() ?? Date.now(), kind, ...body }) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  /** On begin: the last intent of an earlier process with no receipt. A file action is reconciled from the versions
   *  it recorded (happened / not happened / unknown); a screen action is unknown by nature — both are told to the
   *  runtime, which looks before acting again. */
  private recover() {
    const p = this.opts.journal;
    if (!p || !fs.existsSync(p)) return;
    const lines = fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    const last = lines.at(-1);
    if (!last || last.kind !== "intent") return;
    const action = last.action as Action;
    let finding: "happened" | "not_happened" | "unknown" = "unknown";
    const ws = this.opts.files?.workspace;
    if (action.kind === "file" && ws && last.versions_before && last.expect_after) finding = reconcileVersions(ws, last.versions_before as Record<string, string>, last.expect_after as Record<string, string>);
    this.recovered = { action, finding, text: String(last.text ?? "") };
    this.journal("receipt", { recovered: true, finding });
    this.emit("executor.recovered", { action, finding });
  }

  /** The task folder and the file capabilities, when the caller did not give them at construction (before begin). */
  attachFiles(workspace: Workspace, registry: Registry) { this.opts.files = { workspace, registry }; }

  setRequest(raw: string) { this.opts.raw = raw; }

  /** The start gate, mirror of the finish gate: nothing of the user's is touched and nothing is sent until a plan is
   *  in. A plan is accepted when every reading it rests on is settled — no alternatives, or evidence the judge says
   *  tells the readings apart (the orchestrator's evidence judge, same wording). Readings the judge cannot settle are
   *  handed back for the user to choose; without a judge every open reading is the user's to settle. */
  async plan(p: PlanProposal): Promise<PlanVerdict> {
    const open: Reading[] = [];
    for (const r of p.readings ?? []) {
      if (!r.alternatives.length) continue;
      const evidence = r.evidence.filter((e) => e.trim() && !(this.opts.raw ?? "").includes(e.trim()));   // the request cannot settle its own ambiguity
      if (!evidence.length || !this.opts.judge) { open.push(r); continue; }
      const options = [r.reading, ...r.alternatives, "说不清：这些证据区分不了"].map((text, i) => ({ id: `r${i}`, text }));
      const ans = await this.opts.judge.choose(P.evidenceQuestion(r.point), { 用户原文: this.opts.raw ?? "", 证据: evidence }, options);
      if (ans?.choice !== "r0") open.push(r);
    }
    this.emit("executor.plan", { steps: p.steps.length, readings: (p.readings ?? []).length, open: open.map((r) => r.point) });
    if (open.length) return { accepted: false, open, why: `依据不够，先问用户：${open.map((r) => r.point).join("、")}` };
    this.planAccepted = p;
    return { accepted: true, steps: p.steps };
  }

  get hasPlan(): boolean { return this.planAccepted !== null; }

  /** Codex's guardian, in the executor: before an action that changes the user's things or sends something out, an
   *  independent judge reads the user's words, the action in words and the evidence around it. A mismatch is refused
   *  with the judge's reason; "not enough evidence" and a judge that cannot answer fall through to the user's consent
   *  (no contributor is an implicit allow — the user decides). Read-only and task-own actions are never judged. */
  private async judgeIntent(a: Action, consequence: Consequence, object: string, evidence: Record<string, unknown>, text: string): Promise<{ verdict: "matches" | "mismatch" | "insufficient" | "unavailable"; reason: string; by?: string }> {
    const j = this.opts.judge;
    if (!j || !this.opts.raw) return { verdict: "unavailable", reason: "no judge" };
    const ctx = { 用户原文: this.opts.raw, 即将执行的动作: text, 后果类别: consequence, 对象: object, 证据: evidence };
    const ans = await j.choose(INTENT_QUESTION, ctx, INTENT_OPTIONS);
    if (!ans) return { verdict: "unavailable", reason: "the judge could not answer" };
    this.emit("executor.intent", { action: a, verdict: ans.choice, by: ans.by, confidence: ans.confidence, reason: ans.reason ?? "" });
    return { verdict: ans.choice as "matches" | "mismatch" | "insufficient", reason: ans.reason ?? "", by: ans.by };
  }

  /** The epoch of the last snapshot / observation: what a file action, which has no window to observe, cites. */
  get currentEpoch(): number { return this.epoch; }

  private emit(kind: string, body: Record<string, unknown> = {}) { this.opts.onEvent?.(kind, body); }

  async begin(paths: string[] = [], rules: ConsentToken[] = []): Promise<Snapshot> {
    if (rules.length) { const r = this.consent.loadRules(rules); this.emit("executor.rules", r); }
    const raw = await this.driver.snapshot();
    const ws = this.opts.files?.workspace;
    if (ws) {
      const contents: Record<string, string> = {};
      for (const [p, v] of Object.entries(ws.entries())) {
        this.seen[p] = ws.version(p); if (!paths.includes(p)) paths = [...paths, p];
        if (v !== "dir" && ws.isTextFile(p)) { const t = ws.read(p); if (t.length <= 1000) contents[p] = t; }
      }
      this.startTree = { versions: { ...this.seen }, contents };
    }
    this.ledger.begin(raw, paths);
    this.recover();
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
    if (!this.firstObs.has(windowId)) this.firstObs.set(windowId, stamped);
    return stamped;
  }

  stop() { this.stopped = true; this.emit("executor.stopped"); }

  /** A file action's capability and footprint, or why it cannot be looked at. */
  private fileOf(a: Extract<Action, { kind: "file" }>): { cap: Capability; fp: { reads: string[]; writes: string[] }; ws: Workspace } | { error: string } {
    const f = this.opts.files;
    if (!f) return { error: "this executor has no task folder" };
    const cap = f.registry.get(a.capability);
    if (!cap) return { error: `unknown capability ${a.capability}` };
    const bad = cap.typecheck(a.args);
    if (bad) return { error: bad };
    try { return { cap, fp: cap.footprint(f.workspace, a.args), ws: f.workspace }; } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  }

  /** The minimum class an action can have, from structure alone. */
  floor(a: Action): { consequence: Consequence; object: string; why: string } {
    if (a.kind === "file") {
      const f = this.fileOf(a);
      if ("error" in f) return { consequence: "read", object: `cap:${a.capability}`, why: f.error };
      const object = objectOf(a, f.fp, f.cap);
      if (f.cap.effect === "observe") return { consequence: "read", object, why: "reads only" };
      if (f.cap.effect === "external") return { consequence: "external", object, why: "sends something out" };
      const userPaths = f.fp.writes.filter((p) => f.ws.exists(p) && this.ledger.ownerOf(`path:${p}`) === "user");
      if (userPaths.length) return { consequence: "modify_user", object, why: `changes the user's ${userPaths.join(", ")}` };
      // discarding content the task did not write (replace, trash) is the user's loss even on a path the task made
      const foreign = f.cap.discards ? f.fp.writes.filter((p) => f.ws.exists(p) && !f.ws.isDir(p) && !this.taskContent.has(`${p}@${f.ws.version(p)}`)) : [];
      if (foreign.length) return { consequence: "modify_user", object, why: `discards content the task did not write: ${foreign.join(", ")}` };
      return { consequence: "create", object, why: "creates, or changes the task's own files" };
    }
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
    if (req.action.kind === "file") return done(await this.actFile(req.action, req.consent, consequence, f.object, now.epoch));
    // the user is at the keyboard: a window action now would fight them for it, whoever owns the window (D20). Read-only
    // looks are fine; the runtime waits and tries again
    if (now.user_active && consequence !== "read") return done({ ...base, status: "blocked", why: "the user is using the computer right now; wait a moment and try again", epoch: now.epoch });
    if (req.epoch !== now.epoch) return done({ ...base, status: "stale", why: `decided on epoch ${req.epoch}, the computer is at ${now.epoch}; observe again`, epoch: now.epoch });
    const target = "window" in req.action ? req.action.window : null;
    if (target && !now.windows.some((w) => w.id === target)) return done({ ...base, status: "stale", why: `window ${target} is gone`, epoch: now.epoch });
    // an element is addressed only through the window's last observation: a guessed id would skip the structural
    // floor (a `sends` button never seen is not known to send), so it is refused, not executed (review 10-18, T2)
    const obs = target ? this.lastObs.get(target) : undefined;
    if ("target" in req.action && req.action.target && !obs?.elements.some((e) => e.id === (req.action as { target: string }).target)) return done({ ...base, status: "stale", why: `element ${req.action.target} is not in the last observation of ${target}; observe the window first`, epoch: now.epoch });
    if (target && (req.action.kind === "key" || req.action.kind === "type") && !obs) return done({ ...base, status: "stale", why: `window ${target} was never observed; observe it first`, epoch: now.epoch });
    if (NEEDS_CONSENT.has(consequence) && !this.planAccepted) return done({ ...base, status: "needs_plan", why: "touching the user's things or sending something out needs a plan first: call plan with the objects, your readings and their evidence", epoch: now.epoch });
    if (NEEDS_CONSENT.has(consequence)) {
      const text = describeAction(req.action, this.lastObs.get("window" in req.action ? req.action.window : ""), consequence, undefined, this.opts.lang);
      const el = "target" in req.action && req.action.target ? obs?.elements.find((e) => e.id === (req.action as { target: string }).target) : undefined;
      const judged = await this.judgeIntent(req.action, consequence, f.object, { 窗口: obs ? { app: obs.window.app, title: obs.window.title, owner: obs.window.owner } : null, ...(el ? { 元素: { role: el.role, label: el.label, value: el.value } } : {}), ...(req.purpose ? { 模型说的目的: req.purpose } : {}) }, text);
      if (judged.verdict === "mismatch") return done({ ...base, status: "refused", why: `意图核对（${judged.by}）：不是用户要的。${judged.reason}`, epoch: now.epoch });
      const why = this.consent.check(req.action, f.object, consequence, this.opts.task, req.consent);
      if (why) {
        const challenge = this.consent.challenge(req.action, f.object, consequence, text);
        this.emit("executor.consent_needed", { why, consequence, object: f.object });
        return done({ ...base, status: "needs_consent", why, challenge, epoch: now.epoch });
      }
    }
    const before = "window" in req.action ? this.lastObs.get(req.action.window) ?? null : null;
    // a real driver can fail on either side of the action: that is a result the model reads, never an exception
    let r: PerformResult;
    if (consequence !== "read") this.journal("intent", { action: req.action, object: f.object, consequence, text: describeAction(req.action, obs, consequence) });
    try { r = await this.driver.perform(req.action); } catch (e) { r = { status: "error", why: e instanceof Error ? e.message : String(e) }; }
    if (this.opts.crashAfterFirstEffect && !this.crashed && r.status === "ok" && consequence !== "read") { this.crashed = true; throw new Crash("crash after the effect, before the receipt"); }
    if (consequence !== "read") this.journal("receipt", { status: r.status });
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

  /** A file capability under the same guard as a window action. Versions stand in for the observation epoch: every
   *  path the action reads or writes must be as the task last saw it (at begin, in a read, or by its own write); one
   *  that changed since was changed by someone else — recorded as a fact, and the action is refused until the task
   *  reads the file again and decides anew. Nothing here "corrects" another program's work. */
  private async actFile(a: Extract<Action, { kind: "file" }>, consent: ConsentToken | undefined, consequence: Consequence, object: string, epoch: number): Promise<ActResult> {
    const base = { consequence, object, epoch };
    const f = this.fileOf(a);
    if ("error" in f) return { ...base, status: "error", why: f.error };
    const { cap, fp, ws } = f;
    const touched = [...new Set([...fp.reads, ...fp.writes])].filter((p) => ws.exists(p));
    const changed = touched.filter((p) => this.seen[p] !== ws.version(p));
    if (changed.length) {
      for (const p of changed) { this.externalChanges.push({ path: p, seen: this.seen[p] ?? "absent", now: ws.version(p), at: this.opts.now?.() ?? Date.now() }); this.seen[p] = ws.version(p); }
      this.emit("executor.external_change", { paths: changed });
      return { ...base, status: "stale", why: `changed since you last saw it (by another program, or never read): ${changed.join(", ")}. Read it again and decide anew; its content is not yours to undo.` };
    }
    const pre = cap.preconditions(ws, a.args);
    if (pre) return { ...base, status: "error", why: `precondition: ${pre}` };
    if (NEEDS_CONSENT.has(consequence) && !this.planAccepted) return { ...base, status: "needs_plan", why: "changing the user's files or sending something out needs a plan first: call plan with the paths, your readings and their evidence" };
    if (NEEDS_CONSENT.has(consequence)) {
      const text = describeAction(a, undefined, consequence, cap, this.opts.lang);
      const evidence: Record<string, unknown> = {};
      for (const p of touched) if (!ws.isDir(p)) evidence[`文件 ${p} 现在的内容（前 600 字）`] = ws.readForModel(p, 600);
      const judged = await this.judgeIntent(a, consequence, object, evidence, text);
      if (judged.verdict === "mismatch") return { ...base, status: "refused", why: `意图核对（${judged.by}）：不是用户要的。${judged.reason}` };
      const why = this.consent.check(a, object, consequence, this.opts.task, consent);
      if (why) {
        const challenge = this.consent.challenge(a, object, consequence, text);
        this.emit("executor.consent_needed", { why, consequence, object });
        return { ...base, status: "needs_consent", why, challenge };
      }
    }
    const existed = fp.writes.filter((p) => ws.exists(p));
    const undo_prep = cap.prepareUndo?.(ws, a.args);
    const versions_before: Record<string, string> = {};
    for (const p of [...fp.reads, ...fp.writes]) versions_before[p] = ws.version(p);
    if (cap.effect !== "observe") this.journal("intent", { action: a, object, consequence, text: describeAction(a, undefined, consequence, cap), versions_before, expect_after: (fp as { expectAfter?: Record<string, string> }).expectAfter ?? {} });
    let r: ReturnType<Capability["execute"]>;
    try { r = cap.execute(ws, a.args); } catch (e) { ws.invalidate(); if (e instanceof Crash) throw e; return { ...base, status: "error", why: e instanceof Error ? e.message : String(e) }; }
    ws.invalidate();
    if (this.opts.crashAfterFirstEffect && !this.crashed && r.status === "ok" && cap.effect !== "observe") { this.crashed = true; throw new Crash("crash after the effect, before the receipt"); }
    if (cap.effect !== "observe") this.journal("receipt", { status: r.status });
    if (r.status !== "ok") return { ...base, status: "error", why: r.why ?? r.status };
    if (cap.effect !== "observe") this.fileReceipts.set(this.receipts.length + 1, { cap, args: a.args, exec: { status: r.status, versions_after: r.versions_after, undo: r.undo }, ...(undo_prep ? { undo_prep } : {}) });
    const gone = existed.filter((p) => !ws.exists(p));
    for (const p of fp.writes) {
      const v = ws.version(p);
      this.seen[p] = v;
      if (ws.exists(p) && !ws.isDir(p)) this.taskContent.add(`${p}@${v}`);
      if (!existed.includes(p) && ws.exists(p)) { if (gone.length) this.ledger.inherits(`path:${p}`, `path:${gone[0]}`); else this.ledger.created(`path:${p}`); }
    }
    for (const p of fp.reads) this.seen[p] = ws.version(p);        // a read is an observation
    return { ...base, status: "ok", output: r.output ?? {} };
  }

  /** The evidence for a final judgement: the computer now, and every window the task touched or created, observed
   *  again. Who judges is the runtime's `verify` role; what it judges on is this. */
  async verify(): Promise<{ snapshot: Snapshot; windows: Observation[]; receipts: Receipt[]; external_changes: ExternalChange[] }> {
    const s = await this.snapshot();
    // every window the task looked at or made, not only the ones it changed: a judge has to see the state of a
    // window a refused action never reached, too
    const touched = new Set<string>(this.lastObs.keys());
    for (const r of this.receipts) if ("window" in r.request.action && (r.result.status === "ok" || r.result.status === "unverified")) touched.add(r.request.action.window);
    for (const o of this.ledger.taskObjects()) if (o.startsWith("window:")) touched.add(o.slice(7));
    const windows: Observation[] = [];
    for (const id of touched) if (s.windows.some((w) => w.id === id)) windows.push(await this.observe(id));
    return { snapshot: s, windows, receipts: this.receipts, external_changes: this.externalChanges };
  }

  /** The finish gate's verdict: the independent judge reads the computer and the folder as they are now, every window
   *  the task touched, the receipts, what other programs changed, and the runtime's own account (effects, an answer,
   *  the model's claim) — and says pass / fail / unknown. unknown is not done. The runtime and the MCP service call
   *  the same method, so a run cannot end "done" on any runtime without it. */
  async verdict(summary: string, extra: Record<string, unknown> = {}): Promise<{ verdict: "pass" | "fail" | "unknown"; reason: string; by?: string }> {
    const ev = await this.verify();
    const ws = this.opts.files?.workspace;
    const brief = (o: Observation) => ({ window: o.window, modal: o.modal, text: o.text, elements: o.elements.map((e) => ({ id: e.id, role: e.role, label: e.label, value: e.value })) });
    const evidence: Record<string, unknown> = {
      任务结束时整台电脑: ev.snapshot,
      任务看过的窗口现在的样子: ev.windows.map(brief),
      "任务第一次看到这些窗口时的样子（和现在逐条比：少了的行就是被删或移走的，多了的就是新建的；元素 id 在两边是同一个）": ev.windows.map((o) => this.firstObs.get(o.window.id)).filter((o): o is Observation => !!o).map(brief),
      执行层的回执: ev.receipts.map((r) => ({ action: r.request.action, status: r.result.status, consequence: r.result.consequence })),
      // what the task read (file reads, listings): the content it decided on is evidence the judge can quote
      "任务读到过的内容（文件读取的输出，每条最多 1500 字）": ev.receipts.filter((r) => r.request.action.kind === "file" && r.result.output && Object.keys(r.result.output).length).slice(-8).map((r) => ({ action: r.request.action, output: JSON.stringify(r.result.output).slice(0, 1500) })),
      ...(ev.external_changes.length ? { "任务期间被别的程序改过的文件（这些改动不是本任务造成的，保留它们不算违反需求）": ev.external_changes.map((c) => c.path) } : {}),
      ...(ws ? { 任务目录现在的内容: ws.listing(), "任务目录现在的版本（路径 → 版本，和开始时逐条比就知道哪些没动过；文件夹的版本随内容变）": Object.fromEntries(Object.keys(ws.entries()).map((p) => [p, ws.version(p)])) } : {}),
      ...(this.startTree ? { "任务开始时的目录（路径 → 版本；小文件带内容）": this.startTree } : {}),
      ...extra,
      模型自称: summary,
    };
    if (!this.opts.judge) return { verdict: "unknown", reason: "no judge to verify with" };
    const ans = await this.opts.judge.choose(VERIFY_QUESTION, { 用户原文: this.opts.raw ?? "", 证据: evidence }, VERIFY_OPTIONS, "verify");
    if (!ans) return { verdict: "unknown", reason: "the judge could not answer" };
    this.emit("executor.verdict", { verdict: ans.choice, by: ans.by, reason: ans.reason ?? "" });
    return { verdict: ans.choice as "pass" | "fail" | "unknown", reason: ans.reason ?? "", by: ans.by };
  }

  /** Which of the task's effects can be taken back, newest first, and why not: a file action through its capability's
   *  undo (create, move, copy, append have one; a replaced text or a trashed file do not), a window the task opened by
   *  closing it. Anything else done on screen cannot be undone. The whole run is reversible only when every step is. */
  undoable(): { reversible: boolean; steps: { seq: number; text: string; can: boolean; why?: string }[] } {
    const steps: { seq: number; text: string; can: boolean; why?: string }[] = [];
    for (const r of [...this.receipts].reverse()) {
      if (r.result.status !== "ok" || r.result.consequence === "read") continue;
      const a = r.request.action;
      const t = T(this.opts.lang);
      if (a.kind === "file") { const f = this.fileReceipts.get(r.seq); steps.push(f?.cap.undo ? { seq: r.seq, text: describeAction(a, undefined, r.result.consequence, f.cap, this.opts.lang), can: true } : { seq: r.seq, text: describeAction(a, undefined, r.result.consequence, f?.cap, this.opts.lang), can: false, why: t.noUndoFor(a.capability) }); continue; }
      if (a.kind === "open_window") { steps.push({ seq: r.seq, text: t.openWindow(a.app), can: true }); continue; }
      steps.push({ seq: r.seq, text: describeAction(a, undefined, r.result.consequence, undefined, this.opts.lang), can: false, why: t.undoable });
    }
    return { reversible: steps.every((s) => s.can), steps };
  }

  /** Take every effect back, newest first; nothing is touched unless all of them can be (the orchestrator's rule).
   *  A file a later program changed is refused by the capability's own check. */
  async undo(): Promise<{ undone: number; total: number; refused: string | null }> {
    const plan = this.undoable();
    if (!plan.reversible) return { undone: 0, total: plan.steps.length, refused: plan.steps.find((s) => !s.can)?.why ?? "cannot undo" };
    const ws = this.opts.files?.workspace;
    let undone = 0;
    for (const step of plan.steps) {
      const r = this.receipts.find((x) => x.seq === step.seq)!;
      const a = r.request.action;
      let err: string | null = null;
      if (a.kind === "file") {
        const f = this.fileReceipts.get(r.seq)!;
        err = f.cap.undo!(ws!, f.args, { ...f.exec, output: {}, undo: f.exec.undo ?? f.undo_prep } as never);
        ws!.invalidate();
        if (!err) for (const p of f.cap.footprint(ws!, f.args).writes) this.seen[p] = ws!.version(p);
      } else if (a.kind === "open_window") {
        const id = r.result.after?.window.id;
        const snap = await this.driver.snapshot();
        if (id && snap.windows.some((w) => w.id === id)) { const pr = await this.driver.perform({ kind: "close_window", window: id }); if (pr.status !== "ok") err = pr.why ?? pr.status; }
      }
      if (err) { this.emit("executor.undo_refused", { seq: step.seq, why: err, undone }); return { undone, total: plan.steps.length, refused: err }; }
      undone += 1;
      this.emit("executor.undone", { seq: step.seq, text: step.text });
    }
    return { undone, total: plan.steps.length, refused: null };
  }

  /** What changed in the task folder since begin, for the result: paths made, changed and gone (external changes
   *  are listed apart, as what another program did). */
  changes(): { created: string[]; modified: string[]; deleted: string[]; external: string[] } {
    const ws = this.opts.files?.workspace, start = this.startTree?.versions ?? {};
    if (!ws) return { created: [], modified: [], deleted: [], external: this.externalChanges.map((c) => c.path) };
    const now = ws.entries();
    const external = new Set(this.externalChanges.map((c) => c.path));
    return {
      created: Object.keys(now).filter((p) => !(p in start) && !external.has(p)),
      modified: Object.keys(now).filter((p) => p in start && start[p] !== (now[p] === "dir" ? ws.version(p) : now[p]) && now[p] !== "dir" && !external.has(p)),
      deleted: Object.keys(start).filter((p) => !(p in now)),
      external: [...external],
    };
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
export function describeAction(a: Action, obs: Observation | undefined, consequence: Consequence, cap?: Capability, lang?: Lang): string {
  const t = T(lang);
  if (a.kind === "file") {
    const what = `${(cap?.description ?? a.capability).split("；")[0]!.replace(/。$/, "")}：${Object.entries(a.args).map(([k, v]) => `${k}=「${v.slice(0, 80)}」`).join("，")}`;
    return consequence === "external" ? `${what}（${t.sends}）` : consequence === "modify_user" ? `${what}（${t.modifiesFile}）` : what;
  }
  const el = "target" in a && a.target ? obs?.elements.find((e) => e.id === a.target) : undefined;
  const where = obs ? `${obs.window.app}「${obs.window.title}」` : "window" in a ? a.window : "";
  const what = a.kind === "click" ? t.click(el?.label ?? a.target)
    : a.kind === "set_value" ? t.set(el?.label ?? a.target, a.value)
    : a.kind === "type" ? t.type(el?.label ?? a.target, a.text)
    : a.kind === "select" ? t.select(el?.label ?? a.target, a.option)
    : a.kind === "key" ? t.key(a.chord)
    : a.kind === "close_window" ? t.closeWindow : a.kind === "open_window" ? t.openWindow(a.app) : a.kind === "focus_window" ? t.focusWindow : a.kind === "scroll" ? t.scroll : t.wait;
  const cls = consequence === "external" ? t.sends : consequence === "modify_user" ? t.modifies : "";
  return `${where ? t.at(where) : ""}${what}${cls ? "（" + cls + "）" : ""}`;
}

export type { WindowInfo };
