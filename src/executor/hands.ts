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
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private n = 0;
  private buf = "";
  readonly log: string[] = [];

  constructor(private readonly opts: { cmd?: string; dir?: string; scratch?: string; timeoutMs?: number } = {}) {}

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
    this.proc.on("exit", (code) => { for (const p of this.pending.values()) p.reject(new Error(`hands executor exited (${code})`)); this.pending.clear(); this.proc = null; });
  }

  private call<T>(op: string, body: Record<string, unknown> = {}): Promise<T> {
    this.start();
    const id = ++this.n;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`hands ${op}: no answer in ${this.opts.timeoutMs ?? 120_000} ms`)); }, this.opts.timeoutMs ?? 120_000);
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v as T); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      this.proc!.stdin.write(JSON.stringify({ id, op, ...body }) + "\n");
    });
  }

  private begun = false;
  async begin(): Promise<Snapshot> { this.begun = true; return this.call<Snapshot>("begin", { ...(this.opts.scratch ? { scratch: this.opts.scratch } : {}) }); }
  async snapshot(): Promise<Snapshot> { if (!this.begun) return this.begin(); return this.call<Snapshot>("snapshot"); }
  async observe(windowId: string, o?: { screenshot?: boolean }): Promise<Observation> { if (!this.begun) await this.begin(); return this.call<Observation>("observe", { window: windowId, screenshot: !!o?.screenshot }); }
  async perform(action: Action): Promise<PerformResult> { if (!this.begun) await this.begin(); return this.call<PerformResult>("perform", { action }); }
  async end(): Promise<void> { if (!this.proc) return; try { await this.call("end"); } catch { /* already gone */ } this.proc?.kill(); this.proc = null; }
}
