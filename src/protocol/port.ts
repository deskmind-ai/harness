/**
 * The executor port: what a runtime (our agent loop today, Codex or another MCP client later) may ask of the executor,
 * and nothing else. It is the TypeScript shape of the MCP tool set the executor will serve once the runtime runs in a
 * child process (executor split P2, deskmind#90 item 6); in P1 the runtime calls it in process.
 *
 * Everything that keeps the user safe sits behind it: the signing key, the cards (plan, ambiguity, action consent,
 * questions, the result card), the start gate, the intent check, skills, verification and undo, and the task's final
 * status — a task ends "succeeded" only on a passing verdict. A caller decides what to do next and reads the replies;
 * it never sees a card, a token or a key.
 */
import type { Card } from "./cards.js";
import type { Consequence } from "./consent.js";
import type { Action, Observation, Reading, Snapshot } from "./computer.js";

/** A plan step as the caller writes it; `opens`: the URLs it opens with open_window, in which app, and what the URL sends
 *  to the site in a few words (`sends`, e.g. 搜索「北京天气」; shown on the plan card). */
export interface PlanStepIn { purpose: string; objects: string[]; consequence: Consequence; opens?: { app: string; url: string; sends?: string }[] }

/** What a tool call gives back: the text the model reads, whether it is an error, and `done` when the task is over (the
 *  executor has settled its status: the caller makes no more calls, only `end`). */
export interface ToolReply { text: string; isError?: boolean; done?: boolean;
  /** The user's mid-run words this reply carries (a steer applied at this call), whole: a caller keeps them as the user's
   *  words (our loop: a user message, which compaction never cuts), not only inside a tool result. */
  steers?: string[] }

/** A file capability the caller may offer the model as a tool: its tool name, the capability, what it does, its
 *  arguments (all strings, paths relative to the task folder). */
export interface FileTool { name: string; capability: string; description: string; params: Record<string, { description: string }> }

/** What `begin` gives the caller to start with. `ended`: the task cannot start (the screen is locked, the computer could
 *  not be read); `end` then gives the result. */
export interface Begun {
  ended: boolean;
  snapshot: Snapshot | null;
  /** An action an earlier process started and never receipted, what became of it, and the files changed meanwhile. */
  recovered: { text: string; finding: "happened" | "not_happened" | "unknown"; external: string[];
    /** The step's effect is unknown and a file it was writing changed since: the user was asked (the reconciliation
     *  card) and chose to go on from the files as they are now. Absent when nothing needed settling. */
    reconciled?: "continue" } | null;
  /** The task folder: its absolute path and its listing (with the first lines of small files). */
  workspace: { root: string; listing: unknown } | null;
  /** Tutorials that may apply (by structure: the apps on screen, the folder's file types); `readSkill` reads one. */
  skills: { name: string; description: string }[];
  /** Whether the task has tutorials at all (a `readSkill` tool is worth offering), candidates or not. */
  skillsOffered: boolean;
  files: FileTool[];
}

export type TaskStatus = "succeeded" | "unconfirmed" | "failed" | "cancelled" | "environment" | "stopped";

export interface TaskResult {
  status: TaskStatus; reason: string; summary: string; answer: string | null;
  counters: Record<string, number>; consents: { scope: string; object: string; consequence: Consequence }[];
  effects: string[];
  /** The finish verdicts, in order; claims_contradicted: the sentences of the run's account the judge found
   *  contradicted by the evidence (absent when the judge left the field out). */
  verdicts: { verdict: string; reason: string; claims_contradicted?: string[] }[];
  /** Shown with the result, not blocking: 「好的」, and 「撤回」 when every effect can be taken back. */
  result_card: Card | null;
}

export type FinishOutcome = "done" | "unconfirmed" | "cannot" | "stopped";

export interface ExecutorPort {
  /** Start the task: everything on screen now is the user's. */
  begin(): Promise<Begun>;
  /** The whole computer, owners stamped. Read-only. */
  snapshot(): Promise<Snapshot>;
  /** One window close up. Read-only; throws when the window cannot be read. */
  observe(window: string): Promise<Observation>;
  /** One action on screen. The executor settles its class, asks the user when it needs consent (and waits), signs the
   *  yes, and acts. */
  act(p: { action: Action; epoch: number; consequence: Consequence; purpose: string;
    /** Which step of the plan this action is for (1-based), as the caller says: shown in the app's step list, never used
     *  for consent or verification. */
    plan_step?: number }): Promise<ToolReply>;
  /** One file capability on the task folder (a `FileTool`), under the same guard. */
  file(p: { capability: string; args: Record<string, string> }): Promise<ToolReply>;
  /** The plan: the start gate (readings the judge cannot settle are asked of the user), then one plan card for the
   *  user's objects and the sites it names. */
  plan(p: { steps: PlanStepIn[]; readings?: Reading[] }): Promise<ToolReply>;
  /** A question only the user can answer; the answer is kept as the user's words for every later judgement. */
  askUser(p: { question: string; options: string[] }): Promise<ToolReply>;
  /** The answer to a user's question, for the result and the verdict. */
  answer(p: { text: string }): Promise<ToolReply>;
  readSkill(p: { name: string }): Promise<ToolReply>;
  /** The caller's claim that the task is over. "done" is checked by an independent verdict; it ends the task only when
   *  that passes. */
  finish(p: { outcome: FinishOutcome; summary: string; missing?: string[] }): Promise<ToolReply>;
  /** What the user said mid-run (steer) that no reply has carried yet, applied now — between two steps, never during
   *  one. A step the caller asks for while one is pending is not done: its reply carries the new words instead, and
   *  every further step is refused the same way until the caller calls this again (at its next turn: the steps it had
   *  decided before hearing the words are not done). */
  steers(): string[];
  /** Close the task and give its result. `failure`: why the caller is giving up (a budget, a model error), used only
   *  when the executor has not settled the status itself. */
  end(p?: { failure?: string }): Promise<TaskResult>;
}
