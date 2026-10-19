/**
 * The task folder on paper, for undo's preflight: what the disk will be once the later steps are taken back, worked
 * out without touching it. It holds what the disk holds — the entries (path → file digest | "dir", as
 * Workspace.entries lists them) and every other name a folder really has (a hidden file, a link: entries leave them
 * out, but rmdir trips on them) — and answers the questions a capability's undo check asks of a Workspace, a folder's
 * version worked out from its members as they are on paper, by the disk's own formula. Review of #16: a paper made of
 * entries alone let an undo delete the task's output and then stop at a `.keep` or a link; one that skipped folder
 * versions let it stop at a file put into a moved folder.
 */
import { ABSENT, folderVersion, type Workspace } from "../registry/workspace.js";
import { parentOf } from "../registry/spec.js";

export class PaperFolder {
  private readonly e: Record<string, string>;
  /** folder → the names it holds that entries do not list */
  private readonly other = new Map<string, Set<string>>();

  constructor(ws: Workspace) {
    this.e = { ...ws.entries() };
    for (const d of ["", ...Object.keys(this.e).filter((p) => this.e[p] === "dir")]) {
      const rest = ws.members(d).filter((n) => !((d ? `${d}/${n}` : n) in this.e));
      if (rest.length) this.other.set(d, new Set(rest));
    }
  }

  // --- what a capability's undo check reads (the Workspace methods it uses) ---------------------------------------
  version(p: string): string {
    if (p === "" || p === ".") return folderVersion(this.e, "");
    if (!(p in this.e)) return ABSENT;
    return this.e[p] === "dir" ? folderVersion(this.e, p) : this.e[p]!;
  }
  exists(p: string): boolean { return p === "" || p in this.e; }
  isDir(p: string): boolean { return p === "" || this.e[p] === "dir"; }
  entries(): Record<string, string> { return { ...this.e }; }
  members(d: string): string[] {
    const listed = Object.keys(this.e).filter((x) => parentOf(x) === d).map((x) => (d ? x.slice(d.length + 1) : x));
    return [...listed, ...(this.other.get(d) ?? [])];
  }
  /** Read as a Workspace by the capabilities' undo checks. */
  get asWorkspace(): Workspace { return this as unknown as Workspace; }

  /** Take one step back on paper: each path it wrote returns to its version before; a folder it renamed takes
   *  everything under it back along (draft/ → final/: final/note.txt is draft/note.txt again), and a folder it made
   *  goes with everything still under it. */
  takeBack(writes: string[], before: (p: string) => string, left: (p: string) => string | undefined) {
    const src = writes.find((p) => before(p).startsWith("dir:") && left(p) === ABSENT);
    const dst = writes.find((p) => before(p) === ABSENT && left(p)?.startsWith("dir:"));
    if (src && dst) this.relocate(dst, src);
    else for (const p of writes) if (before(p) === ABSENT) this.drop(p);
    for (const p of writes) {
      const b = before(p);
      if (b === ABSENT) { delete this.e[p]; this.other.delete(p); } else this.e[p] = b.startsWith("dir:") ? "dir" : b;
    }
  }

  private inside(d: string, x: string) { return x.startsWith(d + "/"); }
  private relocate(from: string, to: string) {
    for (const x of Object.keys(this.e)) if (this.inside(from, x)) { this.e[to + x.slice(from.length)] = this.e[x]!; delete this.e[x]; }
    for (const [d, names] of [...this.other]) if (d === from || this.inside(from, d)) { this.other.delete(d); this.other.set(to + d.slice(from.length), names); }
  }
  private drop(d: string) {
    for (const x of Object.keys(this.e)) if (this.inside(d, x)) delete this.e[x];
    for (const k of [...this.other.keys()]) if (k === d || this.inside(d, k)) this.other.delete(k);
  }
}
