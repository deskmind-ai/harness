/**
 * Why a send was asked again, in the trace: rc.9 (10-20) had the user approve one send four times, and the trace said
 * only "what goes out changed" / "consent is for another action". The executor now says which part changed.
 */
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/index.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor, type BindingChange } from "../src/executor/executor.js";
import { Judge, OUTGOING_QUESTION } from "../src/executor/judge.js";
import type { Action, Driver, Element, WindowInfo } from "../src/executor/types.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;

interface Win { info: WindowInfo; elements: Element[]; text: string }
class Desk implements Driver {
  epoch = 1;
  log: Action[] = [];
  constructor(public w: Win) {}
  snapshot() { return { epoch: this.epoch, locked: false, front_app: this.w.info.app, windows: [this.w.info] }; }
  observe() { return { epoch: this.epoch, window: this.w.info, modal: null, elements: this.w.elements.map((e) => ({ ...e })), text: this.w.text }; }
  perform(a: Action) { this.log.push(a); this.epoch += 1; return { status: "ok" as const, window: this.w.info.id }; }
}

async function setup(elements: Element[], pixelSendBinding: "strict" | "match" = "strict") {
  const gw = new Gateway(table);
  gw.script = Array(60).fill((_r: string, _s: string, u: string) => (u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: "sends" } : { choice: "matches" }));
  const w: Win = { info: { id: "w", app: "com.apple.Safari", title: "Mailora" }, elements, text: "" };
  const desk = new Desk(w), app = ConsentSigner.fresh(), events: { k: string; b: Record<string, unknown> }[] = [];
  const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, judge: new Judge([{ name: "frontier", gateway: gw }]), raw: "回复并发送", onEvent: (k, b) => events.push({ k, b }), pixelSendBinding });
  await ex.begin(); await ex.plan({ steps: [] });
  return { ex, desk, app, w, events, mine: app.forObject("window:w", "modify_user", "t1") };
}
const mail = (body: string, focus: boolean): Element[] => [
  { id: "elem_1", role: "statictext", label: "许诺", actions: [], rect: [10, 10, 60, 20] },
  { id: "elem_2", role: "textarea", label: "回复内容", value: body, actions: ["set_value", "type"], focused: focus, rect: [10, 300, 400, 80] },
  { id: "elem_3", role: "button", label: "发送", actions: ["click"], rect: [420, 300, 60, 30] },
];
const last = (events: { k: string; b: Record<string, unknown> }[], k: string) => [...events].reverse().find((e) => e.k === k)!.b;

