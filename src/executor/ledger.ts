/**
 * Who owns what: everything that exists when the task begins is the user's; everything the task creates is the
 * task's. Decided by structure (an inventory at begin, a note at every creation), never by a model.
 */
import type { Owner, Snapshot, WindowInfo } from "./types.js";

export class Ledger {
  private readonly userOwned = new Set<string>();
  private readonly taskOwned = new Set<string>();
  private begun = false;

  /** The inventory at begin: windows and tabs on screen now. */
  begin(s: Snapshot, paths: string[] = []) {
    this.begun = true;
    for (const w of s.windows) {
      this.userOwned.add(`window:${w.id}`);
      for (const t of w.tabs ?? []) this.userOwned.add(`tab:${t.id}`);
    }
    for (const p of paths) this.userOwned.add(`path:${p}`);
  }

  created(object: string) {
    if (!this.userOwned.has(object)) this.taskOwned.add(object);
  }

  /** An object neither seen at begin nor created by the task appeared (the user opened it): the user's. */
  ownerOf(object: string): Owner {
    if (!this.begun) throw new Error("ledger: begin() first");
    return this.taskOwned.has(object) ? "task" : "user";
  }

  /** Stamp a snapshot with owners (the driver never says). Windows that appeared since begin without our creating
   *  them are the user's. */
  stamp(s: Snapshot): Snapshot {
    const windows: WindowInfo[] = s.windows.map((w) => ({
      ...w, owner: this.ownerOf(`window:${w.id}`),
      ...(w.tabs ? { tabs: w.tabs.map((t) => ({ ...t, owner: this.ownerOf(`tab:${t.id}`) })) } : {}),
    }));
    return { ...s, windows };
  }

  taskObjects(): string[] { return [...this.taskOwned]; }
}
