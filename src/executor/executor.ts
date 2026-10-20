/**
 * The executor: the last line. Whatever runtime sits above it, an action gets through only when the screen is
 * unlocked, the observation it was decided on is current, the stop switch is off, and — for anything that modifies
 * the user's things or sends something out — a consent token the app signed covers it.
 *
 *   begin     inventory: everything on screen now is the user's
 *   snapshot  the whole computer, owners stamped
 *   observe   one window close up
 *   classify  structure ⊔ the model's class ⊔ the judge's "will this send something out?" (only raises)
 *   act       classify → guard → driver → re-observe → receipt
 *   verify    the evidence a final judgement needs (every window of interest, after)
 *   stop      the app's stop switch: every later act is refused
 *   end       collect the receipts
 */
import type { Action, ActRequest, ActResult, Consequence, ConsentToken, Driver, Element, ExternalChange, Observation, PerformResult, PlanProposal, PlanVerdict, Reading, Receipt, Snapshot, WindowInfo } from "./types.js";
import * as P from "../orchestrator/prompts.js";
import { Crash, type Capability, type Registry } from "../registry/capability.js";
import { reconcile as reconcileVersions } from "../registry/reconcile.js";
import { parentOf } from "../registry/spec.js";
import { PaperFolder } from "./paper.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Workspace } from "../registry/workspace.js";
import { NEEDS_CONSENT, higher, rank } from "./types.js";
import { ConsentVerifier, canon } from "./consent.js";
import { Ledger } from "./ledger.js";
import { INTENT_OPTIONS, INTENT_QUESTION, OUTGOING_OPTIONS, OUTGOING_QUESTION, VERIFY_OPTIONS, VERIFY_QUESTION, type Judge } from "./judge.js";
import { T, type Lang } from "../runtime/text.js";
import type { KeyObject } from "node:crypto";

export interface ExecutorOptions {
  task: string; publicKey: KeyObject; now?: () => number; onEvent?: (kind: string, body: Record<string, unknown>) => void;
  /** How long a state-changing action waits for the user to pause before it is blocked, and how often it looks. */
  userWait?: { ms: number; pollMs: number };
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

/** An action's class, as `classify` settles it, and who settled it: structure (ownership, a capability's declared
 *  effect, or — with no judge attached — the old send hints), the model's own class, a judge tier (its name: "brain",
 *  "frontier"…) answering "will this send something out?", or no answer (then external). */
export interface Classification { consequence: Consequence; object: string; why: string; by: string }

/** An element read from the screen's pixels rather than the accessibility tree: hands' `source` when it sends one,
 *  otherwise its id prefix (text recognition, controls hands made up, Eyes). */
export const fromScreen = (e: Element): boolean => (e.source ? e.source === "pixels" : /^(ocr|gen|icon|desc):/.test(e.id));

/** The screen actions the outgoing question is asked of: those that change something and could send — a click, a
 *  double-click, a key, a typed newline. set_value / select / scroll / typing without a newline are not. */
const mightSend = (a: Action): boolean => a.kind === "click" || a.kind === "double_click" || a.kind === "key" || (a.kind === "type" && a.text.includes("\n"));

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
  /** Files that changed while a screen action ran, with no driver receipt to say whose doing it was: neither the
   *  task's nor called another program's (creditFiles). */
  readonly unconfirmed: ExternalChange[] = [];
  /** The plan the user's things may be touched under: none until one passed the judge (and, upstream, the user). */
  private planAccepted: PlanProposal | null = null;
  /** What undo needs of each file action (by receipt seq): the capability's own record and what it noted beforehand. */
  private fileReceipts = new Map<number, { cap: Capability; args: Record<string, string>; writes: string[]; versions_before: Record<string, string>; madeParents: string[]; exec: { status: string; versions_after: Record<string, string>; undo?: Record<string, unknown> }; undo_prep?: Record<string, unknown> }>();
  /** Paths the task has seen listed in a folder (fs.list): known to be there, though not read. */
  private listed = new Set<string>();
  /** What the task typed into each window (type / set_value that went through), in order: evidence for the outgoing
   *  question, and on a window read from the screen what the card shows goes out (text recognition may not read an
   *  input box back). Cleared when a send in that window went through: that text is gone. */
  private typed = new Map<string, string[]>();
  /** classify's answers, per (action, epoch, the model's class): the judge is asked once per action per screen. */
  private classified = new Map<string, Classification>();
  /** The window each open_window really made (by receipt seq): what its undo closes. */
  private openedWindows = new Map<number, string>();

  /** What a restart found: an action the previous process started and never receipted, what became of it, and the
   *  files other programs changed while no process was watching (from the journal's versions, so they are facts of
   *  the task, not its new starting point). */
  recovered: { action: Action; finding: "happened" | "not_happened" | "unknown"; text: string; external: string[] } | null = null;
  private crashed = false;

  constructor(readonly driver: Driver, readonly opts: ExecutorOptions) {
    this.consent = new ConsentVerifier(opts.publicKey, opts.now);
  }

