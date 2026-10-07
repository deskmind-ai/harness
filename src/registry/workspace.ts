/**
 * A Workspace is the directory a task may touch. Paths are relative, '/'-separated and compared by exact name.
 * A path's version is its content digest, or "dir:" + a digest of its direct members, or "absent".
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const ABSENT = "absent";
export const TRASH = ".deskmind-trash";

export const sha = (b: string | Buffer) => "sha256:" + createHash("sha256").update(b).digest("hex").slice(0, 16);

export interface Entry { path: string; kind: "file" | "folder"; bytes?: number; preview?: string; preview_truncated?: boolean }

/** What a model is shown of a directory: a bounded projection that says what it left out (2.0 §5.4). */
export interface Listing { entries: Entry[]; total: number; truncated: boolean; omitted: number; note?: string }

export class Workspace {
  readonly root: string;
  private cache: { entries: Record<string, string>; mtimes: string } | null = null;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  /** Forget the cached snapshot (after our own effect or a known external change). */
  invalidate() {
    this.cache = null;
  }

  /** A cheap fingerprint of the tree's shape and mtimes; when it is unchanged the digest snapshot is reused. */
  private stamp(): string {
    const parts: string[] = [];
    const walk = (dir: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.name === TRASH || d.name === ".keep") continue;
        const full = path.join(dir, d.name);
        const st = fs.statSync(full);
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
    return full;
  }

  /** path -> "dir" or the file's digest, for every entry. Cached while the tree's mtimes and sizes are unchanged. */
  entries(): Record<string, string> {
    const mtimes = this.stamp();
    if (this.cache && this.cache.mtimes === mtimes) return this.cache.entries;
    const out: Record<string, string> = {};
    const walk = (dir: string, rel: string) => {
      const names = fs.readdirSync(dir, { withFileTypes: true });
      const dirs = names.filter((d) => d.isDirectory() && d.name !== TRASH).map((d) => d.name).sort();
      const files = names.filter((d) => d.isFile() && d.name !== ".keep").map((d) => d.name).sort();
      for (const d of dirs) out[rel ? `${rel}/${d}` : d] = "dir";
      for (const f of files) out[rel ? `${rel}/${f}` : f] = sha(fs.readFileSync(path.join(dir, f)));
      for (const d of dirs) walk(path.join(dir, d), rel ? `${rel}/${d}` : d);
    };
    walk(this.root, "");
    this.cache = { entries: out, mtimes };
    return out;
  }

  version(p: string): string {
    const e = this.entries();
    if (p === "" || p === "/" || p === ".") {
      const members = Object.keys(e).filter((k) => !k.includes("/")).sort();
      return "dir:" + sha(members.map((m) => `${m}=${e[m]}`).join("\n"));
    }
    if (!(p in e)) return ABSENT;
    if (e[p] === "dir") {
      const members = Object.keys(e).filter((k) => k.startsWith(p + "/") && !k.slice(p.length + 1).includes("/")).sort();
      return "dir:" + sha(members.map((m) => `${m}=${e[m]}`).join("\n"));
    }
    return e[p]!;
  }

  read(p: string): string {
    return fs.readFileSync(this.abs(p), "utf-8");
  }

  exists(p: string): boolean {
    return this.version(p) !== ABSENT;
  }

  isDir(p: string): boolean {
    return this.version(p).startsWith("dir:");
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
        const t = this.read(p);
        entries.push({ path: p, kind: "file", bytes: Buffer.byteLength(t), preview: t.slice(0, peek), ...(t.length > peek ? { preview_truncated: true } : {}) });
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
