/**
 * What the runtime and the executor both say about the computer, with no code of either: the whole computer in one
 * format (Snapshot, WindowInfo, Observation, Element), the generic actions (Action), an action's result (ActResult), and
 * a plan's shape (PlanStep, Reading). Moved here from executor/types.ts so the runtime can name them without importing
 * the executor (executor split P1, deskmind#90 item 6); executor/types.ts re-exports all of it, so older imports keep
 * working.
 */
import type { Challenge, Consequence } from "./consent.js";

export type Owner = "user" | "task";


export interface TabInfo { id: string; title: string; url: string; active?: boolean; owner?: Owner }
export interface WindowInfo {
  id: string; app: string; title: string;
  owner?: Owner;                      // filled by the executor from its ledger; a driver never says
  focused?: boolean; minimized?: boolean;
  url?: string; tabs?: TabInfo[];     // a browser window
  /** The driver knows the app is a web browser (hands' is_browser). Absent: not known, not "no". */
  browser?: boolean;
  /** The app's localized name (hands; falls back to the bundle id there), for what the user reads; and its bundle id. */
  app_name?: string; bundle?: string;
  /** Brought up by the task's launch of the app (hands#54 `opened_window`), filled by the executor: still the user's. */
  opened?: boolean;
  /** The driver can operate this window only with its app in front (hands): the plan card says so. */
  needs_foreground?: boolean;
}

/** The whole computer, every app in one format. Read-only, so nothing is hidden: the user's windows are listed too. */
export interface Snapshot { epoch: number; locked: boolean; front_app: string; windows: WindowInfo[]; user_active?: boolean;
  /** What the hands driver hears of the user's input: "keys" (keyboard and mouse, by target), "mouse" (no Input Monitoring:
   *  every key press counts), "" (no tap: every input counts). Told in the run's trace so a check knows which it had. */
  input_watch?: string;
  /** Why the epoch last moved, when the driver says (hands#53): {epoch, at, by: action{kind, window} | input{to: app |
   *  unknown} | windows{app, appeared | vanished | renamed}}. Carried into a stale result's trace; never decides. */
  epoch_reason?: unknown;
  /** The web browsers installed on the computer, running or not, by bundle id and every name the app goes by (its
   *  localized names): what an app named in an open_window is, before it has a window to say so. Absent: not known. */
  browsers?: { bundle: string; names: string[] }[];
  /** Apps sending audio to an output device right now (hands#55; no track title — the system keeps that closed). */
  audio_playing?: { bundle: string; app_name?: string }[];
  /** Apps the driver can operate only in front (hands), when it says so per snapshot rather than per window. */
  needs_foreground?: string[] }

export interface Element {
  id: string; role: string; label: string; actions: string[];
  value?: string; options?: string[]; enabled?: boolean; focused?: boolean; in_modal?: boolean;
  /** Structural evidence that activating this element sends something out of the machine (submits a form, sends a
   *  message, pays): the executor's floor for its consequence is then `external`. From the app profile or the page's
   *  own semantics, never from a model. */
  sends?: boolean;
  /** Where the element was read from: the accessibility tree (`ax`), or the screen's pixels (`pixels`: text
   *  recognition, controls hands made up, Eyes). Until hands sends it, the executor infers it from the id prefix
   *  (`ocr:`, `gen:`, `icon:`, `desc:` are read from the screen). */
  source?: "ax" | "pixels";
  /** The role as the accessibility tree describes it (AXRoleDescription, 「组」 on a group; hands), and whether hands
   *  took the label from the role: a label that only describes the role names nothing. */
  role_description?: string; label_from_role?: boolean;
  rect?: [number, number, number, number];
}

/** One window, close up: its elements (an accessibility tree), text and, when asked for, a screenshot. */
export interface Observation {
  epoch: number; window: WindowInfo; modal: { title: string } | null; elements: Element[];
  text?: string; screenshot_png?: string;     // base64
}

export type Action =
  | { kind: "click"; window: string; target: string }
  | { kind: "double_click"; window: string; target: string }     // opens a row, plays a song: what a single click only selects
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

export type ActStatus = "ok" | "unverified" | "stale" | "needs_consent" | "needs_plan" | "refused" | "blocked" | "error" | "stopped" | "environment";

/** One place the request can be read more than one way: the reading the plan takes, the others, and the evidence
 *  for the choice (things seen: a window title, a file name, a line of a file, the user's answer — never the
 *  request's own words). The judge decides whether the evidence settles it; if not, the user is asked first. */
export interface Reading { point: string; reading: string; alternatives: string[]; evidence: string[] }
export interface PlanStep { purpose: string; objects: string[]; consequence: Consequence }
export interface PlanProposal { steps: PlanStep[]; readings?: Reading[] }
export type PlanVerdict = { accepted: true; steps: PlanStep[] } | { accepted: false; open: Reading[]; why: string };

export interface ActResult {
  status: ActStatus;
  why?: string;
  epoch: number;                     // after the action
  consequence: Consequence;          // the class the executor settled on
  object: string;                    // what it touched (a window id, a tab id, a path)
  files?: string[];                  // task-folder paths a screen action wrote (an app's save), credited to the task
  challenge?: Challenge;             // with needs_consent
  /** What changed, in structure: the window's elements before / after, for the step check. */
  changed?: { elements: number; focus?: string; modal?: string | null; new_windows?: string[] };
  after?: Observation;               // the window after the action (re-observed)
  /** A window this action made, credited to the task in the ledger (the driver's `new_window`, accepted by
   *  Executor.act): steps in it are the task's own. */
  created_window?: string;
  output?: Record<string, unknown>;  // a file capability's output (a read's text, a listing)
  /** With `refused`: the action writes a file that an interrupted step of an earlier process was writing — whether that
   *  step took effect is unknown — and that file changed since. Nothing is written there until the user settles it (the
   *  reconciliation card); these are the facts the card is built from. */
  reconcile?: Reconciliation;
}

/** One file an interrupted step was writing, at that step and now: versions always; for small text files the text and
 *  the lines that differ (`removed`: at the step, not now; `added`: now, not at the step). */
export interface ReconcileFile { path: string; version_at_step: string; version_now: string; text_at_step?: string; text_now?: string; removed?: string[]; added?: string[] }
/** A step an earlier process started and never receipted (the journal has its intent, no receipt), whose effect is
 *  unknown, on files that changed since that step's intent. `decision`: null until the user answers; "continue" once
 *  they chose to go on from the files as they are now. */
export interface Reconciliation { step: string; action: Action; object: string; files: ReconcileFile[]; decision: null | "continue" }
