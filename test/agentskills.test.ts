/**
 * The skills layer in the Agent Skills format: the folder round trip (SKILL.md frontmatter, rules, examples, state),
 * the shipped base skill, the structural filter that keeps rather than drops, the Library stored as folders giving
 * the same answers as the JSON file, disabling by attribution, and the orchestrator reading the chosen skill as
 * evidence before the goal.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Gateway, type Scripted } from "../src/gateway/index.js";
import { Orchestrator, type Answer, type CardUser } from "../src/orchestrator/index.js";
import type { SkillExpect, SkillRule } from "../src/protocol/roles.js";
import { fileRegistry } from "../src/registry/fs.js";
import { Workspace, build } from "../src/registry/workspace.js";
import { SkillStore, chooseSkill, parseSkillMd, parseYaml, renderSkillMd, type Skill } from "../src/skills/agentskills.js";
import { Library, fromSkill, toSkill, type Example, type StoredSkill } from "../src/skills/library.js";

const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
const gateway = (...script: Scripted[]) => { const gw = new Gateway(table); gw.script = script; return gw; };
const t = "2026-10-16T00:00:00Z";
const contentsOf = (files: string[]) => Object.fromEntries(files.map((f) => [f, `（${f} 的内容）`]));

const REC_EXPECT: SkillExpect = { covers: { ext: ["m4a"], name: ["录音", "recording"] }, untouched: true };
const REC_V1: SkillRule[] = [{ name: "rec", match: ["^New Recording (?P<y>\\d{4})-(?P<m>\\d{2})-(?P<d>\\d{2})", "^录音_(?P<y>\\d{4})(?P<m>\\d{2})(?P<d>\\d{2})"], ext: ["m4a"], to: "录音/{y}-{m}" }];
const OTHER = ["铃声.mp3", "旅行计划.docx"];
const T008 = { files: ["New Recording 2026-01-27.m4a", "录音_20260515.m4a", ...OTHER], want: { "New Recording 2026-01-27.m4a": "录音/2026-01/New Recording 2026-01-27.m4a", "录音_20260515.m4a": "录音/2026-05/录音_20260515.m4a" } };
const ex = (id: string, c: { files: string[]; want: Record<string, string> }, source: Example["source"] = "use", confirmed = true): Example => ({ id, source, files: c.files, contents: contentsOf(c.files), want: c.want, confirmed, t });
const stored = (): StoredSkill => ({ id: "S001", family: "recordings", status: "probation", created: t, version: 1, title: "录音按月归档", applies_when: "用户要整理录音", rules: REC_V1, variants: [], expect: REC_EXPECT,
  examples: [ex("E1", T008, "teach"), ex("E2", { files: ["x.m4a"], want: { "x.m4a": "录音/x.m4a" } }, "variant", false), ex("E3", T008, "correction")], admission: { decision: "probation" }, uses: [{ ok: true, teacher_calls: 0, t }] });

const ORGANIZE = `---
name: organize-music
description: 把下载的音乐按歌手整理进「音乐/歌手名」，文件名不改。
metadata:
  deskmind:
    source: taught
    status: admitted
    version: 3
    scope:
      apps: [Finder]
      objects: ["~/Downloads", "audio/*"]
      family: 整理文件
    effects:
      - create
      - move
    taught_on: 2026-10-12
---

## 怎么做
- 每首歌放进「音乐/<歌手>」。
`;

describe("SKILL.md", () => {
  it("parses the frontmatter subset we write (nested maps, inline and dashed lists) and renders it back the same", () => {
    const s = parseSkillMd(ORGANIZE);
    expect(s.name).toBe("organize-music");
    expect(s.meta).toEqual({ source: "taught", status: "admitted", version: 3, scope: { apps: ["Finder"], objects: ["~/Downloads", "audio/*"], family: "整理文件" }, effects: ["create", "move"], taught_on: "2026-10-12" });
    expect(s.body).toContain("## 怎么做");
    const again = parseSkillMd(renderSkillMd({ name: s.name, description: s.description, meta: s.meta, body: s.body }));
    expect(again).toEqual(s);
    expect(parseYaml("a: 1\nb:\n  c: [x, \"y z\"]\n  d: true")).toEqual({ a: 1, b: { c: ["x", "y z"], d: true } });
    expect(() => parseSkillMd("---\nname: Bad Name\ndescription: x\n---\n")).toThrow(/name/);
  });

  it("the shipped base skill reads as a skill with no rules and no examples", () => {
    const store = new SkillStore(path.resolve("skills"));
    const base = store.get("deskmind-computer-use");
    expect(base?.meta).toMatchObject({ source: "shipped", version: 1 });
    expect(base?.rules).toBeNull();
    expect(base?.body).toContain("看得宽");
    expect(store.source().read("deskmind-computer-use")).toContain("finish");
  });

  it("a folder round trip keeps rules, examples, checks and state", () => {
    const store = new SkillStore(tmp("agentskills-"));
    const parsed = parseSkillMd(ORGANIZE);
    const skill: Skill = { ...parsed, rules: { rules: REC_V1, expect: REC_EXPECT }, confirmed: [{ id: "E1", files: ["a.mp3"] }], counter: [{ id: "C1" }], checks: "每首歌都在歌手文件夹里", state: { uses: 2 } };
    store.write(skill);
    expect(store.names()).toEqual(["organize-music"]);
    expect(store.get("organize-music")).toEqual(skill);
    store.write({ ...skill, rules: null, counter: [], checks: null, state: null });
    expect(store.get("organize-music")).toEqual({ ...skill, rules: null, counter: [], checks: null, state: null });
  });
});

describe("retrieval", () => {
  const seed = (store: SkillStore) => {
    const mk = (name: string, apps: string[], objects: string[], status: "admitted" | "retired" = "admitted"): Skill => ({ name, description: name, meta: { source: "taught", status, version: 1, scope: { apps, objects, family: "" }, effects: [] }, body: "x", confirmed: [], counter: [] });
    store.write(mk("organize-music", ["Finder"], ["audio/*"]));
    store.write(mk("organize-podcasts", [], ["~/Podcasts", "*.mp3"]));
    store.write(mk("screenshots-by-month", ["Finder"], ["image/*"]));
    store.write(mk("safari-search", ["Safari"], []));
    store.write(mk("anything", [], []));
    store.write(mk("old-way", ["Finder"], ["audio/*"], "retired"));
  };

  it("step 1 keeps a skill whose apps or objects touch the facts, and every unscoped one; a retired skill never", () => {
    const store = new SkillStore(tmp("agentskills-"));
    seed(store);
    const names = (f: Parameters<SkillStore["candidates"]>[0]) => store.candidates(f).map((s) => s.name);
    expect(names({ objects: ["~/Downloads"], fileTypes: ["mp3"] })).toEqual(["anything", "organize-music", "organize-podcasts"]);
    expect(names({ apps: ["safari"] })).toEqual(["anything", "safari-search"]);
    expect(names({ objects: ["~/Podcasts/ep1.mp3"] })).toEqual(["anything", "organize-podcasts"]);
    // facts that touch no scope leave the unscoped skill; no facts at all, or nothing kept, means all admitted, so
    // the right one is never lost here
    expect(names({ fileTypes: ["xyz"], apps: ["Pages"] })).toEqual(["anything"]);
    expect(names({})).toHaveLength(5);
    store.remove("anything");
    expect(names({ fileTypes: ["xyz"], apps: ["Pages"] })).toHaveLength(4);
  });

  it("step 3 is the same choice question the orchestrator always asked; none is an answer", async () => {
    const cands = [{ name: "organize-music", description: "音乐" }, { name: "organize-podcasts", description: "播客" }];
    const seen: string[] = [];
    const pick = (c: string): Scripted => (role, _s, u) => { seen.push(u); return role === "choice" ? { choice: c } : { outcome: "error", error: role }; };
    expect(await chooseSkill(gateway(pick("organize-podcasts")), "播客放一下", cands)).toBe("organize-podcasts");
    expect(await chooseSkill(gateway(pick("none")), "随便", cands)).toBeNull();
    expect(await chooseSkill(gateway(), "x", [])).toBeNull();
    expect(seen[0]).toContain("哪份已有的教材适用于这个任务？");
    expect(seen[0]).toContain("- none: 都不适用");
  });
});

describe("the Library stored as Agent Skills folders", () => {
  it("a skill saved into a directory loads back equal, with the same usable() and instantiate() as the JSON file", () => {
    const dir = tmp("agentskills-lib-"), json = path.join(tmp("agentskills-json-"), "skills.json");
    const a = new Library(dir), b = new Library(json);
    a.skills.push(stored()); b.skills.push(stored());
    a.save(); b.save();
    expect(fs.existsSync(path.join(dir, "s001-recordings", "SKILL.md"))).toBe(true);
    expect(fs.readFileSync(path.join(dir, "s001-recordings", "SKILL.md"), "utf-8")).toContain("status: admitted");
    expect(fs.readFileSync(path.join(dir, "s001-recordings", "examples", "counter.jsonl"), "utf-8").split("\n").filter(Boolean)).toHaveLength(1);
    const a2 = new Library(dir), b2 = new Library(json);
    expect(a2.skills).toEqual(b2.skills);
    expect(a2.usable().map((s) => s.id)).toEqual(["S001"]);
    const root = tmp("agentskills-ws-");
    build(root, Object.fromEntries(T008.files.map((f) => [f, "x"])));
    const ws = new Workspace(root);
    expect(a2.instantiate("S001", ws)).toEqual(b2.instantiate("S001", ws));
    expect(a2.instantiate("S001", ws).nodes.map((n) => n.args)).toContainEqual({ source: "录音_20260515.m4a", destination: "录音/2026-05/录音_20260515.m4a" });
    // the shipped base skill in the same folder is not the Library's (no state): ignored, not broken
    fs.cpSync(path.resolve("skills", "deskmind-computer-use"), path.join(dir, "deskmind-computer-use"), { recursive: true });
    expect(new Library(dir).skills.map((s) => s.id)).toEqual(["S001"]);
    expect(fromSkill(toSkill(stored()))).toEqual(stored());
  });

  it("disabling counts a misuse only when it is the skill's own: a guard refusal or a declined step is not", () => {
    const lib = new Library(path.join(tmp("agentskills-json-"), "skills.json"));
    const sk = stored(); sk.uses = []; lib.skills.push(sk);
    lib.recordUse("S001", false, 0, ["guard"]);
    lib.recordUse("S001", false, 0, ["declined", "goal"]);
    lib.recordUse("S001", false, 0, []);
    expect(sk.status).toBe("probation");
    lib.recordUse("S001", false, 0, ["misnamed"]);
    expect(sk.status).toBe("probation");
    lib.recordUse("S001", false, 0, ["undone"]);
    expect(sk.status).toBe("disabled");
    expect(sk.uses!.map((u) => !!u.counted)).toEqual([false, false, false, true, true]);
  });
});

describe("the orchestrator and the skill", () => {
  it("asks which skill before the goal, shows the goal the confirmed way as evidence, and instantiates it without asking again", async () => {
    const lib = new Library(tmp("agentskills-lib-"));
    lib.skills.push(stored());
    const root = tmp("agentskills-ws-");
    build(root, { "录音_20260101.m4a": "a", "readme.txt": "b" });
    const ws = new Workspace(root);
    const goal = { requirements: [{ id: "r1", statement: "录音归档", check: { kind: "deterministic", name: "file_exists", args: { path: "录音/2026-01/录音_20260101.m4a" } }, quotes: ["录音"] }], constraints: [], missing: [], feasible: "yes" };
    const prompts: Record<string, string[]> = {};
    const sc: Scripted = (role, _s, u) => { (prompts[role] ??= []).push(u); return role === "goal" ? goal : role === "choice" ? { choice: u.includes("哪份已有的教材") ? "S001" : "act" } : role === "intent" ? { verdict: "matches", reason: "ok" } : { outcome: "error", error: "none" }; };
    const gw = gateway(...Array(12).fill(sc));
    const user: CardUser = { ask: () => null as Answer | null };
    const log = path.join(tmp("agentskills-log-"), "log.jsonl");
    const o = new Orchestrator(log, ws, gw, user, fileRegistry(), { skills: lib });
    o.start("录音整理一下");
    const s = await o.run();
    expect(s.status).toBe("succeeded");
    expect(s.skill).toBe("S001");
    expect(prompts.choice!.filter((p) => p.includes("哪份已有的教材"))).toHaveLength(1);
    expect(prompts.goal![0]).toContain("用户以前确认过的做法");
    expect(prompts.goal![0]).toContain("录音_20260515.m4a → 录音/2026-05/录音_20260515.m4a");
    const kinds = o.log.events.map((e) => e.kind);
    expect(kinds.indexOf("skill.chosen")).toBeLessThan(kinds.indexOf("goal.accepted"));
    // the choice replays from the log: a new process over the same log asks no model
    const o2 = new Orchestrator(log, ws, gateway(), user, fileRegistry(), { skills: lib });
    expect(o2.st.skillChosen).toBe("S001");
  });

  it("with no skill chosen, the goal sees no evidence block and the planner plans", async () => {
    const lib = new Library(tmp("agentskills-lib-"));
    lib.skills.push(stored());
    const root = tmp("agentskills-ws-");
    build(root, { "todo.txt": "交房租\n" });
    const ws = new Workspace(root);
    const goal = { requirements: [{ id: "r1", statement: "末行", check: { kind: "deterministic", name: "last_line_is", args: { path: "todo.txt", line: "买牛奶" } }, quotes: ["买牛奶"] }], constraints: [], missing: [], feasible: "yes" };
    const prompts: Record<string, string[]> = {};
    const sc: Scripted = (role, _s, u) => { (prompts[role] ??= []).push(u); return role === "goal" ? goal : role === "choice" ? { choice: u.includes("哪份已有的教材") ? "none" : "act" } : role === "plan" ? { nodes: [{ id: "n1", capability: "fs.append_line", depends_on: [], purpose: "追加", requirement_ids: ["r1"] }], outcome: "plan" } : role === "bind" ? { bindings: { target: { kind: "resource_ref", path: "todo.txt" }, line: { kind: "source_span", quote: "买牛奶", occurrence: 1 } }, unresolved: [] } : role === "intent" ? { verdict: "matches", reason: "ok" } : { outcome: "error", error: "none" }; };
    const o = new Orchestrator(path.join(tmp("agentskills-log-"), "log.jsonl"), ws, gateway(...Array(12).fill(sc)), { ask: () => null }, fileRegistry(), { skills: lib });
    o.start("在 todo.txt 末尾加一行买牛奶");
    const s = await o.run();
    expect(s.status).toBe("succeeded");
    expect(s.skill).toBeNull();
    expect(prompts.goal![0]).not.toContain("用户以前确认过的做法");
    expect(prompts.plan).toHaveLength(1);
  });
});
