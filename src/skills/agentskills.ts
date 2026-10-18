/**
 * Skills in the Agent Skills format (design notes docs/design/skills-layer-2026-10-18.md): one folder per skill, SKILL.md
 * with `name`, `description` and our own `metadata.deskmind` (source, status, version, scope, effects), the body in
 * natural language for whatever runtime reads it; beside it what only our runtimes use — `rules.json` (the executable
 * rules of skills/rules.ts), `examples/confirmed.jsonl`, `examples/counter.jsonl`, `checks.md`. Another runtime
 * (Codex, Claude Code) reads the SKILL.md and ignores the rest, which is the point of the standard.
 *
 * Retrieval is the design's step 1 and step 3: a structural filter on facts (apps on screen, folders and file types
 * attached, sites open) that keeps rather than drops, then a choice question to a model. Nothing here reads the
 * user's words; the model does.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Gateway } from "../gateway/index.js";
import * as P from "../orchestrator/prompts.js";
import { choiceAnswer } from "../protocol/roles.js";

export type SkillSource = "taught" | "shipped" | "shared";
export type SkillStatus = "draft" | "admitted" | "retired";
export interface SkillScope { apps: string[]; objects: string[]; family: string }
export interface SkillMeta {
  source: SkillSource; status: SkillStatus; version: number; scope: SkillScope; effects: string[];
  requires?: string; taught_from?: string; taught_on?: string;
}
export interface Skill {
  name: string; description: string; meta: SkillMeta;
  /** The SKILL.md body (after the frontmatter): how to do it, in words. */
  body: string;
  rules?: Record<string, unknown> | null;
  confirmed: Record<string, unknown>[];
  counter: Record<string, unknown>[];
  checks?: string | null;
  /** Anything else a runtime keeps per skill (the Library's use and revision records). Never read by a model. */
  state?: Record<string, unknown> | null;
}

/** What is known of the request's situation, from structure: nothing in it is the user's words. */
export interface Facts { apps?: string[]; objects?: string[]; fileTypes?: string[] }

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DEFAULT_META: SkillMeta = { source: "taught", status: "draft", version: 1, scope: { apps: [], objects: [], family: "" }, effects: [] };

// --- frontmatter: the YAML subset SKILL.md uses (nested maps by indentation, inline or dashed lists, scalars) --------
type Yaml = string | number | boolean | null | Yaml[] | { [k: string]: Yaml };

