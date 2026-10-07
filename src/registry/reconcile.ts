/** Version comparison shared by the receipt check and the reconciliation of a lost receipt. */
import type { Workspace } from "./workspace.js";

export function matches(expected: Record<string, string>, ws: Workspace): boolean {
  for (const [k, v] of Object.entries(expected)) {
    const now = ws.version(k);
    if (v === "dir:*") { if (!now.startsWith("dir:")) return false; }
    else if (now !== v) return false;
  }
  return true;
}

export type Finding = "happened" | "not_happened" | "unknown";

export function reconcile(ws: Workspace, before: Record<string, string>, after: Record<string, string>): Finding {
  if (matches(after, ws)) return "happened";
  if (Object.entries(before).every(([k, v]) => ws.version(k) === v)) return "not_happened";
  return "unknown";
}
