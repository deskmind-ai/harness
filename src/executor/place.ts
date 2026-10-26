/**
 * Where an element is, for the app's cursor and target box over a picture of its window: `rect_norm` — the element's
 * rect (local to the window, from the observation) as fractions of the window's size, 0–1 — and `frame`, the same on
 * screen in points. Nothing when the driver gave no rect or no window frame. Used by the step event (`step.target`,
 * ExecutorService.step) and by an action card's facts (`consent.target_box`, Executor), so the two never disagree.
 */
export type Box = [number, number, number, number];

export function placeOf(rect: Box | undefined, frame: Box | undefined): { rect_norm?: Box; frame?: Box } {
  if (!rect || !frame || !(frame[2] > 0) || !(frame[3] > 0)) return {};
  const c = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10_000) / 10_000;
  const [x, y, w, h] = rect, [fx, fy, fw, fh] = frame;
  return { rect_norm: [c(x / fw), c(y / fh), c(w / fw), c(h / fh)], frame: [fx + x, fy + y, w, h] };
}

/** The element's place as a card carries it: both parts, or nothing. */
export function boxOf(rect: Box | undefined, frame: Box | undefined): { rect_norm: Box; frame: Box } | undefined {
  const p = placeOf(rect, frame);
  return p.rect_norm && p.frame ? { rect_norm: p.rect_norm, frame: p.frame } : undefined;
}
