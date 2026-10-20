/**
 * The real Mac through hands: `deskmind_hands.executor` (a JSON-lines process over Peekaboo) is the raw driver.
 * It sees and moves; the guard, ownership and consent stay here in the Executor. The process is started with
 * `DESKMIND_HANDS_CMD` (a shell command) or, in development, `uv run --extra macos python -m deskmind_hands.executor`
 * in the hands checkout next to this repository (`DESKMIND_HANDS_DIR`).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { Action, Driver, Observation, PerformResult, Snapshot } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_HANDS_DIR = path.resolve(here, "..", "..", "..", "hands");

export class HandsDriver implements Driver {
  /** hands#48: a url is loaded in DeskMind's own browser window (one it opens if the task has none); the user's
   *  windows are never navigated, and a browser that cannot give it a window of its own stops the step instead. */
  readonly capabilities = { urlInOwnWindow: true };
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private n = 0;
  private buf = "";
  readonly log: string[] = [];

  constructor(private readonly opts: { cmd?: string; dir?: string; scratch?: string; workspace?: string; timeoutMs?: number } = {}) {}

  private start() {
    if (this.proc) return;
    const cmd = this.opts.cmd ?? process.env.DESKMIND_HANDS_CMD ?? `uv run --extra macos python -m deskmind_hands.executor`;
    const dir = this.opts.dir ?? process.env.DESKMIND_HANDS_DIR ?? DEFAULT_HANDS_DIR;
    this.proc = spawn("/bin/sh", ["-c", cmd], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } });
    this.proc.stdout.setEncoding("utf-8");
    this.proc.stdout.on("data", (chunk: string) => {
      this.buf += chunk;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        let msg: { id: number; ok: boolean; result?: unknown; error?: string };
        try { msg = JSON.parse(line); } catch { this.log.push("unreadable: " + line.slice(0, 200)); continue; }
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error ?? "hands: error"));
      }
    });
    this.proc.stderr.setEncoding("utf-8");
    this.proc.stderr.on("data", (c: string) => { this.log.push(c.trim().slice(0, 500)); });
    const fail = (why: string) => { for (const p of this.pending.values()) p.reject(new Error(why)); this.pending.clear(); };
    this.proc.on("exit", (code) => { fail(`hands executor exited (${code})`); this.proc = null; });
    // a wedged or dead child closes its pipes: every waiting call learns at once, and nothing is thrown at the process
    this.proc.on("error", (e) => fail(`hands executor: ${e.message}`));
    this.proc.stdin.on("error", (e) => { fail(`hands executor stdin: ${e.message}`); this.proc?.kill(); this.proc = null; });
  }

  private call<T>(op: string, body: Record<string, unknown> = {}): Promise<T> {
    this.start();
    const id = ++this.n;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`hands ${op}: no answer in ${this.opts.timeoutMs ?? 120_000} ms`)); }, this.opts.timeoutMs ?? 120_000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v as T); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      try { this.proc!.stdin.write(JSON.stringify({ id, op, ...body }) + "\n"); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  private begun = false;
  async begin(): Promise<Snapshot> { this.begun = true; return this.call<Snapshot>("begin", { ...(this.opts.scratch ? { scratch: this.opts.scratch } : {}), ...(this.opts.workspace ? { workspace: this.opts.workspace } : {}) }); }
  async snapshot(): Promise<Snapshot> { if (!this.begun) return this.begin(); return this.call<Snapshot>("snapshot"); }
  async observe(windowId: string, o?: { screenshot?: boolean }): Promise<Observation> { if (!this.begun) await this.begin(); return this.call<Observation>("observe", { window: windowId, screenshot: !!o?.screenshot }); }
  /** `foreground_ok` goes inside the action dict, as hands#54 reads it: that app may use the foreground route for this one
   *  step (the search box's Return path included). Set by the executor only; the model never sees it. */
  async perform(action: Action, opts?: { foreground_ok?: boolean }): Promise<PerformResult> { if (!this.begun) await this.begin(); return this.call<PerformResult>("perform", { action: opts?.foreground_ok ? { ...action, foreground_ok: true } : action }); }
  /** Close the executor process. `end` is tidying only, so it is never waited for behind a request still running:
   *  the process answers one request at a time, and an `end` queued after a look the task stopped waiting for took
   *  that look's whole timeout (review of harness #24). With a request in flight the process is killed at once (the
   *  request fails with the exit); otherwise `end` gets a few seconds, then the process is killed all the same. */
  async end(): Promise<void> {
    if (!this.proc) return;
    if (this.pending.size === 0) {
      let timer: NodeJS.Timeout | undefined;
      const done = this.call("end").catch(() => undefined);
      await Promise.race([done, new Promise((r) => { timer = setTimeout(r, 5_000); })]);
      clearTimeout(timer);
    }
    this.proc?.kill(); this.proc = null;
  }
}
