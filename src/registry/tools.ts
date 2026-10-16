/**
 * Capabilities that make a new file with a tool: a model rewriting text (translate, summarise, rewrite), and macOS
 * built-ins (PDF, OCR) or Node's own zlib (zip). Requests like these were refused as "needs a capability we lack" although the means were
 * on the Mac (evalset v2's lack tasks, 10-16): each closes one such gap. Every one only creates its output file, so
 * undo deletes it, and each checks its own output before reporting success: a tool that ran but made the wrong thing
 * leaves nothing behind and the step fails with the reason.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Capability, ExecResult } from "./capability.js";
import { IS_MAC, ask, helper, run } from "./mac.js";
import { after, folderOk, make, maybeCrash, norm, p, parentOf, s, untouched } from "./spec.js";
import { ABSENT, isText, sha, type Workspace } from "./workspace.js";
import { readZip, writeZip } from "./zip.js";

/** The longest source a model rewrites in one step; a longer file is refused up front rather than cut. */
const TRANSFORM_MAX_CHARS = 40_000;

const pathsOf = (list: string) => list.split("\n").map(norm).filter(Boolean);
const badPath = (q: string) => q.split("/").includes("..");

/** The destination is new, in an existing folder, with the extension the tool writes (when it writes one). */
function newFile(ws: Workspace, dst: string, ext?: string): string | null {
  if (ext && path.extname(dst).toLowerCase() !== ext) return `${dst} must end with ${ext}`;
  if (ws.exists(dst)) return `${dst} already exists`;
  return folderOk(ws, parentOf(dst)) ? null : `folder ${parentOf(dst)} does not exist`;
}

/** Write a tool's output as a new file and report it; refuses (nothing written) when the check fails. */
function wrote(ws: Workspace, dst: string, data: Buffer | string, check: () => string | null, output: Record<string, unknown> = {}): ExecResult {
  fs.writeFileSync(ws.abs(dst), data, { flag: "wx" });
  const err = check();
  if (err) {
    fs.unlinkSync(ws.abs(dst));
    return { status: "failed", why: err, output: {}, versions_after: { [dst]: ABSENT } };
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
  derive: { field: "text", from: (ws, a) => ({ instruction: a.instruction!, source: ws.read(norm(a.source!)) }) },
  footprint: (_ws, a) => { const dst = norm(a.destination!); return { reads: [norm(a.source!)], writes: [dst], expectAfter: { [dst]: typeof a.text === "string" ? sha(a.text) : "file:*" } }; },
  pre: (ws, a) => {
    const src = norm(a.source!);
    if (!ws.exists(src) || ws.isDir(src)) return `${src} is not an existing file`;
    if (!ws.isTextFile(src)) return `${src} is not a text file`;
    if (ws.read(src).length > TRANSFORM_MAX_CHARS) return `${src} is longer than ${TRANSFORM_MAX_CHARS} characters, too long to rewrite in one step`;
    return newFile(ws, norm(a.destination!));
  },
  run: (ws, a) => {
    const dst = norm(a.destination!);
    if (typeof a.text !== "string") return { status: "failed", why: "the rewritten text was never produced", output: {}, versions_after: {} };
    return wrote(ws, dst, a.text, () => null);
  },
  undo: (ws, a, r) => removeOutput(ws, norm(a.destination!), r),
});

