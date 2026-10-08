/**
 * What each model role answers. The gateway validates a reply against the role's schema before the orchestrator sees
 * it; an off-schema answer is `invalid`, never coerced.
 */
import { z } from "zod";
import { BindingProposal, Check, PlanNode } from "./schemas.js";

export const ROLES = ["goal", "plan", "bind", "intent", "choice", "skill", "verify"] as const;
export type Role = (typeof ROLES)[number];

export const GoalAnswer = z.object({
  requirements: z.array(z.object({
    id: z.string().min(1),
    statement: z.string().min(1),
    check: Check,
    quotes: z.array(z.string()).default([]),
  })),
  constraints: z.array(z.string()),
  /** Paths whose content the user explicitly asked to change (改写 / 替换 / 覆盖 / 追加到). Only these may lose content on
   *  the user's word; the runtime checks each is named in the user's words. A file the user asked to *create* is not here. */
  authorized_rewrites: z.array(z.string()).default([]),
  /** The user handed a choice to us (「随便」「你看着办」「由你决定」). We may decide, and every write is then confirmed first. */
  user_delegated: z.boolean().default(false),
  /** kind: information = only the user knows it (which file, what text); approval = permission for an action the
   *  model already knows how to do. The runtime asks for information and confirms actions itself. */
  missing: z.array(z.object({
    what: z.string(), question: z.string(), kind: z.enum(["information", "approval"]).default("information"),
    /** Candidate answers taken from the evidence (files in the directory, words in the request), 2–6; the runtime
     *  shows them as a numbered list plus 「其他」. 「由你决定」 is a legitimate option when the choice is a preference. */
    options: z.array(z.string().min(1)).max(6).default([]),
  })),
  feasible: z.enum(["yes", "needs_capability_we_lack", "unclear"]),
  infeasible_reason: z.string().optional(),
});
export type GoalAnswer = z.infer<typeof GoalAnswer>;

export const PlanAnswer = z.object({
  nodes: z.array(PlanNode.omit({ args: true })),
  outcome: z.enum(["plan", "cannot", "need_user"]),
  reason: z.string().optional(),
  question: z.string().optional(),
});
export type PlanAnswer = z.infer<typeof PlanAnswer>;

export const BindAnswer = BindingProposal;
export type BindAnswer = z.infer<typeof BindAnswer>;

export const IntentAnswer = z.object({
  verdict: z.enum(["matches", "mismatch", "insufficient_information", "requires_more_steps"]),
  reason: z.string().default(""),
  scores: z.record(z.number()).optional(),          // from a choice-only backend: probability per option
});
export type IntentAnswer = z.infer<typeof IntentAnswer>;

export const choiceAnswer = (ids: readonly [string, ...string[]]) =>
  z.object({ choice: z.enum(ids), reason: z.string().optional(), scores: z.record(z.number()).optional() });

export const VerifyAnswer = z.object({ verdict: z.enum(["pass", "fail", "unknown"]), reason: z.string().default(""), scores: z.record(z.number()).optional() });
export type VerifyAnswer = z.infer<typeof VerifyAnswer>;

const strOrList = z.union([z.string(), z.array(z.string())]);
export const SkillRule = z.object({
  name: z.string().min(1),
  match: strOrList.optional(),
  content: strOrList.optional(),
  ext: strOrList.optional(),
  not: strOrList.optional(),
  to: z.string(),
  rename: z.string().optional(),
  latest: z.object({ group: z.string(), version: z.string(), older_to: z.string(), rename: z.string().optional() }).optional(),
});
export type SkillRule = z.infer<typeof SkillRule>;

export const SkillAnswer = z.object({
  title: z.string(),
  applies_when: z.string(),
  rules: z.array(SkillRule).min(1),
  variants: z.array(z.object({ from: z.string(), content: z.string().optional(), to: z.string() })),
});
export type SkillAnswer = z.infer<typeof SkillAnswer>;