describe("re-ask diagnostics", () => {
  it("the last look's re-ask names the part that changed — the focus leaving the reply box (the user answering our card) — in consent_needed and act", async () => {
    const { ex, w, app, events, mine } = await setup(mail("我看一下再说", true));
    const o = await ex.observe("w");
    const send: Action = { kind: "click", window: "w", target: "elem_3" };
    const r1 = await ex.act({ action: send, epoch: o.epoch, consent: mine });
    w.elements = mail("我看一下再说", false);
    const r2 = await ex.act({ action: send, epoch: o.epoch, consent: app.forAction(r1.challenge!) });
    expect(r2.status).toBe("needs_consent");
    expect(r2.why).toBe("what goes out changed right before sending; asked again with what is there now");   // the user-facing why stays short
    const changed = last(events, "executor.consent_needed").changed as { binding: BindingChange[] };
    expect(changed.binding).toContainEqual({ part: "focus", before: { sig: ["textarea", "回复内容", "我看一下再说", "ax"], at: [210, 340] }, after: null });
    expect(changed.binding.some((c) => c.part === "focus" && JSON.stringify(c.before).includes("true") && JSON.stringify(c.after).includes("false"))).toBe(true);
    expect(last(events, "executor.act").changed).toEqual(changed);
    expect(JSON.stringify(changed)).not.toContain("elem_");                                // signatures, no ids
  });

  it("a changed draft is a field change, before and after", async () => {
    const { ex, w, app, events, mine } = await setup(mail("草稿 A", false));
    const o = await ex.observe("w");
    const send: Action = { kind: "click", window: "w", target: "elem_3" };
    const r1 = await ex.act({ action: send, epoch: o.epoch, consent: mine });
    w.elements = mail("草稿 B", false);
    await ex.act({ action: send, epoch: o.epoch, consent: app.forAction(r1.challenge!) });
    const changed = last(events, "executor.consent_needed").changed as { binding: BindingChange[] };
    expect(changed.binding).toEqual([{ part: "field", before: { sig: ["textarea", "回复内容", "草稿 A", "ax", false], at: [210, 340] }, after: { sig: ["textarea", "回复内容", "草稿 B", "ax", false], at: [210, 340] } }]);
  });

  it("「consent is for another action」 says the token's action and epoch beside the request's, and what of the binding differs", async () => {
    const { ex, desk, w, app, events, mine } = await setup(mail("我看一下再说", true));
    let o = await ex.observe("w");
    const send: Action = { kind: "click", window: "w", target: "elem_3" };
    const r1 = await ex.act({ action: send, epoch: o.epoch, consent: mine });
    const yes = app.forAction(r1.challenge!);
    // the same action, decided again on a newer look where the focus has left the reply box
    w.elements = mail("我看一下再说", false); desk.epoch += 1;
    o = await ex.observe("w");
    const r2 = await ex.act({ action: send, epoch: o.epoch, consent: yes });
    expect([r2.status, r2.why]).toEqual(["needs_consent", "consent is for another action"]);
    const changed = last(events, "executor.consent_needed").changed as { token: { action: string; epoch: number }; request: { action: string; epoch: number }; binding: BindingChange[] };
    expect(changed.token.action).toBe(changed.request.action);
    expect([changed.token.epoch, changed.request.epoch]).toEqual([1, 2]);
    expect(changed.binding.map((c) => c.part)).toContain("focus");
    // a token for another element: the actions differ
    const other: Action = { kind: "click", window: "w", target: "elem_2" };
    await ex.act({ action: other, epoch: o.epoch, consent: app.forAction(r2.challenge!), consequence: "external" });
    const c2 = last(events, "executor.consent_needed").changed as { token: { action: string }; request: { action: string } };
    expect(c2.token.action).toContain("elem_3");
    expect(c2.request.action).toContain("elem_2");
  });

  it("strict, screen-read: an incoming line is reported as an element that came; at most ten items", async () => {
    const rows = (n: number): Element[] => [
      ...Array.from({ length: n }, (_, i) => ({ id: `ocr:${i}`, role: "listitem", label: `消息${i}`, actions: ["click"], rect: [10, 20 + i * 30, 200, 20] as [number, number, number, number] })),
      { id: `ocr:${n}`, role: "listitem", label: "发送", actions: ["click"], rect: [420, 600, 40, 20] },
    ];
    const { ex, w, app, events, mine } = await setup(rows(2));
    const o = await ex.observe("w");
    const send: Action = { kind: "click", window: "w", target: "ocr:2" };
    const r1 = await ex.act({ action: send, epoch: o.epoch, consent: mine });
    w.elements = [...rows(2), { id: "ocr:9", role: "listitem", label: "张三：在吗", actions: ["click"], rect: [10, 90, 200, 20] }];
    await ex.act({ action: send, epoch: o.epoch, consent: app.forAction(r1.challenge!) });
    const changed = last(events, "executor.consent_needed").changed as { binding: BindingChange[] };
    expect(changed.binding).toEqual([{ part: "element", before: null, after: { sig: ["listitem", "张三：在吗", null, false], at: [110, 100] } }]);
    // a page that changed everywhere: the list is cut at ten
    const r3 = await ex.act({ action: send, epoch: o.epoch, consent: mine });
    w.elements = rows(2).map((e, i) => (i < 2 ? e : e)).concat(Array.from({ length: 15 }, (_, i) => ({ id: `ocr:${20 + i}`, role: "listitem", label: `新${i}`, actions: ["click"], rect: [10, 200 + i * 30, 100, 20] as [number, number, number, number] })));
    await ex.act({ action: send, epoch: o.epoch, consent: app.forAction(r3.challenge!) });
    expect((last(events, "executor.consent_needed").changed as { binding: BindingChange[] }).binding.length).toBe(10);
  });
});
