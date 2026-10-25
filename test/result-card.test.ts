/**
 * M2 H2 — "A task that changed things always ends with a result card. Undo appears exactly when every change can be
 * undone, while its window is open" (owner 10-24). Before, only a succeeded task had a result card: a stopped,
 * failed, cancelled or unconfirmed task that had changed the user's files offered no undo at all; a step done but not
 * read back (unverified) was left out of the undo plan, so a task whose screen step went unverified offered an undo
 * of the rest; the signal's forced end wrote no card; the session dropped the card of a task that could not linger.
 * The undo window is 600 s by the wall clock (a Mac asleep past it closes it on waking), or until any new computer
 * task starts on this Mac, or the session ends; `undo_until` says when.
 *
 * app-run in process on the simulated desktop, a scripted runtime and judges; the session tests go through the
 * session's controls with the executor in process and a fake clock. The oracle is the simulated desktop's ground
 * truth: the task folder on disk before and after, and every action the simulated driver was asked to perform.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { appRun, LineReader } from "../src/cli/app.js";
import type { AppEvent } from "../src/protocol/events.js";
import { SimComputer } from "../src/executor/sim.js";
import { OUTGOING_QUESTION } from "../src/executor/judge.js";
import { Gateway } from "../src/gateway/index.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";
import type { Clock } from "../src/executor/clock.js";
import type { Action } from "../src/executor/types.js";
import { SessionHost } from "../src/session/host.js";
import type { ExecutorHandle, Launcher } from "../src/session/task.js";
import { fallbackCard } from "../src/session/host.js";
import { journalSteps, parseJournal, possiblyDone } from "../src/executor/possibly.js";
import { Executor } from "../src/executor/executor.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Workspace, forgetVolumeNames } from "../src/registry/workspace.js";
import { execFileSync } from "node:child_process";
import { fileRegistry } from "../src/registry/fs.js";
import fsCjs from "node:fs";
import { syncBuiltinESMExports } from "node:module";

/** Wall time and timers apart (see card-expiry.test.ts): `sleep` moves the wall clock only, as a Mac's sleep does. */
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
}

const roles = ["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"];
const MODEL = { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as never;
const gateway = () => {
  const gw = new Gateway(Object.fromEntries(roles.map((r) => [r, { backend: "scripted", model: "scripted" }])) as never);
  gw.script = Array(300).fill((role: string, _s: string, u: string) => (role === "verify" ? { choice: "pass", reason: "做完了" } : u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: "stays" } : { choice: "matches" }));
  return gw;
};
const lastJson = (ms: any[]) => { const m = [...ms].reverse().find((x) => x.role === "toolResult"); try { return JSON.parse(m.content[0].text.split("\n")[0]); } catch { return {}; } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (cond: () => unknown, ms = 8000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(2); } };

/** The task folder as it is on disk: every file's content and every folder, by relative path. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      // the harness's own folders (registry/workspace.ts TMP, TRASH, UNDO_DIR): never the user's, never listed
      if (!rel && (e.name === ".deskmind-tmp" || e.name === ".deskmind-trash" || e.name === ".deskmind-undo")) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out[p + "/"] = "dir"; walk(p); } else out[p] = fs.readFileSync(path.join(root, p), "utf-8");
    }
  };
  walk("");
  return out;
}

/** A task folder with two of the user's files, and a simulated desktop with the user's editor. */
function desk(base = os.tmpdir()) {
  const scope = fs.mkdtempSync(path.join(base, "result-card-"));
  fs.mkdirSync(path.join(scope, "notes"));
  fs.writeFileSync(path.join(scope, "notes", "u1.txt"), "一");
  fs.writeFileSync(path.join(scope, "u2.txt"), "二");
  const sim = new SimComputer(scope);
  const w = sim.addEditor("编辑器", { title: "笔记.txt", text: "旧的", path: null }).id;
  const performed: Action[] = [];
  const perform = sim.perform.bind(sim);
  sim.perform = (a: Action) => { performed.push(a); return perform(a); };
  return { scope, sim, w, performed, before: tree(scope) };
}
type Desk = ReturnType<typeof desk>;

/** How the app answers: every plan card and action card approved; the question card (ask_user) as the end path says. */
type End = "succeeded" | "failed" | "unconfirmed" | "cancelled" | "stopped" | "app_gone" | "environment";

/** app-run in process: `steps` then the end. After task_done the app either answers the result card's undo
 *  (`undo: true`, when it offers one) or closes stdin. */
function runTask(d: Desk, steps: Step[], end: End, o: { undo?: boolean; linger?: number; stopAfterSteps?: number; clock?: Clock; signalAfterMs?: number } = {}) {
  const input = new PassThrough();
  const events: AppEvent[] = [];
  const write = (c: unknown) => input.write(JSON.stringify(c) + "\n");
  let results = 0;
  const out = (e: AppEvent) => {
    events.push(e);
    if (e.kind === "step_result" && o.stopAfterSteps !== undefined && ++results === o.stopAfterSteps) write({ type: "stop" });
    if (e.kind === "ask") {
      const pick = (k: string) => e.card.options.findIndex((x) => x.kind === k);
      if (e.card.kind === "missing") {
        if (end === "cancelled") setTimeout(() => write({ type: "answer", ask_id: e.ask_id, option: pick("cancel") }), 1);
        else if (end === "stopped") setTimeout(() => write({ type: "stop" }), 1);
        else if (end === "app_gone") setTimeout(() => input.end(), 1);
      } else setTimeout(() => write({ type: "answer", ask_id: e.ask_id, option: pick("approve") }), 1);
    }
    if (e.kind === "task_done" && end !== "app_gone") {
      const i = e.result_card?.options.findIndex((x) => x.kind === "undo") ?? -1;
      setTimeout(() => { if (o.undo && i >= 0) write({ type: "respond", option: i }); else input.end(); }, 1);
    }
  };
  const tail: Step[] = end === "succeeded" ? [{ calls: [{ name: "finish", args: { outcome: "done", summary: "做完了" } }] }]
    : end === "failed" ? [{ calls: [{ name: "finish", args: { outcome: "cannot", summary: "做不了" } }] }]
    : end === "unconfirmed" ? [{ calls: [{ name: "finish", args: { outcome: "unconfirmed", summary: "没法确认", missing: ["结果"] } }] }]
    : end === "environment" ? [() => { d.sim.lock(); return { calls: [{ name: "computer_act", args: { action: { kind: "wait", ms: 1 }, epoch: 1, consequence: "read", purpose: "等一下" } }] }; }]
    : [{ calls: [{ name: "ask_user", args: { question: "还要接着做吗？", options: ["接着做"] } }] }];
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "result-card-runs-"));
  // signalAfterMs: the executor is ended by a signal that long after the first step began (it dies with what is out)
  let signal: ((sig: string) => void) | null = null, exited!: () => void;
  const exitedP = new Promise<void>((res) => { exited = res; });
  if (o.signalAfterMs !== undefined) { let once = false; const t0 = setInterval(() => { if (!once && events.some((e) => e.kind === "step") && signal) { once = true; clearInterval(t0); setTimeout(() => signal!("SIGTERM"), o.signalAfterMs); } }, 5); }
  const run = appRun({ run_id: "run_h2", raw: "整理一下笔记和文件", config: "ds-flash", scope: d.scope }, {
    runs, out, input: new LineReader(input), linger: o.linger ?? 5,
    ...(o.signalAfterMs !== undefined ? { signals: { onSignal: (h: (sig: string) => void) => { signal = h; }, exit: () => exited(), exitNow: () => exited(), deadlineMs: 50, waitMs: 100 } } : {}),
    inject: { driver: d.sim, gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream([...steps, ...tail, { calls: [{ name: "finish", args: { outcome: "done", summary: "做完了" } }] }]) }, ...(o.clock ? { clock: o.clock } : {}) },
  });
  // (a signal's end returns from appRun only when the run does; the test waits for its exit instead)
  const done = o.signalAfterMs !== undefined ? Promise.race([run, exitedP]) : run;
  const taskDone = () => events.find((e): e is Extract<AppEvent, { kind: "task_done" }> => e.kind === "task_done");
  return { events, done, taskDone, input, dir: path.join(runs, "run_h2") };
}

/** The changes a task makes. file: one new file (its capability has an undo). gui: the user's editor's text set on
 *  screen. unsure: a new file, then a key pressed in the editor that the driver did but could not read back. */
type Change = "none" | "file" | "gui" | "unsure";
function changeSteps(d: Desk, c: Change): Step[] {
  const create: Step = { calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] };
  const plan: Step[] = [
    { calls: [{ name: "plan", args: { steps: [{ purpose: "改笔记", objects: [`window:${d.w}`], consequence: "modify_user" }] } }] },
    { calls: [{ name: "computer_observe", args: { window: d.w } }] },
  ];
  if (c === "none") return [{ calls: [{ name: "computer_snapshot", args: {} }] }];
  if (c === "file") return [create];
  if (c === "gui") return [...plan, (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "set_value", window: d.w, target: `${d.w}:0:textarea`, value: "新的" }, epoch: lastJson(m).epoch, consequence: "modify_user", purpose: "改正文" } }] })];
  return [create, ...plan, (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "key", window: d.w, chord: "cmd+k" }, epoch: lastJson(m).epoch, consequence: "modify_user", purpose: "按一下" } }] })];
}

describe("H2: every end path × every kind of change → result card and undo", () => {
  it("the table: a card exactly when something changed, however the task ended; undo exactly when every change can be taken back, and then it takes the folder back", async () => {
    const ends: End[] = ["succeeded", "failed", "unconfirmed", "cancelled", "stopped", "app_gone", "environment"];
    const changes: Change[] = ["none", "file", "gui", "unsure"];
    const rows: string[] = [];
    for (const end of ends) for (const change of changes) {
      const d = desk();
      const r = runTask(d, changeSteps(d, change), end, { undo: true });
      await r.done;
      const done = r.taskDone()!;
      const row = `${end} × ${change}: ${done.status}`;
      // the ground truth: the folder on disk, and what the simulated driver was asked to do on screen
      const afterTask = done && r.events.some((e) => e.kind === "result_response") ? null : tree(d.scope);
      const screen = d.performed.filter((a) => a.kind !== "wait");
      const fileChanged = change === "file" || change === "unsure";       // checked against the disk below
      const changed = fileChanged || screen.length > 0;
      const reversible = changed && screen.length === 0;
      rows.push(`${row} card=${!!done.result_card} undo=${!!done.result_card?.options.some((x) => x.kind === "undo")}`);
      expect(done.status, row).toBe(end === "app_gone" ? "stopped" : end);
      expect(!!done.result_card, row).toBe(changed);
      // undo is offered only while something waits to carry it out: the app gone (stdin closed), nothing does
      expect(done.result_card?.options.some((x) => x.kind === "undo") ?? false, row).toBe(reversible && end !== "app_gone");
      if (reversible && end === "app_gone") expect(done.result_card!.text, row).toContain("这次运行结束后不再等回答，撤回用不了");
      if (change === "gui" || change === "unsure") expect(screen.length, row).toBeGreaterThan(0);
      if (changed && !reversible) expect(done.result_card!.text, row).toMatch(change === "unsure" ? /做没做成没法确认，撤不回/ : /界面上的操作撤不回/);
      if (changed && end !== "succeeded") expect(done.result_card!.text.split("\n")[0], row).toMatch(/^任务.*已经做了的改动：$/);
      if (reversible && end !== "app_gone") {
        // the undo, answered while the process waits: the folder is as it was before the task
        expect(done.undo_until, row).toBeGreaterThan(done.t);
        expect(r.events.at(-1), row).toMatchObject({ kind: "result_response", picked: "undo", undone: 1, total: 1, refused: null });
        expect(tree(d.scope), row).toEqual(d.before);
      } else {
        if (afterTask && fileChanged) expect(afterTask["a.txt"], row).toBe("hi");
        expect(done.undo_until, row).toBeUndefined();
      }
    }
    expect(rows).toHaveLength(28);
  }, 60_000);

  it("a step still out at the driver when a signal forces the end: the card names it as unknown and offers no undo", async () => {
    class Hanging extends SimComputer {
      began!: () => void;
      performing = new Promise<void>((r) => { this.began = r; });
      override perform(a: Action) { if (a.kind !== "open_window") return super.perform(a); this.began(); return new Promise<never>(() => {}); }
    }
    const scope = fs.mkdtempSync(path.join(os.tmpdir(), "result-card-"));
    const sim = new Hanging(scope);
    const events: AppEvent[] = [];
    let signal!: (sig: string) => void;
    let exited = false;
    void appRun({ run_id: "run_hang", raw: "新建 a.txt，再开一个编辑器", config: "ds-flash", scope }, {
      runs: fs.mkdtempSync(path.join(os.tmpdir(), "result-card-runs-")), out: (e) => events.push(e), input: new LineReader(new PassThrough()), linger: 600,
      signals: { onSignal: (h) => { signal = h; }, exit: () => { exited = true; }, exitNow: () => { exited = true; }, deadlineMs: 50, waitMs: 100 },
      inject: { driver: sim, gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream([
        { calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] },
        { calls: [{ name: "computer_snapshot", args: {} }] },
        (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "open_window", app: "编辑器" }, epoch: lastJson(m).epoch, consequence: "create", purpose: "开编辑器" } }] }),
        { calls: [{ name: "finish", args: { outcome: "done", summary: "x" } }] },
      ]) } },
    });
    await sim.performing;
    signal("SIGTERM");
    await waitFor(() => exited, 5000);
    const done = events.find((e) => e.kind === "task_done") as Extract<AppEvent, { kind: "task_done" }>;
    expect(done).toMatchObject({ status: "stopped", cause: "last_step_unknown" });
    expect(done.result_card).not.toBeNull();
    expect(done.result_card!.options.map((x) => x.kind)).toEqual(["approve"]);
    expect(done.result_card!.text).toContain("最后一步做没做成不知道，撤不回");
    expect(done.result_card!.text).toContain("打开 编辑器");
    expect(done.undo_until).toBeUndefined();
  });
});

