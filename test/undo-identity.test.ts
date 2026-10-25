/**
 * Undo's paper folder models objects, not paths (review of #74, Codex; the third bug of the path-mapping family).
 *
 * The invariant, checked directly against the disk: the pre-check (undo played backwards on paper) and the real undo
 * (each step's capability undo, on the disk) agree on every run —
 *  (a) when the pre-check says everything can be taken back, the undo takes it all back and the folder is the start
 *      tree again (but for what another program changed in between, which stays theirs);
 *  (b) when the pre-check refuses, the real undo, forced step by step without it, also refuses (or fails) at some step.
 * Random nested runs: files and folders created, moved (a folder, then a child out of it, chained), trashed (folders
 * too), replaced, appended; another program interferes between the task and the undo. The Codex repros are named cases.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { SimComputer } from "../src/executor/sim.js";
import { Workspace } from "../src/registry/workspace.js";
import { fileRegistry } from "../src/registry/fs.js";
import { appRun, LineReader } from "../src/cli/app.js";
import { PassThrough } from "node:stream";

const START: Record<string, string> = { "notes/u1.txt": "一", "u2.txt": "二", "deep/sub/x.txt": "x", "가방.txt": "가방" };

/** The folder as text: path → content ("dir" for a folder), the harness's hidden folders left out. */
function tree(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (!rel && e.name.startsWith(".deskmind-")) continue;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out[p + "/"] = "dir"; walk(p); } else out[p] = e.isSymbolicLink() ? "link" : fs.readFileSync(path.join(root, p), "utf-8");
    }
  };
  walk("");
  return out;
}

async function desk() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "undo-identity-"));
  for (const [p, t] of Object.entries(START)) { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), t); }
  const ws = new Workspace(root), app = ConsentSigner.fresh(), sim = new SimComputer(root);
  const ex = new Executor(sim, { task: "t_id", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() } });
  await ex.begin(); await ex.plan({ steps: [] });
  const act = async (capability: string, args: Record<string, string>) => {
    let r = await ex.act({ action: { kind: "file", capability, args }, epoch: ex.currentEpoch });
    if (r.status === "needs_consent") r = await ex.act({ action: { kind: "file", capability, args }, epoch: ex.currentEpoch, consent: app.forAction(r.challenge!) });
    // the executor wants what it acts on read first: read it (a folder: list it), then act again
    for (let i = 0; i < 3 && r.status === "stale" && /never read: /.test(r.why ?? ""); i++) {
      for (const q of (r.why!.match(/never read: (.*?)\. Read it first/)?.[1] ?? "").split(", ").filter(Boolean)) {
        const dir = fs.existsSync(path.join(root, q)) && fs.lstatSync(path.join(root, q)).isDirectory();
        await ex.act({ action: { kind: "file", capability: dir ? "fs.list" : "fs.read_text", args: dir ? { path: q } : { target: q } }, epoch: ex.currentEpoch });
      }
      r = await ex.act({ action: { kind: "file", capability, args }, epoch: ex.currentEpoch });
      if (r.status === "needs_consent") r = await ex.act({ action: { kind: "file", capability, args }, epoch: ex.currentEpoch, consent: app.forAction(r.challenge!) });
    }
    return r;
  };
  return { root, ws, ex, act, start: tree(root) };
}
type Desk = Awaited<ReturnType<typeof desk>>;

/** The pre-check alone (nothing touched): null when every step can be taken back. */
const precheck = (d: Desk): string | null => (d.ex as any).undoPrecheck(d.ex.undoable());
/** The real undo without the pre-check: each step's capability undo on the disk, newest first, until one refuses or
 *  throws. Returns how many were taken back and why it stopped. */
