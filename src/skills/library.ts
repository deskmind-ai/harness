/**
 * The skill library: executable rules with the 2.0 lifecycle (draft → validated → probation → active, or
 * rejected/disabled), teaching after a successful run, and admission that replays the teaching example and the
 * teacher's own variants before anything is stored.
 *
 * A skill instantiates into plan nodes (fs.mkdir / fs.move) whose arguments the rules computed; the orchestrator still
 * runs the intent check and every execution guard on them. Files the rules cannot place are handed back to the planner.
 *
 * Revision (openjev docs/design/skill-revision-2026-10-12.md, after Sakana MASS): a skill carries checks of its own
 * (expect), every use is recorded, and a use that went wrong but ended right becomes a counterexample. The skill role
 * writes a revised version; code replays both on every example the skill has (teaching, variants, past correct uses,
 * the counterexample) and the new version replaces the old only if it gets the counterexample right and breaks
 * nothing the old one got right. The user is asked only when the correction contradicts a way they confirmed before.
 */
import * as fs from "node:fs";
import type { Gateway } from "../gateway/index.js";
import type { Answer, Card, CardUser, SkillLibrary } from "../orchestrator/index.js";
import { SYSTEM } from "../orchestrator/prompts.js";
import { SkillAnswer, SkillRevision, type SkillExpect, type SkillRule } from "../protocol/roles.js";
import type { PlanNode } from "../protocol/schemas.js";
import type { Workspace } from "../registry/workspace.js";
import { DSL_HELP, SkillError, checkExpect, failed, ofKind, runSkill, type ExpectReport } from "./rules.js";

export type SkillStatus = "draft" | "validated" | "probation" | "active" | "disabled" | "rejected";

/** One case a skill is held to: these files, and where each should end up (a file not in want stays). confirmed: the
 *  user's own runs and answers, as opposed to the teacher's imagined variants. */
export interface Example {
  id: string;
  source: "teach" | "variant" | "use" | "correction";
  files: string[];
  contents?: Record<string, string>;
  want: Record<string, string>;
  confirmed: boolean;
  t: string;
}

/** What went wrong in a use, read from structure only: the skill's own checks, the run's guards and goal check, and
 *  what the user did with the plan or the result. Never from the user's words. */
export type Signal = "uncovered" | "misnamed" | "touched" | "guard" | "goal" | "declined" | "undone";

export interface StoredSkill {
  id: string;
  family: string;
  status: SkillStatus;
  created: string;
  version?: number;
  title?: string;
  applies_when?: string;
  rules?: SkillRule[];
  variants?: { from: string; content?: string; to: string }[];
  expect?: SkillExpect;
  examples?: Example[];
  admission: Record<string, unknown>;
  uses?: { ok: boolean; teacher_calls: number; t: string; signals?: Signal[] }[];
  revisions?: { ok: boolean; version: number; change?: string; why?: string; counter: string; t: string }[];
  failed_revisions?: number;                     // in a row; two disable the skill
  notice?: string | null;                        // what the last revision changed, said once with the next result
  draft?: unknown;
}

type Wrong = [string, string, string];
type Planned = { files: string[]; contents: Record<string, string>; where: Record<string, string>; unsure: string[]; report: ExpectReport | null };

const now = () => new Date().toISOString();
const nextId = (examples: Example[] | undefined) => `E${Math.max(0, ...(examples ?? []).map((e) => Number(e.id.slice(1)) || 0)) + 1}`;

/** The moves between two trees (path → content): a file gone from `start` whose content shows up at a new path. */
export function movesBetween(start: Record<string, string | null>, end: Record<string, string | null>): Record<string, string> {
  const moves: Record<string, string> = {};
  for (const [p, v] of Object.entries(start)) {
    if (v === null || p in end) continue;
    const dst = Object.entries(end).find(([q, w]) => w === v && !(q in start) && !Object.values(moves).includes(q))?.[0];
    if (dst) moves[p] = dst;
  }
  return moves;
}

