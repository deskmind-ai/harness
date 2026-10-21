/**
 * app-run under SIGINT / SIGTERM (the helper quitting, or the user's ^C): the run stops as a stop line would stop it,
 * `task_done` (stopped) is written to the log and stdout, and the process exits within a second. Before, it died
 * without a task_done. A steer line sent mid-run reaches the runtime on the way. The run is held in a model call to a local server that never answers, so the signal lands
 * mid-run with no network and no key.
 */
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";

async function runAndSignal(sig: NodeJS.Signals) {
  let hit!: () => void;
  const called = new Promise<void>((r) => { hit = r; });
  const server = http.createServer(() => { hit(); /* never answers */ });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "signals-"));
  const child = spawn(process.execPath, ["--import", "tsx", "src/cli/app.ts", "app-run", "--runs", runs], {
    cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, LOCAL_URL: `http://127.0.0.1:${port}`, LOCAL_API_KEY: "test" },
  });
  let out = "", err = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { err += d; });
  const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
  child.stdin.write(JSON.stringify({ run_id: `run_sig_${sig}`, raw: "把下载文件夹里的截图整理一下", config: "openai:local|m" }) + "\n");
  try {
    await Promise.race([called, exited.then(() => { throw new Error(`exited before the model call: ${out}\n${err}`); })]);
    // a steer mid-run (control v1) reaches the runtime: it says so in the run's trace
    child.stdin.write(JSON.stringify({ type: "steer", text: "只整理今天的" }) + "\n");
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    child.kill(sig);
    const code = await exited;
    const ms = Date.now() - t0;
    const events = out.trim().split("\n").map((l) => JSON.parse(l));
    const onDisk = fs.readFileSync(path.join(runs, `run_sig_${sig}`, "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const trace = fs.readFileSync(path.join(runs, `run_sig_${sig}`, "trace.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    return { code, ms, events, onDisk, err, trace };
  } finally {
    child.kill("SIGKILL");
    server.closeAllConnections();
    server.close();
  }
}

describe("app-run under a signal", () => {
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    it(`${sig}: stops the run, writes task_done (stopped), exits within a second`, async () => {
      const r = await runAndSignal(sig);
      expect(r.events[0]).toMatchObject({ kind: "start", protocol: { events: 1 } });
      const done = r.events.filter((e) => e.kind === "task_done");
      expect(done, r.err).toHaveLength(1);
      expect(done[0]).toMatchObject({ status: "stopped" });
      expect(done[0].reason).toContain(sig);
      expect(r.events.at(-1).kind).toBe("task_done");
      expect(r.onDisk.at(-1)).toMatchObject({ kind: "task_done", status: "stopped" });
      expect(r.code).toBe(0);
      expect(r.ms).toBeLessThan(1000);
      expect(r.trace.filter((t) => t.kind === "steer").map((t) => t.raw)).toEqual(["只整理今天的"]);
    }, 30_000);
  }
});
