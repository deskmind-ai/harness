/**
 * Teaching on the runtime path (skills-layer-2026-10-18.md §学会、收下): after a run the user confirmed, a strong
 * model writes a tutorial in words — the user's own words, how to do it, when not to — plus the confirmed example
 * (the folder before and after). It is a draft until admitted: the runtime does the example again with the tutorial
 * in hand, and only a result identical to what the user confirmed admits it. Nothing is a regex; the model reads the
 * tutorial, code only compares trees.
 */
import { z } from "zod";
import type { Gateway } from "../gateway/index.js";
import { SYSTEM } from "../orchestrator/prompts.js";
import { SkillStore, type Skill } from "./agentskills.js";

export type Tree = Record<string, string | null>;

export const TaughtSkill = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  description: z.string().min(8).max(1024),
  /** The SKILL.md body: 「用户当时的原话」「怎么做」「不适用」 in words, with the example's names where they help. */
  body: z.string().min(20),
  scope: z.object({ apps: z.array(z.string()).default([]), objects: z.array(z.string()).default([]), family: z.string().default("") }),
  effects: z.array(z.string()).default([]),
});

const norm = (t: Tree): Tree => Object.fromEntries(Object.entries(t).filter(([k]) => !k.startsWith(".deskmind")).map(([k, v]) => [k, v === null ? null : v.replace(/\n+$/, "")]));
export const sameTree = (a: Tree, b: Tree) => JSON.stringify(Object.entries(norm(a)).sort()) === JSON.stringify(Object.entries(norm(b)).sort());

/** Write the tutorial a confirmed run teaches, as a draft with its confirmed example. null when the model's answer
 *  is unusable (the run is still a success; it just taught nothing). */
export async function teachFromRun(gw: Gateway, store: SkillStore, o: { raw: string; answers?: string[]; before: Tree; after: Tree; effects: string[]; family?: string; runId?: string }): Promise<Skill | null> {
  const files = (t: Tree) => Object.entries(t).map(([p, v]) => (v === null ? `${p}/` : `${p}（${v.slice(0, 60).replace(/\n/g, "⏎")}）`));
  const prompt = [
    "任务：把用户确认过的一次做法写成一份教程（Agent Skills 的 SKILL.md），以后同类要求照它做。用自然语言写，不写正则、不写代码。",
    "", `用户的原话：${JSON.stringify(o.raw)}`, ...(o.answers?.length ? [`用户后来的回答：${JSON.stringify(o.answers)}`] : []),
    "做之前的文件夹：", ...files(o.before), "做完之后（用户确认过的）：", ...files(o.after), "做了的动作：", ...o.effects,
    "", "要求：",
    "- name：小写字母、数字、连字符，最长 64，说明是哪类事（例如 organize-meeting-minutes）。description：做什么、什么时候用，用户会怎么说。",
    "- body 分三段：「## 用户当时的原话」原样抄；「## 怎么做」写规则——按什么分、放哪、改不改名、拿不准的怎么办，规则要能泛化到同类文件在别的电脑上的叫法，用这次的文件当例子；「## 不适用」写什么情况不要用这份教程、用户这次说的和教程不同时以这次为准。",
    "- scope：apps（涉及的应用）、objects（文件夹、文件类型如 docx/*、网站）、family（哪一族任务，用用户的话说）。effects：会产生的后果类别（create / move / modify_user / external）。",
  ].join("\n");
  const rep = await gw.ask("skill", SYSTEM, prompt, TaughtSkill, o.runId ?? "");
  if (rep.outcome !== "answered") return null;
  const d = rep.data!;
  const name = store.names().includes(d.name) ? `${d.name}-${store.names().length + 1}` : d.name;
  const skill: Skill = {
    name, description: d.description, body: d.body,
    meta: { source: "taught", status: "draft", version: 1, scope: d.scope, effects: d.effects, taught_from: o.runId, taught_on: new Date().toISOString().slice(0, 10) },
    confirmed: [{ raw: o.raw, before: o.before, after: o.after, t: new Date().toISOString() }], counter: [],
  };
  store.write(skill);
  return skill;
}

/** Admission: do the confirmed example again with the tutorial, by whatever runs tasks (`replay`), and keep the
 *  tutorial only when the folder ends exactly as the user confirmed. A draft that fails is retired, with the reason
 *  in its state, never silently kept. */
