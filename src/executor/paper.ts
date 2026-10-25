/**
 * The task folder on paper, for undo's preflight: what the disk will be once the later steps are taken back, worked
 * out without touching it. It holds what the disk holds — the entries (path → file digest | "dir", as
 * Workspace.entries lists them) and every other name a folder really has (a hidden file, a link: entries leave them
 * out, but rmdir trips on them) — and answers the questions a capability's undo check asks of a Workspace, a folder's
 * version worked out from its members as they are on paper, by the disk's own formula. Review of #16: a paper made of
 * entries alone let an undo delete the task's output and then stop at a `.keep` or a link; one that skipped folder
 * versions let it stop at a file put into a moved folder.
 *
 * Identity, not paths (review of #74, the third bug of the path-mapping family): every entry on paper is an object
 * that remembers where it is on the disk now (`disk`). Taking a step back moves objects, never recomputes them: a move
 * back re-keys the object and everything under it (a folder carries its subtree, its hidden names too); a trashed
 * object put back is loaded, subtree and all, from where it lies in the trash. So every question about the thing at a
 * paper path — its version, its members, whether it can be written (mode, lock) — is asked of that very object.
 *
 * Inside the task folder the paper is the whole truth: a name it does not hold is absent (a folder a later undo
 * removes is gone, though the disk still has it until the real undo runs). Only the hidden bases outside the task's
 * scope (the trash, the undo copies) are read from the disk, and permissions and locks — which the run's own undos
 * never change — are read from the disk at the object's place.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ABSENT, HANDS, TMP, TRASH, UNDO_DIR, folderVersion, sha, type Workspace } from "../registry/workspace.js";
import { parentOf } from "../registry/spec.js";

interface Obj { v: string; disk: string }
const HIDDEN = new Set([TRASH, TMP, UNDO_DIR, HANDS]);

export class PaperFolder {
  /** paper path → the object there: its digest ("dir" for a folder) and its place on the disk now */
  private readonly e = new Map<string, Obj>();
  /** folder (paper path) → the names it holds that entries do not list (a hidden file, a link, .keep) */
  private readonly other = new Map<string, Set<string>>();
  private readonly fold: (x: string) => string;

  constructor(private readonly ws: Workspace) {
    const listed = ws.entries();
    for (const [p, v] of Object.entries(listed)) this.e.set(p, { v, disk: p });
    for (const d of ["", ...Object.keys(listed).filter((p) => listed[p] === "dir")]) {
      const rest = ws.members(d).filter((n) => !((d ? `${d}/${n}` : n) in listed));
      if (rest.length) this.other.set(d, new Set(rest));
    }
    // names compared as the volume compares them (Workspace.names): 「U2.txt」 is u2.txt where case is ignored
    const { caseless, formless } = ws.names();
    this.fold = (x) => { const y = formless ? x.normalize("NFC") : x; return caseless ? y.toLowerCase() : y; };
  }

  // --- names --------------------------------------------------------------------------------------------------------
  /** The names folder `d` holds on paper. */
  private children(d: string): string[] {
    const out: string[] = [];
    for (const k of this.e.keys()) if (parentOf(k) === d) out.push(d ? k.slice(d.length + 1) : k);
    return [...out, ...(this.other.get(d) ?? [])];
  }
  /** `p` as the paper holds it, each part matched as the volume matches names (an exact name first): the entry's key
   *  (`entry`), a name entries do not list (`other`: its folder's key and the name), or null — nothing there. */
  private resolve(p: string): { kind: "entry"; key: string } | { kind: "other"; dir: string; name: string } | null {
    const parts = p.split("/").filter(Boolean);
    let cur = "";
    for (let i = 0; i < parts.length; i += 1) {
      const names = this.children(cur);
      const hit = names.includes(parts[i]!) ? parts[i]! : names.find((n) => this.fold(n) === this.fold(parts[i]!));
      if (hit === undefined) return null;
      const key = cur ? `${cur}/${hit}` : hit;
      if (!this.e.has(key)) return i === parts.length - 1 ? { kind: "other", dir: cur, name: hit } : null;
      cur = key;
    }
    return { kind: "entry", key: cur };
  }
  /** Where the thing at paper path `p` is on the disk now; null when the paper holds nothing there. */
  private diskOf(p: string): string | null {
    if (p === "" || p === ".") return "";
    const r = this.resolve(p);
    if (!r) return null;
    if (r.kind === "entry") return this.e.get(r.key)!.disk;
    const d = r.dir === "" ? "" : this.e.get(r.dir)!.disk;
    return d ? `${d}/${r.name}` : r.name;
  }

  // --- what a capability's undo check reads (the Workspace methods it uses) ---------------------------------------
  private flat(): Record<string, string> { const o: Record<string, string> = {}; for (const [k, x] of this.e) o[k] = x.v; return o; }
  version(p: string): string {
    if (p === "" || p === ".") return folderVersion(this.flat(), "");
    const x = this.e.get(p);
    if (!x) return ABSENT;
    return x.v === "dir" ? folderVersion(this.flat(), p) : x.v;
  }
  exists(p: string): boolean { return p === "" || this.e.has(p); }
  isDir(p: string): boolean { return p === "" || this.e.get(p)?.v === "dir"; }
  entries(): Record<string, string> { return this.flat(); }
  members(d: string): string[] { return this.children(d); }
  /** Workspace.at on paper: the version of what is at `p`, the name matched as the volume matches it. */
  at(p: string): string {
    if (p === "" || p === ".") return this.version("");
    const r = this.resolve(p);
    return r?.kind === "entry" ? this.version(r.key) : ABSENT;
  }
  /** Workspace.occupied on paper: anything at `p` — an entry, a link, a hidden name — under any spelling. */
  occupied(p: string): boolean { return this.resolve(p) !== null; }
  /** Whether the thing at `p` can be written back (Workspace.writeBlocked), asked of that object where it is on the
   *  disk now (review of #74: replace u2.txt, move it to notes/u3.txt, the user makes u3.txt read-only — the replace's
   *  undo writes u3.txt brought back). */
  writeBlocked(p: string, how: "content" | "remove" | "into" | "cross"): string | null {
    if (HIDDEN.has(p.split("/")[0]!)) return this.ws.writeBlocked(p, how);   // the trash, the copies: outside the scope, on the disk
    const d = this.diskOf(p);
    if (how === "remove") return (d !== null ? this.ws.entryBlocked(d) : null) ?? this.writeBlocked(parentOf(p), "into");
    return d === null ? null : this.ws.writeBlocked(d, how);
  }
  /** The hidden bases (an undo copy, a trashed object) are outside the task's scope, never on paper: read from disk. */
  abs(p: string): string { return this.ws.abs(p); }
  inside(base: string, rel: string): string | null { return this.ws.inside(base, rel); }
  names() { return this.ws.names(); }
  /** Read as a Workspace by the capabilities' undo checks. */
  get asWorkspace(): Workspace { return this as unknown as Workspace; }

  // --- one step back ------------------------------------------------------------------------------------------------
  /** Take one step back on paper. The objects it brings back (`restores`: path ← where the object is) are moved, with
   *  everything under them: re-keyed from their paper place, or — from the trash — loaded from the disk. Each path it
   *  wrote that held nothing before goes, with everything still under it, and so does every folder it made on the way
   *  (`madeParents`); each file it rewrote in place gets its bytes from before. The caller has checked the step first
   *  (untouched, the capability's check: a trashed object's recorded digest matches what lies in the trash). */
  takeBack(writes: string[], before: (p: string) => string, _left: (p: string) => string | undefined, madeParents: string[] = [], restores: Record<string, string> = {}) {
    const brought = new Set(Object.keys(restores));
    for (const [to, from] of Object.entries(restores)) {
      if (HIDDEN.has(from.split("/")[0]!)) this.load(to, from);
      else this.rekey(from, to);
    }
    for (const p of writes) {
      const b = before(p);
      if (b === ABSENT) { if (!brought.has(p)) this.drop(p); continue; }
      const x = this.e.get(p);
      if (b.startsWith("dir:")) { if (!x) this.e.set(p, { v: "dir", disk: p }); continue; }
      this.e.set(p, { v: b, disk: x?.disk ?? p });            // the same object, its bytes as they were
    }
    for (const d of madeParents) this.drop(d);
  }

  private under(d: string, x: string) { return x === d || x.startsWith(d + "/"); }
  /** Move the object at `from` and everything under it (its hidden names too) to `to`: the objects keep their place
   *  on the disk. */
  private rekey(from: string, to: string) {
    const moved = [...this.e].filter(([k]) => this.under(from, k));
    for (const [k] of moved) this.e.delete(k);
    for (const [k, x] of moved) this.e.set(to + k.slice(from.length), x);
    const others = [...this.other].filter(([d]) => this.under(from, d));
    for (const [d] of others) this.other.delete(d);
    for (const [d, n] of others) this.other.set(to + d.slice(from.length), n);
  }
  private drop(d: string) {
    for (const k of [...this.e.keys()]) if (this.under(d, k)) this.e.delete(k);
    for (const k of [...this.other.keys()]) if (this.under(d, k)) this.other.delete(k);
  }
  /** Put the trashed object at `rel` (in the trash, on the disk) on paper at `to`, as the disk holds it: a file with
   *  its digest; a folder with every entry under it, and the names entries do not list as its hidden names. */
  private load(to: string, rel: string) {
    const full = this.ws.inside(TRASH, rel);
    if (!full) throw new Error(`${rel} is not in the trash`);
    this.drop(to);
    const st = fs.lstatSync(full);
    if (!st.isDirectory()) { this.e.set(to, { v: sha(fs.readFileSync(full)), disk: rel }); return; }
    this.e.set(to, { v: "dir", disk: rel });
    const walk = (dirFull: string, dirDisk: string, dirPaper: string) => {
      for (const d of fs.readdirSync(dirFull, { withFileTypes: true })) {
        const p = `${dirPaper}/${d.name}`, disk = `${dirDisk}/${d.name}`;
        const listed = (d.isDirectory() && !HIDDEN.has(d.name)) || (d.isFile() && d.name !== ".keep");
        if (!listed) { const s = this.other.get(dirPaper) ?? new Set<string>(); s.add(d.name); this.other.set(dirPaper, s); continue; }
        if (d.isDirectory()) { this.e.set(p, { v: "dir", disk }); walk(path.join(dirFull, d.name), disk, p); }
        else this.e.set(p, { v: sha(fs.readFileSync(path.join(dirFull, d.name))), disk });
      }
    };
    walk(full, rel, to);
  }
}
