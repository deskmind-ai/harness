/**
 * A hands request never outlives this side's deadline, and a step this side gave up on is never an error (rc.14,
 * 10-23: 「打开网易云播放安溥的宝贝」 while a script pressed Shift in another app every second). hands waited for a still
 * Mac before filling NetEase's search box; this side stopped waiting at 120 s and recorded the step as an error, the
 * box was filled and Return pressed 18 s later, and that late answer was dropped.
 *
 * Over the real HandsDriver and a stand-in executor process that, like hands, answers one request at a time and
 * speaks its protocol: replies by id, and event lines (`{"event", "req"}`) while it waits for the user. Each test fails
 * on harness main: no deadline sent, a timeout recorded as an error, user_busy unknown (an error), the pause never
 * shown, the late answer dropped.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { HandsDriver } from "../src/executor/hands.js";

// MODE: slow — the perform answers `ok` after SLOW_MS (past this side's timeout); busy — it waits for the user
// (user_wait, user_resumed) and answers user_busy, nothing done; die — it waits for the user, then the process exits;
// crash — the process exits while the step is out, not in a wait (it may have acted)
const CHILD = `
const fs = require("node:fs"); const rl = require("node:readline").createInterface({ input: process.stdin });
const w = { id: "w", app: "网易云音乐", title: "网易云音乐" };
const out = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const queue = []; let busy = false;
const next = () => { if (busy || !queue.length) return; busy = true; const m = queue.shift(); handle(m, () => { busy = false; next(); }); };
const handle = (m, done) => {
  fs.appendFileSync(process.env.SEEN, JSON.stringify({ ...m, at: Date.now() }) + "\\n");
  // the window comes after begin: the task's own (a window there at begin is the user's)
  if (m.op === "begin" || m.op === "snapshot") { out({ id: m.id, ok: true, result: { epoch: 1, locked: false, front_app: "iTerm2", windows: m.op === "begin" ? [] : [w] } }); return done(); }
  if (m.op === "observe") { out({ id: m.id, ok: true, result: { epoch: 1, window: w, modal: null, elements: [{ id: "f", role: "textField", label: "搜索框", actions: ["click", "set_value"], value: "" }] } }); return done(); }
  if (m.op === "perform") {
    const mode = process.env.MODE;
    if (mode === "crash") return setTimeout(() => process.exit(3), 100);
    if (mode === "hang") return;                                   // never answers, and takes nothing else meanwhile
    // acting when it died: its wait said over, written the instant before the exit
    // (written synchronously, as hands' flushed writes are: Node's own stdout to a pipe is asynchronous on macOS, and an
    // exit would drop it)
    if (mode === "actdie") return setTimeout(() => { const put = (x) => { const b = Buffer.from(JSON.stringify(x) + "\\n"); let o = 0; while (o < b.length) { try { o += fs.writeSync(1, b, o); } catch (e) { if (e.code !== "EAGAIN") throw e; } } }; put({ event: "user_wait", req: m.id, reason: "user_active", app: "com.netease.163music", what: "type" }); setTimeout(() => { put({ event: "user_resumed", req: m.id, waited_s: 0.1 }); process.exit(3); }, 100); }, 50);
    if (mode === "slow") return setTimeout(() => { out({ id: m.id, ok: true, result: { status: "ok", why: "entered '安溥 宝贝' into '搜索框' and pressed Return", window: "w" } }); done(); }, Number(process.env.SLOW_MS));
    out({ event: "user_wait", req: m.id, reason: "user_active", app: "com.netease.163music", what: "type" });
    if (mode === "die") return setTimeout(() => process.exit(3), 150);
    return setTimeout(() => { out({ event: "user_resumed", req: m.id, waited_s: 0.1 }); out({ id: m.id, ok: true, result: { status: "user_busy", performed: false, why: "the user is active; the step was not carried out before the caller's deadline -- nothing was done; wait", window: "w" } }); done(); }, 100);
  }
  out({ id: m.id, ok: true, result: {} }); done();
};
rl.on("line", (l) => { queue.push(JSON.parse(l)); next(); });
`;

function rig(mode: "slow" | "busy" | "die" | "crash" | "actdie" | "hang", timeoutMs: number) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hands-deadline-")), seen = path.join(dir, "seen.jsonl");
  fs.writeFileSync(path.join(dir, "child.cjs"), CHILD);
  const driver = new HandsDriver({ cmd: `MODE=${mode} SLOW_MS=${timeoutMs * 2} SEEN=${seen} ${process.execPath} child.cjs`, dir, timeoutMs });
  const events: { k: string; [x: string]: unknown }[] = [];
  const app = ConsentSigner.fresh();
  const ex = new Executor(driver, { task: "t", publicKey: app.publicKey, onEvent: (k, b) => events.push({ k, ...b }) });
  const sent = () => fs.readFileSync(seen, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  return { driver, ex, events, sent };
}

/** begin, the start gate, the search box in a window the task owns (no consent card in the way), and the step. */
async function fill(ex: Executor) {
  await ex.begin(); await ex.plan({ steps: [] });
  ex.ledger.created("window:w");
  const o = await ex.observe("w");
  return ex.act({ action: { kind: "set_value", window: "w", target: "f", value: "安溥 宝贝" }, epoch: o.epoch });
}

