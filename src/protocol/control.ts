/**
 * Control lines: what the app writes on the run's stdin, one JSON object per line (docs/protocol.md, control v1).
 *
 *   {"type":"answer", "ask_id":"ask_…", "option":<n>} | {"type":"answer", "ask_id":"ask_…", "text":"…"}   a card's answer
 *   {"type":"stop"}                                                                                      stop the task now
 *   {"type":"stop", "app_gone":true}                                     the same, sent because the app ended or left (not the user)
 *   {"type":"respond", "option":<n>}                                                                     the result card's answer
 *   {"type":"steer", "text":"…"}                                                                         the user's words mid-run
 *
 * Version 1 still reads the lines from before `type` (the Swift helper moves over later): `{"stop":true}` is a stop,
 * `{"respond":<n>}` a respond, and any other object (`{ask_id, option}`, `{ask_id, text}`, `{}`) an answer. A typed
 * line of a type this version does not know is not a control (null): the reader ignores it.
 */
export type Control =
  | { type: "answer"; ask_id?: string; option?: number; text?: string }
  | { type: "stop"; app_gone?: true }
  | { type: "respond"; option?: number; text?: string }
  | { type: "steer"; text: string };

export const CONTROL_TYPES = ["answer", "stop", "respond", "steer"] as const;

/** One stdin line → a control, or null (not JSON, not an object, or a type this version does not know). */
export function parseControl(line: string): Control | null {
  let j: unknown;
  try { j = JSON.parse(line); } catch { return null; }
  if (!j || typeof j !== "object" || Array.isArray(j)) return null;
  const o = j as Record<string, unknown>;
  const str = (k: string) => (typeof o[k] === "string" ? { [k]: o[k] as string } : {});
  const num = (k: string, from = k) => (typeof o[from] === "number" ? { [k]: o[from] as number } : {});
  if (o.type === undefined) {
    // the untyped lines of before control v1
    if (o.stop === true) return { type: "stop" };
    if (typeof o.respond === "number") return { type: "respond", ...num("option", "respond") };
    return { type: "answer", ...str("ask_id"), ...num("option"), ...str("text") };
  }
  switch (o.type) {
    case "answer": return { type: "answer", ...str("ask_id"), ...num("option"), ...str("text") };
    case "stop": return { type: "stop", ...(o.app_gone === true ? { app_gone: true as const } : {}) };
    case "respond": return { type: "respond", ...num("option"), ...str("text") };
    case "steer": return typeof o.text === "string" ? { type: "steer", text: o.text } : null;
    default: return null;
  }
}

/** A JSON object with a `type` this version does not know: a later version's control line, ignored here. */
export function isForeignControl(line: string): boolean {
  try { const j = JSON.parse(line); return !!j && typeof j === "object" && typeof j.type === "string" && !(CONTROL_TYPES as readonly string[]).includes(j.type); } catch { return false; }
}
