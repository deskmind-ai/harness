/**
 * The file-system capabilities, each a self-contained object (see capability.ts). Field names are deliberately not
 * the user's words (parent/name/text, not filename/content), so the binder has to read descriptions.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Registry, type ExecResult } from "./capability.js";
import { ABSENT, NOT_UTF8_EN, TRASH, Workspace, sha } from "./workspace.js";
import { CRASH_FLAG, after, folderOk, join, make, maybeCrash, norm, p, parentOf, s, untouched } from "./spec.js";
import { toolCapabilities } from "./tools.js";

export { CRASH_FLAG, join, norm, parentOf };

export const fsCreateText = make({
  id: "fs.create_text", description: "在任务目录里新建一个 UTF-8 文本文件并写入正文；目标已存在时失败，不覆盖。", effect: "create",
  fields: { parent: s('新文件所在的文件夹，相对任务目录；放在任务目录本身时填 "."'), name: s("新文件的文件名（只有 basename，不含目录）"), text: s("原样写入的正文，不自动加换行") },
  pathFields: ["parent"],
  footprint: (_ws, a) => { const q = join(a.parent!, a.name!); return { reads: [], writes: [q], expectAfter: { [q]: sha(a.text!) } }; },
  pre: (ws, a) => { const q = join(a.parent!, a.name!); return ws.exists(q) ? `${q} already exists` : !folderOk(ws, parentOf(q)) ? `folder ${parentOf(q)} does not exist` : null; },
  run: (ws, a) => { const q = join(a.parent!, a.name!); fs.writeFileSync(ws.abs(q), a.text!, { encoding: "utf-8", flag: "wx" }); maybeCrash(); return after(ws, [q], { file: q }); },
  undo: (ws, a, r) => { const q = join(a.parent!, a.name!); const e = untouched(ws, r, [q]); if (e) return e; fs.unlinkSync(ws.abs(q)); return null; },
});

export const fsReplaceText = make({
  id: "fs.replace_text", description: "把一个已有文本文件的全部内容替换成新的正文（覆盖原内容）。", effect: "update", discards: true,
  fields: { target: p("要改写的文件"), text: s("新的全部正文") }, pathFields: ["target"],
  footprint: (_ws, a) => ({ reads: [], writes: [norm(a.target!)], expectAfter: { [norm(a.target!)]: sha(a.text!) } }),
  pre: (ws, a) => { const q = norm(a.target!); return !ws.exists(q) || ws.isDir(q) ? `${q} is not an existing file` : null; },
  run: (ws, a) => { const q = norm(a.target!); fs.writeFileSync(ws.abs(q), a.text!, "utf-8"); maybeCrash(); return after(ws, [q]); },
});

const appended = (old: string, line: string) => old + (old === "" || old.endsWith("\n") ? "" : "\n") + line + "\n";
export const fsAppendLine = make({
  id: "fs.append_line", description: "在一个已有文本文件的末尾追加一行。", effect: "update",
  fields: { target: p("要追加的文件"), line: s("追加的那一行文字，不含换行符") }, pathFields: ["target"],
  footprint: (ws, a) => { const q = norm(a.target!); return { reads: [], writes: [q], expectAfter: { [q]: sha(appended(ws.read(q), a.line!)) } }; },
  pre: (ws, a) => { const q = norm(a.target!); return !ws.exists(q) || ws.isDir(q) ? `${q} is not an existing file` : null; },
  run: (ws, a) => { const q = norm(a.target!); const old = ws.read(q); fs.appendFileSync(ws.abs(q), appended(old, a.line!).slice(old.length), "utf-8"); maybeCrash(); return { ...after(ws, [q]), undo: { bytes: Buffer.byteLength(old, "utf-8") } }; },
  prep: (ws, a) => ({ bytes: Buffer.byteLength(ws.read(norm(a.target!)), "utf-8") }),
  check: (_ws, _a, r) => typeof r.undo?.bytes !== "number" ? "no record of the file's length before the append" : null,
  undo: (ws, a, r) => { const q = norm(a.target!); const e = typeof r.undo?.bytes !== "number" ? "no record of the file's length before the append" : untouched(ws, r, [q]); if (e) return e; fs.truncateSync(ws.abs(q), Number(r.undo!.bytes)); return null; },
});

export const fsMove = make({
  id: "fs.move", description: "移动或重命名一个文件或文件夹；目标位置已存在时失败。", effect: "update",
  fields: { source: p("要移动的文件或文件夹"), destination: p("新的完整路径（含新文件名）") }, pathFields: ["source", "destination"],
  footprint: (ws, a) => { const src = norm(a.source!), dst = norm(a.destination!); return { reads: [], writes: [src, dst], expectAfter: { [src]: ABSENT, [dst]: ws.version(src) } }; },
  pre: (ws, a) => { const src = norm(a.source!), dst = norm(a.destination!); return !ws.exists(src) ? `${src} does not exist` : ws.exists(dst) ? `${dst} already exists` : !folderOk(ws, parentOf(dst)) ? `folder ${parentOf(dst)} does not exist` : null; },
  run: (ws, a) => { const src = norm(a.source!), dst = norm(a.destination!); fs.renameSync(ws.abs(src), ws.abs(dst)); maybeCrash(); return after(ws, [src, dst]); },
  check: (ws, a) => (folderOk(ws, parentOf(norm(a.source!))) ? null : `folder ${parentOf(norm(a.source!))} is gone`),
  undo: (ws, a, r) => {
    const src = norm(a.source!), dst = norm(a.destination!);
    const e = untouched(ws, r, [src, dst]); if (e) return e;
    if (!folderOk(ws, parentOf(src))) return `folder ${parentOf(src)} is gone`;
    fs.renameSync(ws.abs(dst), ws.abs(src)); return null;
  },
});

export const fsCopy = make({
  id: "fs.copy", description: "复制一个文件到新路径；目标已存在时失败。", effect: "create",
  fields: { source: p("要复制的文件"), destination: p("副本的完整路径") }, pathFields: ["source", "destination"],
  footprint: (ws, a) => { const src = norm(a.source!), dst = norm(a.destination!); return { reads: [src], writes: [dst], expectAfter: { [dst]: ws.version(src) } }; },
  pre: (ws, a) => { const src = norm(a.source!), dst = norm(a.destination!); return !ws.exists(src) ? `${src} does not exist` : ws.isDir(src) ? `${src} is a folder` : ws.exists(dst) ? `${dst} already exists` : !folderOk(ws, parentOf(dst)) ? `folder ${parentOf(dst)} does not exist` : null; },
  run: (ws, a) => { const dst = norm(a.destination!); fs.copyFileSync(ws.abs(norm(a.source!)), ws.abs(dst)); maybeCrash(); return after(ws, [dst]); },
  undo: (ws, a, r) => { const dst = norm(a.destination!); const e = untouched(ws, r, [dst]); if (e) return e; fs.unlinkSync(ws.abs(dst)); return null; },
});

/** The folders mkdir will create (deepest first): the path and its missing ancestors. */
const madeBy = (ws: Workspace, q: string) => { const made: string[] = []; for (let d = q; d && !ws.exists(d); d = parentOf(d)) made.push(d); return made; };
/** A created folder can be removed when it holds nothing but other folders this step made, or paths the same undo
 *  will take back first (`ours`). */
