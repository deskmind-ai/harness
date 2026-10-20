/**
 * Consent tokens: the app signs, the executor verifies. Ed25519 (node:crypto): the executor holds the public key
 * only, so a runtime between the two cannot forge a token; a challenge binds an action-scoped token to the exact
 * action, object and class — and, for a send, to what goes out — and every token expires and (action scope) is spent
 * on use.
 *
 * Four scopes (docs/0.5-decisions.md D4, D5, rc.10 10-21): action (this one action), object (this object, this task,
 * up to the class signed), site (opening pages of these hosts, this task), rule (a durable permission the executor
 * keeps).
 */
import { createHash, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from "node:crypto";
import type { Action, Challenge, Consequence, ConsentToken } from "./types.js";
import { rank } from "./types.js";

export const canon = (x: unknown): string => JSON.stringify(x, (_, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).sort()) : v));
/** `content`: what a send sends (the window's filled-in fields), so a "yes" to body A does not send body B — a click on
 *  Send is the same action whatever the draft says (review of #16). Left out of the digest when there is none. */
export const digestOf = (action: Action, object: string, consequence: Consequence, content?: unknown) => "sha256:" + createHash("sha256").update(canon({ action, object, consequence, ...(content !== undefined ? { content } : {}) })).digest("hex").slice(0, 32);

const unsigned = (t: ConsentToken) => { const { sig: _s, ...rest } = t; return canon(rest); };

/** The app's side: holds the private key. In the app it is the keychain / Secure Enclave; in tests, a fresh pair. */
export class ConsentSigner {
  constructor(private readonly key: KeyObject, readonly publicKey: KeyObject, private readonly now: () => number = Date.now) {}

  static fresh(now?: () => number): ConsentSigner {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return new ConsentSigner(privateKey, publicKey, now);
  }

  /** Answer a challenge: consent for exactly this action, once. */
  forAction(c: Challenge, ttlMs = 5 * 60_000): ConsentToken {
    return this.sign({ nonce: c.nonce, scope: "action", digest: c.digest, object: c.object, consequence: c.consequence, expires_at: this.now() + ttlMs, sig: "" });
  }

  /** Consent to open pages of these sites (open_window with an http or https URL whose hostname is one of `hosts`) in
   *  `task`, up to `consequence`, and nothing else: not a click, not typing. Per full hostname, so another subdomain
   *  asks again (owner 10-21: per-site consent, docs/0.5-decisions.md). The token itself is checked against `object`
   *  (the user's browser window a URL lands in, or the app a new window opens in) when it is passed with an action.
   *  modify_user: a plan's sites — their pages in the user's window, and (`sends`, host → what the card said goes there)
   *  the content the user approved sending to each, which the executor gives the provenance judge; never a pass for a
   *  send (review of #35). External: the user's yes on a card for a host the task had not opened since it read
   *  material — once it covered an open, the executor counts that host as approved for the rest of the task, whatever
   *  window its later pages land in (they are then no send, and need only what their class does). */
  forSite(object: string, hosts: string[], task: string, consequence: Consequence = "modify_user", ttlMs = 60 * 60_000, sends?: Record<string, string[]>): ConsentToken {
    const ok = [...new Set(hosts.map((h) => h.toLowerCase()).filter(Boolean))].sort();
    const said = sends ? Object.fromEntries(Object.entries(sends).map(([h, w]) => [h.toLowerCase(), w]).filter(([h]) => ok.includes(h as string))) : undefined;
    return this.sign({ nonce: randomBytes(16).toString("hex"), scope: "site", object, hosts: ok, consequence, task, ...(said && Object.keys(said).length ? { sends: said } : {}), expires_at: this.now() + ttlMs, sig: "" });
  }

  /** Consent for every action on `object` in `task` up to `consequence`, until it expires. */
  forObject(object: string, consequence: Consequence, task: string, ttlMs = 60 * 60_000): ConsentToken {
    return this.sign({ nonce: randomBytes(16).toString("hex"), scope: "object", object, consequence, task, expires_at: this.now() + ttlMs, sig: "" });
  }

  /** A durable rule (the executor stores it; `rule` is its text, e.g. "close my windows"), matched by object pattern
   *  and class. Long-lived by nature; the app lets the user revoke it. */
  forRule(rule: string, objectPattern: string, consequence: Consequence, ttlMs = 365 * 24 * 3600_000): ConsentToken {
    return this.sign({ nonce: randomBytes(16).toString("hex"), scope: "rule", object: objectPattern, consequence, rule, expires_at: this.now() + ttlMs, sig: "" });
  }

  private sign(t: ConsentToken): ConsentToken {
    return { ...t, sig: sign(null, Buffer.from(unsigned(t)), this.key).toString("base64") };
  }
}

/** The executor's side: public key, spent nonces, rules. */
export class ConsentVerifier {
  private readonly spent = new Set<string>();
  /** Challenges this executor issued: an action token answers one of these, never a challenge from another run
   *  (the app's key is the same for every run, so without this a hoarded token would do; review 10-18, T5). */
  private readonly issued = new Map<string, unknown>();
  readonly rules: ConsentToken[] = [];
  /** Rules that covered an action this task (their text), for the result card: 「按你以前定的规则做的」. */
  readonly rulesUsed = new Set<string>();

