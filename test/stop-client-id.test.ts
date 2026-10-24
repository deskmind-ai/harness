/**
 * stop{client_id}: the app stops the task its own /cua started, by the cua's client_id, before (or without) seeing
 * session.task — and the harness confirms it, once per stop (session.stop_ack), instead of the app assuming it after a
 * local timeout (deskmind#118). Rows: the cua not received yet (the stop overtook it: nothing stopped, the later cua
 * refused — also across a reopen), refused, its task running (stopped; answered when the end is stored, whatever path
 * stores it), ended (already_ended; its result card closed). A repeated stop gets the same answer.
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
import { SessionLog } from "../src/session/log.js";
import type { ExecutorHandle, Launcher } from "../src/session/task.js";

const MODEL = { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as never;
const gateway = () => { const g = new Gateway(Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as never); g.script = Array(80).fill((role: string) => (role === "verify" ? { choice: "pass", reason: "ok" } : { choice: "matches" })); return g; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (c: () => unknown, ms = 5000) => { const t0 = Date.now(); while (!c()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await sleep(2); } };
const CREATE: Step[] = [{ calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] }, { calls: [{ name: "finish", args: { outcome: "done", summary: "写了" } }] }];
/** A task that waits on a question card until it is stopped. */
const WAITS: Step[] = [{ calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] }, { calls: [{ name: "ask_user", args: { question: "接着做吗？", options: ["接着做"] } }] }, { calls: [{ name: "finish", args: { outcome: "done", summary: "x" } }] }];

const inproc = (scripts: Step[][]): Launcher => { let i = 0; return (req, lo) => {
  const scope = fs.mkdtempSync(path.join(os.tmpdir(), "stopcid-"));
  const input = new PassThrough();
  let ended = false, cb: ((l: string) => void) | null = null;
  const early: string[] = [];
  const out = (e: unknown) => { const l = JSON.stringify(e); if (cb) cb(l); else early.push(l); };
  const exited = appRun({ ...(req as object), scope } as never, { runs: lo.runs, out, input: new LineReader(input), linger: lo.linger,
    inject: { driver: new SimComputer(scope), gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream(scripts[i++] ?? CREATE) } } }).then(() => ({ code: 0, signal: null }));
  return { write: (l) => { if (!ended) input.write(l + "\n"); }, close: () => { if (!ended) { ended = true; input.end(); } }, onLine: (f) => { cb = f; for (const l of early.splice(0)) f(l); }, exited };
}; };

const hosts: SessionHost[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) h.end(); await sleep(50); });

function session(launch: Launcher, o: { dir?: string; exitWaitMs?: number } = {}) {
  const dir = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), "stopcid-ses-"));
  const evs: any[] = [];
  const h = new SessionHost({ dir, sessionId: "ses_s", out: (e) => evs.push(e), coalesceMs: 5, model: { model: MODEL, streamFn: scriptedStream(Array(6).fill({ text: "好" })) }, launch, linger: 600, ...(o.exitWaitMs ? { exitWaitMs: o.exitWaitMs } : {}) });
  hosts.push(h);
  h.start();
  const send = (x: Record<string, unknown>) => h.handle(JSON.stringify(x));
  const acks = (cid: string) => evs.filter((e) => e.kind === "session.stop_ack" && e.client_id === cid);
  return { h, evs, send, acks, dir, stored: () => new SessionLog(dir, "ses_s").events };
}

