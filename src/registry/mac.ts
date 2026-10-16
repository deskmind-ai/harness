/**
 * The macOS built-ins the tool capabilities call (tools.ts): command-line tools that ship with macOS, and the small
 * Swift helper in native/mactools.swift for Vision OCR and reading a PDF back.
 *
 * The helper is compiled with swiftc into a cache folder named after its source digest (an edited source is rebuilt).
 * Compiling needs the Xcode command line tools; without them /usr/bin/swiftc opens an install dialog, so nothing is
 * compiled unless `xcode-select -p` already points at a developer folder. The build runs in the background
 * (prepareHelper, started by the first registry that asks), never inside a step; until it is ready the capabilities
 * that need it are not offered at all (tools.ts toolCapabilities), so no model plans with a tool that cannot run.
 */
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const IS_MAC = process.platform === "darwin";

export interface Ran { ok: boolean; stdout: Buffer; stderr: string }

/** Run a program without a shell, bounded in time; output beyond `maxBytes` fails the run rather than being cut. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; maxBytes?: number } = {}): Ran {
  const p = spawnSync(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: opts.maxBytes ?? 16 * 1024 * 1024 });
  return { ok: p.status === 0 && !p.error, stdout: p.stdout ?? Buffer.alloc(0), stderr: (p.stderr?.toString("utf-8") ?? "") + (p.error ? String(p.error) : "") };
}

/** Where things are; tests point these elsewhere to see the helper missing. */
export const HELPER = {
  source: path.join(path.dirname(fileURLToPath(import.meta.url)), "native", "mactools.swift"),
  cache: path.join(os.homedir(), "Library", "Caches", "deskmind-harness"),
  xcodeSelect: "/usr/bin/xcode-select",
};

type State = { ready: string } | { building: Promise<void> } | { unavailable: string } | null;
let state: State = null;

function binPath(): string | null {
  if (!fs.existsSync(HELPER.source)) return null;
  return path.join(HELPER.cache, "mactools-" + createHash("sha256").update(fs.readFileSync(HELPER.source)).digest("hex").slice(0, 12));
}

/** A built helper answers `ping`; a broken or truncated one is removed so it gets built again. */
function works(bin: string): boolean {
  const r = run(bin, ["ping", "-"], { timeoutMs: 10_000 });
  if (r.ok && r.stdout.toString().includes('"ok"')) return true;
  fs.rmSync(bin, { force: true });
  return false;
}

/** The helper, if it is ready now. Never builds and never waits: see prepareHelper. */
export function helperBin(): string | null {
  if (state && "ready" in state) return state.ready;
  if (state) return null;
  const bin = binPath();
  if (IS_MAC && bin && fs.existsSync(bin) && works(bin)) { state = { ready: bin }; return bin; }
  return null;
}

/** Why the helper is not ready (for a precondition), or null when it is. */
export function helperProblem(): string | null {
  if (helperBin()) return null;
  if (!IS_MAC) return "needs macOS";
  if (state && "unavailable" in state) return state.unavailable;
  return "the macOS helper is not built yet";
}

/** Build the helper in the background, once; resolves when it is ready or known to be unavailable. */
export function prepareHelper(): Promise<void> {
  if (helperBin()) return Promise.resolve();
  if (state && "building" in state) return state.building;
  if (state && "unavailable" in state) return Promise.resolve();
  const fail = (why: string) => { state = { unavailable: why }; };
  if (!IS_MAC) { fail("needs macOS"); return Promise.resolve(); }
  const bin = binPath();
  if (!bin) { fail(`the helper's source is missing (${HELPER.source})`); return Promise.resolve(); }
  // Only with the command line tools already installed: otherwise swiftc would ask the user to install them.
  const dev = run(HELPER.xcodeSelect, ["-p"], { timeoutMs: 10_000 });
  const devDir = dev.stdout.toString().trim();
  if (!dev.ok || !devDir || !fs.existsSync(devDir)) { fail("needs the Xcode command line tools (xcode-select --install)"); return Promise.resolve(); }
  const building = new Promise<void>((resolve) => {
    fs.mkdirSync(HELPER.cache, { recursive: true });
    const tmp = `${bin}.${process.pid}.${Date.now()}.tmp`;
    execFile("/usr/bin/xcrun", ["swiftc", "-O", "-o", tmp, HELPER.source], { timeout: 300_000 }, (err, _out, stderr) => {
      if (!err && fs.existsSync(tmp)) fs.renameSync(tmp, bin);
      fs.rmSync(tmp, { force: true });
      if (fs.existsSync(bin) && works(bin)) state = { ready: bin };
      else fail("cannot build the macOS helper: " + String(stderr || err).slice(0, 300));
      resolve();
    });
  });
  state = { building };
  return building;
}

/** Forget what is known about the helper (tests). */
export function resetHelper() { state = null; }

/** Ask the ready helper; its answer is one JSON object on stdout. */
export function ask(command: "ocr" | "pdf", file: string): Record<string, unknown> | { error: string } {
  const bin = helperBin();
  if (!bin) return { error: helperProblem() ?? "the macOS helper is not ready" };
  const r = run(bin, [command, file], { timeoutMs: 120_000, maxBytes: 64 * 1024 * 1024 });
  if (!r.ok) return { error: `${command} failed: ${r.stderr.slice(0, 300)}` };
  try { return JSON.parse(r.stdout.toString("utf-8")); } catch { return { error: `${command}: unreadable answer` }; }
}