const until = async (f: () => boolean, ms = 3000) => { for (let i = 0; i < ms / 20 && !f(); i++) await new Promise((r) => setTimeout(r, 20)); };

describe("hands requests and this side's deadline", () => {
  it("sends with each perform and observe the deadline it waits for: the same number as its timeout", async () => {
    const { driver, ex, sent } = rig("busy", 4_000);
    try {
      await fill(ex);
      const lines = sent();
      for (const m of lines.filter((x) => x.op === "perform" || x.op === "observe")) {
        expect(typeof m.deadline_ms).toBe("number");
        expect(Math.abs((m.deadline_ms as number) - 4_000 - (m.at as number))).toBeLessThan(1_000);   // sent ≈ now + timeoutMs
      }
      expect(lines.filter((x) => x.op === "perform" || x.op === "observe").length).toBeGreaterThanOrEqual(2);
      expect(lines.filter((x) => x.op === "snapshot" || x.op === "begin").every((x) => !("deadline_ms" in x))).toBe(true);
    } finally { await driver.end(); }
  });

  it("a step not answered in time is unverified (it may have taken effect later), never an error; the late answer is traced", async () => {
    const { driver, ex, events } = rig("slow", 400);
    try {
      const r = await fill(ex);
      expect(r.status).toBe("unverified");
      expect(r.why).toMatch(/no answer in 400 ms: the step may have taken effect after that; observe the window before doing it again/);
      await until(() => events.some((e) => e.k === "executor.late_reply"));
      const late = events.find((e) => e.k === "executor.late_reply")!;
      expect(late).toMatchObject({ op: "perform", ok: true, status: "ok" });
      expect(String(late.why)).toContain("安溥 宝贝");
      expect(driver.log.some((l) => l.startsWith("late answer to perform"))).toBe(true);
    } finally { await driver.end(); }
  });

  it("hands' user_busy ends the step blocked, nothing done, and its wait shows as the pause (user_wait, then user_resumed)", async () => {
    const { driver, ex, events } = rig("busy", 4_000);
    try {
      const r = await fill(ex);
      expect(r.status).toBe("blocked");
      expect(r.why).toMatch(/nothing was done; try again later/);
      const ks = events.map((e) => e.k);
      const wait = ks.indexOf("executor.user_wait"), resumed = ks.indexOf("executor.user_resumed"), act = ks.lastIndexOf("executor.act");
      expect(wait).toBeGreaterThanOrEqual(0);
      expect(wait < resumed && resumed < act).toBe(true);
      expect(events[wait]).toMatchObject({ by: "driver", app: "com.netease.163music", what: "type" });
      expect(ks.filter((k) => k === "executor.user_wait").length).toBe(ks.filter((k) => k === "executor.user_resumed").length);
    } finally { await driver.end(); }
  });

  it("the helper dying mid-wait still ends the pause, and the step is an error: it was only waiting, nothing was done", async () => {
    const { driver, ex, events } = rig("die", 4_000);
    try {
      const r = await fill(ex);
      expect(r.status).toBe("error");
      expect(r.why).toMatch(/exited/);
      const ks = events.map((e) => e.k);
      expect(ks.filter((k) => k === "executor.user_wait").length).toBe(1);
      expect(ks.filter((k) => k === "executor.user_resumed").length).toBe(1);
    } finally { await driver.end(); }
  });

  it("the helper dying while the step is out and not in a wait leaves the step unverified: it may have acted first", async () => {
    const { driver, ex } = rig("crash", 4_000);
    try {
      const r = await fill(ex);
      expect(r.status).toBe("unverified");
      expect(r.why).toMatch(/exited \(3\): the step may have taken effect before that; observe the window before doing it again/);
    } finally { await driver.end(); }
  });

  it("end() with a request out fails it at once, though a new process starts before the old one's close", async () => {
    const { driver } = rig("hang", 3_000);
    try {
      await driver.snapshot();
      const t0 = Date.now();
      const out = driver.perform({ kind: "wait", ms: 1 }).then(() => "answered", (e: Error) => e.message);
      await new Promise((r) => setTimeout(r, 50));
      await driver.end();
      await driver.snapshot();                                       // a new process, before the old one's close
      expect(await out).toMatch(/ended by the caller/);
      expect(Date.now() - t0).toBeLessThan(1_500);                   // not left to its 3 s timer
    } finally { await driver.end(); }
  });

  // a guard, not a reproduction: on this Mac node read the last lines before "exit" too, so it passes with "exit" as well
  it("the lines written just before the process died are read first: a wait it said was over is no wait, the step unverified", async () => {
    const { driver, ex, events } = rig("actdie", 4_000);
    try {
      const r = await fill(ex);
      expect([r.status, r.why]).toEqual(["unverified", expect.stringMatching(/exited \(3\)/)]);
      expect(events.filter((e) => e.k === "executor.user_resumed")).toHaveLength(1);
    } finally { await driver.end(); }
  });
});