function mkdirBusy(ws: Workspace, r: ExecResult, ours: ReadonlySet<string>): string | null {
  if (!Array.isArray(r.undo?.made)) return "no record of which folders were created";
  const made = r.undo!.made as string[];
  const busy = made.filter((d) => ws.isDir(d) && ws.members(d).some((x) => { const q = d ? `${d}/${x}` : x; return !made.includes(q) && !ours.has(q); }));
  return busy.length ? `folders not empty: ${busy.join(", ")}` : null;
}

export const fsMkdir = make({
  id: "fs.mkdir", description: "新建一个文件夹，缺失的上级文件夹一并建好；已存在时失败。", effect: "create",
  fields: { path: p("新文件夹的路径") }, pathFields: ["path"],
  footprint: (_ws, a) => ({ reads: [], writes: [norm(a.path!)], expectAfter: { [norm(a.path!)]: "dir:*" } }),
  pre: (ws, a) => {
    const q = norm(a.path!);
    if (ws.exists(q)) return `${q} already exists`;
    for (let anc = parentOf(q); anc; anc = parentOf(anc)) if (ws.exists(anc) && !ws.isDir(anc)) return `${anc} is a file, not a folder`;
    return null;
  },
  prep: (ws, a) => ({ made: madeBy(ws, norm(a.path!)) }),
  run: (ws, a) => {
    const q = norm(a.path!);
    const made = madeBy(ws, q);
    fs.mkdirSync(ws.abs(q), { recursive: true }); maybeCrash();
    return { ...after(ws, [q]), undo: { made } };
  },
  check: (ws, _a, r, ours) => mkdirBusy(ws, r, ours),
  undo: (ws, _a, r) => {
    const e = mkdirBusy(ws, r, new Set()); if (e) return e;
    for (const d of r.undo!.made as string[]) fs.rmdirSync(ws.abs(d));
    return null;
  },
});

