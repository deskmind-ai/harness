/**
 * A judge over scripted gateways for tests that open URLs after the task read material (review of #35: every observed
 * window is material, so most GUI tests now meet the provenance question). `provenance` answers that question (null:
 * the tier fails); the outgoing question is answered「不会」, the verdict「pass」, everything else「matches」. `lower`: a
 * local first tier (Brain) in front; `only`: Brain alone. `prompts`: every provenance prompt asked.
 */
import { Gateway } from "../../src/gateway/index.js";
import { ALTERS_QUESTION, Judge, OUTGOING_QUESTION, PROVENANCE_QUESTION, type JudgeTier } from "../../src/executor/judge.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
export const isProvenance = (u: string) => u.includes(PROVENANCE_QUESTION.slice(0, 12));
const isOutgoing = (u: string) => u.includes(OUTGOING_QUESTION.slice(0, 12));
const isAlters = (u: string) => u.includes(ALTERS_QUESTION.slice(0, 12));

/** A scripted gateway answer for every role: provenance questions by `answer`, the rest as above. */
export const scripted = (answer: (u: string) => unknown, prompts: string[] = []) => (role: string, _s: string, u: string) => {
  if (isProvenance(u)) { prompts.push(u); return answer(u); }
  if (isOutgoing(u)) return { choice: "stays" };
  if (isAlters(u)) return { choice: "keeps" };          // (the alters question, its own since rc.17)
  return role === "verify" ? { choice: "pass", reason: "ok" } : { choice: "matches" };
};

export function provenanceJudge(provenance: ((u: string) => unknown) | null, o: { lower?: (u: string) => unknown; only?: boolean } = {}) {
  const prompts: string[] = [];
  const gw = (answer: (u: string) => unknown) => { const g = new Gateway(table); g.script = Array(200).fill(scripted(answer, prompts)); return g; };
  const tiers: JudgeTier[] = [];
  if (o.lower) tiers.push({ name: "brain", gateway: gw(o.lower), floor: 0.9, local: true });
  if (!o.only) tiers.push({ name: "frontier", gateway: gw(provenance ?? (() => ({ not: "an answer" }))) });
  return { judge: new Judge(tiers), prompts };
}