function scalar(s: string): Yaml {
  const t = s.trim();
  if (t === "" || t === "null" || t === "~") return null;
  if (t === "true") return true;
  if (t === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
  if (t.startsWith("[") && t.endsWith("]")) return t.slice(1, -1).split(",").map((x) => scalar(x)).filter((x) => x !== null);
  return t;
}

export function parseYaml(text: string): { [k: string]: Yaml } {
  const lines = text.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
  let i = 0;
  const indentOf = (l: string) => l.length - l.trimStart().length;
  const block = (indent: number): Yaml => {
    if (i >= lines.length) return {};
    if (lines[i]!.trim().startsWith("- ")) {
      const out: Yaml[] = [];
      while (i < lines.length && indentOf(lines[i]!) === indent && lines[i]!.trim().startsWith("- ")) { out.push(scalar(lines[i]!.trim().slice(2))); i++; }
      return out;
    }
    const out: { [k: string]: Yaml } = {};
    while (i < lines.length && indentOf(lines[i]!) === indent) {
      const l = lines[i]!.trim();
      const at = l.indexOf(":");
      if (at < 0) throw new Error(`frontmatter: expected key: value, got ${l}`);
      const key = l.slice(0, at).trim(), rest = l.slice(at + 1).trim();
      i++;
      if (rest !== "") { out[key] = scalar(rest); continue; }
      out[key] = i < lines.length && indentOf(lines[i]!) > indent ? block(indentOf(lines[i]!)) : null;
    }
    return out;
  };
  const v = block(indentOf(lines[0] ?? ""));
  return v && typeof v === "object" && !Array.isArray(v) ? v : {};
}

const quote = (s: string) => (/^[\w一-鿿][^:#\[\]{},]*$/u.test(s) && !/^(true|false|null|~|-?\d+(\.\d+)?)$/.test(s) ? s : JSON.stringify(s));
export function dumpYaml(v: { [k: string]: Yaml }, indent = 0): string {
  const pad = " ".repeat(indent);
  return Object.entries(v).map(([k, x]) => {
    if (Array.isArray(x)) return `${pad}${k}: [${x.map((y) => (typeof y === "string" ? quote(y) : String(y))).join(", ")}]`;
    if (x && typeof x === "object") return `${pad}${k}:\n${dumpYaml(x, indent + 2)}`;
    return `${pad}${k}: ${typeof x === "string" ? quote(x) : x === null ? "null" : String(x)}`;
  }).join("\n");
}

export function parseSkillMd(text: string): { name: string; description: string; meta: SkillMeta; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error("SKILL.md has no frontmatter");
  const fm = parseYaml(m[1]!);
  const name = String(fm.name ?? ""), description = String(fm.description ?? "");
  if (!SKILL_NAME.test(name)) throw new Error(`SKILL.md: bad name ${JSON.stringify(name)}`);
  if (!description) throw new Error(`SKILL.md ${name}: no description`);
  const d = ((fm.metadata as { [k: string]: Yaml } | null)?.deskmind ?? {}) as { [k: string]: Yaml };
  const scope = (d.scope ?? {}) as { [k: string]: Yaml };
  const list = (x: Yaml | undefined): string[] => (Array.isArray(x) ? x.map(String) : x === null || x === undefined ? [] : [String(x)]);
  const meta: SkillMeta = {
    source: (d.source as SkillSource) ?? DEFAULT_META.source, status: (d.status as SkillStatus) ?? DEFAULT_META.status,
    version: typeof d.version === "number" ? d.version : 1, scope: { apps: list(scope.apps), objects: list(scope.objects), family: String(scope.family ?? "") },
    effects: list(d.effects), ...(d.requires ? { requires: String(d.requires) } : {}), ...(d.taught_from ? { taught_from: String(d.taught_from) } : {}), ...(d.taught_on ? { taught_on: String(d.taught_on) } : {}),
  };
  return { name, description, meta, body: m[2]!.replace(/^\r?\n/, "") };
}

export function renderSkillMd(s: Pick<Skill, "name" | "description" | "meta" | "body">): string {
  const d: { [k: string]: Yaml } = { source: s.meta.source, status: s.meta.status, version: s.meta.version, ...(s.meta.requires ? { requires: s.meta.requires } : {}),
    scope: { apps: s.meta.scope.apps, objects: s.meta.scope.objects, family: s.meta.scope.family }, effects: s.meta.effects,
    ...(s.meta.taught_from ? { taught_from: s.meta.taught_from } : {}), ...(s.meta.taught_on ? { taught_on: s.meta.taught_on } : {}) };
  return `---\n${dumpYaml({ name: s.name, description: s.description, metadata: { deskmind: d } })}\n---\n\n${s.body.replace(/\s+$/, "")}\n`;
}

const readJsonl = (p: string): Record<string, unknown>[] => (fs.existsSync(p) ? fs.readFileSync(p, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)) : []);
const writeJsonl = (p: string, rows: Record<string, unknown>[]) => { if (rows.length) fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); else fs.rmSync(p, { force: true }); };
const readIf = (p: string) => (fs.existsSync(p) ? fs.readFileSync(p, "utf-8") : null);

export class SkillStore {
  constructor(readonly dir: string) {}

  names(): string[] {
    if (!fs.existsSync(this.dir)) return [];
    return fs.readdirSync(this.dir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(this.dir, d.name, "SKILL.md"))).map((d) => d.name).sort();
  }

  get(name: string): Skill | null {
    const folder = path.join(this.dir, name);
    const md = readIf(path.join(folder, "SKILL.md"));
    if (md === null) return null;
    const parsed = parseSkillMd(md);
    const rules = readIf(path.join(folder, "rules.json")), state = readIf(path.join(folder, "state.json"));
    return {
      ...parsed, rules: rules ? JSON.parse(rules) : null, checks: readIf(path.join(folder, "checks.md")),
      confirmed: readJsonl(path.join(folder, "examples", "confirmed.jsonl")), counter: readJsonl(path.join(folder, "examples", "counter.jsonl")),
      state: state ? JSON.parse(state) : null,
    };
  }

  list(): Skill[] { return this.names().map((n) => this.get(n)!).filter(Boolean); }

  /** The SKILL.md body: what a runtime reads when it picks the skill. */
  read(name: string): string | null { return this.get(name)?.body ?? null; }

  write(s: Skill) {
    if (!SKILL_NAME.test(s.name)) throw new Error(`skill name ${JSON.stringify(s.name)} is not an Agent Skills name`);
    const folder = path.join(this.dir, s.name);
    fs.mkdirSync(path.join(folder, "examples"), { recursive: true });
    fs.writeFileSync(path.join(folder, "SKILL.md"), renderSkillMd(s));
    if (s.rules) fs.writeFileSync(path.join(folder, "rules.json"), JSON.stringify(s.rules, null, 1)); else fs.rmSync(path.join(folder, "rules.json"), { force: true });
    if (s.checks) fs.writeFileSync(path.join(folder, "checks.md"), s.checks); else fs.rmSync(path.join(folder, "checks.md"), { force: true });
    writeJsonl(path.join(folder, "examples", "confirmed.jsonl"), s.confirmed);
    writeJsonl(path.join(folder, "examples", "counter.jsonl"), s.counter);
    if (s.state) fs.writeFileSync(path.join(folder, "state.json"), JSON.stringify(s.state, null, 1)); else fs.rmSync(path.join(folder, "state.json"), { force: true });
  }

  remove(name: string) { fs.rmSync(path.join(this.dir, name), { recursive: true, force: true }); }

  admitted(): Skill[] { return this.list().filter((s) => s.meta.status === "admitted"); }

  /** Step 1 of retrieval: keep a skill whose scope touches the facts, or that declares no scope. Too few facts or
   *  nothing left means every admitted skill: this step must not lose the right one. */
  candidates(facts: Facts = {}): Skill[] {
    const all = this.admitted();
    const apps = (facts.apps ?? []).map(norm), objects = facts.objects ?? [], types = (facts.fileTypes ?? []).map((t) => t.toLowerCase().replace(/^\./, ""));
    if (!apps.length && !objects.length && !types.length) return all;
    const kept = all.filter((s) => {
      const sc = s.meta.scope;
      if (!sc.apps.length && !sc.objects.length) return true;
      if (sc.apps.some((a) => apps.includes(norm(a)))) return true;
      return sc.objects.some((o) => objectMatches(o, objects, types));
    });
    return kept.length ? kept : all;
  }

  /** The runtime's view: every admitted skill's name and description, and the body on request. */
  source(facts: Facts = {}): { candidates(raw: string): { name: string; description: string }[]; read(name: string): string | null } {
    return { candidates: () => this.candidates(facts).map((s) => ({ name: s.name, description: s.description })), read: (n) => this.read(n) };
  }
}

