/**
 * The machine lock (docs/protocol.md 「电脑锁」): one computer task at a time on this Mac, whoever starts it — a chat
 * session (this file's caller, session/host.ts) or the DeskMind helper (its Swift copy of this protocol, ComputerLock).
 *
 * Two files under `<dir>/sessions/`:
 * - `computer.guard`: empty; an exclusive flock on it is held around every read-modify-write of the lock (here: open
 *   with O_EXLOCK, macOS). Nothing between a check and the write it decides can interleave, across processes.
 * - `computer.lock`: the holder, JSON, replaced whole (a file of our own renamed over it):
 *   `{v: 2, state: "acting" | "lingering", pgid, pid, start, run_id, session_id, by, owner, t}`.
 *
 * The holder is the process tree that can act: the executor, started as the leader of its own process group, and
 * everything under it. The lock is held while any process of that group lives (kill(-pgid, 0)) — whether or not the
 * process that started it (`owner`: a session, the helper) still does — unless the group's id now names another
 * group (its leader's pid alive with another start time than `start`). It is written before the executor is sent its
 * task (it waits for its request on stdin), so nothing acts unrecorded.
 *
 * `acting` until its task_done, `lingering` from then (written before task_done is passed on: its result card can be
 * answered at once). A new task finds `acting`: busy. It finds `lingering`: that run's undo expires (owner 10-21) — its
 * group is ended (SIGTERM, then SIGKILL) and the lock is the new task's; a group that does not end refuses the task
 * (`alive`). An undo is let through only to the lingering run itself, which is `acting` again until its
 * result_response. A holder whose group is gone holds nothing: whoever comes next takes the lock over, and its owner
 * removes it when it sees its executor gone (`free`).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { alive } from "./task.js";

export interface Holder {
  v: 2;
  state: "acting" | "lingering";
  /** The executor's process group (it leads it: pgid = its pid). 0: an executor inside the owner's own process
   *  (tests), held while the owner lives. */
  pgid: number;
  pid: number;
  /** The leader's start time, seconds since 1970 (0: unknown). */
  start: number;
  run_id: string;
  session_id: string;
  by: string;
  /** The process that started it (a session, the helper). */
  owner: number;
  t: number;
  /** When a task first found it orphaned (acting, its owner and its leader gone, something of its group still up),
   *  seconds since 1970: `ORPHAN_S` later the next task ends it. */
  orphan_since?: number;
  /** Bumped on every change of state (acting → lingering at task_done, → acting for an undo, back at its
   *  result_response): a writer changes the lock only from the exact holder and generation it saw (compare-and-set).
   *  1 when a task takes the lock; absent (0) in a lock of an earlier build. */
  gen?: number;
}

/** How long an orphaned acting holder keeps the Mac before the next task ends it (as long as a stop is waited for). */
export const ORPHAN_S = 12;

export const computerLockFile = (dir: string) => path.join(dir, "sessions", "computer.lock");
export const computerGuardFile = (dir: string) => path.join(dir, "sessions", "computer.guard");

/** macOS open(2): take an exclusive flock as the file opens (waits for it). */
const O_EXLOCK = 0x20;

/** `f` ran to its end — whatever it changed in the lock stands — but closing the guard then failed: `result` is what
 *  `f` returned. Thrown by guarded so that its caller knows the change landed (and never takes it for one that did
 *  not: a lock left saying something nobody accounts for). */
export class GuardClosed<T = unknown> extends Error {
  constructor(readonly result: T, cause: unknown) { super(`closing the computer lock's guard failed after the change was made: ${cause instanceof Error ? cause.message : String(cause)}`); }
}

/** `f` with the guard's flock held. `f` throwing: its error (closing the guard is tried, its error dropped). `f`
 *  returning and the guard's close failing: GuardClosed with `f`'s result. */
export function guarded<T>(dir: string, f: () => T): T {
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true, mode: 0o700 });
  const flags = fs.constants.O_RDWR | fs.constants.O_CREAT | (process.platform === "darwin" ? O_EXLOCK : 0);
  const fd = fs.openSync(computerGuardFile(dir), flags, 0o600);
  let r: T;
  try { r = f(); } catch (e) { try { fs.closeSync(fd); } catch { /* f's error is the one */ } throw e; }
  try { fs.closeSync(fd); } catch (e) { throw new GuardClosed(r, e); }
  return r;
}

/** A guarded change's outcome as it landed: its result, also when only closing the guard failed afterwards (logged).
 *  Any other error is thrown as it is (the change did not land). */
export function landed<T>(f: () => T): T {
  try { return f(); }
  catch (e) { if (!(e instanceof GuardClosed)) throw e; process.stderr.write(`computer lock: ${e.message}\n`); return e.result as T; }
}

/** Some process of group `pgid` lives — a zombie does not count (it can act no more; this process may not have reaped
 *  its own child yet while it waits here). */
