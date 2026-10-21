/**
 * What the runtime and the executor both say about consent, with no code of either: the consequence classes, the
 * challenge the executor issues and the token the app signs for it, and the canonical form both digest. Lives in
 * protocol/ so the runtime can read a challenge without importing the executor (executor split, deskmind#90 item 6).
 * executor/types.ts and executor/consent.ts re-export all of it, so older imports keep working.
 */
import { createHash } from "node:crypto";

/** Ordered: a guard compares classes, so the order is the law. */
export const CONSEQUENCES = ["read", "create", "modify_user", "external"] as const;
export type Consequence = (typeof CONSEQUENCES)[number];
export const rank = (c: Consequence) => CONSEQUENCES.indexOf(c);
export const higher = (a: Consequence, b: Consequence): Consequence => (rank(a) >= rank(b) ? a : b);

/** The consent an action carries: a token the app signed for a challenge the executor issued (executor/consent.ts). */
export interface ConsentToken {
  nonce: string;                     // the challenge it answers (action scope), or a fresh one (object / rule scope)
  scope: "action" | "object" | "rule" | "site";
  digest?: string;                   // action scope: the exact action
  object?: string;                   // object scope: the window / tab / path it covers
  consequence: Consequence;          // the highest class it allows
  task?: string;                     // object scope: only this task
  rule?: string;                     // rule scope: a durable permission, in the executor's rule store
  hosts?: string[];                  // site scope: opening http(s) pages of these hosts (open_window; the URL's full hostname) in `object`, nothing else
  sends?: Record<string, string[]>;  // site scope, a plan's: host → what the plan card said goes there (given to the provenance judge)
  expires_at: number;                // ms since epoch
  sig: string;                       // base64 Ed25519 over canon(token without sig)
}

/** `site`: the host a yes approves for the rest of the task (an open_window to a host not yet approved, after the task
 *  read material): the app answers it with a site token for that host, not a one-time action token. */
export interface Challenge { nonce: string; digest: string; object: string; consequence: Consequence; text: string; expires_at: number; site?: string }

/** JSON with object keys sorted, at every depth: the form a digest and a signature are computed over. */
export const canon = (x: unknown): string => JSON.stringify(x, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).sort()) : v));
/** `content`: what a send sends (the window's filled-in fields), so a "yes" to body A does not send body B — a click on
 *  Send is the same action whatever the draft says (review of #16). Left out of the digest when there is none.
 *  `action` is the executor's Action; it is only canonicalised here, so the protocol does not need its shape. */
export const digestOf = (action: unknown, object: string, consequence: Consequence, content?: unknown) => "sha256:" + createHash("sha256").update(canon({ action, object, consequence, ...(content !== undefined ? { content } : {}) })).digest("hex").slice(0, 32);
