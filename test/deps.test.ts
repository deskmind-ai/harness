/**
 * The direction of dependencies before the executor is split into its own process (deskmind#90 item 6): the runtime
 * reaches the executor only through the protocol (tools, events, control), so code under src/runtime/ imports only
 * src/protocol/, src/gateway/, src/otel/ (a leaf: the trace context and spans) and src/runtime/ (packages and node: builtins are free); code under src/executor/ never
 * imports src/runtime/. Type-only imports count: they tie the two sides' sources together just the same.
 *
 * P1 removed every violation the P0 list held: the shared types live in src/protocol/ (consent, computer, cards, port),
 * the card texts in src/executor/text.ts, and the runtime reaches the executor only through `ExecutorPort`. The lists
 * below are empty and stay so; the test fails on any violation. src/host/ is the one place that joins both sides.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(import.meta.dirname, "..", "src");

/** Runtime ↔ executor: none since P1. */
const KNOWN_CROSS: string[] = [];
/** Runtime → modules that are neither protocol nor gateway: none since P1. */
const KNOWN_OTHER: string[] = [];

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
      else if (side === "executor" && (target === "runtime" || target === "host")) found.push({ edge, at: `${from}:${line}`, kind: "cross" });
      // otel/ is a leaf (it imports only node builtins and itself, checked below): both sides may record into it
      else if (side === "runtime" && !["runtime", "protocol", "gateway", "otel"].includes(target)) found.push({ edge, at: `${from}:${line}`, kind: "other" });
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

  it("no runtime ↔ executor import", () => {
    const v = violations().filter((x) => x.kind === "cross");
    const edges = [...new Set(v.map((x) => x.edge))].sort();
    expect({ new: edges.filter((e) => !KNOWN_CROSS.includes(e)), gone: KNOWN_CROSS.filter((e) => !edges.includes(e)) }).toEqual({ new: [], gone: [] });
  });

  it("the runtime imports only protocol/, gateway/ and itself", () => {
    const v = violations().filter((x) => x.kind === "other");
    const edges = [...new Set(v.map((x) => x.edge))].sort();
    expect({ new: edges.filter((e) => !KNOWN_OTHER.includes(e)), gone: KNOWN_OTHER.filter((e) => !edges.includes(e)) }).toEqual({ new: [], gone: [] });
  });

  it("otel/ imports nothing of ours outside itself: both sides can record into it", () => {
    const bad = files(path.join(SRC, "otel")).flatMap((f) => importsOf(f).filter((x) => top(x.to) !== "otel").map((x) => `${path.relative(SRC, f)}:${x.line} -> ${x.to}`));
    expect(bad).toEqual([]);
  });

  it("protocol/ imports nothing of ours outside itself: both sides can depend on it", () => {
    const bad = files(path.join(SRC, "protocol")).flatMap((f) => importsOf(f).filter((x) => top(x.to) !== "protocol").map((x) => `${path.relative(SRC, f)}:${x.line} -> ${x.to}`));
    expect(bad).toEqual([]);
  });
});
