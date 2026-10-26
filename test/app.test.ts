/**
 * The app entry's pieces: the event log (seq, on disk before sent, replay after a seq), the stdio user (a card out, an
 * answer in, a stray answer refused), the runtime-to-protocol mapping, the prebuilt helper override, and the
 * selftest the packaged binary is checked with.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { EventLog, type AppEvent } from "../src/protocol/events.js";
import { LineReader, StdioUser, selftest, toProtocol, traceWriter } from "../src/cli/app.js";
import { helperBin, helperProblem, prepareHelper, resetHelper } from "../src/registry/mac.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "app-"));

describe("event log", () => {
  it("numbers events, writes each before the sink sees it, and replays after a seq", () => {
    const file = path.join(tmp(), "events.jsonl");
    const sent: AppEvent[] = [];
    const log = new EventLog(file, "r1", (ev) => { sent.push(ev); expect(fs.readFileSync(file, "utf-8").trim().split("\n").length).toBe(ev.seq); });
    log.emit({ kind: "start", raw: "x", lang: "zh", engine: "runtime" });
    log.emit({ kind: "preparing" });
    log.emit({ kind: "step", text: "click" });
    expect(sent.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(sent.every((e) => e.run_id === "r1")).toBe(true);
    const again = new EventLog(file, "r1");
    expect(again.since(1).map((e) => e.kind)).toEqual(["preparing", "step"]);
    expect(again.emit({ kind: "task_done", status: "failed", reason: "x", summary: "", result_card: null }).seq).toBe(4);
  });

  it("an event off the protocol never reaches the app", () => {
    const log = new EventLog(path.join(tmp(), "e.jsonl"), "r1");
    expect(() => log.emit({ kind: "nope" } as never)).toThrow();
    expect(log.events.length).toBe(0);
  });
});

describe("run trace", () => {
  it("keeps every executor event as emitted -- what the protocol leaves out, why included -- with long strings cut", () => {
    const file = path.join(tmp(), "trace.jsonl");
    const trace = traceWriter(file);
    trace("executor.act", { action: { kind: "click", target: "elem_9" }, status: "ok", why: "" });
    trace("executor.consent_needed", { why: "what goes out changed right before sending", consequence: "external", object: "window:x#1" });
    trace("judge.sample", { prompt: "p".repeat(5000), options: ["a", "b"] });
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind)).toEqual(["executor.act", "executor.consent_needed", "judge.sample"]);
    expect(lines[0].status).toBe("ok");                       // an ok act the protocol drops is in the trace
    expect(toProtocol("executor.act", { status: "ok" })).toBeNull();
    expect(lines[1].why).toBe("what goes out changed right before sending");
    expect(lines[2].prompt.length).toBeLessThan(4100);
    expect(lines[2].prompt).toContain("…(+1000)");
    expect(typeof lines[0].t).toBe("number");
  });

  it("marks what a cut list left out", () => {
    const file = path.join(tmp(), "trace.jsonl");
    traceWriter(file)("executor.files_written", { paths: Array.from({ length: 250 }, (_, i) => `f${i}`) });
    const paths = JSON.parse(fs.readFileSync(file, "utf-8").trim()).paths;
    expect(paths).toHaveLength(201);
    expect(paths[199]).toBe("f199");
    expect(paths[200]).toBe("…(+50)");
  });

  it("never stops a run when the file cannot be written", () => {
    const trace = traceWriter(path.join(tmp(), "no-such-dir", "trace.jsonl"));
    expect(() => trace("executor.act", { status: "ok" })).not.toThrow();
  });
});

describe("stdio user", () => {
  it("a card goes out as ask + waiting; the matching answer comes back; a stray answer is refused", async () => {
    const input = new PassThrough();
    const sent: AppEvent[] = [];
    const log = new EventLog(path.join(tmp(), "e.jsonl"), "r1", (ev) => sent.push(ev));
    const u = new StdioUser(log, new LineReader(input));
    const p = u.ask({ kind: "action", text: "点「发送」", free_text: false, blocking: true, options: [{ kind: "approve", text: "可以" }, { kind: "cancel", text: "先别做了" }] });
    await new Promise((r) => setTimeout(r, 10));
    const ask = sent.find((e) => e.kind === "ask") as Extract<AppEvent, { kind: "ask" }>;
    expect(ask.card.options.map((o) => o.kind)).toEqual(["approve", "cancel"]);
    expect(sent.map((e) => e.kind)).toEqual(["ask", "waiting"]);
    input.write(JSON.stringify({ ask_id: "ask_other", option: 0 }) + "\n");
    input.write(JSON.stringify({ ask_id: ask.ask_id, option: 1 }) + "\n");
    expect(await p).toEqual({ option: 1 });
    expect(sent.map((e) => e.kind)).toEqual(["ask", "waiting", "refused", "resumed"]);
    // (U3) the resumed says what was applied
    expect(sent.at(-1)).toMatchObject({ kind: "resumed", ask_id: ask.ask_id, answer: { option: 1 } });
    const p2 = u.ask({ kind: "missing", text: "写什么？", free_text: true, blocking: true, options: [] });
    input.write(JSON.stringify({ text: "买牛奶" }) + "\n");      // no ask_id: taken as the answer to the open card
    expect(await p2).toEqual({ text: "买牛奶" });
    expect(sent.at(-1)).toMatchObject({ kind: "resumed", answer: { text: "买牛奶" } });
  });

  it("(U3) the resumed carries the answer as applied, never as sent: an option off the card with blank words is no answer; an option off the card with words is the words; at expiry the answer is refused and the resumed is a voided one", async () => {
    const input = new PassThrough();
    const sent: AppEvent[] = [];
    const log = new EventLog(path.join(tmp(), "e.jsonl"), "r1", (ev) => sent.push(ev));
    const u = new StdioUser(log, new LineReader(input));
    const card = { kind: "action" as const, text: "点「发送」", free_text: false, blocking: true, options: [{ kind: "approve" as const, text: "可以" }, { kind: "cancel" as const, text: "先别做了" }] };
    const askOf = () => (sent.filter((e) => e.kind === "ask").at(-1) as Extract<AppEvent, { kind: "ask" }>).ask_id;
    const last = () => sent.at(-1) as any;
    const p1 = u.ask(card);
    await new Promise((r) => setTimeout(r, 5));
    input.write(JSON.stringify({ ask_id: askOf(), option: 7, text: "  " }) + "\n");
    expect(await p1).toBeNull();
    expect(last()).toEqual(expect.objectContaining({ kind: "resumed", ask_id: askOf() }));
    expect(last()).not.toHaveProperty("answer");
    // 0.5 is no option: the card settles on no answer and is said so — never a resumed the event schema refuses with the
    // card left neither open nor settled (review of #80 at 0d3a62b)
    const p15 = u.ask(card);
    await new Promise((r) => setTimeout(r, 5));
    input.write(JSON.stringify({ ask_id: askOf(), option: 0.5 }) + "\n");
    expect(await p15).toBeNull();
    expect(last()).toEqual(expect.objectContaining({ kind: "resumed", ask_id: askOf() }));
    expect(last()).not.toHaveProperty("answer");
    const p2 = u.ask(card);
    await new Promise((r) => setTimeout(r, 5));
    input.write(JSON.stringify({ ask_id: askOf(), option: 9, text: "好的" }) + "\n");
    expect(await p2).toEqual({ text: "好的" });
    expect(last()).toMatchObject({ kind: "resumed", ask_id: askOf(), answer: { text: "好的" } });
    // the card's deadline passes as the answer arrives (expired() closes it first): the answer is refused, the resumed is
    // a voided one, with no answer on it
    const ac = new AbortController();
    const p3 = u.ask(card, { signal: ac.signal, expired: () => { ac.abort("timeout"); return true; } });
    await new Promise((r) => setTimeout(r, 5));
    const id3 = askOf();
    input.write(JSON.stringify({ ask_id: id3, option: 0 }) + "\n");
    expect(await p3).toBeNull();
    const tail = sent.slice(sent.findIndex((e) => e.kind === "ask" && (e as any).ask_id === id3));
    expect(tail.map((e) => e.kind)).toEqual(["ask", "waiting", "resumed", "ask_void", "refused"]);
    expect(tail[2]).toEqual(expect.objectContaining({ kind: "resumed", ask_id: id3, voided: "timeout" }));
    expect(tail[2]).not.toHaveProperty("answer");
    expect(tail[4]).toMatchObject({ kind: "refused", what: `answer for ${id3}` });
  });

  it("maps the runtime's events onto the protocol, and drops what the app does not need", () => {
    // a step is the executor's (ExecutorService.step), not the loop's tool call: it reaches the app whoever the caller is
    expect(toProtocol("tool.call", { name: "computer_act", args: { action: { kind: "click", window: "w" }, consequence: "create", purpose: "x" } })).toBeNull();
    expect(toProtocol("step.start", { step_id: "st_1", action: { kind: "click", window: "w", target: "e1" }, consequence: "create", purpose: "x", object: "window:w", object_label: "邮件「收件箱」", human: "点「发送」", target: { id: "e1", label: "发送", role: "button" }, plan_step: 2 })).toEqual({ kind: "step", text: JSON.stringify({ kind: "click", window: "w", target: "e1" }), consequence: "create", purpose: "x", object: "window:w", object_label: "邮件「收件箱」", step_id: "st_1", human: "点「发送」", target: { id: "e1", label: "发送", role: "button" }, plan_step: 2 });
    expect(toProtocol("step.start", { step_id: "st_2", action: { kind: "file", capability: "fs.write_text", args: { path: "a.txt" } }, consequence: "read", purpose: "写" })).toMatchObject({ kind: "step", text: 'fs.write_text {"path":"a.txt"}', step_id: "st_2" });
    expect(toProtocol("step.end", { step_id: "st_1", status: "stale", why: "epoch", executor_status: "stale" })).toEqual({ kind: "step_result", step_id: "st_1", status: "stale", why: "epoch", executor_status: "stale" });
    expect(toProtocol("executor.act", { action: { kind: "key" }, status: "unverified" })).toBeNull();      // the step's result says it
    expect(toProtocol("tool.call", { name: "computer_snapshot", args: {} })).toBeNull();
    expect(toProtocol("consent.asked", { object: "window:w", consequence: "external", picked: "approve" })).toEqual({ kind: "consent", object: "window:w", consequence: "external", scope: "action", picked: "approve" });
    expect(toProtocol("executor.act", { action: { kind: "wait" }, status: "stale", why: "epoch" })).toMatchObject({ kind: "refused", by: "executor" });
    expect(toProtocol("executor.act", { action: { kind: "wait" }, status: "ok" })).toBeNull();
    expect(toProtocol("answer.given", { text: "14:00" })).toEqual({ kind: "answer_given", text: "14:00" });
  });
});

describe("prebuilt helper", () => {
  it("DESKMIND_MACTOOLS that answers ping is used as it is; one that does not is reported, never built around", async () => {
    const dir = tmp();
    const good = path.join(dir, "mactools"), bad = path.join(dir, "broken");
    fs.writeFileSync(good, '#!/bin/sh\necho \'{"ok":true}\'\n'); fs.chmodSync(good, 0o755);
    fs.writeFileSync(bad, "#!/bin/sh\nexit 1\n"); fs.chmodSync(bad, 0o755);
    const prev = process.env.DESKMIND_MACTOOLS;
    try {
      resetHelper(); process.env.DESKMIND_MACTOOLS = good;
      expect(helperBin()).toBe(good);
      expect(helperProblem()).toBeNull();
      resetHelper(); process.env.DESKMIND_MACTOOLS = bad;
      expect(helperBin()).toBeNull();
      expect(helperProblem()).toContain("does not answer ping");
      resetHelper(); process.env.DESKMIND_MACTOOLS = path.join(dir, "missing");
      await prepareHelper();
      expect(helperProblem()).toContain("does not exist");
    } finally {
      resetHelper();
      if (prev === undefined) delete process.env.DESKMIND_MACTOOLS; else process.env.DESKMIND_MACTOOLS = prev;
    }
  });
});

describe("selftest", () => {
  it("passes in-process and as the CLI", async () => {
    expect((await selftest()).ok).toBe(true);
    const p = spawnSync("npx", ["tsx", "src/cli/app.ts", "--selftest"], { encoding: "utf-8", timeout: 60_000 });
    expect(p.status).toBe(0);
    expect(JSON.parse(p.stdout.trim().split("\n").at(-1)!).ok).toBe(true);
  }, 60_000);
});
