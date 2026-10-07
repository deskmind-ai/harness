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

export interface Entry { path: string; kind: "file" | "folder"; bytes?: number; preview?: string }

export class Workspace {
  readonly root: string;

  constructor(root: string) {
    this.root = path.resolve(root);
  }

  abs(p: string): string {
    const full = path.resolve(this.root, p.replace(/^\/+|\/+$/g, ""));
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error(`path outside the workspace: ${p}`);
    return full;
  }

  /** path -> "dir" or the file's digest, for every entry. */
  entries(): Record<string, string> {
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

  listing(maxFiles = 40, peek = 80): Entry[] {
    const out: Entry[] = [];
    for (const [p, v] of Object.entries(this.entries()).slice(0, maxFiles)) {
      if (v === "dir") out.push({ path: p, kind: "folder" });
      else {
        const t = this.read(p);
        out.push({ path: p, kind: "file", bytes: Buffer.byteLength(t), preview: t.slice(0, peek) });
      }
    }
    return out;
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
