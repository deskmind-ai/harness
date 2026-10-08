/** Contract: every capability that says it is reversible can take its action back, and refuses when someone else
 *  changed a written path since (an undo never destroys later work). */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { FS_CAPABILITIES } from "../src/registry/fs.js";
import { Workspace, build } from "../src/registry/workspace.js";

const FILES = { "a.txt": "第一行\n", "docs/b.txt": "b" };
const SAMPLES: Record<string, Record<string, string>> = {
  "fs.create_text": { parent: "docs", name: "new.txt", text: "新内容" },
  "fs.append_line": { target: "a.txt", line: "第二行" },
  "fs.move": { source: "docs/b.txt", destination: "c.txt" },
  "fs.copy": { source: "a.txt", destination: "docs/a-copy.txt" },
  "fs.mkdir": { path: "x/y/z" },
};
const fresh = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-undo-")); build(root, FILES); return new Workspace(root); };

describe("undo contract", () => {
  const writers = FS_CAPABILITIES.filter((c) => c.effect !== "observe");
  it("reversible is exactly 'has an undo'", () => {
    for (const c of writers) expect(c.reversible).toBe(typeof c.undo === "function");
    expect(writers.filter((c) => c.reversible).map((c) => c.id).sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  for (const [id, args] of Object.entries(SAMPLES)) {
    it(`${id}: execute then undo restores every version`, () => {
      const c = FS_CAPABILITIES.find((x) => x.id === id)!;
      const ws = fresh();
      const before = ws.entries();
      const versions = Object.fromEntries(Object.keys(before).map((p) => [p, ws.version(p)]));
      const r = c.execute(ws, args);
      expect(r.status).toBe("ok");
      expect(c.undo!(ws, args, r)).toBeNull();
      expect(ws.entries()).toEqual(before);
      for (const [p, v] of Object.entries(versions)) expect(ws.version(p)).toBe(v);
    });

    it(`${id}: undo refuses after someone else changed what it wrote`, () => {
      const c = FS_CAPABILITIES.find((x) => x.id === id)!;
      const ws = fresh();
      const r = c.execute(ws, args);
      const touched = Object.keys(r.versions_after).find((p) => ws.exists(p) && !ws.isDir(p)) ?? Object.keys(r.versions_after).find((p) => ws.isDir(p))!;
      if (ws.isDir(touched)) fs.writeFileSync(ws.abs(`${touched}/someone-else.txt`), "x");
      else fs.appendFileSync(ws.abs(touched), "别人加的\n");
      expect(c.undo!(ws, args, r)).not.toBeNull();
    });
  }
});