export const fsTrash = make({
  id: "fs.trash", description: "把一个文件移到废纸篓（可找回）。有后果的操作，需要用户逐条确认。", effect: "delete", confirm: true, discards: true,
  fields: { target: p("要移到废纸篓的文件") }, pathFields: ["target"],
  footprint: (_ws, a) => ({ reads: [], writes: [norm(a.target!)], expectAfter: { [norm(a.target!)]: ABSENT } }),
  pre: (ws, a) => (ws.exists(norm(a.target!)) ? null : `${norm(a.target!)} does not exist`),
  run: (ws, a) => { const q = norm(a.target!); fs.mkdirSync(ws.abs(TRASH), { recursive: true }); fs.renameSync(ws.abs(q), path.join(ws.abs(TRASH), q.replaceAll("/", "_"))); maybeCrash(); return after(ws, [q]); },
});

export const fsReadText = make({
  id: "fs.read_text", description: "读取一个文本文件的内容（只读，不改任何东西）。", effect: "observe",
  fields: { target: p("要读的文件") }, pathFields: ["target"],
  footprint: (_ws, a) => ({ reads: [norm(a.target!)], writes: [], expectAfter: {} }),
  pre: (ws, a) => { const q = norm(a.target!); return !ws.exists(q) || ws.isDir(q) ? `${q} is not an existing file` : !ws.isTextFile(q) ? `${q} ${NOT_UTF8_EN}` : null; },
  run: (ws, a) => ({ status: "ok", output: { text: ws.read(norm(a.target!)) }, versions_after: {} }),
});

export const fsList = make({
  id: "fs.list", description: "列出一个文件夹里的文件和子文件夹（只读）。", effect: "observe",
  fields: { path: s('要列的文件夹，任务目录本身填 "."') }, pathFields: ["path"],
  footprint: (_ws, a) => ({ reads: [norm(a.path!)], writes: [], expectAfter: {} }),
  pre: (ws, a) => (folderOk(ws, norm(a.path!)) ? null : `${norm(a.path!)} is not a folder`),
  run: (ws, a) => {
    // the drill-down the bounded listing points at: one folder's direct members, itself bounded and self-describing
    const q = norm(a.path!), limit = 200;
    const members = Object.entries(ws.entries()).filter(([p]) => parentOf(p) === q);
    const entries = members.slice(0, limit).map(([p, v]) => (v === "dir" ? { path: p, kind: "folder" } : ws.isTextFile(p) ? { path: p, kind: "file", preview: ws.read(p).slice(0, 80) } : { path: p, kind: "file", not_utf8: true }));
    return { status: "ok", output: { entries, total: members.length, truncated: members.length > limit }, versions_after: {} };
  },
});

export const FS_CAPABILITIES = [fsCreateText, fsReplaceText, fsAppendLine, fsMove, fsCopy, fsMkdir, fsTrash, fsReadText, fsList];

/** The file capabilities and the tools that make files (tools.ts): what a file task may use. */
export const fileRegistry = () => [...FS_CAPABILITIES, ...toolCapabilities()].reduce((r, c) => r.register(c), new Registry());

/** Field renames for the dynamic-schema evaluation group. */
export const RENAMES: Record<string, Record<string, string>> = {
  "fs.create_text": { container: "parent", leaf_name: "name", payload: "text" },
  "fs.append_line": { file: "target", entry: "line" },
  "fs.move": { from_path: "source", to_path: "destination" },
  "fs.replace_text": { document: "target", new_body: "text" },
};
