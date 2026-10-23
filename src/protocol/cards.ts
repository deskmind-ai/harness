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
 *  (「其他」). Blocking cards stop the run until answered; the result card is shown with the result. `plan` / `consent`:
 *  the same card's facts in fields (M0, additive), for an app that lays them out itself; `text` says all of it. */
export interface Card { kind: CardKind; text: string; options: CardOption[]; free_text: boolean; blocking: boolean; plan?: PlanCardFacts; consent?: ActionCardFacts }

type Consequence = "read" | "create" | "modify_user" | "external";

/** A plan card in fields: per step its purpose and settled class, the objects it touches as the user knows them, and
 *  the sites it opens pages of with what goes there; and the apps that can only be operated in front. Only what the
 *  card's text says: an object that resolves to nothing on screen or in the folder is not listed (and not signed). */
export interface PlanCardFacts {
  steps: {
    purpose: string;
    /** The class the executor settled for the step (never lower than the caller's). */
    class: Consequence;
    /** `ref`: window:<id> / tab:<id> / path:<p>; `owner`: whose it is (the ledger's word); `marks`: what the step does
     *  to it — changes it (the user's thing), sends from it, opens web pages in it. */
    objects: { ref: string; label: string; owner: "user" | "task"; marks: ("changes" | "sends" | "opens_pages")[] }[];
    /** Every http(s) site the step opens pages of: the host, what the caller says goes there (null: not said), and
     *  whether the executor will still ask before each open there (the task read material: a send). */
    sites: { host: string; sends: string | null; asks_each: boolean }[];
  }[];
  /** Apps the driver can operate only in front, among the plan's objects, and the card's sentence about it. */
  foreground: { apps: string[]; note: string } | null;
}

/** A consent card for one action in fields: the action in words, the element and the window it acts on, its class,
 *  what goes out (a send: the fields filled in, the selected item, what the task typed, other text in the window) and
 *  the site an open asks about. */
export interface ActionCardFacts {
  action: string;
  action_text: string;
  target: string | null;
  object: string;
  object_label: string;
  consequence: Consequence;
  outgoing: { kind: "field" | "selected" | "typed" | "text"; label: string; value: string }[];
  site: string | null;
  /** The steps of this run whose result is unknown (unverified while changing the user's things or sending: they may
   *  already have taken effect), every one, as the card's text names them first; while there is one, every change or
   *  send asks. `model_says_unchecked`: what the model says of the situation now — its words, not checked. */
  uncertain?: { consequence: Consequence; object: string; text: string; outgoing: ActionCardFacts["outgoing"] }[];
  /** How many there are in all (the list keeps the last 20; the text shows at most 5 lines and counts the rest). */
  uncertain_total?: number;
  model_says_unchecked?: string;
}

/** Who answers the executor's cards: the app (stdio: an `ask` event, then the answer line), the evaluation's simulated
 *  user, a test. `signal`: the card is voided when it fires (the user changed the request — a steer — or the task was
 *  stopped): the asker lets go of it (the app is told) and the answer, if any, is not used. */
export interface CardAsker { ask(card: Card, o?: { signal?: AbortSignal }): Promise<Answer | null> | Answer | null }
