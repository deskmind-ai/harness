/**
 * The machine lock (src/session/computer.ts, docs/protocol.md 「电脑锁」): the holder is a process group recorded in
 * the file; one guarded step checks, ends a lingering holder and writes the new one; task_done → lingering; undo only
 * for its own lingering run; the lock outlives its owner while any process of the group lives. Real processes, no
 * model.
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { acquire, computerLockFile, free, held, linger, ORPHAN_S, readHolder, startOf, undo, type Holder } from "../src/session/computer.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dm-lock-"));
const kids: ChildProcess[] = [];
afterEach(() => { for (const k of kids.splice(0)) { try { process.kill(-k.pid!, "SIGKILL"); } catch { /* gone */ } } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (f: () => unknown, ms = 5000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error("timed out"); await sleep(10); } };

/** A stand-in executor: its own process group; `script` is the shell it runs. */
function group(script = "sleep 30"): ChildProcess {
  const p = spawn("/bin/sh", ["-c", script], { stdio: "ignore", detached: true });
  kids.push(p);
  return p;
}
const holderOf = (r: ReturnType<typeof acquire>): Holder => { if (!("ok" in r) || !r.holder) throw new Error("not taken"); return r.holder; };
const who = (run: string) => ({ run_id: run, session_id: "ses_t", by: "session" });
const gone = (p: ChildProcess) => new Promise<void>((r) => { if (p.exitCode !== null || p.signalCode !== null) r(); else p.on("exit", () => r()); });

