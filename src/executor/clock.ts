/**
 * Deadlines by the wall clock (M2): an action card's 10 minutes (H1) and the result card's undo window (H2) are times
 * the user can read off a clock, so they count the time the Mac slept. Node's timers do not: on macOS they run on a
 * clock that stops in sleep, so a plain 10-minute timer set before an hour's sleep fires 10 awake minutes later. A
 * deadline is therefore checked against the wall clock every tick, and passes within one tick of waking.
 */

/** Wall time and a timer. `now` is the wall clock (ms, like Date.now); `schedule` runs `f` after `ms` of the
 *  process's timers and returns a cancel. Tests pass a fake one. */
export interface Clock { now(): number; schedule(ms: number, f: () => void): () => void }

export const WALL_CLOCK: Clock = { now: () => Date.now(), schedule: (ms, f) => { const h = setTimeout(f, ms); return () => clearTimeout(h); } };

/** How often a wall-clock deadline is checked: a Mac that wakes after it passes it within this long. */
export const DEADLINE_TICK_MS = 1000;

/** Run `f` once, when the wall clock reaches `deadline` (ms): at once if it has already. Returns a cancel; cancelling
 *  twice, or after it ran, is harmless. */
export function atWallTime(clock: Clock, deadline: number, f: () => void, tickMs = DEADLINE_TICK_MS): () => void {
  let cancel: (() => void) | null = null, over = false;
  const tick = () => {
    if (over) return;
    const left = deadline - clock.now();
    if (left <= 0) { over = true; f(); return; }
    cancel = clock.schedule(Math.min(tickMs, left), tick);
  };
  tick();
  return () => { over = true; cancel?.(); cancel = null; };
}