  private journal(kind: "begin" | "intent" | "receipt", body: Record<string, unknown>) {
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
    // a record cut off mid-write (the process died inside writeSync) is no record: recovery goes on from the last whole
    // one (review of #16). The fragment is kept — it shows the process got as far as writing — and closed with a
    // newline, so the next record starts on its own line instead of being glued to it and lost
    const raw = fs.readFileSync(p, "utf-8");
    if (raw && !raw.endsWith("\n")) { fs.appendFileSync(p, "\n"); this.emit("executor.journal_torn_tail", { bytes: Buffer.byteLength(raw) - Buffer.byteLength(raw.slice(0, raw.lastIndexOf("\n") + 1)) }); }
    const lines = raw.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } });
    const last = lines.at(-1);
    if (!last || last.kind !== "intent") return;
    const action = last.action as Action;
    let finding: "happened" | "not_happened" | "unknown" = "unknown";
    const ws = this.opts.files?.workspace;
    if (action.kind === "file" && ws && last.versions_before && last.expect_after) finding = reconcileVersions(ws, last.versions_before as Record<string, string>, last.expect_after as Record<string, string>);
    // the folder as the earlier process last knew it: the begin record, plus every file write it receipted and the
    // lost one when it happened; whatever differs now was changed by someone else while no process was watching
    const external: string[] = [];
    if (ws) {
      const known: Record<string, string> = {};
      for (let i = 0; i < lines.length; i += 1) {
        const l = lines[i]!;
        if (l.kind === "begin" && l.versions) Object.assign(known, l.versions as Record<string, string>);
        if (l.kind === "intent" && l.versions_before && lines[i + 1]?.kind === "receipt" && (i + 1 < lines.length - 1 || last.kind !== "intent")) {
          Object.assign(known, l.versions_before as Record<string, string>);                          // what it saw before writing
          if ((lines[i + 1] as { versions_after?: Record<string, string> }).versions_after) Object.assign(known, (lines[i + 1] as { versions_after: Record<string, string> }).versions_after);
        }
      }
      if (finding === "happened") Object.assign(known, last.expect_after as Record<string, string>);
      if (Object.keys(known).length) {
        for (const [path, v] of Object.entries(known)) {
          const now = ws.version(path);
          if (v === now || (v === "file:*" && now !== "absent" && !now.startsWith("dir:")) || (v === "dir:*" && now.startsWith("dir:"))) continue;
          external.push(path);
          this.externalChanges.push({ path, seen: v, now, at: this.opts.now?.() ?? Date.now() });
        }
        if (external.length) this.emit("executor.external_change", { paths: external, while: "down" });
      }
    }
    this.recovered = { action, finding, text: String(last.text ?? ""), external };
    this.journal("receipt", { recovered: true, finding, external });
    this.emit("executor.recovered", { action, finding, external });
  }

  /** Another program's change to a file, recorded once per version it made (a write refused again and again on the
   *  same change is one fact). */
  private noted = new Set<string>();
  private noteExternal(path: string, seen: string, now: string) {
    // a change of unknown origin found again by a later write is still of unknown origin, not another program's
    if (this.noted.has(`${path}@${now}`) || this.unconfirmed.some((u) => u.path === path && u.now === now)) return;
    this.noted.add(`${path}@${now}`);
    this.externalChanges.push({ path, seen, now, at: this.opts.now?.() ?? Date.now() });
  }

  /** The task folder right before a screen action: what `creditFiles` compares against afterwards. */
  private fileVersions(): Record<string, string> | null {
    const ws = this.opts.files?.workspace;
    if (!ws) return null;
    ws.invalidate();
    return Object.fromEntries(Object.keys(ws.entries()).map((p) => [p, ws.version(p)]));
  }

  /** What changed in the task folder since `before`, read right after a screen action (path → version, "absent" when
   *  gone): the candidates `creditFiles` decides on. */
  private fileChanges(before: Record<string, string> | null): { path: string; was: string; now: string }[] {
    const ws = this.opts.files?.workspace;
    if (!ws || !before) return [];
    ws.invalidate();
    const out: { path: string; was: string; now: string }[] = [];
    for (const p of Object.keys(ws.entries())) { const v = ws.version(p); if (before[p] !== v) out.push({ path: p, was: before[p] ?? "absent", now: v }); }
    for (const p of Object.keys(before)) if (!ws.exists(p)) out.push({ path: p, was: before[p]!, now: "absent" });
    return out;
  }

  /** After a screen action: which of the files that changed while it ran are its doing — only what the driver's
   *  receipt (PerformResult.files) vouches for, and only where the version did change. Nothing on screen is evidence of
   *  a write: eight rounds of review found a counter-example to every reading of the window (a sync client's file of
   *  the same name, of the same folder name, a cancelled save sheet, a document that merely changed meanwhile). With a
   *  receipt, any other change is another program's (the driver said what this action wrote; `[]`: it cannot write).
   *  Without one, a change is of unknown origin: not credited and not called another program's either — recorded as
   *  unconfirmed, protected like the user's (a write on it needs a read, discarding it needs consent), and shown to the
   *  verdict as such. A credited file is seen, the task's content, and when new the task's object. Returns the
   *  credited paths (files only). */
  private creditFiles(changes: { path: string; was: string; now: string }[], receipt: PerformResult["files"]): string[] {
    if (!changes.length) return [];
    const ws = this.opts.files!.workspace;
    const reported = receipt?.map((f) => (typeof f === "string" ? { path: this.inFolder(f), sha256: null } : { path: this.inFolder(f.path), sha256: f.sha256 })).filter((f) => f.path !== null);
    // the receipt vouches for a file only while it holds what the driver wrote: the file's own bytes, hashed in full
    const holds = (p: string, sha256: string | null) => !!sha256 && ws.exists(p) && !ws.isDir(p) && createHash("sha256").update(ws.readBytes(p)).digest("hex") === sha256.toLowerCase();
    const unconfirmed = (c: { path: string; was: string; now: string }) => { if (!this.unconfirmed.some((u) => u.path === c.path && u.now === c.now)) this.unconfirmed.push({ path: c.path, seen: c.was, now: c.now, at: this.opts.now?.() ?? Date.now() }); };
    const wrote: string[] = [], other: string[] = [];
    for (const c of changes) {
      if (c.was.startsWith("dir:") || c.now.startsWith("dir:")) { if (c.now === "absent") delete this.seen[c.path]; else this.seen[c.path] = c.now; continue; }
      const entry = reported?.find((f) => f.path === c.path);
      if (!entry || !holds(c.path, entry.sha256)) {
        // in the receipt but no longer (or never said to be) what was written: whose the content is now is not known
        if (reported && !entry) this.noteExternal(c.path, c.was, c.now); else unconfirmed(c);
        other.push(c.path);
        continue;
      }
      wrote.push(c.path);
      if (c.now === "absent") { delete this.seen[c.path]; continue; }
      this.seen[c.path] = c.now;
      this.taskContent.add(`${c.path}@${c.now}`);
      if (c.was === "absent") this.ledger.created(`path:${c.path}`);
    }
    if (wrote.length) this.emit("executor.files_written", { paths: wrote });
    if (other.length) this.emit("executor.files_not_credited", { paths: other, while: "screen action" });
    return wrote;
  }

  /** A path a driver reported, as a path in the task folder (null when outside it). A driver reports what the app says,
   *  links resolved (/private/tmp/… for a task folder given as /tmp/…, as rc.1's /tmp/dm-real was), so both sides are
   *  compared resolved. */
  private inFolder(f: string): string | null {
    const root = this.opts.files!.workspace.root;
    if (!path.isAbsolute(f)) return path.normalize(f).split(path.sep).join("/");
    const real = (p: string) => { try { return fs.realpathSync(p); } catch { try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return p; } } };
    for (const [base, file] of [[root, f], [real(root), real(f)]] as const) {
      const r = path.relative(base, file);
      if (r && !r.startsWith("..") && !path.isAbsolute(r)) return r.split(path.sep).join("/");
    }
    return null;
  }

  /** The task folder and the file capabilities, when the caller did not give them at construction (before begin). */
  attachFiles(workspace: Workspace, registry: Registry) { this.opts.files = { workspace, registry }; }

  setRequest(raw: string) { this.opts.raw = raw; }

  /** What the user answered when asked during the task: their words as much as the request, read by every judge
   *  question (intent, evidence, verdict) — a judge that saw only the request refused the step the user had just asked
   *  for (10-18, "点稍后关掉弹窗"). */
  private answers: { question: string; text: string }[] = [];
  addAnswer(question: string, text: string) { this.answers.push({ question, text }); }
  /** A tutorial the runtime is following this task (one the user taught or admitted): what "整理一下" means here, so
   *  a judge does not refuse the moves the tutorial prescribes as "not what the user asked" (10-18, skills-002/003). */
  private skillsInUse: { name: string; text: string }[] = [];
  addSkill(name: string, text: string) { if (!this.skillsInUse.some((s) => s.name === name)) this.skillsInUse.push({ name, text: text.slice(0, 4000) }); }
  private userWords(): Record<string, unknown> {
    return { 用户原文: this.opts.raw ?? "", ...(this.answers.length ? { "用户对提问的回答（和原话一样是用户的话）": this.answers } : {}),
      ...(this.skillsInUse.length ? { "本次在用的教程（用户教过、收下的做法；按它做的步骤是用户要的）": this.skillsInUse } : {}) };
  }

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
      const ans = await this.opts.judge.choose(P.evidenceQuestion(r.point), { ...this.userWords(), 证据: evidence }, options);
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
    const ctx = { ...this.userWords(), 即将执行的动作: text, 后果类别: consequence, 对象: object, 证据: evidence };
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
    if (ws && !this.recovered) this.journal("begin", { versions: { ...this.seen } });     // what a restart compares against
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

  /** The minimum class an action can have, from structure alone: ownership and what a capability declares. */
  structure(a: Action): { consequence: Consequence; object: string; why: string } {
    if (a.kind === "file") {
      const f = this.fileOf(a);
      if ("error" in f) return { consequence: "read", object: `cap:${a.capability}`, why: f.error };
      const object = objectOf(a, f.fp, f.cap);
      if (f.cap.effect === "observe") return { consequence: "read", object, why: "reads only" };
      if (f.cap.effect === "external") return { consequence: "external", object, why: "sends something out" };
      // a folder carries what is in it: the task's output/ with the user's file put inside is the user's file moved or
      // trashed along with it (review of #16)
      const reached = reach(f.ws, f.fp.writes);
      const userPaths = reached.filter((p) => f.ws.exists(p) && this.ledger.ownerOf(`path:${p}`) === "user");
      if (userPaths.length) return { consequence: "modify_user", object, why: `changes the user's ${userPaths.join(", ")}` };
      // discarding content the task did not write (replace, trash) is the user's loss even on a path the task made
      const foreign = f.cap.discards ? reached.filter((p) => f.ws.exists(p) && !f.ws.isDir(p) && !this.taskContent.has(`${p}@${f.ws.version(p)}`)) : [];
      if (foreign.length) return { consequence: "modify_user", object, why: `discards content the task did not write: ${foreign.join(", ")}` };
      return { consequence: "create", object, why: "creates, or changes the task's own files" };
    }
    const object = objectOf(a);
    if (a.kind === "wait" || a.kind === "focus_window" || a.kind === "scroll") return { consequence: "read", object, why: "changes no content" };
    if (a.kind === "open_window") {
      // a URL handed to a browser the user already has open lands as a tab in their window (deskmind#73): that is
      // the user's thing and asks first; without a URL, or for an app not running, a new window of the task's own
      const theirs = a.url ? this.last?.windows.find((w) => w.owner === "user" && (w.app === a.app || w.id.startsWith(a.app + "#"))) : undefined;
      if (theirs) return { consequence: "modify_user", object: `window:${theirs.id}`, why: `opens ${a.url} in the user's ${a.app} window` };
      return { consequence: "create", object, why: "a window of the task's own" };
    }
    const owner = this.ledger.ownerOf(object);
    if (a.kind === "close_window") return owner === "user" ? { consequence: "modify_user", object, why: "closes the user's window" } : { consequence: "create", object, why: "closes the task's own window" };
    return owner === "user" ? { consequence: "modify_user", object, why: "acts in the user's window" } : { consequence: "create", object, why: "acts in the task's own window" };
  }

  /** The old structural send hints for a screen action: the target is marked `sends` (hands' name list), and Return or
   *  a typed newline in a window that has such a control — in every compose form the focus is on the text and the
   *  default button sends (review 10-18, T3). With a judge they are evidence for the outgoing question, not a class. */
  private hints(a: Action): { obs?: Observation; el?: Element; submits: boolean; sender?: Element } {
    if (!("window" in a)) return { submits: false };
    const obs = this.lastObs.get(a.window);
    const el = "target" in a && a.target ? obs?.elements.find((e) => e.id === a.target) : undefined;
    const submits = (a.kind === "key" && /\b(return|enter)\b/i.test(a.chord)) || (a.kind === "type" && a.text.includes("\n"));
    return { obs, el, submits, sender: obs?.elements.find((e) => e.sends) };
  }

  /** The minimum class from structure alone, the send hints included: what decides when no judge is attached (tests,
   *  the practice ground without a model). With a judge, `classify` uses `structure` and asks instead. */
  floor(a: Action): { consequence: Consequence; object: string; why: string } {
    const s = this.structure(a);
    if (s.consequence === "external" || a.kind === "file" || a.kind === "close_window" || a.kind === "open_window") return s;
    const h = this.hints(a);
    if (h.el?.sends) return { consequence: "external", object: s.object, why: `「${h.el.label}」 sends something out` };
    if (h.submits && h.sender) return { consequence: "external", object: s.object, why: `Return in a window where 「${h.sender.label}」 sends` };
    return s;
  }

  /** The text the task typed into the action's window so far, and what this action types. */
  private typedIn(a: Action): string[] {
    if (!("window" in a)) return [];
    return [...(this.typed.get(a.window) ?? []), ...(a.kind === "type" ? [a.text] : a.kind === "set_value" ? [a.value] : [])];
  }

  /** An action's class and who settled it (docs/outgoing-check-2026-10-20.md §4), from structured facts only — never
   *  the user's words: structure first (ownership; a capability that declares it sends), then the model's own class,
   *  then, for a screen action that changes something and is still below external, the judge's "will this send
   *  something out?" — which only raises: 会 / 拿不准 / no answer → external, 不会 → unchanged. Without a judge the old
   *  send hints decide (floor). Answered once per action per screen (epoch); `act` always calls it itself. */
  async classify(a: Action, epoch: number, declared?: Consequence): Promise<Classification> {
    const key = canon({ a, epoch, declared: declared ?? null });
    const hit = this.classified.get(key);
    if (hit) return hit;
    const s = this.structure(a);
    const model = declared && rank(declared) > rank(s.consequence);
    const settle = (c: Classification) => { this.classified.set(key, c); this.emit("executor.classify", { action: a, epoch, ...c }); return c; };
    const mine = (): Classification => ({ consequence: higher(s.consequence, declared ?? "read"), object: s.object, why: model ? `the model's class (${declared}); structure: ${s.why}` : s.why, by: model ? "model" : "structure" });
    if (s.consequence === "external") return settle({ ...s, by: "structure" });
    if (declared === "external") return settle(mine());
    const judge = this.opts.judge;
    if (!judge || !mightSend(a)) {
      // not a question for the judge (or none attached): the old hints still raise, as before
      const f = this.floor(a);
      if (f.consequence === "external") return settle({ ...f, by: "structure" });
      return settle(mine());
    }
    const h = this.hints(a);
    const els = h.obs?.elements ?? [];
    const screen = (e: Element) => (fromScreen(e) ? "画面（文字识别或补出来的控件，不是辅助功能树）" : "辅助功能树");
    const typed = this.typedIn(a);
    const ctx: Record<string, unknown> = {
      对象: s.object,
      动作: describeAction(a, h.obs, "read"),
      ...(a.kind === "key" ? { 按的键: a.chord } : {}),
      ...(a.kind === "type" ? { 输入的文字: a.text } : {}),
      目标元素: h.el ? { 角色: h.el.role, 名字: h.el.label, ...(h.el.value ? { 值: h.el.value } : {}), 来源: screen(h.el), 名字命中发送词表: !!h.el.sends } : null,
      窗口: h.obs ? { 应用: h.obs.window.app, 标题: h.obs.window.title, 归谁: h.obs.window.owner ?? null, ...(h.obs.window.url ? { 网址: h.obs.window.url } : {}), 有弹窗: h.obs.modal?.title ?? null } : null,
      窗口里标了会发出的其他元素: els.filter((e) => e.sends && e !== h.el).map((e) => ({ 角色: e.role, 名字: e.label, 来源: screen(e) })),
      窗口里的其他控件: els.filter((e) => e !== h.el && e.actions.length).slice(0, 60).map((e) => ({ 角色: e.role, 名字: e.label, ...(e.value ? { 值: e.value.slice(0, 80) } : {}), 来源: screen(e) })),
      ...(h.obs?.text ? { "窗口里的文字（前 800 字）": h.obs.text.slice(0, 800) } : {}),
      本次任务在这个窗口里打过的字: typed,
      结构线索: { 目标名字命中发送词表: !!h.el?.sends, 回车或换行: h.submits, 窗口里有名字命中发送词表的控件: !!h.sender },
    };
    const ans = await judge.choose(OUTGOING_QUESTION, ctx, OUTGOING_OPTIONS, undefined, { settle: "sends", route: false });
    if (!ans) return settle({ consequence: "external", object: s.object, why: "the outgoing check got no answer: treated as sending", by: "no_answer" });
    if (ans.choice !== "stays") return settle({ consequence: "external", object: s.object, why: `判官（${ans.by}）：${ans.choice === "sends" ? "会发出去" : "拿不准"}${ans.reason ? "。" + ans.reason : ""}`, by: ans.by });
    const m = mine();
    return settle({ ...m, why: `判官（${ans.by}）：不会发出去${ans.reason ? "。" + ans.reason : ""}；${m.why}`, by: ans.by });
  }

  /** What `act` would decide before doing anything, without waiting on a judge: `classify`'s answer when it has been
   *  given for this action on this screen (`by` says who settled it), otherwise structure with the send hints and the
   *  model's class — what `act` decides with no judge attached. Synchronous; `classify` is the full answer. */
  preview(req: Omit<ActRequest, "consent">): { consequence: Consequence; object: string; needs_consent: boolean; floor_why: string; by?: string } {
    const hit = this.classified.get(canon({ a: req.action, epoch: req.epoch, declared: req.consequence ?? null }));
    const f = hit ?? this.floor(req.action);
    const consequence = hit ? hit.consequence : higher(f.consequence, req.consequence ?? "read");
    const needs = NEEDS_CONSENT.has(consequence) && this.consent.check(req.action, f.object, consequence, this.opts.task) !== null;
    return { consequence, object: f.object, needs_consent: needs, floor_why: f.why, ...(hit ? { by: hit.by } : {}) };
  }

  async act(req: ActRequest): Promise<ActResult> {
    // until the action is classified below (after the checks that it is current), the structural floor stands in
    const f = this.floor(req.action);
    let consequence = higher(f.consequence, req.consequence ?? "read");
    let base = { consequence, object: f.object };
    const done = (r: ActResult): ActResult => {
      const { consent, ...rest } = req;
      this.receipts.push({ seq: this.receipts.length + 1, t: this.opts.now?.() ?? Date.now(), request: { ...rest, ...(consent ? { consent: { scope: consent.scope, nonce: consent.nonce } } : {}) }, result: r });
      this.emit("executor.act", { action: req.action, status: r.status, consequence: r.consequence, object: r.object, why: r.why ?? "" });
      return r;
    };
    if (this.stopped) return done({ ...base, status: "stopped", why: "the app stopped the task", epoch: this.epoch });
    let now = await this.driver.snapshot();
    if (now.locked) return done({ ...base, status: "environment", why: "the screen is locked", epoch: now.epoch });
    if (req.action.kind === "file") return done(await this.actFile(req.action, req.consent, consequence, f.object, now.epoch));
    // the user is at the keyboard: a window action now would fight them for it, whoever owns the window (D20). Read-only
    // looks are fine. The executor itself waits for them to pause (polling, up to a limit) rather than bouncing the
    // model, which burned a run's whole turn budget on "wait and try again" while the user watched (10-19)
    if (now.user_active && consequence !== "read") {
      const w = await this.waitForUser(now, f.object);
      now = w.now;
      if (w.end) return done({ ...base, ...w.end, epoch: now.epoch });
    }
    // after a wait too: what the user did meanwhile (selected another row) is not what the model decided on, so the
    // action would land on something else (review of #16: "delete selected" deleted B, decided on A)
    if (req.epoch !== now.epoch) return done({ ...base, status: "stale", why: `decided on epoch ${req.epoch}, the computer is at ${now.epoch}; observe again`, epoch: now.epoch });
    const target = "window" in req.action ? req.action.window : null;
    if (target && !now.windows.some((w) => w.id === target)) return done({ ...base, status: "stale", why: `window ${target} is gone`, epoch: now.epoch });
    // an element is addressed only through the window's last observation: a guessed id would skip the structural
    // floor (a `sends` button never seen is not known to send), so it is refused, not executed (review 10-18, T2)
    const obs = target ? this.lastObs.get(target) : undefined;
    if ("target" in req.action && req.action.target && !obs?.elements.some((e) => e.id === (req.action as { target: string }).target)) return done({ ...base, status: "stale", why: `element ${req.action.target} is not in the last observation of ${target}; observe the window first`, epoch: now.epoch });
    if (target && (req.action.kind === "key" || req.action.kind === "type") && !obs) return done({ ...base, status: "stale", why: `window ${target} was never observed; observe it first`, epoch: now.epoch });
    // the class above was read off that observation (a `sends` button, a compose form Return submits), and so are the
    // card and the consent: one older than the computer (a snapshot since gave the model a newer epoch) may show
    // "Preview" where the button now says "Send" — sent without asking — or draft A where B goes out (review of #16).
    // Any action that reads the observation, or needs consent, waits for the window to be looked at again
    const readsObs = ("target" in req.action && !!req.action.target) || req.action.kind === "key" || req.action.kind === "type";
    if (obs && obs.epoch !== now.epoch && (readsObs || NEEDS_CONSENT.has(consequence))) return done({ ...base, status: "stale", why: `the last observation of ${target} is from epoch ${obs.epoch}, the computer is at ${now.epoch}; observe the window again`, epoch: now.epoch });
    // the class, settled here and never taken from the caller: structure, the model's class, and the judge's "will this
    // send something out?" (only raises; cached, so a preview's or a classify call's answer is the same one)
    const asked = this.classified.size;
    const c = await this.classify(req.action, req.epoch, req.consequence);
    consequence = c.consequence; base = { consequence, object: c.object };
    if (this.classified.size !== asked && c.by !== "structure" && c.by !== "model" && !NEEDS_CONSENT.has(consequence)) {
      // a judge answered over the network and nothing below waits again: the computer is looked at once more, as after
      // the intent check (an action with consent is looked at again there)
      now = await this.driver.snapshot();
      if (now.locked) return done({ ...base, status: "environment", why: "the screen is locked", epoch: now.epoch });
      if (now.user_active) { const w = await this.waitForUser(now, c.object); now = w.now; if (w.end) return done({ ...base, ...w.end, epoch: now.epoch }); }
      if (req.epoch !== now.epoch) return done({ ...base, status: "stale", why: `the computer changed while this step was being checked (epoch ${req.epoch}, now ${now.epoch}); observe again`, epoch: now.epoch });
      if (target && !now.windows.some((w) => w.id === target)) return done({ ...base, status: "stale", why: `window ${target} is gone`, epoch: now.epoch });
    }
    if (NEEDS_CONSENT.has(consequence) && !this.planAccepted) return done({ ...base, status: "needs_plan", why: "touching the user's things or sending something out needs a plan first: call plan with the objects, your readings and their evidence", epoch: now.epoch });
    if (NEEDS_CONSENT.has(consequence)) {
      // a send shows what goes out (the filled-in fields, what the window is about): the user checks it on the card
      // and the judge reads it, not only the Send button (review of #16)
      // what the task typed into this window goes on the card when the window does not show it (a window read from the
      // screen: text recognition may not read the input box), and is bound with the consent in every case — changed
      // text is another send, asked again
      const sending = consequence === "external" ? outgoing(obs) : null;
      const typed = sending ? this.typedIn(req.action).filter((t) => t.trim()) : [];
      const typedLines = typed.filter((t) => ![...sending!.fields, ...sending!.shown].some((l) => l.includes(t.trim())));
      const content = sending ? (typed.length ? { ...(sending.bound as object), typed } : sending.bound) : undefined;
      const text = describeAction(req.action, obs, consequence, undefined, this.opts.lang) + (sending ? T(this.opts.lang).outgoing([...sending.fields, ...typedLines.map((t) => T(this.opts.lang).typed(t.trim()))], sending.shown) : "");
      const el = "target" in req.action && req.action.target ? obs?.elements.find((e) => e.id === (req.action as { target: string }).target) : undefined;
      const judged = await this.judgeIntent(req.action, consequence, base.object, { 窗口: obs ? { app: obs.window.app, title: obs.window.title, owner: obs.window.owner } : null, ...(el ? { 元素: { role: el.role, label: el.label, value: el.value } } : {}), ...(sending ? { 将发出的内容: { 字段: sending.fields, 窗口里的其他文字: sending.shown, ...(typed.length ? { 本次任务在这个窗口里打的字: typed } : {}) } } : {}), ...(req.purpose ? { 模型说的目的: req.purpose } : {}) }, text);
      if (judged.verdict === "mismatch") return done({ ...base, status: "refused", why: `意图核对（${judged.by}）：不是用户要的。${judged.reason}`, epoch: now.epoch });
      // the judge answers over the network: the user may have selected another row meanwhile, and the action would land
      // on something the judge never saw — the computer is looked at again, as at the top (the file twin is in actFile)
      now = await this.driver.snapshot();
      if (now.locked) return done({ ...base, status: "environment", why: "the screen is locked", epoch: now.epoch });
      // the user came back to the keyboard meanwhile, before anything on screen moved: wait for them, as at the top
      if (now.user_active) {
        const w = await this.waitForUser(now, base.object);
        now = w.now;
        if (w.end) return done({ ...base, ...w.end, epoch: now.epoch });
      }
      if (req.epoch !== now.epoch) return done({ ...base, status: "stale", why: `the computer changed while this step was being checked (epoch ${req.epoch}, now ${now.epoch}); observe again`, epoch: now.epoch });
      if (target && !now.windows.some((w) => w.id === target)) return done({ ...base, status: "stale", why: `window ${target} is gone`, epoch: now.epoch });
      // a send's consent is for what it sends: the draft changed since the card is another send, asked again
      const why = this.consent.check(req.action, base.object, consequence, this.opts.task, req.consent, content);
      if (why) {
        const challenge = this.consent.challenge(req.action, base.object, consequence, text, undefined, content);
        this.emit("executor.consent_needed", { why, consequence, object: base.object });
        return done({ ...base, status: "needs_consent", why, challenge, epoch: now.epoch });
      }
    }
    const before = "window" in req.action ? this.lastObs.get(req.action.window) ?? null : null;
    // a real driver can fail on either side of the action: that is a result the model reads, never an exception
    let r: PerformResult;
    // the stop switch is read again here, after the waits above (the judge, the user's consent): a stop that arrived
    // meanwhile must not be followed by the effect (review of deskmind#80, 10-18)
    if (this.stopped) return done({ ...base, status: "stopped", why: "the app stopped the task", epoch: this.epoch });
    if (consequence !== "read") this.journal("intent", { action: req.action, object: base.object, consequence, text: describeAction(req.action, obs, consequence) });
    const filesBefore = consequence !== "read" ? this.fileVersions() : null;
    try { r = await this.driver.perform(req.action); } catch (e) { r = { status: "error", why: e instanceof Error ? e.message : String(e) }; }
    if (this.opts.crashAfterFirstEffect && !this.crashed && r.status === "ok" && consequence !== "read") { this.crashed = true; throw new Crash("crash after the effect, before the receipt"); }
    if (consequence !== "read") this.journal("receipt", { status: r.status });
    // what the task typed into a window: evidence for later outgoing questions and what a later send's card shows; a
    // send that went through took it with it
    if ((r.status === "ok" || r.status === "unverified") && "window" in req.action) {
      if (consequence === "external") this.typed.delete(req.action.window);
      else if (req.action.kind === "type" || req.action.kind === "set_value") this.typed.set(req.action.window, this.typedIn(req.action));
    }
    // a window is the task's (and closing it takes the opening back) only on the driver's proof that the action made
    // it (`new_window`) and when it was not on screen before. The window an action merely lands in is not proof: a URL
    // put into the user's browser window returns that window (review of #16), and an app launched by open_window comes
    // back with the windows it restores from its last session, which are the user's (hands PR #48, fourth review: the
    // driver reports `new_window` only for a window it can prove it made)
    const openedId = r.new_window?.id;
    if (openedId && !now.windows.some((w) => w.id === openedId)) { this.ledger.created(`window:${openedId}`); this.openedWindows.set(this.receipts.length + 1, openedId); }
    // files the action wrote through the app (a save sheet, cmd+s): the task's own effect, like a window it opened —
    // credited to it once the window is read back (its name there is the evidence), not found later as "changed by
    // another program" (rc.1 end-to-end: hello.txt, 10-18)
    const wrote = r.status === "ok" && consequence !== "read" ? this.creditFiles(this.fileChanges(filesBefore), r.files) : [];
    let after: Snapshot;
    try { after = await this.driver.snapshot(); } catch (e) { return done({ ...base, status: r.status === "ok" ? "unverified" : "error", why: `${r.why ?? ""}; after the action the computer could not be read: ${e instanceof Error ? e.message : e}`.replace(/^; /, ""), epoch: this.epoch }); }
    this.epoch = after.epoch;
    if (after.locked) return done({ ...base, status: r.status === "ok" ? "unverified" : "environment", why: `${r.why ?? ""}; the screen is locked`.replace(/^; /, ""), epoch: after.epoch });
    const status = r.status === "ok" ? "ok" : r.status === "unverified" ? "unverified" : r.status === "blocked" ? "blocked" : r.status === "unsupported" ? "refused" : "error";
    const out: ActResult = { ...base, status, why: r.why, epoch: after.epoch, ...(wrote.length ? { files: wrote } : {}) };
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

  /** The user is at the keyboard: wait for them to pause (polling, up to a limit). Returns the computer as it is after,
   *  and why the action ends instead when they did not pause or the app stopped the task. */
  private async waitForUser(now: Snapshot, object: string): Promise<{ now: Snapshot; end?: { status: "blocked" | "stopped"; why: string } }> {
    const wait = this.opts.userWait ?? { ms: 120_000, pollMs: 2_000 };
    const until = (this.opts.now?.() ?? Date.now()) + wait.ms;
    this.emit("executor.user_wait", { object });
    while (now.user_active && (this.opts.now?.() ?? Date.now()) < until && !this.stopped) {
      await new Promise((r) => setTimeout(r, wait.pollMs));
      now = await this.driver.snapshot();
    }
    // every wait ends with a resumed, whichever way it ends: the app clears its "paused" state on it (deskmind#85). A
    // stop is said as a stop even when the user is still at the keyboard — it ended the wait, not they (a stop that
    // came before the first look used to be reported "blocked: try again later")
    if (this.stopped) { this.emit("executor.user_resumed", { stopped: true }); return { now, end: { status: "stopped", why: "the app stopped the task" } }; }
    if (now.user_active) { this.emit("executor.user_resumed", { timed_out: true }); return { now, end: { status: "blocked", why: `the user has been using the computer for the last ${Math.round(wait.ms / 1000)} s; try again later` } }; }
    this.emit("executor.user_resumed", {});
    return { now };
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
    // Files (not folders: a folder's version moves with its children) that changed since the task last saw them were
    // changed by someone else — a fact, recorded. A write on such a file is refused until the task has read it again;
    // a read is that reading, so it goes ahead (refusing a read with "read it first" went in circles in rc.1). Only
    // the read moves what the task has seen: a refusal does not, or the same write retried unread went through
    // (review of #16).
    // a written folder is checked by the files in it: trashing folder/ while the user edits folder/note.txt is a write
    // on their edit (review of #16)
    const touched = [...new Set([...fp.reads, ...fp.writes])].filter((p) => ws.exists(p) && !ws.isDir(p));
    const checked = [...new Set([...touched, ...reach(ws, fp.writes)])].filter((p) => ws.exists(p) && !ws.isDir(p));
    const changed = checked.filter((p) => p in this.seen && this.seen[p] !== ws.version(p));
    if (changed.length) {
      for (const p of changed) this.noteExternal(p, this.seen[p] ?? "absent", ws.version(p));
      this.emit("executor.external_change", { paths: changed });
      if (cap.effect !== "observe") return { ...base, status: "stale", why: `changed since you last saw it (by another program): ${changed.join(", ")}. Read it again and decide anew; its content is not yours to undo.` };
    }
    const unseen = fp.writes.filter((p) => ws.exists(p) && !ws.isDir(p) && !(p in this.seen));
    if (unseen.length && cap.effect !== "observe") return { ...base, status: "stale", why: `never read: ${unseen.join(", ")}. Read it first, then decide.` };
    // a written folder holds only what the task knows is there: something put in since it last looked (and not listed)
    // goes with the folder unseen — look again first (review of #16)
    const dirs = fp.writes.filter((p) => ws.exists(p) && ws.isDir(p));
    const appeared = reach(ws, dirs).filter((p) => !dirs.includes(p) && !(p in this.seen) && !this.listed.has(p));
    if (appeared.length && cap.effect !== "observe") {
      for (const p of appeared) if (!ws.isDir(p)) this.noteExternal(p, "absent", ws.version(p));
      this.emit("executor.external_change", { paths: appeared });
      return { ...base, status: "stale", why: `new in ${dirs.join(", ")} since you last looked (by another program): ${appeared.join(", ")}. List it again and decide anew.` };
    }
    const pre = cap.preconditions(ws, a.args);
    if (pre) return { ...base, status: "error", why: `precondition: ${pre}` };
    if (NEEDS_CONSENT.has(consequence) && !this.planAccepted) return { ...base, status: "needs_plan", why: "changing the user's files or sending something out needs a plan first: call plan with the paths, your readings and their evidence" };
    if (NEEDS_CONSENT.has(consequence)) {
      const text = describeAction(a, undefined, consequence, cap, this.opts.lang);
      const evidence: Record<string, unknown> = {};
      for (const p of touched) if (!ws.isDir(p)) evidence[`文件 ${p} 现在的内容（前 600 字）`] = ws.readForModel(p, 600);
      for (const d of dirs) evidence[`文件夹 ${d} 里的东西（会一起受影响）`] = reach(ws, [d]).filter((p) => p !== d).slice(0, 100);
      const members = new Set(reach(ws, fp.writes));
      const judgedOn: Record<string, string> = {};
      for (const p of new Set([...fp.reads, ...reach(ws, fp.writes)])) if (!ws.isDir(p)) judgedOn[p] = ws.version(p);
      const judged = await this.judgeIntent(a, consequence, object, evidence, text);
      // the screen first: locked meanwhile, the task stops, a file action as much as a window one. It is the last
      // wait: from the versions read below to the write there is none, or another program's edit made during it
      // would be overwritten unchecked (review of #16: the lock look, put after the checks, opened just that gap)
      const screen = await this.driver.snapshot();
      if (screen.locked) return { ...base, status: "environment", why: "the screen is locked", epoch: screen.epoch };
      // the judge answers over the network: a file the user changed meanwhile is not the one it judged, and writing
      // now would overwrite their edit (review of #16) — read the versions again, as at the top
      ws.invalidate();
      // and what a written folder holds: a file put into it meanwhile is not in the versions above (review of #16)
      const moved = [...Object.keys(judgedOn).filter((p) => ws.version(p) !== judgedOn[p]), ...reach(ws, fp.writes).filter((p) => !members.has(p))];
      if (moved.length) {
        for (const p of moved) if (!ws.isDir(p)) this.noteExternal(p, judgedOn[p] ?? "absent", ws.version(p));
        this.emit("executor.external_change", { paths: moved });
        return { ...base, status: "stale", why: `changed while this step was being checked (by another program): ${moved.join(", ")}. Read it again and decide anew; its content is not yours to undo.` };
      }
      // and what the action needs of the folder still holds (the folder it writes into is still a folder, not a link
      // put there meanwhile to somewhere outside: review of #16)
      let still: string | null;
      try { still = cap.preconditions(ws, a.args); } catch (e) { still = e instanceof Error ? e.message : String(e); }
      if (still) return { ...base, status: "stale", why: `changed while this step was being checked: ${still}. Look again and decide anew.` };
      if (judged.verdict === "mismatch") return { ...base, status: "refused", why: `意图核对（${judged.by}）：不是用户要的。${judged.reason}` };
      const why = this.consent.check(a, object, consequence, this.opts.task, consent);
      if (why) {
        const challenge = this.consent.challenge(a, object, consequence, text);
        this.emit("executor.consent_needed", { why, consequence, object });
        return { ...base, status: "needs_consent", why, challenge };
      }
    }
    if (this.stopped) return { ...base, status: "stopped", why: "the app stopped the task" };   // read again after the waits above
    const existed = fp.writes.filter((p) => ws.exists(p));
    const undo_prep = cap.prepareUndo?.(ws, a.args);
    const versions_before: Record<string, string> = {};
    for (const p of [...fp.reads, ...fp.writes]) versions_before[p] = ws.version(p);
    // the folders on the way to a written path that are not there yet: the step makes them (mkdir -p, a save into a
    // new folder) and its undo takes them away, though they are not among its writes — undo's paper needs them
    // (review of #16: parent/child made by "mkdir parent/child/grandchild"). Kept for undo only, not journaled: a
    // restart compares the journal's versions with the disk, and a folder's version moves with what is in it
    const madeParents = [...new Set(fp.writes.flatMap((p) => { const out: string[] = []; for (let a = parentOf(p); a; a = parentOf(a)) if (!ws.exists(a)) out.push(a); return out; }))];
    if (cap.effect !== "observe") this.journal("intent", { action: a, object, consequence, text: describeAction(a, undefined, consequence, cap), versions_before, expect_after: (fp as { expectAfter?: Record<string, string> }).expectAfter ?? {} });
    let r: ReturnType<Capability["execute"]>;
    try { r = cap.execute(ws, a.args); } catch (e) { ws.invalidate(); if (e instanceof Crash) throw e; return { ...base, status: "error", why: e instanceof Error ? e.message : String(e) }; }
    ws.invalidate();
    if (this.opts.crashAfterFirstEffect && !this.crashed && r.status === "ok" && cap.effect !== "observe") { this.crashed = true; throw new Crash("crash after the effect, before the receipt"); }
    if (cap.effect !== "observe") this.journal("receipt", { status: r.status, versions_after: r.versions_after ?? {} });
    if (r.status !== "ok") return { ...base, status: "error", why: r.why ?? r.status };
    if (cap.effect !== "observe") this.fileReceipts.set(this.receipts.length + 1, { cap, args: a.args, writes: fp.writes, versions_before, madeParents, exec: { status: r.status, versions_after: r.versions_after, undo: r.undo }, ...(undo_prep ? { undo_prep } : {}) });
    const gone = existed.filter((p) => !ws.exists(p));
    for (const p of fp.writes) {
      const v = ws.version(p);
      this.seen[p] = v;
      if (ws.exists(p) && !ws.isDir(p)) this.taskContent.add(`${p}@${v}`);
      if (!existed.includes(p) && ws.exists(p)) { if (gone.length) this.ledger.inherits(`path:${p}`, `path:${gone[0]}`); else this.ledger.created(`path:${p}`); }
    }
    for (const p of fp.reads) this.seen[p] = ws.version(p);        // a read is an observation
    // a listed folder's members are known to be there — the ones the listing returned, not the ones a bounded listing
    // left out (review of #16: the 201st file) — their content is not read: a write on one still needs a read
    const shown = Array.isArray(r.output?.entries) ? (r.output.entries as { path?: unknown }[]).map((e) => e.path).filter((x): x is string => typeof x === "string") : [];
    for (const p of fp.reads) if (ws.isDir(p)) for (const x of shown) if (parentOf(x) === p) this.listed.add(x);
    return { ...base, status: "ok", output: r.output ?? {} };
  }

  /** The evidence for a final judgement: the computer now, and every window the task touched or created, observed
   *  again. Who judges is the runtime's `verify` role; what it judges on is this. */
  async verify(): Promise<{ snapshot: Snapshot; windows: Observation[]; unreadable: { window: string; why: string }[]; receipts: Receipt[]; external_changes: ExternalChange[] }> {
    const s = await this.snapshot();
    // every window the task looked at or made, not only the ones it changed: a judge has to see the state of a
    // window a refused action never reached, too
    const touched = new Set<string>(this.lastObs.keys());
    for (const r of this.receipts) if ("window" in r.request.action && (r.result.status === "ok" || r.result.status === "unverified")) touched.add(r.request.action.window);
    for (const o of this.ledger.taskObjects()) if (o.startsWith("window:")) touched.add(o.slice(7));
    const windows: Observation[] = [], unreadable: { window: string; why: string }[] = [];
    // a window that cannot be read is said so, not a reason to throw the verdict away: a driver that reads only the
    // window it was asked for (hands f4c4621: it no longer passes another window's content off under this one's id)
    // fails such a look outright, and the judge decides on the rest
    for (const id of touched) if (s.windows.some((w) => w.id === id)) {
      try { windows.push(await this.observe(id)); } catch (e) { unreadable.push({ window: id, why: e instanceof Error ? e.message : String(e) }); }
    }
    return { snapshot: s, windows, unreadable, receipts: this.receipts, external_changes: this.externalChanges };
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
      ...(ev.unreadable.length ? { "任务看过、现在读不出来的窗口（只知道读不出来，不知道它现在的样子）": ev.unreadable } : {}),
      执行层的回执: ev.receipts.map((r) => ({ action: r.request.action, status: r.result.status, consequence: r.result.consequence })),
      // what the task read (file reads, listings): the content it decided on is evidence the judge can quote
      "任务读到过的内容（文件读取的输出，每条最多 1500 字）": ev.receipts.filter((r) => r.request.action.kind === "file" && r.result.output && Object.keys(r.result.output).length).slice(-8).map((r) => ({ action: r.request.action, output: JSON.stringify(r.result.output).slice(0, 1500) })),
      ...(ev.external_changes.length ? { "任务期间被别的程序改过的文件（这些改动不是本任务造成的，保留它们不算违反需求）": ev.external_changes.map((c) => c.path) } : {}),
      ...(this.unconfirmed.length ? { "任务做界面操作期间出现或变化、来源未确认的文件（驱动没有说是这次动作写的：可能是任务在应用里的保存，也可能是别的程序；做没做成看它们现在的内容，来源未确认不算没做成）": this.unconfirmed.map((c) => c.path) } : {}),
      ...(ws ? { 任务目录现在的内容: ws.listing(), "任务目录现在的版本（路径 → 版本，和开始时逐条比就知道哪些没动过；文件夹的版本随内容变）": Object.fromEntries(Object.keys(ws.entries()).map((p) => [p, ws.version(p)])) } : {}),
      ...(this.startTree ? { "任务开始时的目录（路径 → 版本；小文件带内容）": this.startTree } : {}),
      ...extra,
      模型自称: summary,
    };
    if (!this.opts.judge) return { verdict: "unknown", reason: "no judge to verify with" };
    const ans = await this.opts.judge.choose(VERIFY_QUESTION, { ...this.userWords(), 证据: evidence }, VERIFY_OPTIONS, "verify");
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
      if (a.kind === "open_window") { steps.push(this.openedWindows.has(r.seq) ? { seq: r.seq, text: t.openWindow(a.app), can: true } : { seq: r.seq, text: t.openWindow(a.app), can: false, why: t.openedInYours }); continue; }
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
    // check every file step first, as the orchestrator's undoRun does: nothing is touched unless all of them can be
    // taken back (review of #16: second.txt was deleted, then the user's edit to first.txt stopped the undo). The
    // folder is played backwards on paper (paper.ts): newest step first, each path the step wrote — a folder too, its
    // version worked out from what is in it on paper — must be as the step left it, and the capability's own check (a
    // folder holding only ours, the folder a moved file goes back to) must pass on the paper folder as it will be when
    // that step's undo runs; then the step is taken back on paper
    const files = plan.steps.map((st) => this.fileReceipts.get(st.seq)).filter((f) => !!f);
    const ours = new Set(files.flatMap((f) => f.writes));
    const paper = files.length ? new PaperFolder(ws!) : null;
    for (const f of files) {
      const before = (p: string) => f.versions_before[p] ?? "absent", left = (p: string) => f.exec.versions_after[p];
      const moved = f.writes.find((p) => left(p) !== undefined && left(p) !== paper!.version(p));
      const why = moved !== undefined ? `changed since the action: ${moved}` : f.cap.undoCheck?.(paper!.asWorkspace, f.args, { ...f.exec, output: {}, undo: f.exec.undo ?? f.undo_prep } as never, ours) ?? null;
      if (why) { this.emit("executor.undo_refused", { why, undone: 0, checked_first: true }); return { undone: 0, total: plan.steps.length, refused: why }; }
      paper!.takeBack(f.writes, before, left, f.madeParents);
    }
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
        const id = this.openedWindows.get(r.seq);
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
  changes(): { created: string[]; modified: string[]; deleted: string[]; external: string[]; unconfirmed: string[] } {
    const ws = this.opts.files?.workspace, start = this.startTree?.versions ?? {};
    const unconfirmed = new Set(this.unconfirmed.map((c) => c.path));
    if (!ws) return { created: [], modified: [], deleted: [], external: this.externalChanges.map((c) => c.path), unconfirmed: [...unconfirmed] };
    const now = ws.entries();
    const external = new Set(this.externalChanges.map((c) => c.path));
    // a change of unknown origin (unconfirmed) is listed apart, like another program's: not under created / modified
    const apart = (p: string) => external.has(p) || unconfirmed.has(p);
    return {
      created: Object.keys(now).filter((p) => !(p in start) && !apart(p)),
      modified: Object.keys(now).filter((p) => p in start && start[p] !== (now[p] === "dir" ? ws.version(p) : now[p]) && now[p] !== "dir" && !apart(p)),
      deleted: Object.keys(start).filter((p) => !(p in now)),
      external: [...external],
      unconfirmed: [...unconfirmed].filter((p) => !external.has(p)),
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

/** What a write on these paths reaches: each path, and everything under the ones that are folders. */
function reach(ws: Workspace, paths: string[]): string[] {
  const all = Object.keys(ws.entries());
  return [...new Set(paths.flatMap((p) => (ws.isDir(p) ? [p, ...all.filter((x) => x.startsWith(p + "/"))] : [p])))];
}

/** What a send in this window would send, for the card and the consent. `fields`: every element that holds content —
 *  a value (typed, picked, or only shown) or, with nothing to do on it, a text of its own (a confirmation page's
 *  "Recipient: Alice" may be only a label) — and what is selected (the recipient's row); `shown`: every line of the
 *  window's text those do not already carry. The card shows both, whole, under the window's title. `bound` is what
 *  the consent binds: the whole observation as it is — the title, the dialog, the text, and every element's role,
 *  label, value, focus, state and options — so a send whose window changed in any way since the card is asked
 *  again. Not a list of which parts count as "content": that list was short of one part in each of five rounds of
 *  "Alice approved, Bob sent" (a typed field, a pop-up, a read-only value, a label, the title or a selection). */
export function outgoing(obs: Observation | undefined): { fields: string[]; shown: string[]; bound: unknown } {
  const els = obs?.elements ?? [];
  const fields = [
    ...els.filter((e) => e.value || (!e.actions.length && e.label)).map((e) => (e.value ? `${e.label}：${e.value}` : e.label)),
    ...els.filter((e) => e.focused && !e.value && e.actions.length && !e.sends).map((e) => `✓ ${e.label}`),
  ];
  const shown = (obs?.text ?? "").split("\n").map((l) => l.trim()).filter((l) => l && !fields.some((f) => f.includes(l)));
  // where it goes: a page's address may be only in the window's metadata (review of #16: a webview switched sites)
  if (obs?.window.url) fields.unshift(`URL：${obs.window.url}`);
  const bound = obs ? {
    window: { app: obs.window.app, title: obs.window.title, url: obs.window.url ?? null, tabs: (obs.window.tabs ?? []).map((t) => ({ title: t.title, url: t.url, active: !!t.active })) }, modal: obs.modal, text: obs.text ?? "",
    elements: els.map((e) => ({ role: e.role, label: e.label, value: e.value ?? null, focused: !!e.focused, enabled: e.enabled !== false, options: e.options ?? null, in_modal: !!e.in_modal, sends: !!e.sends })),
  } : null;
  return { fields, shown, bound };
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
  const what = a.kind === "click" ? t.click(el?.label ?? a.target) : a.kind === "double_click" ? t.doubleClick(el?.label ?? a.target)
    : a.kind === "set_value" ? t.set(el?.label ?? a.target, a.value)
    : a.kind === "type" ? t.type(el?.label ?? a.target, a.text)
    : a.kind === "select" ? t.select(el?.label ?? a.target, a.option)
    : a.kind === "key" ? t.key(a.chord)
    : a.kind === "close_window" ? t.closeWindow : a.kind === "open_window" ? t.openWindow(a.app) : a.kind === "focus_window" ? t.focusWindow : a.kind === "scroll" ? t.scroll : t.wait;
  const cls = consequence === "external" ? t.sends : consequence === "modify_user" ? t.modifies : "";
  return `${where ? t.at(where) : ""}${what}${cls ? "（" + cls + "）" : ""}`;
}

export type { WindowInfo };