function forced(d: Desk): { undone: number; stopped: string | null } {
  let undone = 0;
  for (const st of d.ex.undoable().steps) {
    const f = (d.ex as any).fileReceipts.get(st.seq);
    let err: string | null;
    try { err = f.cap.undo(d.ws, f.args, { ...f.exec, output: {}, undo: f.exec.undo ?? f.undo_prep }); } catch (e) { err = String(e); }
    d.ws.invalidate();
    if (err) return { undone, stopped: err };
    undone += 1;
  }
  return { undone, stopped: null };
}
/** (a) and (b) for one run; `ext`: paths another program changed (theirs: left out of the comparison). */
async function agree(d: Desk, ext: string[], ctx: string) {
  const why = precheck(d);
  const total = d.ex.undoable().steps.length;
  if (why === null) {
    const u = await d.ex.undo();
    expect(u, ctx).toMatchObject({ undone: total, total, refused: null });
    const mine = (t: Record<string, string>) => Object.fromEntries(Object.entries(t).filter(([p]) => !ext.some((x) => p === x || p.startsWith(x.replace(/\/$/, "") + "/") || p === x + "/")));
    expect(mine(tree(d.root)), ctx).toEqual(mine(d.start));
    return { why, undone: total };
  }
  const f = forced(d);
  expect(f.stopped, `${ctx}: the pre-check refused (${why}) but the real undo took every step back`).not.toBeNull();
  return { why, undone: 0 };
}

