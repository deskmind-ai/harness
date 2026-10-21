/**
 * The direction of dependencies before the executor is split into its own process (deskmind#90 item 6): the runtime
 * reaches the executor only through the protocol (tools, events, control), so code under src/runtime/ imports only
 * src/protocol/, src/gateway/ and src/runtime/ (packages and node: builtins are free); code under src/executor/ never
 * imports src/runtime/. Type-only imports count: they tie the two sides' sources together just the same.
 *
 * Today's violations are listed below, each by importing file and imported file. The test fails on a new one, and on a
 * listed one that is gone (so the list only shrinks). P1 removes them.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "src");

/** Runtime ↔ executor: to be removed in P1. */
const KNOWN_CROSS = [
  "runtime/loop.ts -> executor/executor.ts",
  "runtime/loop.ts -> executor/judge.ts",
  "runtime/loop.ts -> executor/types.ts",
  "executor/executor.ts -> runtime/text.ts",
];
/** Runtime → modules that are neither protocol nor gateway (card types, prompts, the file registry and workspace):
 *  to be removed in P1 too, by moving what the runtime needs into protocol/ or behind the executor's tools. */
const KNOWN_OTHER = [
  "runtime/loop.ts -> orchestrator/index.ts",
  "runtime/loop.ts -> orchestrator/prompts.ts",
  "runtime/loop.ts -> registry/capability.ts",
  "runtime/loop.ts -> registry/workspace.ts",
];

const files = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? files(path.join(dir, e.name)) : /\.ts$/.test(e.name) ? [path.join(dir, e.name)] : []);

/** Every relative import of a source file (static, re-export, side-effect, dynamic), resolved to a path under src/. */
export function importsOf(file: string): { line: number; to: string }[] {
  const out: { line: number; to: string }[] = [];
  fs.readFileSync(file, "utf-8").split("\n").forEach((l, i) => {
    for (const m of l.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|^\s*import\s+)["'](\.{1,2}\/[^"']+)["']/g)) {
      const abs = path.resolve(path.dirname(file), m[1]!).replace(/\.js$/, ".ts");
      out.push({ line: i + 1, to: path.relative(SRC, abs) });
    }
  });
  return out;
}

const top = (rel: string) => rel.split(path.sep)[0]!;
function violations(): { edge: string; at: string; kind: "cross" | "other" }[] {
  const found: { edge: string; at: string; kind: "cross" | "other" }[] = [];
  for (const f of files(SRC)) {
    const from = path.relative(SRC, f), side = top(from);
    if (side !== "runtime" && side !== "executor") continue;
    for (const { line, to } of importsOf(f)) {
      const target = top(to);
      const edge = `${from} -> ${to}`.split(path.sep).join("/");
      if (side === "runtime" && target === "executor") found.push({ edge, at: `${from}:${line}`, kind: "cross" });
      else if (side === "executor" && target === "runtime") found.push({ edge, at: `${from}:${line}`, kind: "cross" });
      else if (side === "runtime" && !["runtime", "protocol", "gateway"].includes(target)) found.push({ edge, at: `${from}:${line}`, kind: "other" });
    }
  }
  return found;
}

describe("dependency direction: runtime ↔ executor", () => {
  it("the import scanner sees static, type-only, re-export and dynamic imports", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "deps-test-"));
    try {
      const f = path.join(dir, "x.ts");
      fs.writeFileSync(f, ['import { a } from "./a.js";', 'import type { B } from "../b.js";', 'export { c } from "./c.js";', 'import "./d.js";', 'const e = await import("./e.js");', 'import * as fs from "node:fs";'].join("\n"));
      expect(importsOf(f).map((x) => path.basename(x.to))).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it("no runtime ↔ executor import beyond the known list (to be removed in P1)", () => {
    const v = violations().filter((x) => x.kind === "cross");
    const edges = [...new Set(v.map((x) => x.edge))].sort();
    expect({ new: edges.filter((e) => !KNOWN_CROSS.includes(e)), gone: KNOWN_CROSS.filter((e) => !edges.includes(e)) }).toEqual({ new: [], gone: [] });
  });

  it("the runtime imports only protocol/, gateway/ and itself, beyond the known list (to be removed in P1)", () => {
    const v = violations().filter((x) => x.kind === "other");
    const edges = [...new Set(v.map((x) => x.edge))].sort();
    expect({ new: edges.filter((e) => !KNOWN_OTHER.includes(e)), gone: KNOWN_OTHER.filter((e) => !edges.includes(e)) }).toEqual({ new: [], gone: [] });
  });

  it("protocol/ imports nothing of ours outside itself: both sides can depend on it", () => {
    const bad = files(path.join(SRC, "protocol")).flatMap((f) => importsOf(f).filter((x) => top(x.to) !== "protocol").map((x) => `${path.relative(SRC, f)}:${x.line} -> ${x.to}`));
    expect(bad).toEqual([]);
  });
});