const norm = (s: string) => s.trim().toLowerCase();
/** The kinds of object patterns a scope names: a file type family (`audio/*`), an extension (`*.pdf`), a folder or
 *  site prefix (`~/Downloads`, `mail.example.com`), or an exact object. */
const FAMILIES: Record<string, string[]> = {
  audio: ["mp3", "m4a", "wav", "aac", "flac", "ogg"], image: ["png", "jpg", "jpeg", "gif", "heic", "webp", "tiff"], video: ["mp4", "mov", "mkv", "avi"],
  document: ["pdf", "doc", "docx", "txt", "md", "rtf", "pages"], spreadsheet: ["xls", "xlsx", "csv", "numbers"], archive: ["zip", "tar", "gz", "7z", "rar"],
};
export function objectMatches(pattern: string, objects: string[], types: string[]): boolean {
  const p = pattern.trim();
  const fam = /^([a-z]+)\/\*$/i.exec(p);
  if (fam) return types.some((t) => (FAMILIES[fam[1]!.toLowerCase()] ?? []).includes(t));
  const ext = /^\*\.([a-z0-9]+)$/i.exec(p);
  if (ext) return types.includes(ext[1]!.toLowerCase());
  const lp = norm(p.replace(/\/\*$/, ""));
  return objects.some((o) => { const lo = norm(o); return lo === lp || lo.startsWith(lp + "/") || lo.includes(lp); });
}

/** Step 3: the model picks one of the candidates, or none. The same question the orchestrator has always asked, so a
 *  choice-only local model (Brain) can answer it. */
export async function chooseSkill(gw: Gateway, raw: string, candidates: { name: string; description: string }[], context: Record<string, unknown> = {}, runId = ""): Promise<string | null> {
  if (!candidates.length) return null;
  const options = [...candidates.map((c) => ({ id: c.name, text: c.description })), { id: "none", text: "都不适用，另外规划" }];
  const ids = options.map((o) => o.id) as [string, ...string[]];
  const rep = await gw.ask("choice", P.SYSTEM, P.choicePrompt("哪份已有的教材适用于这个任务？", { 用户原文: raw, ...context }, options), choiceAnswer(ids), runId);
  if (rep.outcome !== "answered" || rep.data!.choice === "none") return null;
  return rep.data!.choice;
}
