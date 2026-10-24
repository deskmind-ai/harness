/**
 * The app's own id on a respond / answer (`req_id`): the session's refusal of it (session.error) carries back
 * `control`, the `run_id` it targeted and the same `req_id`, for every refusal code a respond can get; its stored
 * session.task_respond echoes `req_id`. A request without req_id is answered exactly as before. (deskmind#114: the
 * helper broadcasts refusals to every watcher, so the app matches by id, never by order.)
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { appRun, LineReader } from "../src/cli/app.js";
import { SimComputer } from "../src/executor/sim.js";
import { Gateway } from "../src/gateway/index.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";
import { SessionHost } from "../src/session/host.js";
import type { Launcher } from "../src/session/task.js";
import type { Clock } from "../src/executor/clock.js";

const MODEL = { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as never;
const gateway = () => { const g = new Gateway(Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as never); g.script = Array(80).fill((role: string) => (role === "verify" ? { choice: "pass", reason: "ok" } : { choice: "matches" })); return g; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (c: () => unknown, ms = 5000) => { const t0 = Date.now(); while (!c()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(2); } };
/** A wall clock the test moves (the executor's and the session's alike). */
const clock = (): Clock & { wall: number } => { const c = { wall: Date.now(), now: () => c.wall, schedule: (ms: number, f: () => void) => { const h = setTimeout(f, ms); return () => clearTimeout(h); } }; return c; };
const CREATE = (name: string): Step[] => [{ calls: [{ name: "fs_create_text", args: { parent: ".", name, text: "hi" } }] }, { calls: [{ name: "finish", args: { outcome: "done", summary: "写了" } }] }];

const hosts: SessionHost[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) h.end(); await sleep(50); });

function session(scripts: Step[][], c = clock()) {
  let i = 0;
  const launch: Launcher = (req, lo) => {
    const scope = fs.mkdtempSync(path.join(os.tmpdir(), "reqid-"));
    const input = new PassThrough();
    let ended = false, cb: ((l: string) => void) | null = null;
    const early: string[] = [];
    const out = (e: unknown) => { const l = JSON.stringify(e); if (cb) cb(l); else early.push(l); };
    const exited = appRun({ ...(req as object), scope } as never, { runs: lo.runs, out, input: new LineReader(input), linger: lo.linger,
      inject: { driver: new SimComputer(scope), gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream(scripts[i++]!) }, clock: c } }).then(() => ({ code: 0, signal: null }));
    return { write: (l) => { if (!ended) input.write(l + "\n"); }, close: () => { if (!ended) { ended = true; input.end(); } }, onLine: (f) => { cb = f; for (const l of early.splice(0)) f(l); }, exited };
  };
  const evs: any[] = [];
  const h = new SessionHost({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "reqid-ses-")), sessionId: "ses_r", out: (e) => evs.push(e), coalesceMs: 5,
    model: { model: MODEL, streamFn: scriptedStream([{ text: "好" }, { text: "好" }, { text: "好" }]) }, launch, linger: 600, clock: c });
  hosts.push(h);
  h.start();
  const send = (x: Record<string, unknown>) => h.handle(JSON.stringify(x));
  const errs = () => evs.filter((e) => e.kind === "session.error" && (e.control === "respond" || e.control === "answer"));
  return { h, evs, send, errs, clock: c };
}
async function finished(s: ReturnType<typeof session>, n = 1) { await waitFor(() => s.evs.filter((e) => e.kind === "session.task_end").length === n && !s.h.busy); return s.evs.filter((e) => e.kind === "task_done").at(-1).run_id as string; }

