/**
 * Helper for session.test.ts (not a test itself): one contender for session locks. For session i of n it waits until
 * t0 + i*gap ms (spinning, so two such processes try at the same moment), calls acquireLock, and prints
 * `{i, ok, pid}` per line. Locks are never released; the process stays alive until `until`, so the other contender
 * always sees a live holder.
 *
 *   node --import tsx test/lock-contend.ts <dir> <n> <t0> <gap> <until>
 */
import { acquireLock } from "../src/session/host.js";

const [dir, n, t0, gap, until] = process.argv.slice(2);
const results: unknown[] = [];
for (let i = 0; i < Number(n); i++) {
  const at = Number(t0) + i * Number(gap);
  while (Date.now() < at) { /* spin */ }
  const r = acquireLock(dir!, `ses_${i}`);
  results.push({ i, ok: r.ok, pid: process.pid });
}
process.stdout.write(results.map((r) => JSON.stringify(r)).join("\n") + "\n");
setTimeout(() => process.exit(0), Math.max(0, Number(until) - Date.now()));