describe("undo models objects, not paths: the pre-check and the real undo agree (Codex repros of #74)", () => {
  it("P1: replace notes/u1.txt, move notes → archive, move archive/u1.txt → u3.txt, u3.txt made read-only: refused before anything", async () => {
    const d = await desk();
    expect((await d.act("fs.replace_text", { target: "notes/u1.txt", text: "新" })).status).toBe("ok");
    expect((await d.act("fs.move", { source: "notes", destination: "archive" })).status).toBe("ok");
    expect((await d.act("fs.move", { source: "archive/u1.txt", destination: "u3.txt" })).status).toBe("ok");
    fs.chmodSync(path.join(d.root, "u3.txt"), 0o444);
    expect(precheck(d)).toMatch(/u3.txt is read-only/);
    const u = await d.ex.undo();
    expect(u).toMatchObject({ undone: 0, total: 3 });
    expect(fs.existsSync(path.join(d.root, "u3.txt"))).toBe(true);
  });

  it("P1: mkdir newfolder, trash it, create a.txt, another program adds a file inside the trashed folder: refused before anything", async () => {
    const d = await desk();
    expect((await d.act("fs.mkdir", { path: "newfolder" })).status).toBe("ok");
    expect((await d.act("fs.trash", { target: "newfolder" })).status).toBe("ok");
    expect((await d.act("fs.create_text", { parent: ".", name: "a.txt", text: "hi" })).status).toBe("ok");
    const t = path.join(d.root, ".deskmind-trash");
    const slot = path.join(t, fs.readdirSync(t)[0]!);
    fs.writeFileSync(path.join(slot, fs.readdirSync(slot)[0]!, "external.txt"), "someone else's");
    const u = await d.ex.undo();
    expect(u).toMatchObject({ undone: 0, total: 3, refused: expect.stringMatching(/trashed file was changed/) });
    expect(fs.existsSync(path.join(d.root, "a.txt"))).toBe(true);
  });

  it("P2: append to notes/u1.txt, trash notes, nothing else: the undo is offered and takes both back", async () => {
    const d = await desk();
    expect((await d.act("fs.append_line", { target: "notes/u1.txt", line: "加" })).status).toBe("ok");
    expect((await d.act("fs.trash", { target: "notes" })).status).toBe("ok");
    expect(precheck(d)).toBeNull();
    expect(await d.ex.undo()).toMatchObject({ undone: 2, total: 2, refused: null });
    expect(tree(d.root)).toEqual(d.start);
  });

  it("a folder restored from the trash keeps its hidden names: a .keep inside a trashed folder the run made blocks the mkdir's undo on paper as on disk", async () => {
    const d = await desk();
    expect((await d.act("fs.mkdir", { path: "box" })).status).toBe("ok");
    fs.writeFileSync(path.join(d.root, "box", ".keep"), "");               // another program's hidden file in it
    expect((await d.act("fs.trash", { target: "box" })).status).toBe("ok");
    const u = await agree(d, ["box"], "keep");
    expect(u.undone).toBe(0);
    expect(u.why).toMatch(/not empty/);
  });

  it("random nested runs × another program in between: the pre-check and the real undo agree; a yes restores the start tree", async () => {
    const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const INTERFERE = ["none", "edit_file", "add_in_trashed_folder", "edit_in_trashed_folder", "readonly_file", "readonly_dir", "retake_vacated", "retake_vacated_case", "rm_empty_dir", "none"];
    const outcomes = { yes: 0, no: 0 }, stat = { acted: 0, idle: 0 }, opStat: Record<string, number> = {};
    for (let seed = 1; seed <= 80; seed++) {
      const rand = rng(seed);
      const pick = <X,>(xs: X[]) => xs[Math.floor(rand() * xs.length)]!;
      const d = await desk();
      // the model of the folder: files and folders by path
      const files = new Set(Object.keys(START)), dirs = new Set(["notes", "deep", "deep/sub"]);
      let k = 0;
      const ops: string[] = [];
      const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ".");
      const relocate = (from: string, to: string) => {
        for (const s of [files, dirs]) for (const p of [...s]) if (p === from || p.startsWith(from + "/")) { s.delete(p); s.add(to + p.slice(from.length)); }
      };
      const n = 2 + Math.floor(rand() * 5);
      for (let i = 0; i < n; i++) {
        const where = () => pick([".", ...dirs]);
        const op = pick(["create", "mkdir", "move_file", "move_dir", "move_dir", "trash", "trash_dir", "replace", "append"]);
        let r: any = null;
        if (op === "create") { const par = where(), name = `n${k++}.txt`; r = await d.act("fs.create_text", { parent: par, name, text: `t${i}` }); if (r.status === "ok") files.add(par === "." ? name : `${par}/${name}`); }
        else if (op === "mkdir") { const par = where(), p = par === "." ? `d${k++}` : `${par}/d${k++}`; r = await d.act("fs.mkdir", { path: p }); if (r.status === "ok") dirs.add(p); }
        else if (op === "move_file" && files.size) { const src = pick([...files]), par = where(), dst = par === "." ? `m${k++}.txt` : `${par}/m${k++}.txt`; r = await d.act("fs.move", { source: src, destination: dst }); if (r.status === "ok") relocate(src, dst); }
        else if (op === "move_dir" && dirs.size) {
          const src = pick([...dirs]);
          const into = [".", ...[...dirs].filter((x) => x !== src && !x.startsWith(src + "/"))];
          const par = pick(into), dst = par === "." ? `f${k++}` : `${par}/f${k++}`;
          r = await d.act("fs.move", { source: src, destination: dst }); if (r.status === "ok") relocate(src, dst);
        }
        else if (op === "trash" && files.size) { const f = pick([...files]); r = await d.act("fs.trash", { target: f }); if (r.status === "ok") files.delete(f); }
        else if (op === "trash_dir" && dirs.size) { const t = pick([...dirs]); r = await d.act("fs.trash", { target: t }); if (r.status === "ok") { for (const s of [files, dirs]) for (const p of [...s]) if (p === t || p.startsWith(t + "/")) s.delete(p); } }
        else if (op === "replace" && files.size) r = await d.act("fs.replace_text", { target: pick([...files]), text: `r${i}\n` });
        else if (op === "append" && files.size) r = await d.act("fs.append_line", { target: pick([...files]), line: `l${i}` });
        if (r) ops.push(`${op}:${r.status}`);
      }
      // another program, between the task's end and the undo
      const interfere = INTERFERE[seed % INTERFERE.length]!;
      const ext: string[] = [];
      const abs = (p: string) => path.join(d.root, p);
      const trashedDirs = () => { const t = abs(".deskmind-trash"); if (!fs.existsSync(t)) return []; return fs.readdirSync(t).flatMap((s) => fs.readdirSync(path.join(t, s)).map((x) => path.join(t, s, x))).filter((x) => fs.lstatSync(x).isDirectory()); };
      const vacated = Object.keys(START).filter((p) => !fs.existsSync(abs(p)) && fs.existsSync(path.dirname(abs(p))));
      if (interfere === "edit_file" && files.size) { const f = pick([...files]); fs.appendFileSync(abs(f), "别人加的"); ext.push(f); }
      if (interfere === "add_in_trashed_folder") { const t = trashedDirs()[0]; if (t) fs.writeFileSync(path.join(t, "external.txt"), "别人的"); }
      if (interfere === "edit_in_trashed_folder") { const t = trashedDirs()[0]; if (t) { const f = fs.readdirSync(t, { recursive: true }).map(String).find((x) => fs.statSync(path.join(t, x)).isFile()); if (f) fs.appendFileSync(path.join(t, f), "改了"); } }
      if (interfere === "readonly_file" && files.size) fs.chmodSync(abs(pick([...files])), 0o444);
      if (interfere === "readonly_dir" && dirs.size) fs.chmodSync(abs(pick([...dirs])), 0o555);
      if (interfere === "retake_vacated" && vacated[0]) { fs.writeFileSync(abs(vacated[0]), "又一个"); ext.push(vacated[0]); }
      if (interfere === "retake_vacated_case" && vacated[0]) { const p = path.join(path.dirname(vacated[0]), path.basename(vacated[0]).toUpperCase()); fs.writeFileSync(abs(p), "大写的"); ext.push(p); }
      if (interfere === "rm_empty_dir") { const e = [...dirs].find((x) => fs.readdirSync(abs(x)).length === 0); if (e) { fs.rmdirSync(abs(e)); ext.push(e); } }
      d.ws.invalidate();
      const ctx = `seed ${seed}: ${ops.join(",")} / ${interfere}`;
      stat[ops.filter((o) => o.endsWith(":ok")).length ? "acted" : "idle"] += 1;
      for (const o of ops) opStat[o] = (opStat[o] ?? 0) + 1;
      try {
        const r = await agree(d, ext, ctx);
        outcomes[r.why === null ? "yes" : "no"] += 1;
      } finally {
        for (const x of [...dirs, ...files]) try { fs.chmodSync(abs(x), dirs.has(x) ? 0o755 : 0o644); } catch { /* moved back, gone */ }
      }
    }
    // both sides of the invariant were exercised
    console.log("identity property", JSON.stringify(outcomes), JSON.stringify(stat), JSON.stringify(opStat));
    expect(outcomes.yes).toBeGreaterThan(15);
    expect(outcomes.no).toBeGreaterThan(10);
  }, 120_000);
});

