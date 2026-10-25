/**
 * Capabilities that make a new file with a tool: a model rewriting text (translate, summarise, rewrite), macOS
 * built-ins (PDF, OCR), and Node's own zlib (zip). Requests like these were refused as "needs a capability we lack"
 * although the means were on the Mac (evalset v2's lack tasks, 10-16): each closes one such gap.
 *
 * Every one only creates its output file, so undo deletes it. The output is made and checked in a temporary file
 * first (in the workspace's own hidden temporary folder: same volume, never listed), then linked into place, which is
 * atomic and never replaces anything. A crash therefore leaves either no output or a complete, checked one, and a tool that ran
 * but made the wrong thing leaves nothing behind: the step fails with the reason.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Capability, ExecResult } from "./capability.js";
import { ask, helperBin, helperProblem, run } from "./mac.js";
import { after, folderOk, make, maybeCrash, norm, p, parentOf, s, untouched } from "./spec.js";
import { ABSENT, NOT_UTF8_EN, TMP, isText, sha, type Workspace } from "./workspace.js";
import { readZip, writeZip } from "./zip.js";

const pathsOf = (list: string) => list.split("\n").map(norm).filter(Boolean);
const badPath = (q: string) => q.split("/").includes("..");
/** A tool that failed cleanly: every failure here comes before anything reached the task folder, or from `wrote`, which
 *  builds the output in a temporary file and puts it in place in one atomic step — so nothing was left behind, and
 *  the receipt says so (performed: false: executor/possibly.ts). */
const failed = (why: string): ExecResult => ({ status: "failed", why, output: {}, versions_after: {}, performed: false });

/** The destination is new, in an existing folder, with the extension the tool writes (when it writes one). */
function newFile(ws: Workspace, dst: string, ext?: string): string | null {
  if (ext && path.extname(dst).toLowerCase() !== ext) return `${dst} must end with ${ext}`;
  if (ws.exists(dst) || fs.existsSync(ws.abs(dst)) || isLink(ws.abs(dst))) return `${dst} already exists`;
  return folderOk(ws, parentOf(dst)) ? null : `folder ${parentOf(dst)} does not exist`;
}
const isLink = (full: string) => { try { return fs.lstatSync(full).isSymbolicLink(); } catch { return false; } };

/** How an output is put in place: a hard link, which is atomic and never replaces a file. Tests replace it to see a
 *  volume without hard links. */
export const PLACE = { link: (from: string, to: string) => fs.linkSync(from, to) };
/** Volumes without hard links (exFAT, FAT, some network shares) say so with these. The checked temporary file is then
 *  renamed into place instead (atomic, same volume), after looking once more that the destination is still free:
 *  rename would replace a file, a link never does. */
const NO_LINKS = new Set(["ENOTSUP", "EPERM", "EXDEV", "EOPNOTSUPP"]);

/** Put a tool's output at `dst`: written to a temporary file in TMP, checked there (`check` gets its path), then
 *  linked (or, without hard links, renamed) into place. Refuses, leaving nothing, when the check fails, `dst` appeared
 *  meanwhile, or the disk will not take it: never throws. */
export function wrote(ws: Workspace, dst: string, data: Buffer | string, check: (file: string) => string | null, output: Record<string, unknown> = {}): ExecResult {
  let tmp: string | null = null;
  try {
    const dir = ws.abs(TMP);
    fs.mkdirSync(dir, { recursive: true });
    tmp = path.join(dir, `${randomUUID()}${path.extname(dst)}`);
    fs.writeFileSync(tmp, data, { flag: "wx" });
    const err = check(tmp);
    if (err) return { ...failed(err), versions_after: { [dst]: ABSENT } };
    try { PLACE.link(tmp, ws.abs(dst)); } catch (e) {
      const code = (e as NodeJS.ErrnoException).code ?? "";
      if (!NO_LINKS.has(code)) return failed(`cannot create ${dst}: ${code || String(e)}`);
      if (fs.existsSync(ws.abs(dst)) || isLink(ws.abs(dst))) return failed(`cannot create ${dst}: EEXIST`);
      fs.renameSync(tmp, ws.abs(dst));
      tmp = null;
    }
  } catch (e) {
    return failed(`cannot create ${dst}: ${(e as NodeJS.ErrnoException).code ?? String(e).slice(0, 200)}`);
  } finally {
    if (tmp) try { fs.rmSync(tmp, { force: true }); } catch { /* swept at a later start */ }
  }
  maybeCrash();
  return after(ws, [dst], { file: dst, ...output });
}

