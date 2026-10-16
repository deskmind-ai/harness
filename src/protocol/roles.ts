/**
 * What each model role answers. The gateway validates a reply against the role's schema before the orchestrator sees
 * it; an off-schema answer is `invalid`, never coerced.
 */
import { z } from "zod";
import { BindingProposal, Check, PlanNode } from "./schemas.js";

export const ROLES = ["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"] as const;
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
  /** Each place where the request can be read more than one way *with different results*: which place (point), the
   *  reading chosen, the other readings, and evidence for the choice — words from the directory listing, file contents
   *  or the user's later answers (the ambiguous request itself does not count). See docs/ask-policy.md. */
  assumptions: z.array(z.object({
    point: z.string().default(""),
    reading: z.string().min(1),
    alternatives: z.array(z.string().min(1)).default([]),
    evidence: z.array(z.string().min(1)).default([]),
  })).default([]),
  /** kind: information = only the user knows it (which file, what text); approval = permission for an action the
   *  model already knows how to do. The runtime asks for information and confirms actions itself. */
  missing: z.array(z.object({
    what: z.string(), question: z.string(),
    /** information: only the user knows it. approval: permission (never asked; the runtime confirms actions).
     *  observable: the system can find it out by reading files; planned as read-only steps, never asked. */
    kind: z.enum(["information", "approval", "observable"]).default("information"),
    /** Candidate answers taken from the evidence (files in the directory, words in the request), 2–6; the runtime
     *  shows them as a numbered list plus 「其他」. 「由你决定」 is a legitimate option when the choice is a preference. */
    options: z.array(z.string().min(1)).max(6).default([]),
    /** values: the options are facts (files in the directory, words the user said) and are checked against the
     *  evidence. proposals: the options are ways to handle the situation (keep one copy, add a suffix…); they are
     *  the user's to pick, so they are shown as written. */
    options_are: z.enum(["values", "proposals"]).default("values"),
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
  /** With insufficient_information: can the user supply what is missing (then `question` is put to them), or is it
   *  evidence the system lacks (then the binding is retried, the user is not interrupted). */
  ask_user: z.boolean().default(false),
  question: z.string().optional(),
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

/** What a skill's result must look like, checked by code (skills/rules.ts checkExpect): which files are this skill's
 *  kind (covers: ext, and a name or content pattern), the file name a placed file must end up with (name), and that
 *  files of other kinds stay where they are (untouched). */
const nonEmpty = (x: string | string[] | undefined) => (x === undefined ? [] : typeof x === "string" ? [x] : x).some((v) => v.trim() !== "");
export const SkillExpect = z.object({
  covers: z.object({ ext: strOrList.optional(), name: strOrList.optional(), content: strOrList.optional() })
    .refine((c) => nonEmpty(c.ext) || nonEmpty(c.name) || nonEmpty(c.content), "covers needs an extension, a name or a content pattern"),
  name: strOrList.optional(),
  untouched: z.boolean().default(true),
});
export type SkillExpect = z.infer<typeof SkillExpect>;

export const SkillAnswer = z.object({
  title: z.string(),
  applies_when: z.string(),
  rules: z.array(SkillRule).min(1),
  variants: z.array(z.object({ from: z.string(), content: z.string().optional(), to: z.string() })),
  expect: SkillExpect.optional(),
});
export type SkillAnswer = z.infer<typeof SkillAnswer>;

/** A revised skill (skills/library.ts revise): the new version, what changed in a few words (shown with the next
 *  result), and an earlier confirmed example the correction contradicts, if the model sees one. */
export const SkillRevision = SkillAnswer.extend({
  change: z.string(),
  conflicts_with: z.string().nullable().default(null),
});
export type SkillRevision = z.infer<typeof SkillRevision>;

/** transform: the new text a text-transforming capability writes (fs.transform_text), from the source text and the
 *  instruction the planner bound. `text` is written as is. */
export const TransformAnswer = z.object({ text: z.string() });
