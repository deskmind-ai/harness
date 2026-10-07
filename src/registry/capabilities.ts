/**
 * Capabilities: what the runtime can really execute. Each has an id@version, a description the model reads, an input
 * JSON schema with per-field descriptions, an effect class, code-checked preconditions, an executor and a way to
 * reconcile a lost receipt. The model never sees an executor.
 *
 * Field names are deliberately not the user's words (parent/name/text, not filename/content), so the binder has to
 * read descriptions. `renamed()` makes a variant with other field names and the same executor.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { ABSENT, TRASH, Workspace, sha } from "./workspace.js";

export type Effect = "observe" | "create" | "update" | "delete" | "external";

export interface FieldSchema { type: "string"; minLength?: number; description: string }
export interface InputSchema { type: "object"; properties: Record<string, FieldSchema>; required: string[]; additionalProperties: false }

export interface Capability {
  id: string;
  version: string;
  description: string;
  schema: InputSchema;
  effect: Effect;
  channel: "filesystem" | "gui";
  requiresConfirmation: boolean;
  /** For a renamed variant: the base capability id and variant field -> base field. */
  base?: string;
  rename?: Record<string, string>;
}

export type Args = Record<string, string>;

const s = (description: string): FieldSchema => ({ type: "string", minLength: 1, description });
const p = (description: string): FieldSchema => s(description + "。相对任务目录的路径，'/' 分隔，不能含 '..'");

function cap(id: string, description: string, props: Record<string, FieldSchema>, effect: Effect, requiresConfirmation = false): Capability {
  return { id, version: "1.0.0", description, schema: { type: "object", properties: props, required: Object.keys(props), additionalProperties: false }, effect, channel: "filesystem", requiresConfirmation };
}

export const FILE_CAPS: Record<string, Capability> = Object.fromEntries([
  cap("fs.create_text", "在任务目录里新建一个 UTF-8 文本文件并写入正文；目标已存在时失败，不覆盖。",
    { parent: s('新文件所在的文件夹，相对任务目录；放在任务目录本身时填 "."'), name: s("新文件的文件名（只有 basename，不含目录）"), text: s("原样写入的正文，不自动加换行") }, "create"),
  cap("fs.replace_text", "把一个已有文本文件的全部内容替换成新的正文（覆盖原内容）。", { target: p("要改写的文件"), text: s("新的全部正文") }, "update"),
  cap("fs.append_line", "在一个已有文本文件的末尾追加一行。", { target: p("要追加的文件"), line: s("追加的那一行文字，不含换行符") }, "update"),
  cap("fs.move", "移动或重命名一个文件或文件夹；目标位置已存在时失败。", { source: p("要移动的文件或文件夹"), destination: p("新的完整路径（含新文件名）") }, "update"),
  cap("fs.copy", "复制一个文件到新路径；目标已存在时失败。", { source: p("要复制的文件"), destination: p("副本的完整路径") }, "create"),
  cap("fs.mkdir", "新建一个文件夹；已存在时失败。", { path: p("新文件夹的路径") }, "create"),
  cap("fs.trash", "把一个文件移到废纸篓（可找回）。有后果的操作，需要用户逐条确认。", { target: p("要移到废纸篓的文件") }, "delete", true),
  cap("fs.read_text", "读取一个文本文件的内容（只读，不改任何东西）。", { target: p("要读的文件") }, "observe"),
  cap("fs.list", "列出一个文件夹里的文件和子文件夹（只读）。", { path: s('要列的文件夹，任务目录本身填 "."') }, "observe"),
].map((c) => [c.id, c]));

export const RENAMES: Record<string, Record<string, string>> = {
  "fs.create_text": { container: "parent", leaf_name: "name", payload: "text" },
  "fs.append_line": { file: "target", entry: "line" },
  "fs.move": { from_path: "source", to_path: "destination" },
  "fs.replace_text": { document: "target", new_body: "text" },
};

