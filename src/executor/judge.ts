/**
 * The judge: the execution layer's only use of a model, and it never generates — every question is a choice among
 * fixed options (which class, is this what the user asked, do these facts settle the readings, is the goal met). A
 * question goes to the first tier (DeskMind Brain, local, calibrated probabilities); when its confidence is under the
 * tier's floor it goes to the next (a frontier model through the gateway); when every tier fails, the answer is null
 * and the caller takes the conservative branch (ask the user, or refuse). Codex's guardian is the precedent: an
 * isolated reviewer beside the acting model, with a budget and a cache; ours sits in the executor so it goes wherever
 * the executor goes (docs/0.5-decisions.md 结论 3).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Gateway, type RoleTable } from "../gateway/index.js";
import type { Role } from "../protocol/roles.js";
import * as P from "../orchestrator/prompts.js";
import * as R from "../protocol/roles.js";

export interface JudgeTier { name: string; gateway: Gateway; role?: Role; floor?: number }
export interface JudgeOption { id: string; text: string }
export interface JudgeAnswer { choice: string; by: string; confidence?: number; reason?: string; cached?: boolean }

/** How often a lower tier settles each kind of question (kinds: the question's first words — intent, verify, and
 *  the evidence questions share a prefix), kept across tasks when a path is given: a tier that never settles a kind
 *  is not asked it any more, except for an occasional probe, so its latency is not paid for nothing. */
export class TierStats {
  private readonly data: Record<string, Record<string, { asked: number; settled: number; compared?: number; agreed?: number }>> = {};
  constructor(private readonly path?: string) {
    if (path) { try { Object.assign(this.data, JSON.parse(readFileSync(path, "utf-8"))); } catch { /* fresh */ } }
  }
  /** A question's kind: its first words, and what the action is on (a window, a path, an app) — the fast tier agrees
   *  with the slow one far less on window actions than on file actions (10-19: 46% vs 95%), so they are routed apart. */
  static kindOf(question: string, context?: unknown): string {
    const obj = (context as { 对象?: unknown } | undefined)?.对象;
    const where = typeof obj === "string" ? obj.split(":")[0] : "";
    return question.slice(0, 12) + (where ? `|${where}` : "");
  }
  private save() { if (this.path) { try { mkdirSync(dirname(this.path), { recursive: true }); writeFileSync(this.path, JSON.stringify(this.data)); } catch { /* best effort */ } } }
  private at(tier: string, kind: string) { const t = (this.data[tier] ??= {}); return (t[kind] ??= { asked: 0, settled: 0 }); }
  note(tier: string, kind: string, settled: boolean) { const k = this.at(tier, kind); k.asked += 1; if (settled) k.settled += 1; this.save(); }
  /** A shadow comparison: did the slow tier agree with what the fast tier settled? */
  noteAgreement(tier: string, kind: string, agree: boolean) { const k = this.at(tier, kind); k.compared = (k.compared ?? 0) + 1; if (agree) k.agreed = (k.agreed ?? 0) + 1; this.save(); }
  /** Skip the tier for this kind when it has shown it is not worth asking: it settles under `floor` of the questions
   *  (asked at least `min` times), or — measured by shadow comparisons — the slow tier agreed with its settled
   *  answers under `agreeFloor` of the time (compared at least `minCompared` times). A probe turn now and then keeps
   *  the numbers alive. */
  skip(tier: string, kind: string, min = 8, floor = 0.2, probeEvery = 20, minCompared = 10, agreeFloor = 0.9): boolean {
    const k = this.data[tier]?.[kind];
    if (!k) return false;
    if (k.asked > 0 && k.asked % probeEvery === 0) return false;
    if (k.asked >= min && k.settled / k.asked < floor) return true;
    if ((k.compared ?? 0) >= minCompared && (k.agreed ?? 0) / k.compared! < agreeFloor) return true;
    return false;
  }
  snapshot() { return JSON.parse(JSON.stringify(this.data)) as typeof this.data; }
}

export class Judge {
  private readonly cache = new Map<string, JudgeAnswer>();
  calls = 0;
  constructor(readonly tiers: JudgeTier[], readonly opts: { budget?: number; onEvent?: (kind: string, body: Record<string, unknown>) => void;
    /** adaptive routing: skip a lower tier on question kinds it never settles */ stats?: TierStats;
    /** measurement: after a lower tier settles, ask the top tier too and report whether they agree (costs the top call) */ shadow?: boolean } = {}) {}

