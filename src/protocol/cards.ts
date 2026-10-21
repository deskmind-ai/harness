/**
 * Cards: every interaction with the user (design notes docs/design/interaction-cards-2026-10-09.md). The executor shows
 * them (through the app) and acts on the option's kind, never its words; the runtime never sees one. Moved here from
 * orchestrator/index.ts (executor split P1); the orchestrator re-exports them.
 */

/** A user's answer: a picked option (index into the options shown) or free text. */
export type Answer = { option: number } | { text: string };

/** What an option means. The runtime acts on this, never on the option's words (design notes
 *  docs/design/interaction-cards-2026-10-09.md). */
export type OptionKind = "approve" | "reading" | "value" | "proposal" | "skip_step" | "delegate" | "undo" | "undo_and_reading" | "other" | "cancel" | "never_ask_this";
export interface CardOption {
  kind: OptionKind; text: string;
  node_id?: string;                                   // skip_step: which step
  point?: string; readings?: string[]; reading_index?: number;   // reading / undo_and_reading: which reading of which point
}
export type CardKind = "missing" | "ambiguity" | "plan" | "action" | "result_check" | "cannot" | "result";
/** Every interaction with the user is a card: the situation, options that cover what can happen next, and free text
 *  (「其他」). Blocking cards stop the run until answered; the result card is shown with the result. */
export interface Card { kind: CardKind; text: string; options: CardOption[]; free_text: boolean; blocking: boolean }

/** Who answers the executor's cards: the app (stdio: an `ask` event, then the answer line), the evaluation's simulated
 *  user, a test. `signal`: the card is voided when it fires (the user changed the request — a steer — or the task was
 *  stopped): the asker lets go of it (the app is told) and the answer, if any, is not used. */
export interface CardAsker { ask(card: Card, o?: { signal?: AbortSignal }): Promise<Answer | null> | Answer | null }