export function renamed(c: Capability): Capability {
  const m = RENAMES[c.id];
  if (!m) throw new Error(`no renamed variant for ${c.id}`);
  const properties: Record<string, FieldSchema> = {};
  for (const [nu, old] of Object.entries(m)) properties[nu] = c.schema.properties[old]!;
  return { ...c, id: c.id + ".alt", schema: { type: "object", properties, required: Object.keys(properties), additionalProperties: false }, base: c.id, rename: m };
}

export const toBase = (c: Capability, args: Args): Args =>
  c.rename ? Object.fromEntries(Object.entries(args).map(([k, v]) => [c.rename![k] ?? k, v])) : { ...args };

const baseId = (c: Capability) => c.base ?? c.id;
const norm = (x: string) => (x.trim() === "." || x.trim() === "./" ? "" : x.trim().replace(/^(\.\/)+/, "").replace(/^\/+|\/+$/g, ""));
const join = (parent: string, name: string) => (norm(parent) === "" ? name : `${norm(parent)}/${name}`);
const parentOf = (q: string) => (q.includes("/") ? q.slice(0, q.lastIndexOf("/")) : "");

export function typecheck(c: Capability, args: Args): string | null {
  const { properties, required } = c.schema;
  const extra = Object.keys(args).filter((k) => !(k in properties));
  if (extra.length) return `unexpected arguments ${JSON.stringify(extra)}`;
  for (const k of required) if (!(k in args)) return `missing argument ${k}`;
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== "string") return `${k} must be a string`;
    if (properties[k]!.minLength && !v) return `${k} is empty`;
  }
  const b = toBase(c, args);
  for (const k of ["parent", "target", "source", "destination", "path"]) if (b[k] !== undefined && b[k]!.split("/").includes("..")) return `bad path ${b[k]}`;
  if (b.name !== undefined && (b.name.includes("/") || b.name === "." || b.name === "..")) return "name must be a bare file name";
  return null;
}

/** [paths read, paths written] by an action. */
export function touched(c: Capability, args: Args): [string[], string[]] {
  const a = toBase(c, args);
  switch (baseId(c)) {
    case "fs.create_text": return [[], [join(a.parent!, a.name!)]];
    case "fs.replace_text": case "fs.append_line": case "fs.trash": return [[], [norm(a.target!)]];
    case "fs.move": return [[], [norm(a.source!), norm(a.destination!)]];
    case "fs.copy": return [[norm(a.source!)], [norm(a.destination!)]];
    case "fs.mkdir": return [[], [norm(a.path!)]];
    case "fs.read_text": return [[norm(a.target!)], []];
    case "fs.list": return [[norm(a.path!)], []];
  }
  throw new Error(baseId(c));
}

export function preconditions(ws: Workspace, c: Capability, args: Args): string | null {
  const a = toBase(c, args);
  const folderOk = (d: string) => d === "" || ws.isDir(d);
  switch (baseId(c)) {
    case "fs.create_text": {
      const q = join(a.parent!, a.name!);
      if (ws.exists(q)) return `${q} already exists`;
      if (!folderOk(parentOf(q))) return `folder ${parentOf(q)} does not exist`;
      return null;
    }
    case "fs.replace_text": case "fs.append_line": case "fs.read_text": {
      const q = norm(a.target!);
      return !ws.exists(q) || ws.isDir(q) ? `${q} is not an existing file` : null;
    }
    case "fs.move": case "fs.copy": {
      const src = norm(a.source!), dst = norm(a.destination!);
      if (!ws.exists(src)) return `${src} does not exist`;
      if (baseId(c) === "fs.copy" && ws.isDir(src)) return `${src} is a folder`;
      if (ws.exists(dst)) return `${dst} already exists`;
      if (!folderOk(parentOf(dst))) return `folder ${parentOf(dst)} does not exist`;
      return null;
    }
    case "fs.mkdir": {
      const q = norm(a.path!);
      if (ws.exists(q)) return `${q} already exists`;
      if (!folderOk(parentOf(q))) return `folder ${parentOf(q)} does not exist`;
      return null;
    }
    case "fs.trash": return ws.exists(norm(a.target!)) ? null : `${norm(a.target!)} does not exist`;
    case "fs.list": return folderOk(norm(a.path!)) ? null : `${norm(a.path!)} is not a folder`;
  }
  return null;
}