  /** One choice question. The same question (same words, same facts, same options) is answered once per task. */
  async choose(question: string, context: unknown, options: JudgeOption[], role?: Role): Promise<JudgeAnswer | null> {
    const key = createHash("sha256").update(JSON.stringify({ question, context, options })).digest("hex").slice(0, 24);
    const hit = this.cache.get(key);
    if (hit) return { ...hit, cached: true };
    if (this.calls >= (this.opts.budget ?? 40)) { this.opts.onEvent?.("judge.budget", {}); return null; }
    const ids = options.map((o) => o.id) as [string, ...string[]];
    const kind = TierStats.kindOf(question, context);
    let last: JudgeAnswer | null = null, settled = false, settledBy: JudgeTier | null = null;
    for (const tier of this.tiers) {
      const final = tier === this.tiers[this.tiers.length - 1];
      if (!final && this.opts.stats?.skip(tier.name, kind)) { this.opts.onEvent?.("judge.skipped", { tier: tier.name, question_kind: kind }); continue; }
      this.calls += 1;
      const rep = await tier.gateway.ask(role ?? tier.role ?? "intent", P.SYSTEM, P.choicePrompt(question, context, options), R.choiceAnswer(ids));
      if (rep.outcome !== "answered") { this.opts.onEvent?.("judge.tier_failed", { tier: tier.name, outcome: rep.outcome }); continue; }
      const scores = rep.data!.scores;
      const confidence = scores && Object.keys(scores).length ? Math.max(...Object.values(scores)) : undefined;
      last = { choice: rep.data!.choice, by: tier.name, confidence, reason: rep.data!.reason };
      if (final) { settled = true; break; }
      // a lower tier may approve on its own when confident; refusing is the top tier's call (a cheap model's confident
      // "no" blocked right actions in the 10-18 probe), and "not enough evidence" is never final below the top
      const canSettle = last.choice === options[0]?.id && confidence !== undefined && confidence >= (tier.floor ?? 0);
      this.opts.stats?.note(tier.name, kind, canSettle);
      if (canSettle) { settled = true; settledBy = tier; break; }
      this.opts.onEvent?.("judge.escalate", { tier: tier.name, choice: last.choice, confidence: confidence ?? null });
    }
    // shadow: the top tier's answer to a question a lower tier settled — never used, only compared (measurement)
    if (settled && settledBy && this.opts.shadow) {
      const top = this.tiers[this.tiers.length - 1]!;
      const rep = await top.gateway.ask(role ?? top.role ?? "intent", P.SYSTEM, P.choicePrompt(question, context, options), R.choiceAnswer(ids));
      const agree = rep.outcome === "answered" ? rep.data!.choice === last!.choice : null;
      if (agree !== null) this.opts.stats?.noteAgreement(settledBy.name, kind, agree);
      this.opts.onEvent?.("judge.shadow", { tier: settledBy.name, question_kind: kind, choice: last!.choice, top: rep.outcome === "answered" ? rep.data!.choice : null, agree });
    }
    // every tier above a lower tier's refusal failed: that refusal does not become final by default — the caller takes
    // the conservative branch (the user decides), the same as when no tier answered
    if (last && !settled) { this.opts.onEvent?.("judge.unsettled", { by: last.by, choice: last.choice }); last = null; }
    if (last) this.cache.set(key, last);
    this.opts.onEvent?.("judge.answer", { question: question.slice(0, 80), answer: last });
    return last;
  }
}

/** The intent question, as the orchestrator's intent role asks it: is this action what the user asked for? */
export const INTENT_OPTIONS: JudgeOption[] = [
  { id: "matches", text: "是用户要的：动作忠实于原话，没有改写、对调、漏掉要求，也没有多做" },
  { id: "mismatch", text: "不是：参数弄反、对象弄错、内容改写、违反了约束，或者用户没要求这件事" },
  { id: "insufficient", text: "证据不够：动作里有的值是猜的，或看不出对象是不是用户说的那个" },
];
export const INTENT_QUESTION = "程序即将执行下面这个动作（已经取好参数）。这是完成用户要求过程中的一步，不是全部：只判断这一步和用户的话（原话，以及用户对提问的回答）是否一致——对象是不是用户说的那个、内容是不是用户给的、有没有做用户没要求的事。一步只做了一部分不算「不是」。只为把路让开的中间步骤——关掉挡住的弹窗（选「稍后」「取消」这种不改东西的项）、滚动、切换窗口、在结果里切换分类标签 / 翻页 / 展开列表——不算「用户没要求的事」，只要它本身不改用户的内容、不往外发；点「立即更新」「确定删除」这类会改东西的项才要和用户的话对得上。只看给出的材料，不替用户补充意图。";