const removeOutput = (ws: Workspace, dst: string, r: ExecResult) => { const e = untouched(ws, r, [dst]); if (e) return e; fs.unlinkSync(ws.abs(dst)); return null; };

export const fsTransformText = make({
  id: "fs.transform_text",
  description: "按一句说明改写一个文本文件的内容，写成一个新文件（原文件不动）：翻译、总结、改写语气或格式都用它。改写由模型完成，结果原样写入。",
  effect: "create",
  fields: {
    source: p("要改写的文本文件"),
    instruction: s("怎么改写，一句话写清楚，例如「翻译成英文」「总结成三条要点」「改成正式的语气」；保留什么、输出什么格式也写在这里"),
    destination: p("新文件的完整路径（含文件名）；不能是已有文件"),
  },
  pathFields: ["source", "destination"],
  // text: the rewrite; text_of: the version of the source it was made from, so a source changed before this step runs
  // (an earlier step of the same plan appended to it) fails the precondition and the node is bound and rewritten again
  derive: {
    fields: ["text", "text_of"],
    from: (ws, a) => ({ field: "text", instruction: a.instruction!, source: ws.read(norm(a.source!)), also: { text_of: ws.version(norm(a.source!)) } }),
  },
  footprint: (_ws, a) => { const dst = norm(a.destination!); return { reads: [norm(a.source!)], writes: [dst], expectAfter: { [dst]: typeof a.text === "string" ? sha(a.text) : "file:*" } }; },
  pre: (ws, a) => {
    const src = norm(a.source!);
    if (!ws.exists(src) || ws.isDir(src)) return `${src} is not an existing file`;
    if (!ws.isTextFile(src)) return `${src} ${NOT_UTF8_EN}`;
    if (a.text_of !== undefined && ws.version(src) !== a.text_of) return `${src} changed after it was rewritten: rewrite it again`;
    return newFile(ws, norm(a.destination!));
  },
  run: (ws, a) => {
    if (typeof a.text !== "string" || !a.text) return failed("the rewritten text was never produced");
    return wrote(ws, norm(a.destination!), a.text, () => null);
  },
  undoWrites: (_ws, a) => ({ remove: [norm(a.destination!)] }),
  undo: (ws, a, r) => removeOutput(ws, norm(a.destination!), r),
});

/** Finder's folder settings: never something the user asked to compress. */
const JUNK = new Set([".DS_Store"]);
/** What one archive may hold: zip's own limits without zip64 (65,535 entries, 4 GiB), and the archive is built in
 *  memory, so its total is kept to 1 GiB. A guard, refused up front with the reason. */
export const ZIP_LIMITS = { entries: 65_535, totalBytes: 1024 ** 3 };

/** Every file and folder under the given paths, as zip entry names (folders end with "/"), in the listing's order. */
function entriesUnder(ws: Workspace, sources: string[]): string[] {
  const out: string[] = [];
  const all = Object.entries(ws.entries());
  for (const q of sources) {
    if (!ws.isDir(q)) { out.push(q); continue; }
    out.push(q + "/");
    for (const [p, v] of all) if (p.startsWith(q + "/") && !JUNK.has(path.basename(p))) out.push(v === "dir" ? p + "/" : p);
  }
  return [...new Set(out)];
}

const sizeOf = (ws: Workspace, names: string[]) => names.filter((n) => !n.endsWith("/")).reduce((t, n) => t + fs.statSync(ws.abs(n)).size, 0);

/** The archive as other programs see it: our reader gives exactly these entries with these bytes, and on a Mac the
 *  system unzip extracts the same files (all at once; given no names, it treats none as a pattern). */
