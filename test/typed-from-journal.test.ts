/**
 * The text possibly waiting in a window is read off the journal (possibly.ts' rule), not kept in a map (review of
 * harness#66, Codex P1, the 3rd bug of the "typed text" family): a typed newline (itself a send) that ended unverified
 * was never recorded, and a later cmd+shift+d was classed create and pressed with no card. Codex's two cases fail on
 * eb96cfc; the matrix checks the rule across outcomes and a restart.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/index.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { Judge, OUTGOING_QUESTION, type JudgeTier } from "../src/executor/judge.js";
import type { Action, Driver, Element, PerformResult, WindowInfo } from "../src/executor/types.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as never;
const judge = () => { const g = new Gateway(table); g.script = Array(200).fill((_r: string, _s: string, u: string) => (u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: "sends" } : { choice: "matches" })); return new Judge([{ name: "frontier", gateway: g } as JudgeTier]); };

class Chat implements Driver {
  epoch = 1; log: Action[] = []; replies: PerformResult[] = []; lockNext = false; lockAfter = false; shown = false;
  info: WindowInfo = { id: "chat", app: "聊天", title: "张三" };
  elements: Element[] = [{ id: "ocr:1", role: "listitem", label: "输入消息…", actions: ["click", "type"] }];
  snapshot() { const locked = this.lockNext; this.lockNext = false; return { epoch: this.epoch, locked, front_app: "聊天", windows: this.shown ? [this.info] : [] }; }
  observe() { return { epoch: this.epoch, window: this.info, modal: null, elements: this.elements, text: "输入消息…" }; }
  perform(a: Action) { this.log.push(a); this.epoch += 1; if (this.lockAfter) { this.lockAfter = false; this.lockNext = true; } return this.replies.shift() ?? { status: "ok" as const, window: "chat" }; }
}

type R = "ok" | "unverified" | "error" | "nothing";
const reply = (r: R | "lock"): PerformResult => (r === "unverified" ? { status: "unverified", why: "no answer" } : r === "error" ? { status: "error", why: "typing stopped part way" } : r === "nothing" ? { status: "user_busy", performed: false, why: "the user is active" } : { status: "ok", window: "chat" });

async function world(journal?: string) {
  const chat = new Chat(), app = ConsentSigner.fresh();
  const mk = () => new Executor(chat, { task: "t1", publicKey: app.publicKey, judge: judge(), raw: "回张三：明天见", ...(journal ? { journal } : {}) });
  const ex = mk();
  await ex.begin(); await ex.plan({ steps: [] });
  chat.shown = true; chat.epoch++; await ex.snapshot(); ex.ledger.created("window:chat");
  /** act with the card's yes when one is asked */
  const act = async (e: Executor, a: Action, r: R | "lock") => {
    let o = await e.observe("chat");
    let res = await e.act({ action: a, epoch: o.epoch });
    if (res.status === "needs_consent") { if (r === "lock") { chat.lockAfter = true; } else chat.replies.push(reply(r)); res = await e.act({ action: a, epoch: res.epoch, consent: app.forAction(res.challenge!) }); }
    else { o = o; }
    return res;
  };
  return { chat, app, ex, mk, act };
}
const KEY: Action = { kind: "key", window: "chat", chord: "cmd+shift+d" };
const type = (text: string): Action => ({ kind: "type", window: "chat", target: "ocr:1", text });

describe("Codex's cases: a typed newline that ended unverified", () => {
  for (const how of ["unverified", "lock"] as const) {
    it(`(${how === "lock" ? "ok, then the screen locked" : "the driver said unverified"}): the send key after it is asked about as a send`, async () => {
      const { chat, ex, act } = await world();
      const t = await act(ex, type("明天见\n"), how);
      expect(t.status).toBe("unverified");
      const o = await ex.observe("chat");
      const k = await ex.act({ action: KEY, epoch: o.epoch });
      expect([k.status, k.consequence]).toEqual(["needs_consent", "external"]);
      expect(chat.log.filter((a) => a.kind === "key")).toHaveLength(0);
    });
  }
});

describe("the matrix: what a following cmd+shift+d is classed as", () => {
  const cases: [boolean, R, "none" | "ok" | "unverified", boolean][] = [];
  for (const nl of [false, true]) for (const r of ["ok", "unverified", "error", "nothing"] as R[]) for (const s of ["none", "ok", "unverified"] as const) for (const restart of [false, true]) cases.push([nl, r, s, restart]);
  for (const [nl, r, s, restart] of cases) {
    it(`type${nl ? " with a newline" : ""} ${r}, send ${s}${restart ? ", restart" : ""}`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "typed-")), journal = path.join(dir, "j.jsonl");
      const { chat, ex, mk, act } = await world(journal);
      // the typing: a newline makes it a send (a card); plain typing in the task's own window goes as it is
      if (nl) await act(ex, type("明天见\n"), r);
      else { chat.replies.push(reply(r)); const o = await ex.observe("chat"); await ex.act({ action: type("明天见"), epoch: o.epoch }); }
      if (s !== "none") await act(ex, KEY, s);
      let e = ex;
      if (restart) { e = mk(); await e.begin(); e.ledger.created("window:chat"); }
      const o = await e.observe("chat");
      const c = await e.classify(KEY, o.epoch);
      // text possibly there (not refused before acting), not sent by its own newline (ok), and no certain send took it
      const waiting = r !== "nothing" && !(nl && r === "ok") && s !== "ok";
      expect(c.consequence === "external").toBe(waiting);
    });
  }
});
