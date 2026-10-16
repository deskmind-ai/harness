/**
 * Executable skills: the rule language of openjev experiments/stress-2026-10-07/skills2.py, in TypeScript.
 *
 *   match     one regex or a list (alternatives), searched case-insensitively in the file name
 *   content   regex(es) searched in the file's text, for files whose name says nothing
 *   ext       the extensions the rule may take; none: any
 *   not       regex(es) that exclude a file
 *   to / rename   templates with {field}, {field|02} (zero-pad), {field|int} (drop .00), {field|lower}, {d[0:4]} (slice)
 *   latest    {group, version, older_to}: keep the newest per group, older ones go to older_to
 *
 * Rules written by a model are data, never code: the teacher's regexes are compiled here with Python named groups
 * (?P<x>) translated to JavaScript (?<x>). When both match and content are given both must hit and their fields merge
 * (the content's win on a clash).
 */
import type { SkillExpect, SkillRule } from "../protocol/roles.js";

export class SkillError extends Error {}

const list = (x: string | string[] | undefined): string[] => (x === undefined ? [] : typeof x === "string" ? [x] : x);
const FULL = "０１２３４５６７８９";
const toAscii = (v: string) => v.replace(/[０-９]/g, (c) => String(FULL.indexOf(c)));

function normalize(v: string, f: string | undefined): string {
  if (!f) return v;
  if (f === "int") { const m = /^\s*0*(\d+)/.exec(toAscii(v)); return m ? m[1]! : v; }
  if (/^\d+$/.test(f)) { const digits = toAscii(v).replace(/\D/g, ""); return digits ? digits.padStart(Number(f), "0") : v; }
  if (f === "lower") return v.toLowerCase();
  if (f === "upper") return v.toUpperCase();
  return v;
}

const FIELD = /\{(\w+)(?:\[(\d*):(\d*)\])?(?:\|(\w+))?\}/g;

export function fill(template: string, groups: Record<string, string>): string {
  return template.replace(FIELD, (_, name: string, a: string | undefined, b: string | undefined, f: string | undefined) => {
    if (!(name in groups)) throw new SkillError(`missing field ${name}`);
    let v = groups[name]!;
    if (a !== undefined || b !== undefined) v = [...v].slice(a ? Number(a) : undefined, b ? Number(b) : undefined).join("");
    return normalize(v, f);
  });
}

const compile = (p: string) => {
  try { return new RegExp(p.replace(/\(\?P</g, "(?<"), "iu"); }
  catch (e) { throw new SkillError(`bad pattern ${p}: ${e instanceof Error ? e.message : e}`); }
};

interface Compiled { names: RegExp[]; contents: RegExp[]; nots: RegExp[] }

function hit(rule: SkillRule, c: Compiled, name: string, text: string): Record<string, string> | null {
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const exts = list(rule.ext).map((e) => e.toLowerCase().replace(/^\./, ""));
  if (exts.length && !exts.includes(ext)) return null;
  if (c.nots.some((n) => n.test(name))) return null;
  let nm: RegExpExecArray | null = null;
  for (const rx of c.names) { nm = rx.exec(name); if (nm) break; }
  let cm: RegExpExecArray | null = null;
  for (const rx of c.contents) { cm = rx.exec(text); if (cm) break; }
  const groups = (m: RegExpExecArray | null) => Object.fromEntries(Object.entries(m?.groups ?? {}).filter(([, v]) => v !== undefined)) as Record<string, string>;
  if (c.names.length && c.contents.length) return nm && cm ? { ...groups(nm), ...groups(cm) } : null;
  const m = nm ?? cm;
  return m ? groups(m) : null;
}

export interface Skill { rules: SkillRule[] }

/** Where every file goes under the skill, the files it could not decide (two rules, or a template error), and the files
 *  a rule matched at all: a file already where its rule puts it stays put, and is still the rule's (where alone cannot
 *  tell it from a file no rule knows). */
export function runSkill(skill: Skill, files: string[], contents: Record<string, string> = {}): { where: Record<string, string>; unsure: string[]; matched: string[] } {
  if (!Array.isArray(skill.rules) || !skill.rules.length) throw new SkillError("no rules");
  const compiled: [SkillRule, Compiled][] = skill.rules.map((r) => [r, { names: list(r.match).map(compile), contents: list(r.content).map(compile), nots: list(r.not).map(compile) }]);
  const where: Record<string, string> = {}, unsure: string[] = [], hits = new Map<string, [SkillRule, Record<string, string>]>();
  for (const f of files) {
    const name = f.slice(f.lastIndexOf("/") + 1);
    const ms = compiled.map(([r, c]) => [r, hit(r, c, name, contents[f] ?? "")] as const).filter((x) => x[1] !== null);
    if (ms.length > 1) unsure.push(f);
    else if (!ms.length) where[f] = f;
    else hits.set(f, [ms[0]![0], ms[0]![1]!]);
  }
  const latest = new Map<string, number>();
  for (const [f, [r, g]] of hits) {
    const lv = r.latest;
    if (!lv) continue;
    try {
      const key = `${r.name}\u0000${normalize(g[lv.group]!, "lower")}`;
      const v = Number(normalize(g[lv.version]!, "int"));
      if (Number.isNaN(v)) throw new SkillError("version");
      latest.set(key, Math.max(latest.get(key) ?? -1, v));
    } catch { unsure.push(f); }
  }
  for (const [f, [r, g]] of hits) {
    if (unsure.includes(f)) continue;
    try {
      let folder = r.to ?? "", rename = r.rename;
      const lv = r.latest;
      if (lv) {
        const key = `${r.name}\u0000${normalize(g[lv.group]!, "lower")}`;
        if (Number(normalize(g[lv.version]!, "int")) < latest.get(key)!) { folder = lv.older_to; rename = lv.rename; }
      }
      folder = fill(folder, g).replace(/^\/+|\/+$/g, "");
      const name = rename ? fill(rename, g) : f.slice(f.lastIndexOf("/") + 1);
      if (name.includes("/") || folder.split("/").includes("..")) { unsure.push(f); continue; }
      where[f] = folder ? `${folder}/${name}` : name;
    } catch { unsure.push(f); }
  }
  return { where, unsure, matched: [...hits.keys()] };
}

/** Whether a file is the kind the skill is for (expect.covers): its extension, when listed, and its name or its text,
 *  when patterns are given. */
export function ofKind(covers: SkillExpect["covers"], name: string, text = ""): boolean {
  if (!coversSomething(covers)) throw new SkillError("expect.covers names no extension, name or content");
  const ext = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "";
  const exts = list(covers.ext).map((e) => e.toLowerCase().replace(/^\./, ""));
  if (exts.length && !exts.includes(ext)) return false;
  const names = list(covers.name).map(compile), contents = list(covers.content).map(compile);
  if (!names.length && !contents.length) return exts.length > 0;
  return names.some((rx) => rx.test(name)) || contents.some((rx) => rx.test(text));
}

/** covers has to say something (an extension, a name or a content pattern): an empty one checks nothing. */
export const coversSomething = (covers: SkillExpect["covers"] | undefined) => !!covers && [covers.ext, covers.name, covers.content].some((x) => list(x).some((v) => v.trim()));

export interface ExpectReport {
  uncovered: string[];        // of the skill's kind, but no rule placed it
  misnamed: string[];         // placed, but its new name is not what expect.name says
  touched: string[];          // not of the skill's kind, yet moved
}

/** The skill's own checks on one result (where: file → new path, unsure: files the rules could not decide, matched:
 *  files a rule took). matched null: a result no rules produced (the right answer), where "uncovered" means nothing. */
export function checkExpect(expect: SkillExpect, files: string[], contents: Record<string, string>, where: Record<string, string>, unsure: string[] = [], matched: string[] | null = null): ExpectReport {
  const names = list(expect.name).map(compile);
  const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);
  const r: ExpectReport = { uncovered: [], misnamed: [], touched: [] };
  for (const f of files) {
    const moved = (where[f] ?? f) !== f;
    const kind = ofKind(expect.covers, base(f), contents[f] ?? "");
    const taken = matched ? matched.includes(f) : moved;
    if (matched && kind && !taken && !unsure.includes(f)) r.uncovered.push(f);
    if (taken && kind && !unsure.includes(f) && names.length && !names.some((rx) => rx.test(base(where[f] ?? f)))) r.misnamed.push(f);
    if (moved && !kind && expect.untouched !== false) r.touched.push(f);
  }
  return r;
}

