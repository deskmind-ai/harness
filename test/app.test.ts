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
import { LineReader, StdioUser, selftest, toProtocol } from "../src/cli/app.js";
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
    const p2 = u.ask({ kind: "missing", text: "写什么？", free_text: true, blocking: true, options: [] });
    input.write(JSON.stringify({ text: "买牛奶" }) + "\n");      // no ask_id: taken as the answer to the open card
    expect(await p2).toEqual({ text: "买牛奶" });
  });

  it("maps the runtime's events onto the protocol, and drops what the app does not need", () => {
    expect(toProtocol("tool.call", { name: "computer_act", args: { action: { kind: "click", window: "w" }, consequence: "create", purpose: "x" } })).toMatchObject({ kind: "step", consequence: "create", purpose: "x" });
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