describe("the machine lock", () => {
  it("acquire: writes the holder (its group, acting) before the caller sends the task; a holder acting refuses the next", () => {
    const dir = tmp();
    let p!: ChildProcess;
    const a = acquire(dir, who("run_a"), () => { p = group(); return { pid: p.pid }; });
    expect("ok" in a && a.holder).toMatchObject({ v: 2, state: "acting", pgid: p.pid, pid: p.pid, run_id: "run_a", owner: process.pid });
    expect(readHolder(dir)!.start).toBe(startOf(p.pid!));
    let spawned = false;
    const b = acquire(dir, who("run_b"), () => { spawned = true; return { pid: 1 }; });
    expect("busy" in b && b.busy.run_id).toBe("run_a");
    expect(spawned).toBe(false);                       // nothing started under a holder that acts
  });

  it("acquire: a lingering holder is ended (its undo expires) — a group deaf to SIGTERM by SIGKILL — and the lock is the new task's", async () => {
    const dir = tmp();
    const deaf = group("trap '' TERM; while :; do sleep 0.1; done");
    const a = acquire(dir, who("run_a"), () => ({ pid: deaf.pid }));
    expect(linger(dir, holderOf(a))).toMatchObject({ state: "lingering", gen: 2 });
    let p!: ChildProcess;
    const b = acquire(dir, who("run_b"), () => { p = group(); return { pid: p.pid }; }, { termMs: 300, killMs: 2000 });
    expect("ok" in b).toBe(true);
    await gone(deaf);
    expect(readHolder(dir)).toMatchObject({ run_id: "run_b", state: "acting", pgid: p.pid });
  });

  it("held: while any process of its group lives — the executor gone, its child not — and not once the group is gone", async () => {
    const dir = tmp();
    // the leader starts a child in its group and exits
    const p = group("sleep 30 & exit 0");
    acquire(dir, who("run_a"), () => ({ pid: p.pid }));
    await gone(p);
    const h = readHolder(dir)!;
    expect(held(h)).toBe(true);
    free(dir, "run_a", p.pid!);                        // its owner saw the executor exit: the child keeps the lock
    expect(readHolder(dir)).toMatchObject({ run_id: "run_a", state: "acting" });
    expect("busy" in acquire(dir, who("run_b"), () => ({ pid: 1 }))).toBe(true);
    process.kill(-p.pid!, "SIGKILL");
    await waitFor(() => !held(h));
    free(dir, "run_a", p.pid!);
    expect(fs.existsSync(computerLockFile(dir))).toBe(false);
  });

  it("held: the owner gone (a helper killed, a session process gone) does not free it; a reused group id with another start time does", () => {
    const p = group();
    const h: Holder = { v: 2, state: "acting", pgid: p.pid!, pid: p.pid!, start: startOf(p.pid!)!, run_id: "r", session_id: "", by: "helper", owner: 999_999, t: 0 };
    expect(held(h)).toBe(true);
    expect(held({ ...h, start: h.start - 3600 })).toBe(false);
    expect(held({ ...h, pgid: 999_999, pid: 999_999 })).toBe(false);
  });

  it("start time: the same seconds whatever this process's time zone (the helper reads the kernel's)", async () => {
    const p = group();
    const here = startOf(p.pid!);
    const there = await new Promise<string>((r) => {
      const c = spawn(process.execPath, ["--import", "tsx", "-e", `import { startOf } from ${JSON.stringify(path.resolve("src/session/computer.ts"))}; console.log(startOf(${p.pid}))`],
        { env: { ...process.env, TZ: "America/New_York" }, stdio: ["ignore", "pipe", "inherit"] });
      let s = ""; c.stdout!.on("data", (d) => (s += d)); c.on("exit", () => r(s.trim()));
    });
    expect(here).not.toBeNull();
    expect(Number(there)).toBe(here);
    expect(Math.abs(here! - Date.now() / 1000)).toBeLessThan(10);
  });

  it("an orphaned acting holder (its owner and leader gone, a child of its group up) is refused for ORPHAN_S, then ended by the next task", async () => {
    const dir = tmp();
    const p = group("sleep 30 & exit 0");
    await gone(p);
    // as a killed helper left it: acting, its owner gone
    fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
    const h: Holder = { v: 2, state: "acting", pgid: p.pid!, pid: p.pid!, start: 0, run_id: "run_o", session_id: "", by: "helper", owner: 999_999, t: 0 };
    fs.writeFileSync(computerLockFile(dir), JSON.stringify(h));
    const t0 = Date.now() / 1000;
    expect("busy" in acquire(dir, who("run_b"), () => ({ pid: 1 }), { now: t0 })).toBe(true);
    expect(readHolder(dir)!.orphan_since).toBe(t0);
    expect("busy" in acquire(dir, who("run_b"), () => ({ pid: 1 }), { now: t0 + ORPHAN_S - 1 })).toBe(true);
    let q!: ChildProcess;
    const r = acquire(dir, who("run_b"), () => { q = group(); return { pid: q.pid }; }, { now: t0 + ORPHAN_S, termMs: 500, killMs: 1000 });
    expect("ok" in r).toBe(true);
    expect(held(h)).toBe(false);
    expect(readHolder(dir)!.run_id).toBe("run_b");
    // a live owner's acting run is never orphaned, even with its leader gone and a child of its group up
    const p2 = group("sleep 30 & exit 0");
    await gone(p2);
    fs.writeFileSync(computerLockFile(dir), JSON.stringify({ ...h, run_id: "run_live", pgid: p2.pid!, pid: p2.pid!, owner: process.pid }));
    expect("busy" in acquire(dir, who("run_c"), () => ({ pid: 1 }), { now: t0 })).toBe(true);
    expect(readHolder(dir)!.orphan_since).toBeUndefined();
    expect("busy" in acquire(dir, who("run_c"), () => ({ pid: 1 }), { now: t0 + 999 })).toBe(true);
    // a versioned lock it cannot use is no lock (as the helper reads it), not the old format
    fs.writeFileSync(computerLockFile(dir), JSON.stringify({ v: 3, pid: process.pid }));
    expect(readHolder(dir)).toBeNull();
  });

  it("undo: only from its own lingering holder, exactly as last written (then acting until its result_response); another's or a run gone: expired", () => {
    const dir = tmp();
    const p = group();
    const a = acquire(dir, who("run_a"), () => ({ pid: p.pid }));
    const h1 = holderOf(a);
    expect(h1.gen).toBe(1);
    expect(undo(dir, h1)).toBe("busy");                // still acting: no undo before its task_done
    const h2 = linger(dir, h1)!;
    expect(h2).toMatchObject({ state: "lingering", gen: 2 });
    expect(linger(dir, h1)).toBeNull();                // a second change from the same old holder: refused
    expect(undo(dir, { ...h2, run_id: "run_x" })).toBe("expired");
    const u = undo(dir, h2);
    expect(u).toMatchObject({ ok: { state: "acting", gen: 3 } });
    expect(undo(dir, h2)).toBe("busy");
    // the exact race of a cleanup after the executor exits: a writer still holding the acquired (h1) or task_done (h2)
    // holder cannot write lingering over the undo that acts now
    expect(linger(dir, h1)).toBeNull();
    expect(linger(dir, h2)).toBeNull();
    expect(readHolder(dir)).toMatchObject({ state: "acting", gen: 3 });
    expect(linger(dir, (u as { ok: Holder }).ok)).toMatchObject({ state: "lingering", gen: 4 });   // its result_response
  });

  it("two acquires at once from two processes (forced interleaving inside the guard): one takes the lock, the other is busy, and nothing it started is ended", async () => {
    const dir = tmp();
    const child = (run: string, holdMs: number) => spawn(process.execPath, ["--import", "tsx", "-e", `
      import { acquire } from ${JSON.stringify(path.resolve("src/session/computer.ts"))};
      import { spawn } from "node:child_process";
      const r = acquire(${JSON.stringify(dir)}, { run_id: ${JSON.stringify(run)}, session_id: "", by: "test" }, () => {
        const p = spawn("/bin/sh", ["-c", "sleep 30"], { stdio: "ignore", detached: true });
        p.unref();
        const until = Date.now() + ${holdMs}; while (Date.now() < until) {}   // still inside the guard
        return { pid: p.pid };
      });
      console.log(JSON.stringify("ok" in r ? { ok: r.holder.pgid } : { busy: true }));
    `], { stdio: ["ignore", "pipe", "inherit"] });
    const out = (p: ChildProcess) => new Promise<any>((r) => { let s = ""; p.stdout!.on("data", (d) => (s += d)); p.on("exit", () => r(JSON.parse(s.trim().split("\n").pop()!))); });
    const a = child("run_a", 800);
    await sleep(400);                                   // A is inside the guard, its executor started, not yet written
    const b = child("run_b", 0);
    const [ra, rb] = await Promise.all([out(a), out(b)]);
    expect(ra.ok).toBeGreaterThan(0);
    expect(rb).toEqual({ busy: true });
    expect(held(readHolder(dir)!)).toBe(true);          // A's executor was not ended by B
    expect(readHolder(dir)!.run_id).toBe("run_a");
    process.kill(-ra.ok, "SIGKILL");
  });
});
