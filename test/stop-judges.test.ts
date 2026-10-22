/**
 * A stop is the last thing a judge hears: every judge call of the executor checks the stop right before it goes out,
 * and the stop aborts one in flight. After the app's stop (a Stop, a card's timeout, the session turning the model off)
 * the step in progress sends nothing more — not the user's words, not a window's text, not what would go out — to any
 * model. Fake drivers, judges over fake gateways that count their calls: no model is called.
 */
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/index.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { ExecutorService } from "../src/executor/service.js";
import { INTENT_QUESTION, Judge, OUTGOING_QUESTION, type JudgeTier } from "../src/executor/judge.js";
import type { Action, Driver, Element, WindowInfo } from "../src/executor/types.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
const isOutgoing = (u: string) => u.includes(OUTGOING_QUESTION.slice(0, 12));
const isIntent = (u: string) => u.includes(INTENT_QUESTION.slice(0, 12));

interface FakeWin { info: WindowInfo; elements: Element[]; text: string }
class FakeDesk implements Driver {
  epoch = 1;
  log: Action[] = [];
  constructor(public wins: FakeWin[]) {}
  snapshot() { return { epoch: this.epoch, locked: false, front_app: this.wins[0]?.info.app ?? "", windows: this.wins.map((w) => w.info) }; }
  observe(id: string) { const w = this.wins.find((x) => x.info.id === id)!; return { epoch: this.epoch, window: w.info, modal: null, elements: w.elements, text: w.text }; }
  perform(a: Action) { this.log.push(a); this.epoch += 1; return { status: "ok" as const, window: "window" in a ? a.window : undefined }; }
}
const chat = (): FakeWin => ({
  info: { id: "chat", app: "聊天", title: "张三" },
  elements: [
    { id: "ocr:0", role: "listitem", label: "张三：明天开会吗？", actions: ["click"] },
    { id: "ocr:1", role: "listitem", label: "输入消息…", actions: ["click", "type"] },
    { id: "ocr:2", role: "listitem", label: "发送", actions: ["click"] },
  ],
  text: "张三：明天开会吗？\n输入消息…\n发送",
});

/** A gateway that counts every question and answers each with `answer(prompt)` — or, for `hang`, keeps the question
 *  open until its signal fires (a call in flight); it records whether that signal fired. */
function countingGateway(answer: (u: string) => unknown, o: { hang?: (u: string) => boolean } = {}) {
  const asked: string[] = [];
  const aborted: boolean[] = [];
  const gw = {
    ask: (_role: string, _sys: string, user: string, _schema: unknown, _run = "", signal?: AbortSignal) => {
      asked.push(user);
      if (o.hang?.(user)) return new Promise((res) => {
        const go = () => { aborted.push(true); res({ outcome: "error", error: "aborted", data: null }); };
        if (signal?.aborted) go(); else signal?.addEventListener("abort", go, { once: true });
      });
      return Promise.resolve({ outcome: "answered", error: "", data: answer(user) });
    },
  };
  return { gw: gw as unknown as Gateway, asked, aborted };
}

async function setup(judge: Judge, raw = "回张三：明天见") {
  const desk = new FakeDesk([chat()]), app = ConsentSigner.fresh();
  const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, judge, raw });
  await ex.begin();
  await ex.plan({ steps: [] });
  const mine = app.forObject("window:chat", "modify_user", "t1");
  let o = await ex.observe("chat");
  expect((await ex.act({ action: { kind: "type", window: "chat", target: "ocr:1", text: "明天见" }, epoch: o.epoch, consent: mine })).status).toBe("ok");
  o = await ex.observe("chat");
  return { desk, ex, app, mine, epoch: o.epoch };
}
const RETURN: Action = { kind: "key", window: "chat", chord: "return" };
/** Fails instead of hanging: a call that is never aborted would keep the step waiting. */
const within = <T>(p: Promise<T>, ms = 3000) => Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("the step is still waiting on a judge after the stop")), ms))]);

