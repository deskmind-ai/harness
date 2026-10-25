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

  /** What the folder listed when the paper was made: a name in it and no longer in `e` was taken away by the run's own
   *  steps undone on paper. */
  private readonly initial: Set<string>;
  constructor(private readonly ws: Workspace) {
    this.e = { ...ws.entries() };
    this.initial = new Set(Object.keys(this.e));
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
  // --- the undo questions (Workspace.at / occupied), on paper: the run's own steps undone so far are simulated here,
  // everything else — what other programs did, under any spelling, a symlink — is read from the disk, by the same
  // name resolution the volume uses
  private known(p: string): string | null {
    if (p in this.e) return p;
    const d = this.ws.onDisk(p);
    return d in this.e ? d : null;
  }
  private vacated(p: string): boolean { return (this.initial.has(p) && !(p in this.e)) || (() => { const d = this.ws.onDisk(p); return this.initial.has(d) && !(d in this.e); })(); }
  at(p: string): string {
    if (p === "" || p === ".") return this.version("");
    const k = this.known(p);
    if (k !== null) return this.version(k);
    return this.vacated(p) ? ABSENT : this.ws.at(p);
  }
  occupied(p: string): boolean {
    if (this.known(p) !== null) return true;
    return this.vacated(p) ? false : this.ws.occupied(p);
  }

  /** Whether what is at `p` can be written back (Workspace.writeBlocked). Permissions and locks are the disk's — the
   *  run's own undos only move entries, never change a mode or a flag — so they are asked of the disk, by the same
   *  call, about the entry that will be at `p` when this undo runs: where it is on the disk now (review of #74: replace
   *  u2.txt, move it to notes/u3.txt, the user makes u3.txt read-only — the file the replace's undo writes is u3.txt
   *  brought back, not whatever is at u2.txt now). */
  writeBlocked(p: string, how: "content" | "remove" | "into" | "cross"): string | null {
    if (how === "remove") return this.ws.entryBlocked(this.diskOf(p)) ?? this.writeBlocked(parentOf(p), "into");
    return this.ws.writeBlocked(this.diskOf(p), how);
  }
  /** Where the entry at `p` on paper is on the disk now: what the run's own undos on paper brought back (a move back,
   *  a trashed file put back), followed through a folder brought back; anything else is where it is. */
  diskOf(p: string): string {
    let best = "";
    for (const k of this.from.keys()) if ((p === k || p.startsWith(k + "/")) && k.length > best.length) best = k;
    return best ? this.from.get(best)! + p.slice(best.length) : p;
  }
  /** paper path → its place on the disk, for the entries the run's undos on paper brought back */
  private readonly from = new Map<string, string>();
  private forget(p: string) { for (const k of [...this.from.keys()]) if (k === p || k.startsWith(p + "/")) this.from.delete(k); }

  /** A hidden path's place on the real disk (an undo copy, a trashed file: never in the entries, so never moved on
   *  paper): what an undo check reads to see that what it will restore from is there. */
  abs(p: string): string { return this.ws.abs(p); }
  /** Read as a Workspace by the capabilities' undo checks. */
  get asWorkspace(): Workspace { return this as unknown as Workspace; }

  /** Take one step back on paper: each path it wrote returns to its version before; a folder it renamed takes
   *  everything under it back along (draft/ → final/: final/note.txt is draft/note.txt again), and a folder it made
   *  goes with everything still under it — the ones it made on the way to a written path too (`madeParents`). */
  takeBack(writes: string[], before: (p: string) => string, left: (p: string) => string | undefined, madeParents: string[] = [], restores: Record<string, string> = {}) {
    // where each restored entry is on the disk, worked out before the paper changes (a chain: moved twice back)
    const came = Object.entries(restores).map(([to, fromP]) => [to, this.diskOf(fromP), fromP] as const);
    for (const [, , fromP] of came) this.forget(fromP);
    for (const p of writes) if (before(p) === ABSENT) this.forget(p);
    for (const [to, disk] of came) { this.forget(to); if (to !== disk) this.from.set(to, disk); }
    const src = writes.find((p) => before(p).startsWith("dir:") && left(p) === ABSENT);
    const dst = writes.find((p) => before(p) === ABSENT && left(p)?.startsWith("dir:"));
    if (src && dst) this.relocate(dst, src);
    else for (const p of writes) if (before(p) === ABSENT) this.drop(p);
    for (const p of writes) {
      const b = before(p);
      if (b === ABSENT) { delete this.e[p]; this.other.delete(p); } else this.e[p] = b.startsWith("dir:") ? "dir" : b;
    }
    for (const d of madeParents) { this.drop(d); delete this.e[d]; }
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
