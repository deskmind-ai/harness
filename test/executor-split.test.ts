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
import { spawn } from "node:child_process";
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
import { JsonRpcPeer } from "../src/transport/jsonrpc.js";
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
const shape = (es: AppEvent[]) => es.map(({ t: _t, ...e }) => JSON.parse(JSON.stringify(e).replace(/ask_[0-9a-f]{8}/g, "ask_x")));

const savedInproc = process.env.DESKMIND_EXECUTOR_INPROC;
afterEach(() => { if (savedInproc === undefined) delete process.env.DESKMIND_EXECUTOR_INPROC; else process.env.DESKMIND_EXECUTOR_INPROC = savedInproc; });

describe("the runtime as a child process", () => {
  it("end to end over the pipe: the same app events as in process; the trace, the runtime's log and its model calls are split", async () => {
    delete process.env.DESKMIND_EXECUTOR_INPROC;
    const child = run(OPEN);
    await child.done;
    const inproc = run(OPEN, { inproc: true });
    await inproc.done;
    const done = child.events.find((e) => e.kind === "task_done") as any;
    expect(done).toMatchObject({ status: "succeeded" });
    expect(done.result_card?.options.map((x: any) => x.kind)).toContain("undo");
    // additive only: the stream the app reads is the in-process one
    expect(shape(child.events)).toEqual(shape(inproc.events));
    expect(child.events.filter((e) => e.kind === "step")).toHaveLength(1);
    // the executor's trace: the port calls (tool.call / tool.result with its time), each MCP call's time, the child
    const tr = child.trace();
    expect(tr.filter((t) => t.kind === "tool.call").map((t) => t.name)).toEqual(["computer_snapshot", "computer_act", "finish"]);
    expect(tr.filter((t) => t.kind === "tool.result").every((t) => typeof t.ms === "number")).toBe(true);
    expect(tr.filter((t) => t.kind === "mcp.call").map((t) => t.tool)).toEqual(["begin", "snapshot", "act", "finish", "steers", "end"].filter((x) => x !== "steers"));
    expect(tr.find((t) => t.kind === "agent.start")?.pid).toBeGreaterThan(0);
    expect(tr.some((t) => t.kind === "model.call")).toBe(false);
    // the runtime's own log: its model turns and each call's round trip; model_calls.jsonl has the turns
    const rt = child.runtime();
    expect(rt.filter((t) => t.kind === "model.call")).toHaveLength(3);
    expect(rt.filter((t) => t.kind === "mcp.rtt").map((t) => t.tool)).toEqual(["begin", "snapshot", "act", "finish", "end"]);
    expect(lines(path.join(child.dir, "model_calls.jsonl"))).toHaveLength(3);
    expect(fs.existsSync(path.join(child.dir, "runtime.log"))).toBe(true);
    // the counters are both sides' (the loop's came with its calls)
    expect(inproc.trace().some((t) => t.kind === "agent.start")).toBe(false);
  }, 30_000);

  it("the app's stop on an open card: the card is let go, the run ends stopped, the runtime exits", async () => {
    const sim = new SimComputer();
    const w = sim.addEditor("编辑器", { title: "笔记.txt", text: "买牛奶", path: null });
    const steps: JsonStep[] = [
      { calls: [{ name: "plan", args: { steps: [{ purpose: "改笔记", objects: [`window:${w.id}`], consequence: "modify_user" }] } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "x" } }] },
    ];
    const r = run(steps, { sim });
    await until(() => r.events.some((e) => e.kind === "ask"));
    const pid = r.trace().find((t) => t.kind === "agent.start")!.pid as number;
    r.input.write(JSON.stringify({ type: "stop" }) + "\n");
    await r.done;
    const done = r.events.filter((e) => e.kind === "task_done") as any[];
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ status: "stopped" });
    expect(r.events.filter((e) => e.kind === "refused" && (e as any).by === "user")).toHaveLength(1);
    expect(r.runtime().some((t) => t.kind === "control.stop")).toBe(true);
    await until(() => !alive(pid), 3000);
  }, 30_000);

  it("the app's stop during a slow observe: the look is not cut off mid-way, the run ends stopped with nothing unknown", async () => {
    const sim = new SlowSim("observe", 800);
    const w = sim.addEditor("编辑器");
    const steps: JsonStep[] = [
      { calls: [{ name: "computer_observe", args: { window: w.id } }] },
      { calls: [{ name: "computer_act", args: { action: { kind: "open_window", app: "编辑器" }, epoch: 0, consequence: "create", purpose: "x" } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "x" } }] },
    ];
    const r = run(steps, { sim });
    await until(() => sim.started);
    r.input.write(JSON.stringify({ type: "stop" }) + "\n");
    await r.done;
    const done = r.events.filter((e) => e.kind === "task_done") as any[];
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ status: "stopped" });
    expect(done[0].changes.unconfirmed).toEqual([]);
    expect(r.events.some((e) => e.kind === "step")).toBe(false);          // nothing after the stop
    // the look finished before the end was served (requests in order): the end came after it
    const calls = r.trace().filter((t) => t.kind === "mcp.call").map((t) => t.tool);
    expect(calls.slice(-2)).toEqual(["observe", "end"]);
  }, 30_000);
});