describe("H2 property: a task that changed only what can be taken back, ended any way, is undone to exactly how it was", () => {
  const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  it("random file steps (new files, folders, copies, moves, appended lines; the user's files too), a random end: undo leaves the folder as before the task", async () => {
    for (let seed = 7; seed < 27; seed++) {
      const rand = rng(seed);
      const pick = <X,>(xs: X[]) => xs[Math.floor(rand() * xs.length)]!;
      const d = desk();
      // a model of the folder, only to make arguments that are valid when generated (the oracle is the disk)
      const files = new Set(["notes/u1.txt", "u2.txt"]), dirs = new Set([".", "notes"]);
      let n = 0;
      const fresh = (dir: string) => `${dir === "." ? "" : dir + "/"}n${n++}.txt`;
      const steps: Step[] = [{ calls: [{ name: "plan", args: { steps: [{ purpose: "整理", objects: ["path:notes/u1.txt", "path:u2.txt"], consequence: "modify_user" }] } }] }];
      const k = 2 + Math.floor(rand() * 5);
      for (let i = 0; i < k; i++) {
        const op = files.size ? pick(["create", "mkdir", "copy", "move", "append", "replace", "trash"]) : "create";
        if (op === "create") { const dir = pick([...dirs]); const p = fresh(dir); files.add(p); steps.push({ calls: [{ name: "fs_create_text", args: { parent: dir, name: path.basename(p), text: `t${i}` } }] }); }
        else if (op === "mkdir") { const p = `d${n++}`; dirs.add(p); steps.push({ calls: [{ name: "fs_mkdir", args: { path: p } }] }); }
        else if (op === "copy") { const src = pick([...files]); const dst = fresh(pick([...dirs])); files.add(dst); steps.push({ calls: [{ name: "fs_copy", args: { source: src, destination: dst } }] }); }
        else if (op === "move") { const src = pick([...files]); const dst = fresh(pick([...dirs])); files.delete(src); files.add(dst); steps.push({ calls: [{ name: "fs_move", args: { source: src, destination: dst } }] }); }
        else if (op === "replace") { const f = pick([...files]); steps.push({ calls: [{ name: "fs_replace_text", args: { target: f, text: `r${i}\n` } }] }); }
        else if (op === "trash") { const f = pick([...files]); files.delete(f); steps.push({ calls: [{ name: "fs_trash", args: { target: f } }] }); }
        else { const f = pick([...files]); steps.push({ calls: [{ name: "fs_append_line", args: { target: f, line: `l${i}` } }] }); }
      }
      const end = pick<End>(["succeeded", "failed", "unconfirmed", "cancelled", "stopped"]);
      // a stop in the middle, after some of the steps, for a few
      const stopAfterSteps = end === "stopped" && rand() < 0.5 ? 1 + Math.floor(rand() * k) : undefined;
      const r = runTask(d, steps, end, { undo: true, ...(stopAfterSteps ? { stopAfterSteps } : {}) });
      await r.done;
      const done = r.taskDone()!;
      const ctx = `seed ${seed}: ${end}${stopAfterSteps ? ` after ${stopAfterSteps}` : ""}, ${steps.length - 1} steps → ${done.status}`;
      expect(d.performed, ctx).toEqual([]);                // nothing on screen: every change is a file's
      const response = r.events.find((e) => e.kind === "result_response") as any;
      if (!response) {
        // nothing changed (every step refused, or a stop before the first): no card, the folder as it was
        expect(done.result_card, ctx).toBeNull();
        expect(tree(d.scope), ctx).toEqual(d.before);
        continue;
      }
      expect(done.result_card!.options.some((x) => x.kind === "undo"), ctx).toBe(true);
      expect(response, ctx).toMatchObject({ picked: "undo", refused: null });
      expect(response.undone, ctx).toBe(response.total);
      expect(tree(d.scope), ctx).toEqual(d.before);
      // and no undo copy is left once the window closed (appRun returned)
      expect(undoCopies(d.scope), ctx).toEqual([]);
    }
  }, 60_000);
});

// --- the undo window, through the session ------------------------------------------------------------------------------

const hosts: SessionHost[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) h.end(); await sleep(50); });

/** A session whose tasks run in process on the simulated desktop with `scripts[i]`, the fake clock, and an app that
 *  approves plan cards and stops the task at its question card (`stopAt: "missing"`). */
function session(o: { scripts: ((d: Desk) => Step[])[]; clock: FakeClock; linger?: number; onAsk?: (e: any, send: (c: Record<string, unknown>) => void) => void }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "result-card-ses-"));
  const desks: Desk[] = [];
  let i = 0;
  const launch: Launcher = (req, lo) => {
    const d = desk(); desks.push(d);
    const steps = o.scripts[i++]!(d);
    const input = new PassThrough();
    let ended = false, cb: ((l: string) => void) | null = null;
    const early: string[] = [];
    const out = (e: unknown) => { const l = JSON.stringify(e); if (cb) cb(l); else early.push(l); };
    const exited = appRun({ ...(req as object), scope: d.scope } as never, { runs: lo.runs, out, input: new LineReader(input), linger: lo.linger,
      inject: { driver: d.sim, gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream(steps) }, clock: o.clock } }).then(() => ({ code: 0, signal: null }));
    const h: ExecutorHandle = { write: (l) => { if (!ended) input.write(l + "\n"); }, close: () => { if (!ended) { ended = true; input.end(); } }, onLine: (f) => { cb = f; for (const l of early.splice(0)) f(l); }, exited };
    return h;
  };
  const evs: any[] = [];
  const send = (c: Record<string, unknown>) => h.handle(JSON.stringify(c));
  const h: SessionHost = new SessionHost({ dir, sessionId: "ses_h2", out: (e) => {
    evs.push(e);
    if (e.kind === "ask") {
      if ((e as any).card.kind === "missing" && o.onAsk) o.onAsk(e, send);
      else if ((e as any).card.kind !== "missing") setTimeout(() => send({ type: "answer", run_id: e.run_id, ask_id: e.ask_id, option: (e as any).card.options.findIndex((x: any) => x.kind === "approve") }), 1);
    }
  }, coalesceMs: 5, model: { model: MODEL, streamFn: scriptedStream([{ text: "好" }, { text: "好" }, { text: "好" }]) }, launch, linger: o.linger ?? 600, clock: o.clock });
  hosts.push(h);
  h.start();
  const of = (kind: string, runId?: string) => evs.filter((e) => e.kind === kind && (!runId || e.run_id === runId));
  return { h, evs, send, desks, of, dir };
}
const CREATE_THEN_ASK = (): Step[] => [
  { calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] },
  { calls: [{ name: "ask_user", args: { question: "还要接着做吗？", options: ["接着做"] } }] },
  { calls: [{ name: "finish", args: { outcome: "done", summary: "x" } }] },
];
const CREATE = (): Step[] => [{ calls: [{ name: "fs_create_text", args: { parent: ".", name: "b.txt", text: "hi" } }] }, { calls: [{ name: "finish", args: { outcome: "done", summary: "写了" } }] }];

describe("H2 through the session: the undo window", () => {
  it("a stopped task that changed a file: the result card lingers, task_end says undo open until the executor's deadline, and the undo takes it back", async () => {
    const clock = new FakeClock();
    const s = session({ clock, scripts: [() => CREATE_THEN_ASK()], onAsk: (e, send) => setTimeout(() => send({ type: "stop", run_id: e.run_id }), 1) });
    s.send({ type: "cua", text: "新建 a.txt" });
    await waitFor(() => s.of("session.task_end").length === 1);
    const done = s.of("task_done")[0], end = s.of("session.task_end")[0];
    expect(done.status).toBe("stopped");
    expect(done.result_card.options.map((x: any) => x.kind)).toEqual(["approve", "undo"]);
    expect(done.undo_until).toBe(clock.now() / 1000 + 600);
    expect(end).toMatchObject({ status: "stopped", undo: "open", undo_until: done.undo_until });
    expect(fs.existsSync(path.join(s.desks[0]!.scope, "a.txt"))).toBe(true);
    s.send({ type: "respond", run_id: done.run_id, option: 1 });
    await waitFor(() => s.of("session.task_undo").length === 1);
    expect(s.of("session.task_undo")[0]).toMatchObject({ undone: 1, total: 1, refused: null });
    expect(tree(s.desks[0]!.scope)).toEqual(s.desks[0]!.before);
  });

  it("the window is 600 s by the wall clock: open at 599 s awake, closed within a second of waking after a sleep past it; a respond then is refused", async () => {
    const clock = new FakeClock();
    const s = session({ clock, scripts: [() => CREATE()] });
    s.send({ type: "cua", text: "新建 b.txt" });
    await waitFor(() => s.of("session.task_end").length === 1);
    const done = s.of("task_done")[0];
    expect(s.of("session.task_end")[0]).toMatchObject({ undo: "open", undo_until: clock.now() / 1000 + 600 });
    clock.advance(599_000);
    await sleep(30);
    expect(s.of("session.task_closed")).toEqual([]);
    clock.sleep(30 * 60_000);                             // the lid closed: no timer moved
    await sleep(30);
    expect(s.of("session.task_closed")).toEqual([]);
    clock.advance(1000);                                  // the first tick after waking
    await waitFor(() => s.of("session.task_closed").length === 1);
    expect(s.of("session.task_closed")[0]).toMatchObject({ run_id: done.run_id, why: "linger" });
    s.send({ type: "respond", run_id: done.run_id, option: 1 });
    await waitFor(() => s.of("session.error").some((e) => e.control === "respond"));
    expect(s.of("session.error").find((e) => e.control === "respond")).toMatchObject({ code: "no_task" });
    expect(fs.existsSync(path.join(s.desks[0]!.scope, "b.txt"))).toBe(true);
  });

  it("a new computer task on this Mac ends a stopped task's undo window (new_task); its respond is refused", async () => {
    const clock = new FakeClock();
    const s = session({ clock, scripts: [() => CREATE_THEN_ASK(), () => CREATE()], onAsk: (e, send) => setTimeout(() => send({ type: "stop", run_id: e.run_id }), 1) });
    s.send({ type: "cua", text: "新建 a.txt" });
    await waitFor(() => s.of("session.task_end").length === 1);
    const first = s.of("task_done")[0].run_id;
    expect(s.of("session.task_end")[0]).toMatchObject({ status: "stopped", undo: "open" });
    await waitFor(() => !s.h.busy);
    s.send({ type: "cua", text: "新建 b.txt" });
    await waitFor(() => s.of("session.task_closed", first).length === 1);
    expect(s.of("session.task_closed", first)[0]).toMatchObject({ why: "new_task" });
    s.send({ type: "respond", run_id: first, option: 1 });
    await waitFor(() => s.of("session.error").some((e) => e.control === "respond"));
    expect(fs.existsSync(path.join(s.desks[0]!.scope, "a.txt"))).toBe(true);
  });

  it("the helper goes away mid-task: the stopped task's result card is still written (with its undo), and the window closes with the session (session_end)", async () => {
    const clock = new FakeClock();
    const s = session({ clock, scripts: [() => CREATE_THEN_ASK()], onAsk: () => setTimeout(() => s.h.inputClosed(), 1) });
    s.send({ type: "cua", text: "新建 a.txt" });
    await waitFor(() => s.of("session.task_closed").length === 1);
    const done = s.of("task_done")[0];
    expect(done.status).toBe("stopped");
    expect(done.result_card.options.map((x: any) => x.kind)).toEqual(["approve", "undo"]);
    expect(s.of("session.task_closed")[0]).toMatchObject({ why: "session_end" });
  });

  it("a failed task that changed something on screen: a result card that says why there is no undo; task_end undo none, no deadline", async () => {
    const clock = new FakeClock();
    const s = session({ clock, scripts: [(d) => [...changeSteps(d, "gui"), { calls: [{ name: "finish", args: { outcome: "cannot", summary: "做不了" } }] }]] });
    s.send({ type: "cua", text: "改一下笔记" });
    await waitFor(() => s.of("session.task_end").length === 1);
    const done = s.of("task_done")[0];
    expect(done.status).toBe("failed");
    expect(done.result_card.options.map((x: any) => x.kind)).toEqual(["approve"]);
    expect(done.result_card.text).toContain("界面上的操作撤不回");
    expect(done.undo_until).toBeUndefined();
    const end = s.of("session.task_end")[0];
    expect(end).toMatchObject({ status: "failed", undo: "none" });
    expect(end.undo_until).toBeUndefined();
  });
});