/** The misuse signals of a run that used a skill, from its log: a guard or check stopping one of the skill's steps,
 *  the user declining a step of it, the goal check failing after it, and the user undoing the result. */
export function useSignals(events: { kind: string; [k: string]: any }[]): Signal[] {
  const at = events.findIndex((e) => e.kind === "plan.accepted" && e.plan?.source === "skill");
  if (at < 0) return [];
  const ids = new Set<string>(events[at]!.plan.nodes.map((n: PlanNode) => n.id));
  const out = new Set<Signal>();
  let own = true;                                 // still the skill's plan (until the planner takes over)
  for (const e of events.slice(at + 1)) {
    if (e.kind === "plan.accepted") own = false;
    if (own && e.kind === "node.failed" && ids.has(e.node_id)) out.add(e.why === "declined by the user" ? "declined" : "guard");
    if (own && e.kind === "interaction.reply" && e.body?.purpose === "plan" && e.body.approved === false) out.add("declined");
    if (e.kind === "verification" && e.subject === "goal" && e.passed === false) out.add("goal");
    if (e.kind === "result.response" && (e.picked === "undo" || e.picked === "undo_and_reading")) out.add("undone");
  }
  return [...out];
}

export class Library implements SkillLibrary {
  skills: StoredSkill[] = [];
  private planned = new Map<string, Planned>();  // the last instantiation of each skill, for recording its use

  constructor(readonly path: string) {
    if (fs.existsSync(path)) this.skills = JSON.parse(fs.readFileSync(path, "utf-8"));
  }

  save() {
    fs.writeFileSync(this.path, JSON.stringify(this.skills, null, 1));
  }

  usable() {
    return this.skills.filter((s) => s.status === "probation" || s.status === "active");
  }

  /** Every usable skill is a candidate; the choice role decides (retrieval is trivial at this library size). */
  candidates(_raw: string, _ws: Workspace) {
    return this.usable().map((s) => ({ id: s.id, title: s.title!, applies_when: s.applies_when! }));
  }

  /** Where the rules put each file. A file the skill's own checks object to is handed back to the planner, not moved:
   *  one of the skill's kind no rule placed (uncovered), one placed under the wrong name, one of another kind moved. */
  plan(sk: StoredSkill, files: string[], contents: Record<string, string>): Planned {
    const { where, unsure } = runSkill({ rules: sk.rules! }, files, contents);
    const report = sk.expect ? checkExpect(sk.expect, files, contents, where, unsure) : null;
    const back = report ? [...report.uncovered, ...report.misnamed, ...report.touched] : [];
    for (const f of back) delete where[f];
    return { files, contents, where, unsure: [...new Set([...unsure, ...back])], report };
  }

  planMoves(sk: StoredSkill, ws: Workspace) {
    const files = Object.entries(ws.entries()).filter(([, v]) => v !== "dir").map(([p]) => p);
    const contents = Object.fromEntries(files.map((f) => [f, ws.read(f)]));
    const p = this.plan(sk, files, contents);
    this.planned.set(sk.id, p);
    return { moves: Object.fromEntries(Object.entries(p.where).filter(([f, t]) => t !== f)), unsure: p.unsure };
  }

  instantiate(skillId: string, ws: Workspace): { nodes: PlanNode[]; unsure: string[]; notice: string | null } {
    const sk = this.skills.find((s) => s.id === skillId)!;
    const { moves, unsure } = this.planMoves(sk, ws);
    const nodes: PlanNode[] = [];
    const made = new Map<string, string>();
    const ensure = (folder: string): string[] => {
      if (!folder || ws.isDir(folder)) return [];
      if (made.has(folder)) return [made.get(folder)!];
      const parent = folder.includes("/") ? folder.slice(0, folder.lastIndexOf("/")) : "";
      const deps = ensure(parent);
      const id = `mk${nodes.length}`;
      nodes.push({ id, capability: "fs.mkdir", depends_on: deps, purpose: `新建文件夹 ${folder}`, requirement_ids: [], args: { path: folder } });
      made.set(folder, id);
      return [id];
    };
    for (const [f, t] of Object.entries(moves)) {
      const folder = t.includes("/") ? t.slice(0, t.lastIndexOf("/")) : "";
      const deps = ensure(folder);
      nodes.push({ id: `mv${nodes.length}`, capability: "fs.move", depends_on: deps, purpose: `按教材移动 ${f}`, requirement_ids: [], args: { source: f, destination: t } });
    }
    return { nodes, unsure, notice: sk.notice ?? null };
  }

