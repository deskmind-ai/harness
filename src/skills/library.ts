/**
 * The skill library: executable rules with the 2.0 lifecycle (draft → validated → probation → active, or
 * rejected/disabled), teaching after a successful run, and admission that replays the teaching example and the
 * teacher's own variants before anything is stored.
 *
 * A skill instantiates into plan nodes (fs.mkdir / fs.move) whose arguments the rules computed; the orchestrator still
 * runs the intent check and every execution guard on them. Files the rules cannot place are handed back to the planner.
 */
import * as fs from "node:fs";
import type { Gateway } from "../gateway/index.js";
import type { SkillLibrary } from "../orchestrator/index.js";
import { SYSTEM } from "../orchestrator/prompts.js";
import { SkillAnswer, type SkillRule } from "../protocol/roles.js";
import type { PlanNode } from "../protocol/schemas.js";
import type { Workspace } from "../registry/workspace.js";
import { DSL_HELP, SkillError, runSkill } from "./rules.js";

export type SkillStatus = "draft" | "validated" | "probation" | "active" | "disabled" | "rejected";

export interface StoredSkill {
  id: string;
  family: string;
  status: SkillStatus;
  created: string;
  title?: string;
  applies_when?: string;
  rules?: SkillRule[];
  variants?: { from: string; content?: string; to: string }[];
  admission: Record<string, unknown>;
  uses?: { ok: boolean; teacher_calls: number; t: string }[];
  draft?: unknown;
}

type Wrong = [string, string, string];

export class Library implements SkillLibrary {
  skills: StoredSkill[] = [];

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

  planMoves(sk: StoredSkill, ws: Workspace) {
    const files = Object.entries(ws.entries()).filter(([, v]) => v !== "dir").map(([p]) => p);
    const contents = Object.fromEntries(files.map((f) => [f, ws.read(f)]));
    const { where, unsure } = runSkill({ rules: sk.rules! }, files, contents);
    return { moves: Object.fromEntries(Object.entries(where).filter(([f, t]) => t !== f)), unsure };
  }

  instantiate(skillId: string, ws: Workspace): { nodes: PlanNode[]; unsure: string[] } {
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
    return { nodes, unsure };
  }

  static selfCheck(sk: { rules: SkillRule[]; variants?: { from: string; content?: string; to: string }[] }, files: string[], contents: Record<string, string>, moves: Record<string, string>): Wrong[] {
    const wrong: Wrong[] = [];
    let got: Record<string, string>;
    try { got = runSkill(sk, files, contents).where; }
    catch (e) { return [["(rules)", e instanceof SkillError ? e.message : String(e), "valid rules"]]; }
    for (const f of files) { const want = moves[f] ?? f; if ((got[f] ?? f) !== want) wrong.push([f, got[f] ?? "（拿不准）", want]); }
    const vs = (sk.variants ?? []).filter((v) => v.from && v.to);
    if (vs.length) {
      try {
        const vg = runSkill(sk, vs.map((v) => v.from), Object.fromEntries(vs.map((v) => [v.from, v.content ?? ""]))).where;
        for (const v of vs) if (vg[v.from] !== v.to) wrong.push([v.from + "（设想的写法）", vg[v.from] ?? "（拿不准）", v.to]);
      } catch (e) { wrong.push(["(rules)", e instanceof SkillError ? e.message : String(e), "valid rules"]); }
    }
    return wrong;
  }

  /** After a run that moved files successfully: ask the skill role for rules, then admit or reject. */
  async teach(gw: Gateway, raw: string, filesBefore: string[], contents: Record<string, string>, moves: Record<string, string>, family: string, runId = ""): Promise<StoredSkill> {
    const system = SYSTEM + "\n你在写一份可以由程序执行的「教材」。\n" + DSL_HELP;
    const base = [`用户的要求：${raw}`, "", "这次的文件：", ...filesBefore, "", "这次正确的结果（文件 → 新位置）：", ...Object.entries(moves).map(([k, v]) => `- ${k} → ${v}`), "（其余文件不动）", "",
      "先想一想：同一类文件在别人的电脑上、别的软件导出时还可能叫什么名字（至少 6 种：英文、不同分隔符、不同日期写法、带后缀、名字看不出只能看内容的）。把它们写进 variants，再写出能同时覆盖这些写法的 rules。"].join("\n");
    const rec: StoredSkill = { id: `S${String(this.skills.length + 1).padStart(3, "0")}`, family, status: "draft", created: new Date().toISOString(), admission: {} };
    let sk: SkillAnswer | undefined, wrong: Wrong[] | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      const prompt = !wrong ? base : base + "\n\n上一版：" + JSON.stringify({ rules: sk!.rules, variants: sk!.variants }) + "\n程序照它执行，下面这些不对（文件 / 得到 / 应该）：\n" + wrong.map(([a, b, c]) => `- ${a} / ${b} / ${c}`).join("\n") + "\n改好，输出完整的新版本。";
      const rep = await gw.ask("skill", system, prompt, SkillAnswer, runId);
      if (rep.outcome !== "answered") { rec.admission = { decision: "reject", why: `skill role ${rep.outcome}: ${rep.error.slice(0, 100)}` }; break; }
      sk = rep.data!;
      wrong = Library.selfCheck(sk, filesBefore, contents, moves);
      const onExample = wrong.filter((w) => !w[0].includes("（设想"));
      rec.admission = { attempts: attempt + 1, wrong_on_example: onExample.length, variants: sk.variants.length, variants_wrong: wrong.length - onExample.length };
      if (!onExample.length) break;
    }
    if (sk && wrong && !wrong.some((w) => !w[0].includes("（设想"))) {
      Object.assign(rec, { title: sk.title, applies_when: sk.applies_when, rules: sk.rules, variants: sk.variants });
      rec.status = "probation";                 // validated on the teaching example and its variants; real use decides
      rec.admission.decision = "probation";
    } else {
      rec.status = "rejected";
      rec.admission.decision ??= "reject";
      if (sk) rec.draft = { title: sk.title, rules: sk.rules };
    }
    this.skills.push(rec);
    this.save();
    return rec;
  }

  recordUse(skillId: string, ok: boolean, teacherCalls: number) {
    const s = this.skills.find((x) => x.id === skillId);
    if (!s) return;
    s.uses = [...(s.uses ?? []), { ok, teacher_calls: teacherCalls, t: new Date().toISOString() }];
    if (s.status === "probation" && s.uses.length >= 2 && s.uses.slice(-2).every((u) => u.ok)) s.status = "active";
    if (!ok && s.uses.filter((u) => !u.ok).length >= 2) s.status = "disabled";
    this.save();
  }
}