describe("H2, review of #68: undo only while something can carry it out; every end has its card", () => {
  it("an undo sent in the second after waking from a sleep past the window, before any tick: nothing is undone, and that is said", async () => {
    const clock = new FakeClock();
    const d = desk();
    const input = new PassThrough();
    const events: AppEvent[] = [];
    const done = appRun({ run_id: "run_wake", raw: "新建 a.txt", config: "ds-flash", scope: d.scope }, {
      runs: fs.mkdtempSync(path.join(os.tmpdir(), "result-card-runs-")), out: (e) => events.push(e), input: new LineReader(input), linger: 600,
      inject: { driver: d.sim, gateway: gateway(), clock, model: { model: MODEL, streamFn: scriptedStream([...changeSteps(d, "file"), { calls: [{ name: "finish", args: { outcome: "done", summary: "写了" } }] }]) } },
    });
    await waitFor(() => events.some((e) => e.kind === "task_done"));
    const td = events.find((e) => e.kind === "task_done") as Extract<AppEvent, { kind: "task_done" }>;
    expect(td.undo_until).toBe(clock.now() / 1000 + 600);
    clock.advance(5 * 60_000);
    clock.sleep(30 * 60_000);                              // past undo_until; no timer moved
    input.write(JSON.stringify({ type: "respond", option: td.result_card!.options.findIndex((x) => x.kind === "undo") }) + "\n");
    await done;
    expect(events.filter((e) => e.kind === "result_response")).toEqual([expect.objectContaining({ picked: "undo", undone: 0, total: 1, refused: "expired" })]);
    expect(fs.readFileSync(path.join(d.scope, "a.txt"), "utf-8")).toBe("hi");
  });

  it("a signal ends the run normally (the step's receipt came): the card offers no undo and says why — the process exits, nobody can carry it out", async () => {
    class Slow extends SimComputer {
      began!: () => void;
      performing = new Promise<void>((r) => { this.began = r; });
      override perform(a: Action) { if (a.kind !== "open_window") return super.perform(a); this.began(); return new Promise<ReturnType<SimComputer["perform"]>>((r) => setTimeout(() => r(super.perform(a)), 300)) as never; }
    }
    const scope = fs.mkdtempSync(path.join(os.tmpdir(), "result-card-"));
    const sim = new Slow(scope);
    const events: AppEvent[] = [];
    let signal!: (sig: string) => void;
    let exited = false;
    void appRun({ run_id: "run_sig", raw: "新建 a.txt，再开一个编辑器", config: "ds-flash", scope }, {
      runs: fs.mkdtempSync(path.join(os.tmpdir(), "result-card-runs-")), out: (e) => events.push(e), input: new LineReader(new PassThrough()), linger: 600,
      signals: { onSignal: (h) => { signal = h; }, exit: () => { exited = true; }, exitNow: () => { exited = true; }, deadlineMs: 50, waitMs: 3000 },
      inject: { driver: sim, gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream([
        { calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] },
        { calls: [{ name: "computer_snapshot", args: {} }] },
        (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "open_window", app: "编辑器" }, epoch: lastJson(m).epoch, consequence: "create", purpose: "开编辑器" } }] }),
        { calls: [{ name: "finish", args: { outcome: "done", summary: "x" } }] },
      ]) } },
    });
    await sim.performing;
    signal("SIGINT");
    await waitFor(() => exited, 5000);
    const done = events.find((e) => e.kind === "task_done") as Extract<AppEvent, { kind: "task_done" }>;
    expect(done.status).toBe("stopped");
    expect(done.reason).not.toContain("unknown");            // the runtime's own end, not the forced one
    expect(done.result_card!.options.map((x) => x.kind)).toEqual(["approve"]);
    expect(done.result_card!.text).toContain("这次运行结束后不再等回答，撤回用不了");
    expect(done.undo_until).toBeUndefined();
  });

  it("an action the driver had, whose result came back as an error or as the screen found locked after it, is a change that may have happened: no undo of the rest", async () => {
    for (const how of ["error", "locked_after"] as const) {
      const d = desk();
      const perform = d.sim.perform.bind(d.sim);
      d.sim.perform = (a: Action) => {
        if (a.kind !== "key") return perform(a);
        perform(a);                                        // it went through on screen
        if (how === "locked_after") { d.sim.lock(); return { status: "unverified", why: "sent; nothing read back", window: d.w }; }
        return { status: "error", why: "the driver lost track of it" };
      };
      const r = runTask(d, [...changeSteps(d, "unsure")], how === "error" ? "succeeded" : "environment", { undo: true });
      await r.done;
      const done = r.taskDone()!;
      // the key's step came back as the review describes: error (from the driver), or environment (locked after it)
      expect(r.events.filter((e) => e.kind === "step_result").at(-1), how).toMatchObject(how === "error" ? { status: "error", executor_status: "error" } : { status: "refused", executor_status: "environment" });
      expect(done.result_card, how).not.toBeNull();
      expect(done.result_card!.options.map((x) => x.kind), how).toEqual(["approve"]);
      expect(done.result_card!.text, how).toContain("有一步做没做成没法确认，撤不回");
      expect(fs.readFileSync(path.join(d.scope, "a.txt"), "utf-8"), how).toBe("hi");    // nothing undone
    }
  });
});