  /** The rules and checks on one example: right when every file ends where the example says and the checks pass. */
  static replay(sk: { rules: SkillRule[]; expect?: SkillExpect }, ex: Example): boolean {
    let r: { where: Record<string, string>; unsure: string[] };
    try { r = runSkill({ rules: sk.rules }, ex.files, ex.contents ?? {}); }
    catch { return false; }
    if (ex.files.some((f) => (r.where[f] ?? f) !== (ex.want[f] ?? f))) return false;
    return !sk.expect || !failed(checkExpect(sk.expect, ex.files, ex.contents ?? {}, r.where, r.unsure));
  }

  static selfCheck(sk: { rules: SkillRule[]; variants?: { from: string; content?: string; to: string }[]; expect?: SkillExpect }, files: string[], contents: Record<string, string>, moves: Record<string, string>): Wrong[] {
    const wrong: Wrong[] = [];
    let got: { where: Record<string, string>; unsure: string[] };
    try { got = runSkill(sk, files, contents); }
    catch (e) { return [["(rules)", e instanceof SkillError ? e.message : String(e), "valid rules"]]; }
    for (const f of files) { const want = moves[f] ?? f; if ((got.where[f] ?? f) !== want) wrong.push([f, got.where[f] ?? "（拿不准）", want]); }
    const vs = (sk.variants ?? []).filter((v) => v.from && v.to);
    let vg: Record<string, string> = {};
    if (vs.length) {
      try {
        vg = runSkill(sk, vs.map((v) => v.from), Object.fromEntries(vs.map((v) => [v.from, v.content ?? ""]))).where;
        for (const v of vs) if (vg[v.from] !== v.to) wrong.push([v.from + "（设想的写法）", vg[v.from] ?? "（拿不准）", v.to]);
      } catch (e) { wrong.push(["(rules)", e instanceof SkillError ? e.message : String(e), "valid rules"]); }
    }
    // the skill's own checks: they must hold on the right answer (or they check the wrong thing) and on the rules' result
    if (!sk.expect) return [...wrong, ["(expect)", "没写", "写上 expect"]];
    try {
      const say = (r: ExpectReport, where: string): Wrong[] => [
        ...r.uncovered.map((f): Wrong => [f + where, "属于这一类，但规则没认出来", "被规则处理"]),
        ...r.misnamed.map((f): Wrong => [f + where, "新文件名不符合 expect.name", "符合 expect.name"]),
        ...r.touched.map((f): Wrong => [f + where, "不属于这一类，却被移动了", "不动"]),
      ];
      wrong.push(...say(checkExpect(sk.expect, files, contents, moves), "（正确结果不满足 expect）"));
      wrong.push(...say(checkExpect(sk.expect, files, contents, got.where, got.unsure), ""));
      if (vs.length) {
        const vc = Object.fromEntries(vs.map((v) => [v.from, v.content ?? ""]));
        wrong.push(...say(checkExpect(sk.expect, vs.map((v) => v.from), vc, Object.fromEntries(vs.map((v) => [v.from, v.to]))), "（设想的写法，正确结果不满足 expect）"));
        wrong.push(...say(checkExpect(sk.expect, vs.map((v) => v.from), vc, vg), "（设想的写法）"));
      }
    } catch (e) { wrong.push(["(expect)", e instanceof SkillError ? e.message : String(e), "valid expect"]); }
    return wrong;
  }