function groupAlive(pgid: number): boolean {
  if (!(pgid > 1)) return false;
  try { process.kill(-pgid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EPERM") return false; }
  try {
    const rows = execFileSync("/bin/ps", ["-A", "-o", "pgid=,stat="], { env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 });
    return rows.split("\n").some((r) => { const [g, st] = r.trim().split(/\s+/); return Number(g) === pgid && !!st && !st.startsWith("Z"); });
  } catch { return true; }                              // cannot tell: held
}

/** A process's start time, seconds since 1970, or null (gone, or unreadable). */
export function startOf(pid: number): number | null {
  if (!(pid > 0)) return null;
  try {
    // in UTC, read as UTC: the same seconds the helper reads from the kernel, whatever this process's time zone
    const t = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], { env: { LC_ALL: "C", TZ: "UTC0", PATH: "/usr/bin:/bin" }, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"], timeout: 2000 }).trim();
    if (!t) return null;
    const ms = Date.parse(`${t} GMT`);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  } catch { return null; }
}

export function readHolder(dir: string): Holder | null {
  let t: string;
  try { t = fs.readFileSync(computerLockFile(dir), "utf-8"); } catch { return null; }
  try {
    const j = JSON.parse(t);
    if (j && j.v !== undefined) {
      // a versioned lock: this version with its fields, or no lock (as the helper reads it)
      if (j.v !== 2 || (j.state !== "acting" && j.state !== "lingering") || !Number.isInteger(j.pgid) || !Number.isInteger(j.owner)) return null;
      if (j.orphan_since !== undefined && typeof j.orphan_since !== "number") delete j.orphan_since;
      return j as Holder;
    }
    // an earlier format ({pid, executor_pid}): held while one of them lives, as acting
    if (j && typeof j.pid === "number") {
      const p = [j.pid, j.executor_pid].find((x) => typeof x === "number" && alive(x));
      return { v: 2, state: "acting", pgid: 0, pid: 0, start: 0, run_id: String(j.run_id ?? ""), session_id: String(j.session_id ?? ""), by: "old", owner: p ?? 0, t: 0 };
    }
  } catch { /* not a lock */ }
  return null;
}

/** Whether the holder's tree may still act (see the top). */
export function held(h: Holder): boolean {
  if (h.pgid === 0) return alive(h.owner);
  if (!groupAlive(h.pgid)) return false;
  if (alive(h.pid) && h.start > 0) {
    const s = startOf(h.pid);
    if (s !== null && Math.abs(s - h.start) > 1) return false;   // the id is another group's now
  }
  return true;
}

function write(dir: string, h: Holder) {
  const file = computerLockFile(dir);
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}`;
  try { fs.writeFileSync(tmp, JSON.stringify(h), { mode: 0o600 }); fs.renameSync(tmp, file); }
  catch (e) { try { fs.unlinkSync(tmp); } catch { /* never written */ } throw e; }
}

const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function waitGone(h: Holder, ms: number): boolean {
  const until = Date.now() + ms;
  while (held(h)) { if (Date.now() >= until) return false; nap(20); }
  return true;
}

/** Executors inside this process (tests: no process of their own): how to let one go. */
export const inProcess = new Map<string, () => void>();

/** End a lingering holder's tree: SIGTERM to its group, then SIGKILL. True once it is gone. */
export function endTree(h: Holder, o: { termMs?: number; killMs?: number } = {}): boolean {
  if (h.pgid === 0) { const close = inProcess.get(h.run_id); close?.(); return !!close || !held(h); }
  try { process.kill(-h.pgid, "SIGTERM"); } catch { /* gone */ }
  if (waitGone(h, o.termMs ?? 1500)) return true;
  try { process.kill(-h.pgid, "SIGKILL"); } catch { /* gone */ }
  return waitGone(h, o.killMs ?? 1000);
}

export type Acquired = { ok: true; holder: Holder | null } | { busy: Holder } | { alive: Holder };

/** Take the machine for a new task: in one guarded step, a holder acting refuses (`busy`), a lingering one is ended
 *  (`alive` when it will not end), then `spawn` starts the executor (in its own group; nil pid: in this process) and
 *  the lock names it, acting. `spawn` returning null (it could not start) writes nothing. The caller sends the
 *  executor its task only after this returns. */
export function acquire(dir: string, who: { run_id: string; session_id: string; by: string },
  spawn: () => { pid?: number } | null, o: { termMs?: number; killMs?: number; now?: number } = {}): Acquired {
  return guarded(dir, () => {
    const h = readHolder(dir);
    if (h && held(h)) {
      if (h.state === "acting") {
        // orphaned (its owner and its leader gone, a process of its group still up): refused for ORPHAN_S, then ended
        if (!(h.pgid > 0 && !alive(h.owner) && startOf(h.pid) === null)) return { busy: h };
        const now = o.now ?? Date.now() / 1000;
        if (h.orphan_since === undefined) { write(dir, { ...h, orphan_since: now }); return { busy: h }; }
        if (now - h.orphan_since < ORPHAN_S) return { busy: h };
      }
      if (!endTree(h, o)) return { alive: h };
    }
    const r = spawn();
    if (!r) return { ok: true, holder: null };
    const pgid = r.pid ?? 0;
    const holder: Holder = { v: 2, state: "acting", pgid, pid: pgid, start: pgid ? startOf(pgid) ?? 0 : 0, ...who, owner: process.pid, t: Date.now() / 1000, gen: 1 };
    try { write(dir, holder); } catch (e) {
      // not recorded: the executor never gets its task (the caller sees the error); its group is ended at once
      if (pgid > 0) { try { process.kill(-pgid, "SIGKILL"); } catch { /* gone */ } }
      throw e;
    }
    return { ok: true, holder };
  });
}

const mine = (h: Holder | null, run: string, pgid: number): h is Holder => !!h && h.run_id === run && h.pgid === pgid;

const same = (h: Holder | null, from: Holder): h is Holder => mine(h, from.run_id, from.pgid) && h.state === from.state && (h.gen ?? 0) === (from.gen ?? 0);

/** Its task_done (or an undo's result_response): the run no longer acts, its result card may be answered (and a new
 *  task may end it). Only from the acting holder `from` its writer last saw — compare-and-set: a lock changed since (an
 *  undo, a new task) is not written over. The new holder, or null. */
export function linger(dir: string, from: Holder): Holder | null {
  if (from.state !== "acting") return null;
  return guarded(dir, () => {
    const h = readHolder(dir);
    if (!same(h, from)) return null;
    const next: Holder = { ...h, state: "lingering", gen: (h.gen ?? 0) + 1, t: Date.now() / 1000 };
    write(dir, next);
    return next;
  });
}

/** An undo: only while the lock is still exactly the lingering holder `from`; it acts again (the next generation).
 *  `expired`: another task has started since (or its tree is gone); `busy`: the lock changed under it otherwise (an
 *  answer of it is being carried out). */
export function undo(dir: string, from: Holder): { ok: Holder } | "busy" | "expired" {
  return guarded(dir, () => {
    const h = readHolder(dir);
    if (!mine(h, from.run_id, from.pgid) || !held(h)) return "expired";
    if (h.state === "acting" || (h.gen ?? 0) !== (from.gen ?? 0)) return "busy";
    const next: Holder = { ...h, state: "acting", gen: (h.gen ?? 0) + 1, t: Date.now() / 1000 };
    write(dir, next);
    return { ok: next };
  });
}

/** A start that failed after `acquire` named its run (its executor never got its task: it has done nothing): its
 *  group is ended at once (SIGKILL) and the lock removed — only while the lock is still exactly `from`, the holder that
 *  start wrote (its run, group, state and generation: compare-and-set); a lock changed since is left as it is. A group
 *  that does not end keeps the lock, acting (reapLater and the next task end it). Never throws; true once the lock no
 *  longer names it. */
export function release(dir: string, from: Holder, o: { killMs?: number } = {}): boolean {
  try {
    return guarded(dir, () => {
      const h = readHolder(dir);
      if (!same(h, from)) return !mine(h, from.run_id, from.pgid);
      if (h.pgid > 0) {
        try { process.kill(-h.pgid, "SIGKILL"); } catch { /* gone */ }
        if (!waitGone(h, o.killMs ?? 1000)) return false;
      }
      fs.unlinkSync(computerLockFile(dir));
      return true;
    });
  } catch (e) {
    if (e instanceof GuardClosed) return e.result as boolean;   // done; only closing the guard failed
    // the guard or the file could not be used: the group is ended all the same (the lock then names a group that is
    // gone, which holds nothing: the next task takes it over)
    if (from.pgid > 0) { try { process.kill(-from.pgid, "SIGKILL"); } catch { /* gone */ } }
    process.stderr.write(`computer lock: ${e instanceof Error ? e.message : String(e)}\n`);
    return false;
  }
}

/** Its executor has exited: the lock is removed if it still names that run and nothing of its group is left (a
 *  child still up keeps it, in the state it had). */
export function free(dir: string, run: string, pgid: number): void {
  guarded(dir, () => {
    const h = readHolder(dir);
    if (mine(h, run, pgid) && (pgid === 0 || !held(h))) { try { fs.unlinkSync(computerLockFile(dir)); } catch { /* gone */ } }
  });
}

/** Its executor has exited while the lock still says it acts (no task_done; or it died during an undo): what is left of
 *  its group is given `ms` to end by itself, then ended — it must not hold the Mac for good. A lingering leftover needs
 *  nothing: the next task ends it. Never throws (a timer). */
export function reapLater(dir: string, run: string, pgid: number, ms: number): void {
  if (!(pgid > 0)) return;
  const t = setTimeout(() => {
    try {
      const h = guarded(dir, () => { const x = readHolder(dir); return mine(x, run, pgid) && x.state === "acting" && held(x) ? x : null; });
      if (!h) return;
      endTree(h, { termMs: 2000, killMs: 2000 });
      free(dir, run, pgid);
    } catch (e) { process.stderr.write(`computer lock: ${e instanceof Error ? e.message : String(e)}\n`); }
  }, ms);
  t.unref?.();
}
