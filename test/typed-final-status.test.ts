/**
 * The typed text a send takes with it is cleared in one place: done(), on the act's FINAL status ok (the one its
 * receipt records, after the read-back) — never on the driver's own ok (review of harness#66, Codex P1, the 2nd bug of
 * the "typed text cleared" family). Codex's three ways a raw ok becomes unverified after the driver answered: the
 * snapshot after it fails, the screen is locked after it, the window cannot be read back. In each, a task-owned chat
 * window with no marked Send control: the retried cmd+shift+d must still be asked about as a send (a card naming the
 * uncertain one), and pressed once only. Fail on fbce87d: cleared on the raw ok, the retry was classed create, no card.
 */
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/index.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { Judge, OUTGOING_QUESTION, type JudgeTier } from "../src/executor/judge.js";
import type { Action, Driver, Element, WindowInfo } from "../src/executor/types.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as never;

type Fault = "snapshot" | "locked" | "readback";
class Chat implements Driver {
  epoch = 1; log: Action[] = []; shown = false; fault: Fault | null = null; armed = false;
  info: WindowInfo = { id: "chat", app: "聊天", title: "张三" };
  elements: Element[] = [{ id: "ocr:1", role: "listitem", label: "输入消息…", actions: ["click", "type"] }];
  snapshot() {
    if (this.armed && this.fault === "snapshot") { this.armed = false; throw new Error("the computer could not be read"); }
    const locked = this.armed && this.fault === "locked";
    if (locked) this.armed = false;
    return { epoch: this.epoch, locked, front_app: "聊天", windows: this.shown ? [this.info] : [] };
  }
  observe() {
    if (this.armed && this.fault === "readback") { this.armed = false; throw new Error("the window could not be read"); }
    return { epoch: this.epoch, window: this.info, modal: null, elements: this.elements, text: "输入消息…" };
  }
  perform(a: Action) { this.log.push(a); this.epoch += 1; if (a.kind === "key") this.armed = true; return { status: "ok" as const, window: "chat" }; }
}

describe("a send's typed text goes only with a final ok", () => {
  for (const fault of ["snapshot", "locked", "readback"] as Fault[]) {
    it(`${fault} after the driver's ok: one press, then a card on the retry`, async () => {
      const top = new Gateway(table);
      top.script = Array(80).fill((_r: string, _s: string, u: string) => (u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: "sends" } : { choice: "matches" }));
      const chat = new Chat(), app = ConsentSigner.fresh();
      const ex = new Executor(chat, { task: "t1", publicKey: app.publicKey, judge: new Judge([{ name: "frontier", gateway: top } as JudgeTier]), raw: "回张三：明天见" });
      await ex.begin(); await ex.plan({ steps: [] });
      chat.shown = true; chat.epoch++; await ex.snapshot(); ex.ledger.created("window:chat");
      let o = await ex.observe("chat");
      expect((await ex.act({ action: { kind: "type", window: "chat", target: "ocr:1", text: "明天见" }, epoch: o.epoch })).status).toBe("ok");
      o = await ex.observe("chat");
      const key: Action = { kind: "key", window: "chat", chord: "cmd+shift+d" };
      const asked = await ex.act({ action: key, epoch: o.epoch });
      expect([asked.status, asked.consequence]).toEqual(["needs_consent", "external"]);
      chat.fault = fault;
      const first = await ex.act({ action: key, epoch: asked.epoch, consent: app.forAction(asked.challenge!) });
      expect(first.status).toBe("unverified");                      // the driver said ok; the step is not known done
      expect(ex.uncertainCount).toBe(1);
      chat.fault = null;
      o = await ex.observe("chat");
      const retry = await ex.act({ action: key, epoch: o.epoch });
      expect(retry.status).toBe("needs_consent");                   // still a send, and the uncertain one named
      expect(retry.challenge!.text).toMatch(/^之前「.*cmd\+shift\+d.*」结果不确定/);
      expect(chat.log.filter((a) => a.kind === "key")).toHaveLength(1);
    });
  }
});