describe("H2 round 2: could this step have done something — one rule, from the journal", () => {
  it("the table: receipt kind × consequence → possibly done (only 'not performed' and a reconciled 'did not happen' say no)", () => {
    const receipts: [string, Record<string, unknown> | null, boolean][] = [
      ["no receipt (died, in flight, threw half way)", null, true],
      ["ok", { kind: "receipt", status: "ok" }, true],
      ["unverified", { kind: "receipt", status: "unverified" }, true],
      ["error", { kind: "receipt", status: "error" }, true],
      ["environment (locked after)", { kind: "receipt", status: "environment" }, true],
      ["blocked", { kind: "receipt", status: "blocked" }, true],
      ["unsupported", { kind: "receipt", status: "unsupported" }, true],
      ["user_busy, performed:false", { kind: "receipt", status: "user_busy", performed: false }, false],
      ["error, performed:false", { kind: "receipt", status: "error", performed: false }, false],
      ["restart: not_happened", { kind: "receipt", recovered: true, finding: "not_happened" }, false],
      ["restart: unknown", { kind: "receipt", recovered: true, finding: "unknown" }, true],
      ["restart: happened", { kind: "receipt", recovered: true, finding: "happened" }, true],
    ];
    for (const consequence of ["create", "modify_user", "external"]) for (const [name, receipt, want] of receipts) {
      expect(possiblyDone(receipt), `${name} × ${consequence}`).toBe(want);
      const lines = [{ kind: "begin" }, { kind: "intent", consequence, text: "x" }, ...(receipt ? [receipt as { kind: string }] : [])];
      expect(journalSteps(lines).map((st) => st.possibly), `${name} × ${consequence} (journal)`).toEqual([want]);
    }
    // a step refused before it was acted on wrote no intent: nothing to count. An intent whose receipt never came is
    // not closed by the next intent's receipt
    expect(journalSteps([{ kind: "begin" }])).toEqual([]);
    expect(journalSteps([{ kind: "intent", text: "a" }, { kind: "intent", text: "b" }, { kind: "receipt", status: "ok", performed: false }]).map((x) => [x.text, x.possibly])).toEqual([["a", true], ["b", false]]);
  });

  /** An executor that reports a few steps on stdout and in its events.jsonl (and its journal, when given), then dies. */
  const crashing = (evs: Record<string, unknown>[], journal?: Record<string, unknown>[]): Launcher => (_req, lo) => {
    const file = path.join(lo.runs, lo.runId, "events.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let cb: ((l: string) => void) | null = null;
    let die!: (x: { code: number | null; signal: string | null }) => void;
    const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { die = r; });
    const lines = evs.map((e, i) => JSON.stringify({ seq: i + 1, t: Date.now() / 1000, run_id: lo.runId, ...e }));
    return {
      start: () => { setTimeout(() => {
        fs.writeFileSync(file, lines.join("\n") + "\n");
        if (journal) fs.writeFileSync(path.join(path.dirname(file), "journal.jsonl"), journal.map((j) => JSON.stringify(j)).join("\n") + "\n");
        for (const l of lines) cb?.(l);
        setTimeout(() => die({ code: 1, signal: null }), 10);
      }, 5); },
      write: () => {}, close: () => {}, onLine: (f) => { cb = f; }, exited,
    };
  };
  const ses = (launch: Launcher) => {
    const evs: any[] = [];
    const h = new SessionHost({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "result-card-ses-")), sessionId: "ses_crash", out: (e) => evs.push(e), coalesceMs: 5,
      model: { model: MODEL, streamFn: scriptedStream([{ text: "好" }]) }, launch, linger: 600 });
    hosts.push(h);
    h.start();
    return { h, evs };
  };
  const endOf = async (launch: Launcher) => {
    const s = ses(launch);
    s.h.handle(JSON.stringify({ type: "cua", text: "改一下笔记" }));
    await waitFor(() => s.evs.some((e) => e.kind === "session.task_end"));
    return s.evs.find((e) => e.kind === "session.task_end");
  };
  const SET = "在 编辑器「笔记.txt」 把「正文」设为「新的」", SAVE = "在 编辑器「笔记.txt」 按 cmd+s";

  it("bug 1: screen steps that came back error, or refused because the screen was locked after them, then the executor dies — the card lists them", async () => {
    const evs = [
      { kind: "step", step_id: "st_1", text: "{}", human: SET, consequence: "modify_user" },
      { kind: "step_result", step_id: "st_1", status: "error", executor_status: "error", consequence: "modify_user" },
      { kind: "step", step_id: "st_2", text: "{}", human: SAVE, consequence: "modify_user" },
      { kind: "step_result", step_id: "st_2", status: "refused", executor_status: "environment", consequence: "modify_user" },
    ];
    // from the journal (the executor's record), and from the events alone (no journal: a missing possibly_done counts)
    for (const journal of [[{ kind: "begin" }, { kind: "intent", consequence: "modify_user", text: SET }, { kind: "receipt", status: "error", seq: 1 }, { kind: "intent", consequence: "modify_user", text: SAVE }, { kind: "receipt", status: "environment", seq: 2 }], undefined]) {
      const end = await endOf(crashing(evs, journal));
      expect(end.result_card, journal ? "journal" : "events").toMatchObject({ kind: "result", options: [{ kind: "approve", text: "好的" }] });
      expect(end.result_card.text.split("\n")[0]).toBe("执行进程意外退出，撤不回");
      expect(end.result_card.text).toContain(`做没做成没法确认：${SET}；${SAVE}`);
    }
  });

  it("only looks, or steps the driver said it never performed: no card; a step with no result counts", async () => {
    const look = [{ kind: "step", step_id: "st_1", text: "{}", human: "看一眼", consequence: "read" }, { kind: "step_result", step_id: "st_1", status: "ok", consequence: "read", possibly_done: false }];
    expect((await endOf(crashing(look, [{ kind: "begin" }]))).result_card).toBeUndefined();
    expect((await endOf(crashing(look))).result_card).toBeUndefined();
    const notPerformed = [{ kind: "begin" }, { kind: "intent", consequence: "modify_user", text: SET }, { kind: "receipt", status: "user_busy", performed: false, seq: 1 }];
    expect((await endOf(crashing([], notPerformed))).result_card).toBeUndefined();
    const dangling = [{ kind: "begin" }, { kind: "intent", consequence: "modify_user", text: SAVE }];
    expect((await endOf(crashing([], dangling))).result_card.text).toContain(`做没做成没法确认：${SAVE}`);
  });

  /** fs.writeFileSync of a file named boom*.txt writes "par" and then fails, as a full disk would half way. */
  const halfWrite = () => {
    const orig = fsCjs.writeFileSync;
    (fsCjs as any).writeFileSync = (file: any, data: any, o?: any) => {
      if (typeof file === "string" && /boom[^/]*\.txt$/.test(file)) { orig(file, "par", o); throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" }); }
      return orig(file, data, o);
    };
    syncBuiltinESMExports();
    return () => { (fsCjs as any).writeFileSync = orig; syncBuiltinESMExports(); };
  };

  it("bug 2: a file step whose capability wrote half its file and then threw is possibly done with no recipe: no undo, the card says why, and the live card, a dead executor's card and a restart agree", async () => {
    const d = desk();
    const restore = halfWrite();
    let r: ReturnType<typeof runTask>;
    try {
      r = runTask(d, [{ calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] }, { calls: [{ name: "fs_create_text", args: { parent: ".", name: "boom.txt", text: "partial" } }] }], "succeeded", { undo: true });
      await r.done;
    } finally { restore(); }
    const done = r!.taskDone()!;
    expect(fs.readFileSync(path.join(d.scope, "boom.txt"), "utf-8")).toBe("par");
    expect(done.result_card!.options.map((x) => x.kind)).toEqual(["approve"]);
    expect(done.result_card!.text).toContain("有一步做没做成没法确认，撤不回");
    const results = r!.events.filter((e) => e.kind === "step_result") as any[];
    expect(results.map((x) => [x.status, x.possibly_done])).toEqual([["ok", true], ["error", true]]);
    expect(r!.events.some((e) => e.kind === "result_response")).toBe(false);
    expect(fs.readFileSync(path.join(d.scope, "boom.txt"), "utf-8")).toBe("par");
    // the same journal, read by the session and by a restart
    const journal = parseJournal(fs.readFileSync(path.join(r!.dir, "journal.jsonl"), "utf-8"));
    const live = cardLines(done.result_card!.text), dead = cardLines(fallbackCard([], journal, "zh", "crashed")!.text);
    expect(dead).toEqual(live);
    expect(live.unsure.some((x) => x.includes("boom.txt"))).toBe(true);
    const again = await restart(d, r!.dir);
    expect(again.lines).toEqual(live);
    expect(again.reversible).toBe(false);
  });

  it("property: random steps, random driver answers, random deaths — the live card, a dead executor's card and a restart list the same steps; undo only when the disk and the driver can be put back", async () => {
    const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    type Answer = "ok" | "unverified" | "error" | "blocked" | "not_performed" | "locked_after" | "hang";
    for (let seed = 1; seed <= 24; seed++) {
      const rand = rng(seed);
      const pick = <X,>(xs: X[]) => xs[Math.floor(rand() * xs.length)]!;
      const d = desk();
      // what the driver answers to each key press, in order (hang: it never answers — the executor dies with it out)
      const answers: Answer[] = [];
      let screen = 0;                                       // key presses the simulated driver actually carried out
      const perform = d.sim.perform.bind(d.sim);
      d.sim.perform = (a: Action) => {
        if (a.kind !== "key") return perform(a);
        const ans = answers.shift() ?? "ok";
        if (ans === "hang") { screen += 1; return new Promise<never>(() => {}); }
        if (ans === "not_performed") return { status: "error", why: "the user was busy", performed: false } as never;
        perform(a); screen += 1;
        if (ans === "locked_after") { d.sim.lock(); return { status: "unverified", window: d.w } as never; }
        return { status: ans, why: ans, window: d.w } as never;
      };
      const steps: Step[] = [
        { calls: [{ name: "plan", args: { steps: [{ purpose: "改笔记", objects: [`window:${d.w}`], consequence: "modify_user" }] } }] },
      ];
      const k = 2 + Math.floor(rand() * 4);
      let n = 0, hung = false;
      for (let i = 0; i < k && !hung; i++) {
        const op = pick(["file", "file", "boom", "key"]);
        if (op === "file") steps.push({ calls: [{ name: "fs_create_text", args: { parent: ".", name: `f${n++}.txt`, text: "hi" } }] });
        else if (op === "boom") steps.push({ calls: [{ name: "fs_create_text", args: { parent: ".", name: `boom${n++}.txt`, text: "whole" } }] });
        else {
          const ans = pick<Answer>(["ok", "unverified", "error", "blocked", "not_performed", "locked_after", "hang"]);
          answers.push(ans); hung = ans === "hang";
          steps.push({ calls: [{ name: "computer_observe", args: { window: d.w } }] }, (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "key", window: d.w, chord: `cmd+${i}` }, epoch: lastJson(m).epoch, consequence: "modify_user", purpose: "按键" } }] }));
        }
      }
      const restore = halfWrite();
      let r: ReturnType<typeof runTask>;
      try {
        r = runTask(d, steps, "succeeded", { undo: true, ...(hung ? { signalAfterMs: 150 } : {}) });
        await r.done;
      } finally { restore(); }
      const ctx = `seed ${seed}: ${JSON.stringify(steps.length)} steps, answers ${JSON.stringify(answers)} hung=${hung}`;
      const done = r!.taskDone()!;
      const journal = parseJournal(fs.readFileSync(path.join(r!.dir, "journal.jsonl"), "utf-8"));
      const card = done.result_card;
      const dead = fallbackCard([], journal, "zh", "crashed");
      const again = await restart(d, r!.dir);
      // all three list the same steps (or none)
      expect(!!card, ctx).toBe(!!dead);
      if (card) { expect(cardLines(dead!.text), ctx).toEqual(cardLines(card.text)); expect(again.lines, ctx).toEqual(cardLines(card.text)); }
      else expect(again.lines, ctx).toEqual({ did: [], unsure: [] });
      // undo: offered only when what the oracle sees can all be put back — no key the driver carried out, no half
      // written file — and then it does put the disk back
      const offered = !!card?.options.some((x) => x.kind === "undo");
      const halfWritten = Object.keys(tree(d.scope)).some((p) => p.startsWith("boom"));
      if (offered) {
        expect(screen, ctx).toBe(0);
        expect(halfWritten, ctx).toBe(false);
        const resp = r!.events.find((e) => e.kind === "result_response") as any;
        expect(resp, ctx).toMatchObject({ picked: "undo", refused: null });
        expect(tree(d.scope), ctx).toEqual(d.before);
      }
      // and never "nothing changed" when something did
      if (screen > 0 || halfWritten || Object.keys(tree(d.scope)).length !== Object.keys(d.before).length) expect(card, ctx).toBeTruthy();
    }
  }, 120_000);

  it("the session refuses an undo sent after undo_until itself — never forwarded, never recorded as cut off", async () => {
    const clock = new FakeClock();
    const s = session({ clock, scripts: [() => CREATE()] });
    s.send({ type: "cua", text: "新建 b.txt" });
    await waitFor(() => s.of("session.task_end").length === 1);
    const done = s.of("task_done")[0];
    expect(s.of("session.task_end")[0]).toMatchObject({ undo: "open" });
    clock.sleep(11 * 60_000);                              // past undo_until on the one clock; the executor's tick has not run
    s.send({ type: "respond", run_id: done.run_id, option: 1 });
    await waitFor(() => s.of("session.error").some((e) => e.control === "respond"));
    expect(s.of("session.error").find((e) => e.control === "respond")).toMatchObject({ code: "undo_expired" });
    await sleep(50);
    expect(s.of("session.task_respond")).toEqual([]);
    expect(s.of("result_response")).toEqual([]);
    expect(fs.existsSync(path.join(s.desks[0]!.scope, "b.txt"))).toBe(true);
  });

  it("B1: the session compares undo_until with the executors' clock, not its own: a window open by that clock is open", async () => {
    // the executors' wall clock is years behind this machine's: the undo window is open by it, so the undo is done
    const clock = new FakeClock();
    clock.wall = Date.UTC(2020, 0, 1);
    const s = session({ clock, scripts: [() => CREATE()] });
    s.send({ type: "cua", text: "新建 b.txt" });
    await waitFor(() => s.of("session.task_end").length === 1);
    s.send({ type: "respond", run_id: s.of("task_done")[0].run_id, option: 1 });
    await waitFor(() => s.of("session.task_undo").length === 1 || s.of("session.error").length > 0);
    expect(s.of("session.error")).toEqual([]);
    expect(s.of("session.task_undo")[0]).toMatchObject({ undone: 1, total: 1 });
  });

  it("B2: a driver reply that by protocol means 'refused before acting' (unsupported, or performed:false) is nothing done: a file-only task keeps its undo", async () => {
    for (const reply of [{ status: "unsupported", why: "no route" }, { status: "error", why: "stale: observe again", performed: false }]) {
      const d = desk();
      const perform = d.sim.perform.bind(d.sim);
      d.sim.perform = (a: Action) => (a.kind === "key" ? reply as never : perform(a));
      const r = runTask(d, [{ calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] }, ...changeSteps(d, "gui").slice(0, 2), (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "key", window: d.w, chord: "cmd+k" }, epoch: lastJson(m).epoch, consequence: "modify_user", purpose: "按一下" } }] })], "succeeded", { undo: true });
      await r.done;
      const done = r.taskDone()!;
      const key = (r.events.filter((e) => e.kind === "step_result") as any[]).at(-1);
      expect(key, reply.status).toMatchObject({ possibly_done: false });
      expect(done.result_card!.text, reply.status).not.toContain("cmd+k");
      expect(done.result_card!.options.map((x) => x.kind), reply.status).toEqual(["approve", "undo"]);
      expect(tree(d.scope), reply.status).toEqual(d.before);             // undone
    }
  });

  it("E1: a capability that fails cleanly (the zip could not be put in place) says it did nothing: no out.zip, the rest keeps its undo", async () => {
    const { PLACE } = await import("../src/registry/tools.js");
    const link = PLACE.link;
    PLACE.link = () => { throw Object.assign(new Error("EACCES: permission denied, link"), { code: "EACCES" }); };
    const d = desk();
    let r: ReturnType<typeof runTask>;
    try {
      r = runTask(d, [{ calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] }, { calls: [{ name: "fs_zip_files", args: { sources: "a.txt", destination: "out.zip" } }] }], "succeeded", { undo: true });
      await r.done;
    } finally { PLACE.link = link; }
    const done = r!.taskDone()!;
    expect(fs.existsSync(path.join(d.scope, "out.zip"))).toBe(false);
    expect((r!.events.filter((e) => e.kind === "step_result") as any[]).map((x) => [x.status, x.possibly_done])).toEqual([["ok", true], ["error", false]]);
    expect(done.result_card!.options.map((x) => x.kind)).toEqual(["approve", "undo"]);
    expect(done.result_card!.text).not.toContain("out.zip");
    expect(tree(d.scope)).toEqual(d.before);
  });

  it("E2/E3: a window the task opened, whose outcome is not known (the screen locked right after): listed as not known, never as done, and no undo", async () => {
    const d = desk();
    const perform = d.sim.perform.bind(d.sim);
    d.sim.perform = (a: Action) => { const x = perform(a); if (a.kind === "open_window") d.sim.lock(); return x; };
    const r = runTask(d, [{ calls: [{ name: "computer_snapshot", args: {} }] }, (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "open_window", app: "编辑器" }, epoch: lastJson(m).epoch, consequence: "create", purpose: "开编辑器" } }] })], "succeeded", { undo: true });
    await r.done;
    const done = r.taskDone()!;
    const lines = cardLines(done.result_card!.text);
    expect(lines.did).toEqual([]);
    expect(lines.unsure.some((x) => x.includes("编辑器"))).toBe(true);
    expect(done.result_card!.options.map((x) => x.kind)).toEqual(["approve"]);
    expect(done.result_card!.text).toContain("有一步做没做成没法确认，撤不回");
    // the same journal, read by the session for a dead executor, lists it the same way
    expect(cardLines(fallbackCard([], parseJournal(fs.readFileSync(path.join(r.dir, "journal.jsonl"), "utf-8")), "zh", "crashed")!.text)).toEqual(lines);
  });

  it("E4: without a journal, a look (consequence read, no possibly_done field) is not listed", () => {
    const evs = [
      { kind: "step", step_id: "st_1", text: "{}", human: "滚动", consequence: "read" },
      { kind: "step_result", step_id: "st_1", status: "ok", consequence: "read" },
      { kind: "step", step_id: "st_2", text: "{}", human: "再看看" , consequence: "read" },
    ];
    expect(fallbackCard(evs, null, "zh", "crashed")).toBeUndefined();
    expect(fallbackCard([...evs, { kind: "step", step_id: "st_3", text: "{}", human: "按 cmd+s", consequence: "modify_user" }], null, "zh", "crashed")!.text).toContain("做没做成没法确认：按 cmd+s");
  });
});

/** The step lines of a card's text: done, and not known. */
function cardLines(text: string): { did: string[]; unsure: string[] } {
  const of = (head: string) => text.split("\n").filter((l) => l.startsWith(head)).flatMap((l) => l.slice(head.length).split("；"));
  return { did: of("做了："), unsure: of("做没做成没法确认：") };
}

/** A new executor on the same task folder and journal (a restart): the steps it reads as possibly done, as a card lists
 *  them, and whether it could undo them. */
async function restart(d: Desk, runDir: string) {
  const signer = ConsentSigner.fresh();
  const ex = new Executor(d.sim, { task: "restart", publicKey: signer.publicKey, journal: path.join(runDir, "journal.jsonl"), files: { workspace: new Workspace(d.scope), registry: fileRegistry() } });
  d.sim.lock(false);
  await ex.begin(Object.keys(new Workspace(d.scope).entries()), []);
  const { stepLines } = await import("../src/executor/possibly.js");
  const lines = stepLines(ex.possiblySteps());
  return { lines, reversible: ex.undoable().reversible };
}

describe("H2 round 4: a stop while the result card waits closes it and its undo, whatever stopped before", () => {
  /** A task that writes a.txt and then asks a question; `stopTask`: the app stops it at the question (else it finishes).
   *  After task_done the app writes `after` (control lines, in one write), then closes stdin a moment later. */
  async function card(o: { stopTask: boolean; after: Record<string, unknown>[] }) {
    const d = desk();
    const input = new PassThrough();
    const events: AppEvent[] = [];
    const write = (c: unknown) => input.write(JSON.stringify(c) + "\n");
    const steps: Step[] = [
      { calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] },
      ...(o.stopTask ? [{ calls: [{ name: "ask_user", args: { question: "还要接着做吗？", options: ["接着做"] } }] }] : []),
      { calls: [{ name: "finish", args: { outcome: "done", summary: "写了" } }] },
    ];
    const out = (e: AppEvent) => {
      events.push(e);
      if (e.kind === "ask") setTimeout(() => write({ type: "stop" }), 1);
      if (e.kind === "task_done") setTimeout(() => {
        const undo = e.result_card!.options.findIndex((x) => x.kind === "undo");
        input.write(o.after.map((c) => JSON.stringify(c.type === "respond" ? { ...c, option: undo } : c) + "\n").join(""));
        setTimeout(() => input.end(), 100);
      }, 1);
    };
    await appRun({ run_id: "run_stop", raw: "新建 a.txt", config: "ds-flash", scope: d.scope }, { runs: fs.mkdtempSync(path.join(os.tmpdir(), "result-card-runs-")), out, input: new LineReader(input), linger: 600,
      inject: { driver: d.sim, gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream(steps) } } });
    const done = events.find((e) => e.kind === "task_done") as Extract<AppEvent, { kind: "task_done" }>;
    return { d, events, done, file: fs.existsSync(path.join(d.scope, "a.txt")) };
  }

  it("the task was stopped, its card waits: a second stop closes it — a later undo is not carried out, the file stays", async () => {
    const r = await card({ stopTask: true, after: [{ type: "stop" }, { type: "respond" }] });
    expect(r.done).toMatchObject({ status: "stopped" });
    expect(r.done.result_card!.options.map((x) => x.kind)).toEqual(["approve", "undo"]);
    expect(r.events.some((e) => e.kind === "result_response")).toBe(false);
    expect(r.file).toBe(true);
  });

  it("the task ended normally, its card waits: a stop closes it; a third and fourth stop change nothing", async () => {
    const r = await card({ stopTask: false, after: [{ type: "stop" }, { type: "stop" }, { type: "stop" }, { type: "respond" }] });
    expect(r.done).toMatchObject({ status: "succeeded" });
    expect(r.events.some((e) => e.kind === "result_response")).toBe(false);
    expect(r.file).toBe(true);
    expect(r.events.filter((e) => e.kind === "task_done")).toHaveLength(1);
    expect(r.events.filter((e) => e.kind === "refused" && e.by === "user")).toHaveLength(1);   // one stop recorded, once
  });

  it("the task was stopped, its card waits: an undo still works (the stop that ended the task does not close the card)", async () => {
    const r = await card({ stopTask: true, after: [{ type: "respond" }] });
    expect(r.events.at(-1)).toMatchObject({ kind: "result_response", picked: "undo", undone: 1, total: 1 });
    expect(r.file).toBe(false);
  });

  it("a stop that comes after the undo was asked for: the undo is not cut short (it finishes and is recorded)", async () => {
    const r = await card({ stopTask: true, after: [{ type: "respond" }, { type: "stop" }] });
    expect(r.events.find((e) => e.kind === "result_response")).toMatchObject({ picked: "undo", undone: 1, total: 1, refused: null });
    expect(r.file).toBe(false);
  });
});