describe("req_id on respond / answer", () => {
  it("every refusal of a respond echoes control, run_id and req_id — no_task, bad_control, busy, undo_expired (by the clock)", async () => {
    const s = session([CREATE("a.txt"), CREATE("b.txt")]);
    // no_task: nothing lingers yet; then a run id that is not this session's
    s.send({ type: "respond", option: 1, req_id: "r0" });
    s.send({ type: "respond", run_id: "run_nope", option: 1, req_id: "r0b" });
    s.send({ type: "cua", text: "新建 a.txt" });
    const run = await finished(s);
    // bad_control: no such option
    s.send({ type: "respond", run_id: run, option: 9, req_id: "r1" });
    // accepted (approve: not an undo), then busy: answered already
    s.send({ type: "respond", run_id: run, option: 0, req_id: "r2" });
    s.send({ type: "respond", run_id: run, option: 1, req_id: "r3" });
    expect(s.evs.find((e) => e.kind === "session.task_respond")).toMatchObject({ run_id: run, req_id: "r2" });
    expect(s.errs().map((e) => [e.code, e.control, e.run_id, e.req_id])).toEqual([
      ["no_task", "respond", undefined, "r0"], ["no_task", "respond", "run_nope", "r0b"],
      ["bad_control", "respond", run, "r1"], ["busy", "respond", run, "r3"],
    ]);
    // the first task's card is closed (answered); a new task on this Mac: a respond to the first is no_task, named
    await waitFor(() => s.evs.some((e) => e.kind === "session.task_closed" && e.run_id === run));
    s.send({ type: "cua", text: "新建 b.txt" });
    const run2 = await finished(s, 2);
    s.send({ type: "respond", run_id: run, option: 1, req_id: "r3b" });
    expect(s.errs().at(-1)).toMatchObject({ code: "no_task", control: "respond", run_id: run, req_id: "r3b" });
    // undo_expired by the clock
    s.clock.wall += 11 * 60_000;
    s.send({ type: "respond", run_id: run2, option: 1, req_id: "r4" });
    expect(s.errs().at(-1)).toMatchObject({ code: "undo_expired", control: "respond", run_id: run2, req_id: "r4" });
  });

  it("undo_expired after a stop closed the card; an answer's no_task", async () => {
    const s = session([CREATE("a.txt"), CREATE("b.txt")]);
    s.send({ type: "cua", text: "新建 a.txt" });
    const run = await finished(s);
    s.send({ type: "stop", run_id: run });
    s.send({ type: "respond", run_id: run, option: 1, req_id: "s1" });
    expect(s.errs().at(-1)).toMatchObject({ code: "undo_expired", control: "respond", run_id: run, req_id: "s1" });
    s.send({ type: "answer", run_id: "run_nope", ask_id: "ask_x", option: 0, req_id: "s2" });
    expect(s.errs().at(-1)).toMatchObject({ code: "no_task", control: "answer", run_id: "run_nope", req_id: "s2" });
  });

  it("the undo accepted: session.task_respond echoes req_id", async () => {
    const s = session([CREATE("a.txt")]);
    s.send({ type: "cua", text: "新建 a.txt" });
    const run = await finished(s);
    s.send({ type: "respond", run_id: run, option: 1, req_id: "u1" });
    expect(s.evs.find((e) => e.kind === "session.task_respond")).toMatchObject({ run_id: run, option: 1, undo: true, req_id: "u1" });
    await waitFor(() => s.evs.some((e) => e.kind === "session.task_undo"));
  });

  it("without req_id, everything is as before: no run_id or req_id on the refusal, none on task_respond", async () => {
    const s = session([CREATE("a.txt")]);
    s.send({ type: "respond", option: 1 });
    s.send({ type: "cua", text: "新建 a.txt" });
    const run = await finished(s);
    s.send({ type: "respond", run_id: run, option: 9 });
    s.send({ type: "respond", run_id: run, option: 1 });
    for (const e of s.errs()) { expect(e).not.toHaveProperty("req_id"); expect(e).not.toHaveProperty("run_id"); }
    expect(s.errs().map((e) => e.code)).toEqual(["no_task", "bad_control"]);
    expect(s.evs.find((e) => e.kind === "session.task_respond")).not.toHaveProperty("req_id");
    // a req_id longer than the limit is ignored, as if absent
    s.send({ type: "respond", run_id: run, option: 1, req_id: "x".repeat(101) });
    expect(s.errs().at(-1)).not.toHaveProperty("req_id");
  });
});