describe("a run id names folders: never one that leaves them (Codex P1 of #74)", () => {
  it("run_id \"..\" is refused at appRun; the task folder is untouched", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "undo-runid-"));
    fs.writeFileSync(path.join(root, "keep.txt"), "mine");
    const input = new PassThrough(); input.end();
    await expect(appRun({ run_id: "..", raw: "改文件", scope: root }, { runs: fs.mkdtempSync(path.join(os.tmpdir(), "undo-runid-runs-")), out: () => {}, input: new LineReader(input), linger: 0 })).rejects.toThrow(/run_id must match/);
    expect(fs.readFileSync(path.join(root, "keep.txt"), "utf-8")).toBe("mine");
  });

  it("every cleanup stays strictly inside .deskmind-undo: a '..' owner, a recorded path with '..', an undo folder that is a link", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "undo-inside-"));
    fs.writeFileSync(path.join(root, "keep.txt"), "mine");
    const ws = new Workspace(root);
    expect(ws.inside(".deskmind-undo", ".deskmind-undo/..")).toBeNull();
    expect(ws.inside(".deskmind-undo", ".deskmind-undo/a/../../keep.txt")).toBeNull();
    expect(ws.inside(".deskmind-undo", ".deskmind-undo")).toBeNull();
    ws.undoOwner = "..";
    expect(ws.undoRunDir()).toBe(".deskmind-undo/__");
    // the undo folder replaced by a link to somewhere else: nothing there is ever removed
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "undo-elsewhere-"));
    fs.mkdirSync(path.join(elsewhere, "run_x")); fs.writeFileSync(path.join(elsewhere, "run_x", "owner.json"), JSON.stringify({ pid: 2 ** 22 + 77 }));
    fs.symlinkSync(elsewhere, path.join(root, ".deskmind-undo"));
    expect(ws.inside(".deskmind-undo", ".deskmind-undo/run_x")).toBeNull();
    ws.sweepUndo();
    expect(fs.existsSync(path.join(elsewhere, "run_x", "owner.json"))).toBe(true);
    // a link inside the undo folder that points out: never followed
    fs.unlinkSync(path.join(root, ".deskmind-undo"));
    fs.mkdirSync(path.join(root, ".deskmind-undo"));
    fs.symlinkSync(root, path.join(root, ".deskmind-undo", "run_y"));
    expect(ws.inside(".deskmind-undo", ".deskmind-undo/run_y/keep.txt")).toBeNull();
    expect(fs.readFileSync(path.join(root, "keep.txt"), "utf-8")).toBe("mine");
  });
});
