/**
 * app-run under SIGINT / SIGTERM (the helper quitting, or the user's ^C): the run stops as a stop line would stop it,
 * `task_done` (stopped) is written to the log and stdout, and the process exits within a second. Before, it died
 * without a task_done. A steer line sent mid-run is read and noted in the trace, not handed to the runtime (yet). The run is held in a model call to a local server that never answers, so the signal lands
 * mid-run with no network and no key.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { appRun, LineReader, STEP_UNKNOWN } from "../src/cli/app.js";
import { SimComputer } from "../src/executor/sim.js";
import type { Action } from "../src/executor/types.js";
import { Gateway } from "../src/gateway/index.js";
import { scriptedStream } from "../src/runtime/scripted.js";
import type { AppEvent } from "../src/protocol/events.js";

async function runAndSignal(sig: NodeJS.Signals) {
  let hit!: () => void;
  const called = new Promise<void>((r) => { hit = r; });
  const server = http.createServer(() => { hit(); /* never answers */ });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "signals-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli/app.ts", "app-run", "--runs", runs], {
    cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LOCAL_URL: `http://127.0.0.1:${port}`, LOCAL_API_KEY: "test" },
  });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  child.stdin.write(JSON.stringify({ run_id: `run_sig_${sig}`, raw: "把下载文件夹里的截图整理一下", config: "openai:local|m" }) + "\n");
  try {
    await Promise.race([called, exited.then(() => { throw new Error(`exited before the model call: ${out}\n${err}`); })]);
    // a steer mid-run (control v1) is read and noted, not handed to the runtime yet
    child.stdin.write(JSON.stringify({ type: "steer", text: "只整理今天的" }) + "\n");
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    child.kill(sig);
    const code = await exited;
    const ms = Date.now() - t0;
    const events = out.trim().split("\n").map((l) => JSON.parse(l));
    const onDisk = fs.readFileSync(path.join(runs, `run_sig_${sig}`, "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const trace = fs.readFileSync(path.join(runs, `run_sig_${sig}`, "trace.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    return { code, ms, events, onDisk, err, trace };
  } finally {
    child.kill("SIGKILL");
    server.closeAllConnections();
    server.close();
  }
}

describe("app-run under a signal", () => {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    it(`${sig}: stops the run, writes task_done (stopped), exits within a second`, async () => {
      const r = await runAndSignal(sig);
      expect(r.events[0]).toMatchObject({ kind: "start", protocol: { events: 1 } });
      const done = r.events.filter((e) => e.kind === "task_done");
      expect(done, r.err).toHaveLength(1);
      expect(done[0]).toMatchObject({ status: "stopped" });
      expect(done[0].reason).toContain(sig);
      expect(r.events.at(-1).kind).toBe("task_done");
      expect(r.onDisk.at(-1)).toMatchObject({ kind: "task_done", status: "stopped" });
      expect(r.code).toBe(0);
      expect(r.ms).toBeLessThan(1000);
      expect(r.trace.filter((t) => t.kind === "control.steer").map((t) => [t.text, t.note])).toEqual([["只整理今天的", "steer not supported yet"]]);
      expect(r.trace.some((t) => t.kind === "steer")).toBe(false);
      expect(r.events.filter((e) => e.kind === "refused")).toHaveLength(1);
    }, 30_000);
  }
});

/** A desktop whose open_window is slow (`ms`) or never answers (`ms: null`), like a hands action that takes its time. */
class SlowSim extends SimComputer {
  performing: Promise<void>;
  private began!: () => void;
  constructor(private readonly ms: number | null) { super(); this.performing = new Promise((r) => { this.began = r; }); }
  override perform(a: Action) {
    if (a.kind !== "open_window") return super.perform(a);
    this.began();
    if (this.ms === null) return new Promise<never>(() => {});
    return new Promise<ReturnType<SimComputer["perform"]>>((r) => setTimeout(() => r(super.perform(a)), this.ms!)) as never;
  }
}