describe("stop{client_id}", () => {
  it("task running: stopped as by stop{run_id}; one ack once its end is stored, with how it ended; a repeat gets the same", async () => {
    const s = session(inproc([WAITS]));
    s.send({ type: "cua", text: "新建 a.txt", client_id: "c1" });
    await waitFor(() => s.evs.some((e) => e.kind === "ask"));
    const run = s.evs.find((e) => e.kind === "session.task").run_id;
    s.send({ type: "stop", client_id: "c1" });
    s.send({ type: "stop", client_id: "c1" });                                // a second while waiting: no second stop
    expect(s.acks("c1")).toEqual([]);
    await waitFor(() => s.acks("c1").length === 2);
    expect(s.acks("c1")).toEqual([expect.objectContaining({ result: "stopped", run_id: run, status: "stopped" }), expect.objectContaining({ result: "stopped", run_id: run, status: "stopped" })]);
    expect(s.evs.find((e) => e.kind === "session.task_end")).toMatchObject({ run_id: run, status: "stopped" });
    s.send({ type: "stop", client_id: "c1" });
    expect(s.acks("c1").at(-1)).toMatchObject({ result: "stopped", run_id: run, status: "stopped" });
  });

  it("task running, its executor dies with no task_done: the end the session stores releases the ack (status failed)", async () => {
    let die!: (x: { code: number | null; signal: string | null }) => void;
    const launch: Launcher = () => ({ start: () => {}, write: (l: string) => { if (JSON.parse(l).type === "stop") setTimeout(() => die({ code: 1, signal: null }), 5); }, close: () => {}, onLine: () => {},
      exited: new Promise((r) => { die = r; }) }) as ExecutorHandle;
    const s = session(launch);
    s.send({ type: "cua", text: "做点事", client_id: "c2" });
    await waitFor(() => s.evs.some((e) => e.kind === "session.task"));
    s.send({ type: "stop", client_id: "c2" });
    await waitFor(() => s.acks("c2").length === 1);
    expect(s.acks("c2")[0]).toMatchObject({ result: "stopped", status: "failed" });
    expect(s.stored().find((e: any) => e.kind === "session.task_end")).toMatchObject({ status: "failed" });
  });

  it("task running, the helper goes away and the task never confirms the stop: the end stored after the wait releases the ack (status stopped)", async () => {
    const launch: Launcher = () => ({ start: () => {}, write: () => {}, close: () => {}, onLine: () => {}, exited: new Promise(() => {}) }) as ExecutorHandle;
    const s = session(launch, { exitWaitMs: 100 });
    s.send({ type: "cua", text: "做点事", client_id: "c3" });
    await waitFor(() => s.evs.some((e) => e.kind === "session.task"));
    s.send({ type: "stop", client_id: "c3" });
    s.h.inputClosed();
    await waitFor(() => s.acks("c3").length === 1);
    expect(s.acks("c3")[0]).toMatchObject({ result: "stopped", status: "stopped" });
  });

  it("task ended: already_ended with its status, and its result card is closed (a later undo refused)", async () => {
    const s = session(inproc([CREATE]));
    s.send({ type: "cua", text: "新建 a.txt", client_id: "c4" });
    await waitFor(() => s.evs.some((e) => e.kind === "session.task_end") && !s.h.busy);
    const run = s.evs.find((e) => e.kind === "session.task").run_id;
    s.send({ type: "stop", client_id: "c4" });
    expect(s.acks("c4")).toEqual([expect.objectContaining({ result: "already_ended", run_id: run, status: "succeeded" })]);
    s.send({ type: "respond", run_id: run, option: 1 });
    expect(s.evs.filter((e) => e.kind === "session.error" && e.control === "respond").at(-1)).toMatchObject({ code: "undo_expired" });
    s.send({ type: "stop", client_id: "c4" });
    expect(s.acks("c4")).toHaveLength(2);
    expect(s.acks("c4")[1]).toMatchObject({ result: "already_ended", run_id: run, status: "succeeded" });
  });

  it("the cua was refused: none, nothing else is stopped, and a retry of that cua is refused", async () => {
    const s = session(inproc([WAITS, CREATE]));
    s.send({ type: "cua", text: "先做这个", client_id: "first" });
    await waitFor(() => s.evs.some((e) => e.kind === "ask"));
    s.send({ type: "cua", text: "再做这个", client_id: "c5" });                  // busy: refused
    expect(s.evs.filter((e) => e.kind === "session.error" && e.client_id === "c5").map((e) => e.code)).toEqual(["busy"]);
    s.send({ type: "stop", client_id: "c5" });
    expect(s.acks("c5")).toEqual([expect.objectContaining({ result: "none" })]);
    await sleep(50);
    expect(s.evs.some((e) => e.kind === "session.task_end")).toBe(false);          // the first task still runs
    s.send({ type: "cua", text: "再做这个", client_id: "c5" });
    expect(s.evs.filter((e) => e.kind === "session.error" && e.client_id === "c5").map((e) => e.code)).toEqual(["busy", "cancelled"]);
  });

  it("the stop overtook its cua (both on stdin, the cua right behind): none; the cua is refused, cua_cancelled stored before it — and after a reopen too", async () => {
    const s = session(inproc([CREATE]));
    // one stdin chunk, the session handles the lines in order
    for (const l of [JSON.stringify({ type: "stop", client_id: "c6" }), JSON.stringify({ type: "cua", text: "新建 a.txt", client_id: "c6" })]) s.h.handle(l);
    expect(s.acks("c6")).toEqual([expect.objectContaining({ result: "none" })]);
    expect(s.evs.filter((e) => e.kind === "session.error" && e.client_id === "c6")).toEqual([expect.objectContaining({ code: "cancelled", control: "cua" })]);
    expect(s.stored().map((e: any) => e.kind)).toEqual(["session.cua_cancelled"]);
    expect(s.evs.some((e) => e.kind === "session.task")).toBe(false);
    // reopened: the record still holds
    s.h.end(); await sleep(50);
    const s2 = session(inproc([CREATE]), { dir: s.dir });
    s2.send({ type: "cua", text: "新建 a.txt", client_id: "c6" });
    expect(s2.evs.filter((e) => e.kind === "session.error" && e.client_id === "c6")).toEqual([expect.objectContaining({ code: "cancelled" })]);
    expect(s2.evs.some((e) => e.kind === "session.task")).toBe(false);
    // and a stop with the same id after the reopen: the same answer
    s2.send({ type: "stop", client_id: "c6" });
    expect(s2.acks("c6")).toEqual([expect.objectContaining({ result: "none" })]);
    expect(s2.stored().filter((e: any) => e.kind === "session.cua_cancelled")).toHaveLength(1);
  });

  it("after a reopen, a stop for a cua whose task ended in the last process: already_ended from the history", async () => {
    const s = session(inproc([CREATE]));
    s.send({ type: "cua", text: "新建 a.txt", client_id: "c7" });
    await waitFor(() => s.evs.some((e) => e.kind === "session.task_end") && !s.h.busy);
    const run = s.evs.find((e) => e.kind === "session.task").run_id;
    s.h.end(); await waitFor(() => s.evs.some((e) => e.kind === "session.task_closed"));
    const s2 = session(inproc([]), { dir: s.dir });
    s2.send({ type: "stop", client_id: "c7" });
    expect(s2.acks("c7")).toEqual([expect.objectContaining({ result: "already_ended", run_id: run, status: "succeeded" })]);
  });
});
