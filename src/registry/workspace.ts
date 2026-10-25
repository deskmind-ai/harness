/**
 * A Workspace is the directory a task may touch. Paths are relative, '/'-separated and compared by exact name.
 * A path's version is its content digest, or "dir:" + a digest of its direct members, or "absent".
 */
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

export const ABSENT = "absent";
export const TRASH = ".deskmind-trash";
/** Tools' outputs while they are checked (tools.ts wrote): their own hidden folder at the root, on the same volume as
 *  the task's files and never listed. Nothing a user owns is ever put there (a trashed file goes to TRASH, under its
 *  own name, whatever that name is), so sweeping it can never delete the user's data. */
export const TMP = ".deskmind-tmp";
/** The copies undo restores from (fs.replace_text keeps the file it overwrites here): hidden at the root, never listed,
 *  never a change, never credited. Each run keeps its own in `UNDO_DIR/<run>/` with an `owner.json` (its process id):
 *  the executor removes its folder on every exit; the app's next run sweeps the folders whose owner process is gone (a
 *  SIGKILL, a crash), and anything older than STALE_UNDO_MS whoever owns it. */
export const UNDO_DIR = ".deskmind-undo";
/** A copy older than this is stale whatever its owner says: no run lingers that long. */
const STALE_UNDO_MS = 24 * 60 * 60_000;
const pidAlive = (pid: unknown): boolean => { if (typeof pid !== "number" || !(pid > 0)) return false; try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; } };
/** A folder's version, from entries (path → file digest | "dir"): its direct members and their digests. One formula
 *  for the disk (Workspace.version) and for undo's paper folder, so the two cannot drift apart. */
