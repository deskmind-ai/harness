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
import { DSL_HELP, SkillError, checkExpect, coversSomething, failed, runSkill, type ExpectReport } from "./rules.js";

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
  revisions?: { ok: boolean; version: number; change?: string; why?: string; counter: string; counted?: boolean; asked?: boolean; retired?: string[]; t: string }[];
  failed_revisions?: number;                     // in a row, of versions written and lost on the replay; two disable the skill
  notice?: string | null;                        // what the last revision changed, said once with the next result
  draft?: unknown;
}

type Wrong = [string, string, string];
type Run = { where: Record<string, string>; unsure: string[]; matched: string[] };
type Planned = { files: string[]; contents: Record<string, string>; raw: Run; where: Record<string, string>; unsure: string[]; report: ExpectReport | null };
type Rules = { rules: SkillRule[]; expect?: SkillExpect };
type Outcome = "replaced" | "kept" | "asked_kept" | "no_answer";

const now = () => new Date().toISOString();
const nextId = (examples: Example[] | undefined) => `E${Math.max(0, ...(examples ?? []).map((e) => Number(e.id.slice(1)) || 0)) + 1}`;
const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

/** The moves between two trees (path → content): a file gone from `start` whose content shows up at a new path. Same
 *  name first, so two files with the same content are not paired crosswise. */
export function movesBetween(start: Record<string, string | null>, end: Record<string, string | null>): Record<string, string> {
  const moves: Record<string, string> = {}, taken = new Set<string>();
  const gone = Object.entries(start).filter(([p, v]) => v !== null && !(p in end));
  const fresh = Object.entries(end).filter(([q, w]) => w !== null && !(q in start));
  for (const byName of [true, false]) for (const [p, v] of gone) {
    if (p in moves) continue;
    const dst = fresh.find(([q, w]) => w === v && !taken.has(q) && (!byName || base(q) === base(p)))?.[0];
    if (dst) { moves[p] = dst; taken.add(dst); }
  }
  return moves;
}

/** The misuse signals of a run that used a skill, from its log: a guard or check stopping one of the skill's steps,
 *  the user declining a step of it, picking another reading or answering in their own words on its cards, the goal
 *  check failing after it, and the user undoing the result. */
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
    if (own && e.kind === "interaction.reply" && e.body?.kind === "clarify" && (e.body.purpose === "plan" || e.body.card === "plan" || e.body.card === "action")) out.add("declined");
    if (e.kind === "verification" && e.subject === "goal" && e.passed === false) out.add("goal");
    if (e.kind === "result.response" && (e.picked === "undo" || e.picked === "undo_and_reading")) out.add("undone");
  }
  return [...out];
}

/** Whether the user approved what the skill's run did: its plan card, or the result card. */
export function useApproved(events: { kind: string; [k: string]: any }[]): boolean {
  const at = events.findIndex((e) => e.kind === "plan.accepted" && e.plan?.source === "skill");
  return at >= 0 && events.slice(at + 1).some((e) => (e.kind === "interaction.reply" && e.body?.kind === "authorize" && (e.body.purpose === "plan" || e.body.purpose === "result") && e.body.approved === true)
    || (e.kind === "result.response" && e.picked === "approve"));
}

/** What a finished run that used a skill gives to learn from: its moves are right when it ended succeeded (an undo
 *  leaves it cancelled; undo and another reading, redone, ends succeeded), and the user corrected it when they declined
 *  or redirected the skill's plan, or undid the result for another reading. */
