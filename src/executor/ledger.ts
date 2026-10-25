/**
 * Who owns what: everything that exists when the task begins is the user's; everything the task creates is the
 * task's. Decided by structure (an inventory at begin, a note at every creation), never by a model.
 */
import type { Owner, Snapshot, WindowInfo } from "./types.js";

/** Every name the driver has for a window's app: its bundle id, its name, its localized name, and the `bundle#` prefix of
 *  its id. hands puts the bundle on snapshot windows but not on `opened_window` (id, app, app_name, title — review of
 *  #75, B2), so an app is matched on any of them; two apps sharing a name are taken for one (the safe side: the user's). */
export function appKeys(w: { id: string; app?: string; app_name?: string; bundle?: string }): string[] {
  const out = new Set<string>();
  for (const s of [w.bundle, w.app, w.app_name, w.id.includes("#") ? w.id.slice(0, w.id.lastIndexOf("#")) : undefined]) if (s && s.trim()) out.add(s.trim().toLowerCase());
  return [...out];
}
export const sameApp = (a: { id: string; app?: string; app_name?: string; bundle?: string }, b: { id: string; app?: string; app_name?: string; bundle?: string }) => { const ks = new Set(appKeys(a)); return appKeys(b).some((k) => ks.has(k)); };

export class Ledger {
  private readonly userOwned = new Set<string>();
  private readonly taskOwned = new Set<string>();
  private begun = false;
  /** Every window id this task has seen — the begin snapshot, every snapshot and look since — and every name of every
   *  app those windows belong to. Fed only by the executor's two driver reads (`see`, `watch`): a window a launch brings
   *  back (a minimised or hidden one of the user's) is none the task made or opened (review of #32), and an app the
   *  user had open — seen in any snapshot, a wait's included — and quit mid-task comes back from the task's launch with
   *  the same mailbox under a new window id, the user's still (review of #75, B; Codex round 2). */
  private readonly seenWindows = new Set<string>();
  private readonly seenApps = new Set<string>();
  /** Records a window as seen; true when it, or a name of its app, was not known before (the executor journals those, so
   *  a process that resumes the task reloads what the earlier one saw — review of #75, probe R). */
  saw(w: { id: string; app?: string; app_name?: string; bundle?: string }): boolean {
    let fresh = !this.seenWindows.has(w.id);
    this.seenWindows.add(w.id);
    for (const k of appKeys(w)) { if (!this.seenApps.has(k)) fresh = true; this.seenApps.add(k); }
    return fresh;
  }
  seen(windowId: string): boolean { return this.seenWindows.has(windowId); }
  seenApp(w: { id: string; app?: string; app_name?: string; bundle?: string }): boolean { return appKeys(w).some((k) => this.seenApps.has(k)); }

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

  /** The user's content moved to a new place (a rename, a move): the new object is the user's too, so discarding it
   *  later still needs consent. Ownership follows the content, not the path. */
  inherits(object: string, from: string) {
    if (this.ownerOf(from) === "user") { this.userOwned.add(object); this.taskOwned.delete(object); }
    else this.created(object);
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
