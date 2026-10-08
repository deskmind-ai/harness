/**
 * Protocol objects of the orchestration runtime (design 2.0, first slice), as zod schemas.
 *
 * One definition gives the TypeScript types, the runtime validation and (through export.ts) the JSON Schema that
 * documents and tests are generated from. The field manual of the 2.0 draft was produced from a schema by hand and
 * came out wrong; here there is nothing to copy by hand.
 */
import { z } from "zod";

export const Context = z.object({
  goal_rev: z.number().int().min(0),
  plan_rev: z.number().int().min(0),
  policy_rev: z.number().int().min(1),
  evidence_epoch: z.number().int().min(0),
});
export type Context = z.infer<typeof Context>;

// --- goal ---------------------------------------------------------------------------------------------------------

export const CheckKind = z.enum(["deterministic", "semantic", "user_confirmation"]);
export const CheckName = z.enum([
  "file_exists", "file_absent", "is_folder", "text_equals", "text_contains", "last_line_is", "same_text", "unchanged",
  "content_moved", "last_line_is_content_of", "text_equals_content_of",
]);
export type CheckName = z.infer<typeof CheckName>;

export const Check = z.object({
  kind: CheckKind,
  name: z.string().optional(),
  args: z.record(z.string()).optional(),
});

export const Requirement = z.object({
  id: z.string().min(1),
  statement: z.string().min(1),
  check: Check,
  quotes: z.array(z.string()).default([]),
});
export type Requirement = z.infer<typeof Requirement>;

export const Goal = z.object({
  requirements: z.array(Requirement),
  constraints: z.array(z.string()),
});
export type Goal = z.infer<typeof Goal>;

// --- plan -----------------------------------------------------------------------------------------------------------

export const PlanNode = z.object({
  id: z.string().min(1),
  capability: z.string().min(1),
  depends_on: z.array(z.string()),
  purpose: z.string(),
  requirement_ids: z.array(z.string()),
  /** Arguments fixed by a skill's rules (not by the binder). */
  args: z.record(z.string()).optional(),
});
export type PlanNode = z.infer<typeof PlanNode>;

export const Plan = z.object({
  nodes: z.array(PlanNode).min(1),
  source: z.enum(["planner", "skill"]),
  skill: z.string().optional(),
  unsure: z.array(z.string()).optional(),
});
export type Plan = z.infer<typeof Plan>;

// --- binding ----------------------------------------------------------------------------------------------------------

export const SourceSpanBinding = z.object({
  kind: z.literal("source_span"),
  quote: z.string().min(1),
  occurrence: z.number().int().min(1).default(1),
});
export const ResourceBinding = z.object({ kind: z.literal("resource_ref"), path: z.string() });
export const UpstreamBinding = z.object({ kind: z.literal("upstream_output"), node_id: z.string(), field: z.string() });
export const LiteralBinding = z.object({ kind: z.literal("literal"), value: z.string(), authority: z.string().min(1) });
/** A value computed from observed files (a date read from an invoice name, a folder from the user's rule): the
 *  sources must exist, and the intent check gets their content plus the model's explanation. */
export const DerivedBinding = z.object({ kind: z.literal("derived"), value: z.string(), from_paths: z.array(z.string()).min(1), how: z.string().min(1) });
export const Binding = z.discriminatedUnion("kind", [SourceSpanBinding, ResourceBinding, UpstreamBinding, LiteralBinding, DerivedBinding]);
export type Binding = z.infer<typeof Binding>;

export const Unresolved = z.object({
  parameter: z.string(),
  reason: z.enum(["missing_user_intent", "missing_observation", "ambiguous", "model_limit"]),
  question: z.string().optional(),
});

export const BindingProposal = z.object({
  bindings: z.record(Binding),
  unresolved: z.array(Unresolved),
});
export type BindingProposal = z.infer<typeof BindingProposal>;

// --- execution --------------------------------------------------------------------------------------------------------

export const ExecutionCommand = z.object({
  operation_id: z.string(),
  node_id: z.string(),
  capability: z.string(),
  args: z.record(z.string()),
  reads: z.array(z.string()),
  writes: z.array(z.string()),
  versions_before: z.record(z.string()),
  expect_after: z.record(z.string()),
  context: Context,
  text: z.string(),
  observation_epoch: z.number().int().optional(),
});
export type ExecutionCommand = z.infer<typeof ExecutionCommand>;

export const ExecutionResult = z.object({
  status: z.string(),
  output: z.record(z.unknown()).optional(),
  versions_after: z.record(z.string()),
  why: z.string().optional(),
  note: z.string().optional(),
});
export type ExecutionResult = z.infer<typeof ExecutionResult>;

// --- verification -------------------------------------------------------------------------------------------------------

export const VerificationCheck = z.object({ passed: z.boolean(), evidence: z.string() });
export const Verification = z.object({
  subject: z.enum(["intent", "node", "goal"]),
  passed: z.boolean(),
  checks: z.record(VerificationCheck).optional(),
  failed: z.array(z.string()).default([]),
  verdict: z.string().optional(),
  reason: z.string().optional(),
  node_ids: z.array(z.string()).optional(),
});

// --- interaction ----------------------------------------------------------------------------------------------------------

export const Interaction = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("clarify"), question: z.string(), why: z.string().optional(), options: z.array(z.string()).optional(), text: z.string().optional() }),
  z.object({ kind: z.literal("authorize"), text: z.string(), digest: z.string(), approved: z.boolean().optional() }),
]);
export type Interaction = z.infer<typeof Interaction>;

// --- run status -------------------------------------------------------------------------------------------------------------

export const RunStatus = z.enum([
  "received", "running", "waiting_user", "needs_reconciliation", "succeeded", "failed", "cancelled",
]);
export type RunStatus = z.infer<typeof RunStatus>;
export const TERMINAL: ReadonlySet<RunStatus> = new Set(["succeeded", "failed", "cancelled"]);