export function useOutcome(status: string, resultResponse: string | null, signals: Signal[]): { right: boolean; corrected: boolean } {
  return { right: status === "succeeded", corrected: signals.includes("declined") || resultResponse === "undo_and_reading" };
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
   *  one of the skill's kind no rule took (uncovered), one taken under the wrong name, one of another kind moved. */
  plan(sk: StoredSkill, files: string[], contents: Record<string, string>): Planned {
    const raw = runSkill({ rules: sk.rules! }, files, contents);
    const report = sk.expect ? checkExpect(sk.expect, files, contents, raw.where, raw.unsure, raw.matched) : null;
    const back = report ? [...report.uncovered, ...report.misnamed, ...report.touched] : [];
    const where = { ...raw.where };
    for (const f of back) delete where[f];
    return { files, contents, raw, where, unsure: [...new Set([...raw.unsure, ...back])], report };
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

  /** The rules and checks on one example: right when every file ends where the example says and the checks pass. A
   *  pattern that does not compile (in the rules or the checks) is a wrong answer, never an exception. */
  static replay(sk: Rules, ex: Example): boolean {
    try {
      const r = runSkill({ rules: sk.rules }, ex.files, ex.contents ?? {});
      if (ex.files.some((f) => (r.where[f] ?? f) !== (ex.want[f] ?? f))) return false;
      return !sk.expect || !failed(checkExpect(sk.expect, ex.files, ex.contents ?? {}, r.where, r.unsure, r.matched));
    } catch { return false; }
  }

  /** Whether an example's right answer itself breaks these checks (then the checks were wrong, not the answer): a file
   *  they count as this kind left where it was counts as not taken. */
  static answerBreaks(expect: SkillExpect, ex: Example): boolean {
    const moved = ex.files.filter((f) => (ex.want[f] ?? f) !== f);
    try { return failed(checkExpect(expect, ex.files, ex.contents ?? {}, Object.fromEntries(ex.files.map((f) => [f, ex.want[f] ?? f])), [], moved)); }
    catch { return true; }
  }

  /** How a new version is judged against the old one on a counterexample: right on an example under its own checks and,
   *  unless the counterexample's right answer breaks them, under the old version's checks too (so it cannot pass by
   *  weakening its own). */
  static judge(champion: Rules, counter: Example): (s: Rules, ex: Example) => boolean {
    const bindOld = !!champion.expect && !Library.answerBreaks(champion.expect, counter);
    return (s, ex) => Library.replay(s, ex) && (!bindOld || Library.replay({ rules: s.rules, expect: champion.expect }, ex));
  }

  static selfCheck(sk: { rules: SkillRule[]; variants?: { from: string; content?: string; to: string }[]; expect?: SkillExpect }, files: string[], contents: Record<string, string>, moves: Record<string, string>): Wrong[] {
    const wrong: Wrong[] = [];
    let got: Run;
    try { got = runSkill(sk, files, contents); }
    catch (e) { return [["(rules)", e instanceof SkillError ? e.message : String(e), "valid rules"]]; }
    for (const f of files) { const want = moves[f] ?? f; if ((got.where[f] ?? f) !== want) wrong.push([f, got.where[f] ?? "（拿不准）", want]); }
    const vs = (sk.variants ?? []).filter((v) => v.from && v.to);
    let vg: Run = { where: {}, unsure: [], matched: [] };
    if (vs.length) {
      try {
        vg = runSkill(sk, vs.map((v) => v.from), Object.fromEntries(vs.map((v) => [v.from, v.content ?? ""])));
        for (const v of vs) if (vg.where[v.from] !== v.to) wrong.push([v.from + "（设想的写法）", vg.where[v.from] ?? "（拿不准）", v.to]);
      } catch (e) { wrong.push(["(rules)", e instanceof SkillError ? e.message : String(e), "valid rules"]); }
    }
    // the skill's own checks: they must say something, and hold on the right answer (or they check the wrong thing)
    // and on the rules' result
    if (!sk.expect) return [...wrong, ["(expect)", "没写", "写上 expect"]];
    if (!coversSomething(sk.expect.covers)) return [...wrong, ["(expect)", "covers 是空的", "写上这一类文件的扩展名、名字或内容"]];
    try {
      const say = (r: ExpectReport, where: string): Wrong[] => [
        ...r.uncovered.map((f): Wrong => [f + where, "属于这一类，但规则没认出来", "被规则处理"]),
        ...r.misnamed.map((f): Wrong => [f + where, "新文件名不符合 expect.name", "符合 expect.name"]),
        ...r.touched.map((f): Wrong => [f + where, "不属于这一类，却被移动了", "不动"]),
      ];
      wrong.push(...say(checkExpect(sk.expect, files, contents, moves), "（正确结果不满足 expect）"));
      wrong.push(...say(checkExpect(sk.expect, files, contents, got.where, got.unsure, got.matched), ""));
      if (vs.length) {
        const vc = Object.fromEntries(vs.map((v) => [v.from, v.content ?? ""]));
        wrong.push(...say(checkExpect(sk.expect, vs.map((v) => v.from), vc, Object.fromEntries(vs.map((v) => [v.from, v.to]))), "（设想的写法，正确结果不满足 expect）"));
        wrong.push(...say(checkExpect(sk.expect, vs.map((v) => v.from), vc, vg.where, vg.unsure, vg.matched), "（设想的写法）"));
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
        const vx: Example = { id: nextId(rec.examples), source: "variant", files: [v.from], contents: { [v.from]: v.content ?? "" }, want: { [v.from]: v.to }, confirmed: false, t };
        if (Library.replay(sk, vx)) rec.examples.push(vx);
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

  /** After a run that used the skill: the use is recorded (with the skill's own check signals added), and learnt from.
   *  files/contents: the folder before the run; final: the moves of a run that ended right (succeeded), else null;
   *  signals: useSignals of its log; approved: the user approved its plan or result (useApproved); corrected: the
   *  user corrected it (declined, another reading, their own words); noticeShown: the result card said what the last
   *  revision changed. A use the skill got right becomes an example; one it got wrong that ended right is a
   *  counterexample, and the skill is revised on it. The example is confirmed (binding on every later version) only
   *  when the user approved or corrected the run. */
  async learn(gw: Gateway, skillId: string, o: { files: string[]; contents: Record<string, string>; final: Record<string, string> | null; signals: Signal[]; ok?: boolean; teacherCalls?: number; approved?: boolean; corrected?: boolean; noticeShown?: boolean }, user?: CardUser, runId = ""): Promise<{ signals: Signal[]; example?: string; revision?: Outcome }> {
    const sk = this.skills.find((s) => s.id === skillId);
    if (!sk?.rules) return { signals: o.signals };
    if (o.noticeShown) sk.notice = null;         // said once, with the result it was shown on
    const p = this.planned.get(skillId) ?? this.plan(sk, o.files, o.contents);
    this.planned.delete(skillId);
    const own: Signal[] = p.report ? (["uncovered", "misnamed", "touched"] as const).filter((k) => p.report![k].length) : [];
    const signals = [...new Set([...o.signals, ...own])];
    this.recordUse(skillId, o.ok ?? o.final !== null, o.teacherCalls ?? 0, signals);
    if (!o.final) { this.save(); return { signals }; }
    // the example keeps every file of the folder: one the skill moved by mistake, and one of a kind its checks did not
    // know yet but the user's run filed, are what a revision has to learn from
    const scope = o.files;
    const ex: Example = { id: nextId(sk.examples), source: o.corrected ? "correction" : "use", files: scope,
      contents: Object.fromEntries(scope.map((f) => [f, o.contents[f] ?? ""])), want: Object.fromEntries(scope.filter((f) => o.final![f]).map((f) => [f, o.final![f]!])),
      confirmed: !!(o.approved || o.corrected), t: now() };
    // right on what the run ended with (whatever the signals were about): one more example, nothing to revise
    if (Library.replay(sk as Rules, ex)) {
      sk.examples = [...(sk.examples ?? []), ex];
      this.save();
      return { signals, example: ex.id };
    }
    const revision = await this.revise(gw, sk, ex, user, runId);
    return { signals, example: ex.id, revision };
  }

  private async askRevision(gw: Gateway, sk: StoredSkill, examples: Example[], counter: Example, broke: Example[], runId: string) {
    const show = (ex: Example) => `${ex.id}（${ex.source}${ex.confirmed ? "，用户确认过" : ""}）：` + ex.files.map((f) => `${f} → ${ex.want[f] ?? "不动"}`).join("；");
    let got: Record<string, string> = {};
    try { got = runSkill({ rules: sk.rules! }, counter.files, counter.contents ?? {}).where; } catch { /* shown as 拿不准 */ }
    const system = SYSTEM + "\n你在修改一份可以由程序执行的「教材」。\n" + DSL_HELP;
    const prompt = [`当前教材（第 ${sk.version ?? 1} 版）：`, JSON.stringify({ title: sk.title, applies_when: sk.applies_when, rules: sk.rules, variants: sk.variants, expect: sk.expect }), "",
      "它学过的例子（用户确认过的，新版必须都对；设想的写法尽量保留）：", ...examples.map(show), "",
      `这次用错了。正确的结果：${show(counter)}`, "当前教材给出的：" + counter.files.map((f) => `${f} → ${got[f] ?? "（拿不准）"}`).join("；"), "",
      ...(broke.length ? ["你上一次写的新版把这些用户确认过的例子改坏了：", ...broke.map(show), "再写一版，让它们和这次的正确结果都对。确实两者不能同时满足，就照旧输出你认为最好的版本，并在 conflicts_with 写冲突的例子 id。", ""] : []),
      "写出完整的新版本（rules、variants、expect），再用一句话写 change：这一版比上一版多做了什么（给用户看，例如「现在也会改名」）。",
      "如果这次的正确结果和某个用户确认过的例子互相矛盾（同一类文件，用户以前要一种结果、这次要另一种），在 conflicts_with 写那个例子的 id；不矛盾就写 null。"].join("\n");
    return gw.ask("skill", system, prompt, SkillRevision, runId);
  }

  /** Champion and challenger: the skill role writes a revised version from the counterexample; code replays both on
   *  every example. The new version replaces the old only if it gets the counterexample right and every confirmed
   *  example right; imagined variants it breaks are dropped (they never outrank what the user confirmed). The old
   *  version's checks bind the new one too, unless this right answer breaks them. If the new version breaks a
   *  confirmed example, the skill role gets one more try at a version that keeps both; only if that also fails is the
   *  user asked which way holds from now on. A failure counts toward disabling only when a version was written and
   *  lost the replay. */
  async revise(gw: Gateway, sk: StoredSkill, counter: Example, user?: CardUser, runId = ""): Promise<Outcome> {
    const champion: Rules = { rules: sk.rules!, expect: sk.expect };
    const examples = sk.examples ?? [];
    const right = Library.judge(champion, counter);
    const log = (ok: boolean, why: string, more: Record<string, unknown> = {}) =>
      (sk.revisions = [...(sk.revisions ?? []), { ok, version: sk.version ?? 1, why, counter: counter.id, t: now(), ...more }]);
    const keep = (why: string, counted: boolean): Outcome => {
      if (counter.confirmed || counted) sk.examples = [...examples, counter];   // a later version has to get it right
      log(false, why, { counted });
      if (counted) {
        sk.failed_revisions = (sk.failed_revisions ?? 0) + 1;
        if (sk.failed_revisions >= 2) sk.status = "disabled";
      }
      this.save();
      return "kept";
    };
    type Tried = { ch: Rules; data: SkillRevision; counterOk: boolean; brokenConfirmed: Example[]; brokenImagined: Example[] };
    const attempt = async (broke: Example[]): Promise<Tried | string> => {
      const rep = await this.askRevision(gw, sk, examples, counter, broke, runId);
      if (rep.outcome !== "answered") return `skill role ${rep.outcome}`;
      const ch: Rules = { rules: rep.data!.rules, expect: rep.data!.expect ?? sk.expect };
      try { runSkill({ rules: ch.rules }, counter.files, counter.contents ?? {}); }
      catch (e) { return "invalid rules: " + (e instanceof Error ? e.message : String(e)); }
      if (ch.expect) {
        try { checkExpect(ch.expect, counter.files, counter.contents ?? {}, {}, [], counter.files); }
        catch { return "invalid expect"; }
      }
      return { ch, data: rep.data!, counterOk: right(ch, counter), brokenConfirmed: examples.filter((ex) => ex.confirmed && !right(ch, ex)), brokenImagined: examples.filter((ex) => !ex.confirmed && !right(ch, ex)) };
    };
    const replace = (t: Tried, retired: Example[], asked = false): Outcome => {
      const at = now();
      Object.assign(sk, { rules: t.ch.rules, expect: t.ch.expect, variants: t.data.variants, title: t.data.title || sk.title, applies_when: t.data.applies_when || sk.applies_when });
      sk.version = (sk.version ?? 1) + 1;
      sk.examples = [...examples.filter((ex) => !retired.includes(ex)), counter];
      for (const v of t.data.variants.filter((v) => v.from && v.to)) {
        const vx: Example = { id: nextId(sk.examples), source: "variant", files: [v.from], contents: { [v.from]: v.content ?? "" }, want: { [v.from]: v.to }, confirmed: false, t: at };
        if (right(t.ch, vx)) sk.examples.push(vx);
      }
      sk.failed_revisions = 0;
      sk.notice = t.data.change;
      sk.revisions = [...(sk.revisions ?? []), { ok: true, version: sk.version, change: t.data.change, counter: counter.id, t: at, ...(asked ? { asked } : {}), ...(retired.length ? { retired: retired.map((e) => e.id) } : {}) }];
      this.save();
      return "replaced";
    };
    const first = await attempt([]);
    if (typeof first === "string") return keep(first, first.startsWith("invalid"));
    if (!first.counterOk) return keep("the new version is wrong on the counterexample too", true);
    if (!first.brokenConfirmed.length) return replace(first, first.brokenImagined);
    // it breaks something the user confirmed: one more try at a version that keeps both, before calling it a conflict
    const second = await attempt(first.brokenConfirmed);
    if (typeof second !== "string" && second.counterOk && !second.brokenConfirmed.length) return replace(second, second.brokenImagined);
    const best = typeof second !== "string" && second.counterOk && second.brokenConfirmed.length < first.brokenConfirmed.length ? second : first;
    if (!user) return keep(`conflicts with ${best.brokenConfirmed.map((e) => e.id).join(", ")}; nobody to ask`, false);
    const old = best.brokenConfirmed.find((ex) => ex.id === best.data.conflicts_with) ?? best.brokenConfirmed.find((ex) => Library.replay(champion, ex)) ?? best.brokenConfirmed[0]!;
    const sample = (ex: Example) => { const f = ex.files.find((x) => ex.want[x] && ex.want[x] !== x) ?? ex.files[0]!; return `${f} → ${ex.want[f] ?? f}`; };
    const card: Card = { kind: "ambiguity", text: `整理这类文件，以前是「${sample(old)}」，这次是「${sample(counter)}」，以后按哪个？`, free_text: false, blocking: true,
      options: [{ kind: "reading", text: `以前的：${sample(old)}` }, { kind: "reading", text: `这次的：${sample(counter)}` }] };
    const a: Answer | null = user.ask(card);
    if (!a || !("option" in a)) { log(false, "conflict: no answer", { counted: false, asked: true }); this.save(); return "no_answer"; }
    if (a.option === 0) { log(false, "conflict: the user keeps the old way", { counted: false, asked: true }); this.save(); return "asked_kept"; }
    // the new way holds: everything of the old way that version breaks is retired, imagined variants included
    return replace(best, [...best.brokenConfirmed, ...best.brokenImagined], true);
  }
}
