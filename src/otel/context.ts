/**
 * What is in progress right now, carried through async calls (AsyncLocalStorage): the step the executor is on (its
 * `step_id`), and later the judge question and the trace span. Whatever runs inside a step — the judges it asks, the
 * gateway calls they make, the executor's own trace events — can name that step without every function passing it
 * on. Outside a step (a look, the plan) the fields are absent.
 *
 * Only this process: the runtime in a child process (executor split P2) does not share it, and does not need to — every
 * step, judge and model call it would name happens on the executor's side.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export interface TraceContext {
  /** The executor step in progress (ExecutorService: one per act / file call), as the protocol's `step.step_id`. */
  step_id?: string;
}

const als = new AsyncLocalStorage<TraceContext>();

/** The context now: empty outside any. */
export function current(): TraceContext { return als.getStore() ?? {}; }

/** Run `fn` with `patch` added to the context; everything it awaits sees it, nothing outside does. */
export function within<T>(patch: TraceContext, fn: () => T): T { return als.run({ ...current(), ...patch }, fn); }
