/**
 * set_config (docs/protocol.md 「会话」): a live session's model config and lang change with no new process, and the
 * model can be turned off (config null). Scripted session models (one per config name, so the test sees which one a
 * turn went to), the executor in process (cli/app.ts appRun) on the simulated computer; the keys and the precedence
 * of open / reopen also as the real process against a fake OpenAI-compatible service on localhost (no network).
 */
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import type { Message } from "@earendil-works/pi-ai";
import { SessionHost } from "../src/session/host.js";
import { SessionLog } from "../src/session/log.js";
import type { SessionModel } from "../src/session/loop.js";
import type { ExecutorHandle, Launcher } from "../src/session/task.js";
import { appRun, LineReader } from "../src/cli/app.js";
import { SimComputer } from "../src/executor/sim.js";
import { OUTGOING_QUESTION } from "../src/executor/judge.js";
import { Gateway } from "../src/gateway/index.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dm-cfg-"));
const modelOf = (provider: string) => ({ id: "m", name: "m", api: "openai-completions", provider, baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 128_000, maxTokens: 8_000 }) as never;
const roles = ["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"];
const gateway = () => {
  const gw = new Gateway(Object.fromEntries(roles.map((r) => [r, { backend: "scripted", model: "scripted" }])) as never);
  gw.script = Array(80).fill((role: string, _s: string, u: string) => (role === "verify" ? { choice: "pass", reason: "做完了" } : u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: "stays" } : { choice: "matches" }));
  return gw;
};
const lastJson = (ms: any[]) => { const m = [...ms].reverse().find((x) => x.role === "toolResult"); try { return JSON.parse(m.content[0].text.split("\n")[0]); } catch { return {}; } };
const waitFor = async (cond: () => unknown, ms = 10_000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 5)); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Executors in process: each task takes the next runtime script; the runtime's model calls are kept per task. */
function inproc(scripts: Step[][], sim: (scope?: string) => SimComputer = (s) => new SimComputer(s)) {
  const requests: any[] = [], seen: Message[][][] = [];
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
      inject: { driver: sim(req.scope as string | undefined), gateway: gateway(), model: { model: modelOf("rt"), streamFn: scriptedStream(steps, rt) } } }).then(() => ({ code: 0, signal: null }));
    const h: ExecutorHandle = { write: (l) => { if (!ended) input.write(l + "\n"); }, close: () => { if (!ended) { ended = true; input.end(); } }, onLine: (f) => { cb = f; for (const l of early.splice(0)) f(l); }, exited };
    return h;
  };
  return { launch, requests, seen };
}

const hosts: SessionHost[] = [];
afterEach(async () => { for (const h of hosts.splice(0)) h.end(); await sleep(50); });

/** A session whose model is chosen by config name: `models[name]` is that config's script, and `seen[name]` every
 *  request that config's model got (its length: how many model calls it made). */
function session(o: { models: Record<string, Step[]>; config?: string; lang?: "zh" | "en"; tasks?: Step[][]; dir?: string; scope?: string; sim?: (scope?: string) => SimComputer }) {
  const evs: any[] = [];
  const dir = o.dir ?? tmp();
  const ex = inproc(o.tasks ?? [], o.sim);
  const seen: Record<string, Message[][]> = {}, made: Record<string, SessionModel> = {};
  for (const k of Object.keys(o.models)) seen[k] = [];
    // (the executor knows a config name of the form openai:<provider>|<model>: config C("A") is "openai:a|m")
  const model = (c: string): SessionModel => { const k = /^openai:(\w+)\|m$/.exec(c)?.[1]?.toUpperCase() ?? c; return (made[k] ??= { model: modelOf(k.toLowerCase()), streamFn: scriptedStream(o.models[k] ?? [], seen[k] ??= []) }); };
  let onEvent: ((e: any) => void) | null = null;
  const h = new SessionHost({ dir, sessionId: "ses_c", out: (e) => { evs.push(e); onEvent?.(e); }, coalesceMs: 5, model, launch: ex.launch,
    ...(o.config ? { config: o.config } : {}), ...(o.lang ? { lang: o.lang } : {}), ...(o.scope ? { scope: o.scope } : {}) });
  hosts.push(h);
  h.start();
  const send = (c: Record<string, unknown>) => h.handle(JSON.stringify(c));
  const kinds = (k: string) => evs.filter((e) => e.kind === k);
  const stored = () => new SessionLog(dir, "ses_c").events as any[];
  const calls = (c: string) => seen[c]?.length ?? 0;
  return { h, evs, seen, dir, ex, send, kinds, stored, calls, on: (f: (e: any) => void) => { onEvent = f; } };
}