export function folderVersion(e: Record<string, string>, p: string): string {
  const members = Object.keys(e).filter((k) => (p ? k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/") : !k.includes("/"))).sort();
  return "dir:" + sha(members.map((m) => `${m}=${e[m]}`).join("\n"));
}

/** The hands driver's own folder in the task folder (a new TextEdit document is a file there until it is saved as
 *  something): the driver's, never the task's or the user's — not listed, not credited (review of #16). */
export const HANDS = ".hands";
/** A temporary output older than this is left by a process that died, not one still being checked. */
const STALE_TEMP_MS = 10 * 60_000;

export const sha = (b: string | Buffer) => "sha256:" + createHash("sha256").update(b).digest("hex").slice(0, 16);

export interface Entry { path: string; kind: "file" | "folder"; bytes?: number; preview?: string; preview_truncated?: boolean; not_utf8?: boolean }

/** Text a model can be shown: valid UTF-8 without NUL bytes. A zip, a PDF or an image is not, and neither is text in
 *  another encoding (GBK, UTF-16); decoded as UTF-8 either is noise in a prompt. */
export function isText(b: Buffer): boolean {
  if (b.subarray(0, 8192).includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(b); return true; } catch { return false; }
}

/** What to call a file that is not UTF-8 text, without guessing which it is. */
export const NOT_UTF8 = "不是 UTF-8 文本（可能是图片、PDF、压缩包等二进制文件，或 GBK、UTF-16 等别的编码）";
/** The same, in the runtime's own (English) voice, for a refused precondition. */
export const NOT_UTF8_EN = "is not UTF-8 text (a binary file such as an image, PDF or archive, or text in another encoding such as GBK or UTF-16)";

/** What a model is shown of a directory: a bounded projection that says what it left out (2.0 §5.4). */
export interface Listing { entries: Entry[]; total: number; truncated: boolean; omitted: number; note?: string }

export class Workspace {
  readonly root: string;
  private cache: { entries: Record<string, string>; mtimes: string } | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** The run whose undo copies this workspace keeps (the executor's task id), so they live in a folder of its own. */
  undoOwner?: string;
  private ownerWritten = false;
  /** Where this run's undo copies go. Its owner record is (re)written by the first use in each process: a restarted
   *  run's folder names the live process, not the one that died (the sweep would take its copies). */
  undoDir(): string {
    const rel = `${UNDO_DIR}/${(this.undoOwner ?? "_").replace(/[^\w.-]/g, "_")}`;
    const full = this.abs(rel);
    fs.mkdirSync(full, { recursive: true });
    if (!this.ownerWritten) {
      try { fs.writeFileSync(path.join(full, "owner.json"), JSON.stringify({ pid: process.pid, run: this.undoOwner ?? null })); this.ownerWritten = true; } catch { /* swept by age */ }
    }
    return rel;
  }

  /** Remove tools' temporary outputs a crashed process left in TMP: only there, and only old ones, so another run
   *  checking its output right now keeps it. */
  sweepTemp() {
    this.sweepUndo();
    const dir = path.join(this.root, TMP);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    const cutoff = Date.now() - STALE_TEMP_MS;
    for (const n of names) {
      const full = path.join(dir, n);
      try { if (fs.lstatSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true }); } catch { /* raced, or next time */ }
    }
  }

  /** Undo copies no live run will use: a run folder whose owner process is gone (it was killed or crashed: no exit path
   *  ran), and anything older than STALE_UNDO_MS. `except`: the calling run's own folder, never touched. */
  sweepUndo(o: { except?: string } = {}) {
    const dir = path.join(this.root, UNDO_DIR);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    const cutoff = Date.now() - STALE_UNDO_MS;
    for (const n of names) {
      if (o.except !== undefined && n === o.except.replace(/[^\w.-]/g, "_")) continue;
      const full = path.join(dir, n);
      try {
        const st = fs.lstatSync(full);
        let owner: { pid?: unknown } | null = null;
        if (st.isDirectory()) { try { owner = JSON.parse(fs.readFileSync(path.join(full, "owner.json"), "utf-8")); } catch { owner = null; } }
        const dead = st.isDirectory() && owner !== null && !pidAlive(owner.pid);
        if (dead || st.mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
      } catch { /* raced */ }
    }
    try { fs.rmdirSync(dir); } catch { /* not empty, or gone */ }
  }

  /** A path as it is spelled on disk: each part that exists under another case or Unicode form (macOS volumes are
   *  usually case- and normalisation-insensitive: 「PLAN.txt」 opens plan.txt) is replaced by the name in its folder;
   *  an exact name always wins, and from the first part that is not there on, the rest is kept as given. So ownership,
   *  consent and every guard see the file a write would really reach. */
  onDisk(p: string): string {
    const parts = p.split("/").filter(Boolean);
    // only what this volume ignores is folded: on a case-sensitive volume 「A.txt」 is another file than a.txt
    const { caseless, formless } = this.names();
    const fold = (x: string) => { const y = formless ? x.normalize("NFC") : x; return caseless ? y.toLowerCase() : y; };
    if (!caseless && !formless) return p;
    let dir = this.root;
    const out: string[] = [];
    for (let i = 0; i < parts.length; i += 1) {
      let names: string[];
      try { names = fs.readdirSync(dir); } catch { return [...out, ...parts.slice(i)].join("/"); }
      const part = parts[i]!;
      const hit = names.includes(part) ? part : names.find((n) => fold(n) === fold(part));
      if (hit === undefined) return [...out, ...parts.slice(i)].join("/");
      out.push(hit);
      dir = path.join(dir, hit);
    }
    return out.join("/");
  }

  /** How the volume under the root compares names: does it ignore case, does it ignore the Unicode form (NFC/NFD)?
   *  Asked of the volume itself, once per volume (a probe file in TMP, looked up under the other spelling). */
  names(): VolumeNames {
    let dev: number;
    try { dev = fs.statSync(this.root).dev; } catch { return defaultNames(); }
    const known = VOLUME_NAMES.get(dev);
    if (known) return known;
    const dir = path.join(this.root, TMP), base = `probe-${randomUUID().slice(0, 8)}-a\u00e9`;
    let found: VolumeNames;
    const made = !fs.existsSync(dir);
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, base), "");
      const there = (n: string) => { try { fs.lstatSync(path.join(dir, n)); return true; } catch { return false; } };
      found = { caseless: there(base.toUpperCase()), formless: there(base.normalize("NFD")) };
    } catch { found = defaultNames(); }
    try { fs.rmSync(path.join(dir, base), { force: true }); if (made) fs.rmdirSync(dir); } catch { /* not empty: another run's outputs */ }
    VOLUME_NAMES.set(dev, found);
    return found;
  }

  /** Forget the cached snapshot (after our own effect or a known external change). */
  invalidate() {
    this.cache = null;
  }

  /** A cheap fingerprint of the tree's shape and mtimes; when it is unchanged the digest snapshot is reused. */
  private stamp(): string {
    const parts: string[] = [];
    const gone = (e: unknown) => (e as { code?: string }).code === "ENOENT";
    const walk = (dir: string) => {
      let names: fs.Dirent[];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (gone(e) && dir !== this.root) return; throw e; }   // vanished meanwhile: not there
      for (const d of names) {
        if (d.name === TRASH || d.name === TMP || d.name === UNDO_DIR || d.name === HANDS || d.name === ".keep") continue;
        const full = path.join(dir, d.name);
        let st: fs.Stats;
        try { st = fs.lstatSync(full); } catch (e) { if (gone(e)) continue; throw e; }   // a link (even a dangling one) is not followed
        parts.push(`${full}:${st.mtimeMs}:${st.size}`);
        if (d.isDirectory()) walk(full);
      }
    };
    walk(this.root);
    return parts.join("\n");
  }

  abs(p: string): string {
    const full = path.resolve(this.root, p.replace(/^\/+|\/+$/g, ""));
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error(`path outside the workspace: ${p}`);
    // nor through a link on the way: a folder swapped for a link to somewhere else takes a write there (review of #16:
    // destination/ became a link while the judge answered, and a move replaced a file outside). The last part may be a
    // link itself — the tools look at it (lstat) and never write through it
    const parts = path.relative(this.root, full).split(path.sep).filter(Boolean);
    let at = this.root;
    for (const part of parts.slice(0, -1)) {
      at = path.join(at, part);
      let st: fs.Stats;
      try { st = fs.lstatSync(at); } catch { break; }            // not there yet: nothing further to go through
      if (st.isSymbolicLink()) throw new Error(`path goes through a link: ${p}`);
    }
    return full;
  }

  /** path -> "dir" or the file's digest, for every entry. Cached while the tree's mtimes and sizes are unchanged. */
  entries(): Record<string, string> {
    const mtimes = this.stamp();
    if (this.cache && this.cache.mtimes === mtimes) return this.cache.entries;
    const out: Record<string, string> = {};
    // a folder other programs use too (a scope like /tmp): an entry that vanishes between the listing and its read
    // is simply not there — the listing is of what exists now, not a reason to fail the task (10-18, app-run on /tmp)
    const gone = (e: unknown) => (e as { code?: string }).code === "ENOENT";
    const walk = (dir: string, rel: string) => {
      let names: fs.Dirent[];
      try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (gone(e) && rel) { delete out[rel]; return; } throw e; }
      const dirs = names.filter((d) => d.isDirectory() && d.name !== TRASH && d.name !== TMP && d.name !== UNDO_DIR && d.name !== HANDS).map((d) => d.name).sort();
      const files = names.filter((d) => d.isFile() && d.name !== ".keep").map((d) => d.name).sort();
      for (const d of dirs) out[rel ? `${rel}/${d}` : d] = "dir";
      for (const f of files) {
        try { out[rel ? `${rel}/${f}` : f] = sha(fs.readFileSync(path.join(dir, f))); } catch (e) { if (!gone(e)) throw e; }
      }
      for (const d of dirs) walk(path.join(dir, d), rel ? `${rel}/${d}` : d);
    };
    walk(this.root, "");
    this.cache = { entries: out, mtimes };
    return out;
  }

  version(p: string): string {
    const e = this.entries();
    if (p === "" || p === "/" || p === ".") return folderVersion(e, "");
    if (!(p in e)) return ABSENT;
    return e[p] === "dir" ? folderVersion(e, p) : e[p]!;
  }

  read(p: string): string {
    return fs.readFileSync(this.abs(p), "utf-8");
  }

  readBytes(p: string): Buffer {
    return fs.readFileSync(this.abs(p));
  }

  /** A file whose content is text (see isText). */
  isTextFile(p: string): boolean {
    return this.exists(p) && !this.isDir(p) && isText(this.readBytes(p));
  }

  /** A file's text for a prompt, at most `max` characters; a file that is not UTF-8 text is named, never decoded. */
  readForModel(p: string, max: number): string {
    const b = this.readBytes(p);
    return isText(b) ? b.toString("utf-8").slice(0, max) : `（${NOT_UTF8}，${b.length} 字节，不显示内容）`;
  }

  exists(p: string): boolean {
    return this.version(p) !== ABSENT;
  }

  // --- what an undo asks the disk (one set of questions, for its check and for itself) -----------------------------
  /** The version of what is at `p` now, the name resolved as the volume resolves it (another case, another Unicode
   *  form: 「U2.txt」 is at 「u2.txt」 on a case-insensitive volume). ABSENT when nothing listed is there. */
  at(p: string): string { return this.version(this.onDisk(p)); }
  /** Something is at `p` — a file, a folder, a symlink, listed or not — as the volume sees the name. */
  occupied(p: string): boolean { try { fs.lstatSync(this.abs(p)); return true; } catch { return false; } }
  /** Why what is at `p` could not be written back now, or null — the permission question an undo asks before it acts
   *  (review of #74: a file made read-only or locked after the task let undo start and then throw half way):
   *  - "content": its bytes can be written (replace, append: the file writable, not locked or append-only);
   *  - "remove": it can be unlinked or renamed away (the entry not locked, its folder accepts the change);
   *  - "into": a folder that takes an entry in (writable and searchable, not locked).
   *  Nothing there: null (whether something must be there is untouched's and the capability's question). */
  writeBlocked(p: string, how: "content" | "remove" | "into"): string | null {
    const full = this.abs(p), name = p === "" ? "." : p;
    let st: fs.Stats;
    try { st = fs.lstatSync(full); } catch { return how === "remove" ? this.writeBlocked(parentRel(p), "into") : null; }
    if (how === "into" && !st.isDirectory()) return null;
    if (fileFlags(full) & LOCK_FLAGS) return how === "into" ? `folder ${name} is locked` : `${name} is locked`;
    if (how === "remove") return this.writeBlocked(parentRel(p), "into");
    try { fs.accessSync(full, how === "into" ? fs.constants.W_OK | fs.constants.X_OK : fs.constants.W_OK); } catch { return how === "into" ? `folder ${name} is read-only` : `${name} is read-only`; }
    return null;
  }

  isDir(p: string): boolean {
    return this.version(p).startsWith("dir:");
  }

  /** A folder's members as they are on disk (names, hidden ones too): what "this folder holds only ours" is checked
   *  by. A seam: undo's preflight asks the same of the folder as it will be after the later undos. */
  members(d: string): string[] {
    return fs.readdirSync(this.abs(d));
  }

  /** path -> text (null for a folder): the scorer's view. */
  tree(): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    for (const [p, v] of Object.entries(this.entries())) out[p] = v === "dir" ? null : this.read(p);
    return out;
  }

  listing(maxFiles = 40, peek = 80): Listing {
    const all = Object.entries(this.entries());
    const entries: Entry[] = [];
    for (const [p, v] of all.slice(0, maxFiles)) {
      if (v === "dir") entries.push({ path: p, kind: "folder" });
      else {
        const b = this.readBytes(p);
        if (!isText(b)) { entries.push({ path: p, kind: "file", bytes: b.length, not_utf8: true }); continue; }
        const t = b.toString("utf-8");
        entries.push({ path: p, kind: "file", bytes: b.length, preview: t.slice(0, peek), ...(t.length > peek ? { preview_truncated: true } : {}) });
      }
    }
    const omitted = Math.max(0, all.length - maxFiles);
    return {
      entries, total: all.length, truncated: omitted > 0, omitted,
      ...(omitted > 0 ? { note: `目录共 ${all.length} 项，这里只列出前 ${maxFiles} 项；没列出的不等于不存在。要看其余的，先用只读能力 fs.list 列某个子文件夹，或 fs.read_text 读某个文件。` } : {}),
    };
  }
}