describe("a process that dies", () => {
  it("kill -9 of the runtime mid-action: the action finishes with its receipt, the run ends failed (agent exited) with its changes", async () => {
    const sim = new SlowSim("open_window", 600);
    const r = run(OPEN, { sim });
    await until(() => sim.started);
    const pid = r.trace().find((t) => t.kind === "agent.start")!.pid as number;
    process.kill(pid, "SIGKILL");
    await r.done;
    const done = r.events.filter((e) => e.kind === "task_done") as any[];
    expect(done).toHaveLength(1);
    expect(done[0].status).toBe("failed");
    expect(done[0].reason).toMatch(/^agent exited \(SIGKILL\)/);
    // no half-done action: the window was opened, the executor took its receipt (journal) and nothing is unconfirmed
    expect(sim.wins.filter((x) => x.kind === "editor")).toHaveLength(1);
    expect(done[0].changes.unconfirmed).toEqual([]);
    expect(r.trace().filter((t) => t.kind === "executor.act").map((t) => t.status)).toEqual(["ok"]);
    const journal = lines(path.join(r.dir, "journal.jsonl"));
    expect(journal.filter((j) => j.kind === "intent")).toHaveLength(1);
    expect(journal.filter((j) => j.kind === "intent").length).toBe(journal.filter((j) => j.kind === "receipt").length);
    expect(r.trace().find((t) => t.kind === "agent.exit")).toMatchObject({ signal: "SIGKILL" });
  }, 30_000);

  it("kill -9 of the executor: the runtime and hands see their stdin end and exit; nothing is left behind", async () => {
    // the model is a local server that never answers, so the runtime is mid-call when the executor dies
    const server = http.createServer(() => { /* never answers */ });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    const root = tmp(), runs = tmp();
    const fake = path.join(root, "fake-hands.mjs"), handsPid = path.join(root, "hands.pid");
    fs.writeFileSync(fake, `import * as fs from 'node:fs';import * as readline from 'node:readline';
      fs.writeFileSync(${JSON.stringify(handsPid)},String(process.pid));
      const rl=readline.createInterface({input:process.stdin});
      rl.on('line',line=>{const m=JSON.parse(line);const result=m.op==='begin'||m.op==='snapshot'?{epoch:1,locked:false,front_app:'',windows:[],user_active:false}:{};process.stdout.write(JSON.stringify({id:m.id,ok:true,result})+'\\n');});
      rl.on('close',()=>process.exit(0));`);
    const ex = spawn(process.execPath, ["--import", "tsx", "src/cli/app.ts", "executor", "--runs", runs], {
      cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LOCAL_URL: `http://127.0.0.1:${port}`, LOCAL_API_KEY: "test", DESKMIND_HANDS_CMD: `${process.execPath} ${fake}`, DESKMIND_HANDS_DIR: root, DESKMIND_EXECUTOR_INPROC: "" },
    });
    let err = "";
    ex.stderr.on("data", (d) => { err += d; });
    let hit!: () => void;
    const called = new Promise<void>((r) => { hit = r; });
    server.on("request", () => hit());
    try {
      ex.stdin.write(JSON.stringify({ run_id: "run_kill", raw: "看看屏幕", config: "openai:local|m", driver: "hands" }) + "\n");
      await Promise.race([called, sleep(20_000).then(() => { throw new Error(`no model call: ${err}`); })]);
      const agent = lines(path.join(runs, "run_kill", "trace.jsonl")).find((t) => t.kind === "agent.start")!.pid as number;
      const hands = Number(fs.readFileSync(handsPid, "utf-8"));
      expect(alive(agent) && alive(hands)).toBe(true);
      ex.kill("SIGKILL");
      await until(() => !alive(agent) && !alive(hands), 5000);
    } finally {
      ex.kill("SIGKILL");
      server.closeAllConnections();
      server.close();
    }
  }, 40_000);
});

