/** Can't-do for want of a capability (evalset v2 cannot/lack, 10-16): done right is correct, an honest stop with
 *  nothing written is a capability gap, anything else is wrong. */
import * as zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { score, zipEntries, type LackCompletion, type Talk, type Task } from "../src/eval/score.js";

const lack = (raw: string, files: Record<string, string>, completion: LackCompletion | null): Task => ({
  id: "t", group: 6, split: "check", raw, files, category: "cannot", kind: "lack", interaction: "optional",
  gold: { expect: "stopped", tree: files, allowed: [], lack: { completion } },
});
const done = { status: "succeeded", counters: { actions: 1 }, ops: { a: "ok" } };
const stopped = { status: "failed", reason: "cannot: 没有翻译能力", counters: {}, ops: {} };
const errored = { status: "failed", reason: "model error: plan timeout", counters: {}, ops: {} };
const talk = (o: Partial<Talk> = {}) => ({ clarify: 0, authorize: 0, askedBeforeFirstWrite: false, wrote: true, ...o });

/** A zip archive with one entry per file, stored or deflated (with a real CRC, as zip tools write it). */
function zipOf(files: Record<string, Buffer>, deflate = false): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, data] of Object.entries(files)) {
    const body = deflate ? zlib.deflateRawSync(data) : data, n = Buffer.from(name), crc = zlib.crc32(data);
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
    const t = lack("把 summary.csv 翻译成英文另存一份", files, { type: "translate", source: "summary.csv" });
    expect(score(t, files, { ...files, "summary_en.csv": "Content" }, done, [], talk())).toMatchObject({ correct: true, outcome: "completed", gap: false, wrong_effect: false, false_success: false });
    expect(score(t, files, files, stopped, [], talk({ wrote: false }))).toMatchObject({ correct: false, gap: true, wrong_effect: false, false_success: false });
    expect(score(t, files, { ...files, "summary_en.csv": "Content 内容" }, done, [], talk())).toMatchObject({ correct: false, gap: false, wrong_effect: true, false_success: true });
    // the source overwritten instead of a copy kept, another extension, or the copy in another folder: wrong
    expect(score(t, files, { ...files, "summary.csv": "Content" }, done, [], talk())).toMatchObject({ correct: false, wrong_effect: true });
    expect(score(t, files, { ...files, "summary_en.txt": "Content" }, done, [], talk()).correct).toBe(false);
    expect(score(t, files, { ...files, "en": null, "en/summary.csv": "Content" }, done, [], talk()).correct).toBe(false);
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
    expect(score(t, files, files, stopped, [], talk({ wrote: false }))).toMatchObject({ correct: false, gap: true });
  });

  it("pdf: a .pdf whose bytes start %PDF is correct; text renamed .pdf is wrong", () => {
    const t = lack("把 list.txt 转成 PDF", { "list.txt": "内容", "other.txt": "x" }, { type: "pdf", source: "list.txt" });
    const start = { "list.txt": "内容", "other.txt": "x" }, end = { ...start, "list.pdf": "…" };
    const at = (b: Buffer) => (p: string) => (p === "list.pdf" ? b : Buffer.from("内容"));
    expect(score(t, start, end, done, [], talk(), at(Buffer.from("%PDF-1.4\n…")))).toMatchObject({ correct: true });
    expect(score(t, start, end, done, [], talk(), at(Buffer.from("内容")))).toMatchObject({ correct: false, wrong_effect: true });
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
    const t = lack("把 summary.csv 翻译成英文另存一份", files, { type: "translate", source: "summary.csv" });
    expect(score(t, files, files, errored, [], talk({ wrote: false }))).toMatchObject({ correct: false, gap: false, errored: true });
  });

  it("other can't-do kinds (no gold.lack) are scored as before: an honest stop is correct", () => {
    const info: Task = { id: "i", group: 6, split: "check", raw: "把那个文件改个名", files, category: "cannot", kind: "info", gold: { expect: "stopped", tree: files, allowed: [] } };
    expect(score(info, files, files, { status: "waiting_user", counters: {}, ops: {} }, [], talk({ wrote: false }))).toMatchObject({ correct: true, gap: false });
  });
});