const roles = ["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"];
const model = { model: { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as never };
const lastJson = (ms: any[]) => { const m = [...ms].reverse().find((x) => x.role === "toolResult"); try { return JSON.parse(m.content[0].text.split("\n")[0]); } catch { return {}; } };

/** app-run in-process on a slow desktop: the model opens a window (a create step, journaled), then finishes. */
function slowRun(ms: number | null, timing: { deadlineMs: number; waitMs: number }) {
  const sim = new SlowSim(ms);
  const gw = new Gateway(Object.fromEntries(roles.map((r) => [r, { backend: "scripted", model: "scripted" }])) as never);
  gw.script = Array(20).fill((role: string) => (role === "verify" ? { choice: "pass", reason: "ok" } : { choice: "matches" }));
  const steps = [
    { calls: [{ name: "computer_snapshot", args: {} }] },
    (m: any[]) => ({ calls: [{ name: "computer_act", args: { action: { kind: "open_window", app: "编辑器" }, epoch: lastJson(m).epoch, consequence: "create", purpose: "open" } }] }),
    { calls: [{ name: "finish", args: { outcome: "done", summary: "opened" } }] },
  ];
  const input = new PassThrough();
  const events: AppEvent[] = [];
  const exits: { how: "exit" | "now"; at: number }[] = [];
  let signal!: (sig: string) => void;
  void appRun({ run_id: "run_slow", raw: "开一个编辑器窗口", config: "ds-flash" }, {
    runs: fs.mkdtempSync(path.join(os.tmpdir(), "slow-")), out: (e) => events.push(e), input: new LineReader(input), linger: 0,
    signals: { onSignal: (h) => { signal = h; }, exit: () => exits.push({ how: "exit", at: Date.now() }), exitNow: () => exits.push({ how: "now", at: Date.now() }), ...timing },
    inject: { driver: sim, gateway: gw, model: { ...model, streamFn: scriptedStream(steps as never) } },
  });
  const exited = async (limit = 5000) => { const t0 = Date.now(); while (!exits.length && Date.now() - t0 < limit) await new Promise((r) => setTimeout(r, 10)); return exits[0]; };
  return { sim, input, events, exits, signal: (sig: string) => signal(sig), exited };
}

describe("a signal while an action is out at the driver", () => {
  it("perform never returns: waits up to the cap, then task_done names the step as unconfirmed, never a clean stop", async () => {
    const r = slowRun(null, { deadlineMs: 100, waitMs: 300 });
    await r.sim.performing;
    const t0 = Date.now();
    r.signal("SIGTERM");
    const e = await r.exited();
    expect(e?.how).toBe("exit");
    expect(e!.at - t0).toBeGreaterThanOrEqual(380);                 // the deadline, then the wait for a receipt
    const done = r.events.filter((x) => x.kind === "task_done") as any[];
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ status: "stopped", reason: STEP_UNKNOWN });
    expect(done[0].changes.unconfirmed).toHaveLength(1);
    expect(r.events.filter((x) => x.kind === "refused" && (x as any).by === "user").map((x: any) => x.why)).toEqual(["stopped by SIGTERM"]);
  });

  it("perform answers within the cap: the runtime ends on its own after the receipt, a clean stop", async () => {
    const r = slowRun(400, { deadlineMs: 100, waitMs: 3000 });
    await r.sim.performing;
    r.signal("SIGINT");
    const e = await r.exited();
    expect(e?.how).toBe("exit");
    const done = r.events.filter((x) => x.kind === "task_done") as any[];
    expect(done).toHaveLength(1);
    expect(done[0].status).toBe("stopped");
    expect(done[0].reason).not.toBe(STEP_UNKNOWN);
    expect(done[0].reason).toContain("SIGINT");
    expect(done[0]).toHaveProperty("answer");                       // written by the runtime's own end, not the deadline
  });

  it("a stop line, then a signal, then a second signal: one refused (the app's), task_done written, exit at once", async () => {
    const r = slowRun(null, { deadlineMs: 5000, waitMs: 10_000 });
    await r.sim.performing;
    r.input.write(JSON.stringify({ type: "stop" }) + "\n");
    await new Promise((res) => setTimeout(res, 20));
    r.signal("SIGINT");
    await new Promise((res) => setTimeout(res, 20));
    expect(r.exits).toEqual([]);                                    // the first signal waits for the step
    r.signal("SIGINT");
    expect(r.exits.map((x) => x.how)).toEqual(["now"]);
    const done = r.events.filter((x) => x.kind === "task_done") as any[];
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ status: "stopped", reason: STEP_UNKNOWN });
    expect(r.events.filter((x) => x.kind === "refused" && (x as any).by === "user").map((x: any) => x.why)).toEqual(["stopped by the app"]);
  });
});