  /** The user's standing rules, handed over by the app at begin: only validly signed rule tokens are kept; anything
   *  else (another scope, a bad signature, expired) is dropped and reported. The executor never persists rules itself —
   *  a runtime between app and executor cannot add one. */
  loadRules(tokens: ConsentToken[]): { kept: number; dropped: string[] } {
    const dropped: string[] = [];
    for (const t of tokens) {
      const bad = t.scope !== "rule" ? "not a rule" : t.consequence === "external" ? "a rule may not cover sending" : this.valid(t);
      if (bad) { dropped.push(`${t.rule ?? t.nonce}: ${bad}`); continue; }
      if (!this.rules.some((r) => r.nonce === t.nonce)) this.rules.push(t);
    }
    return { kept: this.rules.length, dropped };
  }

  constructor(private readonly publicKey: KeyObject, private readonly now: () => number = Date.now) {}

  challenge(action: Action, object: string, consequence: Consequence, text: string, ttlMs = 5 * 60_000, content?: unknown): Challenge {
    const nonce = randomBytes(16).toString("hex");
    this.issued.set(nonce, content);
    return { nonce, digest: digestOf(action, object, consequence, content), object, consequence, text, expires_at: this.now() + ttlMs };
  }

  private valid(t: ConsentToken): string | null {
    if (!t.sig) return "unsigned";
    try { if (!verify(null, Buffer.from(unsigned(t)), this.publicKey, Buffer.from(t.sig, "base64"))) return "bad signature"; }
    catch { return "bad signature"; }
    if (t.expires_at <= this.now()) return "expired";
    return null;
  }

  /** Does this token (or a stored rule) cover the action? Spends an action-scoped token unless `spend` is false — then
   *  the caller spends it with `spend()` right before the effect, after its last checks. Returns the reason it does
   *  not, or null. */
  check(action: Action, object: string, consequence: Consequence, task: string, token?: ConsentToken, content?: unknown, spend = true): string | null {
    const covers = (t: ConsentToken): string | null => {
      const bad = this.valid(t);
      if (bad) return bad;
      if (rank(t.consequence) < rank(consequence)) return `consent covers ${t.consequence}, the action is ${consequence}`;
      if (t.scope === "action") {
        if (!this.issued.has(t.nonce)) return "consent answers a challenge this executor did not issue";
        if (t.digest !== digestOf(action, object, consequence, content)) return "consent is for another action";
        if (this.spent.has(t.nonce)) return "consent already used";
        return null;
      }
      if (t.scope === "site") {
        if (t.task !== task) return "consent is for another task";
        if (t.object !== object) return "consent is for another object";
        if (action.kind !== "open_window" || !action.url) return "consent covers opening pages only";
        const h = siteOf(action.url);
        if (!h) return "consent covers http(s) pages only";
        return t.hosts?.includes(h) ? null : `consent does not cover ${h}`;
      }
      if (t.scope === "object") {
        if (t.task !== task) return "consent is for another task";
        if (t.object !== object) return "consent is for another object";
        return null;
      }
      return matchesPattern(t.object ?? "", object) ? null : "rule does not cover this object";
    };
    if (token) {
      const why = covers(token);
      if (why) return why;
      if (token.scope === "action" && spend) this.spent.add(token.nonce);
      if (token.scope === "rule") { if (token.consequence === "external") return "a rule may not cover sending"; if (!this.rules.some((r) => r.nonce === token.nonce)) this.rules.push(token); this.rulesUsed.add(token.rule ?? token.nonce); }
      return null;
    }
    const rule = this.rules.find((r) => covers(r) === null);
    if (rule) { this.rulesUsed.add(rule.rule ?? rule.nonce); return null; }
    return "no consent";
  }

  /** A plan's sites from its site token (owner 10-21 refinement, review of #35): the hosts and what the card said goes
   *  to each, when the token is validly signed, unexpired and of that task; nothing otherwise. The runtime hands the
   *  token over; it cannot add a host or approved content itself. */
  planSitesOf(t: ConsentToken, task: string): { hosts: string[]; sends: Record<string, string[]> } {
    if (t.scope !== "site" || t.task !== task || this.valid(t)) return { hosts: [], sends: {} };
    return { hosts: t.hosts ?? [], sends: t.sends ?? {} };
  }

  /** What a challenge this executor issued was bound to (a send's content), so a later look can be held against what
   *  the user saw — not only against its digest. */
  contentOf(nonce: string): unknown { return this.issued.get(nonce); }

  /** Spend an action token checked with `spend: false`: false when it was spent meanwhile (used once only). */
  spend(token: ConsentToken): boolean {
    if (token.scope !== "action") return true;
    if (this.spent.has(token.nonce)) return false;
    this.spent.add(token.nonce);
    return true;
  }
}

/** The site a URL opens, as a site consent binds it: the full hostname (lower-cased and punycoded by URL), for http
 *  and https only; null for anything else (file:, mailto:, view-source:, an app's own scheme are never covered). */
export function siteOf(url: string): string | null {
  try { const u = new URL(url); return (u.protocol === "http:" || u.protocol === "https:") && u.hostname ? u.hostname : null; } catch { return null; }
}

/** `app:*`, `window:*`, an exact id, or `*`. */
export function matchesPattern(pattern: string, object: string): boolean {
  if (pattern === "*" || pattern === object) return true;
  if (pattern.endsWith("*")) return object.startsWith(pattern.slice(0, -1));
  return false;
}
