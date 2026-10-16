import * as fs from "node:fs";

/** Rows from several results files; with supersede, a later file's row for the same config, task and repetition
 *  replaces an earlier one (a rerun of some tasks under a new --out, merged into the first run's report). */
export function readRows(paths: string[], supersede = false): any[] {
  const rows = paths.flatMap((p) => fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  if (!supersede) return rows;
  const last = new Map<string, any>();
  for (const r of rows) { const k = `${r.config}|${r.task}|${r.rep ?? 0}`; last.delete(k); last.set(k, r); }
  return [...last.values()];
}