describe("a stop mid-step: no judge call after it", () => {
  it("the stop comes while the send judge answers: the intent judge is never asked, the step ends stopped, nothing is pressed", async () => {
    let ex!: Executor;
    const { gw, asked } = countingGateway((u) => { if (isOutgoing(u)) { ex.stop(); return { choice: "sends", reason: "回车就是发出去" }; } return { choice: "matches" }; });
    const s = await setup(new Judge([{ name: "frontier", gateway: gw }]));
    ex = s.ex;
    asked.splice(0);                                                  // (the typing before asked the intent judge)
    const r = await s.ex.act({ action: RETURN, epoch: s.epoch, consent: s.mine });
    expect(r.status).toBe("stopped");
    expect(asked.filter(isOutgoing)).toHaveLength(1);
    expect(asked.filter(isIntent)).toHaveLength(0);
    expect(asked).toHaveLength(1);
    expect(s.desk.log.filter((a) => a.kind === "key")).toEqual([]);
  });

  it("the stop aborts a judge call in flight; no tier above it is asked", async () => {
    const low = countingGateway(() => ({ choice: "stays", scores: { stays: 0.5 } }), { hang: isOutgoing });
    const top = countingGateway(() => ({ choice: "sends" }));
    const tiers: JudgeTier[] = [{ name: "brain", gateway: low.gw, floor: 0.9, local: true }, { name: "frontier", gateway: top.gw }];
    const s = await setup(new Judge(tiers));
    low.asked.splice(0); top.asked.splice(0);                         // (the typing before asked the intent judge)
    const step = s.ex.act({ action: RETURN, epoch: s.epoch, consent: s.mine });
    await new Promise((r) => setTimeout(r, 20));
    expect(low.asked.filter(isOutgoing)).toHaveLength(1);
    s.ex.stop();
    const r = await within(step);
    expect(r.status).toBe("stopped");
    expect(low.aborted).toEqual([true]);
    expect([low.asked.length, top.asked.length]).toEqual([1, 0]);
  });

  it("the race: the top tier's call started beside the lower one is aborted by the stop too", async () => {
    const low = countingGateway(() => ({ choice: "stays" }), { hang: () => true });
    const top = countingGateway(() => ({ choice: "sends" }), { hang: () => true });
    const judge = new Judge([{ name: "brain", gateway: low.gw, floor: 0.9 }, { name: "frontier", gateway: top.gw }], { race: true });
    const stop = new AbortController();
    const a = judge.choose(OUTGOING_QUESTION, { x: 1 }, [{ id: "sends", text: "会" }, { id: "stays", text: "不会" }], undefined, { signal: stop.signal });
    await new Promise((r) => setTimeout(r, 10));
    stop.abort();
    expect(await within(a)).toBeNull();
    expect([low.aborted, top.aborted]).toEqual([[true], [true]]);
    // nothing was kept: the same question without a stop is asked again
    const again = countingGateway(() => ({ choice: "sends" }));
    const j2 = new Judge([{ name: "frontier", gateway: again.gw }]);
    const st = new AbortController(); st.abort();
    expect(await j2.choose(OUTGOING_QUESTION, { x: 1 }, [{ id: "sends", text: "会" }, { id: "stays", text: "不会" }], undefined, { signal: st.signal })).toBeNull();
    expect(again.asked).toHaveLength(0);
  });

  it("after the stop, the plan's evidence judge and the finish verdict's judge are not asked", async () => {
    const { gw, asked } = countingGateway(() => ({ choice: "r0" }));
    const desk = new FakeDesk([chat()]), app = ConsentSigner.fresh();
    const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, judge: new Judge([{ name: "frontier", gateway: gw }]), raw: "回那个人" });
    await ex.begin();
    ex.stop();
    const v = await ex.plan({ steps: [], readings: [{ point: "回谁", reading: "张三", alternatives: ["李四"], evidence: ["聊天窗口标题是张三"] }] });
    expect(v.accepted).toBe(false);
    expect((await ex.verdict("回好了")).verdict).toBe("unknown");
    expect(asked).toHaveLength(0);
  });

  it("a file action: the stop comes while the intent judge answers: the step ends stopped, no consent card is asked for, nothing written", async () => {
    const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
    const { Workspace, build } = await import("../src/registry/workspace.js");
    const { fileRegistry } = await import("../src/registry/fs.js");
    const { SimComputer } = await import("../src/executor/sim.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stop-file-"));
    build(root, { "todo.txt": "交房租\n" });
    let ex!: Executor;
    const { gw, asked } = countingGateway((u) => { if (isIntent(u)) ex.stop(); return { choice: "matches" }; });
    const app = ConsentSigner.fresh(), events: string[] = [];
    ex = new Executor(new SimComputer(root), { task: "t1", publicKey: app.publicKey, files: { workspace: new Workspace(root), registry: fileRegistry() }, judge: new Judge([{ name: "frontier", gateway: gw }]), raw: "在 todo.txt 末尾加一行 买牛奶", onEvent: (k) => events.push(k) });
    await ex.begin();
    await ex.plan({ steps: [] });
    const r = await ex.act({ action: { kind: "file", capability: "fs.append_line", args: { target: "todo.txt", line: "买牛奶" } }, epoch: ex.currentEpoch });
    expect(r.status).toBe("stopped");
    expect(r.challenge).toBeUndefined();
    expect(events).not.toContain("executor.consent_needed");
    expect(asked.filter(isIntent)).toHaveLength(1);
    expect(fs.readFileSync(path.join(root, "todo.txt"), "utf-8")).toBe("交房租\n");
  });

  it("the port: classify after the stop is refused, no judge asked", async () => {
    const { gw, asked } = countingGateway(() => ({ choice: "sends" }));
    const desk = new FakeDesk([chat()]), signer = ConsentSigner.fresh();
    const ex = new Executor(desk, { task: "t1", publicKey: signer.publicKey, judge: new Judge([{ name: "frontier", gateway: gw }]), raw: "回张三" });
    const svc = new ExecutorService({ task: "t1", raw: "回张三", executor: ex, signer, user: { ask: () => null }, gateway: new Gateway(table) });
    await svc.port.begin();
    const o = await svc.port.observe("chat");
    svc.stop("stopped by the app", "stopped", "user_stopped");
    await expect(svc.port.classify({ action: RETURN, epoch: o.epoch })).rejects.toThrow(/任务已经结束/);
    expect(asked).toHaveLength(0);
  });
});
