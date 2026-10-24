/**
 * Computer tasks in a chat session (H2, docs/protocol.md 「会话（第 1 版）」): the session model's computer_task tool
 * and /cua, the executor's events and controls through the session, typing while a task runs (queue, steer, the open
 * card), undo and its expiry when another task starts on this Mac, the machine lock, the app going away mid-task,
 * resume, and retry. No network: a scripted session model, the executor in process (cli/app.ts appRun) on the
 * simulated computer with a scripted runtime and scripted judges.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import type { Message } from "@earendil-works/pi-ai";
import { SessionHost } from "../src/session/host.js";
import { SessionLog } from "../src/session/log.js";
import { reasoningBack, withReasoningBack, reply } from "../src/session/loop.js";
import { cutRaw, MAX_RAW, type ExecutorHandle, type Launcher } from "../src/session/task.js";
import { computerLockFile, held, readHolder, reapLater } from "../src/session/computer.js";
import { execFileSync, spawn } from "node:child_process";
import fsCjs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as http from "node:http";
import { isProvenance, scripted as judgeScript } from "./helpers/provenance-judge.js";
import { appRun, LineReader } from "../src/cli/app.js";
import { SimComputer } from "../src/executor/sim.js";
import { OUTGOING_QUESTION } from "../src/executor/judge.js";
import { Gateway } from "../src/gateway/index.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dm-h2-"));
const MODEL = { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 128_000, maxTokens: 8_000 } as never;
const roles = ["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"];
const gateway = () => {
  const gw = new Gateway(Object.fromEntries(roles.map((r) => [r, { backend: "scripted", model: "scripted" }])) as never);
  gw.script = Array(80).fill((role: string, _s: string, u: string) => (role === "verify" ? { choice: "pass", reason: "做完了" } : u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: "stays" } : { choice: "matches" }));
  return gw;
};
const lastJson = (ms: any[]) => { const m = [...ms].reverse().find((x) => x.role === "toolResult"); try { return JSON.parse(m.content[0].text.split("\n")[0]); } catch { return {}; } };
const textOf = (m: any) => (typeof m.content === "string" ? m.content : m.content.map((c: any) => c.text ?? (c.type === "toolCall" ? `[call ${c.name} ${JSON.stringify(c.arguments)}]` : "")).join(""));
const waitFor = async (cond: () => unknown, ms = 10_000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 5)); } };

/** Executors in process: each task takes the next runtime script; the runtime's model sees are kept per task. */
function inproc(scripts: Step[][], sim: (scope?: string) => SimComputer = (s) => new SimComputer(s)) {
  const requests: any[] = [], seen: Message[][][] = [], handles: ExecutorHandle[] = [];
  let i = 0;
  const launch: Launcher = (req, o) => {
    requests.push(req);
    const steps = scripts[i++] ?? [];
    const rt: Message[][] = []; seen.push(rt);
    const input = new PassThrough();
    let ended = false, cb: ((l: string) => void) | null = null;
    const early: string[] = [];
    const out = (e: unknown) => { const l = JSON.stringify(e); if (cb) cb(l); else early.push(l); };
    const exited = appRun(req as never, { runs: o.runs, out, input: new LineReader(input), linger: o.linger,
      inject: { driver: sim(req.scope as string | undefined), gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream(steps, rt) } } }).then(() => ({ code: 0, signal: null }));
    const h: ExecutorHandle = { write: (l) => { if (!ended) input.write(l + "\n"); }, close: () => { if (!ended) { ended = true; input.end(); } }, onLine: (f) => { cb = f; for (const l of early.splice(0)) f(l); }, exited };
    handles.push(h);
    return h;
  };
  return { launch, requests, seen, handles };
}

const hosts: SessionHost[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) h.end(); await new Promise((r) => setTimeout(r, 50)); });

function session(o: { model: Step[]; tasks?: Step[][]; dir?: string; sid?: string; scope?: string; launch?: Launcher; exitWaitMs?: number; sim?: (scope?: string) => SimComputer }) {
  const evs: any[] = [], seen: Message[][] = [];
  const dir = o.dir ?? tmp();
  const ex = inproc(o.tasks ?? [], o.sim);
  let onEvent: ((e: any) => void) | null = null;
  let exitedFlag = false, failure: string | undefined, exits = 0;
  const h = new SessionHost({ dir, sessionId: o.sid ?? "ses_t", out: (e) => { evs.push(e); onEvent?.(e); }, coalesceMs: 5, model: { model: MODEL, streamFn: scriptedStream(o.model, seen) },
    launch: o.launch ?? ex.launch, ...(o.exitWaitMs ? { exitWaitMs: o.exitWaitMs } : {}), ...(o.scope ? { scope: o.scope } : {}), onExit: (f) => { exitedFlag = true; failure = f; exits += 1; } });
  hosts.push(h);
  h.start();
  const send = (c: Record<string, unknown>) => h.handle(JSON.stringify(c));
  const kinds = (k: string) => evs.filter((e) => e.kind === k);
  const stored = () => new SessionLog(dir, o.sid ?? "ses_t").events;
  return { h, evs, seen, dir, ex, send, kinds, stored, on: (f: (e: any) => void) => { onEvent = f; }, exited: () => exitedFlag, failure: () => failure, exits: () => exits };
}