export const failed = (r: ExpectReport) => r.uncovered.length + r.misnamed.length + r.touched.length > 0;

export const DSL_HELP = `教材写成可以由程序执行的规则（JSON）。程序照规则移动文件，小模型只负责选用哪份教材、判断某个文件归不归它管。
**规则要能认出同一类文件的各种叫法，不能只认这一次的写法。**
{"title": "<一句话>", "applies_when": "<什么样的请求、什么样的文件适用>",
 "rules": [{"name": "<规则名>",
            "match": ["<正则1>", "<正则2>", ...],   // 在文件名里搜索（不分大小写），任一命中即可；用 (?<名字>...) 取字段
            "content": ["<正则>", ...],              // 可选：在文件内容里搜索。match 和 content 都写时，两者都要命中，字段从两边合并
            "ext": ["pdf", ...],                     // 可选：允许的扩展名
            "not": ["<正则>", ...],                  // 可选：命中就排除（模板、说明、报价单之类）
            "to": "<目标文件夹模板>", "rename": "<新文件名模板，可不写>",
            "latest": {"group": "<分组字段>", "version": "<版本号字段>", "older_to": "<旧版本文件夹模板>"}}]}
模板里用 {字段}，可以加处理：{m|02} 补零到两位，{amt|int} 只留整数（128.00 → 128），{x|lower} 小写，{d[0:4]} 切片。
要点：
- 用多条 match 覆盖常见的不同命名：中英文、不同分隔符（_ - 空格 .）、不同日期写法（20260305、2026-03-05、2026.03.05）、
  全角数字、带「最终版 / (2) / 副本 / final」等后缀；关键词用中英两种说法（截屏 / Screenshot、录音 / Recording、发票 / invoice）。
- 日期、金额等字段分别取（年 y、月 m、日 d），模板里再拼，不要把整段日期原样搬过去。
- 文件名看不出类别的，用 content 在内容里认（例如内容里有「发票」「价税合计」）。
- 用 not 排除名字像、但不该动的文件。
另外写 expect：做完应当是什么样，由程序检查。
"expect": {"covers": {"ext": ["pdf"], "name": ["<正则>", ...], "content": ["<正则>", ...]},   // 哪些文件属于这一类（这一类的都要被规则认出来）
           "name": ["<正则>", ...],      // 规则处理过的文件，新文件名要符合其一（例如 ^\\d{8}-.+-\\d+\\.pdf$）
           "untouched": true}            // 不属于这一类的文件不能动
covers 写这一类文件「本来是什么」，不要照抄 match：match 写错了，covers 才能把漏掉的文件报出来。`;
