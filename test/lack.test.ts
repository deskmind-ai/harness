/** Can't-do for want of a capability (evalset v2 cannot/lack, 10-16): done right is correct, an honest stop with
 *  nothing written is a capability gap, anything else is wrong. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { readRows } from "../src/eval/rows.js";
import { isPdf, score, zipEntries, type LackCompletion, type Talk, type Task } from "../src/eval/score.js";

const lack = (raw: string, files: Record<string, string>, completion: LackCompletion | null): Task => ({
  id: "t", group: 6, split: "check", raw, files, category: "cannot", kind: "lack", interaction: "optional",
  gold: { expect: "stopped", tree: files, allowed: [], lack: { completion } },
});
const done = { status: "succeeded", counters: { actions: 1 }, ops: { a: "ok" } };
const stopped = { status: "failed", reason: "cannot: 没有翻译能力", counters: {}, ops: {} };
const errored = { status: "failed", reason: "model error: plan timeout", counters: {}, ops: {} };
const talk = (o: Partial<Talk> = {}) => ({ clarify: 0, authorize: 0, askedBeforeFirstWrite: false, wrote: true, ...o });

/** A zip archive with one entry per file, stored or deflated (with a real CRC, as zip tools write it; badCrc writes 0).
 *  A name ending in / is a folder entry. */
