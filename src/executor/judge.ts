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
import { Gateway } from "../gateway/index.js";
import type { Role } from "../protocol/roles.js";
import * as P from "../orchestrator/prompts.js";
import * as R from "../protocol/roles.js";

export interface JudgeTier { name: string; gateway: Gateway; role?: Role; floor?: number }
export interface JudgeOption { id: string; text: string }
export interface JudgeAnswer { choice: string; by: string; confidence?: number; reason?: string; cached?: boolean }

export class Judge {
  private readonly cache = new Map<string, JudgeAnswer>();
  calls = 0;
  constructor(readonly tiers: JudgeTier[], readonly opts: { budget?: number; onEvent?: (kind: string, body: Record<string, unknown>) => void } = {}) {}

  /** One choice question. The same question (same words, same facts, same options) is answered once per task. */
  async choose(question: string, context: unknown, options: JudgeOption[]): Promise<JudgeAnswer | null> {
    const key = createHash("sha256").update(JSON.stringify({ question, context, options })).digest("hex").slice(0, 24);
    const hit = this.cache.get(key);
    if (hit) return { ...hit, cached: true };
    if (this.calls >= (this.opts.budget ?? 40)) { this.opts.onEvent?.("judge.budget", {}); return null; }
    const ids = options.map((o) => o.id) as [string, ...string[]];
    let last: JudgeAnswer | null = null;
    for (const tier of this.tiers) {
      this.calls += 1;
      const rep = await tier.gateway.ask(tier.role ?? "intent", P.SYSTEM, P.choicePrompt(question, context, options), R.choiceAnswer(ids));
      if (rep.outcome !== "answered") { this.opts.onEvent?.("judge.tier_failed", { tier: tier.name, outcome: rep.outcome }); continue; }
      const scores = rep.data!.scores;
      const confidence = scores && Object.keys(scores).length ? Math.max(...Object.values(scores)) : undefined;
      last = { choice: rep.data!.choice, by: tier.name, confidence, reason: rep.data!.reason };
      const final = tier === this.tiers[this.tiers.length - 1];
      if (final) break;
      // a lower tier may approve on its own when confident; refusing is the top tier's call (a cheap model's confident
      // "no" blocked right actions in the 10-18 probe), and "not enough evidence" is never final below the top
      const canSettle = last.choice === options[0]?.id && confidence !== undefined && confidence >= (tier.floor ?? 0);
      if (canSettle) break;
      this.opts.onEvent?.("judge.escalate", { tier: tier.name, choice: last.choice, confidence: confidence ?? null });
    }
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
export const INTENT_QUESTION = "程序即将执行下面这个动作（已经取好参数）。这是完成用户要求过程中的一步，不是全部：只判断这一步和用户原话是否一致——对象是不是用户说的那个、内容是不是用户给的、有没有做用户没要求的事。一步只做了一部分不算「不是」。只看给出的材料，不替用户补充意图。";

/** The judge a runtime gets by default: the gateway's intent role; with `DESKMIND_BRAIN_JUDGE=1` (and
 *  `DESKMIND_BRAIN_URL`, token in `DESKMIND_BRAIN_TOKEN`) DeskMind Brain answers first and may approve on its own above
 *  the floor, never refuse alone. Opt-in until Brain is measured on these questions: in the 10-18 probe it was
 *  confidently wrong on 2 of 13 (docs/0.5-decisions.md D24). The floor is a calibration output, not a rule. */
export function defaultJudge(gateway: Gateway, onEvent?: (kind: string, body: Record<string, unknown>) => void): Judge {
  const tiers: JudgeTier[] = [];
  const url = process.env.DESKMIND_BRAIN_URL;
  if (url && process.env.DESKMIND_BRAIN_JUDGE === "1") {
    const table = Object.fromEntries(R.ROLES.map((r) => [r, { backend: "systemone", model: url }])) as ConstructorParameters<typeof Gateway>[0];
    tiers.push({ name: "brain", gateway: new Gateway(table), floor: Number(process.env.DESKMIND_BRAIN_FLOOR ?? 0.9) });
  }
  tiers.push({ name: "frontier", gateway });
  return new Judge(tiers, { onEvent });
}
