/**
 * The chat session's commands (docs/protocol.md 「会话（第 1 版）」):
 *
 *   session [--dir <d>] [--config <c>] [--lang zh|en]    stdin line 1: {session_id?, config?, lang?, driver?}; then
 *                                                        control lines (say, stop, attach, end). A known session_id
 *                                                        resumes it; none starts a new one
 *   session --session <id> [--dir <d>]                   resume <id> at once; a first line without `type` is still
 *                                                        read as the header (config, lang)
 *   sessions list [--dir <d>]                            every session, the newest first, as one JSON array
 *
 * `--dir`: the folder that holds `sessions/` (default ~/Library/Application Support/DeskMind). The process exits when
 * stdin closes or `end` comes and no reply is running; SIGINT / SIGTERM are an `end`.
 */
import * as path from "node:path";
import * as readline from "node:readline";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";
import { DEFAULT_DIR, SESSION_ID, listSessions, sessionDir } from "../session/log.js";
import { SessionHost, acquireLock, headerProblem, type SessionHeader } from "../session/host.js";
import * as fs from "node:fs";

const usage = "usage: session [--session <id>] [--dir <d>] [--config <c>] [--lang zh|en] | sessions list [--dir <d>]";

/** `argv`: the arguments after the script (`session …` or `sessions list …`). Resolves with the exit code. */
export async function sessionMain(argv: string[]): Promise<number> {
  let a: { session?: string; dir?: string; config?: string; lang?: string }, positionals: string[];
  try {
    ({ values: a, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { session: { type: "string" }, dir: { type: "string" }, config: { type: "string" }, lang: { type: "string" } } }));
  } catch (e) { console.error(`${(e as Error).message}\n${usage}`); return 2; }
  const dir = path.resolve(a.dir ?? DEFAULT_DIR);
  if (positionals[0] === "sessions") {
    if (positionals[1] !== "list") { console.error(usage); return 2; }
    process.stdout.write(JSON.stringify(listSessions(dir)) + "\n");
    return 0;
  }
  if (positionals[0] !== "session") { console.error(usage); return 2; }

  process.stdout.on("error", () => { /* the app went away: the reply is still stored */ });
  const out = (ev: Record<string, unknown>) => { try { process.stdout.write(JSON.stringify(ev) + "\n"); } catch { /* as above */ } };
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const lines: string[] = [];
  let closed = false, onLine: ((l: string) => void) | null = null, onClose: (() => void) | null = null;
  rl.on("line", (l) => { if (onLine) onLine(l); else lines.push(l); });
  rl.on("close", () => { closed = true; onClose?.(); });
  const firstLine = () => new Promise<string | null>((res) => {
    const l = lines.shift();
    if (l !== undefined) return res(l);
    if (closed) return res(null);
    onLine = (x) => { onLine = null; onClose = null; res(x); };
    onClose = () => { onLine = null; onClose = null; res(null); };
  });
  const asHeader = (l: string): Record<string, unknown> | null => {
    try { const j = JSON.parse(l); return j && typeof j === "object" && !Array.isArray(j) && typeof j.type !== "string" ? j as Record<string, unknown> : null; } catch { return null; }
  };
  // a start that cannot go on: said on stdout as the app reads it (bad_config, not stored), and on stderr; exit 2
  const refuse = (text: string, sessionId?: string) => { out({ t: Date.now() / 1000, ...(sessionId ? { session_id: sessionId } : {}), kind: "session.error", code: "bad_config", text }); console.error(text); return 2; };

  let header: SessionHeader = {};
  let sid: string;
  if (a.session) {
    sid = a.session;
    if (!SESSION_ID.test(sid)) return refuse(`bad session id ${JSON.stringify(sid).slice(0, 80)}`);
    if (!fs.existsSync(path.join(sessionDir(dir, sid), "session.jsonl"))) return refuse(`no session ${sid} under ${dir}`, sid);
  } else {
    const l = await firstLine();
    if (l === null) return refuse("no header line on stdin");
    const h = asHeader(l);
    if (!h) return refuse(`the first line must be the header {session_id?, config?, lang?, driver?}; ${usage}`);
    const bad = headerProblem(h);
    if (bad) return refuse(bad);
    header = h as SessionHeader;
    sid = header.session_id ?? `ses_${randomUUID().slice(0, 8)}`;
  }
  const lock = acquireLock(dir, sid);
  if (!lock.ok) {
    out({ t: Date.now() / 1000, session_id: sid, kind: "session.error", code: "busy", text: `another process (pid ${lock.pid}) has this session open` });
    return 1;
  }
  let exit!: () => void;
  const exited = new Promise<void>((res) => { exit = res; });
  const host = new SessionHost({ dir, sessionId: sid, config: header.config ?? a.config, lang: (header.lang ?? a.lang) as never, out, onExit: () => exit() });
  host.start();
  // resume with --session: the first line, whenever it comes, may still be a header (config, lang); after it, controls
  let first = !!a.session;
  const feed = (l: string) => {
    if (first && l.trim()) { first = false; const h = asHeader(l); if (h) { host.configure(h); return; } }
    host.handle(l);
  };
  for (const l of lines.splice(0)) feed(l);
  if (closed) host.inputClosed();
  onLine = feed;
  onClose = () => host.inputClosed();
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => host.end());
  await exited;
  lock.release();
  rl.close();
  return 0;
}
