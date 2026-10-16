/**
 * The macOS built-ins the tool capabilities call (tools.ts): command-line tools that ship with macOS, and the small
 * Swift helper in native/mactools.swift for Vision OCR and reading a PDF back. The helper is compiled once with swiftc
 * (Xcode command line tools) into a cache folder named after its source digest, so an edited source is rebuilt.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const IS_MAC = process.platform === "darwin";

export interface Ran { ok: boolean; stdout: Buffer; stderr: string }

/** Run a program without a shell; bounded so a hung tool cannot hold the run. */
export function run(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Ran {
  const p = spawnSync(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 60_000, maxBuffer: 64 * 1024 * 1024 });
  return { ok: p.status === 0 && !p.error, stdout: p.stdout ?? Buffer.alloc(0), stderr: (p.stderr?.toString("utf-8") ?? "") + (p.error ? String(p.error) : "") };
}

const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), "native", "mactools.swift");
let built: string | null = null;

/** The compiled helper, built on first use; null with the reason when this machine cannot build it. */
export function helper(): { bin: string } | { error: string } {
  if (!IS_MAC) return { error: "needs macOS" };
  if (built && fs.existsSync(built)) return { bin: built };
  const src = fs.readFileSync(SOURCE);
  const dir = path.join(os.homedir(), "Library", "Caches", "deskmind-harness");
  const bin = path.join(dir, "mactools-" + createHash("sha256").update(src).digest("hex").slice(0, 12));
  if (!fs.existsSync(bin)) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${bin}.${process.pid}.tmp`;
    const r = run("/usr/bin/swiftc", ["-O", "-o", tmp, SOURCE], { timeoutMs: 300_000 });
    if (!r.ok) return { error: "cannot build the macOS helper (needs the Xcode command line tools): " + r.stderr.slice(0, 300) };
    fs.renameSync(tmp, bin);
  }
  built = bin;
  return { bin };
}

/** Ask the helper; its answer is one JSON object on stdout. */
export function ask(command: "ocr" | "pdf", file: string): Record<string, unknown> | { error: string } {
  const h = helper();
  if ("error" in h) return h;
  const r = run(h.bin, [command, file], { timeoutMs: 120_000 });
  if (!r.ok) return { error: `${command} failed: ${r.stderr.slice(0, 300)}` };
  try { return JSON.parse(r.stdout.toString("utf-8")); } catch { return { error: `${command}: unreadable answer` }; }
}