  /** After a run that moved files successfully: ask the skill role for rules, then admit or reject. */
  async teach(gw: Gateway, raw: string, filesBefore: string[], contents: Record<string, string>, moves: Record<string, string>, family: string, runId = ""): Promise<StoredSkill> {
    const system = SYSTEM + "\n你在写一份可以由程序执行的「教材」。\n" + DSL_HELP;
    const base = [`用户的要求：${raw}`, "", "这次的文件：", ...filesBefore, "", "这次正确的结果（文件 → 新位置）：", ...Object.entries(moves).map(([k, v]) => `- ${k} → ${v}`), "（其余文件不动）", "",
      "先想一想：同一类文件在别人的电脑上、别的软件导出时还可能叫什么名字（至少 6 种：英文、不同分隔符、不同日期写法、带后缀、名字看不出只能看内容的）。把它们写进 variants，再写出能同时覆盖这些写法的 rules，以及检查结果的 expect。"].join("\n");
    const rec: StoredSkill = { id: `S${String(this.skills.length + 1).padStart(3, "0")}`, family, status: "draft", created: now(), version: 1, admission: {} };
    // the teaching example and the variants are judged apart: a variant the rules miss is reported, the example decides
    const onExample = (w: Wrong[]) => w.filter((x) => !x[0].includes("（设想"));
    let sk: SkillAnswer | undefined, wrong: Wrong[] | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = !wrong ? base : base + "\n\n上一版：" + JSON.stringify({ rules: sk!.rules, variants: sk!.variants, expect: sk!.expect }) + "\n程序照它执行，下面这些不对（文件 / 得到 / 应该）：\n" + wrong.map(([a, b, c]) => `- ${a} / ${b} / ${c}`).join("\n") + "\n改好，输出完整的新版本。";
      const rep = await gw.ask("skill", system, prompt, SkillAnswer, runId);
      if (rep.outcome !== "answered") { rec.admission = { decision: "reject", why: `skill role ${rep.outcome}: ${rep.error.slice(0, 100)}` }; break; }
      sk = rep.data!;
      wrong = Library.selfCheck(sk, filesBefore, contents, moves);
      rec.admission = { attempts: attempt + 1, wrong_on_example: onExample(wrong).length, variants: sk.variants.length, variants_wrong: wrong.length - onExample(wrong).length };
      if (!onExample(wrong).length) break;
    }
    if (sk && wrong && !onExample(wrong).length) {
      Object.assign(rec, { title: sk.title, applies_when: sk.applies_when, rules: sk.rules, variants: sk.variants, expect: sk.expect });
      const t = now();
      rec.examples = [{ id: "E1", source: "teach", files: filesBefore, contents, want: moves, confirmed: true, t }];
      for (const v of sk.variants.filter((v) => v.from && v.to)) {
        if (Library.replay(sk, { id: "", source: "variant", files: [v.from], contents: { [v.from]: v.content ?? "" }, want: { [v.from]: v.to }, confirmed: false, t }))
          rec.examples.push({ id: `E${rec.examples.length + 1}`, source: "variant", files: [v.from], contents: { [v.from]: v.content ?? "" }, want: { [v.from]: v.to }, confirmed: false, t });
      }
      rec.status = "probation";                 // validated on the teaching example and its variants; real use decides
      rec.admission.decision = "probation";
    } else {
      rec.status = "rejected";
      rec.admission.decision ??= "reject";
      if (sk) rec.draft = { title: sk.title, rules: sk.rules, expect: sk.expect };
    }
    this.skills.push(rec);
    this.save();
    return rec;
  }

  recordUse(skillId: string, ok: boolean, teacherCalls: number, signals: Signal[] = []) {
    const s = this.skills.find((x) => x.id === skillId);
    if (!s) return;
    s.uses = [...(s.uses ?? []), { ok, teacher_calls: teacherCalls, t: now(), ...(signals.length ? { signals } : {}) }];
    const clean = (u: { ok: boolean; signals?: Signal[] }) => u.ok && !u.signals?.length;
    if (s.status === "probation" && s.uses.length >= 2 && s.uses.slice(-2).every(clean)) s.status = "active";
    if (!ok && s.uses.filter((u) => !u.ok).length >= 2) s.status = "disabled";
    this.save();
  }

  /** After a run that used the skill. files/contents: the folder before the run; final: the moves of a run that ended
   *  right (succeeded and not undone), else null; signals: useSignals of its log. A clean use that ended right becomes
   *  an example; a use with signals that ended right is a counterexample, and the skill is revised on it. The skill's
   *  own checks at instantiation (uncovered, misnamed, touched) are added here. */
  async learn(gw: Gateway, skillId: string, o: { files: string[]; contents: Record<string, string>; final: Record<string, string> | null; signals: Signal[]; corrected?: boolean }, user?: CardUser, runId = ""): Promise<{ signals: Signal[]; example?: string; revision?: "replaced" | "kept" | "asked_kept" | "no_answer" }> {
    const sk = this.skills.find((s) => s.id === skillId);
    if (!sk?.rules) return { signals: o.signals };
    sk.notice = null;                            // said with this use's result
    const p = this.planned.get(skillId) ?? this.plan(sk, o.files, o.contents);
    const own: Signal[] = p.report ? (["uncovered", "misnamed", "touched"] as const).filter((k) => p.report![k].length) : [];
    const signals = [...new Set([...o.signals, ...own])];
    this.planned.delete(skillId);
    if (!o.final) { this.save(); return { signals }; }
    // the example covers the files that are the skill's business: its kind, or what its rules placed
    const scope = o.files.filter((f) => (sk.expect ? ofKind(sk.expect.covers, f.slice(f.lastIndexOf("/") + 1), o.contents[f] ?? "") : true) || (p.where[f] ?? f) !== f);
    const ex: Example = { id: nextId(sk.examples), source: o.corrected ? "correction" : "use", files: scope,
      contents: Object.fromEntries(scope.map((f) => [f, o.contents[f] ?? ""])), want: Object.fromEntries(scope.filter((f) => o.final![f]).map((f) => [f, o.final![f]!])), confirmed: true, t: now() };
    // right on what the run ended with (whatever the signals were about): one more example, nothing to revise
    if (Library.replay(sk as { rules: SkillRule[]; expect?: SkillExpect }, ex)) {
      sk.examples = [...(sk.examples ?? []), ex];
      this.save();
      return { signals, example: ex.id };
    }
    const revision = await this.revise(gw, sk, ex, user, runId);
    return { signals, example: ex.id, revision };
  }

  /** Champion and challenger: the skill role writes a revised version from the counterexample; code replays both on
   *  every example. The new version replaces the old only if it gets the counterexample right and every example the
   *  old one got right. A correction that contradicts a way the user confirmed before is asked about, once. */
  async revise(gw: Gateway, sk: StoredSkill, counter: Example, user?: CardUser, runId = ""): Promise<"replaced" | "kept" | "asked_kept" | "no_answer"> {
    const champion = { rules: sk.rules!, expect: sk.expect };
    let examples = sk.examples ?? [];
    const right = (s: { rules: SkillRule[]; expect?: SkillExpect }, ex: Example) => Library.replay(s, ex);
    const show = (ex: Example) => `${ex.id}（${ex.source}${ex.confirmed ? "，用户确认过" : ""}）：` + ex.files.map((f) => `${f} → ${ex.want[f] ?? "不动"}`).join("；");
    const got = runSkill({ rules: champion.rules }, counter.files, counter.contents ?? {}).where;
    const system = SYSTEM + "\n你在修改一份可以由程序执行的「教材」。\n" + DSL_HELP;
    const prompt = [`当前教材（第 ${sk.version ?? 1} 版）：`, JSON.stringify({ title: sk.title, applies_when: sk.applies_when, rules: sk.rules, variants: sk.variants, expect: sk.expect }), "",
      "它学过的例子（新版必须都还对）：", ...examples.map(show), "",
      `这次用错了。正确的结果：${show(counter)}`, "当前教材给出的：" + counter.files.map((f) => `${f} → ${got[f] ?? "（拿不准）"}`).join("；"), "",
      "写出完整的新版本（rules、variants、expect），再用一句话写 change：这一版比上一版多做了什么（给用户看，例如「现在也会改名」）。",
      "如果这次的正确结果和某个用户确认过的例子互相矛盾（同一类文件，用户以前要一种结果、这次要另一种），在 conflicts_with 写那个例子的 id；不矛盾就写 null。"].join("\n");
    const rep = await gw.ask("skill", system, prompt, SkillRevision, runId);
    const keep = (why: string) => {
      sk.examples = [...examples, counter];       // still an example: a later version has to get it right
      sk.failed_revisions = (sk.failed_revisions ?? 0) + 1;
      sk.revisions = [...(sk.revisions ?? []), { ok: false, version: sk.version ?? 1, why, counter: counter.id, t: now() }];
      if (sk.failed_revisions >= 2) sk.status = "disabled";
      this.save();
      return "kept" as const;
    };
    if (rep.outcome !== "answered") return keep(`skill role ${rep.outcome}`);
    const challenger = { rules: rep.data!.rules, expect: rep.data!.expect ?? sk.expect };
    try { runSkill({ rules: challenger.rules }, counter.files, counter.contents ?? {}); }
    catch (e) { return keep("invalid rules: " + (e instanceof Error ? e.message : String(e))); }
    // the model says the user contradicted an earlier confirmed example: code checks that the new version really cannot
    // keep both, then the user decides which one holds from now on
    const old = examples.find((ex) => ex.id === rep.data!.conflicts_with && ex.confirmed);
    if (old && right(challenger, counter) && right(champion, old) && !right(challenger, old)) {
      if (!user) return keep(`conflicts with ${old.id}; nobody to ask`);
      const sample = (ex: Example) => { const f = ex.files.find((x) => ex.want[x] && ex.want[x] !== x) ?? ex.files[0]!; return `${f} → ${ex.want[f] ?? f}`; };
      const card: Card = { kind: "ambiguity", text: `整理这类文件，以前是「${sample(old)}」，这次是「${sample(counter)}」，以后按哪个？`, free_text: false, blocking: true,
        options: [{ kind: "reading", text: `以前的：${sample(old)}` }, { kind: "reading", text: `这次的：${sample(counter)}` }] };
      const a: Answer | null = user.ask(card);
      if (!a || !("option" in a)) { this.save(); return "no_answer"; }
      if (a.option === 0) { this.save(); return "asked_kept"; }      // the old way holds: this correction was a one-off
      examples = examples.filter((ex) => ex.id !== old.id);         // the new way holds: the old example is retired
    }
    const keepRight = examples.filter((ex) => right(champion, ex));
    const broken = keepRight.filter((ex) => !right(challenger, ex));
    if (!right(challenger, counter)) return keep("the new version is wrong on the counterexample too");
    if (broken.length) return keep(`the new version breaks ${broken.map((e) => e.id).join(", ")}`);
    const t = now();
    Object.assign(sk, { rules: challenger.rules, expect: challenger.expect, variants: rep.data!.variants, title: rep.data!.title || sk.title, applies_when: rep.data!.applies_when || sk.applies_when });
    sk.version = (sk.version ?? 1) + 1;
    sk.examples = [...examples, counter];
    for (const v of rep.data!.variants.filter((v) => v.from && v.to)) {
      const vx: Example = { id: nextId(sk.examples), source: "variant", files: [v.from], contents: { [v.from]: v.content ?? "" }, want: { [v.from]: v.to }, confirmed: false, t };
      if (right(challenger, vx)) sk.examples.push(vx);
    }
    sk.failed_revisions = 0;
    sk.notice = rep.data!.change;
    sk.revisions = [...(sk.revisions ?? []), { ok: true, version: sk.version, change: rep.data!.change, counter: counter.id, t }];
    this.save();
    return "replaced";
  }
}