describe("the fallback and the steer push", () => {
  it("DESKMIND_EXECUTOR_INPROC=1: the loop runs in the executor's process, the same events, its log still its own", async () => {
    process.env.DESKMIND_EXECUTOR_INPROC = "1";
    const r = run(OPEN);
    await r.done;
    expect(r.events.find((e) => e.kind === "task_done")).toMatchObject({ status: "succeeded" });
    expect(r.trace().some((t) => t.kind === "agent.start" || t.kind === "mcp.call")).toBe(false);
    expect(r.trace().filter((t) => t.kind === "tool.call").map((t) => t.name)).toEqual(["computer_snapshot", "computer_act", "finish"]);
    expect(r.runtime().filter((t) => t.kind === "model.call")).toHaveLength(3);
  }, 30_000);

  it("steers: pulled only after a push or a reply that carried words; a plain turn makes no call", async () => {
    const sim = new SimComputer();
    const signer = ConsentSigner.fresh();
    const svc = new ExecutorService({ task: "t", raw: "开一个编辑器", executor: new Executor(sim, { task: "t", publicKey: signer.publicKey }), signer, user: { ask: () => null }, gateway: gateway() });
    const toServer = new PassThrough(), toClient = new PassThrough();
    const serverPeer = new JsonRpcPeer(toServer, toClient), clientPeer = new JsonRpcPeer(toClient, toServer);
    serve(new McpExecutorServer({ session: { port: svc.port, stop: (w) => svc.stop(w) } }), serverPeer);
    const port = new McpPort(clientPeer, "开一个编辑器");
    const calls: string[] = [];
    port.onCall = (c) => calls.push(c.tool);
    clientPeer.onNotification = (m) => { if (m === STEER_NOTIFICATION) port.steerWaiting(); };
    await port.initialize();
    await port.begin();
    expect(await port.steers()).toEqual([]);
    expect(calls).toEqual(["begin"]);                                       // no round trip
    svc.steer("算了，开浏览器");
    serverPeer.notify(STEER_NOTIFICATION);
    await sleep(20);
    expect(await port.steers()).toEqual(["算了，开浏览器"]);
    expect(calls).toEqual(["begin", "steers"]);
    // words a reply carried: the executor refuses further steps until `steers` is called again
    svc.steer("还是开编辑器");
    const r = await port.act({ action: { kind: "open_window", app: "编辑器" }, epoch: 0, consequence: "create", purpose: "x" });
    expect(r.steers).toEqual(["还是开编辑器"]);
    expect((await port.act({ action: { kind: "open_window", app: "编辑器" }, epoch: 0, consequence: "create", purpose: "x" })).isError).toBe(true);
    expect(await port.steers()).toEqual([]);
    expect(calls.at(-1)).toBe("steers");
    expect((await port.act({ action: { kind: "open_window", app: "编辑器" }, epoch: 0, consequence: "create", purpose: "x" })).isError).toBeFalsy();
  });
});
