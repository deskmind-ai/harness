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
  // these two have an undo (a kept copy, a move back) but stay not reversible: not done on a guess (policy)
  "fs.replace_text": { target: "a.txt", text: "全换了\n" },
  "fs.trash": { target: "docs/b.txt" },
};
const NOT_ON_A_GUESS = ["fs.replace_text", "fs.trash"];
const fresh = () => { const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-undo-")); build(root, FILES); return new Workspace(root); };

describe("undo contract", () => {
  const writers = FS_CAPABILITIES.filter((c) => c.effect !== "observe");
  it("every writer has an undo; reversible is 'has an undo', except the two never done on a guess", () => {
    for (const c of writers) expect(c.reversible, c.id).toBe(typeof c.undo === "function" && !NOT_ON_A_GUESS.includes(c.id));
    expect(writers.filter((c) => typeof c.undo === "function").map((c) => c.id).sort()).toEqual(Object.keys(SAMPLES).sort());
  });

  for (const [id, args] of Object.entries(SAMPLES)) {
    it(`${id}: execute then undo restores every version`, () => {
      const c = FS_CAPABILITIES.find((x) => x.id === id)!;
      const ws = fresh();
      const before = ws.entries();
      const versions = Object.fromEntries(Object.keys(before).map((p) => [p, ws.version(p)]));
      const prep = c.prepareUndo?.(ws, args);
      const r0 = c.execute(ws, args);
      const r = { ...r0, undo: r0.undo ?? prep };
      expect(r.status).toBe("ok");
      expect(c.undo!(ws, args, r)).toBeNull();
      expect(ws.entries()).toEqual(before);
      for (const [p, v] of Object.entries(versions)) expect(ws.version(p)).toBe(v);
    });

    it(`${id}: undo refuses after someone else changed what it wrote`, () => {
      const c = FS_CAPABILITIES.find((x) => x.id === id)!;
      const ws = fresh();
      const prep = c.prepareUndo?.(ws, args);
      const r0 = c.execute(ws, args);
      const r = { ...r0, undo: r0.undo ?? prep };
      // (a trashed path: someone puts a file there again — undo must not overwrite it)
      const touched = id === "fs.trash" ? undefined : Object.keys(r.versions_after).find((p) => ws.exists(p) && !ws.isDir(p)) ?? Object.keys(r.versions_after).find((p) => ws.isDir(p));
      if (!touched) fs.writeFileSync(ws.abs(args.target!), "别人又放回来一个");
      else if (ws.isDir(touched)) fs.writeFileSync(ws.abs(`${touched}/someone-else.txt`), "x");
      else fs.appendFileSync(ws.abs(touched), "别人加的\n");
      ws.invalidate();
      expect(c.undo!(ws, args, r)).not.toBeNull();
    });
  }
});