describe("H2 round 5: the result card's state is decided once, in the session; the executor follows", () => {
  /** A stopped task that wrote a.txt: its result card (with undo) open in the session. */
  async function openCard() {
    const clock = new FakeClock();
    const s = session({ clock, scripts: [() => CREATE_THEN_ASK()], onAsk: (e, send) => setTimeout(() => send({ type: "stop", run_id: e.run_id }), 1) });
    s.send({ type: "cua", text: "新建 a.txt" });
    await waitFor(() => s.of("session.task_end").length === 1);
    const run = s.of("task_done")[0].run_id as string;
    expect(s.of("session.task_end")[0]).toMatchObject({ status: "stopped", undo: "open" });
    return { s, run, file: () => fs.existsSync(path.join(s.desks[0]!.scope, "a.txt")), clock };
  }
  const UNDO = 1;

  it("open + stop → closed(stopped): nothing recorded as a respond; the executor's wait ends and it exits", async () => {
    const { s, run, file } = await openCard();
    s.send({ type: "stop", run_id: run });
    await waitFor(() => s.of("session.task_closed", run).length === 1);
    expect(s.of("session.task_respond")).toEqual([]);
    expect(s.of("session.task_undo")).toEqual([]);
    expect(file()).toBe(true);
  });

  it("open + respond(undo) → undoing: task_respond recorded, the undo runs and is recorded", async () => {
    const { s, run, file } = await openCard();
    s.send({ type: "respond", run_id: run, option: UNDO });
    await waitFor(() => s.of("session.task_undo", run).length === 1);
    expect(s.of("session.task_respond", run)).toHaveLength(1);
    expect(s.of("session.task_undo", run)[0]).toMatchObject({ undone: 1, total: 1, refused: null });
    expect(s.of("session.task_undo", run)[0]).not.toHaveProperty("unknown");
    expect(file()).toBe(false);
  });

  it("closed(stopped) + respond at once (the same moment as the stop): refused; no task_respond, no undo record, no undo", async () => {
    const { s, run, file } = await openCard();
    s.send({ type: "stop", run_id: run });
    s.send({ type: "respond", run_id: run, option: UNDO });
    expect(s.of("session.error").find((e) => e.control === "respond")).toMatchObject({ code: "undo_expired" });
    await waitFor(() => s.of("session.task_closed", run).length === 1);
    await sleep(50);
    expect(s.of("session.task_respond")).toEqual([]);
    expect(s.of("session.task_undo")).toEqual([]);
    expect(file()).toBe(true);
  });

  it("undoing + stop: the undo is not cut half way — it finishes and is recorded", async () => {
    const { s, run, file } = await openCard();
    s.send({ type: "respond", run_id: run, option: UNDO });
    s.send({ type: "stop", run_id: run });
    await waitFor(() => s.of("session.task_undo", run).length === 1);
    expect(s.of("session.task_undo", run)[0]).toMatchObject({ undone: 1, total: 1, refused: null });
    expect(file()).toBe(false);
  });

  it("undoing, and the executor dies before the undo's outcome: recorded unknown (the one case it is)", async () => {
    // an executor that says task_done with an undo card, takes the respond, and dies without result_response
    let die!: (x: { code: number | null; signal: string | null }) => void;
    const launch: Launcher = (_req, lo) => {
      let cb: ((l: string) => void) | null = null;
      const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { die = r; });
      return {
        start: () => setTimeout(() => cb?.(JSON.stringify({ seq: 1, t: Date.now() / 1000, run_id: lo.runId, kind: "task_done", status: "succeeded", summary: "ok", reason: "", result_card: { kind: "result", text: "做了", options: [{ kind: "approve", text: "好的" }, { kind: "undo", text: "撤回" }], free_text: false, blocking: false } })), 5),
        write: (l) => { if (JSON.parse(l).type === "respond") setTimeout(() => die({ code: 1, signal: null }), 5); },
        close: () => {}, onLine: (f) => { cb = f; }, exited,
      };
    };
    const evs: any[] = [];
    const h = new SessionHost({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "result-card-ses-")), sessionId: "ses_die", out: (e) => evs.push(e), coalesceMs: 5,
      model: { model: MODEL, streamFn: scriptedStream([{ text: "好" }]) }, launch, linger: 600 });
    hosts.push(h);
    h.start();
    h.handle(JSON.stringify({ type: "cua", text: "新建 a.txt" }));
    await waitFor(() => evs.some((e) => e.kind === "session.task_end"));
    const run = evs.find((e) => e.kind === "task_done").run_id;
    h.handle(JSON.stringify({ type: "respond", run_id: run, option: 1 }));
    await waitFor(() => evs.some((e) => e.kind === "session.task_undo"));
    expect(evs.find((e) => e.kind === "session.task_undo")).toMatchObject({ unknown: true });
  });

  it("closed(expired) + respond → refused undo_expired, nothing recorded", async () => {
    const { s, run, clock, file } = await openCard();
    clock.sleep(11 * 60_000);
    s.send({ type: "respond", run_id: run, option: UNDO });
    expect(s.of("session.error").find((e) => e.control === "respond")).toMatchObject({ code: "undo_expired" });
    expect(s.of("session.task_respond")).toEqual([]);
    expect(file()).toBe(true);
  });
});

describe("H2 round 6: review repros R2, R5", () => {
  it("R2: the task is stopped with [answer naming no open card, stop] in one chunk at its question card; the result card's undo then does nothing (the respond is read by the question card's leftover wait)", async () => {
    const d = desk();
    const input = new PassThrough();
    const events: AppEvent[] = [];
    const steps: Step[] = [
      { calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] },
      { calls: [{ name: "ask_user", args: { question: "还要接着做吗？", options: ["接着做"] } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "写了" } }] },
    ];
    const out = (e: AppEvent) => {
      events.push(e);
      if (e.kind === "ask") setTimeout(() => input.write([{ type: "answer", ask_id: "ask_nowhere", option: 0 }, { type: "stop" }].map((c) => JSON.stringify(c) + "\n").join("")), 1);
      if (e.kind === "task_done") setTimeout(() => {
        input.write(JSON.stringify({ type: "respond", option: e.result_card!.options.findIndex((x) => x.kind === "undo") }) + "\n");
        setTimeout(() => input.end(), 300);
      }, 1);
    };
    await appRun({ run_id: "run_r2", raw: "新建 a.txt", config: "ds-flash", scope: d.scope }, { runs: fs.mkdtempSync(path.join(os.tmpdir(), "result-card-runs-")), out, input: new LineReader(input), linger: 600,
      inject: { driver: d.sim, gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream(steps) } } });
    expect(events.find((e) => e.kind === "task_done")).toMatchObject({ status: "stopped" });
    expect(events.find((e) => e.kind === "result_response")).toMatchObject({ picked: "undo", undone: 1, total: 1 });
    expect(fs.existsSync(path.join(d.scope, "a.txt"))).toBe(false);
  });

  it("R5: a respond the session forwards just before undo_until, read by the executor just after its own deadline tick: the session records task_undo unknown (an undo cut off) though nothing ran", async () => {
    const clock = new FakeClock();
    const s = session({ clock, scripts: [() => CREATE_THEN_ASK()], onAsk: (e, send) => setTimeout(() => send({ type: "stop", run_id: e.run_id }), 1) });
    s.send({ type: "cua", text: "新建 a.txt" });
    await waitFor(() => s.of("session.task_end").length === 1);
    const run = s.of("task_done")[0].run_id as string;
    const until = s.of("task_done")[0].undo_until as number;
    clock.sleep(until * 1000 - clock.now() - 1);              // 1 ms before the deadline, by the wall clock
    s.send({ type: "respond", run_id: run, option: 1 });      // the session: still open → undoing, task_respond stored, forwarded
    expect(s.of("session.task_respond", run)).toHaveLength(1);
    clock.advance(1000);                                       // the executor's deadline tick runs before it reads the line
    await waitFor(() => s.of("session.task_closed", run).length === 1);
    await sleep(50);
    expect(fs.existsSync(path.join(s.desks[0]!.scope, "a.txt"))).toBe(true);   // nothing was undone
    // nothing ran: never recorded as an undo cut off half way
    expect(s.of("session.task_undo", run).filter((e) => e.unknown)).toEqual([]);
  });
});

// gap tests: pass at 711a04d, fail under the surviving mutations M6 (a stop while undoing closes the card) and M2 (a
// keep is taken as undoing)
describe("H2 round 6: review gap tests G6, G2", () => {
  /** An executor that says task_done with an undo card (options: approve, undo), and dies 5 ms after `dieOn` reaches it. */
  function dying(dieOn: (j: any) => boolean) {
    let die!: (x: { code: number | null; signal: string | null }) => void;
    const launch: Launcher = (_req, lo) => {
      let cb: ((l: string) => void) | null = null;
      const exited = new Promise<{ code: number | null; signal: string | null }>((r) => { die = r; });
      return {
        start: () => setTimeout(() => cb?.(JSON.stringify({ seq: 1, t: Date.now() / 1000, run_id: lo.runId, kind: "task_done", status: "succeeded", summary: "ok", reason: "", result_card: { kind: "result", text: "做了", options: [{ kind: "approve", text: "好的" }, { kind: "undo", text: "撤回" }], free_text: false, blocking: false } })), 5),
        write: (l: string) => { if (dieOn(JSON.parse(l))) setTimeout(() => die({ code: 1, signal: null }), 5); },
        close: () => {}, onLine: (f: (l: string) => void) => { cb = f; }, exited,
      } as never;
    };
    const evs: any[] = [];
    const h = new SessionHost({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "result-card-ses-")), sessionId: "ses_gap", out: (e) => evs.push(e), coalesceMs: 5,
      model: { model: MODEL, streamFn: scriptedStream([{ text: "好" }]) }, launch, linger: 600 });
    hosts.push(h);
    h.start();
    h.handle(JSON.stringify({ type: "cua", text: "新建 a.txt" }));
    return { h, evs };
  }

  it("G6: undoing + stop, then the executor dies before the undo's outcome: still recorded unknown (the stop does not close an undo under way)", async () => {
    const { h, evs } = dying((j) => j.type === "stop");
    await waitFor(() => evs.some((e) => e.kind === "session.task_end"));
    const run = evs.find((e) => e.kind === "task_done").run_id;
    h.handle(JSON.stringify({ type: "respond", run_id: run, option: 1 }));
    h.handle(JSON.stringify({ type: "stop", run_id: run }));
    await waitFor(() => evs.some((e) => e.kind === "session.task_closed"));
    expect(evs.find((e) => e.kind === "session.task_undo")).toMatchObject({ unknown: true });
  });

  it("G2: a respond that is not undo (approve), then the executor dies before its result_response: no undo is recorded at all", async () => {
    const { h, evs } = dying((j) => j.type === "respond");
    await waitFor(() => evs.some((e) => e.kind === "session.task_end"));
    const run = evs.find((e) => e.kind === "task_done").run_id;
    h.handle(JSON.stringify({ type: "respond", run_id: run, option: 0 }));
    await waitFor(() => evs.some((e) => e.kind === "session.task_closed"));
    expect(evs.filter((e) => e.kind === "session.task_undo")).toEqual([]);
  });
});

describe("H2 round 6: every respond the session forwards gets one result_response", () => {
  it("a respond forwarded just before undo_until and read after the executor's deadline: answered 'expired', recorded as such (not cut off); the session stops forwarding", async () => {
    const clock = new FakeClock();
    const s = session({ clock, scripts: [() => CREATE_THEN_ASK()], onAsk: (e, send) => setTimeout(() => send({ type: "stop", run_id: e.run_id }), 1) });
    s.send({ type: "cua", text: "新建 a.txt" });
    await waitFor(() => s.of("session.task_end").length === 1);
    const run = s.of("task_done")[0].run_id as string;
    clock.sleep((s.of("task_done")[0].undo_until as number) * 1000 - clock.now() - 1);
    s.send({ type: "respond", run_id: run, option: 1 });
    clock.advance(1000);
    await waitFor(() => s.of("session.task_closed", run).length === 1);
    expect(s.of("result_response", run)).toEqual([expect.objectContaining({ picked: "undo", undone: 0, refused: "expired" })]);
    expect(s.of("session.task_undo", run)).toEqual([expect.objectContaining({ undone: 0, refused: "expired" })]);
    expect(s.of("session.task_undo", run)[0]).not.toHaveProperty("unknown");
    expect(s.of("result_card_closed", run)).toHaveLength(1);
    expect(fs.existsSync(path.join(s.desks[0]!.scope, "a.txt"))).toBe(true);
  });
});

