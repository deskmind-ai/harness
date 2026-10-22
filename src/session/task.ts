/**
 * Computer tasks in a chat session (H2, docs/protocol.md 「会话（第 1 版）」): the machine lock, the executor process a
 * task runs in, and one task's life as the session follows it.
 *
 * The machine lock (one computer task at a time on this Mac, whoever starts it) is session/computer.ts.
 *
 * The executor: `harness.mjs executor --linger <s> --runs <dir>/sessions/<sid>/runs` (cli/app.ts, unchanged), the
 * request on its stdin's first line, its events on its stdout, its stderr in the run folder's `executor.log`.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { selfCommand } from "../host/agent.js";

/** Is the process `pid` alive? (Ours counts: this process holds it.) */
export function alive(pid: number): boolean {
  if (!(pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}
const readFile = (file: string): string | null => { try { return fs.readFileSync(file, "utf-8").trim(); } catch { return null; } };

export type LinkLock = { ok: true; release: () => void; replace: (content: string) => void } | { ok: false; held: string };

/** A lock file created whole and at once: `content` is written to a file of our own, then hard-linked to the lock's
 *  name (link fails if the name exists), so no one ever reads an empty lock. A lock whose holder is gone (`live` says
 *  no) is taken over by renaming it aside first: only when the renamed file still holds what was read was it the stale
 *  lock; if a live holder's lock was caught instead, it is put back. `release` removes it while it is still ours;
 *  `replace` rewrites it (a file of our own renamed over it) while it is ours. */
export function linkLock(file: string, content: string, live: (held: string) => boolean): LinkLock {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let mine = content;
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  const ours = () => readFile(file) === mine.trim();
  try {
    for (let i = 0; i < 5; i++) {
      try {
        fs.linkSync(tmp, file);
        return {
          ok: true,
          release: () => { if (ours()) { try { fs.unlinkSync(file); } catch { /* gone already */ } } },
          replace: (next: string) => {
            if (!ours()) return;
            const t = `${file}.${process.pid}.${randomUUID().slice(0, 8)}`;
            try { fs.writeFileSync(t, next, { mode: 0o600 }); fs.renameSync(t, file); mine = next; } catch { try { fs.unlinkSync(t); } catch { /* never written */ } }
          },
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const held = readFile(file);
      if (held === null) continue;                                     // released meanwhile: try again
      if (live(held)) return { ok: false, held };
      const aside = `${file}.stale.${process.pid}.${randomUUID().slice(0, 8)}`;
      try { fs.renameSync(file, aside); } catch { continue; }           // someone else moved it: try again
      const moved = readFile(aside);
      if (moved === held) { try { fs.unlinkSync(aside); } catch { /* ours to remove */ } continue; }
      // we caught a lock taken after we looked: give it back (unless yet another one is there now) and step aside
      try { fs.linkSync(aside, file); } catch { /* another lock is in place */ }
      try { fs.unlinkSync(aside); } catch { /* ours to remove */ }
      return { ok: false, held: moved ?? "" };
    }
    return { ok: false, held: readFile(file) ?? "" };
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* gone already */ }
  }
}

// --- the executor process -------------------------------------------------------------------------------------------

/** One executor, however it runs: lines to its stdin, its stdout lines, its end. */
export interface ExecutorHandle {
  /** Its process, the leader of its own process group (none: it runs inside this process, tests). */
  pid?: number;
  /** Send it its task (the request line): only once the machine lock names it (computer.ts acquire). An executor in
   *  this process has its request already. */
  start?: () => void;
  write(line: string): void;
  /** End its stdin: an executor lingering for its result card exits; a running one lets go of an open card. */
  close(): void;
  onLine(cb: (line: string) => void): void;
  exited: Promise<{ code: number | null; signal: string | null }>;
}
export type Launcher = (request: Record<string, unknown>, o: { runs: string; runId: string; linger: number }) => ExecutorHandle;

/** The real one: this harness's `executor` as a child process, the leader of a process group of its own (what it
 *  starts is in it: the machine lock holds that group), its environment the session's (keys, hands). It waits for its
 *  request, sent by `start`. */
export const spawnExecutor: Launcher = (request, o) => {
  const dir = path.join(o.runs, o.runId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const err = fs.openSync(path.join(dir, "executor.log"), "a", 0o600);
  const [cmd, ...args] = selfCommand(["executor", "--linger", String(o.linger), "--runs", o.runs]);
  const p = spawn(cmd!, args, { stdio: ["pipe", "pipe", err], detached: true });
  fs.closeSync(err);
  // exited once its stdout is drained too ('close'): every line it wrote has been handed on before its exit is acted
  // on (an undo's result_response is never taken for missing). Its own children have pipes of their own, so 'close'
  // follows 'exit' at once; should anything still hold its stdout, 2 s after 'exit' counts all the same
  const exited = new Promise<{ code: number | null; signal: string | null }>((res) => {
    p.on("close", (code, signal) => res({ code, signal }));
    p.on("exit", (code, signal) => { setTimeout(() => res({ code, signal }), 2000).unref(); });
    p.on("error", (e) => res({ code: null, signal: `spawn: ${e.message}` }));
  });
  p.stdin!.on("error", () => { /* it went away: its exit says so */ });
  let cb: ((l: string) => void) | null = null;
  const early: string[] = [];
  readline.createInterface({ input: p.stdout!, terminal: false }).on("line", (l) => { if (cb) cb(l); else early.push(l); });
  return {
    pid: p.pid,
    start: () => { if (p.stdin!.writable) p.stdin!.write(JSON.stringify(request) + "\n"); },
    write: (l) => { if (p.stdin!.writable) p.stdin!.write(l + "\n"); },
    close: () => { try { p.stdin!.end(); } catch { /* gone */ } },
    onLine: (f) => { cb = f; for (const l of early.splice(0)) f(l); },
    exited,
  };
};

/** The user's words a task carries (request.raw): at most about this many characters. */
export const MAX_RAW = 4000;
const HEAD = 1500;
/** Not half a character at a cut. */
const clean = (s: string) => s.replace(/^[\uDC00-\uDFFF]/, "").replace(/[\uD800-\uDBFF]$/, "");

/** The user's messages since the last task (oldest first) as one request: the newest message whole and as many earlier
 *  ones as fit before it, the rest marked as left out; a newest message longer than the whole budget keeps its head
 *  (where an instruction usually is) and its tail, the middle marked as left out — never a cut that silently drops the
 *  instruction and leaves pasted text as "the user's words". */
export function cutRaw(messages: string[]): string {
  const msgs = messages.filter((m) => m.trim());
  const all = msgs.join("\n\n");
  if (all.length <= MAX_RAW || !msgs.length) return all;
  const last = msgs[msgs.length - 1]!;
  if (last.length > MAX_RAW) {
    const tail = MAX_RAW - HEAD;
    const marker = `\n…（中间省略 ${last.length - HEAD - tail} 字）…\n`;
    return (msgs.length > 1 ? `（更早的 ${msgs.length - 1} 条消息省略）\n\n` : "") + clean(last.slice(0, HEAD)) + marker + clean(last.slice(-tail));
  }
  const kept = [last];
  let room = MAX_RAW - last.length, i = msgs.length - 2;
  for (; i >= 0 && msgs[i]!.length + 2 <= room; i--) { kept.unshift(msgs[i]!); room -= msgs[i]!.length + 2; }
  return (i >= 0 ? `（更早的 ${i + 1} 条消息省略）\n\n` : "") + kept.join("\n\n");
}

/** How long a session waits for task_done after it stopped a task because the app went away. */
export const EXIT_WAIT_MS = 12_000;
/** The executor's linger: how long its result card (undo) can be answered. */
export const LINGER_S = 600;