const CREATE = (name = "a.txt", text = "hi"): Step[] => [
  { calls: [{ name: "fs_create_text", args: { parent: ".", name, text } }] },
  { calls: [{ name: "finish", args: { outcome: "done", summary: `写了 ${name}` } }] },
];
const SLOW = (ms = 300): Step => ({ text: "想想", delayMs: ms });
/** A task that waits for the user: the plan card for changing a simulated editor's text, then the change. */
const EDIT = (w: string): Step[] => [
  { calls: [{ name: "computer_snapshot", args: {} }] },
  { calls: [{ name: "computer_observe", args: { window: w } }] },
  { calls: [{ name: "plan", args: { steps: [{ purpose: "把正文改成「新的」", objects: [`window:${w}`], consequence: "modify_user" }] } }] },
  { calls: [{ name: "computer_observe", args: { window: w } }] },
  (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "set_value", window: w, target: `${w}:0:textarea`, value: "新的" }, epoch: lastJson(m).epoch, consequence: "modify_user", purpose: "改正文", plan_step: 1 } }] }),
  { calls: [{ name: "finish", args: { outcome: "done", summary: "正文改成了「新的」" } }] },
];
const editorSim = () => (scope?: string) => { const s = new SimComputer(scope); s.addEditor("编辑器", { title: "笔记.txt", text: "旧的", path: null }); return s; };
/** The config name of test model `k` (A, B): its turns go to that model's script, `<k>|m`. */
const C = (k: string) => `openai:${k.toLowerCase()}|m`;
const CALL = (goal: string): Step => ({ calls: [{ name: "computer_task", args: { goal } }] });
const assistants = (s: { stored: () => any[] }) => s.stored().filter((e) => e.kind === "session.message" && e.role === "assistant").map((e) => [e.text, e.model]);

