/**
 * Executor split P2 (deskmind#90 item 6): the agent loop runs as a child process (`runtime`) of the executor, which
 * serves it the port over MCP on the child's stdin/stdout. The app sees the same events as with the loop in process;
 * the app's stop reaches the child as a notification and still waits for a step in flight; a runtime killed with -9
 * leaves no half-done action and the executor finishes the run (failed: agent exited); an executor killed with -9
 * leaves no runtime or hands process behind; DESKMIND_EXECUTOR_INPROC=1 keeps the loop in process.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { execSync, spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { appRun, LineReader } from "../src/cli/app.js";
import { McpExecutorServer, serve } from "../src/cli/mcp.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { ExecutorService } from "../src/executor/service.js";
import { SimComputer } from "../src/executor/sim.js";
import type { Action } from "../src/executor/types.js";
import { Gateway } from "../src/gateway/index.js";
import type { JsonStep } from "../src/host/agent.js";
import type { AppEvent } from "../src/protocol/events.js";
import { scriptedStream } from "../src/runtime/scripted.js";
import { JsonRpcPeer, topLevelId } from "../src/transport/jsonrpc.js";
import { EventLog } from "../src/protocol/events.js";
import { REPLY_MAX, bounded } from "../src/cli/mcp.js";
import { ReportMirror, checkedCounters } from "../src/transport/report.js";
import { agentEnv } from "../src/host/agent.js";
import { FrontierRuntime } from "../src/host/frontier.js";
import { Tracer } from "../src/otel/trace.js";
import { within } from "../src/otel/context.js";
import { McpPort, STEER_NOTIFICATION } from "../src/transport/mcp-port.js";

const roles = ["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"];
const gateway = () => { const g = new Gateway(Object.fromEntries(roles.map((r) => [r, { backend: "scripted", model: "scripted" }])) as never); g.script = Array(40).fill((role: string) => (role === "verify" ? { choice: "pass", reason: "看到了新窗口" } : { choice: "matches" })); return g; };
const SCRIPTED_MODEL = { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as never;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "split-"));
const lines = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until<T>(f: () => T | undefined | null | false, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = f(); if (v) return v; if (Date.now() > end) throw new Error("timed out"); await sleep(10); }
}

/** A desktop whose open_window or observe takes `ms` (a hands action taking its time). */
class SlowSim extends SimComputer {
  started = false;
  constructor(private readonly slow: "open_window" | "observe", private readonly ms: number) { super(); }
  override perform(a: Action) {
    if (this.slow !== "open_window" || a.kind !== "open_window") return super.perform(a);
    this.started = true;
    return new Promise<ReturnType<SimComputer["perform"]>>((r) => setTimeout(() => r(super.perform(a)), this.ms)) as never;
  }
  override observe(w: string) {
    if (this.slow !== "observe") return super.observe(w);
    this.started = true;
    return new Promise((r) => setTimeout(() => r(super.observe(w)), this.ms)) as never;
  }
}

const OPEN: JsonStep[] = [
  { calls: [{ name: "computer_snapshot", args: {} }] },
  { calls: [{ name: "computer_act", args: { action: { kind: "open_window", app: "编辑器" }, epoch: 0, consequence: "create", purpose: "开一个编辑器" } }] },
  { calls: [{ name: "finish", args: { outcome: "done", summary: "开好了一个编辑器窗口" } }] },
];

/** app-run with the loop as a child (scripted model), or in process (`inproc`: the same script as a stream). */
function run(steps: JsonStep[], o: { sim?: SimComputer; inproc?: boolean; runId?: string } = {}) {
  const runs = tmp(), runId = o.runId ?? "run_split";
  const input = new PassThrough();
  const events: AppEvent[] = [];
  const sim = o.sim ?? new SimComputer();
  const done = appRun({ run_id: runId, raw: "开一个编辑器窗口", config: "ds-flash" }, {
    runs, out: (e) => events.push(e), input: new LineReader(input), linger: 0,
    inject: { driver: sim, gateway: gateway(), ...(o.inproc ? { model: { model: SCRIPTED_MODEL, streamFn: scriptedStream(steps) } } : { agent: { scripted: steps } }) },
  });
  const dir = path.join(runs, runId);
  return { done, events, input, sim, dir, trace: () => lines(path.join(dir, "trace.jsonl")), runtime: () => lines(path.join(dir, "runtime.jsonl")) };
}
/** The events as the app reads them, without what differs between two runs (time, the card's id). */
const shape = (es: AppEvent[]) => es.map(({ t: _t, ...e }) => JSON.parse(JSON.stringify(e).replace(/\b(ask|mc|st|jd)_[0-9a-f]{8}/g, "$1_x"), (k, v) => (k === "latency_ms" || k === "ms" ? 0 : v)));

const savedInproc = process.env.DESKMIND_EXECUTOR_INPROC;
afterEach(() => { if (savedInproc === undefined) delete process.env.DESKMIND_EXECUTOR_INPROC; else process.env.DESKMIND_EXECUTOR_INPROC = savedInproc; });


// rv-h13 repro (#67): the runtime dies while a card is open. The executor lets the card go (service.stop → its race
// returns null) but StdioUser is never told: taskOver() → end("done") returns early when a card is open. So the app
// gets no ask_void (the card stays open after task_done), and a later answer to it is "delivered" (resumed, after
// task_done) to a wait nobody holds, instead of refused.
describe("rv-h13 #67: a card left open when the runtime dies", () => {
  it("is closed for the app, and a later answer to it is refused", async () => {
    const sim = new SimComputer();
    const w = sim.addEditor("编辑器", { title: "笔记.txt", text: "买牛奶", path: null });
    const steps: JsonStep[] = [
      { calls: [{ name: "plan", args: { steps: [{ purpose: "改笔记", objects: [`window:${w.id}`], consequence: "modify_user" }] } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "x" } }] },
    ];
    const r = run(steps, { sim });
    const ask = await until(() => r.events.find((e) => e.kind === "ask")) as any;
    const pid = r.trace().find((t) => t.kind === "agent.start")!.pid as number;
    process.kill(pid, "SIGKILL");
    await r.done;
    expect(r.events.find((e) => e.kind === "task_done")).toMatchObject({ status: "failed" });
    // the app is told the card is closed
    expect(r.events.some((e: any) => (e.kind === "ask_void" || (e.kind === "resumed" && e.voided)) && e.ask_id === ask.ask_id)).toBe(true);
    // a late answer to it: refused, not resumed
    r.input.write(JSON.stringify({ type: "answer", ask_id: ask.ask_id, option: 0 }) + "\n");
    await sleep(50);
    expect(r.events.filter((e: any) => e.kind === "resumed" && e.ask_id === ask.ask_id && !e.voided)).toEqual([]);
    expect(r.events.filter((e: any) => e.kind === "refused" && e.what === `answer for ${ask.ask_id}`)).toHaveLength(1);
    r.input.end();
  }, 30_000);
});