export async function admit(store: SkillStore, name: string, replay: (raw: string, before: Tree, skill: string) => Promise<Tree | null>): Promise<{ admitted: boolean; why: string }> {
  const s = store.get(name);
  if (!s) return { admitted: false, why: "no such skill" };
  const ex = s.confirmed[0] as { raw: string; before: Tree; after: Tree } | undefined;
  if (!ex) return { admitted: false, why: "no confirmed example to replay" };
  const got = await replay(ex.raw, ex.before, name);
  const ok = !!got && sameTree(got, ex.after);
  s.meta.status = ok ? "admitted" : "retired";
  s.state = { ...(s.state ?? {}), admission: { ok, why: ok ? "the replay ended as the user confirmed" : got ? "the replay ended differently" : "the replay did not finish", t: new Date().toISOString() } };
  store.write(s);
  return { admitted: ok, why: String((s.state.admission as { why: string }).why) };
}

/** A use that went wrong (the user undid the result, or the verdict failed) is a counterexample: written down with
 *  what the user said and what the folder looked like, then the skill role writes the next version from every example
 *  the skill has. The new version is admitted the same way as the first — every confirmed example replayed must end
 *  as confirmed — or the old version stays and the counterexample waits for the next revision. */
export async function reviseFromCounter(gw: Gateway, store: SkillStore, name: string, counter: { raw: string; before: Tree; after: Tree | null; why: string }, replay: (raw: string, before: Tree, skill: string) => Promise<Tree | null>): Promise<{ revised: boolean; why: string }> {
  const s = store.get(name);
  if (!s) return { revised: false, why: "no such skill" };
  s.counter = [...s.counter, { ...counter, t: new Date().toISOString() }];
  store.write(s);
  const show = (ex: { raw: string; before: Tree; after: Tree | null }) => `- 原话「${ex.raw}」；做之前：${Object.keys(ex.before).join("、")}；${ex.after ? "正确结果：" + Object.keys(ex.after).join("、") : "没有正确结果"}`;
  const prompt = [
    `任务：修订一份教程（第 ${s.meta.version} 版）。它这次用错了；下面是它学过的例子（用户确认过的，新版必须都对）和这次的反例。只改需要改的，用自然语言，不写正则。`,
    "", "当前教程：", s.body, "", "用户确认过的例子：", ...s.confirmed.map((e) => show(e as never)), "", "反例（这次用错了）：", show(counter), `哪里错了：${counter.why}`,
    "", "输出完整的新版本（name 保持不变，description 可以改，body 三段照旧，scope、effects 照旧或更准）。",
  ].join("\n");
  const rep = await gw.ask("skill", SYSTEM, prompt, TaughtSkill, name);
  if (rep.outcome !== "answered") return { revised: false, why: `skill role ${rep.outcome}` };
  const d = rep.data!;
  // every confirmed example must still end as the user confirmed under the new words
  const candidate: Skill = { ...s, description: d.description, body: d.body, meta: { ...s.meta, version: s.meta.version + 1, scope: d.scope, effects: d.effects } };
  const probe = `${name}--v${candidate.meta.version}`;
  store.write({ ...candidate, name: probe, meta: { ...candidate.meta, status: "draft" } });
  let ok = true;
  for (const ex of s.confirmed as { raw: string; before: Tree; after: Tree }[]) {
    const got = await replay(ex.raw, ex.before, probe);
    if (!got || !sameTree(got, ex.after)) { ok = false; break; }
  }
  store.remove(probe);
  if (!ok) { s.state = { ...(s.state ?? {}), revisions: [...((s.state?.revisions as unknown[]) ?? []), { ok: false, version: s.meta.version, why: "the new version broke a confirmed example", t: new Date().toISOString() }] }; store.write(s); return { revised: false, why: "the new version broke a confirmed example; the old one stays" }; }
  candidate.state = { ...(s.state ?? {}), revisions: [...((s.state?.revisions as unknown[]) ?? []), { ok: true, version: candidate.meta.version, t: new Date().toISOString() }] };
  store.write(candidate);
  return { revised: true, why: `version ${candidate.meta.version}` };
}