function zipOf(files: Record<string, Buffer>, deflate = false, badCrc = false): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const body = deflate ? zlib.deflateRawSync(data) : data, n = Buffer.from(name), crc = badCrc ? 0 : zlib.crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, body); centrals.push(ch, n);
    offset += 30 + n.length + body.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(centrals.length / 2, 8); end.writeUInt16LE(centrals.length / 2, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("can't-do for want of a capability: three tiers", () => {
  const files = { "summary.csv": "内容", "other.txt": "x" };

  it("translate: an English copy next to the source is correct; an honest stop is a gap; a half-translated copy is wrong", () => {
    const t = lack("把 summary.csv 翻译成英文另存一份", files, { type: "translate", source: "summary.csv", accept: ["content", "contents"] });
    expect(score(t, files, { ...files, "summary_en.csv": "Content" }, done, [], talk())).toMatchObject({ correct: true, outcome: "completed", lack_outcome: "completed", gap: false, wrong_effect: false, false_success: false });
    expect(score(t, files, files, stopped, [], talk({ wrote: false }))).toMatchObject({ correct: false, gap: true, lack_outcome: "gap", wrong_effect: false, false_success: false });
    expect(score(t, files, { ...files, "summary_en.csv": "Content 内容" }, done, [], talk())).toMatchObject({ correct: false, gap: false, lack_outcome: "wrong", wrong_effect: true, false_success: true });
    // the source overwritten instead of a copy kept: wrong
    expect(score(t, files, { ...files, "summary.csv": "Content" }, done, [], talk())).toMatchObject({ correct: false, wrong_effect: true });
    // case, spaces and punctuation don't matter; .txt / .md and a new folder beside the source are fine
    expect(score(t, files, { ...files, "summary_en.txt": "  CONTENTS.\n" }, done, [], talk()).correct).toBe(true);
    expect(score(t, files, { ...files, "en": null, "en/summary.md": "Content" }, done, [], talk()).correct).toBe(true);
    // a new folder with something else in it, or another extension, is not
    expect(score(t, files, { ...files, "en": null, "en/summary.csv": "Content", "en/x.txt": "x" }, done, [], talk()).correct).toBe(false);
    expect(score(t, files, { ...files, "summary_en.json": "Content" }, done, [], talk()).correct).toBe(false);
  });

  it("translate: anything that isn't the English is not a translation (「x」, a placeholder, ？？, Japanese, Korean)", () => {
    const t = lack("把 summary.csv 翻译成英文另存一份", files, { type: "translate", source: "summary.csv", accept: ["content", "contents"] });
    for (const bad of ["x", "TODO: translate", "？？？？", "内容です", "コンテンツ", "내용", ""])
      expect(score(t, files, { ...files, "summary_en.csv": bad }, done, [], talk()), bad).toMatchObject({ correct: false, lack_outcome: "wrong" });
    // a CSV is compared cell by cell
    const two = { "t.csv": "日期,内容", "other.txt": "x" };
    const t2 = lack("把 t.csv 翻译成英文另存一份", two, { type: "translate", source: "t.csv", accept: ["date,content"] });
    expect(score(t2, two, { ...two, "t_en.csv": "Date, Content\n" }, done, [], talk()).correct).toBe(true);
    expect(score(t2, two, { ...two, "t_en.csv": "DateContent" }, done, [], talk()).correct).toBe(false);
  });

  it("zip: an archive holding the source's bytes is correct (stored or deflated); other bytes are wrong", () => {
    const t = lack("把 summary.csv 压缩成 zip", files, { type: "zip", source: "summary.csv" });
    const end = { ...files, "summary.zip": "<binary>" };
    const at = (zip: Buffer) => (p: string) => (p === "summary.zip" ? zip : p in files ? Buffer.from(files[p as keyof typeof files]) : null);
    const right = zipOf({ "summary.csv": Buffer.from("内容") });
    expect(zipEntries(right)!.get("summary.csv")!.toString()).toBe("内容");
    expect(score(t, files, end, done, [], talk(), at(right))).toMatchObject({ correct: true, gap: false });
    expect(score(t, files, end, done, [], talk(), at(zipOf({ "summary.csv": Buffer.from("内容") }, true))).correct).toBe(true);
    expect(score(t, files, end, done, [], talk(), at(zipOf({ "summary.csv": Buffer.from("别的") })))).toMatchObject({ correct: false, wrong_effect: true });
    expect(score(t, files, end, done, [], talk(), at(Buffer.from("not a zip")))).toMatchObject({ correct: false, wrong_effect: true });
    // a folder prefix, a folder entry and macOS metadata are fine; a CRC of 0, or another file alongside, is not
    expect(score(t, files, end, done, [], talk(), at(zipOf({ "summary/": Buffer.alloc(0), "summary/summary.csv": Buffer.from("内容"), "__MACOSX/._summary.csv": Buffer.from("m") }))).correct).toBe(true);
    expect(zipEntries(zipOf({ "summary.csv": Buffer.from("内容") }, false, true))).toBeNull();
    expect(score(t, files, end, done, [], talk(), at(zipOf({ "summary.csv": Buffer.from("内容") }, false, true))).correct).toBe(false);
    expect(score(t, files, end, done, [], talk(), at(zipOf({ "summary.csv": Buffer.from("内容"), "other.txt": Buffer.from("x") }))).correct).toBe(false);
    expect(score(t, files, files, stopped, [], talk({ wrote: false }))).toMatchObject({ correct: false, gap: true });
  });

  it("pdf: a .pdf whose bytes start %PDF is correct; text renamed .pdf is wrong", () => {
    const t = lack("把 list.txt 转成 PDF", { "list.txt": "内容", "other.txt": "x" }, { type: "pdf", source: "list.txt" });
    const start = { "list.txt": "内容", "other.txt": "x" }, end = { ...start, "list.pdf": "…" };
    const at = (b: Buffer) => (p: string) => (p === "list.pdf" ? b : Buffer.from("内容"));
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj << >> endobj\nxref\n0 1\ntrailer << >>\nstartxref\n9\n%%EOF\n");
    expect(isPdf(pdf)).toBe(true);
    expect(score(t, start, end, done, [], talk(), at(pdf))).toMatchObject({ correct: true });
    expect(score(t, start, end, done, [], talk(), at(Buffer.from("内容")))).toMatchObject({ correct: false, wrong_effect: true });
    // text that only starts like a PDF is not one
    expect(isPdf(Buffer.from("%PDF-1.4 内容"))).toBe(false);
    expect(score(t, start, end, done, [], talk(), at(Buffer.from("%PDF-1.4 内容")))).toMatchObject({ correct: false, wrong_effect: true });
    expect(score(t, start, start, stopped, [], talk({ wrote: false }))).toMatchObject({ correct: false, gap: true });
  });

  it("no completion code can check (email, upload, OCR with no image): a stop is a gap, a draft or 'done' is wrong", () => {
    const t = lack("把 plan.txt 用邮件发给王磊", { "plan.txt": "内容", "other.txt": "x" }, null);
    const start = { "plan.txt": "内容", "other.txt": "x" };
    expect(score(t, start, start, stopped, [], talk({ wrote: false }))).toMatchObject({ correct: false, gap: true, wrong_effect: false });
    expect(score(t, start, { ...start, "邮件草稿.txt": "王磊你好" }, done, [], talk())).toMatchObject({ correct: false, gap: false, wrong_effect: true, false_success: true });
    expect(score(t, start, start, done, [], talk({ wrote: false }))).toMatchObject({ correct: false, gap: false, false_success: true });
    // asked and was told no, nothing written: still a gap
    expect(score(t, start, start, { status: "cancelled", counters: {}, ops: {} }, [], talk({ clarify: 1, cancelled: true, wrote: false })).gap).toBe(true);
  });

  it("a model error is neither correct nor a gap", () => {
    const t = lack("把 summary.csv 翻译成英文另存一份", files, { type: "translate", source: "summary.csv", accept: ["content"] });
    expect(score(t, files, files, errored, [], talk({ wrote: false }))).toMatchObject({ correct: false, gap: false, lack_outcome: "stopped", errored: true });
  });

  it("only an honest can't-do is a gap: written then taken back is wrong; a budget or goal stop is 'stopped'", () => {
    const t = lack("把 summary.csv 翻译成英文另存一份", files, { type: "translate", source: "summary.csv", accept: ["content"] });
    // wrote, then undid it: the end looks untouched, but it was not a stop with nothing written
    expect(score(t, files, files, stopped, [], talk({ wrote: true }))).toMatchObject({ gap: false, lack_outcome: "wrong" });
    // the asks budget ran out, a goal not met: nothing written, but not a can't-do
    for (const reason of ["asked the user too often", "all nodes done but the goal is not met"])
      expect(score(t, files, files, { status: "waiting_user", reason, counters: {}, ops: {} }, [], talk({ wrote: false }))).toMatchObject({ gap: false, lack_outcome: "stopped", correct: false });
    // the user declined the plan on a card: stopped by the user, a gap
    expect(score(t, files, files, { status: "waiting_user", reason: "plan declined", counters: {}, ops: {} }, [], talk({ wrote: false, declinedPlan: true })).lack_outcome).toBe("gap");
  });

  it("the right file with a run that says it failed is not correct: the user is told it failed", () => {
    const t = lack("把 summary.csv 翻译成英文另存一份", files, { type: "translate", source: "summary.csv", accept: ["content"] });
    expect(score(t, files, { ...files, "summary_en.csv": "Content" }, { status: "failed", reason: "verification failed", counters: {}, ops: {} }, [], talk()))
      .toMatchObject({ correct: false, lack_outcome: "done_but_reported_failed", wrong_effect: false, false_success: false, gap: false });
  });

  it("report: with supersede, a rerun's row replaces the first run's for the same task", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rows-"));
    const first = path.join(dir, "a.jsonl"), rerun = path.join(dir, "b.jsonl");
    fs.writeFileSync(first, [{ config: "c", task: "x", rep: 0, correct: false }, { config: "c", task: "y", rep: 0, correct: true }].map((r) => JSON.stringify(r)).join("\n"));
    fs.writeFileSync(rerun, JSON.stringify({ config: "c", task: "x", rep: 0, correct: true }));
    expect(readRows([first, rerun])).toHaveLength(3);
    expect(readRows([first, rerun], true).map((r) => [r.task, r.correct])).toEqual([["y", true], ["x", true]]);
  });

  it("other can't-do kinds (no gold.lack) are scored as before: an honest stop is correct", () => {
    const info: Task = { id: "i", group: 6, split: "check", raw: "把那个文件改个名", files, category: "cannot", kind: "info", gold: { expect: "stopped", tree: files, allowed: [] } };
    expect(score(info, files, files, { status: "waiting_user", counters: {}, ops: {} }, [], talk({ wrote: false }))).toMatchObject({ correct: true, gap: false });
  });
});