describe("H2 round 8: the result card is registered before task_done announces it", () => {
  it("app-run: an undo sent inside the task_done event is carried out", async () => {
    const d = desk();
    const input = new PassThrough();
    const events: AppEvent[] = [];
    const out = (e: AppEvent) => {
      events.push(e);
      if (e.kind === "task_done") { input.write(JSON.stringify({ type: "respond", option: e.result_card!.options.findIndex((x) => x.kind === "undo") }) + "\n"); }
      if (e.kind === "result_response") input.end();
    };
    await Promise.race([appRun({ run_id: "run_sync", raw: "新建 a.txt", config: "ds-flash", scope: d.scope }, { runs: fs.mkdtempSync(path.join(os.tmpdir(), "result-card-runs-")), out, input: new LineReader(input), linger: 600,
      inject: { driver: d.sim, gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream(CREATE()) } } }), sleep(4000)]);
    expect(events.find((e) => e.kind === "result_response")).toMatchObject({ picked: "undo", undone: 1, total: 1 });
    expect(tree(d.scope)).toEqual(d.before);
  });

  it("through the session: an undo sent inside the task_done event is taken (open), recorded and carried out; a stop sent there closes the card", async () => {
    for (const how of ["respond", "stop"] as const) {
      const clock = new FakeClock();
      let s!: ReturnType<typeof session>;
      s = session({ clock, scripts: [() => CREATE()] });
      const evs = s.evs;
      // answer inside the very event, before anything else runs
      const orig = evs.push.bind(evs);
      evs.push = (...xs: any[]) => { const n = orig(...xs); for (const e of xs) if (e.kind === "task_done") s.send(how === "respond" ? { type: "respond", run_id: e.run_id, option: 1 } : { type: "stop", run_id: e.run_id }); return n; };
      s.send({ type: "cua", text: "新建 b.txt" });
      if (how === "respond") {
        await waitFor(() => s.of("session.task_undo").length === 1);
        expect(s.of("session.task_undo")[0]).toMatchObject({ undone: 1, total: 1, refused: null });
        expect(s.of("session.error")).toEqual([]);
        expect(fs.existsSync(path.join(s.desks[0]!.scope, "b.txt"))).toBe(false);
      } else {
        await waitFor(() => s.of("session.task_closed").length === 1);
        s.send({ type: "respond", run_id: s.of("task_done")[0].run_id, option: 1 });
        expect(s.of("session.task_respond")).toEqual([]);
        expect(fs.existsSync(path.join(s.desks[0]!.scope, "b.txt"))).toBe(true);
      }
    }
  });
});

/** The undo copies on disk (files under .deskmind-undo, its owner records left out). */
const undoCopies = (scope: string): string[] => { const dir = path.join(scope, ".deskmind-undo"); return fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map(String).filter((p) => !p.endsWith("owner.json") && fs.statSync(path.join(dir, p)).isFile()) : []; };

describe("file undo: replace_text keeps a copy, trash moves back — both only while untouched (the disk is the oracle)", () => {
  /** app-run on the desk: `steps`, finish; at task_done `between` runs (another program, the situation), then the undo. */
  async function runAndUndo(d: Desk, steps: Step[], between: () => void = () => {}) {
    const input = new PassThrough();
    const events: AppEvent[] = [];
    const write = (c: unknown) => input.write(JSON.stringify(c) + "\n");
    let listing: string[] = [], copies: string[] = [];
    const out = (e: AppEvent) => {
      events.push(e);
      if (e.kind === "ask") setTimeout(() => write({ type: "answer", ask_id: e.ask_id, option: e.card.options.findIndex((x) => x.kind === "approve") }), 1);
      if (e.kind === "task_done") setTimeout(() => {
        // while the window is open: the copy is on disk, and never in what the model or the app is shown
        listing = new Workspace(d.scope).listing().entries.map((x) => x.path);
        copies = undoCopies(d.scope);
        between();
        const i = e.result_card?.options.findIndex((x) => x.kind === "undo") ?? -1;
        if (i >= 0) write({ type: "respond", option: i }); else input.end();
      }, 1);
      if (e.kind === "result_response") input.end();
    };
    await appRun({ run_id: "run_fu", raw: "改文件", config: "ds-flash", scope: d.scope }, { runs: fs.mkdtempSync(path.join(os.tmpdir(), "result-card-runs-")), out, input: new LineReader(input), linger: 600,
      inject: { driver: d.sim, gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream([{ calls: [{ name: "plan", args: { steps: [{ purpose: "改", objects: ["path:u2.txt", "path:notes/u1.txt"], consequence: "modify_user" }] } }] }, ...steps, { calls: [{ name: "finish", args: { outcome: "done", summary: "改了" } }] }]) } } });
    const done = events.find((e) => e.kind === "task_done") as Extract<AppEvent, { kind: "task_done" }>;
    return { done, response: events.find((e) => e.kind === "result_response") as any, listing, copies, left: fs.existsSync(path.join(d.scope, ".deskmind-undo")) ? fs.readdirSync(path.join(d.scope, ".deskmind-undo")) : [] };
  }
  const STEP: Record<string, Step> = {
    replace: { calls: [{ name: "fs_replace_text", args: { target: "u2.txt", text: "新的\n" } }] },
    trash: { calls: [{ name: "fs_trash", args: { target: "u2.txt" } }] },
    move: { calls: [{ name: "fs_move", args: { source: "u2.txt", destination: "notes/u3.txt" } }] },
    append: { calls: [{ name: "fs_append_line", args: { target: "u2.txt", line: "加一行" } }] },
    create: { calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] },
  };
  /** The path the step changed, to be touched by another program afterwards. */
  const WROTE: Record<string, string> = { replace: "u2.txt", trash: "u2.txt", move: "notes/u3.txt", append: "u2.txt", create: "a.txt" };

  it("the table: capability × (untouched | changed since | its undo copy gone) → undo offered, refused or done, and the folder after it", async () => {
    const rows: string[] = [];
    for (const cap of Object.keys(STEP)) for (const sit of ["untouched", "changed_since", "copy_gone"] as const) {
      if (sit === "copy_gone" && cap !== "replace" && cap !== "trash") continue;
      const d = desk();
      const r = await runAndUndo(d, [STEP[cap]!], () => {
        if (sit === "changed_since") fs.writeFileSync(path.join(d.scope, WROTE[cap]!), "another program wrote this");
        if (sit === "copy_gone") { for (const c of undoCopies(d.scope)) fs.rmSync(path.join(d.scope, ".deskmind-undo", c)); const t = path.join(d.scope, ".deskmind-trash"); if (fs.existsSync(t)) for (const f of fs.readdirSync(t, { recursive: true }).map(String)) if (fs.statSync(path.join(t, f)).isFile()) fs.rmSync(path.join(t, f)); }
      });
      const row = `${cap} × ${sit}`;
      rows.push(row);
      expect(r.done.status, row).toBe("succeeded");
      expect(r.done.result_card!.options.some((x) => x.kind === "undo"), row).toBe(true);        // every one has a recipe
      expect(r.listing.some((p) => p.startsWith(".deskmind")), row).toBe(false);                  // never shown
      expect(Object.values(r.done.changes ?? {}).flat().some((p) => String(p).startsWith(".deskmind")), row).toBe(false);   // never a change
      if (cap === "replace") expect(r.copies, row).toHaveLength(1);                               // kept before the write
      if (sit === "untouched") {
        expect(r.response, row).toMatchObject({ picked: "undo", undone: 1, total: 1, refused: null });
        expect(tree(d.scope), row).toEqual(d.before);
      } else {
        expect(r.response.undone, row).toBe(0);
        expect(r.response.refused, row).toBeTruthy();
        expect(tree(d.scope), row).not.toEqual(d.before);                                         // nothing taken back on a guess
      }
      expect(r.left, row).toEqual([]);                                                            // the copies go with the window
    }
    expect(rows).toHaveLength(12);
  }, 60_000);

  it("trash keeps every trashed file under its own name: two files of the same name trashed, undo puts each back", async () => {
    const d = desk();
    fs.writeFileSync(path.join(d.scope, "notes", "u2.txt"), "notes 里的");
    const before = tree(d.scope);
    const r = await runAndUndo(d, [STEP.trash!, { calls: [{ name: "fs_trash", args: { target: "notes/u2.txt" } }] }, { calls: [{ name: "fs_create_text", args: { parent: ".", name: "u2.txt", text: "新的同名" } }] }, { calls: [{ name: "fs_trash", args: { target: "u2.txt" } }] }]);
    expect(r.response).toMatchObject({ picked: "undo", undone: 4, total: 4, refused: null });
    expect(tree(d.scope)).toEqual(before);
  });

  it("the copy's place and version are in the step's journal intent, written before the write (a crash leaves it findable)", async () => {
    const d = desk();
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), "result-card-runs-"));
    const input = new PassThrough();
    await appRun({ run_id: "run_j", raw: "改", config: "ds-flash", scope: d.scope }, { runs, out: (e) => { if (e.kind === "ask") setTimeout(() => input.write(JSON.stringify({ type: "answer", ask_id: e.ask_id, option: 0 }) + "\n"), 1); }, input: new LineReader(input), linger: 0,
      inject: { driver: d.sim, gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream([{ calls: [{ name: "plan", args: { steps: [{ purpose: "改", objects: ["path:u2.txt"], consequence: "modify_user" }] } }] }, STEP.replace!, { calls: [{ name: "finish", args: { outcome: "done", summary: "x" } }] }]) } } });
    const j = parseJournal(fs.readFileSync(path.join(runs, "run_j", "journal.jsonl"), "utf-8"));
    const i = j.findIndex((l) => l.kind === "intent");
    expect(j[i]).toMatchObject({ undo_prep: { backup: expect.stringMatching(/^\.deskmind-undo\/run_j\//), version: expect.stringMatching(/^sha256:/) } });
    expect(j[i + 1]).toMatchObject({ kind: "receipt", status: "ok" });
  });

  it("through the session (the 清单 case): a /cua replaces 「苹果」 with 「香蕉」 in the user's file — task_end undo open, the undo puts the file back", async () => {
    const clock = new FakeClock();
    const s = session({ clock, scripts: [(d) => { fs.writeFileSync(path.join(d.scope, "清单.txt"), "购物清单\n苹果 3 个\n牛奶 1 盒\n"); d.before = tree(d.scope); return [
      { calls: [{ name: "plan", args: { steps: [{ purpose: "把苹果改成香蕉", objects: ["path:清单.txt"], consequence: "modify_user" }] } }] },
      { calls: [{ name: "fs_replace_text", args: { target: "清单.txt", text: "购物清单\n香蕉 3 个\n牛奶 1 盒\n" } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "改好了" } }] },
    ]; }] });
    s.send({ type: "cua", text: "把 清单.txt 里的「苹果」都改成「香蕉」" });
    await waitFor(() => s.of("session.task_end").length === 1);
    const done = s.of("task_done")[0];
    expect(done.changes.modified).toEqual(["清单.txt"]);
    expect(s.of("session.task_end")[0]).toMatchObject({ status: "succeeded", undo: "open" });
    expect(fs.readFileSync(path.join(s.desks[0]!.scope, "清单.txt"), "utf-8")).toContain("香蕉");
    s.send({ type: "respond", run_id: done.run_id, option: done.result_card.options.findIndex((x: any) => x.kind === "undo") });
    await waitFor(() => s.of("session.task_undo").length === 1);
    expect(s.of("session.task_undo")[0]).toMatchObject({ undone: 1, total: 1, refused: null });
    expect(tree(s.desks[0]!.scope)).toEqual(s.desks[0]!.before);
    await waitFor(() => s.of("session.task_closed").length === 1);
    expect(undoCopies(s.desks[0]!.scope)).toEqual([]);
  });

  it("policy unchanged: replace_text and trash stay not reversible (never done on the model's reading of an ambiguous request)", () => {
    const reg = fileRegistry();
    expect(reg.get("fs.replace_text")).toMatchObject({ reversible: false });
    expect(reg.get("fs.trash")).toMatchObject({ reversible: false });
    expect(typeof reg.get("fs.replace_text")!.undo).toBe("function");
    expect(typeof reg.get("fs.trash")!.undo).toBe("function");
  });

  // review of #74 (REV74 F): a file made read-only or locked after the task let the undo start, take the newer steps
  // back, and then throw (EACCES) — no result_response, the app crashed, copies left. Invariants: the check asks the
  // same permission question the undo meets (writeBack: mode, folder, the Finder's lock); and an undo never throws —
  // the unforeseen (an I/O error) stops it at that step with an honest account, and the exit path still runs
  it("the table: capability × (read-only target, locked target, read-only folder, I/O error injected) → refused with nothing touched, done, or an honest partial account; never a crash", async () => {
    // each capability's step, then a newer step in a folder of its own (so a locked folder of the first step's does
    // not refuse the newer one): a refusal must leave the newer one's file in place
    const OWN: Record<string, { step: Step; target: (scope: string) => string; folder: string; call: "copyFileSync" | "truncateSync" | "renameSync" | "unlinkSync" }> = {
      replace: { step: STEP.replace!, target: (s) => path.join(s, "u2.txt"), folder: ".", call: "copyFileSync" },
      append: { step: STEP.append!, target: (s) => path.join(s, "u2.txt"), folder: ".", call: "truncateSync" },
      create: { step: STEP.create!, target: (s) => path.join(s, "a.txt"), folder: ".", call: "unlinkSync" },
      move: { step: STEP.move!, target: (s) => path.join(s, "notes", "u3.txt"), folder: "notes", call: "renameSync" },
      // the file undo moves back: the one in the trash
      trash: { step: STEP.trash!, target: (s) => { const t = path.join(s, ".deskmind-trash"); return path.join(t, fs.readdirSync(t)[0]!, "u2.txt"); }, folder: ".", call: "renameSync" },
    };
    const NEWER: Step = { calls: [{ name: "fs_create_text", args: { parent: "later", name: "z.txt", text: "newer" } }] };
    // what each situation leads to, per capability: the undo's own writes decide it
    const EXPECT: Record<string, Record<string, "refused" | "done" | "partial">> = {
      readonly_target: { replace: "refused", append: "refused", create: "done", move: "done", trash: "done" },  // a read-only file can still be unlinked or renamed
      locked_target: { replace: "refused", append: "refused", create: "refused", move: "refused", trash: "refused" },
      readonly_folder: { replace: "done", append: "done", create: "refused", move: "refused", trash: "refused" },   // bytes written in place need no folder
      io_error: { replace: "partial", append: "partial", create: "partial", move: "partial", trash: "partial" },
    };
    const isMac = process.platform === "darwin";
    const rows: string[] = [];
    for (const cap of Object.keys(OWN)) for (const sit of Object.keys(EXPECT)) {
      if (sit === "locked_target" && !isMac) continue;
      const o = OWN[cap]!, want = EXPECT[sit]![cap]!, row = `${cap} × ${sit}`;
      const d = desk();
      fs.mkdirSync(path.join(d.scope, "later"));
      d.before = tree(d.scope);
      const folder = path.join(d.scope, o.folder);
      const real = (fsCjs as any)[o.call];
      let target = "";
      const undoLocks = () => {
        try { if (target && isMac) execFileSync("chflags", ["nouchg", target]); } catch { /* gone */ }
        try { if (target) fs.chmodSync(target, 0o644); } catch { /* gone */ }
        fs.chmodSync(folder, 0o755);
        (fsCjs as any)[o.call] = real; syncBuiltinESMExports();
      };
      let r: Awaited<ReturnType<typeof runAndUndo>>;
      try {
        r = await runAndUndo(d, [o.step, NEWER], () => {
          target = o.target(d.scope);
          if (sit === "readonly_target") fs.chmodSync(target, 0o444);
          if (sit === "locked_target") execFileSync("chflags", ["uchg", target]);
          if (sit === "readonly_folder") fs.chmodSync(folder, 0o555);
          if (sit === "io_error") {
            // the disk fails as this step is taken back (and only then): nothing a check could have seen
            (fsCjs as any)[o.call] = (...xs: unknown[]) => {
              if (xs.some((x) => typeof x === "string" && (x === target || path.basename(x) === path.basename(target)) && !x.includes(".deskmind-undo"))) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
              return real(...xs);
            };
            syncBuiltinESMExports();
          }
        });
      } finally { undoLocks(); }
      rows.push(row);
      const resp = r.response;
      expect(resp, row).toBeTruthy();                                                               // answered: no crash
      expect(resp.total, row).toBe(2);
      if (want === "refused") {
        expect(resp, row).toMatchObject({ undone: 0, refused: expect.stringMatching(/read-only|locked/) });
        expect(fs.existsSync(path.join(d.scope, "later", "z.txt")), row).toBe(true);              // nothing touched
      } else if (want === "done") {
        expect(resp, row).toMatchObject({ undone: 2, refused: null });
        expect(tree(d.scope), row).toEqual(d.before);
      } else {
        // the newer step taken back, this one failed in: said as such, the older ones (none here) untouched
        expect(resp, row).toMatchObject({ undone: 1, refused: expect.stringContaining("EIO"), unsure: expect.any(String) });
        expect(resp.refused, row).toContain("may be partly taken back");
        expect(fs.existsSync(path.join(d.scope, "later", "z.txt")), row).toBe(false);
      }
      expect(r.left, row).toEqual([]);                                                              // the exit path ran: copies gone
    }
    expect(rows).toHaveLength(isMac ? 20 : 15);
  }, 120_000);

  it("a case-sensitive volume: another file whose name differs only in case is another file — no false refusal", async () => {
    if (process.platform !== "darwin") return;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cs-vol-")), img = path.join(tmp, "cs.dmg"), mnt = path.join(tmp, "mnt");
    try { execFileSync("hdiutil", ["create", "-size", "20m", "-fs", "Case-sensitive APFS", "-volname", "cs", img], { stdio: "ignore" }); fs.mkdirSync(mnt); execFileSync("hdiutil", ["attach", "-nobrowse", "-mountpoint", mnt, img], { stdio: "ignore" }); }
    catch { return; }   // no disk images here: nothing to test on
    try {
      forgetVolumeNames();
      const d = desk(mnt);
      fs.writeFileSync(path.join(d.scope, "U2.txt"), "大写的另一个文件");
      expect(fs.readFileSync(path.join(d.scope, "u2.txt"), "utf-8")).toBe("二");               // two files on this volume
      d.before = tree(d.scope);
      // u2.txt trashed, then a newer step changes U2.txt: on this volume two files, so the undo takes both back
      const r = await runAndUndo(d, [STEP.trash!, { calls: [{ name: "fs_append_line", args: { target: "U2.txt", line: "加" } }] }]);
      expect(r.response, "case-sensitive").toMatchObject({ undone: 2, total: 2, refused: null });
      expect(tree(d.scope)).toEqual(d.before);
    } finally { try { execFileSync("hdiutil", ["detach", mnt, "-force"], { stdio: "ignore" }); } catch { /* left mounted */ } fs.rmSync(tmp, { recursive: true, force: true }); forgetVolumeNames(); }
  }, 60_000);
});