/** Every file and folder under the given paths, as zip entry names (folders end with "/"), in the listing's order. */
function entriesUnder(ws: Workspace, sources: string[]): string[] {
  const out: string[] = [];
  const all = Object.entries(ws.entries());
  for (const q of sources) {
    if (!ws.isDir(q)) { out.push(q); continue; }
    out.push(q + "/");
    for (const [p, v] of all) if (p.startsWith(q + "/")) out.push(v === "dir" ? p + "/" : p);
  }
  return [...new Set(out)];
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
    return newFile(ws, dst, ".zip");
  },
  run: (ws, a) => {
    const dst = norm(a.destination!), names = entriesUnder(ws, pathsOf(a.sources!));
    const data = writeZip(names.map((n) => ({ name: n, data: n.endsWith("/") ? Buffer.alloc(0) : ws.readBytes(n) })));
    // Read back: exactly these entries, each byte for byte (and, on a Mac, as the system's unzip extracts it).
    return wrote(ws, dst, data, () => {
      let got: { name: string; data: Buffer }[];
      try { got = readZip(ws.readBytes(dst)); } catch (e) { return "the archive cannot be read back: " + String(e); }
      if (got.map((e) => e.name).join("\n") !== names.join("\n")) return "the archive's entries differ from the files";
      for (const e of got) {
        if (e.name.endsWith("/")) continue;
        if (!e.data.equals(ws.readBytes(e.name))) return `${e.name} in the archive differs from the file`;
        if (fs.existsSync("/usr/bin/unzip")) {
          const u = run("/usr/bin/unzip", ["-p", ws.abs(dst), e.name]);
          if (!u.ok || !u.stdout.equals(e.data)) return `the system unzip reads ${e.name} differently`;
        }
      }
      return null;
    }, { entries: names.filter((n) => !n.endsWith("/")) });
  },
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
    if (!IS_MAC) return "needs macOS";
    if (!ws.exists(src) || ws.isDir(src)) return `${src} is not an existing file`;
    if (!TEXTUTIL.has(path.extname(src).toLowerCase()) && !ws.isTextFile(src)) return `${src} is not a document this can convert`;
    return newFile(ws, norm(a.destination!), ".pdf");
  },
  run: (ws, a) => {
    const src = norm(a.source!), dst = norm(a.destination!);
    let text: string;
    if (TEXTUTIL.has(path.extname(src).toLowerCase())) {
      const t = run("/usr/bin/textutil", ["-convert", "txt", "-stdout", ws.abs(src)]);
      if (!t.ok) return { status: "failed", why: "textutil failed: " + t.stderr.slice(0, 200), output: {}, versions_after: {} };
      text = t.stdout.toString("utf-8");
    } else text = ws.read(src);
    // cupsfilter reads a file; the plain text goes through a temporary one outside the task folder
    const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-pdf-")), "in.txt");
    fs.writeFileSync(tmp, text, "utf-8");
    const c = run("/usr/sbin/cupsfilter", ["-m", "application/pdf", tmp]);
    fs.rmSync(path.dirname(tmp), { recursive: true, force: true });
    if (!c.ok || c.stdout.length === 0) return { status: "failed", why: "cupsfilter failed: " + c.stderr.split("\n").filter((l) => !l.startsWith("DEBUG")).join(" ").slice(0, 200), output: {}, versions_after: {} };
    // A PDF that PDFKit opens, with the document's text in it (its first line at least, ignoring line breaks).
    return wrote(ws, dst, c.stdout, () => {
      if (!c.stdout.subarray(0, 5).equals(Buffer.from("%PDF-"))) return "the output is not a PDF";
      const info = ask("pdf", ws.abs(dst));
      if ("error" in info) return String(info.error);
      if (!(Number(info.pages) >= 1)) return "the PDF has no pages";
      const first = squash(text.split("\n").find((l) => l.trim()) ?? "").slice(0, 20);
      return first && !squash(String(info.text ?? "")).includes(first) ? "the PDF does not contain the document's text" : null;
    });
  },
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
    if (!IS_MAC) return "needs macOS";
    if (!ws.exists(src) || ws.isDir(src)) return `${src} is not an existing file`;
    if (!IMAGES.has(path.extname(src).toLowerCase()) || isText(ws.readBytes(src))) return `${src} is not an image`;
    const h = helper();
    if ("error" in h) return h.error;
    return newFile(ws, norm(a.destination!));
  },
  run: (ws, a) => {
    const dst = norm(a.destination!);
    const got = ask("ocr", ws.abs(norm(a.source!)));
    if ("error" in got) return { status: "failed", why: String(got.error), output: {}, versions_after: {} };
    const lines = (got.lines as string[] | undefined) ?? [];
    if (!lines.length) return { status: "failed", why: "no text was found in the image", output: {}, versions_after: {} };
    return wrote(ws, dst, lines.join("\n") + "\n", () => null, { lines: lines.length });
  },
  undo: (ws, a, r) => removeOutput(ws, norm(a.destination!), r),
});

/** The text rewrite and zip work anywhere; PDF and OCR need macOS's tools and are offered only on a Mac. */
export const TOOL_CAPABILITIES: Capability[] = [fsTransformText, fsZipFiles, ...(IS_MAC ? [fsConvertToPdf, fsOcrImage] : [])];

