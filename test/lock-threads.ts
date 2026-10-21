/**
 * Helper for session.test.ts (not a test itself): two threads try the same session lock at the same instant (a
 * spin barrier on shared memory, microseconds apart: two processes cannot be lined up that closely), `rounds` times,
 * every other round on a stale lock. Prints `[[okA, okB], …]`. The lock's pid is this process's for both threads, so a
 * thread that finds the other's lock sees a live holder.
 *
 *   node --import tsx test/lock-threads.ts <dir> <rounds> <deadPid>
 */
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireLock } from "../src/session/host.js";

if (isMainThread) {
  const [dir, rounds, dead] = process.argv.slice(2);
  const n = Number(rounds);
  for (let r = 0; r < n; r += 2) { fs.mkdirSync(path.join(dir!, "sessions", `ses_${r}`), { recursive: true }); fs.writeFileSync(path.join(dir!, "sessions", `ses_${r}`, "lock"), dead!); }
  // [0] go: the round both may start; [1], [2] ready: the round each thread waits at; results from [3]
  const shared = new Int32Array(new SharedArrayBuffer(4 * (3 + 2 * n)));
  shared[0] = -1; shared[1] = -1; shared[2] = -1;
  const self = fileURLToPath(import.meta.url);
  const workers = [0, 1].map((w) => new Worker(self, { workerData: { dir, n, w, shared } }));
  for (let r = 0; r < n; r++) {
    while (Atomics.load(shared, 1) !== r || Atomics.load(shared, 2) !== r) { /* both at the barrier */ }
    Atomics.store(shared, 0, r);
    while (Atomics.load(shared, 3 + 2 * r) === 0 || Atomics.load(shared, 4 + 2 * r) === 0) { /* both tried */ }
  }
  const out = Array.from({ length: n }, (_, r) => [shared[3 + 2 * r] === 1, shared[4 + 2 * r] === 1]);
  process.stdout.write(JSON.stringify(out) + "\n");
  await Promise.all(workers.map((w) => w.terminate()));
} else {
  const { dir, n, w, shared } = workerData as { dir: string; n: number; w: number; shared: Int32Array };
  for (let r = 0; r < n; r++) {
    Atomics.store(shared, 1 + w, r);
    while (Atomics.load(shared, 0) !== r) { /* spin: start together */ }
    const got = acquireLock(dir, `ses_${r}`);
    Atomics.store(shared, 3 + 2 * r + w, got.ok ? 1 : 2);
  }
  parentPort!.postMessage("done");
}