describe("REV74 (review of #74, adopted)", () => {
  const plan = { calls: [{ name: "plan", args: { steps: [{ purpose: "改", objects: ["path:u2.txt", "path:notes/u1.txt"], consequence: "modify_user" }] } }] };
  function start(d: Desk, steps: Step[], onDone: (e: any, write: (c: unknown) => void, input: PassThrough) => void, signals?: any) {
    const input = new PassThrough();
    const events: AppEvent[] = [];
    const write = (c: unknown) => input.write(JSON.stringify(c) + "\n");
    const out = (e: AppEvent) => {
      events.push(e);
      if (e.kind === "ask") setTimeout(() => write({ type: "answer", ask_id: e.ask_id, option: e.card.options.findIndex((x) => x.kind === "approve") }), 1);
      if (e.kind === "task_done") setTimeout(() => onDone(e, write, input), 1);
      if (e.kind === "result_response") input.end();
    };
    const run = appRun({ run_id: "run_r", raw: "改文件", config: "ds-flash", scope: d.scope }, { runs: fs.mkdtempSync(path.join(os.tmpdir(), "rev74-runs-")), out, input: new LineReader(input), linger: 600,
      ...(signals ? { signals } : {}),
      inject: { driver: d.sim, gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream([plan, ...steps, { calls: [{ name: "finish", args: { outcome: "done", summary: "改了" } }] }]) } } });
    return { run, events };
  }
  const copiesIn = (d: Desk) => undoCopies(d.scope);

  it("A: SIGTERM while the card lingers (session ending a lingering holder) leaves the copy", async () => {
    const d = desk();
    let signal!: (s: string) => void; let exited = false;
    const r = start(d, [{ calls: [{ name: "fs_replace_text", args: { target: "u2.txt", text: "新的\n" } }] }], () => { signal("SIGTERM"); },
      { onSignal: (h: any) => { signal = h; }, exit: () => { exited = true; }, exitNow: () => { exited = true; }, deadlineMs: 50, waitMs: 100 });
    await waitFor(() => exited, 8000);
    expect(copiesIn(d)).toEqual([]);
  });

  it("B: trash of a file in a subfolder, the subfolder removed afterwards, a newer step: undo must refuse with nothing taken back", async () => {
    const d = desk();
    const r = start(d, [
      { calls: [{ name: "fs_trash", args: { target: "notes/u1.txt" } }] },
      { calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] },
    ], (e, write, input) => {
      fs.rmdirSync(path.join(d.scope, "notes"));       // another program removes the now-empty folder
      const i = e.result_card?.options.findIndex((x: any) => x.kind === "undo") ?? -1;
      if (i >= 0) write({ type: "respond", option: i }); else input.end();
    });
    await r.run;
    const resp = r.events.find((e) => e.kind === "result_response") as any;
    expect(resp?.refused).toBeTruthy();
    expect(resp.undone).toBe(0);
    expect(fs.existsSync(path.join(d.scope, "a.txt"))).toBe(true);    // nothing taken back
  });

  it("C: same file replaced twice, then undo: byte-equal, mode kept", async () => {
    const d = desk();
    fs.chmodSync(path.join(d.scope, "u2.txt"), 0o600);
    const r = start(d, [
      { calls: [{ name: "fs_replace_text", args: { target: "u2.txt", text: "一次\n" } }] },
      { calls: [{ name: "fs_replace_text", args: { target: "u2.txt", text: "两次\n" } }] },
    ], (e, write, input) => { const i = e.result_card?.options.findIndex((x: any) => x.kind === "undo") ?? -1; if (i >= 0) write({ type: "respond", option: i }); else input.end(); });
    await r.run;
    expect(r.events.find((e) => e.kind === "result_response")).toMatchObject({ undone: 2, refused: null });
    expect(tree(d.scope)).toEqual(d.before);
    expect(fs.statSync(path.join(d.scope, "u2.txt")).mode & 0o777).toBe(0o600);
    expect(copiesIn(d)).toEqual([]);
  });

  it("E: trash u2.txt + newer create, then another program makes U2.txt (case-insensitive volume): refuse as a whole", async () => {
    const d = desk();
    const r = start(d, [
      { calls: [{ name: "fs_trash", args: { target: "u2.txt" } }] },
      { calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] },
    ], (e, write, input) => {
      fs.writeFileSync(path.join(d.scope, "U2.txt"), "user's new file");
      const i = e.result_card?.options.findIndex((x: any) => x.kind === "undo") ?? -1;
      if (i >= 0) write({ type: "respond", option: i }); else input.end();
    });
    await r.run;
    const resp = r.events.find((e) => e.kind === "result_response") as any;
    expect(resp.undone).toBe(0);
  });

  it("E2: a CJK name taken again in its other Unicode form (NFD) after the trash: refused as a whole, nothing taken back", async () => {
    const d = desk();
    const name = "가방.txt";                                   // Hangul: its NFD form is another byte string, the same name to the volume
    fs.writeFileSync(path.join(d.scope, name.normalize("NFC")), "가방");
    const r = start(d, [
      { calls: [{ name: "fs_trash", args: { target: name } }] },
      { calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] },
    ], (e, write, input) => {
      fs.writeFileSync(path.join(d.scope, name.normalize("NFD")), "another program's");
      const i = e.result_card?.options.findIndex((x: any) => x.kind === "undo") ?? -1;
      if (i >= 0) write({ type: "respond", option: i }); else input.end();
    });
    await r.run;
    const resp = r.events.find((e) => e.kind === "result_response") as any;
    expect(resp.undone).toBe(0);
    expect(resp.refused).toBeTruthy();
    expect(fs.existsSync(path.join(d.scope, "a.txt"))).toBe(true);
  });

  /** Run `steps`, then `between` (the user, after the task), then the undo; the answer and whether appRun threw. */
  async function undoAfter(d: Desk, steps: Step[], between: () => void) {
    const r = start(d, steps, (e, write, input) => {
      between();
      const i = e.result_card?.options.findIndex((x: any) => x.kind === "undo") ?? -1;
      if (i >= 0) write({ type: "respond", option: i }); else input.end();
    });
    let threw: unknown = null;
    try { await Promise.race([r.run, new Promise((_, rej) => setTimeout(() => rej(new Error("hung")), 8000))]); } catch (e) { threw = e; }
    return { threw, resp: r.events.find((e) => e.kind === "result_response") as any };
  }

  it("G: replace u2.txt, then move it to notes/u3.txt; the user makes notes/u3.txt read-only: refused before anything (the check asks about the file the replace's undo will write — u3.txt brought back)", async () => {
    const d = desk();
    const x = await undoAfter(d, [
      { calls: [{ name: "fs_replace_text", args: { target: "u2.txt", text: "新的\n" } }] },
      { calls: [{ name: "fs_move", args: { source: "u2.txt", destination: "notes/u3.txt" } }] },
    ], () => fs.chmodSync(path.join(d.scope, "notes", "u3.txt"), 0o444));
    expect(x.threw).toBeNull();
    expect(x.resp).toMatchObject({ undone: 0, total: 2, refused: expect.stringMatching(/read-only/) });
    expect(fs.existsSync(path.join(d.scope, "notes", "u3.txt"))).toBe(true);                     // nothing taken back
  });

  it("G2: replace u2.txt, then trash it; the user makes the trashed file read-only: refused before anything (the file the replace's undo writes is the trashed one put back)", async () => {
    const d = desk();
    const x = await undoAfter(d, [
      { calls: [{ name: "fs_replace_text", args: { target: "u2.txt", text: "新的\n" } }] },
      { calls: [{ name: "fs_trash", args: { target: "u2.txt" } }] },
    ], () => { const t = path.join(d.scope, ".deskmind-trash"); fs.chmodSync(path.join(t, fs.readdirSync(t)[0]!, "u2.txt"), 0o444); });
    // the replace's undo writes the trashed file once it is back: read-only, so refused as a whole
    expect(x.threw).toBeNull();
    expect(x.resp).toMatchObject({ undone: 0, total: 2, refused: expect.stringMatching(/read-only/) });
    expect(fs.existsSync(path.join(d.scope, "u2.txt"))).toBe(false);
  });

  it("H: create a.txt; the user makes notes/ unreadable (chmod 000): the undo answers (refused as a whole), never throws", async () => {
    const d = desk();
    let x: Awaited<ReturnType<typeof undoAfter>>;
    try { x = await undoAfter(d, [{ calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] }], () => fs.chmodSync(path.join(d.scope, "notes"), 0o000)); }
    finally { fs.chmodSync(path.join(d.scope, "notes"), 0o755); }
    expect(x.threw).toBeNull();
    expect(x.resp).toMatchObject({ undone: 0, total: 1, refused: expect.stringMatching(/could not check the undo/) });
    expect(fs.existsSync(path.join(d.scope, "a.txt"))).toBe(true);
    expect(copiesIn(d)).toEqual([]);
  });

  it("a folder moved across parents, made 555 by the user: moving it back needs write permission on itself — refused before anything", async () => {
    const d = desk();
    fs.mkdirSync(path.join(d.scope, "archive"));
    let x: Awaited<ReturnType<typeof undoAfter>>;
    try {
      x = await undoAfter(d, [
        { calls: [{ name: "fs_move", args: { source: "notes", destination: "archive/notes" } }] },
        { calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] },
      ], () => fs.chmodSync(path.join(d.scope, "archive", "notes"), 0o555));
    } finally { try { fs.chmodSync(path.join(d.scope, "archive", "notes"), 0o755); } catch { /* moved back */ } }
    expect(x.threw).toBeNull();
    expect(x.resp).toMatchObject({ undone: 0, total: 2, refused: expect.stringMatching(/folder archive\/notes is read-only/) });
    expect(fs.existsSync(path.join(d.scope, "a.txt"))).toBe(true);
  });

  it("a volume probe a dead process left in .deskmind-tmp is swept by the next app run", async () => {
    const d = desk();
    const tmpDir = path.join(d.scope, ".deskmind-tmp"), probe = path.join(tmpDir, "probe-dead0000-a\u00e9");
    fs.mkdirSync(tmpDir); fs.writeFileSync(probe, "");
    const old = new Date(Date.now() - 5 * 60_000); fs.utimesSync(probe, old, old);
    await undoAfter(d, [{ calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] }], () => {});
    expect(fs.existsSync(probe)).toBe(false);
  });

  it("D: trash a file whose name is 250 bytes (worked on main)", async () => {
    const d = desk();
    const name = "长".repeat(81) + ".txt";   // 244 bytes
    fs.writeFileSync(path.join(d.scope, name), "x");
    const r = start(d, [{ calls: [{ name: "fs_trash", args: { target: name } }] }], (e, write, input) => input.end());
    await r.run;
    expect(fs.existsSync(path.join(d.scope, name))).toBe(false);
  });
});

