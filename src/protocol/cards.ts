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
  /** A second line under the option (H2): a reading's detail, as the plan role wrote it in a field of its own. */
  detail?: string;
}
/** One thing a card's yes covers, beyond what was asked (H2): exactly what the yes signs — an object (window, tab,
 *  file) or a site — as the user knows it. */
export interface Beyond { kind: "object" | "site"; ref: string; label: string;
  /** A site: the place its pages land (the object its token is signed on) and how the user knows it; `sends` when the
   *  card said something goes there. */
  at?: string; at_label?: string; sends?: true }
export type CardKind = "missing" | "ambiguity" | "plan" | "action" | "result_check" | "cannot" | "result";
/** Every interaction with the user is a card: the situation, options that cover what can happen next, and free text
 *  (「其他」). Blocking cards stop the run until answered; the result card is shown with the result. `plan` / `consent`:
 *  the same card's facts in fields (M0, additive), for an app that lays them out itself; `text` says all of it. */
export interface Card { kind: CardKind; text: string; options: CardOption[]; free_text: boolean; blocking: boolean; plan?: PlanCardFacts; consent?: ActionCardFacts;
  /** One sentence saying what the card is about (H2), in the run's language, built from the facts the yes signs. */
  headline?: string;
  /** What the yes covers beyond the request (H2): the signed objects and sites, no more and no fewer. */
  beyond?: Beyond[];
  /** The card about an interrupted step (recover): a steer does not void it — it is answered first (H5). */
  reconcile?: true }

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
  /** What is selected in the window the action acts in (H2): elements whose selection flag is set (focused, and not
   *  where the keyboard types), by their labels, from the same look the card is made of — which mail a 「删除」 deletes. */
  selected?: string[];
}

/** Who answers the executor's cards: the app (stdio: an `ask` event, then the answer line), the evaluation's simulated
 *  user, a test. `signal`: the card is voided when it fires (the user changed the request — a steer — or the task was
 *  stopped): the asker lets go of it (the app is told) and the answer, if any, is not used. `expired` (an action card
 *  with a deadline): asked when an answer arrives, before it is taken — true means the card has just expired (its
 *  signal fired with "timeout") and the answer is a late one. */
export interface CardAsker { ask(card: Card, o?: { signal?: AbortSignal; expired?: () => boolean;
  /** Called by the asker the moment it takes an answer for this card (synchronously, before anything after it on the
   *  same input is read): the card is no longer open from then on (review of #77: a steer right behind an answer). */
  taken?: () => void }): Promise<Answer | null> | Answer | null }

/** Whether an answer line answers the card open now (`open`: its ask_id, null when none): it names that card, or names
 *  none while no card of the run was voided (steer, timeout) — after a void an answer must say which card it is for.
 *  The one rule, read by the executor's asker (cli/app.ts StdioUser) and by the session (session/host.ts) alike, so
 *  the two never disagree on which line answered the card (review of #77). */
export function answersOpenCard(line: { ask_id?: unknown }, open: string | null, voidedBefore: boolean): boolean {
  return open !== null && (line.ask_id === open || (line.ask_id === undefined && !voidedBefore));
}
