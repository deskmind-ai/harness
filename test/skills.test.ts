import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Gateway, type Scripted } from "../src/gateway/index.js";
import { Orchestrator, type Answer, type Card, type CardUser } from "../src/orchestrator/index.js";
import type { SkillExpect, SkillRule } from "../src/protocol/roles.js";
import { fileRegistry } from "../src/registry/fs.js";
import { Workspace, build } from "../src/registry/workspace.js";
import { Library, useSignals, type Example, type StoredSkill } from "../src/skills/library.js";
import { checkExpect } from "../src/skills/rules.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
const gateway = (...script: Scripted[]) => { const gw = new Gateway(table); gw.script = script; return gw; };
const library = () => new Library(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-skills-")), "skills.json"));
const user = (pick: number | null): CardUser & { cards: Card[] } => ({ cards: [], ask(c) { this.cards.push(c); return pick === null ? null : { option: pick } as Answer; } });
const t = "2026-10-16T00:00:00Z";
const contentsOf = (files: string[]) => Object.fromEntries(files.map((f) => [f, `（${f} 的内容）`]));

// --- recordings (check set v2 skills-008 taught it; 009 and 010 used it) ---------------------------------------------
const REC_EXPECT: SkillExpect = { covers: { ext: ["m4a"], name: ["录音", "recording"] }, untouched: true };
/** What the teacher wrote from 008: the two spellings it saw, anchored and with ASCII digits only. */
const REC_V1: SkillRule[] = [{ name: "rec", match: ["^New Recording (?P<y>\\d{4})-(?P<m>\\d{2})-(?P<d>\\d{2})", "^录音_(?P<y>\\d{4})(?P<m>\\d{2})(?P<d>\\d{2})"], ext: ["m4a"], to: "录音/{y}-{m}" }];
/** A revision: any prefix, any case, spaces around the separators, full-width digits (normalised by |04 and |02). */
const REC_V2: SkillRule[] = [{ name: "rec", match: ["new recording\\s*(?P<y>\\d{4})\\s*-\\s*(?P<m>\\d{2})\\s*-\\s*(?P<d>\\d{2})", "录音\\s*_\\s*(?P<y>[0-9０-９]{4})(?P<m>[0-9０-９]{2})(?P<d>[0-9０-９]{2})"], ext: ["m4a"], to: "录音/{y|04}-{m|02}" }];
const OTHER = ["铃声.mp3", "旅行计划.docx", "录音笔说明书.pdf", "家庭预算.xlsx"];
const T008 = { files: ["New Recording 2026-01-27.m4a", "New Recording 2025-10-13.m4a", "录音_20260515.m4a", ...OTHER], want: { "New Recording 2026-01-27.m4a": "录音/2026-01/New Recording 2026-01-27.m4a", "New Recording 2025-10-13.m4a": "录音/2025-10/New Recording 2025-10-13.m4a", "录音_20260515.m4a": "录音/2026-05/录音_20260515.m4a" } };
const T009 = { files: ["final_New Recording 2025-07-12 - 改.m4a", "FINAL_录音_20251025.m4a", "录音 _ ２０２５０７０９.m4a", "录音_２０２６０１１３(2).m4a", ...OTHER],
  want: { "final_New Recording 2025-07-12 - 改.m4a": "录音/2025-07/final_New Recording 2025-07-12 - 改.m4a", "FINAL_录音_20251025.m4a": "录音/2025-10/FINAL_录音_20251025.m4a", "录音 _ ２０２５０７０９.m4a": "录音/2025-07/录音 _ ２０２５０７０９.m4a", "录音_２０２６０１１３(2).m4a": "录音/2026-01/录音_２０２６０１１３(2).m4a" } };
const T010 = { files: ["New Recording 2026 - 03 - 21 最终版.m4a", "nEW rECORDING 2025-08-13_new.m4a", "录音_２０２５０４１８(2).m4a", "Doc-New Recording 2025 - 07 - 25.m4a", "todo.md", ...OTHER],
  want: { "New Recording 2026 - 03 - 21 最终版.m4a": "录音/2026-03/New Recording 2026 - 03 - 21 最终版.m4a", "nEW rECORDING 2025-08-13_new.m4a": "录音/2025-08/nEW rECORDING 2025-08-13_new.m4a", "录音_２０２５０４１８(2).m4a": "录音/2025-04/录音_２０２５０４１８(2).m4a", "Doc-New Recording 2025 - 07 - 25.m4a": "录音/2025-07/Doc-New Recording 2025 - 07 - 25.m4a" } };

// --- invoices (skills-012 taught it; 013 used it) ---------------------------------------------------------------------
const INV_EXPECT: SkillExpect = { covers: { ext: ["pdf"], name: ["发票"] }, name: ["^\\d{8}-.+-\\d+\\.pdf$"], untouched: true };
const INV_TAUGHT: SkillRule = { name: "inv", match: ["^发票_(?P<shop>[^_]+)_(?P<y>\\d{4})(?P<m>\\d{2})(?P<d>\\d{2})_(?P<amt>\\d+)元"], ext: ["pdf"], not: ["模板"], to: "财务/发票/{y}-{m}", rename: "{y}{m}{d}-{shop}-{amt|int}.pdf" };
/** v1 also took any other invoice spelling, by its date only: moved, never renamed (013). */
const INV_V1: SkillRule[] = [INV_TAUGHT, { name: "inv-other", match: ["^(?!发票_).*发票.*?(?P<y>\\d{4})\\.(?P<m>\\d{2})"], ext: ["pdf"], not: ["模板"], to: "财务/发票/{y}-{m}" }];
const INV_V2: SkillRule[] = [INV_TAUGHT, { name: "inv-e", match: ["电子发票-(?P<shop>[^-]+)-(?P<y>\\d{4})\\.(?P<m>\\d{2})\\.(?P<d>\\d{2})-(?P<amt>[\\d.]+)元"], ext: ["pdf"], not: ["模板"], to: "财务/发票/{y}-{m}", rename: "{y}{m}{d}-{shop}-{amt|int}.pdf" }];
const T012 = { files: ["发票_盒马_20260304_256元.pdf", "发票_京东_20250905_128元.pdf", "报价单_顺丰_23.pdf", "开票信息.txt"], want: { "发票_盒马_20260304_256元.pdf": "财务/发票/2026-03/20260304-盒马-256.pdf", "发票_京东_20250905_128元.pdf": "财务/发票/2025-09/20250905-京东-128.pdf" } };
const T013 = { files: ["电子发票-山姆-2026.08.13-99.00元.pdf", "电子发票-携程-2026.03.12-1024.00元.pdf", "发票模板.docx", "readme.txt"],
  want: { "电子发票-山姆-2026.08.13-99.00元.pdf": "财务/发票/2026-08/20260813-山姆-99.pdf", "电子发票-携程-2026.03.12-1024.00元.pdf": "财务/发票/2026-03/20260312-携程-1024.pdf" } };

const ex = (id: string, c: { files: string[]; want: Record<string, string> }, source: Example["source"] = "use"): Example => ({ id, source, files: c.files, contents: contentsOf(c.files), want: c.want, confirmed: source !== "variant", t });
function stored(lib: Library, family: string, rules: SkillRule[], expectation: SkillExpect, teach: { files: string[]; want: Record<string, string> }): StoredSkill {
  const sk: StoredSkill = { id: "S001", family, status: "probation", created: t, version: 1, title: family, applies_when: family, rules, variants: [], expect: expectation, examples: [ex("E1", teach, "teach")], admission: {} };
  lib.skills.push(sk);
  return sk;
}
const revision = (rules: SkillRule[], expectation: SkillExpect, change: string, conflicts_with: string | null = null) => (role: string) => role === "skill" ? { title: "", applies_when: "", rules, variants: [], expect: expectation, change, conflicts_with } : { outcome: "error", error: "unexpected " + role };

describe("skill checks (expect)", () => {
  it("reports files of the kind no rule placed, a placed file under the wrong name, and a file of another kind moved", () => {
    const files = ["电子发票-山姆-2026.08.13-99.00元.pdf", "发票_盒马_20260304_256元.pdf", "INVOICE.pdf", "readme.txt"];
    const where = { "电子发票-山姆-2026.08.13-99.00元.pdf": "财务/发票/2026-08/电子发票-山姆-2026.08.13-99.00元.pdf", "发票_盒马_20260304_256元.pdf": "财务/发票/2026-03/20260304-盒马-256.pdf", "readme.txt": "财务/readme.txt" };
    expect(checkExpect(INV_EXPECT, files, {}, where)).toEqual({ uncovered: [], misnamed: ["电子发票-山姆-2026.08.13-99.00元.pdf"], touched: ["readme.txt"] });
    expect(checkExpect({ ...INV_EXPECT, covers: { ext: ["pdf"], name: ["发票", "invoice"] } }, files, {}, where).uncovered).toEqual(["INVOICE.pdf"]);
  });

  it("admission needs expect, and it must hold on the right answer and on the rules' result", async () => {
    const lib = library();
    const answer = (e?: SkillExpect) => ({ title: "录音", applies_when: "整理录音", rules: REC_V1, variants: [{ from: "New Recording 2024-02-03.m4a", to: "录音/2024-02/New Recording 2024-02-03.m4a" }], ...(e ? { expect: e } : {}) });
    const c = contentsOf(T008.files);
    // no expect at first: sent back; then one whose name check the right answer itself fails: rejected
    const bad = await lib.teach(gateway(() => answer(), () => answer({ ...REC_EXPECT, name: ["^\\d{8}\\.m4a$"] })), "录音整理一下", T008.files, c, T008.want, "recordings");
    expect(bad.status).toBe("rejected");
    const ok = await lib.teach(gateway(() => answer(REC_EXPECT)), "录音整理一下", T008.files, c, T008.want, "recordings");
    expect(ok.status).toBe("probation");
    expect(ok.examples!.map((e) => [e.id, e.source, e.confirmed])).toEqual([["E1", "teach", true], ["E2", "variant", false]]);
  });
});

describe("misuse signals", () => {
  it("come from the log's structure: a skill step stopped or declined, the goal check failing, the result undone", () => {
    const plan = { kind: "plan.accepted", plan: { source: "skill", skill: "S001", nodes: [{ id: "mk0" }, { id: "mv1" }] } };
    expect(useSignals([{ kind: "run.start" }])).toEqual([]);
    expect(useSignals([plan, { kind: "node.failed", node_id: "mk0", why: "intent: insufficient evidence on a skill action" }])).toEqual(["guard"]);
    expect(useSignals([plan, { kind: "node.failed", node_id: "mv1", why: "declined by the user" }, { kind: "verification", subject: "goal", passed: false }])).toEqual(["declined", "goal"]);
    // after the planner took over, its own failures are not the skill's
    expect(useSignals([plan, { kind: "plan.accepted", plan: { source: "plan", nodes: [{ id: "mk0" }] } }, { kind: "node.failed", node_id: "mk0", why: "x" }, { kind: "result.response", picked: "undo" }])).toEqual(["undone"]);
  });
});

describe("revision: champion and challenger (design table: 009, 010, 013)", () => {
  it("the taught skill gets 009, 010 and 013 wrong; the revised ones get them right and keep the teaching example", () => {
    for (const [v1, v2, e, teach, uses] of [[REC_V1, REC_V2, REC_EXPECT, T008, [T009, T010]], [INV_V1, INV_V2, INV_EXPECT, T012, [T013]]] as const) {
      expect(Library.replay({ rules: [...v1], expect: e }, ex("E1", teach, "teach"))).toBe(true);
      expect(Library.replay({ rules: [...v2], expect: e }, ex("E1", teach, "teach"))).toBe(true);
      for (const u of uses) {
        expect(Library.replay({ rules: [...v1], expect: e }, ex("E2", u))).toBe(false);
        expect(Library.replay({ rules: [...v2], expect: e }, ex("E2", u))).toBe(true);
      }
    }
  });

  it("at use, files the checks object to go back to the planner: 009's three unrecognised recordings, 013's unrenamed invoices", () => {
    const lib = library();
    const rec = stored(lib, "recordings", REC_V1, REC_EXPECT, T008);
    const p = lib.plan(rec, T009.files, contentsOf(T009.files));
    expect(p.report!.uncovered).toEqual(["final_New Recording 2025-07-12 - 改.m4a", "FINAL_录音_20251025.m4a", "录音 _ ２０２５０７０９.m4a", "录音_２０２６０１１３(2).m4a"]);
    expect(p.unsure).toEqual(p.report!.uncovered);
    const inv = { ...stored(library(), "invoices", INV_V1, INV_EXPECT, T012) };
    const q = lib.plan(inv, T013.files, contentsOf(T013.files));
    expect(q.report!.misnamed).toHaveLength(2);
    expect(Object.values(q.where).filter((w) => w.startsWith("财务"))).toEqual([]);   // not moved half-right
  });

  it("009 then 010: the use that ended right is a counterexample; the revision is replayed on every example and replaces v1", async () => {
    const lib = library();
    const sk = stored(lib, "recordings", REC_V1, REC_EXPECT, T008);
    const r1 = await lib.learn(gateway(revision(REC_V2, REC_EXPECT, "现在也认得全角数字和带前缀、空格的写法")), "S001", { files: T009.files, contents: contentsOf(T009.files), final: T009.want, signals: [] });
    expect(r1).toMatchObject({ signals: ["uncovered"], revision: "replaced" });
    expect(sk).toMatchObject({ version: 2, notice: "现在也认得全角数字和带前缀、空格的写法", failed_revisions: 0 });
    expect(sk.examples!.map((e) => e.id)).toEqual(["E1", "E2"]);
    // 010 under v2: right first time, so it is one more example and nothing is revised (the script would be unused)
    const gw = gateway();
    const r2 = await lib.learn(gw, "S001", { files: T010.files, contents: contentsOf(T010.files), final: T010.want, signals: [] });
    expect(r2).toEqual({ signals: [], example: "E3" });
    expect(gw.calls).toBe(0);
    expect(sk.notice).toBeNull();                 // said once, with the use after the revision
  });

  it("013: a revision that breaks the teaching example is not taken; two in a row disable the skill", async () => {
    const lib = library();
    const sk = stored(lib, "invoices", INV_V1, INV_EXPECT, T012);
    const breaks: SkillRule[] = [INV_V2[1]!];     // the electronic spelling only: 012's 发票_… no longer placed
    const one = await lib.learn(gateway(revision(breaks, INV_EXPECT, "x")), "S001", { files: T013.files, contents: contentsOf(T013.files), final: T013.want, signals: ["declined"], corrected: true });
    expect(one.revision).toBe("kept");
    expect(sk).toMatchObject({ version: 1, status: "probation", failed_revisions: 1 });
    expect(sk.rules).toEqual(INV_V1);
    expect(sk.examples!.at(-1)).toMatchObject({ source: "correction", confirmed: true });
    const two = await lib.learn(gateway(revision(breaks, INV_EXPECT, "x")), "S001", { files: T013.files, contents: contentsOf(T013.files), final: T013.want, signals: ["declined"], corrected: true });
    expect(two.revision).toBe("kept");
    expect(sk.status).toBe("disabled");
  });

  it("013 with a good revision: replaced, and the next result says what changed, with undo", async () => {
    const lib = library();
    const sk = stored(lib, "invoices", INV_V1, INV_EXPECT, T012);
    expect((await lib.learn(gateway(revision(INV_V2, INV_EXPECT, "现在也会改名")), "S001", { files: T013.files, contents: contentsOf(T013.files), final: T013.want, signals: ["declined"], corrected: true })).revision).toBe("replaced");
    // the next use: the orchestrator picks the skill, runs it, and the result card carries the notice
    const files = { "电子发票-盒马-2026.01.02-58.00元.pdf": "a", "readme.txt": "b" };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-skills-ws-"));
    build(root, files);
    const ws = new Workspace(root);
    const target = "财务/发票/2026-01/20260102-盒马-58.pdf";
    const goal = { requirements: [{ id: "r1", statement: "发票归档", check: { kind: "deterministic", name: "file_exists", args: { path: target } }, quotes: ["发票"] }], constraints: [], missing: [], feasible: "yes" };
    const sc: Scripted = (role, _s, u) => role === "goal" ? goal : role === "choice" ? { choice: u.includes("哪份已有的教材") ? "S001" : "act" } : role === "intent" ? { verdict: "matches", reason: "ok" } : { outcome: "error", error: "none" };
    const gw = gateway(...Array(12).fill(sc));
    const o = new Orchestrator(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-skills-log-")), "log.jsonl"), ws, gw, user(null), fileRegistry(), { skills: lib });
    o.start("把发票归档一下");
    const s = await o.run();
    expect(s.status).toBe("succeeded");
    expect(ws.exists(target)).toBe(true);
    expect(s.result_card).toMatchObject({ kind: "result", text: "按教材整理（已更新：现在也会改名）", blocking: false });
    expect(s.result_card!.options.map((x) => x.kind)).toEqual(["approve", "undo"]);
    o.respond(s.result_card!, { option: 1 });
    expect(o.summary().status).toBe("cancelled");
    expect(ws.exists("电子发票-盒马-2026.01.02-58.00元.pdf")).toBe(true);
    expect(sk.version).toBe(2);
  });
});

describe("revision: asking only on a conflict with what the user confirmed", () => {
  // taught 「录音/年-月」; this time the user's run put a recording under 「录音/年」
  const BY_YEAR: SkillRule[] = [{ ...REC_V2[0]!, to: "录音/{y|04}" }];
  const T_YEAR = { files: ["New Recording 2026-02-14.m4a", ...OTHER], want: { "New Recording 2026-02-14.m4a": "录音/2026/New Recording 2026-02-14.m4a" } };

  it("the new version cannot keep both: one question 「以前是 A，这次是 B，以后按哪个？」; the answer decides", async () => {
    for (const [pick, outcome, version, to] of [[1, "replaced", 2, "录音/{y|04}"], [0, "asked_kept", 1, "录音/{y}-{m}"]] as const) {
      const lib = library();
      const sk = stored(lib, "recordings", REC_V1, REC_EXPECT, T008);
      const u = user(pick);
      const r = await lib.learn(gateway(revision(BY_YEAR, REC_EXPECT, "按年归档", "E1")), "S001", { files: T_YEAR.files, contents: contentsOf(T_YEAR.files), final: T_YEAR.want, signals: ["declined"], corrected: true }, u);
      expect(r.revision).toBe(outcome);
      expect(u.cards).toHaveLength(1);
      expect(u.cards[0]!.text).toMatch(/^整理这类文件，以前是「.+录音\/20\d\d-\d\d\/.+」，这次是「.+录音\/2026\/.+」，以后按哪个？$/);
      expect(sk.version).toBe(version);
      expect(sk.rules![0]!.to).toBe(to);
      if (pick === 1) expect(sk.examples!.map((e) => e.id)).not.toContain("E1");   // the old way is retired
    }
  });

  it("a conflict the model claims but the replay does not show is not asked about", async () => {
    const lib = library();
    stored(lib, "recordings", REC_V1, REC_EXPECT, T008);
    const u = user(1);
    const r = await lib.learn(gateway(revision(REC_V2, REC_EXPECT, "认得更多写法", "E1")), "S001", { files: T009.files, contents: contentsOf(T009.files), final: T009.want, signals: [] }, u);
    expect(r.revision).toBe("replaced");
    expect(u.cards).toEqual([]);
  });
});