describe("file undo: every exit path of the executor discards its own copies; the next app run sweeps a dead run's", () => {
  const copies = undoCopies;
  const REPLACE: Step = { calls: [{ name: "fs_replace_text", args: { target: "u2.txt", text: "新的\n" } }] };
  const PLAN: Step = { calls: [{ name: "plan", args: { steps: [{ purpose: "改", objects: ["path:u2.txt"], consequence: "modify_user" }] } }] };
  /** app-run: plan, replace, then `tail` (default: finish); `at`: what the test does at task_done (or at the replace's
   *  step_result: "running"). Returns when the process would exit. */
  async function exitBy(how: "end_no_card_wait" | "answered" | "linger_timeout" | "stdin_closed" | "sigterm_running" | "sigterm_lingering") {
    const d = desk();
    const input = new PassThrough();
    const clock = new FakeClock();
    let signal!: (s: string) => void, exited!: () => void;
    const exitedP = new Promise<void>((r) => { exited = r; });
    let sawCopy = false;
    const out = (e: AppEvent) => {
      if (e.kind === "ask") setTimeout(() => input.write(JSON.stringify({ type: "answer", ask_id: e.ask_id, option: e.card.options.findIndex((x) => x.kind === "approve") }) + "\n"), 1);
      if (e.kind === "step_result") { sawCopy ||= copies(d.scope).length > 0; if (how === "sigterm_running") setTimeout(() => signal("SIGTERM"), 1); }
      if (e.kind === "task_done") setTimeout(() => {
        sawCopy ||= copies(d.scope).length > 0;
        if (how === "answered") input.write(JSON.stringify({ type: "respond", option: e.result_card!.options.findIndex((x) => x.kind === "approve") }) + "\n");
        if (how === "linger_timeout") clock.advance(601_000);
        if (how === "stdin_closed") input.end();
        if (how === "sigterm_lingering") signal("SIGTERM");
      }, 1);
    };
    const steps: Step[] = [PLAN, REPLACE, ...(how === "sigterm_running" ? [{ calls: [{ name: "ask_user", args: { question: "还要接着做吗？", options: ["接着做"] } }] } as Step] : []), { calls: [{ name: "finish", args: { outcome: "done", summary: "改了" } }] }];
    const run = appRun({ run_id: "run_exit", raw: "改", config: "ds-flash", scope: d.scope }, { runs: fs.mkdtempSync(path.join(os.tmpdir(), "result-card-runs-")), out, input: new LineReader(input), linger: how === "end_no_card_wait" ? 0 : 600,
      signals: { onSignal: (h: (s: string) => void) => { signal = h; }, exit: () => exited(), exitNow: () => exited(), deadlineMs: 50, waitMs: 100 },
      inject: { driver: d.sim, gateway: gateway(), clock, model: { model: MODEL, streamFn: scriptedStream(steps) } } });
    await Promise.race([run, exitedP]);
    return { d, sawCopy, left: copies(d.scope) };
  }

  for (const how of ["end_no_card_wait", "answered", "linger_timeout", "stdin_closed", "sigterm_running", "sigterm_lingering"] as const) {
    it(`${how}: the copy existed while the task ran, and none is left when the process exits`, async () => {
      const r = await exitBy(how);
      expect(r.sawCopy, how).toBe(true);
      expect(r.left, how).toEqual([]);
    });
  }

  it("SIGKILL / crash (no exit path ran): the next app run in that folder sweeps the dead run's copies, never a live run's", async () => {
    const d = desk();
    const dead = path.join(d.scope, ".deskmind-undo", "run_dead"), live = path.join(d.scope, ".deskmind-undo", "run_live");
    for (const [dir, pid] of [[dead, 2 ** 22 + 12345], [live, process.pid]] as const) { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid })); fs.writeFileSync(path.join(dir, "copy"), "x"); }
    const input = new PassThrough();
    await appRun({ run_id: "run_next", raw: "看一眼", config: "ds-flash", scope: d.scope }, { runs: fs.mkdtempSync(path.join(os.tmpdir(), "result-card-runs-")), out: () => {}, input: new LineReader(input), linger: 0,
      inject: { driver: d.sim, gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream([{ calls: [{ name: "finish", args: { outcome: "cannot", summary: "x" } }] }]) } } });
    expect(fs.existsSync(dead)).toBe(false);
    expect(fs.existsSync(path.join(live, "copy"))).toBe(true);
  });
});

describe("file undo: a capability's check refuses whenever its undo would (never half way)", () => {
  const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  it("random file steps, then another program interferes at random: undo takes back all of it or none of it", async () => {
    const INTERFERE = ["none", "rm_notes", "retake_trashed", "retake_trashed_case", "retake_trashed_nfd", "symlink_trashed", "edit_a_file", "drop_copies", "rename_case", "readonly_a_file", "readonly_notes"];
    for (let seed = 101; seed < 167; seed++) {
      const rand = rng(seed);
      const pick = <X,>(xs: X[]) => xs[Math.floor(rand() * xs.length)]!;
      const d = desk();
      // a CJK name too, whose NFD form is another byte string the volume takes for the same name
      fs.writeFileSync(path.join(d.scope, "가방.txt"), "가방");
      d.before = tree(d.scope);
      const files = new Set(["notes/u1.txt", "u2.txt", "가방.txt"]);
      let n = 0;
      const steps: Step[] = [{ calls: [{ name: "plan", args: { steps: [{ purpose: "整理", objects: ["path:notes/u1.txt", "path:u2.txt", "path:가방.txt"], consequence: "modify_user" }] } }] }];
      const ops: string[] = [];
      // every interference in turn; one that takes a trashed path again gets a trash first and a newer step after it
      // (the case a check blind to it undoes half way)
      const interfere = INTERFERE[seed % INTERFERE.length]!;
      const trashFirst = interfere.startsWith("retake") || interfere === "symlink_trashed";
      for (let i = 0; i < 2 + Math.floor(rand() * 4); i++) {
        const op = trashFirst && i === 0 ? "trash" : files.size ? pick(["create", "move", "append", "replace", "trash"]) : "create";
        ops.push(op);
        if (op === "create") { const p = `n${n++}.txt`; files.add(p); steps.push({ calls: [{ name: "fs_create_text", args: { parent: ".", name: p, text: `t${i}` } }] }); }
        else if (op === "move") { const src = pick([...files]); const dst = `m${n++}.txt`; files.delete(src); files.add(dst); steps.push({ calls: [{ name: "fs_move", args: { source: src, destination: dst } }] }); }
        else if (op === "append") steps.push({ calls: [{ name: "fs_append_line", args: { target: pick([...files]), line: `l${i}` } }] });
        else if (op === "replace") steps.push({ calls: [{ name: "fs_replace_text", args: { target: pick([...files]), text: `r${i}\n` } }] });
        else { const f = pick([...files]); files.delete(f); steps.push({ calls: [{ name: "fs_trash", args: { target: f } }] }); }
      }
      // another program, between the task's end and the undo
      const r = runTask(d, steps, "succeeded", { undo: true });
      // (runTask answers the undo at task_done; interfere in the same tick, before the respond is read)
      const orig = r.events.push.bind(r.events);
      r.events.push = (...xs: AppEvent[]) => { for (const e of xs) if (e.kind === "task_done") {
        const trashed = Object.keys(d.before).filter((p) => !p.endsWith("/") && !fs.existsSync(path.join(d.scope, p)));
        try {
          if (interfere === "rm_notes" && fs.existsSync(path.join(d.scope, "notes")) && fs.readdirSync(path.join(d.scope, "notes")).length === 0) fs.rmdirSync(path.join(d.scope, "notes"));
          if (interfere === "retake_trashed" && trashed[0] && fs.existsSync(path.dirname(path.join(d.scope, trashed[0])))) fs.writeFileSync(path.join(d.scope, trashed[0]), "又放回来一个");
          // the same place under another spelling the volume takes for it: upper case; a CJK name's other Unicode form
          if (interfere === "retake_trashed_case" && trashed[0] && fs.existsSync(path.dirname(path.join(d.scope, trashed[0])))) fs.writeFileSync(path.join(d.scope, path.dirname(trashed[0]), path.basename(trashed[0]).toUpperCase()), "大写的");
          if (interfere === "retake_trashed_nfd" && trashed[0] && fs.existsSync(path.dirname(path.join(d.scope, trashed[0])))) fs.writeFileSync(path.join(d.scope, path.dirname(trashed[0]), path.basename(trashed[0]).normalize("NFD")), "另一种写法");
          if (interfere === "rename_case") { const f = [...files].find((p) => fs.existsSync(path.join(d.scope, p))); if (f) fs.renameSync(path.join(d.scope, f), path.join(d.scope, path.dirname(f), path.basename(f).toUpperCase())); }
          if (interfere === "symlink_trashed" && trashed[0] && fs.existsSync(path.dirname(path.join(d.scope, trashed[0])))) fs.symlinkSync("/nonexistent", path.join(d.scope, trashed[0]));
          if (interfere === "edit_a_file") { const f = [...files].find((p) => fs.existsSync(path.join(d.scope, p))); if (f) fs.appendFileSync(path.join(d.scope, f), "别人加的"); }
          if (interfere === "drop_copies") fs.rmSync(path.join(d.scope, ".deskmind-undo"), { recursive: true, force: true });
          // permissions the user changes: never a reason to stop half way (the check asks what the undo meets)
          if (interfere === "readonly_a_file") for (const f of [...files]) if (fs.existsSync(path.join(d.scope, f))) fs.chmodSync(path.join(d.scope, f), 0o444);
          if (interfere === "readonly_notes" && fs.existsSync(path.join(d.scope, "notes"))) fs.chmodSync(path.join(d.scope, "notes"), 0o555);
        } catch { /* the situation does not apply */ }
      } return orig(...xs); };
      try { await r.done; } finally { try { fs.chmodSync(path.join(d.scope, "notes"), 0o755); } catch { /* gone */ } }
      const resp = r.events.find((e) => e.kind === "result_response") as any;
      const ctx = `seed ${seed}: ${ops.join(",")} / ${interfere}`;
      if (!resp) continue;
      expect([0, resp.total], ctx).toContain(resp.undone);
      if (resp.undone === resp.total) expect(resp.refused, ctx).toBeNull();
    }
  }, 60_000);
});

describe("file undo: a restarted run's copy folder names the live process", () => {
  it("the first use in a process rewrites owner.json (a folder left by the run's dead process is not swept from under it)", () => {
    const d = desk();
    const dir = path.join(d.scope, ".deskmind-undo", "run_again");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: 2 ** 22 + 4321, run: "run_again" }));
    const ws = new Workspace(d.scope);
    ws.undoOwner = "run_again";
    ws.undoDir();
    expect(JSON.parse(fs.readFileSync(path.join(dir, "owner.json"), "utf-8")).pid).toBe(process.pid);
    new Workspace(d.scope).sweepUndo({ except: "someone_else" });
    expect(fs.existsSync(dir)).toBe(true);
  });
});