describe("set_config: the model and lang of a live session", () => {
  it("switches the provider for the next say, acked by a stored session.config; a task's turn after it takes the new one; the next task's executor gets it", async () => {
    const s = session({ config: C("A"), scope: tmp(), models: { A: [{ text: "a1" }, CALL("新建 a.txt")], B: [{ text: "b1" }, { text: "建好了" }, CALL("新建 b.txt"), { text: "又建好了" }] },
      tasks: [[SLOW(), ...CREATE()], CREATE("b.txt")] });
    s.send({ type: "say", text: "一" });
    await s.h.idle();
    s.send({ type: "set_config", config: C("B"), client_id: "cfg-1" });
    expect(s.stored().at(-1)).toMatchObject({ kind: "session.config", config: C("B"), model: "b|m", lang: "zh", by: "set_config", client_id: "cfg-1" });
    s.send({ type: "say", text: "二" });
    await s.h.idle();
    expect(assistants(s)).toEqual([["a1", "a|m"], ["b1", "b|m"]]);
    expect([s.calls("A"), s.calls("B")]).toEqual([1, 1]);

    // back to A for a turn that starts a task; B is set while the task runs: the turn after the task is B's,
    // the running task keeps A, the next task is started with B
    s.send({ type: "set_config", config: C("A") });
    s.send({ type: "say", text: "新建 a.txt" });
    await waitFor(() => s.kinds("start").length === 1);
    s.send({ type: "set_config", config: C("B") });
    await s.h.idle();
    expect(assistants(s).at(-1)).toEqual(["建好了", "b|m"]);
    expect([s.calls("A"), s.calls("B")]).toEqual([2, 2]);
    expect(s.ex.requests[0].config).toBe(C("A"));
    s.send({ type: "say", text: "再建 b.txt" });
    await s.h.idle();
    expect(s.ex.requests[1].config).toBe(C("B"));
    // each model call recorded under the model that made it
    const rows = fs.readFileSync(path.join(s.dir, "sessions", "ses_c", "model_calls.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l).model);
    expect(rows).toEqual(["a|m", "b|m", "a|m", "b|m", "b|m", "b|m"]);
  });

  it("a reply already streaming keeps the old provider; the config applies from the next turn", async () => {
    const s = session({ config: C("A"), models: { A: [{ text: "慢慢说完", chunks: ["慢慢", "说", "完"], delayMs: 60 }], B: [{ text: "b" }] } });
    s.send({ type: "say", text: "说吧" });
    await waitFor(() => s.kinds("session.delta").some((d) => d.text));
    s.send({ type: "set_config", config: C("B") });
    await s.h.idle();
    expect(assistants(s)).toEqual([["慢慢说完", "a|m"]]);
    expect(s.calls("B")).toBe(0);
    s.send({ type: "say", text: "然后" });
    await s.h.idle();
    expect(assistants(s).at(-1)).toEqual(["b", "b|m"]);
  });

  it("persists across a reopen; an open that names its own config wins and is stored, so the next open takes it", async () => {
    const dir = tmp();
    const a = session({ dir, config: C("A"), models: { A: [], B: [] } });
    a.send({ type: "set_config", config: C("B"), lang: "en" });
    a.h.end();
    // reopened with no settings of its own: the stored ones
    const b = session({ dir, models: { A: [], B: [{ text: "b" }] } });
    expect([b.h.config, b.h.lang]).toEqual([C("B"), "en"]);
    b.send({ type: "say", text: "hi" });
    await b.h.idle();
    expect(assistants(b)).toEqual([["b", "b|m"]]);
    b.h.end();
    // reopened with a config of its own: it wins, and is stored (by open)
    const c = session({ dir, config: C("A"), models: { A: [{ text: "a" }], B: [] } });
    expect([c.h.config, c.h.lang]).toEqual([C("A"), "en"]);
    expect(c.stored().at(-1)).toMatchObject({ kind: "session.config", config: C("A"), lang: "en", by: "open" });
    c.h.end();
    const d = session({ dir, models: { A: [], B: [] } });
    expect(d.h.config).toBe(C("A"));
    // an open that names the stored settings again stores nothing
    d.h.end();
    const n = d.stored().length;
    const e = session({ dir, config: C("A"), lang: "en", models: { A: [], B: [] } });
    expect(e.stored()).toHaveLength(n);
    // no model persists too
    e.send({ type: "set_config", config: null });
    e.h.end();
    const f = session({ dir, models: { A: [{ text: "x" }], B: [] } });
    expect(f.h.config).toBeNull();
    f.send({ type: "say", text: "hi", client_id: "c1" });
    expect(f.kinds("session.error").at(-1)).toMatchObject({ code: "no_model", control: "say", client_id: "c1" });
    expect(f.calls("A")).toBe(0);
  });

  it("lang switches the rendering: the system prompt, the session's own texts, the next task's request", async () => {
    const s = session({ config: C("A"), scope: tmp(), models: { A: [{ text: "好", chunks: ["好"], delayMs: 80 }, { text: "ok" }, CALL("create a.txt"), { text: "done" }] }, tasks: [CREATE()] });
    s.send({ type: "say", text: "你好" });
    s.send({ type: "say", text: "还有" });
    expect(s.kinds("session.error").at(-1).text).toBe("上一条回复还没完：先停下它，或者等它说完");
    await s.h.idle();
    s.send({ type: "set_config", config: C("A"), lang: "en" });
    expect(s.stored().at(-1)).toMatchObject({ kind: "session.config", lang: "en" });
    s.send({ type: "say", text: "hello" });
    s.send({ type: "say", text: "more" });
    expect(s.kinds("session.error").at(-1).text).toBe("a reply is still coming; stop it first or wait");
    await s.h.idle();
    expect((s.seen.A![0]![0] as any).content).toContain("今天是");
    expect((s.seen.A![1]![0] as any).content).toContain("Today is");
    s.send({ type: "say", text: "create a.txt" });
    await s.h.idle();
    expect(s.ex.requests[0].lang).toBe("en");
  });

  it("a bad set_config is refused (bad_config) and changes nothing: no config, a wrong type, an unknown config, a bad lang", () => {
    const evs: any[] = [];
    const h = new SessionHost({ dir: tmp(), sessionId: "ses_c", out: (e) => evs.push(e), config: "ds-flash" });
    hosts.push(h);
    h.start();
    for (const c of [{ lang: "en" }, { config: 3 }, { config: "" }, { config: "no-such-config" }, { config: "ds-flash", lang: "fr" }]) h.handle(JSON.stringify({ type: "set_config", ...c, client_id: "x" }));
    expect(evs.filter((e) => e.kind === "session.error").map((e) => [e.code, e.control, e.client_id, e.seq])).toEqual(Array(5).fill(["bad_config", "set_config", "x", undefined]));
    expect([h.config, h.lang]).toEqual(["ds-flash", "zh"]);
    expect(h.log.events).toHaveLength(0);
    h.handle(JSON.stringify({ type: "set_config", config: "ds-flash" }));
    expect(h.log.events.at(-1)).toMatchObject({ kind: "session.config", config: "ds-flash", model: expect.stringMatching(/^deepseek\|/) });
  });
});

describe("set_config null: no model, nothing more goes to it", () => {
  it("say, cua and retry are refused no_model (not stored, nothing started); the ack has no model", async () => {
    const s = session({ config: C("A"), models: { A: [{ text: "a1" }, { text: "never" }] } });
    s.send({ type: "say", text: "一" });
    await s.h.idle();
    s.send({ type: "set_config", config: null, client_id: "off" });
    const ack = s.stored().at(-1);
    expect(ack).toMatchObject({ kind: "session.config", config: null, lang: "zh", by: "set_config", client_id: "off" });
    expect(ack.model).toBeUndefined();
    const n = s.stored().length;
    s.send({ type: "say", text: "二", client_id: "s1" });
    s.send({ type: "cua", text: "新建 a.txt", client_id: "c1" });
    s.send({ type: "retry" });
    await s.h.idle();
    expect(s.kinds("session.error").map((e) => [e.code, e.control, e.client_id, e.seq])).toEqual([["no_model", "say", "s1", undefined], ["no_model", "cua", "c1", undefined], ["no_model", "retry", undefined, undefined]]);
    expect(s.stored()).toHaveLength(n);
    expect(s.calls("A")).toBe(1);
    expect(s.ex.requests).toHaveLength(0);
  });

  it("a running task is stopped (user_stopped); no model call after it; its end is stored and the next turn, once a config is set, reads it", async () => {
    const s = session({ config: C("A"), scope: tmp(), models: { A: [CALL("新建 a.txt"), { text: "不该有这一轮" }], B: [{ text: "知道了，任务停了" }] }, tasks: [[SLOW(400), ...CREATE()]] });
    s.send({ type: "say", text: "新建 a.txt" });
    await waitFor(() => s.kinds("start").length);
    s.send({ type: "set_config", config: null });
    await s.h.idle();
    await sleep(100);
    expect(s.evs.find((e) => e.kind === "task_done")).toMatchObject({ status: "stopped", cause: "user_stopped" });
    expect(s.stored().find((e) => e.kind === "session.task_end")).toMatchObject({ status: "stopped", cause: "user_stopped" });
    expect(s.calls("A")).toBe(1);
    expect(assistants(s)).toEqual([]);
    // the runtime's model was not asked again after the stop either (its slow first turn was the last)
    expect(s.ex.seen[0]!.length).toBe(1);
    s.send({ type: "set_config", config: C("B") });
    s.send({ type: "say", text: "怎么样了" });
    await s.h.idle();
    const result = s.seen.B![0]!.find((m: any) => m.role === "toolResult") as any;
    expect(JSON.parse(result.content[0].text)).toMatchObject({ status: "stopped" });
  });

  it("the user's stop and then no model, before the task ends: the follow-up turn is skipped (zero model calls after the stop)", async () => {
    const s = session({ config: C("A"), scope: tmp(), models: { A: [CALL("新建 a.txt"), { text: "停下了" }] }, tasks: [[SLOW(400), ...CREATE()]] });
    s.send({ type: "say", text: "新建 a.txt" });
    await waitFor(() => s.kinds("start").length);
    s.send({ type: "stop" });
    s.send({ type: "set_config", config: null });
    await s.h.idle();
    await sleep(100);
    expect(s.stored().find((e) => e.kind === "session.task_end")).toMatchObject({ status: "stopped" });
    expect(s.calls("A")).toBe(1);
    // /cua: its one turn after the task is skipped too
    const c = session({ config: C("A"), scope: tmp(), models: { A: [{ text: "不该有这一轮" }] }, tasks: [[SLOW(400), ...CREATE()]] });
    c.send({ type: "cua", text: "新建 a.txt" });
    await waitFor(() => c.kinds("start").length);
    c.send({ type: "stop" });
    c.send({ type: "set_config", config: null });
    await c.h.idle();
    await sleep(100);
    expect(c.stored().find((e) => e.kind === "session.task_end")).toMatchObject({ status: "stopped" });
    expect(c.calls("A")).toBe(0);
  });

  it("a task card that times out (the app gives up on it, then turns the model off): no model call after it", async () => {
    const s = session({ config: C("A"), sim: editorSim(), models: { A: [CALL("改笔记"), { text: "不该有这一轮" }] }, tasks: [EDIT("editor-1")] });
    s.on((e) => { if (e.kind === "ask") setTimeout(() => { s.send({ type: "answer", run_id: e.run_id, ask_id: e.ask_id }); s.send({ type: "set_config", config: null }); }, 5); });
    s.send({ type: "say", text: "把笔记的正文改成「新的」" });
    await waitFor(() => s.stored().some((e) => e.kind === "session.task_end"));
    await s.h.idle();
    await sleep(100);
    expect(s.kinds("ask")).toHaveLength(1);
    expect(s.calls("A")).toBe(1);
    expect(assistants(s)).toEqual([]);
  });

  it("a turn streaming when the model is turned off ends on its own, and the computer_task it calls does not start; a turn not yet sent is not sent", async () => {
    // (the line comes while the turn's request is out: the step's function runs as the service is asked)
    let t: ReturnType<typeof session> | null = null;
    t = session({ config: C("A"), models: { A: [(_m) => { t!.send({ type: "set_config", config: null }); return CALL("新建 a.txt"); }, { text: "不该有这一轮" }] } });
    t.send({ type: "say", text: "新建 a.txt" });
    await t.h.idle();
    expect(t.ex.requests).toHaveLength(0);
    expect(t.calls("A")).toBe(1);
    expect(t.stored().some((e) => e.kind === "session.task")).toBe(false);

    // a say whose turn has not been sent yet when the model is turned off (the next line): nothing is sent; the
    // user's words are stored, the reply's bubble is void (a no_model refusal naming it, not stored)
    const u = session({ config: C("A"), models: { A: [{ text: "不该有" }] } });
    u.send({ type: "say", text: "你好" });
    u.send({ type: "set_config", config: null });
    await u.h.idle();
    expect(u.calls("A")).toBe(0);
    const err = u.kinds("session.error").at(-1);
    expect(err).toMatchObject({ code: "no_model", msg_id: expect.any(String), reply_to: u.stored()[0].msg_id });
    expect(err.seq).toBeUndefined();
    expect(u.stored().map((e) => e.kind)).toEqual(["session.message", "session.config"]);
    expect(fs.existsSync(path.join(u.dir, "sessions", "ses_c", "model_calls.jsonl"))).toBe(false);
  });

  it("queued words are not delivered while there is no model (nor sent now), and are delivered once a config is set", async () => {
    const s = session({ config: C("A"), scope: tmp(), models: { A: [CALL("新建 a.txt"), { text: "建好了", chunks: ["建", "好了"], delayMs: 80 }, { text: "收到一" }] }, tasks: [[SLOW(), ...CREATE()]] });
    s.send({ type: "say", text: "新建 a.txt" });
    await waitFor(() => s.kinds("start").length);
    s.send({ type: "say", text: "一", client_id: "q1" });
    // the turn after the task is streaming when the model is turned off: it ends on its own; the queue stays
    await waitFor(() => s.kinds("session.delta").some((d) => d.text === "建"));
    s.send({ type: "set_config", config: null });
    await s.h.idle();
    await sleep(50);
    expect(assistants(s)).toEqual([["建好了", "a|m"]]);
    const q = s.kinds("session.queue").at(-1).items;
    expect(q).toEqual([{ id: expect.any(String), text: "一", client_id: "q1" }]);
    expect(s.stored().some((e) => e.kind === "session.message" && e.text === "一")).toBe(false);
    s.send({ type: "queue_send_now", id: q[0].id });
    expect(s.kinds("session.error").at(-1)).toMatchObject({ code: "no_model", control: "queue_send_now", client_id: "q1" });
    expect(s.calls("A")).toBe(2);
    // a config again: the queue goes to the model as usual
    s.send({ type: "set_config", config: C("A") });
    await s.h.idle();
    expect(s.stored().filter((e) => e.kind === "session.message").map((e) => `${e.role}:${e.text}${e.via ? `(${e.via})` : ""}`)).toEqual(["user:新建 a.txt", "assistant:建好了", "user:一(queue)", "assistant:收到一"]);
    expect(s.kinds("session.queue").at(-1).items).toEqual([]);
  });

  it("undo on a lingering result card still works with no model (the executor's receipts; no model call)", async () => {
    const scope = tmp();
    const s = session({ config: C("A"), scope, models: { A: [CALL("新建 a.txt"), { text: "好了" }] }, tasks: [CREATE()] });
    s.send({ type: "say", text: "新建 a.txt 写 hi" });
    await s.h.idle();
    const done = s.evs.find((e) => e.kind === "task_done");
    expect(fs.existsSync(path.join(scope, "a.txt"))).toBe(true);
    s.send({ type: "set_config", config: null });
    s.send({ type: "respond", run_id: done.run_id, option: done.result_card.options.findIndex((x: any) => x.kind === "undo") });
    await waitFor(() => s.stored().some((e) => e.kind === "session.task_closed"));
    expect(s.stored().find((e) => e.kind === "session.task_undo")).toMatchObject({ run_id: done.run_id, undone: 1, total: 1, refused: null });
    expect(fs.existsSync(path.join(scope, "a.txt"))).toBe(false);
    expect(s.calls("A")).toBe(2);
    expect(s.kinds("session.error")).toEqual([]);
  });
});

/** An OpenAI-compatible service on localhost that keeps each request's model and Authorization header. */
function fakeService() {
  const requests: { model: string; auth: string }[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const model = JSON.parse(body).model;
      requests.push({ model, auth: String(req.headers.authorization ?? "") });
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }, null));
      res.write(chunk({ content: `from ${model}` }, null));
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    });
  });
  const ready = new Promise<string>((res) => server.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${(server.address() as any).port}`)));
  return { requests, ready, close: () => server.close() };
}

function proc(args: string[], env: Record<string, string>) {
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/cli/app.ts", ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const evs: any[] = [];
  let buf = "", out = "", err = "";
  child.stdout!.on("data", (d) => { out += d; buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) evs.push(JSON.parse(l)); } });
  child.stderr!.on("data", (d) => (err += d));
  const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
  const until = (f: () => boolean, ms = 20_000) => new Promise<void>((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { if (f()) { clearInterval(t); res(); } else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error(`timeout; events ${JSON.stringify(evs)}; stderr ${err}`)); } }, 10); });
  const send = (o: unknown) => child.stdin!.write(JSON.stringify(o) + "\n");
  return { child, evs, until, send, exited, all: () => out + err };
}

describe("set_config: keys stay in the environment (the real process)", () => {
  const svc = fakeService();
  afterAll(() => svc.close());

  it("each turn uses its own service's key; no key reaches session.jsonl, model_calls.jsonl or an event; a config carrying a key is refused", async () => {
    const url = await svc.ready;
    const dir = tmp();
    const env = { LOCAL_URL: url, LOCAL_API_KEY: "sk-localSECRET0001", CUSTOM_URL: url, CUSTOM_API_KEY: "sk-customSECRET0002" };
    const A = proc(["session", "--dir", dir], env);
    A.send({ session_id: "ses_k", config: "openai:local|fake-a" });
    A.send({ type: "say", text: "u1" });
    await A.until(() => A.evs.filter((e) => e.kind === "session.message").length === 2);
    A.send({ type: "set_config", config: "openai:custom|fake-b", client_id: "k1" });
    await A.until(() => A.evs.some((e) => e.kind === "session.config"));
    expect(A.evs.find((e) => e.kind === "session.config")).toMatchObject({ config: "openai:custom|fake-b", model: "custom|fake-b", lang: "zh", by: "set_config", client_id: "k1", seq: 3 });
    // a config that would carry a key (a key value of the environment, or one that looks like a key) is refused
    A.send({ type: "set_config", config: "openai:custom|sk-customSECRET0002" });
    A.send({ type: "set_config", config: "openai:custom|sk-abcdefghijklmnop" });
    await A.until(() => A.evs.filter((e) => e.kind === "session.error").length === 2);
    expect(A.evs.filter((e) => e.kind === "session.error").map((e) => [e.code, e.control])).toEqual([["bad_config", "set_config"], ["bad_config", "set_config"]]);
    A.send({ type: "say", text: "u2" });
    await A.until(() => A.evs.filter((e) => e.kind === "session.message").length === 4);
    expect(svc.requests.map((r) => [r.model, r.auth])).toEqual([["fake-a", "Bearer sk-localSECRET0001"], ["fake-b", "Bearer sk-customSECRET0002"]]);
    A.child.stdin!.end();
    expect(await A.exited).toBe(0);

    // reopened with no config of its own: the stored one (custom), not the open's of before
    const B = proc(["session", "--session", "ses_k", "--dir", dir], env);
    await B.until(() => B.evs.some((e) => e.kind === "session.start"));
    B.send({ type: "say", text: "u3" });
    await B.until(() => B.evs.some((e) => e.kind === "session.message" && e.role === "assistant"));
    expect(svc.requests.at(-1)).toEqual({ model: "fake-b", auth: "Bearer sk-customSECRET0002" });
    B.child.stdin!.end();
    expect(await B.exited).toBe(0);
    // a config carrying a key at open is refused too (the header, the command line)
    const C = proc(["session", "--dir", dir, "--config", "openai:local|sk-abcdefghijklmnop"], env);
    expect(await C.exited).toBe(2);

    const files = ["session.jsonl", "model_calls.jsonl"].map((f) => fs.readFileSync(path.join(dir, "sessions", "ses_k", f), "utf-8"));
    for (const text of [...files, A.all(), B.all(), C.all()]) for (const key of ["SECRET0001", "SECRET0002", "abcdefghijklmnop"]) expect(text).not.toContain(key);
    expect(JSON.parse(files[0]!.trim().split("\n").at(-1)!)).toMatchObject({ kind: "session.message", role: "assistant", model: "custom|fake-b" });
  }, 60_000);
});
