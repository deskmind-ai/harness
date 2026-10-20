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
  it("Return in the reply box: the focus leaving it is still a change — stale at the last look, and named in the binding when re-decided", async () => {
    const { ex, desk, w, app, events, mine } = await setup(mail("我看一下再说", true));
    let o = await ex.observe("w");
    const ret: Action = { kind: "key", window: "w", chord: "return" };
    const r1 = await ex.act({ action: ret, epoch: o.epoch, consent: mine });
    expect(r1.status).toBe("needs_consent");
    const yes = app.forAction(r1.challenge!);
    w.elements = mail("我看一下再说", false);
    expect((await ex.act({ action: ret, epoch: o.epoch, consent: yes })).status).toBe("stale");   // the last look: the focus moved
    desk.epoch += 1; o = await ex.observe("w");
    const r3 = await ex.act({ action: ret, epoch: o.epoch, consent: yes });
    expect([r3.status, r3.why]).toEqual(["needs_consent", "what goes out changed since it was approved"]);
    const changed = last(events, "executor.consent_needed").changed as { binding: BindingChange[] };
    expect(changed.binding).toContainEqual({ part: "focus", before: { sig: ["textarea", "回复内容", "我看一下再说", "ax"], at: [210, 340] }, after: null });
    expect(last(events, "executor.act").changed).toEqual(changed);
    expect(JSON.stringify(changed)).not.toContain("elem_");                                // signatures, no ids
    expect(desk.log).toEqual([]);
  });

  it("a click send: the focus leaving the reply box alone (the user answering our card) no longer asks again", async () => {
    const { ex, desk, w, app, mine } = await setup(mail("我看一下再说", true));
    const o = await ex.observe("w");
    const send: Action = { kind: "click", window: "w", target: "elem_3" };
    const r1 = await ex.act({ action: send, epoch: o.epoch, consent: mine });
    w.info = { ...w.info };
    w.elements = mail("我看一下再说", false);                                                // DeskMind came forward, Safari's focus cleared
    expect((await ex.act({ action: send, epoch: o.epoch, consent: app.forAction(r1.challenge!) })).status).toBe("ok");
    expect(desk.log).toEqual([send]);
  });

  it("a click send: the recipient, the content and the target still ask again (or go stale) — none is sent", async () => {
    const variants: [string, (w: Win) => void][] = [
      ["张三→李四", (w) => { w.elements = [{ ...w.elements[0]!, label: "李四" }, ...w.elements.slice(1)]; }],
      ["a recipient tag added", (w) => { w.elements = [...w.elements, { id: "elem_9", role: "button", label: "b@evil.com", actions: ["click"], rect: [80, 10, 90, 20] }]; }],
      ["the draft changed", (w) => { w.elements = mail("别的内容", false); }],
      ["the target swapped", (w) => { w.elements = [...w.elements.slice(0, 2), { ...w.elements[2]!, label: "全部转发" }]; }],
    ];
    for (const [name, change] of variants) {
      const { ex, desk, w, app, mine } = await setup(mail("我看一下再说", true));
      const o = await ex.observe("w");
      const send: Action = { kind: "click", window: "w", target: "elem_3" };
      const r1 = await ex.act({ action: send, epoch: o.epoch, consent: mine });
      change(w);
      const r2 = await ex.act({ action: send, epoch: o.epoch, consent: app.forAction(r1.challenge!) });
      expect([name, ["needs_consent", "stale"].includes(r2.status), desk.log.length]).toEqual([name, true, 0]);
    }
  });

  it("a changed draft is a field change, before and after", async () => {
    const { ex, w, app, events, mine } = await setup(mail("草稿 A", false));
    const o = await ex.observe("w");
    const send: Action = { kind: "click", window: "w", target: "elem_3" };
    const r1 = await ex.act({ action: send, epoch: o.epoch, consent: mine });
    w.elements = mail("草稿 B", false);
    await ex.act({ action: send, epoch: o.epoch, consent: app.forAction(r1.challenge!) });
    const changed = last(events, "executor.consent_needed").changed as { binding: BindingChange[] };
    expect(changed.binding).toEqual([{ part: "field", before: { sig: ["textarea", "回复内容", "草稿 A", "ax"], at: [210, 340] }, after: { sig: ["textarea", "回复内容", "草稿 B", "ax"], at: [210, 340] } }]);
  });

  it("the same action with what goes out changed says so, not 「another action」; a token for another action still says 「another action」", async () => {
    const { ex, desk, w, app, events, mine } = await setup(mail("草稿 A", false));
    let o = await ex.observe("w");
    const send: Action = { kind: "click", window: "w", target: "elem_3" };
    const r1 = await ex.act({ action: send, epoch: o.epoch, consent: mine });
    const yes = app.forAction(r1.challenge!);
    w.elements = mail("草稿 B", false); desk.epoch += 1;
    o = await ex.observe("w");
    const r2 = await ex.act({ action: send, epoch: o.epoch, consent: yes });
    expect([r2.status, r2.why]).toEqual(["needs_consent", "what goes out changed since it was approved"]);
    const changed = last(events, "executor.consent_needed").changed as { token: { action: string; epoch: number }; request: { action: string; epoch: number }; binding: BindingChange[] };
    expect(changed.token.action).toBe(changed.request.action);
    expect([changed.token.epoch, changed.request.epoch]).toEqual([1, 2]);
    expect(changed.binding.map((c) => c.part)).toEqual(["field"]);
    const other: Action = { kind: "click", window: "w", target: "elem_2" };
    const r3 = await ex.act({ action: other, epoch: o.epoch, consent: app.forAction(r2.challenge!), consequence: "external" });
    expect(r3.why).toBe("consent is for another action");
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

describe("the runtime's trace of tool results", () => {
  it("keeps up to 2000 characters of a tool result (300 cut every observation on rc.9)", async () => {
    const { FrontierRuntime } = await import("../src/runtime/loop.js");
    const { scriptedStream } = await import("../src/runtime/scripted.js");
    const many: Element[] = Array.from({ length: 80 }, (_, i) => ({ id: `elem_${i}`, role: "statictext", label: `第 ${i} 行邮件标题`, actions: [], rect: [0, i * 20, 200, 20] }));
    const desk = new Desk({ info: { id: "w", app: "com.apple.Safari", title: "Mailora" }, elements: many, text: "" });
    const app = ConsentSigner.fresh();
    const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey });
    const gw = new Gateway(table);
    gw.script = Array(10).fill(() => ({ choice: "pass", reason: "ok" }));
    const events: { k: string; b: Record<string, unknown> }[] = [];
    const model = { model: { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as any };
    const steps: any[] = [{ calls: [{ name: "computer_observe", args: { window: "w" } }] }, { calls: [{ name: "finish", args: { outcome: "done", summary: "看过了" } }] }];
    const rt = new FrontierRuntime({ task: "t1", raw: "看一下邮件", executor: ex, signer: app, user: { ask: () => null }, gateway: gw, model: { ...model, streamFn: scriptedStream(steps) }, onEvent: (k, b) => events.push({ k, b }) });
    await rt.run();
    const seen = events.find((e) => e.k === "tool.result" && e.b.name === "computer_observe")!.b.text as string;
    expect(seen.length).toBe(2000);
  });
});

describe("why the epoch moved, in a stale act's trace (hands#53 epoch_reason)", () => {
  /** A desk whose snapshot says why its epoch last moved, like hands#53 — or says nothing, like an older hands. */
  class ReasonDesk extends Desk {
    reason: unknown = undefined;
    snapshot() { return { ...super.snapshot(), ...(this.reason !== undefined ? { epoch_reason: this.reason } : {}) }; }
  }
  const run = async (say: boolean) => {
    const w: Win = { info: { id: "w", app: "com.apple.Safari", title: "Mailora" }, elements: mail("我看一下再说", false), text: "" };
    const desk = new ReasonDesk(w), app = ConsentSigner.fresh(), events: { k: string; b: Record<string, unknown> }[] = [];
    const gw = new Gateway(table);
    gw.script = Array(20).fill((_r: string, _s: string, u: string) => (u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: "sends" } : { choice: "matches" }));
    const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, judge: new Judge([{ name: "frontier", gateway: gw }]), raw: "回复并发送", onEvent: (k, b) => events.push({ k, b }) });
    await ex.begin(); await ex.plan({ steps: [] });
    const o = await ex.observe("w");
    const send: Action = { kind: "click", window: "w", target: "elem_3" };
    // early: the computer moved after the model decided
    desk.epoch += 1;
    if (say) desk.reason = { epoch: desk.epoch, at: 1792503195.9, by: { input: { to: "unknown" } } };
    const r1 = await ex.act({ action: send, epoch: o.epoch });
    // at the last look: the epoch moves while the window is looked at again before the send
    const o2 = await ex.observe("w");
    const r2 = await ex.act({ action: send, epoch: o2.epoch, consent: app.forObject("window:w", "modify_user", "t1") });
    const yes = app.forAction(r2.challenge!);
    const observe = desk.observe.bind(desk);
    desk.observe = () => { desk.epoch += 1; if (say) desk.reason = { epoch: desk.epoch, at: 1792503196.2, by: { windows: { app: "com.apple.Safari", appeared: true } } }; return observe(); };
    const r3 = await ex.act({ action: send, epoch: o2.epoch, consent: yes });
    const acts = events.filter((e) => e.k === "executor.act" && e.b.status === "stale").map((e) => e.b);
    return { r1, r3, acts, desk };
  };

  it("carries the snapshot's epoch_reason into executor.act for the early check and for the last look", async () => {
    const { r1, r3, acts, desk } = await run(true);
    expect([r1.status, r3.status]).toEqual(["stale", "stale"]);
    expect(acts.map((a) => a.epoch_reason)).toEqual([
      { epoch: 2, at: 1792503195.9, by: { input: { to: "unknown" } } },
      { epoch: 3, at: 1792503196.2, by: { windows: { app: "com.apple.Safari", appeared: true } } },
    ]);
    expect(desk.log).toEqual([]);
  });

  it("an older driver without epoch_reason: the stale result is the same, the event has no epoch_reason", async () => {
    const { r1, r3, acts } = await run(false);
    expect([r1.status, r3.status]).toEqual(["stale", "stale"]);
    expect(acts.every((a) => !("epoch_reason" in a))).toBe(true);
  });
});
