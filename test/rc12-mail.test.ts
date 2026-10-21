/**
 * rc.12 run_dc7236fc (10-21): a reply in a web mail page (Safari「Mailora」) was approved seven times and never sent.
 * Every last look before the send came back `needs_consent` with an empty binding diff. The looks here are the run's
 * own accessibility reads of the window (test/fixtures/rc12-mailora.json, converted as hands b77f0a0 does).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/index.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor, bindingDiff, outgoing, within, type BindingChange } from "../src/executor/executor.js";
import { Judge, OUTGOING_QUESTION } from "../src/executor/judge.js";
import type { Action, Driver, Element, WindowInfo } from "../src/executor/types.js";

const fx = JSON.parse(readFileSync(new URL("./fixtures/rc12-mailora.json", import.meta.url), "utf8")) as { card: Element[]; fresh: Element[]; fewer: Element[] };
const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;

interface Win { info: WindowInfo; elements: Element[] }
class Desk implements Driver {
  epoch = 7; log: Action[] = [];
  constructor(public w: Win) {}
  snapshot() { return { epoch: this.epoch, locked: false, front_app: "Safari浏览器", windows: [this.w.info] }; }
  // the window's text as hands gives it: every static text, in order (deskmind_hands/executor.py observe)
  observe() { return { epoch: this.epoch, window: this.w.info, modal: null, elements: this.w.elements.map((e) => ({ ...e })), text: this.w.elements.filter((e) => /^(statictext|text)$/i.test(e.role) && (e.value || e.label)).map((e) => e.value || e.label).join("\n") }; }
  perform(a: Action) { this.log.push(a); this.epoch += 1; return { status: "ok" as const, window: this.w.info.id }; }
}

async function setup(elements: Element[]) {
  const gw = new Gateway(table);
  gw.script = Array(40).fill((_r: string, _s: string, u: string) => (u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: "sends" } : { choice: "matches" }));
  const w: Win = { info: { id: "com.apple.Safari#1210", app: "com.apple.Safari", title: "Mailora", owner: "task" } as WindowInfo, elements };
  const desk = new Desk(w), app = ConsentSigner.fresh(), events: { k: string; b: Record<string, unknown> }[] = [];
  const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, judge: new Judge([{ name: "frontier", gateway: gw }]), raw: "给许诺的“合同续签”那封邮件回复“我看一下再说”并发送", onEvent: (k, b) => events.push({ k, b }) });
  await ex.begin(); await ex.plan({ steps: [] });
  return { ex, desk, app, w, events };
}
const send: Action = { kind: "click", window: "com.apple.Safari#1210", target: "elem_96" };

/** One send through the card: the card from the look `card`, the user approves, the last look reads `fresh`. */
async function approveAndSend(card: Element[], fresh: Element[]) {
  const { ex, desk, app, w, events } = await setup(card);
  const o = await ex.observe(w.info.id);
  const r1 = await ex.act({ action: send, epoch: o.epoch });
  expect(r1.status).toBe("needs_consent");
  w.elements = fresh;
  const r2 = await ex.act({ action: send, epoch: o.epoch, consent: app.forAction(r1.challenge!) });
  return { r1, r2, desk, events };
}

describe("rc.12 mail: the last look before a send, on the run's own reads of the page", () => {
  it("an unchanged page (two reads of it) is sent after one approval", async () => {
    const { r2, desk } = await approveAndSend(fx.card, fx.fresh);
    expect(r2.status).toBe("ok");
    expect(desk.log).toEqual([send]);
  });

  it("one of two identical anonymous groups not read again is not a change either", async () => {
    const { r2, desk } = await approveAndSend(fx.card, fx.fewer);
    expect(r2.status).toBe("ok");
    expect(desk.log).toEqual([send]);
  });

  it("a changed reply still asks again, and the trace names the field", async () => {
    const changed = fx.fresh.map((e) => (e.id === "elem_93" ? { ...e, value: "同意，签吧" } : e));
    const { r2, desk, events } = await approveAndSend(fx.card, changed);
    expect(r2.status).toBe("needs_consent");
    expect(desk.log).toEqual([]);
    const c = [...events].reverse().find((e) => e.k === "executor.consent_needed")!.b.changed as { binding: BindingChange[] };
    expect(c.binding.map((x) => x.part)).toContain("field");
  });

  it("every re-ask is explained: within() is false exactly when bindingDiff() has items, on the run's reads and edits of them", () => {
    const bindingOf = (els: Element[]) => {
      const o = { epoch: 7, window: { id: "w", app: "com.apple.Safari", title: "Mailora" }, modal: null, elements: els, text: "" };
      return { ...(outgoing(o as any).bound as object), typed: [], target: null, focused: null } as any;
    };
    const base = fx.card;
    const edits: [string, Element[]][] = [
      ["same", fx.fresh],
      ["fewer anonymous", fx.fewer],
      ["reply changed", base.map((e) => (e.id === "elem_93" ? { ...e, value: "x" } : e))],
      ["recipient line gone", base.filter((e) => e.id !== "elem_85")],
      ["a button came", [...base, { id: "elem_200", role: "button", label: "全部回复", actions: ["click"], source: "ax", rect: [900, 387, 60, 19] } as Element]],
      ["a text came", [...base, { id: "elem_201", role: "staticText", label: "新邮件", value: "新邮件", actions: ["click"], source: "ax", rect: [900, 500, 60, 19] } as Element]],
      ["a second 许诺 came", [...base, { ...base.find((e) => e.id === "elem_85")!, id: "elem_202", rect: [781, 500, 32, 19] }]],
      ["a group came", [...base, { id: "elem_203", role: "group", label: "组", role_description: "组", label_from_role: true, actions: ["click"], source: "ax", rect: [900, 600, 20, 20] } as Element]],
      ["reordered", [...base.slice(0, 10), base[11]!, base[10]!, ...base.slice(12)]],
    ];
    for (const [name, els] of edits) {
      const a = bindingOf(base), b = bindingOf(els);
      const diff = bindingDiff(a, b, "strict", Infinity);
      expect([name, within(a, b, "strict"), diff.length === 0]).toEqual([name, diff.length === 0, diff.length === 0]);
    }
  });
});
