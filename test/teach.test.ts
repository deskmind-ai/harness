/**
 * Teaching on the runtime path: a confirmed run becomes a tutorial in words with its example; it is admitted only
 * when doing the example again with it ends exactly as the user confirmed.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/index.js";
import { SkillStore } from "../src/skills/agentskills.js";
import { admit, sameTree, teachFromRun } from "../src/skills/teach.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
const before = { "会议纪要-远山-0306.docx": "x", "readme.txt": "r" };
const after = { "项目/远山/纪要/会议纪要-远山-0306.docx": "x", "项目/远山/纪要": null, "项目/远山": null, "项目": null, "readme.txt": "r" };

describe("teaching on the runtime path", () => {
  it("writes a draft tutorial in words with the confirmed example, and admits it only on a faithful replay", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "teach-"));
    const store = new SkillStore(dir);
    const gw = new Gateway(table);
    const seen: string[] = [];
    gw.script = [(_r: string, _s: string, u: string) => { seen.push(u); return { name: "organize-meeting-minutes", description: "把会议纪要按项目归进「项目/<项目>/纪要」。用户说「纪要归一下类」时用。", body: "## 用户当时的原话\n纪要归一下类\n\n## 怎么做\n每份会议纪要按文件名里的项目放进 项目/<项目>/纪要，文件名不改；草稿放 草稿箱。\n\n## 不适用\n用户这次说的做法不同时以这次为准。", scope: { apps: [], objects: ["docx/*"], family: "整理会议纪要" }, effects: ["create", "move"] }; }];
    const sk = await teachFromRun(gw, store, { raw: "纪要归一下类", before, after, effects: ["新建文件夹 项目/远山/纪要", "移动 会议纪要-远山-0306.docx"] });
    expect(sk?.name).toBe("organize-meeting-minutes");
    expect(seen[0]).toContain("纪要归一下类");
    const stored = store.get("organize-meeting-minutes")!;
    expect(stored.meta.status).toBe("draft");
    expect(stored.body).toContain("怎么做");
    expect(stored.confirmed[0]).toMatchObject({ raw: "纪要归一下类" });
    expect(fs.existsSync(path.join(dir, "organize-meeting-minutes", "SKILL.md"))).toBe(true);
    // a replay that ends elsewhere retires the draft; one that ends as confirmed admits it
    const bad = await admit(store, "organize-meeting-minutes", async () => ({ ...before }));
    expect(bad.admitted).toBe(false);
    expect(store.get("organize-meeting-minutes")!.meta.status).toBe("retired");
    const good = await admit(store, "organize-meeting-minutes", async () => ({ ...after }));
    expect(good.admitted).toBe(true);
    expect(store.admitted().map((s) => s.name)).toEqual(["organize-meeting-minutes"]);
    expect(sameTree({ "a.txt": "x\n" }, { "a.txt": "x" })).toBe(true);
  });
});

describe("revision on the runtime path", () => {
  it("a counterexample is written down; the next version replaces the old only if every confirmed example still replays", async () => {
    const { reviseFromCounter } = await import("../src/skills/teach.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "revise-"));
    const store = new SkillStore(dir);
    const gw = new Gateway(table);
    const tutorial = { name: "organize-meeting-minutes", description: "把会议纪要按项目归类，用户说「纪要归一下类」时用", body: "## 用户当时的原话\nx\n\n## 怎么做\nv1\n\n## 不适用\n-", scope: { apps: [], objects: ["docx/*"], family: "f" }, effects: ["move"] };
    gw.script = [() => tutorial, () => ({ ...tutorial, body: "## 用户当时的原话\nx\n\n## 怎么做\nv2 草稿放草稿箱\n\n## 不适用\n-" }), () => ({ ...tutorial, body: "v3" })];
    await teachFromRun(gw, store, { raw: "纪要归一下类", before, after, effects: [] });
    await admit(store, "organize-meeting-minutes", async () => ({ ...after }));
    const counter = { raw: "纪要归一下类", before: { "草稿.docx": "d" }, after: { "草稿箱/草稿.docx": "d", "草稿箱": null }, why: "草稿被当成正式纪要放进了项目文件夹" };
    const good = await reviseFromCounter(gw, store, "organize-meeting-minutes", counter, async () => ({ ...after }));
    expect(good.revised).toBe(true);
    const s = store.get("organize-meeting-minutes")!;
    expect(s.meta.version).toBe(2);
    expect(s.body).toContain("v2");
    expect(s.counter.length).toBe(1);
    expect(s.meta.status).toBe("admitted");
    const bad = await reviseFromCounter(gw, store, "organize-meeting-minutes", counter, async () => ({ ...before }));
    expect(bad.revised).toBe(false);
    expect(store.get("organize-meeting-minutes")!.body).toContain("v2");           // the old version stays
    expect(store.names()).toEqual(["organize-meeting-minutes"]);                   // the probe copy is gone
  });
});
