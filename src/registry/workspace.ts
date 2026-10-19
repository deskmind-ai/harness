/**
 * A Workspace is the directory a task may touch. Paths are relative, '/'-separated and compared by exact name.
 * A path's version is its content digest, or "dir:" + a digest of its direct members, or "absent".
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const ABSENT = "absent";
export const TRASH = ".deskmind-trash";
/** Tools' outputs while they are checked (tools.ts wrote): their own hidden folder at the root, on the same volume as
 *  the task's files and never listed. Nothing a user owns is ever put there (a trashed file goes to TRASH, under its
 *  own name, whatever that name is), so sweeping it can never delete the user's data. */
export const TMP = ".deskmind-tmp";
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

  /** Remove tools' temporary outputs a crashed process left in TMP: only there, and only old ones, so another run
   *  checking its output right now keeps it. */
  sweepTemp() {
    const dir = path.join(this.root, TMP);
    let names: string[] = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    const cutoff = Date.now() - STALE_TEMP_MS;
    for (const n of names) {
      const full = path.join(dir, n);
      try { if (fs.lstatSync(full).mtimeMs < cutoff) fs.rmSync(full, { force: true }); } catch { /* raced, or next time */ }
    }
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
        if (d.name === TRASH || d.name === TMP || d.name === HANDS || d.name === ".keep") continue;
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
      const dirs = names.filter((d) => d.isDirectory() && d.name !== TRASH && d.name !== TMP && d.name !== HANDS).map((d) => d.name).sort();
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
