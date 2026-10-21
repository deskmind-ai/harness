/**
 * The execution layer's contract (design notes docs/design/computer-use-2026-10-16.md, skills-layer-2026-10-18.md §底线下沉).
 *
 * The runtime (ours, Codex, Claude Code…) sees the whole computer in one format, acts through a few generic actions,
 * and never touches the user's things or sends anything out without a consent token the app signed. Ownership and
 * the minimum consequence class of an action are computed here from structure; a model may only raise the class.
 *
 * Two drivers implement the raw side (`Driver`): the simulated computer (tests, the practice ground) and hands on a
 * real Mac. Everything above the driver (ledger, guard, consent, receipts) is shared.
 */

/** The classes, their order, the challenge and the token are the protocol's (protocol/consent.ts): re-exported here. */
import type { Challenge, Consequence, ConsentToken } from "../protocol/consent.js";
export { CONSEQUENCES, rank, higher } from "../protocol/consent.js";
export type { Consequence, ConsentToken, Challenge } from "../protocol/consent.js";
/** Classes that need the user's consent before the action runs. */
export const NEEDS_CONSENT: ReadonlySet<Consequence> = new Set(["modify_user", "external"]);

/** The computer's shapes, the actions and their results are the protocol's (protocol/computer.ts): re-exported here. */
import type { Action, ActResult, Frame, Observation, Snapshot, WindowInfo } from "../protocol/computer.js";
export type { Frame, Owner, TabInfo, WindowInfo, Snapshot, Element, Observation, Action, ActionKind, ActStatus, Reading, PlanStep, PlanProposal, PlanVerdict, ActResult, Reconciliation, ReconcileFile } from "../protocol/computer.js";

/** A file another program changed while the task ran: a fact for the verdict, never something to "correct". */
export interface ExternalChange { path: string; seen: string; now: string; at: number }

export interface ActRequest {
  action: Action;
  epoch: number;                     // the snapshot / observation the action was decided on
  /** The model's own class for the action; the executor takes the higher of this and its structural floor. */
  consequence?: Consequence;
  purpose?: string;
  consent?: ConsentToken;
}

export interface PerformResult {
  status: "ok" | "error" | "unsupported" | "unverified" | "blocked"; why?: string; window?: string; new_window?: WindowInfo;
  /** A window that appeared when the task launched an app, without proof the task made it (hands#54): the user's. */
  opened_window?: WindowInfo;
  /** Windows of the acted app that came on screen during the action and that the driver does not claim as made, with
   *  why (hands: shows a file, holds content, could not be read…). For the trace only: never credits anything. */
  appeared?: { id: string; why: string }[];
  /** The files this action wrote, as far as the driver can vouch for it: relative to the task folder, or absolute. Only
   *  writes it is sure of — one it made itself (a save-as it carried out), or the app's own save, seen as the window's
   *  document going from unsaved to saved during the action. A document that merely changed while the action ran is
   *  not one: a sync client editing it meanwhile looks the same (review of #16). `sha256` (hex, of the file's bytes)
   *  is what was written: the executor credits a file only while it still holds exactly that — a sync client that
   *  wrote the same file again before the action returned is not the task (review of #16, tenth round) — and a bare
   *  path, or a digest that no longer matches, leaves the file unconfirmed. The digest has to come from what was
   *  written itself (the bytes the driver wrote, the document's content as the app holds it), never from reading the
   *  file back: read after another program wrote it, it matches that program's content, which would then be credited
   *  (eleventh round). No such source, no digest — the file stays unconfirmed. `[]` says nothing was written; no
   *  field, that the driver does not know. */
  files?: (string | { path: string; sha256: string })[];
  /** The file the window points to after the action (AXDocument, or the app's scripting), when the app says. What it
   *  shows, not what the action did: never credits a file. */
  document?: string;
  /** The picture of the window after the action, written where `perform`'s `shot` said (hands); and where the window
   *  and the element acted on were on screen before acting. For the app only. */
  shot?: string; target_frame?: Frame; window_frame?: Frame;
}
type Maybe<T> = T | Promise<T>;
/** The raw driver: sees and moves, decides nothing. The simulated one answers at once; a real one talks to a process. */
export interface Driver {
  snapshot(): Maybe<Snapshot>;
  observe(windowId: string, opts?: { screenshot?: boolean }): Maybe<Observation>;
  /** `foreground_ok`: the executor allows this one step to bring its app to the front (the task's own window, or one
   *  the user consented to); a driver that can act in the background may ignore it. */
  perform(action: Action, opts?: { foreground_ok?: boolean; shot?: string }): Maybe<PerformResult>;
  end?(): Maybe<void>;
  /** What the driver promises about where its actions land. `urlInOwnBrowserWindow`: an open_window with a url in a web
   *  browser (an app whose windows the driver marks `browser: true`) always loads in a browser window of the task's own,
   *  never in one of the user's — the executor then takes it for the task's own step. It says nothing of other apps: a
   *  url handed to any other app (hands: `open -g -b <app> <url>`) opens where that app likes, usually in the user's
   *  window, so without the promise, or for an app not marked a browser, a url is taken to land in the user's window. */
  readonly capabilities?: { urlInOwnBrowserWindow?: boolean };
}

/** What a run's receipts and verification can read back: the executor's own log of what it did. */
export interface Receipt { seq: number; t: number; request: Omit<ActRequest, "consent"> & { consent?: { scope: string; nonce: string } }; result: ActResult }
