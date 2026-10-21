/**
 * The chat session (H1, docs/protocol.md 「会话（第 1 版）」): streaming, stop, replay, resume after a kill, the key
 * errors, compaction, and the session list. In-process with a scripted model, and as its own process against a fake
 * OpenAI-compatible service on localhost (no network).
 */
import { afterAll, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { SessionHost, acquireLock, parseSessionControl } from "../src/session/host.js";
import { SessionLog, listSessions, MAX_USER_CHARS } from "../src/session/log.js";
import { buildContext, exchanges, localDate, systemPrompt } from "../src/session/context.js";
import { classifyError, reply, type SessionModel } from "../src/session/loop.js";
import { redactKeys } from "../src/gateway/index.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";
import type { Message } from "@earendil-works/pi-ai";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dm-session-"));
const MODEL = { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 128_000, maxTokens: 8_000 } as never;
const scripted = (steps: Step[], seen: Message[][] = []): SessionModel => ({ model: MODEL, streamFn: scriptedStream(steps, seen) });

function host(steps: Step[], o: { dir?: string; sid?: string; seen?: Message[][]; config?: string; noModel?: boolean } = {}) {
  const evs: any[] = [];
  const dir = o.dir ?? tmp();
  const h = new SessionHost({ dir, sessionId: o.sid ?? "ses_t", out: (e) => evs.push(e), coalesceMs: 20, ...(o.config ? { config: o.config } : {}), ...(o.noModel ? {} : { model: scripted(steps, o.seen) }) });
  h.start();
  const say = async (text: string) => { h.handle(JSON.stringify({ type: "say", text })); await h.idle(); };
  return { h, evs, dir, say };
}
const kinds = (evs: any[], k: string) => evs.filter((e) => e.kind === k);

describe("session: one reply", () => {
  it("starts with the protocol versions; the deltas, joined, are the final message, in order and without gaps", async () => {
    const chunks = ["你好，", "我是 ", "DeskMind。", "有什么", "可以帮你？"];
    const { evs, say } = host([{ text: chunks.join(""), chunks, delayMs: 15 }]);
    expect(evs[0]).toMatchObject({ kind: "session.start", session_id: "ses_t", last_seq: 0, resumed: false });
    expect(evs[0].protocol).toEqual({ session: 1 });
    expect(evs[0].seq).toBeUndefined();
    await say("你好");
    const deltas = kinds(evs, "session.delta");
    const final = kinds(evs, "session.message").find((m) => m.role === "assistant");
    expect(final).toMatchObject({ role: "assistant", text: chunks.join(""), reply_to: kinds(evs, "session.message")[0].msg_id, model: "test|scripted" });
    expect(deltas.every((d) => d.msg_id === final.msg_id && d.seq === undefined)).toBe(true);
    expect(deltas.map((d) => d.text).join("")).toBe(final.text);
    // each delta says where it starts: no gap, no overlap; the first (empty) says the reply has begun
    let at = 0;
    for (const d of deltas) { expect(d.offset).toBe(at); at += d.text.length; }
    expect(deltas[0]).toMatchObject({ text: "", offset: 0 });
    // coalesced: fewer deltas than chunks is allowed, more is not
    expect(deltas.length - 1).toBeLessThanOrEqual(chunks.length);
  });

  it("stores exactly the final messages with seq 1..n; the model saw the system prompt and the user's words", async () => {
    const seen: Message[][] = [];
    const { evs, dir, say } = host([{ text: "一" }, { text: "二" }], { seen });
    await say("第一句");
    await say("第二句");
    const lines = fs.readFileSync(path.join(dir, "sessions", "ses_t", "session.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.seq, l.kind, l.role, l.text])).toEqual([[1, "session.message", "user", "第一句"], [2, "session.message", "assistant", "一"], [3, "session.message", "user", "第二句"], [4, "session.message", "assistant", "二"]]);
    expect(lines.every((l) => l.session_id === "ses_t")).toBe(true);
    expect(kinds(evs, "session.message").map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    const second = seen[1]!;
    expect(second[0]).toMatchObject({ role: "system", content: systemPrompt("zh") });
    expect(second.slice(1).map((m: any) => [m.role, typeof m.content === "string" ? m.content : m.content[0].text])).toEqual([["user", "第一句"], ["assistant", "一"], ["user", "第二句"]]);
    // the folder holds the user's words: only the user can read it
    expect(fs.statSync(path.join(dir, "sessions", "ses_t")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "sessions")).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(dir, "sessions", "ses_t", "session.jsonl")).mode & 0o777).toBe(0o600);
  });

  it("stop ends the reply with stopped: true and the text that had come; the next say works", async () => {
    const chunks = Array.from({ length: 20 }, (_, i) => `第${i}段。`);
    const { h, evs, say } = host([{ text: chunks.join(""), chunks, delayMs: 20 }, { text: "好的" }]);
    h.handle(JSON.stringify({ type: "say", text: "讲个长故事" }));
    await new Promise<void>((res) => { const t = setInterval(() => { if (kinds(evs, "session.delta").some((d) => d.text)) { clearInterval(t); res(); } }, 5); });
    h.handle(JSON.stringify({ type: "stop" }));
    await h.idle();
    const a = kinds(evs, "session.message").find((m) => m.role === "assistant");
    expect(a.stopped).toBe(true);
    expect(a.text.length).toBeGreaterThan(0);
    expect(a.text.length).toBeLessThan(chunks.join("").length);
    expect(kinds(evs, "session.delta").map((d) => d.text).join("")).toBe(a.text);
    await say("算了");
    expect(kinds(evs, "session.message").at(-1)).toMatchObject({ role: "assistant", text: "好的" });
    expect(kinds(evs, "session.message").at(-1).stopped).toBeUndefined();
  });

  it("a say while a reply is coming is refused (busy), not stored; too long is refused; task controls with no task are no_task", async () => {
    const { h, evs } = host([{ text: "慢慢说", chunks: ["慢", "慢说"], delayMs: 30 }]);
    h.handle(JSON.stringify({ type: "say", text: "一" }));
    h.handle(JSON.stringify({ type: "say", text: "二" }));
    h.handle(JSON.stringify({ type: "say", text: "x".repeat(MAX_USER_CHARS + 1) }));
    for (const t of ["cua", "steer", "answer", "respond", "queue_add"]) h.handle(JSON.stringify({ type: t, text: "x" }));
    h.handle(JSON.stringify({ type: "later_thing" }));
    h.handle("not json");
    await h.idle();
    const errs = kinds(evs, "session.error");
    // H2: a /cua while a reply is coming is busy; steer / answer / respond name no task; an unknown queue_* is ignored
    expect(errs.map((e) => [e.code, e.control])).toEqual([["busy", "say"], ["too_long", "say"], ["busy", "cua"], ["no_task", "steer"], ["no_task", "answer"], ["no_task", "respond"]]);
    expect(errs.every((e) => e.seq === undefined)).toBe(true);
    expect(kinds(evs, "session.message").map((m) => m.text)).toEqual(["一", "慢慢说"]);
    expect(parseSessionControl(JSON.stringify({ type: "attach", after_seq: -3 }))).toEqual({ type: "attach", after_seq: 0 });
  });

  it("a reply over 64k characters is cut there and marked truncated", async () => {
    const big = "字".repeat(40_000);
    const { evs, say } = host([{ text: big + big, chunks: [big, big] }]);
    await say("写长一点");
    const a = kinds(evs, "session.message").find((m) => m.role === "assistant");
    expect(a.truncated).toBe(true);
    expect(a.text.length).toBe(64_000);
    expect(kinds(evs, "session.delta").map((d) => d.text).join("")).toBe(a.text);
  });
});

describe("session: errors", () => {
  it("no key: the user's message is kept, then no_key (stored, naming the variable, never a key)", async () => {
    const saved = { url: process.env.CUSTOM_URL, key: process.env.CUSTOM_API_KEY };
    process.env.CUSTOM_URL = "http://127.0.0.1:9"; delete process.env.CUSTOM_API_KEY;
    try {
      const { evs, say } = host([], { config: "openai:custom|some-model", noModel: true });
      await say("在吗");
      const err = kinds(evs, "session.error")[0];
      expect(err).toMatchObject({ kind: "session.error", code: "no_key", seq: 2, reply_to: kinds(evs, "session.message")[0].msg_id });
      expect(err.text).toContain("CUSTOM_API_KEY");
      expect(kinds(evs, "session.message").map((m) => m.role)).toEqual(["user"]);
      expect(kinds(evs, "session.delta")).toEqual([]);
    } finally {
      if (saved.url === undefined) delete process.env.CUSTOM_URL; else process.env.CUSTOM_URL = saved.url;
      if (saved.key !== undefined) process.env.CUSTOM_API_KEY = saved.key;
    }
  });

  it("an unknown config is bad_config; the service's refusals map to key_invalid / quota / network by status", async () => {
    const { evs, say } = host([], { config: "nope", noModel: true });
    await say("在吗");
    expect(kinds(evs, "session.error")[0]).toMatchObject({ code: "bad_config" });
    expect(classifyError("401 Authentication Fails, Your api key: ****abcd is invalid")).toBe("key_invalid");
    expect(classifyError("402: {\"error\":{\"message\":\"Insufficient Balance\"}}")).toBe("quota");
    expect(classifyError("429 Too Many Requests")).toBe("quota");
    expect(classifyError("Connection error.")).toBe("network");
    expect(classifyError("503 Service Unavailable")).toBe("network");
    const k = host([{ error: "401 Authentication Fails (sk-abcdefghijklmnop)" }]);
    await k.say("hi");
    const e = kinds(k.evs, "session.error")[0];
    expect(e).toMatchObject({ code: "key_invalid", seq: 2 });
    expect(e.text).not.toContain("abcdefghijklmnop");
    expect(e.msg_id).toMatch(/^msg_/);
  });
});

describe("session: attach and resume", () => {
  it("attach{after_seq} replays the stored events after it: with what the app had, nothing twice, nothing missing", async () => {
    const { h, evs, say } = host([{ text: "a1" }, { text: "a2" }, { text: "a3", chunks: ["a", "3"], delayMs: 40 }]);
    await say("u1");
    await say("u2");
    const seenByApp = kinds(evs, "session.message").filter((e) => e.seq <= 2);      // the app went away after seq 2
    const before = evs.length;
    h.handle(JSON.stringify({ type: "attach", after_seq: 2 }));
    const replay = evs.slice(before);
    expect(replay.map((e) => e.seq)).toEqual([3, 4]);
    expect([...seenByApp, ...replay].map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    // attach during a reply: the text so far, as one delta at offset 0, after the stored events
    h.handle(JSON.stringify({ type: "say", text: "u3" }));
    await new Promise<void>((res) => { const t = setInterval(() => { if (kinds(evs, "session.delta").some((d) => d.text === "a")) { clearInterval(t); res(); } }, 5); });
    const mark = evs.length;
    h.handle(JSON.stringify({ type: "attach", after_seq: 4 }));
    const r2 = evs.slice(mark);
    expect(r2.map((e) => [e.kind, e.seq, e.text, e.offset])).toEqual([["session.message", 5, "u3", undefined], ["session.delta", undefined, "a", 0]]);
    await h.idle();
    const last = kinds(evs, "session.delta").at(-1);
    expect(last).toMatchObject({ text: "3", offset: 1 });
    h.handle(JSON.stringify({ type: "attach", after_seq: 0 }));
    expect(evs.slice(-6).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("a session reopened from its file reads the same history and continues the seq", async () => {
    const dir = tmp();
    const a = host([{ text: "r1" }], { dir });
    await a.say("u1");
    const seen: Message[][] = [];
    const b = host([{ text: "r2" }], { dir, seen });
    expect(b.evs[0]).toMatchObject({ kind: "session.start", resumed: true, last_seq: 2 });
    await b.say("u2");
    expect(kinds(b.evs, "session.message").map((e) => e.seq)).toEqual([3, 4]);
    expect(seen[0]!.slice(1).map((m: any) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("session: context", () => {
  const msg = (role: "user" | "assistant", text: string, i: number) => ({ msg_id: `m${i}`, role, text });
  it("compaction drops the oldest whole exchanges down to about half the budget, says how many messages, never cuts the newest user message", () => {
    const hist = [];
    for (let i = 0; i < 10; i++) { hist.push(msg("user", `问${i} ` + "x".repeat(100), 2 * i)); hist.push(msg("assistant", `答${i} ` + "y".repeat(100), 2 * i + 1)); }
    hist.push(msg("user", "最新的问题 " + "z".repeat(200), 99));
    const sys = "S";
    const all = buildContext(hist, { budgetChars: 1e6, system: sys });
    expect(all.dropped).toBe(0);
    expect(all.messages.length).toBe(21);
    const c = buildContext(hist, { budgetChars: 1000, system: sys });
    expect(c.messages.at(-1)).toEqual({ role: "user", text: hist.at(-1)!.text });
    expect(c.messages[0]!.role).toBe("user");
    expect(c.messages.length % 2).toBe(1);
    expect(c.dropped).toBe(21 - c.messages.length);
    expect(c.dropped).toBeGreaterThan(0);
    expect(c.system).toBe(`S\n\n（更早的 ${c.dropped} 条对话已省略）`);
    expect(c.chars - c.system.length).toBeLessThanOrEqual(999);
    // the kept ones are the newest, whole
    expect(c.messages.slice(0, -1).map((m) => m.text)).toEqual(hist.slice(21 - c.messages.length, -1).map((m) => m.text));
    // a budget smaller than the newest message alone: it is still there, alone
    const tiny = buildContext(hist, { budgetChars: 10, system: sys, lang: "en" });
    expect(tiny.messages).toEqual([{ role: "user", text: hist.at(-1)!.text }]);
    expect(tiny.dropped).toBe(20);
    expect(tiny.system).toBe("S\n\n(20 earlier messages of this conversation are omitted.)");
  });

  it("the cut moves in jumps, not every turn: the context keeps its beginning for several turns", () => {
    const hist: any[] = [];
    const cuts: number[] = [];
    const firsts: string[] = [];
    for (let i = 0; i < 60; i++) {
      hist.push(msg("user", `问${i} ` + "x".repeat(100), 2 * i));
      const c = buildContext(hist, { budgetChars: 3000, system: "S" });
      cuts.push(c.dropped); firsts.push(c.messages[0]!.text);
      expect(c.chars - c.system.length).toBeLessThanOrEqual(2999);
      // the same history gives the same cut
      expect(buildContext(hist, { budgetChars: 3000, system: "S" })).toEqual(c);
      hist.push(msg("assistant", `答${i} ` + "y".repeat(100), 2 * i + 1));
    }
    // never moves back; moves seldom (each move frees about half the budget: ~7 turns of 208 characters)
    for (let i = 1; i < cuts.length; i++) expect(cuts[i]).toBeGreaterThanOrEqual(cuts[i - 1]!);
    const moves = cuts.filter((d, i) => i > 0 && d !== cuts[i - 1]).length;
    expect(moves).toBeGreaterThan(2);
    expect(moves).toBeLessThanOrEqual(60 / 5);
    // between moves the first message the model reads is the same
    for (let i = 1; i < cuts.length; i++) if (cuts[i] === cuts[i - 1]) expect(firsts[i]).toBe(firsts[i - 1]);
  });

  it("a user message with no reply joins the next one; an empty stopped reply is left out, a partial one is marked", () => {
    const h = [msg("user", "a", 1), msg("user", "b", 2), msg("assistant", "", 3), msg("user", "c", 4), { ...msg("assistant", "半句", 5), stopped: true }, msg("user", "d", 6)];
    expect(exchanges(h).map((g) => g.map((m) => m.msg_id))).toEqual([["m1", "m2", "m4", "m5"], ["m6"]]);
    expect(buildContext(h, { budgetChars: 1e6, system: "S" }).messages).toEqual([{ role: "user", text: "a\n\nb\n\nc" }, { role: "assistant", text: "半句\n\n（这条回复被用户中途停下了）" }, { role: "user", text: "d" }]);
  });
});

// ---- the process: a fake OpenAI-compatible service on localhost ------------------------------------------------------

interface FakeReq { messages: { role: string; content: unknown }[] }
function fakeService() {
  const requests: FakeReq[] = [];
  /** What each request is answered with: chunks, then finish — or `hang` after the chunks (the stream stays open). */
  const plan: { chunks: string[]; hang?: boolean; die?: boolean; status?: number }[] = [];
  const open = new Set<http.ServerResponse>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      requests.push(JSON.parse(body));
      const p = plan.shift() ?? { chunks: ["(no plan)"] };
      if (p.status) { res.writeHead(p.status, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "nope" } })); return; }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (delta: unknown, finish: string | null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 0, model: "fake", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      res.write(chunk({ role: "assistant", content: "" }, null));
      for (const c of p.chunks) res.write(chunk({ content: c }, null));
      if (p.hang) { open.add(res); return; }
      if (p.die) { setTimeout(() => res.destroy(), 30); return; }
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    });
  });
  const ready = new Promise<string>((res) => server.listen(0, "127.0.0.1", () => res(`http://127.0.0.1:${(server.address() as any).port}`)));
  return { requests, plan, ready, close: () => { for (const r of open) r.destroy(); server.close(); } };
}

function proc(args: string[], env: Record<string, string>) {
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/cli/app.ts", ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const evs: any[] = [];
  let buf = "", err = "";
  child.stdout!.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l.trim()) evs.push(JSON.parse(l)); } });
  child.stderr!.on("data", (d) => (err += d));
  const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
  const until = (f: () => boolean, ms = 20_000) => new Promise<void>((res, rej) => { const t0 = Date.now(); const t = setInterval(() => { if (f()) { clearInterval(t); res(); } else if (Date.now() - t0 > ms) { clearInterval(t); rej(new Error(`timeout; events ${JSON.stringify(evs)}; stderr ${err}`)); } }, 10); });
  const send = (o: unknown) => child.stdin!.write(JSON.stringify(o) + "\n");
  return { child, evs, until, send, exited, stderr: () => err };
}

describe("session: the process", () => {
  const svc = fakeService();
  afterAll(() => svc.close());

  it("killed mid-reply: the partial reply is gone, the user message kept; --session resumes with the same context", async () => {
    const url = await svc.ready;
    const dir = tmp();
    const env = { LOCAL_URL: url, LOCAL_API_KEY: "test-key" };
    const config = "openai:local|fake";
    const A = proc(["session", "--dir", dir], env);
    A.send({ session_id: "ses_kill", config, lang: "zh" });
    await A.until(() => A.evs.some((e) => e.kind === "session.start"));
    expect(A.evs[0]).toMatchObject({ kind: "session.start", session_id: "ses_kill", resumed: false, protocol: { session: 1 } });
    svc.plan.push({ chunks: ["你好", "！"] });
    A.send({ type: "say", text: "u1" });
    await A.until(() => A.evs.some((e) => e.kind === "session.message" && e.role === "assistant"));
    expect(A.evs.find((e) => e.kind === "session.message" && e.role === "assistant").text).toBe("你好！");
    // only the user can read the session's files, the lock included
    for (const f of ["", "session.jsonl", "lock", "model_calls.jsonl"]) expect(fs.statSync(path.join(dir, "sessions", "ses_kill", f)).mode & 0o777).toBe(f ? 0o600 : 0o700);
    svc.plan.push({ chunks: ["说到一半"], hang: true });
    A.send({ type: "say", text: "u2" });
    await A.until(() => A.evs.some((e) => e.kind === "session.delta" && e.text === "说到一半"));
    A.child.kill("SIGKILL");
    await A.exited;
    const stored = new SessionLog(dir, "ses_kill").events;
    expect(stored.map((e: any) => [e.seq, e.role, e.text])).toEqual([[1, "user", "u1"], [2, "assistant", "你好！"], [3, "user", "u2"]]);
    const killedTurn = svc.requests.at(-1)!.messages;

    const B = proc(["session", "--session", "ses_kill", "--dir", dir, "--config", config], env);
    await B.until(() => B.evs.some((e) => e.kind === "session.start"));
    expect(B.evs[0]).toMatchObject({ kind: "session.start", resumed: true, last_seq: 3 });
    svc.plan.push({ chunks: ["接着说"] });
    B.send({ type: "say", text: "u3" });
    await B.until(() => B.evs.some((e) => e.kind === "session.message" && e.role === "assistant"));
    const resumedTurn = svc.requests.at(-1)!.messages;
    // the same context as the killed turn's; the unanswered u2 and the new u3 read as one user message
    expect(resumedTurn.slice(0, -1)).toEqual(killedTurn.slice(0, -1));
    expect(killedTurn.at(-1)).toMatchObject({ role: "user", content: "u2" });
    expect(resumedTurn.at(-1)).toMatchObject({ role: "user", content: "u2\n\nu3" });
    expect(B.evs.filter((e) => e.kind === "session.message").map((e) => e.seq)).toEqual([4, 5]);
    // the app goes away (stdin closes) and nothing runs: the process exits by itself
    B.child.stdin!.end();
    expect(await B.exited).toBe(0);
    expect(fs.existsSync(path.join(dir, "sessions", "ses_kill", "lock"))).toBe(false);
  }, 60_000);

  it("a key the service refuses is key_invalid; stdin closing mid-reply still stores the reply before exiting", async () => {
    const url = await svc.ready;
    const dir = tmp();
    const P = proc(["session", "--dir", dir, "--config", "openai:local|fake"], { LOCAL_URL: url, LOCAL_API_KEY: "bad" });
    P.send({ session_id: "ses_401" });
    svc.plan.push({ chunks: [], status: 401 });
    P.send({ type: "say", text: "hi" });
    await P.until(() => P.evs.some((e) => e.kind === "session.error"));
    expect(P.evs.find((e) => e.kind === "session.error")).toMatchObject({ code: "key_invalid", seq: 2 });
    svc.plan.push({ chunks: ["最后", "一句"] });
    P.send({ type: "say", text: "再试" });
    P.child.stdin!.end();
    expect(await P.exited).toBe(0);
    expect(new SessionLog(dir, "ses_401").messages().map((m) => m.text)).toEqual(["hi", "再试", "最后一句"]);
  }, 60_000);

  it("sessions list: the newest first, titled by the first user message (40 characters)", async () => {
    const dir = tmp();
    const a = host([{ text: "好" }], { dir, sid: "ses_a" });
    await a.say("第一个会话的第一句话，这句话故意写得很长很长，超过四十个字符以后应该被截断掉，后面这些都不要");
    await new Promise((r) => setTimeout(r, 20));
    const b = host([{ text: "嗯" }, { text: "行" }], { dir, sid: "ses_b" });
    await b.say("短的");
    await b.say("第二句");
    fs.mkdirSync(path.join(dir, "sessions", "not a session"), { recursive: true });
    const p = spawnSync(process.execPath, ["--import", "tsx", "src/cli/app.ts", "sessions", "list", "--dir", dir], { encoding: "utf-8", timeout: 60_000 });
    expect(p.status).toBe(0);
    const list = JSON.parse(p.stdout);
    expect(list).toEqual(listSessions(dir));
    expect(list.map((s: any) => s.session_id)).toEqual(["ses_b", "ses_a"]);
    expect(list[0]).toMatchObject({ title: "短的", last_message: { role: "assistant", text: "行" } });
    expect(Array.from(list[1].title as string).length).toBe(41);        // 40 and the "…"
    expect(list[1].title.endsWith("…")).toBe(true);
    expect(typeof list[0].updated_at).toBe("number");
    expect(list[0].updated_at).toBeGreaterThanOrEqual(list[1].updated_at);
  }, 60_000);
});

describe("session: review fixes (#52)", () => {
  const deadPid = () => { const p = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf-8" }); return Number(p.stdout); };

  it("lock: busy while a live process holds it; a dead holder's lock is taken over; release tolerates a missing file", () => {
    const dir = tmp();
    const lockFile = path.join(dir, "sessions", "ses_l", "lock");
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"]);
    try {
      fs.writeFileSync(lockFile, String(holder.pid));
      expect(acquireLock(dir, "ses_l")).toEqual({ ok: false, pid: holder.pid });
      expect(fs.readFileSync(lockFile, "utf-8")).toBe(String(holder.pid));
    } finally { holder.kill("SIGKILL"); }
    const dead = deadPid();
    fs.writeFileSync(lockFile, String(dead));
    const got = acquireLock(dir, "ses_l");
    expect(got.ok).toBe(true);
    expect(fs.readFileSync(lockFile, "utf-8")).toBe(String(process.pid));
    expect(fs.statSync(lockFile).mode & 0o777).toBe(0o600);
    // this process holds it now: a second acquire is refused
    expect(acquireLock(dir, "ses_l")).toEqual({ ok: false, pid: process.pid });
    // no stray files beside the lock (the temp file and the renamed-aside one are removed)
    expect(fs.readdirSync(path.dirname(lockFile))).toEqual(["lock"]);
    fs.unlinkSync(lockFile);
    if (got.ok) expect(() => got.release()).not.toThrow();
    // an empty lock file (left by an older version) counts as stale
    fs.writeFileSync(lockFile, "");
    expect(acquireLock(dir, "ses_l").ok).toBe(true);
  });

  it("lock: two processes trying at the same moment, 40 times (half on a stale lock): exactly one wins each time", async () => {
    const dir = tmp();
    const n = 40, dead = deadPid();
    for (let i = 0; i < n; i += 2) { fs.mkdirSync(path.join(dir, "sessions", `ses_${i}`), { recursive: true }); fs.writeFileSync(path.join(dir, "sessions", `ses_${i}`, "lock"), String(dead)); }
    const t0 = Date.now() + 4000, gap = 25, until = t0 + n * gap + 3000;
    const run = () => new Promise<any[]>((res, rej) => {
      const c = spawn(process.execPath, ["--import", "tsx", "test/lock-contend.ts", dir, String(n), String(t0), String(gap), String(until)]);
      let o = "", e = "";
      c.stdout.on("data", (d) => (o += d)); c.stderr.on("data", (d) => (e += d));
      c.on("exit", (code) => code === 0 ? res(o.trim().split("\n").map((l) => JSON.parse(l))) : rej(new Error(e)));
    });
    const [a, b] = await Promise.all([run(), run()]);
    for (let i = 0; i < n; i++) expect([a![i].ok, b![i].ok].filter(Boolean).length, `session ${i}`).toBe(1);
    for (let i = 0; i < n; i++) expect(fs.readdirSync(path.join(dir, "sessions", `ses_${i}`))).toEqual(["lock"]);
  }, 60_000);

  it("lock: two threads lined up to microseconds, 200 times (half on a stale lock): exactly one wins each time", () => {
    const dir = tmp();
    const p = spawnSync(process.execPath, ["--import", "tsx", "test/lock-threads.ts", dir, "200", String(deadPid())], { encoding: "utf-8", timeout: 60_000 });
    expect(p.status, p.stderr).toBe(0);
    const rounds: [boolean, boolean][] = JSON.parse(p.stdout);
    expect(rounds.length).toBe(200);
    expect(rounds.filter(([a, b]) => a === b)).toEqual([]);
  }, 60_000);

  it("a bad header is refused as bad_config (no stack trace): non-string id or config, a path as id, an unknown lang", () => {
    const run = (args: string[], input: string) => spawnSync(process.execPath, ["--import", "tsx", "src/cli/app.ts", "session", "--dir", tmp(), ...args], { input, encoding: "utf-8", timeout: 60_000 });
    for (const header of [{ session_id: 5 }, { session_id: "../x" }, { config: { a: 1 } }, { lang: "fr" }, { session_id: "ok", driver: 1 }]) {
      const p = run([], JSON.stringify(header) + "\n");
      expect(p.status, JSON.stringify(header)).toBe(2);
      expect(p.stderr).not.toMatch(/at .*\.ts:\d+/);
      expect(JSON.parse(p.stdout.trim())).toMatchObject({ kind: "session.error", code: "bad_config" });
    }
    const p = run(["--session", "../x"], "");
    expect(p.status).toBe(2);
    expect(JSON.parse(p.stdout.trim())).toMatchObject({ kind: "session.error", code: "bad_config" });
    // after start (resume, then a header line): refused, nothing changes
    const { h, evs } = host([{ text: "好" }]);
    h.configure({ config: 7 });
    expect(evs.at(-1)).toMatchObject({ kind: "session.error", code: "bad_config", text: "config must be a string" });
    expect(h.config).toBe("ds-flash");
  });

  it("a partial last line (killed inside a write) is skipped on resume; the next event takes its seq", async () => {
    const dir = tmp();
    const a = host([{ text: "r1" }], { dir });
    await a.say("u1");
    const file = path.join(dir, "sessions", "ses_t", "session.jsonl");
    fs.appendFileSync(file, '{"seq":3,"t":1,"session_id":"ses_t","kind":"session.mess');
    const b = host([{ text: "r2" }], { dir });
    expect(b.evs[0]).toMatchObject({ last_seq: 2, resumed: true });
    await b.say("u2");
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
    const good = lines.flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
    expect(good.map((e) => [e.seq, e.text])).toEqual([[1, "u1"], [2, "r1"], [3, "u2"], [4, "r2"]]);
    expect(new SessionLog(dir, "ses_t").messages().map((m) => m.text)).toEqual(["u1", "r1", "u2", "r2"]);
  });

  it("a stop that comes after the model finished does not mark the reply stopped", async () => {
    const ac = new AbortController();
    const r = await reply({ model: scripted([{ text: "ab", chunks: ["a", "b"] }]), context: { system: "S", messages: [{ role: "user", text: "x" }], dropped: 0, chars: 2 }, signal: ac.signal, maxChars: 100,
      onDelta: (d) => { if (d === "b") ac.abort(); } });
    expect(ac.signal.aborted).toBe(true);
    expect(r).toMatchObject({ ended: "done", text: "ab" });
  });

  it("a final text that is not what was streamed is sent whole at offset 0 before the message", async () => {
    const { evs, say } = host([{ text: "abc", chunks: ["ab", "c"], final: "xyz" }]);
    await say("hi");
    const deltas = kinds(evs, "session.delta");
    expect(deltas.at(-1)).toMatchObject({ text: "xyz", offset: 0 });
    const i = evs.indexOf(deltas.at(-1)), m = evs.findIndex((e) => e.kind === "session.message" && e.role === "assistant");
    expect(i).toBeLessThan(m);
    expect(evs[m].text).toBe("xyz");
  });

  it("key values from the environment never reach an error; the session's model calls are recorded; the prompt has today's date", async () => {
    const saved = process.env.CUSTOM_API_KEY;
    process.env.CUSTOM_API_KEY = "my-very-secret-value";
    try {
      expect(redactKeys("401 bad key my-very-secret-value, Bearer abcdefghijkl")).toBe("401 bad key …, Bearer …");
      const { evs, dir, say } = host([{ error: "401 your key my-very-secret-value is wrong" }, { text: "好" }]);
      await say("hi");
      expect(kinds(evs, "session.error")[0].text).toBe("401 your key … is wrong");
      expect(fs.readFileSync(path.join(dir, "sessions", "ses_t", "session.jsonl"), "utf-8")).not.toContain("my-very-secret-value");
      await say("再来");
      const calls = fs.readFileSync(path.join(dir, "sessions", "ses_t", "model_calls.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      expect(calls.map((c) => [c.role, c.outcome, c.model])).toEqual([["session", "error", "test|scripted"], ["session", "answered", "test|scripted"]]);
      expect(calls[1]).toMatchObject({ kind: "model.call", tokens_in: 1, tokens_out: 1, cache_read: 0, msg_id: kinds(evs, "session.message").at(-1).msg_id });
      expect(typeof calls[1].latency_ms).toBe("number");
      expect(calls[0].error).not.toContain("my-very-secret-value");
      expect(fs.statSync(path.join(dir, "sessions", "ses_t", "model_calls.jsonl")).mode & 0o777).toBe(0o600);
    } finally { if (saved === undefined) delete process.env.CUSTOM_API_KEY; else process.env.CUSTOM_API_KEY = saved; }
    expect(systemPrompt("zh", new Date(2026, 9, 22))).toContain("今天是 2026-10-22（本地时间）");
    expect(systemPrompt("en", new Date(2026, 0, 5))).toContain("Today is 2026-01-05 (local time).");
    const seen: Message[][] = [];
    await host([{ text: "x" }], { seen }).say("y");
    expect((seen[0]![0] as any).content).toContain(localDate());
  });
});

describe("session: the process, stop and failures on a real stream", () => {
  const svc = fakeService();
  afterAll(() => svc.close());

  it("stop on a real stream stores what came with stopped: true; a stream that dies mid-way voids its deltas", async () => {
    const url = await svc.ready;
    const dir = tmp();
    const P = proc(["session", "--dir", dir, "--config", "openai:local|fake"], { LOCAL_URL: url, LOCAL_API_KEY: "k" });
    P.send({ session_id: "ses_real" });
    svc.plan.push({ chunks: ["一半", "的话"], hang: true });
    P.send({ type: "say", text: "说长点" });
    await P.until(() => P.evs.filter((e) => e.kind === "session.delta").map((e) => e.text).join("") === "一半的话");
    P.send({ type: "stop" });
    await P.until(() => P.evs.some((e) => e.kind === "session.message" && e.role === "assistant"));
    expect(P.evs.find((e) => e.kind === "session.message" && e.role === "assistant")).toMatchObject({ text: "一半的话", stopped: true, seq: 2 });
    // the service dies mid-stream: the deltas of that reply are void (the error names it), no reply is stored
    svc.plan.push({ chunks: ["说了", "一点"], die: true });
    P.send({ type: "say", text: "再说" });
    await P.until(() => P.evs.some((e) => e.kind === "session.error"));
    const err = P.evs.find((e) => e.kind === "session.error");
    const voided = P.evs.filter((e) => e.kind === "session.delta" && e.msg_id === err.msg_id);
    expect(voided.length).toBeGreaterThan(0);
    expect(err).toMatchObject({ code: "network", seq: 4 });
    expect(new SessionLog(dir, "ses_real").messages().map((m) => [m.role, m.text])).toEqual([["user", "说长点"], ["assistant", "一半的话"], ["user", "再说"]]);
    P.child.stdin!.end();
    expect(await P.exited).toBe(0);
  }, 60_000);
});