/** Build a workspace from {path: text | null (folder)}. */
export function build(root: string, files: Record<string, string | null>) {
  const items = Object.entries(files).sort(([, a], [, b]) => Number(a !== null) - Number(b !== null));
  for (const [p, text] of items) {
    const full = path.join(root, p);
    if (text === null) fs.mkdirSync(full, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, text, "utf-8");
    }
  }
}

/** How a volume compares names (Workspace.names). */
export interface VolumeNames { caseless: boolean; formless: boolean }
const VOLUME_NAMES = new Map<number, VolumeNames>();
/** When the volume cannot be asked (the folder is read-only): macOS volumes are case- and form-insensitive by default. */
const defaultNames = (): VolumeNames => ({ caseless: process.platform === "darwin", formless: process.platform === "darwin" });
/** Test seam: forget what was probed. */
export const forgetVolumeNames = () => VOLUME_NAMES.clear();

/** The BSD file flags that refuse a write, an unlink or a rename whatever the mode says: the Finder's lock (uchg),
 *  append-only (uappnd), and their system forms (schg, sappnd). */
const LOCK_FLAGS = 0x2 | 0x4 | 0x20000 | 0x40000;
/** A path's BSD flags (st_flags; Node's stat does not carry them), not following a link. 0 where there are none. */
export function fileFlags(full: string): number {
  if (process.platform !== "darwin") return 0;
  try { return Number(execFileSync("/usr/bin/stat", ["-f", "%f", full], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }).trim()) || 0; } catch { return 0; }
}
const parentRel = (p: string) => { const i = p.lastIndexOf("/"); return i < 0 ? "" : p.slice(0, i); };
