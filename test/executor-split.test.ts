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
    // every model call is the executor's record (M0): the runtime's turns came over the pipe as role "loop"
    expect(tr.filter((t) => t.kind === "model.call" && t.role === "loop")).toHaveLength(3);
    // the runtime's own log: its model turns and each call's round trip; model_calls.jsonl has the turns
    const rt = child.runtime();
    expect(rt.filter((t) => t.kind === "model.call")).toHaveLength(3);
    expect(rt.filter((t) => t.kind === "mcp.rtt").map((t) => t.tool)).toEqual(["begin", "snapshot", "act", "finish", "end"]);
    const rows = (d: string) => lines(path.join(d, "model_calls.jsonl")).map((r) => `${r.role}:${r.outcome}:${r.tokens_in}:${r.tokens_out}`);
    expect(rows(child.dir).filter((r) => r.startsWith("loop:"))).toHaveLength(3);
    expect(rows(child.dir)).toEqual(rows(inproc.dir));
    expect(fs.existsSync(path.join(child.dir, "runtime.log"))).toBe(true);
    // the counters are both sides' (the loop's came with its calls)
    expect(inproc.trace().some((t) => t.kind === "agent.start")).toBe(false);
  }, 30_000);

  it("across the boundary (M0): the same model_call events and usage, the same span tree, and plan_step on act", async () => {
    delete process.env.DESKMIND_EXECUTOR_INPROC;
    const steps: JsonStep[] = OPEN.map((x) => ("calls" in x && x.calls[0]!.name === "computer_act" ? { calls: [{ ...x.calls[0]!, args: { ...x.calls[0]!.args, plan_step: 1 } }] } : x));
    const child = run(steps); await child.done;
    const inproc = run(steps, { inproc: true }); await inproc.done;
    // model calls: the acting model's three turns (role loop) and the judges', as events and in task_done's usage
    const calls = (r: typeof child) => shape(r.events.filter((e) => e.kind === "model_call"));
    expect(calls(child).filter((c: any) => c.role === "loop")).toHaveLength(3);
    expect(calls(child)).toEqual(calls(inproc));
    const usage = (r: typeof child) => { const u = (r.events.find((e) => e.kind === "task_done") as any).usage; return { calls: u.calls, tokens_in: u.tokens_in, tokens_out: u.tokens_out, roles: Object.fromEntries(Object.entries(u.by_role).map(([k, v]: [string, any]) => [k, v.calls])) }; };
    expect(usage(child)).toEqual(usage(inproc));
    expect(usage(child).roles.loop).toBe(3);
    // plan_step reached the executor over MCP
    expect(child.events.find((e) => e.kind === "step")).toMatchObject({ plan_step: 1 });
    // the span tree: every span's name under its parent's names, the same in both; the executor's step spans sit
    // under the runtime's execute_tool span
    const tree = (r: typeof child) => {
      const spans = lines(path.join(r.dir, "trace.otel.jsonl")).flatMap((l) => l.resourceSpans[0].scopeSpans[0].spans) as { spanId: string; parentSpanId?: string; name: string; status: { code: number } }[];
      const by = new Map(spans.map((x) => [x.spanId, x]));
      const pathOf = (x: (typeof spans)[number]): string => { const p = x.parentSpanId ? by.get(x.parentSpanId) : undefined; return p ? `${pathOf(p)} > ${x.name}` : x.name; };
      expect(spans.every((x) => !x.parentSpanId || by.has(x.parentSpanId))).toBe(true);           // no orphans
      return spans.map(pathOf).sort();
    };
    const t = tree(child);
    expect(t).toEqual(tree(inproc));
    expect(t.some((p) => /deskmind\.turn > execute_tool computer_act > deskmind\.step/.test(p))).toBe(true);
    expect(t.filter((p) => /deskmind\.turn > chat scripted$/.test(p))).toHaveLength(3);
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
      env: { ...process.env, LOCAL_URL: `http://127.0.0.1:${port}`, LOCAL_API_KEY: "test", DESKMIND_HANDS_CMD: `${process.execPath} ${fake}`, DESKMIND_HANDS_DIR: root, DESKMIND_EXECUTOR_INPROC: "", DESKMIND_BRAIN_TOKEN: "brain-secret", OPENROUTER_API_KEY: "or-secret" },
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
      // the runtime's environment and command line hold neither the user's words nor another service's secret
      const seen = execSync(`ps eww -p ${agent}`).toString();
      expect(seen).not.toMatch(/brain-secret|or-secret|看看屏幕|DESKMIND_HANDS/);
      expect(seen).toContain("LOCAL_API_KEY");
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
  it("a steer read with the request (before the runtime's process exists) reaches its first turn, as in process", async () => {
    const go = async (inproc: boolean) => {
      const runs = tmp(), input = new PassThrough(), reader = new LineReader(input), events: AppEvent[] = [];
      input.write(JSON.stringify({ type: "steer", text: "开一个编辑器窗口，标题叫 x" }) + "\n");     // in the same batch as the request
      await sleep(30);
      await appRun({ run_id: "r", raw: "开一个编辑器窗口", config: "ds-flash" }, { runs, out: (e) => events.push(e), input: reader, linger: 0,
        inject: { driver: new SimComputer(), gateway: gateway(), ...(inproc ? { model: { model: SCRIPTED_MODEL, streamFn: scriptedStream(OPEN) } } : { agent: { scripted: OPEN } }) } });
      return lines(path.join(runs, "r", "trace.jsonl")).filter((t) => t.kind === "steer.applied" || (t.kind === "executor.act")).map((t) => t.kind === "executor.act" ? `act:${t.status}` : t.kind);
    };
    const inproc = await go(true);
    expect(inproc).toEqual(["steer.applied", "act:ok"]);
    expect(await go(false)).toEqual(inproc);
  }, 30_000);

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

describe("the boundary does not trust the runtime (review of #50)", () => {
  it("its environment is an allowlist: no DeskMind secrets, only its own provider's key and URL", () => {
    const env = { PATH: "/bin", HOME: "/h", LANG: "zh_CN.UTF-8", LC_ALL: "C", NODE_OPTIONS: "--x", DESKMIND_BRAIN_TOKEN: "brain", OPENROUTER_API_KEY: "or", DEEPSEEK_API_KEY: "ds", LOCAL_API_KEY: "lk", LOCAL_URL: "http://l", DESKMIND_HANDS_CMD: "h", DESKMIND_HANDS_DIR: "d", DESKMIND_EXECUTOR_INPROC: "1" };
    expect(Object.keys(agentEnv("local|m", env)).sort()).toEqual(["HOME", "LANG", "LC_ALL", "LOCAL_API_KEY", "LOCAL_URL", "NODE_OPTIONS", "PATH"]);
    expect(Object.keys(agentEnv("deepseek|x", env))).toContain("DEEPSEEK_API_KEY");
    expect(Object.keys(agentEnv({ scripted: [] }, env)).sort()).toEqual(["HOME", "LANG", "LC_ALL", "NODE_OPTIONS", "PATH"]);
  });

  it("a forged model_call record becomes a plain loop record; a forged span name, a duplicate id, oversized attrs and odd times are refused or bounded", () => {
    const recs: any[] = [];
    const tracer = new Tracer(path.join(tmp(), "otel.jsonl"));
    const root = tracer.start("root", { parent: null });
    const m = new ReportMirror({ tracer, span: root, onModelCall: (r) => recs.push(r) });
    const forged = { kind: "model.call", call_id: "x".repeat(50), role: "judge", judge_id: "jd_fake", step_id: "st_fake", model: "m".repeat(500), outcome: "ok", tokens_in: 1e12, tokens_out: "x", cost_usd: 999, latency_ms: -5, started_at: 0, extra: { a: 1 } };
    m.notification("notifications/deskmind/model_call", { record: forged });
    m.notification("notifications/deskmind/model_call", { record: { ...forged, role: "__proto__", tokens_in: Infinity } });
    m.notification("notifications/deskmind/model_call", { record: "nope" });
    expect(recs).toHaveLength(2);
    for (const r of recs) {
      expect(r.role).toBe("loop");
      expect(r).not.toHaveProperty("judge_id"); expect(r).not.toHaveProperty("step_id"); expect(r).not.toHaveProperty("extra");
      expect(r.cost_usd).toBeLessThanOrEqual(100); expect(r.tokens_out).toBe(0); expect(r.latency_ms).toBe(0); expect(r.model.length).toBe(200);
      expect(r.call_id).toMatch(/^mc_[0-9a-f]{8}$/);
      expect(r.started_at).toBeGreaterThan(Date.now() - 60_000);
    }
    expect(recs[0].tokens_in).toBe(1e8);
    expect(({} as any).calls).toBeUndefined();
    const id = (n: number) => n.toString(16).padStart(16, "0");
    expect(m.notification("notifications/deskmind/span", { op: "start", id: id(1), name: "deskmind.consent", attrs: {}, at: 0 })).toBe(true);
    m.notification("notifications/deskmind/span", { op: "start", id: id(2), name: "deskmind.turn", attrs: { big: "y".repeat(200_000), ok: 1, ["bad key!"]: 2 }, at: 0 });
    m.notification("notifications/deskmind/span", { op: "start", id: id(2), name: "deskmind.turn", attrs: {}, at: 0 });
    m.notification("notifications/deskmind/span", { op: "end", id: id(2), attrs: {}, at: 9e15 });
    expect(m.dropped).toMatchObject({ model_call: 1, span_name: 1, span_duplicate: 1 });
    tracer.end(root);
    const spans = lines(tracer.file).flatMap((l) => l.resourceSpans[0].scopeSpans[0].spans);
    expect(spans.map((s: any) => s.name).sort()).toEqual(["deskmind.turn", "root"]);
    const turn = spans.find((s: any) => s.name === "deskmind.turn");
    expect(JSON.stringify(turn.attributes).length).toBeLessThan(2000);
    expect(Number(BigInt(turn.endTimeUnixNano) / 1_000_000n)).toBeLessThanOrEqual(Date.now());
    expect(Number(BigInt(turn.startTimeUnixNano) / 1_000_000n)).toBeGreaterThan(Date.now() - 60_000);
  });

  it("counters from _meta: known-looking names, finite, capped, never going down", () => {
    let c = checkedCounters({}, { model_calls: 3, tokens_in: 1e15, __proto__x: 1, "Bad": 2, neg: -1, nan: NaN, s: "9" });
    expect(c).toEqual({ model_calls: 3, tokens_in: 1e9 });
    c = checkedCounters(c, { model_calls: 1, turns: 2 });
    expect(c).toEqual({ model_calls: 3, tokens_in: 1e9, turns: 2 });
    expect(checkedCounters(c, JSON.parse('{"__proto__": {"polluted": 1}}'))).toEqual(c);
    expect(({} as any).polluted).toBeUndefined();
  });

  it("the transport: a notification flood is dropped and counted by method; a non-JSON line goes to the parse-error hook", async () => {
    const input = new PassThrough(), output = new PassThrough();
    const peer = new JsonRpcPeer(input, output, { maxLine: 1000, oversize: "close", notifyPerSec: 10, notifyBurst: 5 });
    const got: string[] = [], bad: string[] = [];
    peer.onNotification = (m) => got.push(m);
    peer.onParseError = (l) => bad.push(l);
    input.write("hello, not json\n");
    for (let i = 0; i < 20; i++) input.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/deskmind/model_call" }) + "\n");
    await sleep(20);
    expect(bad).toEqual(["hello, not json"]);
    expect(got.length).toBe(5);
    expect(peer.dropped.notifications).toBe(15);
    expect(peer.droppedByMethod["notifications/deskmind/model_call"]).toBe(15);
  });

  /** A response line of `mb` megabytes to a pending request, written in 64 KB pieces. */
  const bigLine = (mb: number, id: number | null = 1) => Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, result: { text: "字".repeat(Math.floor((mb * 1024 * 1024) / 3)) } }) + "\n");
  const feed = (input: PassThrough, b: Buffer) => { for (let i = 0; i < b.length; i += 65536) input.write(b.subarray(i, i + 65536)); };

  it("an oversize line is never dropped silently — the child reading its parent has no cap: a 17 MB reply arrives", async () => {
    const input = new PassThrough(), output = new PassThrough();
    const peer = new JsonRpcPeer(input, output);                          // as runtimeMain makes it
    const p = peer.request("tools/call", {});
    feed(input, bigLine(17));
    await expect(Promise.race([p.then(() => "answered"), sleep(5000).then(() => "hung")])).resolves.toBe("answered");
  });

  it("the executor reading its child: an oversize line is a protocol violation — pending requests rejected, the peer closed", async () => {
    const input = new PassThrough(), output = new PassThrough();
    const peer = new JsonRpcPeer(input, output, { maxLine: 16 * 1024 * 1024, oversize: "close" });
    const p = peer.request("x", {});
    feed(input, bigLine(17));
    await expect(Promise.race([p.then(() => "answered", (e) => `rejected: ${e.message}`), sleep(5000).then(() => "hung")])).resolves.toMatch(/^rejected: .*line too long/);
    expect(peer.violation).toBe("line too long");
    expect(await peer.closed).toBe("protocol: line too long");
  });

  it("the standalone server reading a foreign caller: an oversize request is answered with an error (its id read from the line's start), else the connection is closed", async () => {
    const input = new PassThrough(), output = new PassThrough();
    const peer = new JsonRpcPeer(input, output, { maxLine: 1024, oversize: "error" });
    const replies: any[] = [];
    output.on("data", (d) => String(d).split("\n").filter(Boolean).forEach((l) => replies.push(JSON.parse(l))));
    const reqs: unknown[] = [];
    peer.onRequest = (m) => reqs.push(m.id);
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "act", arguments: { id: 99, text: "x".repeat(5000) } } }) + "\n");
    input.write(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "ping" }) + "\n");
    await sleep(20);
    expect(replies[0]).toMatchObject({ id: 7, error: { code: -32600 } });
    expect(reqs).toEqual([8]);                                              // the next request is still served
    expect(peer.violation).toBeNull();
    input.write(JSON.stringify({ jsonrpc: "2.0", method: "tools/call", params: { text: "y".repeat(5000) } }) + "\n");
    await sleep(20);
    expect(replies[1]).toMatchObject({ id: null, error: { code: -32600 } });
    expect(peer.violation).toBe("line too long");
    expect(topLevelId('{"jsonrpc":"2.0","params":{"id":3},"id":"a\\"b","method":"x"')).toBe('a"b');
    expect(topLevelId('{"jsonrpc":"2.0","params":{"id":3,"text":"xxxx')).toBeUndefined();
  });

  it("a runtime that writes an oversize line: the run ends failed, agent exited (protocol: line too long), promptly", async () => {
    const dir = tmp(), evil = path.join(dir, "big.mjs");
    fs.writeFileSync(evil, `import * as readline from "node:readline";
      const rl = readline.createInterface({ input: process.stdin }); rl.on("line", () => {});
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { pad: "z".repeat(17 * 1024 * 1024) } }) + "\\n");
      setInterval(() => {}, 1000);`);
    const signer = ConsentSigner.fresh(), t0 = Date.now();
    const rt = new FrontierRuntime({ task: "big", raw: "x", executor: new Executor(new SimComputer(), { task: "big", publicKey: signer.publicKey }), signer, user: { ask: () => null }, gateway: gateway(), mode: "process", agent: { model: "local|m", command: [process.execPath, evil] } });
    const r = await rt.run();
    expect(r).toMatchObject({ status: "failed", reason: "agent exited (protocol: line too long)" });
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 30_000);

  it("the executor caps what it sends: one huge window's observation is cut with a marker", async () => {
    const sim = new SimComputer();
    const w = sim.addEditor("编辑器", { title: "大.txt", text: "字".repeat(3_000_000), path: null });
    const signer = ConsentSigner.fresh();
    const svc = new ExecutorService({ task: "t", raw: "看", executor: new Executor(sim, { task: "t", publicKey: signer.publicKey }), signer, user: { ask: () => null }, gateway: gateway() });
    const s = new McpExecutorServer({ session: { port: svc.port, stop: () => {} } });
    await s.call("begin", { raw: "看" });
    const o = await s.call("observe", { window: w.id });
    expect(o.text.length).toBeLessThanOrEqual(REPLY_MAX + 1000);
    expect((o.out as any).truncated).toBeTruthy();
    const huge = { elements: Array.from({ length: 200_000 }, (_, i) => ({ id: `e${i}`, label: "标签".repeat(20) })), text: "t" };
    const b = bounded(huge as never) as any;
    expect(JSON.stringify(b).length).toBeLessThanOrEqual(REPLY_MAX);
    expect(b.truncated.elements).toBe(200_000);
    expect(b.elements.length).toBeGreaterThan(1000);
  });

  it("model_call reports dropped by the rate limit: the run says its usage is incomplete", async () => {
    const dir = tmp(), evil = path.join(dir, "flood.mjs");
    fs.writeFileSync(evil, `import * as readline from "node:readline";
      const w = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
      const rl = readline.createInterface({ input: process.stdin });
      const pending = new Map(); let id = 0;
      const req = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); w({ jsonrpc: "2.0", id: i, method, params }); });
      rl.on("line", (l) => { const m = JSON.parse(l); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
      await req("initialize", {});
      for (let i = 0; i < 3000; i++) w({ jsonrpc: "2.0", method: "notifications/deskmind/model_call", params: { record: { tokens_in: 1 } } });
      await req("tools/call", { name: "end", arguments: {} });
      process.exit(0);`);
    const recs: unknown[] = [];
    const signer = ConsentSigner.fresh();
    const rt = new FrontierRuntime({ task: "flood", raw: "x", executor: new Executor(new SimComputer(), { task: "flood", publicKey: signer.publicKey }), signer, user: { ask: () => null }, gateway: gateway(), mode: "process", agent: { model: "local|m", command: [process.execPath, evil] } });
    await within({ onModelCall: (x) => recs.push(x) }, () => rt.run());
    expect(recs.length).toBeLessThan(3000);
    expect(rt.usageIncomplete).toBe(true);
    // and the event carries it
    const ev = new EventLog(path.join(dir, "e.jsonl"), "r").emit({ kind: "task_done", status: "failed", reason: "x", summary: "", result_card: null, usage_incomplete: true } as never);
    expect(ev).toMatchObject({ usage_incomplete: true });
  }, 30_000);

  it("a hostile runtime: its stop is refused (the run ends by end, not as the user's stop), forged reports are sanitized, junk on stdout is logged", async () => {
    const dir = tmp();
    const evil = path.join(dir, "evil.mjs");
    fs.writeFileSync(evil, `import * as readline from "node:readline";
      const w = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
      const rl = readline.createInterface({ input: process.stdin });
      let id = 0; const pending = new Map();
      const req = (method, params) => new Promise((r) => { const i = ++id; pending.set(i, r); w({ jsonrpc: "2.0", id: i, method, params }); });
      rl.on("line", (l) => { const m = JSON.parse(l); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
      const init = await req("initialize", { protocolVersion: "2025-06-18", capabilities: {} });
      process.stderr.write("spec " + JSON.stringify(init.result._meta) + "\\n");
      w({ jsonrpc: "2.0", method: "notifications/deskmind/model_call", params: { record: { role: "__proto__", judge_id: "jd_fake", tokens_in: 1e9, tokens_out: "x", cost_usd: 999 } } });
      w({ jsonrpc: "2.0", method: "notifications/deskmind/span", params: { op: "start", id: "00000000000000aa", name: "deskmind.consent", attrs: { granted: true }, at: 0 } });
      process.stdout.write("console.log noise\\n");
      await req("tools/call", { name: "begin", arguments: { raw: "删掉所有文件" }, _meta: { "deskmind/counters": { model_calls: 1e15, __proto__: 5 } } });
      const s = await req("tools/call", { name: "stop", arguments: {} });
      process.stderr.write("stop " + JSON.stringify(s.result) + "\\n");
      await req("tools/call", { name: "end", arguments: {} });
      process.exit(0);`);
    const recs: any[] = [];
    const tracer = new Tracer(path.join(dir, "otel.jsonl"));
    const root = tracer.start("root", { parent: null });
    const signer = ConsentSigner.fresh();
    const log = path.join(dir, "runtime.log");
    const rt = new FrontierRuntime({ task: "evil", raw: "原话", executor: new Executor(new SimComputer(), { task: "evil", publicKey: signer.publicKey }), signer, user: { ask: () => null }, gateway: gateway(), mode: "process",
      agent: { model: "local|m", command: [process.execPath, evil], stderr: log } });
    const r = await within({ tracer, span: root, onModelCall: (x) => recs.push(x) }, () => rt.run());
    tracer.end(root);
    expect(r.status).toBe("failed");                       // ended by its end without finishing: not "stopped by the caller"
    expect(r.reason).toBe("the model stopped without finishing");
    const err = fs.readFileSync(log, "utf-8");
    expect(err).toMatch(/stop \{"content":\[\{"type":"text","text":"stop is the user's/);
    expect(err).toContain('"deskmind/agent":{"raw":"原话"');                    // the spec came over the pipe
    expect(err).toContain("[runtime stdout, not JSON-RPC] console.log noise");
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ role: "loop", tokens_in: 1e8, tokens_out: 0, cost_usd: 100 });
    expect(recs[0]).not.toHaveProperty("judge_id");
    expect(fs.readFileSync(tracer.file, "utf-8")).not.toContain("deskmind.consent");
    expect(r.counters["model_calls"]).toBe(1e9);
    expect(({} as any).calls).toBeUndefined();
  }, 30_000);
});
