/**
 * The execution layer's contract (openjev docs/design/computer-use-2026-10-16.md, skills-layer-2026-10-18.md §底线下沉).
 *
 * The runtime (ours, Codex, Claude Code…) sees the whole computer in one format, acts through a few generic actions,
 * and never touches the user's things or sends anything out without a consent token the app signed. Ownership and
 * the minimum consequence class of an action are computed here from structure; a model may only raise the class.
 *
 * Two drivers implement the raw side (`Driver`): the simulated computer (tests, the practice ground) and hands on a
 * real Mac. Everything above the driver (ledger, guard, consent, receipts) is shared.
 */

export type Owner = "user" | "task";

/** Ordered: a guard compares classes, so the order is the law. */
export const CONSEQUENCES = ["read", "create", "modify_user", "external"] as const;
export type Consequence = (typeof CONSEQUENCES)[number];
export const rank = (c: Consequence) => CONSEQUENCES.indexOf(c);
export const higher = (a: Consequence, b: Consequence): Consequence => (rank(a) >= rank(b) ? a : b);
/** Classes that need the user's consent before the action runs. */
export const NEEDS_CONSENT: ReadonlySet<Consequence> = new Set(["modify_user", "external"]);

export interface TabInfo { id: string; title: string; url: string; active?: boolean; owner?: Owner }
export interface WindowInfo {
  id: string; app: string; title: string;
  owner?: Owner;                      // filled by the executor from its ledger; a driver never says
  focused?: boolean; minimized?: boolean;
  url?: string; tabs?: TabInfo[];     // a browser window
}

/** The whole computer, every app in one format. Read-only, so nothing is hidden: the user's windows are listed too. */
export interface Snapshot { epoch: number; locked: boolean; front_app: string; windows: WindowInfo[]; user_active?: boolean }

export interface Element {
  id: string; role: string; label: string; actions: string[];
  value?: string; options?: string[]; enabled?: boolean; focused?: boolean; in_modal?: boolean;
  /** Structural evidence that activating this element sends something out of the machine (submits a form, sends a
   *  message, pays): the executor's floor for its consequence is then `external`. From the app profile or the page's
   *  own semantics, never from a model. */
  sends?: boolean;
  rect?: [number, number, number, number];
}

/** One window, close up: its elements (an accessibility tree), text and, when asked for, a screenshot. */
export interface Observation {
  epoch: number; window: WindowInfo; modal: { title: string } | null; elements: Element[];
  text?: string; screenshot_png?: string;     // base64
}

export type Action =
  | { kind: "click"; window: string; target: string }
  | { kind: "set_value"; window: string; target: string; value: string }
  | { kind: "type"; window: string; target: string; text: string }
  | { kind: "select"; window: string; target: string; option: string }
  | { kind: "key"; window: string; chord: string }
  | { kind: "scroll"; window: string; target?: string; dy: number }
  | { kind: "open_window"; app: string; url?: string }
  | { kind: "close_window"; window: string }
  | { kind: "focus_window"; window: string }
  | { kind: "wait"; ms: number }
  /** A file capability (registry) on the task folder: the same guard, with versions in place of observation epochs. */
  | { kind: "file"; capability: string; args: Record<string, string> };
export type ActionKind = Action["kind"];

/** A file another program changed while the task ran: a fact for the verdict, never something to "correct". */
export interface ExternalChange { path: string; seen: string; now: string; at: number }

/** The consent an action carries: a token the app signed for a challenge the executor issued (consent.ts). */
export interface ConsentToken {
  nonce: string;                     // the challenge it answers (action scope), or a fresh one (object / rule scope)
  scope: "action" | "object" | "rule";
  digest?: string;                   // action scope: the exact action
  object?: string;                   // object scope: the window / tab / path it covers
  consequence: Consequence;          // the highest class it allows
  task?: string;                     // object scope: only this task
  rule?: string;                     // rule scope: a durable permission, in the executor's rule store
  expires_at: number;                // ms since epoch
  sig: string;                       // base64 Ed25519 over canon(token without sig)
}

export interface Challenge { nonce: string; digest: string; object: string; consequence: Consequence; text: string; expires_at: number }

export interface ActRequest {
  action: Action;
  epoch: number;                     // the snapshot / observation the action was decided on
  /** The model's own class for the action; the executor takes the higher of this and its structural floor. */
  consequence?: Consequence;
  purpose?: string;
  consent?: ConsentToken;
}

export type ActStatus = "ok" | "unverified" | "stale" | "needs_consent" | "refused" | "blocked" | "error" | "stopped" | "environment";

export interface ActResult {
  status: ActStatus;
  why?: string;
  epoch: number;                     // after the action
  consequence: Consequence;          // the class the executor settled on
  object: string;                    // what it touched (a window id, a tab id, a path)
  challenge?: Challenge;             // with needs_consent
  /** What changed, in structure: the window's elements before / after, for the step check. */
  changed?: { elements: number; focus?: string; modal?: string | null; new_windows?: string[] };
  after?: Observation;               // the window after the action (re-observed)
  output?: Record<string, unknown>;  // a file capability's output (a read's text, a listing)
}

export interface PerformResult { status: "ok" | "error" | "unsupported" | "unverified" | "blocked"; why?: string; window?: string; new_window?: WindowInfo }
type Maybe<T> = T | Promise<T>;
/** The raw driver: sees and moves, decides nothing. The simulated one answers at once; a real one talks to a process. */
export interface Driver {
  snapshot(): Maybe<Snapshot>;
  observe(windowId: string, opts?: { screenshot?: boolean }): Maybe<Observation>;
  perform(action: Action): Maybe<PerformResult>;
  end?(): Maybe<void>;
}

/** What a run's receipts and verification can read back: the executor's own log of what it did. */
export interface Receipt { seq: number; t: number; request: Omit<ActRequest, "consent"> & { consent?: { scope: string; nonce: string } }; result: ActResult }