const CREATE = (name = "a.txt", text = "hi"): Step[] => [
  { calls: [{ name: "fs_create_text", args: { parent: ".", name, text } }] },
  { calls: [{ name: "finish", args: { outcome: "done", summary: `写了 ${name}` } }] },
];
/** A task that waits for the user: the plan card for changing a simulated editor's text, then the change. */
const EDIT = (w: string): Step[] => [
  { calls: [{ name: "computer_snapshot", args: {} }] },
  { calls: [{ name: "computer_observe", args: { window: w } }] },
  { calls: [{ name: "plan", args: { steps: [{ purpose: "把正文改成「新的」", objects: [`window:${w}`], consequence: "modify_user" }] } }] },
  { calls: [{ name: "computer_observe", args: { window: w } }] },
  (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "set_value", window: w, target: `${w}:0:textarea`, value: "新的" }, epoch: lastJson(m).epoch, consequence: "modify_user", purpose: "改正文", plan_step: 1 } }] }),
  { calls: [{ name: "finish", args: { outcome: "done", summary: "正文改成了「新的」" } }] },
];
/** A simulated computer with one editor (the sim names it editor-1). */
const editorSim = () => { let id = ""; const make = (scope?: string) => { const s = new SimComputer(scope); id = s.addEditor("编辑器", { title: "笔记.txt", text: "旧的 秘密正文XYZ", path: null }).id; return s; }; return { make, id: () => id }; };
const CALL = (goal: string): Step => ({ calls: [{ name: "computer_task", args: { goal } }] });

// rv-h13 repro (#68 Q3/Q4): the executor reads its stdin > EXPIRED_GRACE_MS after its deadline (a stall; modelled by a
// FIFO that hands the executor every write AND the close 2.5 s late, order kept). The session took the undo before
// undo_until by its own clock and forwarded it; the executor's grace ended first and it exited without reading it.
// The run's file has result_card_closed (so nothing was undone), yet the session records unknown:true.
describe("rv-h13 #68: a forwarded respond the executor reads after its 2 s grace", () => {
  it("is recorded unknown although result_card_closed proves nothing was undone", async () => {
    const scope = tmp();
    const steps = CREATE();
    const launch: Launcher = (req, o) => {
      const input = new PassThrough();
      let cb: ((l: string) => void) | null = null; const early: string[] = [];
      const out = (e: unknown) => { const l = JSON.stringify(e); if (cb) cb(l); else early.push(l); };
      const exited = appRun(req as never, { runs: o.runs, out, input: new LineReader(input), linger: 1,
        inject: { driver: new SimComputer(req.scope as string | undefined), gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream(steps, []) } } }).then(() => ({ code: 0, signal: null }));
      const late = (f: () => void) => { setTimeout(f, 3500); };   // (appRun has the request already; every write and the close reach it late, in order)
      let ended = false;
      return { write: (l) => late(() => { if (!input.writableEnded) input.write(l + "\n"); }), close: () => { if (!ended) { ended = true; late(() => input.end()); } }, onLine: (f) => { cb = f; for (const l of early.splice(0)) f(l); }, exited };
    };
    const s = session({ scope, model: [CALL("新建 a.txt"), { text: "好了" }], launch });
    s.send({ type: "say", text: "新建 a.txt 写 hi" });
    await waitFor(() => s.evs.some((e) => e.kind === "task_done"));
    const done = s.evs.find((e) => e.kind === "task_done");
    expect(Date.now() / 1000).toBeLessThan(done.undo_until);       // before the deadline by the session's clock
    s.send({ type: "respond", run_id: done.run_id, option: done.result_card.options.findIndex((x: any) => x.kind === "undo") });
    expect(s.kinds("session.error")).toEqual([]);                  // taken and forwarded
    await waitFor(() => s.stored().some((e: any) => e.kind === "session.task_closed"), 15_000);
    const run = fs.readFileSync(path.join(s.dir, "sessions", "ses_t", "runs", done.run_id, "events.jsonl"), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(run.some((e) => e.kind === "result_card_closed")).toBe(true);
    expect(run.some((e) => e.kind === "result_response")).toBe(false);   // the forwarded respond got no result_response
    expect(fs.existsSync(path.join(scope, "a.txt"))).toBe(true);         // nothing was undone
    // the spec: unknown only when the executor accepted a respond. Expected {undone:0, refused:"expired"}:
    expect(s.stored().find((e: any) => e.kind === "session.task_undo")).not.toMatchObject({ unknown: true });
  }, 20_000);
});