/** The judge a runtime gets by default: the gateway's intent role, with an optional first tier that answers first and
 *  may approve on its own above its floor, never refuse alone:
 *  - `DESKMIND_BRAIN_JUDGE=1` (+ `DESKMIND_BRAIN_URL`, token in `DESKMIND_BRAIN_TOKEN`, floor `DESKMIND_BRAIN_FLOOR`):
 *    DeskMind Brain's system one, local, calibrated probabilities;
 *  - `DESKMIND_JUDGE_FIRST=<backend>:<model>` (floor `DESKMIND_JUDGE_FIRST_FLOOR`), e.g.
 *    `openai:volcengine|doubao-seed-2-1-lite-260915`: any fast model the gateway can reach, same contract.
 *  Opt-in until measured on these questions: in the 10-18 probe Brain was confidently wrong on 2 of 13
 *  (docs/0.5-decisions.md D24). The floor is a calibration output, not a rule. */
export function defaultJudge(gateway: Gateway, onEvent?: (kind: string, body: Record<string, unknown>) => void): Judge {
  const tiers: JudgeTier[] = [];
  const url = process.env.DESKMIND_BRAIN_URL;
  const table = (backend: string, model: string) => Object.fromEntries(R.ROLES.map((r) => [r, { backend, model }])) as RoleTable;
  if (url && process.env.DESKMIND_BRAIN_JUDGE === "1") tiers.push({ name: "brain", gateway: new Gateway(table("systemone", url)), floor: Number(process.env.DESKMIND_BRAIN_FLOOR ?? 0.9) });
  const first = firstTier(process.env.DESKMIND_JUDGE_FIRST, process.env.DESKMIND_JUDGE_FIRST_FLOOR);
  if (first) { const t = table(first.backend, first.model); for (const r of R.ROLES) t[r] = { ...t[r], think: false }; tiers.push({ name: first.name, gateway: new Gateway(t), floor: first.floor }); }   // a choice wants a fast answer
  tiers.push({ name: "frontier", gateway });
  // adaptive routing across runs (DESKMIND_JUDGE_STATS names the file; unset: per process); shadow measurement opt-in
  const stats = new TierStats(process.env.DESKMIND_JUDGE_STATS || undefined);
  return new Judge(tiers, { onEvent, stats, shadow: process.env.DESKMIND_JUDGE_SHADOW === "1" });
}

/** `backend:model` → a first judge tier; null when unset or malformed (then the frontier judges alone). */
export function firstTier(spec: string | undefined, floor?: string): { name: string; backend: string; model: string; floor: number } | null {
  const m = spec ? /^(\w+):(.+)$/s.exec(spec.trim()) : null;
  if (!m) return null;
  return { name: `first:${m[2]!.split("|").pop()}`, backend: m[1]!, model: m[2]!, floor: Number(floor ?? 0.9) };
}

/** The completion audit, as a choice: Codex's wording (ext/goal/templates/goals/continuation.md) — completion is
 *  unproven until the current state proves every requirement; weak or indirect evidence is not achieved. */
export const VERIFY_QUESTION = [
  "任务做成了没有？核对的做法：先从用户的要求里列出每一条具体要求（每个文件、每句话、每个动作、每个问题的答案），再逐条在证据里找能证明它的东西。",
  "证据只认现在的状态（窗口的元素和文字、文件内容、执行回执）；模型自称做完了、动作「发出去了」但没读回结果、只和要求「相符」但证明不了，都不算。",
  "一条要求的证据范围要和它一样宽：用一个窄的检查不能支持一个宽的结论。任务期间别的程序改过的文件，那些改动不是本任务造成的，保留它们不算违反要求。",
  "「不要动 X」「其他文件不动」「别碰 X」这类要求，证据就是：执行层的回执里没有改 X 的动作，而且 X 现在的版本和任务开始时一样——两条都成立就算证明了，不要再要求别的。只读地读过 X（fs.read_text、观察窗口）不算碰：读不改东西，用户说的「动 / 碰」指的是改。",
  "界面上「删掉 / 移走 X」的证据是：X 在窗口第一次观察里有、现在没有，而且回执里有导致它消失的那串动作（选中它那一行、点删除、确认）——删除按钮是通用控件，不会以那一行为目标，所以不要去找「以那一行为目标的删除动作」，也不要求看到废纸篓或已删除文件夹，那是应用的事。用户对提问的回答和原话一样算证据，用它来消歧。",
  "用户说了在哪个应用里做、怎么做（「在文本编辑里保存为…」）的，证据要证明是那样做成的：用别的路子（比如文件工具直接写出一个同名文件）得到的结果不算那条要求的证据；任务自己的窗口到结束还带着未保存的改动（标题里的「已编辑」、未命名），和「保存了」矛盾。",
  "每条都被证明才选 pass；有一条证据矛盾选 fail；有一条证据不够、没有或间接，选 unknown。reason 里写明哪一条、缺什么。",
].join("\n");
export const VERIFY_OPTIONS: JudgeOption[] = [
  { id: "pass", text: "做成了：每一条要求都有现在状态的证据" },
  { id: "fail", text: "没做成：有证据和要求矛盾" },
  { id: "unknown", text: "确认不了：有要求没有足够的证据" },
];