/** The versions an action should leave; recorded in the intent and used to reconcile a lost receipt. */
export function expectedAfter(ws: Workspace, c: Capability, args: Args): Record<string, string> {
  const a = toBase(c, args);
  switch (baseId(c)) {
    case "fs.create_text": return { [join(a.parent!, a.name!)]: sha(a.text!) };
    case "fs.replace_text": return { [norm(a.target!)]: sha(a.text!) };
    case "fs.append_line": {
      const q = norm(a.target!), old = ws.read(q);
      return { [q]: sha(old + (old === "" || old.endsWith("\n") ? "" : "\n") + a.line! + "\n") };
    }
    case "fs.move": { const src = norm(a.source!); return { [src]: ABSENT, [norm(a.destination!)]: ws.version(src) }; }
    case "fs.copy": return { [norm(a.destination!)]: ws.version(norm(a.source!)) };
    case "fs.mkdir": return { [norm(a.path!)]: "dir:*" };
    case "fs.trash": return { [norm(a.target!)]: ABSENT };
  }
  return {};
}

export class Crash extends Error {}

export interface ExecResult { status: string; output: Record<string, unknown>; versions_after: Record<string, string>; why?: string }

export function execute(ws: Workspace, c: Capability, args: Args, crashAfterEffect = false): ExecResult {
  const a = toBase(c, args);
  const P = (q: string) => ws.abs(q);
  let output: Record<string, unknown> = {};
  switch (baseId(c)) {
    case "fs.create_text": {
      const q = join(a.parent!, a.name!);
      fs.writeFileSync(P(q), a.text!, { encoding: "utf-8", flag: "wx" }); // exclusive create: no overwrite even in a race
      output = { file: q };
      break;
    }
    case "fs.replace_text": fs.writeFileSync(P(norm(a.target!)), a.text!, "utf-8"); break;
    case "fs.append_line": {
      const q = norm(a.target!), old = ws.read(q);
      fs.appendFileSync(P(q), (old === "" || old.endsWith("\n") ? "" : "\n") + a.line! + "\n", "utf-8");
      break;
    }
    case "fs.move": fs.renameSync(P(norm(a.source!)), P(norm(a.destination!))); break;
    case "fs.copy": fs.copyFileSync(P(norm(a.source!)), P(norm(a.destination!))); break;
    case "fs.mkdir": fs.mkdirSync(P(norm(a.path!))); break;
    case "fs.trash": {
      fs.mkdirSync(P(TRASH), { recursive: true });
      const q = norm(a.target!);
      fs.renameSync(P(q), path.join(P(TRASH), q.replaceAll("/", "_")));
      break;
    }
    case "fs.read_text": output = { text: ws.read(norm(a.target!)) }; break;
    case "fs.list": {
      const q = norm(a.path!);
      output = { entries: ws.listing().filter((e) => parentOf(e.path) === q) };
      break;
    }
  }
  if (crashAfterEffect) throw new Crash("crash after the effect, before the receipt");
  const [, writes] = touched(c, args);
  const parents = new Set(writes.filter((w) => w.includes("/")).map(parentOf));
  const versions_after: Record<string, string> = {};
  for (const k of [...writes, ...parents]) versions_after[k] = ws.version(k);
  return { status: "ok", output, versions_after };
}

export function matches(expected: Record<string, string>, ws: Workspace): boolean {
  for (const [k, v] of Object.entries(expected)) {
    const now = ws.version(k);
    if (v === "dir:*") { if (!now.startsWith("dir:")) return false; }
    else if (now !== v) return false;
  }
  return true;
}

export type Finding = "happened" | "not_happened" | "unknown";

export function reconcile(ws: Workspace, before: Record<string, string>, after: Record<string, string>): Finding {
  if (matches(after, ws)) return "happened";
  if (Object.entries(before).every(([k, v]) => ws.version(k) === v)) return "not_happened";
  return "unknown";
}
