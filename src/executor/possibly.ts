/**
 * "Could this step have done something?" — answered in one place, from one fact (M2 H2, review of #68 round 2).
 *
 * The fact is the executor's journal: before an action that may change anything goes to the driver (a screen action
 * that is not a look) or to its capability (a file action that is not a read), the executor writes an `intent`; once
 * it has the outcome, a `receipt`. A step is possibly done when it has an intent and no receipt that positively says
 * nothing happened. Only two receipts say that: the driver's own word that it did not perform the action
 * (`performed: false`, e.g. hands' user_busy), and a restart's reconciliation that found the file step did not happen
 * (`finding: "not_happened"`). A step refused before it was acted on never wrote an intent. Status names are never
 * read here: an error, a lock found after the action, a capability that threw half way — all possibly done. Fail
 * closed: an intent with no receipt (the process died, the action is still out at the driver, the capability threw)
 * is possibly done.
 *
 * Every reader uses this: the executor's undo plan and result card (Executor.undoable), each step's `possibly_done`
 * on step_result, the session's own result card when an executor died without task_done, and the restart's
 * `interrupted` end — so the live card and the restart agree for the same journal.
 */

export type JournalLine = { kind: string } & Record<string, unknown>;

/** One intent and its receipt, if any (the next receipt before another intent). `earlier`: written by an earlier
 *  process of the same task (a restart), whose effects this process has no recipe to take back. */
export interface JournalStep {
  /** The intent's index among the journal's lines. */
  intent: number;
  action: unknown;
  consequence: string;
  /** The action in the user's words, as the intent recorded it. */
  text: string;
  receipt: JournalLine | null;
  possibly: boolean;
  earlier: boolean;
}

/** Driver replies that, by the protocol (docs/protocol.md 「可能做了」), mean the driver refused before acting: nothing
 *  was done. `unsupported`: the driver cannot do this kind of action at all (the simulated desktop's unknown app, a
 *  hands action it has no route for). Any other reply may hide an effect. A reply that says `performed: false` is the
 *  driver's own word, whatever its status. This is the only place a reply's status is read for the decision. */
const REFUSED_BEFORE_ACTING: ReadonlySet<string> = new Set(["unsupported"]);

/** Did the driver (or a capability) say it did nothing at all? Its explicit `performed: false`, or a reply the
 *  protocol defines as a refusal before acting. The executor writes the answer into the receipt as `performed: false`. */
export function saysNotPerformed(reply: { status?: unknown; performed?: unknown }): boolean {
  return reply.performed === false || (typeof reply.status === "string" && REFUSED_BEFORE_ACTING.has(reply.status));
}

/** The one decision: an intent was written (the caller has one), and this receipt — null when there is none — does
 *  not positively say nothing happened (`performed: false`, or a restart's reconciliation `finding: not_happened`). */
export function possiblyDone(receipt: Record<string, unknown> | null | undefined): boolean {
  if (!receipt) return true;
  return !(receipt.performed === false || receipt.finding === "not_happened");
}

/** Every intent of a journal with its receipt and the decision. `ownFrom`: the first line this process wrote. */
export function journalSteps(lines: readonly JournalLine[], ownFrom = 0): JournalStep[] {
  const out: JournalStep[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.kind !== "intent") continue;
    let receipt: JournalLine | null = null;
    for (let j = i + 1; j < lines.length; j++) { const m = lines[j]!; if (m.kind === "intent") break; if (m.kind === "receipt") { receipt = m; break; } }
    out.push({ intent: i, action: l.action, consequence: String(l.consequence ?? ""), text: String(l.text ?? ""), receipt, possibly: possiblyDone(receipt), earlier: i < ownFrom });
  }
  return out;
}

/** A journal file's whole records (a torn last line is no record). */
export function parseJournal(raw: string): JournalLine[] {
  return raw.split("\n").filter((l) => l.trim()).flatMap((l) => { try { const j = JSON.parse(l); return j && typeof j === "object" && typeof j.kind === "string" ? [j as JournalLine] : []; } catch { return []; } });
}

/** How a card lists possibly-done steps — the executor's live card, the session's card for a dead executor and a
 *  restart's alike, so the same journal reads the same: done (a receipt that says ok) or not known (anything else). */
export function stepLines(steps: readonly JournalStep[]): { did: string[]; unsure: string[] } {
  const did: string[] = [], unsure: string[] = [];
  for (const s of steps) if (s.possibly) (s.receipt?.status === "ok" ? did : unsure).push(s.text);
  return { did, unsure };
}
