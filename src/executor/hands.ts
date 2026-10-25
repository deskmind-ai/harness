/**
 * The real Mac through hands: `deskmind_hands.executor` (a JSON-lines process over Peekaboo) is the raw driver.
 * It sees and moves; the guard, ownership and consent stay here in the Executor. The process is started with
 * `DESKMIND_HANDS_CMD` (a shell command) or, in development, `uv run --extra macos python -m deskmind_hands.executor`
 * in the hands checkout next to this repository (`DESKMIND_HANDS_DIR`).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { EffectUnknown, type Action, type Driver, type DriverEvent, type Observation, type PerformResult, type Snapshot } from "./types.js";

/** The requests sent with the caller's deadline (`deadline_ms`, Unix ms): hands never waits for the user, nor acts,
 *  past it, so its answer comes while this side still listens (rc.14: a step waited 138 s for a still Mac, this side
 *  gave up at 120 s, and the search box was filled after). A hands without it ignores the field. */
const DEADLINE_OPS = new Set(["perform", "observe"]);
/** At most this many requests given up on are remembered for their late answers. */
const LATE_KEPT = 32;

const here = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_HANDS_DIR = path.resolve(here, "..", "..", "..", "hands");

export class HandsDriver implements Driver {
  /** hands#48: in a web browser, a url is loaded in DeskMind's own browser window (one it opens if the task has none);
   *  the user's browser windows are never navigated, and a browser that cannot give it a window of its own stops the
   *  step instead. Other apps get the url from `open`, wherever they put it — not covered. */
  readonly capabilities = { urlInOwnBrowserWindow: true };
  private proc: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<number, { op: string; resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private n = 0;
  private buf = "";
  readonly log: string[] = [];
  private listeners: ((ev: DriverEvent) => void)[] = [];
  /** Requests whose timeout passed, by id: their answer, if it comes, is logged and told (late_reply), never dropped. */
  private late = new Map<number, { op: string; at: number }>();
  /** The request hands said is waiting for the user (its `user_wait` event), until it said it resumed or it ended. */
  private waiting: { id: number; op: string } | null = null;

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
        let msg: { id: number; ok: boolean; result?: unknown; error?: string; event?: unknown; req?: unknown; [k: string]: unknown };
        try { msg = JSON.parse(line); } catch { this.log.push("unreadable: " + line.slice(0, 200)); continue; }
        if (typeof msg.event === "string") { this.onEvent(msg); continue; }     // an event has no id: never an answer
        const p = this.pending.get(msg.id);
        if (!p) { this.onLate(msg); continue; }
        this.pending.delete(msg.id);
        msg.ok ? p.resolve(msg.result) : p.reject(new Error(msg.error ?? "hands: error"));
      }
    });
    this.proc.stderr.setEncoding("utf-8");
    this.proc.stderr.on("data", (c: string) => { this.log.push(c.trim().slice(0, 500)); });
    // on "close", not "exit": close comes after stdout has been read to its end, so the lines the process wrote just
    // before it died (a user_resumed, then acting) are taken in first — read after "exit", a death mid-action could
    // pass for a death mid-wait and be recorded an error (review of harness#66). Only while it is still this driver's
    // process: one let go of (end, a broken pipe) failed its requests then, and the pending ones now are a new one's
    const proc = this.proc;
    proc.on("close", (code) => { if (this.proc !== proc) return; this.failAll(`hands executor exited (${code})`, true); this.proc = null; });
    // a wedged or dead child closes its pipes: every waiting call learns at once, and nothing is thrown at the process
    proc.on("error", (e) => { if (this.proc === proc) this.failAll(`hands executor: ${e.message}`, false); });
    proc.stdin.on("error", (e) => { if (this.proc !== proc) return; this.failAll(`hands executor stdin: ${e.message}`, false); proc.kill(); this.proc = null; });
  }

  /** Every request out fails now (the process is gone, or let go of). `died`: it may have run them — a perform's
   *  effect is unknown, not failed, whatever it said before (a user_wait proves nothing: hands may wait for the user
   *  after it has typed — review of harness#66, Codex P2). Only an answer that says performed: false says nothing went,
   *  and a request that died has none. A spawn or pipe error: nothing was taken in. */
  private failAll(why: string, died: boolean) {
    this.endWait(null, "exit"); this.late.clear();
    const out = [...this.pending]; this.pending.clear();
    for (const [, p] of out) p.reject(died && p.op === "perform" ? new EffectUnknown(p.op, `${why}: the step may have taken effect before that`, false) : new Error(why));
  }

  /** Hear what hands says besides its answers: its waits for the user, and answers that came after their timeout. */
  listen(cb: (ev: DriverEvent) => void): void { this.listeners.push(cb); }
  private tell(ev: DriverEvent) { for (const l of this.listeners) { try { l(ev); } catch { /* a listener never breaks the pipe */ } } }

  /** hands' event lines (`{"event", "req", ...}`, no `id`): a wait for the user in the request `req`. Only for a
   *  request still waited for here — one given up on is no step of the run's any more, and is only logged. */
  private onEvent(m: Record<string, unknown>) {
    const id = typeof m.req === "number" ? m.req : null;
    const p = id !== null ? this.pending.get(id) : undefined;
    if (m.event === "user_wait") {
      if (!p || id === null) { this.log.push(`hands waits for the user in a request no longer waited for (${String(m.req)})`); return; }
      if (this.waiting?.id === id) return;
      this.endWait(null, "reply");                    // one request at a time: an earlier wait is over
      this.waiting = { id, op: p.op };
      // (hands#70: the wait's numbers, epoch seconds there, ms here like every time the app reads)
      const ms = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? Math.round(x * 1000) : undefined);
      const started = ms(m.started_at), gives = ms(m.gives_up_at);
      this.tell({ kind: "user_wait", op: p.op, ...(typeof m.app === "string" ? { app: m.app } : {}), ...(typeof m.what === "string" ? { what: m.what } : {}),
        ...(typeof m.quiet_s === "number" ? { quiet_s: m.quiet_s } : {}), ...(typeof m.needs_front === "boolean" ? { needs_front: m.needs_front } : {}),
        ...(started !== undefined ? { started_at: started } : {}), ...(gives !== undefined ? { gives_up_at: gives } : {}) });
    } else if (m.event === "user_resumed") {
      if (id !== null && this.waiting?.id === id) {
        this.waiting = null;
        this.tell({ kind: "user_resumed", op: p?.op ?? "", ...(typeof m.waited_s === "number" ? { waited_s: m.waited_s } : {}), ended: "driver",
          ...(m.why === "" || m.why === "stopped" || m.why === "timed_out" || m.why === "failed" ? { why: m.why } : {}) });
      }
    } else this.log.push("event: " + JSON.stringify(m).slice(0, 200));
  }

  /** The wait for the user in request `id` (null: whichever) ends with the request: every user_wait gets its resumed,
   *  also when hands never said it (it died mid-wait, or this side gave up on the request). */
  private endWait(id: number | null, ended: "reply" | "timeout" | "exit") {
    const w = this.waiting;
    if (!w || (id !== null && w.id !== id)) return;
    this.waiting = null;
    this.tell({ kind: "user_resumed", op: w.op, ended });
  }

  /** An answer with no request waiting for it: one given up on (its timeout passed) is logged and told — its step was
   *  recorded as maybe done, and this says what became of it; anything else is logged. */
  private onLate(m: { id: number; ok: boolean; result?: unknown; error?: string }) {
    const gone = this.late.get(m.id);
    if (!gone) { this.log.push(`answer to no request (${String(m.id)})`); return; }
    this.late.delete(m.id);
    const r = (m.result ?? {}) as { status?: unknown; why?: unknown };
    const ev: DriverEvent = { kind: "late_reply", op: gone.op, id: m.id, late_ms: Date.now() - gone.at, ok: !!m.ok,
      ...(typeof r.status === "string" ? { status: r.status } : {}), ...(m.ok ? (typeof r.why === "string" ? { why: r.why.slice(0, 500) } : {}) : { why: String(m.error ?? "").slice(0, 500) }) };
    this.log.push(`late answer to ${gone.op} #${m.id}, ${ev.late_ms} ms after its timeout: ${m.ok ? `${ev.status ?? "ok"}${ev.why ? " — " + ev.why : ""}` : `error — ${ev.why}`}`);
    this.tell(ev);
  }

  /** One request. `perform` and `observe` carry the caller's deadline (`deadline_ms`): the moment this side stops
   *  waiting, from the same number as the timer — one source for the timeout. Past it the request fails with
   *  EffectUnknown (it may still land), and its answer, if it comes, is a late_reply. */
  private call<T>(op: string, body: Record<string, unknown> = {}): Promise<T> {
    this.start();
    const id = ++this.n;
    const ms = this.opts.timeoutMs ?? 120_000;
    const deadline = DEADLINE_OPS.has(op) ? { deadline_ms: Date.now() + ms } : {};
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        this.late.set(id, { op, at: Date.now() });
        for (const k of this.late.keys()) { if (this.late.size <= LATE_KEPT) break; this.late.delete(k); }
        this.endWait(id, "timeout");
        reject(new EffectUnknown(op, `hands ${op}: no answer in ${ms} ms`, true));
      }, ms);
      this.pending.set(id, { op, resolve: (v) => { clearTimeout(timer); this.endWait(id, "reply"); resolve(v as T); }, reject: (e) => { clearTimeout(timer); this.endWait(id, "reply"); reject(e); } });
      try { this.proc!.stdin.write(JSON.stringify({ id, op, ...body, ...deadline }) + "\n"); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e instanceof Error ? e : new Error(String(e))); }
    });
  }

  private begun = false;
  async begin(): Promise<Snapshot> { this.begun = true; return this.call<Snapshot>("begin", { ...(this.opts.scratch ? { scratch: this.opts.scratch } : {}), ...(this.opts.workspace ? { workspace: this.opts.workspace } : {}) }); }
  async snapshot(): Promise<Snapshot> { if (!this.begun) return this.begin(); return this.call<Snapshot>("snapshot"); }
  async observe(windowId: string, o?: { screenshot?: boolean }): Promise<Observation> { if (!this.begun) await this.begin(); return this.call<Observation>("observe", { window: windowId, screenshot: !!o?.screenshot }); }
  /** `foreground_ok` goes inside the action dict, as hands#54 reads it: that app may use the foreground route for this one
   *  step (the search box's Return path included). Set by the executor only; the model never sees it. `shot`: the file
   *  hands writes the window's picture to after the step (hands M0), beside the action; `frames`: say where the window
   *  and the target were before acting. Neither is asked for a look or a wait. */
  async perform(action: Action, opts?: { foreground_ok?: boolean; shot?: string; frames?: boolean }): Promise<PerformResult> { if (!this.begun) await this.begin(); return this.call<PerformResult>("perform", { action: opts?.foreground_ok ? { ...action, foreground_ok: true } : action, ...(opts?.shot ? { shot: opts.shot } : {}), ...(opts?.frames ? { frames: true } : {}) }); }
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
    // the requests still out fail now, as the process's death fails them — not left to their timers (120 s each): the
    // process is let go of, and its close, which comes later, no longer speaks for this driver
    if (this.pending.size) this.failAll("hands executor exited (ended by the caller)", true);
    this.proc?.kill(); this.proc = null;
  }
}