function zipMatches(ws: Workspace, file: string, names: string[]): string | null {
  let got: { name: string; data: Buffer }[];
  try { got = readZip(fs.readFileSync(file)); } catch (e) { return "the archive cannot be read back: " + String(e); }
  if (got.map((e) => e.name).join("\n") !== names.join("\n")) return "the archive's entries differ from the files";
  for (const e of got) if (!e.name.endsWith("/") && !e.data.equals(ws.readBytes(e.name))) return `${e.name} in the archive differs from the file`;
  if (!fs.existsSync("/usr/bin/unzip")) return null;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "harness-unzip-"));
  try {
    const u = run("/usr/bin/unzip", ["-q", file, "-d", out], { timeoutMs: 300_000 });
    if (!u.ok) return "the system unzip cannot extract the archive: " + u.stderr.slice(0, 200);
    for (const e of got) {
      if (e.name.endsWith("/")) continue;
      const x = path.join(out, e.name);
      if (!fs.existsSync(x) || !fs.readFileSync(x).equals(e.data)) return `the system unzip extracts ${e.name} differently`;
    }
    return null;
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

export const fsZipFiles = make({
  id: "fs.zip_files",
  description: "把一个或几个文件、文件夹压缩成一个新的 .zip 文件（原文件不动；中文文件名在 Windows 上也正常）。",
  effect: "create",
  fields: {
    sources: s("要压缩的文件或文件夹，相对任务目录的路径；几个时每行一个"),
    destination: p("新 zip 文件的完整路径，以 .zip 结尾；不能是已有文件"),
  },
  pathFields: ["destination"],
  footprint: (_ws, a) => ({ reads: pathsOf(a.sources!), writes: [norm(a.destination!)], expectAfter: { [norm(a.destination!)]: "file:*" } }),
  pre: (ws, a) => {
    const srcs = pathsOf(a.sources!);
    if (!srcs.length) return "no files to compress";
    const bad = srcs.filter(badPath);
    if (bad.length) return `bad path ${bad[0]}`;
    const missing = srcs.filter((q) => !ws.exists(q));
    if (missing.length) return `${missing.join(", ")} does not exist`;
    const dst = norm(a.destination!);
    if (srcs.some((q) => dst === q || dst.startsWith(q + "/"))) return `${dst} would be inside what it compresses`;
    const names = entriesUnder(ws, srcs);
    if (names.length > ZIP_LIMITS.entries) return `${names.length} entries: more than a zip without zip64 can hold (${ZIP_LIMITS.entries})`;
    const total = sizeOf(ws, names);
    if (total > ZIP_LIMITS.totalBytes) return `${total} bytes to compress: more than ${ZIP_LIMITS.totalBytes} in one archive`;
    return newFile(ws, dst, ".zip");
  },
  run: (ws, a) => {
    const dst = norm(a.destination!), names = entriesUnder(ws, pathsOf(a.sources!));
    const data = writeZip(names.map((n) => ({ name: n, data: n.endsWith("/") ? Buffer.alloc(0) : ws.readBytes(n) })));
    return wrote(ws, dst, data, (file) => zipMatches(ws, file, names), { entries: names.filter((n) => !n.endsWith("/")) });
  },
  undoWrites: (_ws, a) => ({ remove: [norm(a.destination!)] }),
  undo: (ws, a, r) => removeOutput(ws, norm(a.destination!), r),
});

/** Formats macOS's textutil reads (converted to plain text first); anything else must be text already. */
const TEXTUTIL = new Set([".rtf", ".rtfd", ".doc", ".docx", ".odt", ".html", ".htm", ".webarchive", ".wordml"]);
const squash = (t: string) => t.replace(/\s+/g, "");

export const fsConvertToPdf = make({
  id: "fs.convert_to_pdf",
  description: "把一个文档（纯文本、Markdown、CSV，或 RTF、Word、HTML）转成一个新的 PDF 文件（原文件不动；只保留文字，不保留排版）。",
  effect: "create",
  fields: { source: p("要转换的文档"), destination: p("新 PDF 的完整路径，以 .pdf 结尾；不能是已有文件") },
  pathFields: ["source", "destination"],
  footprint: (_ws, a) => ({ reads: [norm(a.source!)], writes: [norm(a.destination!)], expectAfter: { [norm(a.destination!)]: "file:*" } }),
  pre: (ws, a) => {
    const src = norm(a.source!);
    const h = helperProblem();                     // the result is checked with PDFKit, through the helper
    if (h) return h;
    if (!ws.exists(src) || ws.isDir(src)) return `${src} is not an existing file`;
    if (!TEXTUTIL.has(path.extname(src).toLowerCase()) && !ws.isTextFile(src)) return `${src} is not a document this can convert`;
    return newFile(ws, norm(a.destination!), ".pdf");
  },
  run: (ws, a) => {
    const src = norm(a.source!), dst = norm(a.destination!);
    let text: string;
    if (TEXTUTIL.has(path.extname(src).toLowerCase())) {
      // -noload: never fetch what an HTML or Word file links to
      const t = run("/usr/bin/textutil", ["-noload", "-convert", "txt", "-stdout", ws.abs(src)], { maxBytes: 256 * 1024 * 1024 });
      if (!t.ok) return failed("textutil failed: " + t.stderr.slice(0, 200));
      text = t.stdout.toString("utf-8");
    } else text = ws.read(src);
    // cupsfilter reads a file; the plain text goes through a temporary one outside the task folder
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-pdf-"));
    let pdf: Buffer;
    try {
      fs.writeFileSync(path.join(dir, "in.txt"), text, "utf-8");
      const c = run("/usr/sbin/cupsfilter", ["-m", "application/pdf", path.join(dir, "in.txt")], { maxBytes: 512 * 1024 * 1024, timeoutMs: 300_000 });
      if (!c.ok || c.stdout.length === 0) return failed("cupsfilter failed: " + c.stderr.split("\n").filter((l) => !l.startsWith("DEBUG")).join(" ").slice(0, 200));
      pdf = c.stdout;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    // A PDF that PDFKit opens, with the document's text in it (its first line at least, ignoring line breaks).
    return wrote(ws, dst, pdf, (file) => {
      if (!pdf.subarray(0, 5).equals(Buffer.from("%PDF-"))) return "the output is not a PDF";
      const info = ask("pdf", file);
      if ("error" in info) return String(info.error);
      if (!(Number(info.pages) >= 1)) return "the PDF has no pages";
      const first = squash(text.split("\n").find((l) => l.trim()) ?? "").slice(0, 20);
      return first && !squash(String(info.text ?? "")).includes(first) ? "the PDF does not contain the document's text" : null;
    });
  },
  undoWrites: (_ws, a) => ({ remove: [norm(a.destination!)] }),
  undo: (ws, a, r) => removeOutput(ws, norm(a.destination!), r),
});

const IMAGES = new Set([".png", ".jpg", ".jpeg", ".heic", ".tif", ".tiff", ".gif", ".bmp", ".webp"]);

export const fsOcrImage = make({
  id: "fs.ocr_image",
  description: "识别一张图片里的文字（中文、英文），按从上到下的行写成一个新的文本文件（原图不动）。在本机完成，不上传。",
  effect: "create",
  fields: { source: p("要识别的图片（png、jpg、heic 等）"), destination: p("写入识别结果的新文本文件的完整路径；不能是已有文件") },
  pathFields: ["source", "destination"],
  footprint: (_ws, a) => ({ reads: [norm(a.source!)], writes: [norm(a.destination!)], expectAfter: { [norm(a.destination!)]: "file:*" } }),
  pre: (ws, a) => {
    const src = norm(a.source!);
    const h = helperProblem();
    if (h) return h;
    if (!ws.exists(src) || ws.isDir(src)) return `${src} is not an existing file`;
    if (!IMAGES.has(path.extname(src).toLowerCase()) || isText(ws.readBytes(src))) return `${src} is not an image`;
    return newFile(ws, norm(a.destination!));
  },
  run: (ws, a) => {
    const got = ask("ocr", ws.abs(norm(a.source!)));
    if ("error" in got) return failed(String(got.error));
    const lines = (got.lines as string[] | undefined) ?? [];
    if (!lines.length) return failed("no text was found in the image");
    return wrote(ws, norm(a.destination!), lines.join("\n") + "\n", () => null, { lines: lines.length });
  },
  undoWrites: (_ws, a) => ({ remove: [norm(a.destination!)] }),
  undo: (ws, a, r) => removeOutput(ws, norm(a.destination!), r),
});

/** What a registry offers now. The text rewrite and zip work anywhere. PDF and OCR need the macOS helper and are
 *  offered only once it answers, so a goal or plan never counts on a tool that cannot run (a process that wants them
 *  calls mac.prepareHelper() first; the eval runner does). */
export function toolCapabilities(): Capability[] {
  return [fsTransformText, fsZipFiles, ...(helperBin() ? [fsConvertToPdf, fsOcrImage] : [])];
}
