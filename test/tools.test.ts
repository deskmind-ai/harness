/** Capabilities that make a file with a tool (src/registry/tools.ts): a model rewrite, zip, PDF, OCR. Each is run,
 *  checked and undone here on real files; the macOS ones run on a Mac only. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Gateway, type Scripted } from "../src/gateway/index.js";
import { Orchestrator, type CardUser } from "../src/orchestrator/index.js";
import type { Capability, ExecResult } from "../src/registry/capability.js";
import { fileRegistry, fsReadText } from "../src/registry/fs.js";
import { IS_MAC, run } from "../src/registry/mac.js";
import { matches } from "../src/registry/reconcile.js";
import { fsConvertToPdf, fsOcrImage, fsTransformText, fsZipFiles } from "../src/registry/tools.js";
import { Workspace, build } from "../src/registry/workspace.js";
import { crc32 } from "../src/registry/zip.js";
import { deflateSync } from "node:zlib";

/** A plain white PNG: a picture with no text in it. */
function blankPng(size = 64): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 0;
  const rows = Buffer.concat(Array.from({ length: size }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(size, 255)])));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

const ROLES = ["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"];
const table = Object.fromEntries(ROLES.map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
const byRole = (a: Record<string, unknown>): Scripted => (role) => a[role] ?? { outcome: "error", error: `no scripted answer for ${role}` };
const nobody: CardUser = { ask: () => null };

function ws(files: Record<string, string | null>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-tools-"));
  build(root, files);
  return new Workspace(root);
}

/** Run one capability the way the orchestrator does: typecheck, preconditions, execute, then the receipt check. */
function act(w: Workspace, cap: Capability, args: Record<string, string>): { r: ExecResult; ok: boolean } {
  expect(cap.typecheck(args)).toBeNull();
  expect(cap.preconditions(w, args)).toBeNull();
  const expectAfter = cap.footprint(w, args).expectAfter;
  const r = cap.execute(w, args);
  w.invalidate();
  return { r, ok: r.status !== "failed" && matches(expectAfter, w) };
}

const mac = IS_MAC ? it : it.skip;

describe("tool capabilities", () => {
  it("all register: the contract holds, and the planner sees them with the file capabilities", () => {
    const ids = fileRegistry().list().map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["fs.transform_text", "fs.zip_files"]));
    if (IS_MAC) expect(ids).toEqual(expect.arrayContaining(["fs.convert_to_pdf", "fs.ocr_image"]));
  });

  it("transform_text writes the model's text as a new file; the text is part of the arguments; undo removes it", () => {
    const w = ws({ "summary.csv": "内容\n", "other.txt": "x" });
    const args = { source: "summary.csv", instruction: "翻译成英文", destination: "summary_en.csv" };
    expect(fsTransformText.derive!(w, args)).toEqual({ field: "text", instruction: "翻译成英文", source: "内容\n" });
    // without the derived text nothing is written
    const none = fsTransformText.execute(w, args);
    expect(none.status).toBe("failed");
    expect(w.exists("summary_en.csv")).toBe(false);
    const { r, ok } = act(w, fsTransformText, { ...args, text: "Content\n" });
    expect(ok).toBe(true);
    expect(w.read("summary_en.csv")).toBe("Content\n");
    expect(w.read("summary.csv")).toBe("内容\n");
    expect(fsTransformText.undo!(w, args, r)).toBeNull();
    w.invalidate();
    expect(w.exists("summary_en.csv")).toBe(false);
  });

  it("transform_text refuses a missing, binary or existing target up front", () => {
    const w = ws({ "a.txt": "x", "b.txt": "y" });
    fs.writeFileSync(w.abs("pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
    w.invalidate();
    expect(fsTransformText.preconditions(w, { source: "nope.txt", instruction: "翻译", destination: "c.txt" })).toMatch(/not an existing file/);
    expect(fsTransformText.preconditions(w, { source: "pic.png", instruction: "翻译", destination: "c.txt" })).toMatch(/not a text file/);
    expect(fsTransformText.preconditions(w, { source: "a.txt", instruction: "翻译", destination: "b.txt" })).toMatch(/already exists/);
    expect(fsTransformText.typecheck({ source: "a.txt", instruction: "翻译", destination: "c.txt", other: "x" })).toMatch(/unexpected/);
  });

  it("a translate request is planned, the rewrite is asked once, written and verified (evalset lack task)", async () => {
    const w = ws({ "summary.csv": "内容", "other.txt": "x" });
    const gw = new Gateway(table);
    let transformAsked = "";
    const all: Scripted = (role, _sys, user) => {
      if (role === "transform") { transformAsked = user; return { text: "Content" }; }
      return byRole({
        goal: { requirements: [{ id: "r1", statement: "有一份英文的 summary_en.csv", check: { kind: "deterministic", name: "file_exists", args: { path: "summary_en.csv" } }, quotes: ["翻译成英文另存一份"] }], constraints: ["原文件不动"], missing: [], feasible: "yes" },
        plan: { nodes: [{ id: "n1", capability: "fs.transform_text", depends_on: [], purpose: "翻译并另存", requirement_ids: ["r1"] }], outcome: "plan" },
        bind: { bindings: { source: { kind: "resource_ref", path: "summary.csv" }, instruction: { kind: "literal", value: "翻译成英文", authority: "原文：翻译成英文" }, destination: { kind: "literal", value: "summary_en.csv", authority: "另存一份，名字按惯例加 _en" } }, unresolved: [] },
        intent: { verdict: "matches", reason: "ok" },
        choice: { choice: "act" },
      })(role, _sys, user);
    };
    gw.script = Array(12).fill(all);
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-tools-log-")), "log.jsonl");
    const o = new Orchestrator(log, w, gw, nobody, fileRegistry());
    o.start("把 summary.csv 翻译成英文另存一份");
    const s = await o.run();
    expect(s.status, `${s.reason} ${JSON.stringify(o.log.events.filter((e: any) => ["decision.rejected", "node.failed", "model.reply"].includes(e.kind)).map((e: any) => [e.kind, e.role, e.why, e.outcome, e.error]))}`).toBe("succeeded");
    w.invalidate();
    expect(w.read("summary_en.csv")).toBe("Content");
    expect(w.read("summary.csv")).toBe("内容");
    expect(transformAsked).toContain("翻译成英文");
    expect(s.counters["calls:transform"]).toBe(1);
    // the execution intent records the text, so a replay after a crash writes the same thing
    const intent = o.log.events.find((e: any) => e.kind === "execution.intent") as any;
    expect(intent.command.args.text).toBe("Content");
  });

  it("zip_files: the archive holds exactly the files, byte for byte; undo removes it", () => {
    const w = ws({ "readme.csv": "a,b\n1,2\n", "资料/说明.txt": "中文\n", "other.txt": "x" });
    const args = { sources: "readme.csv\n资料", destination: "包.zip" };
    const { r, ok } = act(w, fsZipFiles, args);
    expect(ok).toBe(true);
    expect(r.output.entries).toEqual(["readme.csv", "资料/说明.txt"]);
    expect(run("/usr/bin/unzip", ["-p", w.abs("包.zip"), "资料/说明.txt"]).stdout.toString()).toBe("中文\n");
    // a zip is not text: the listing shows it without a preview, and read_text refuses it
    expect(w.listing().entries.find((e) => e.path === "包.zip")).toMatchObject({ binary: true });
    expect(w.listing().entries.find((e) => e.path === "包.zip")!.preview).toBeUndefined();
    expect(fsReadText.preconditions(w, { target: "包.zip" })).toMatch(/not a text file/);
    expect(fsZipFiles.undo!(w, args, r)).toBeNull();
    w.invalidate();
    expect(w.exists("包.zip")).toBe(false);
    expect(w.read("readme.csv")).toBe("a,b\n1,2\n");
  });

  it("zip_files refuses bad input before running", () => {
    const w = ws({ "a.txt": "x", "old.zip": "z" });
    expect(fsZipFiles.preconditions(w, { sources: "a.txt", destination: "a.tar" })).toMatch(/\.zip/);
    expect(fsZipFiles.preconditions(w, { sources: "a.txt", destination: "old.zip" })).toMatch(/already exists/);
    expect(fsZipFiles.preconditions(w, { sources: "a.txt\nnope.txt", destination: "b.zip" })).toMatch(/nope.txt does not exist/);
    expect(fsZipFiles.preconditions(w, { sources: "../etc/passwd", destination: "b.zip" })).toMatch(/bad path/);
  });

  it("an undo refuses when the output changed after the action", () => {
    const w = ws({ "a.txt": "x" });
    const args = { sources: "a.txt", destination: "a.zip" };
    const { r } = act(w, fsZipFiles, args);
    fs.appendFileSync(w.abs("a.zip"), "tampered");
    w.invalidate();
    expect(fsZipFiles.undo!(w, args, r)).toMatch(/changed since the action/);
    expect(w.exists("a.zip")).toBe(true);
  });

  mac("convert_to_pdf: plain text and RTF become a PDF with the text in it; undo removes it", () => {
    const w = ws({ "list.txt": "周会纪要\n1. 发布日期 10 月 15 日\nHello\n" });
    const { r, ok } = act(w, fsConvertToPdf, { source: "list.txt", destination: "list.pdf" });
    expect(ok).toBe(true);
    expect(w.readBytes("list.pdf").subarray(0, 5).toString()).toBe("%PDF-");
    expect(fsConvertToPdf.undo!(w, { source: "list.txt", destination: "list.pdf" }, r)).toBeNull();
    w.invalidate();
    expect(w.exists("list.pdf")).toBe(false);
    // RTF goes through textutil first
    run("/usr/bin/textutil", ["-convert", "rtf", "-output", w.abs("memo.rtf"), w.abs("list.txt")]);
    w.invalidate();
    expect(act(w, fsConvertToPdf, { source: "memo.rtf", destination: "memo.pdf" }).ok).toBe(true);
  });

  mac("ocr_image: the text in a picture becomes a new text file; a picture with no text writes nothing", () => {
    const w = ws({ "page.txt": "周会纪要\n\n发布日期 十月十五日\n" });
    // a picture of a page: the text as a PDF, rendered to PNG
    expect(act(w, fsConvertToPdf, { source: "page.txt", destination: "page.pdf" }).ok).toBe(true);
    run("/usr/bin/sips", ["-s", "format", "png", "-Z", "2400", w.abs("page.pdf"), "--out", w.abs("page.png")]);
    w.invalidate();
    const args = { source: "page.png", destination: "page-ocr.txt" };
    const { r, ok } = act(w, fsOcrImage, args);
    expect(ok).toBe(true);
    expect(w.read("page-ocr.txt")).toContain("周会纪要");
    expect(fsOcrImage.undo!(w, args, r)).toBeNull();
    // a blank picture: the tool reports why, and leaves no file
    fs.writeFileSync(w.abs("blank.png"), blankPng());
    w.invalidate();
    const blank = fsOcrImage.execute(w, { source: "blank.png", destination: "blank.txt" });
    expect(blank.status).toBe("failed");
    expect(blank.why).toMatch(/no text/);
    w.invalidate();
    expect(w.exists("blank.txt")).toBe(false);
    expect(fsOcrImage.preconditions(w, { source: "page.txt", destination: "x.txt" })).toMatch(/not an image/);
  });

  mac("a tool that fails its own check fails the step with its reason, and the run says so", async () => {
    const w = ws({});
    fs.writeFileSync(w.abs("blank.png"), blankPng());
    w.invalidate();
    const gw = new Gateway(table);
    gw.script = Array(12).fill(byRole({
      goal: { requirements: [{ id: "r1", statement: "有识别结果 out.txt", check: { kind: "deterministic", name: "file_exists", args: { path: "out.txt" } }, quotes: ["识别"] }], constraints: [], missing: [], feasible: "yes" },
      plan: { nodes: [{ id: "n1", capability: "fs.ocr_image", depends_on: [], purpose: "识别", requirement_ids: ["r1"] }], outcome: "plan" },
      bind: { bindings: { source: { kind: "resource_ref", path: "blank.png" }, destination: { kind: "literal", value: "out.txt", authority: "识别结果存为 out.txt" } }, unresolved: [] },
      intent: { verdict: "matches", reason: "ok" },
      choice: { choice: "act" },
    }));
    const log = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-tools-log-")), "log.jsonl");
    const o = new Orchestrator(log, w, gw, nobody, fileRegistry());
    o.start("识别 blank.png 里的文字");
    const s = await o.run();
    expect(s.status).not.toBe("succeeded");
    const failed = o.log.events.find((e: any) => e.kind === "node.failed") as any;
    expect(failed.why).toMatch(/no text was found/);
    w.invalidate();
    expect(w.exists("out.txt")).toBe(false);
  });
});
