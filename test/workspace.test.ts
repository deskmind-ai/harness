import * as fs from "node:fs";
import fsCjs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Workspace, build } from "../src/registry/workspace.js";

describe("workspace listing in a folder other programs use", () => {
  it("an entry that vanishes while the folder is listed is left out, not a failure", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-race-"));
    build(root, { "a.txt": "a", "probe/x.txt": "x", "keep/y.txt": "y" });
    const ws = new Workspace(root);
    // another program removes probe/ after the top-level listing saw it (readdirSync is wrapped to simulate the race)
    const real = fsCjs.readdirSync;
    let first = true;
    fsCjs.readdirSync = ((p: fs.PathLike, o?: unknown) => {
      const r = (real as (p: fs.PathLike, o?: unknown) => ReturnType<typeof fs.readdirSync>)(p, o);
      if (first && String(p) === root) { first = false; fs.rmSync(path.join(root, "probe"), { recursive: true }); }
      return r;
    }) as typeof fs.readdirSync;
    syncBuiltinESMExports();
    try {
      const e = ws.entries();
      expect(Object.keys(e).sort()).toEqual(["a.txt", "keep", "keep/y.txt"]);
    } finally { fsCjs.readdirSync = real; syncBuiltinESMExports(); }
  });
});
