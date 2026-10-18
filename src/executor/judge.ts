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
import type { Gateway } from "../gateway/index.js";
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
      const confidence = scores ? Math.max(...Object.values(scores)) : undefined;
      last = { choice: rep.data!.choice, by: tier.name, confidence, reason: rep.data!.reason };
      if (confidence === undefined || confidence >= (tier.floor ?? 0)) break;       // confident enough, or a tier that gives no scores
      this.opts.onEvent?.("judge.escalate", { tier: tier.name, confidence });
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
export const INTENT_QUESTION = "程序即将执行下面这个动作（已经取好参数）。对照用户原话和证据，它是不是用户要的？只看给出的材料，不替用户补充意图。";

/** The judge a runtime gets by default: DeskMind Brain first when it is configured (`DESKMIND_BRAIN_URL`, token in
 *  `DESKMIND_BRAIN_TOKEN`), escalating to the gateway's intent role when Brain's confidence is under the floor. The
 *  floor is a calibration output, not a rule: `DESKMIND_BRAIN_FLOOR` overrides the default until Brain's own
 *  calibration for these questions is measured (docs/0.5-decisions.md D24). */
export function defaultJudge(gateway: Gateway, onEvent?: JudgeTier["gateway"] extends never ? never : (kind: string, body: Record<string, unknown>) => void): Judge {
  const tiers: JudgeTier[] = [];
  const url = process.env.DESKMIND_BRAIN_URL;
  if (url) {
    const table = Object.fromEntries(R.ROLES.map((r) => [r, { backend: "systemone", model: url }])) as ConstructorParameters<typeof Gateway>[0];
    tiers.push({ name: "brain", gateway: new (gateway.constructor as typeof Gateway)(table), floor: Number(process.env.DESKMIND_BRAIN_FLOOR ?? 0.9) });
  }
  tiers.push({ name: "frontier", gateway });
  return new Judge(tiers, { onEvent });
}
