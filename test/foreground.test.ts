/**
 * rc.10: the foreground route is allowed per step by the executor (hands#54 `foreground_ok`), only for the task's own
 * window or a window the user consented to; what the user reads names apps by hands' `app_name`; the skills filter
 * takes its apps from the computer when the request names none.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor, describeAction } from "../src/executor/executor.js";
import type { Action, Driver, Element, Snapshot, WindowInfo } from "../src/executor/types.js";
import { skillsFor } from "../src/cli/app.js";
import { SkillStore, type Skill } from "../src/skills/agentskills.js";
import { Workspace, build } from "../src/registry/workspace.js";

/** A desk that records what perform was given, the options included. */
class Desk implements Driver {
  epoch = 1;
  performed: { action: Action; opts?: { foreground_ok?: boolean } }[] = [];
  opens: WindowInfo | null = null;
  constructor(public wins: { info: WindowInfo; elements: Element[] }[]) {}
  snapshot(): Snapshot { return { epoch: this.epoch, locked: false, front_app: "DeskMind", windows: this.wins.map((w) => w.info) }; }
  observe(id: string) { const w = this.wins.find((x) => x.info.id === id)!; return { epoch: this.epoch, window: w.info, modal: null, elements: w.elements, text: "" }; }
  perform(action: Action, opts?: { foreground_ok?: boolean }) {
    this.performed.push({ action, ...(opts ? { opts } : {}) }); this.epoch += 1;
    if (action.kind === "open_window" && this.opens) { this.wins.push({ info: this.opens, elements: [{ id: "gen:搜索框", role: "textField", label: "搜索框", actions: ["set_value"] }] }); return { status: "ok" as const, window: this.opens.id, new_window: this.opens }; }
    return { status: "ok" as const, window: "window" in action ? action.window : undefined };
  }
}
const music = (id: string): WindowInfo => ({ id, app: "com.netease.163music", app_name: "网易云音乐", bundle: "com.netease.163music", title: "" });
const els: Element[] = [
  { id: "gen:搜索框", role: "textField", label: "搜索框", actions: ["set_value"] },
  { id: "ocr:1", role: "listitem", label: "发送", actions: ["click"] },
  { id: "ocr:2", role: "listitem", label: "宝贝", actions: ["click", "double_click"] },
];

async function setup(wins: { info: WindowInfo; elements: Element[] }[], opens?: WindowInfo) {
  const desk = new Desk(wins); if (opens) desk.opens = opens;
  const app = ConsentSigner.fresh(), events: { k: string; b: Record<string, unknown> }[] = [];
  const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, onEvent: (k, b) => events.push({ k, b }) });
  await ex.begin(); await ex.plan({ steps: [] });
  return { desk, app, ex, events };
}
const lastAct = (events: { k: string; b: Record<string, unknown> }[]) => [...events].reverse().find((e) => e.k === "executor.act")!.b;

describe("foreground_ok (hands#54)", () => {
  it("the task's own window: set on the step the driver performs, and in the trace", async () => {
    const { desk, ex, events } = await setup([], music("com.netease.163music#2"));
    await ex.act({ action: { kind: "open_window", app: "网易云音乐" }, epoch: ex.currentEpoch });
    const o = await ex.observe("com.netease.163music#2");
    expect((await ex.act({ action: { kind: "set_value", window: "com.netease.163music#2", target: "gen:搜索框", value: "宝贝 安溥" }, epoch: o.epoch })).status).toBe("ok");
    expect(desk.performed.at(-1)).toEqual({ action: { kind: "set_value", window: "com.netease.163music#2", target: "gen:搜索框", value: "宝贝 安溥" }, opts: { foreground_ok: true } });
    expect(lastAct(events).foreground_ok).toBe(true);
  });

  it("the user's window with the plan's object token for it: set", async () => {
    const { desk, app, ex } = await setup([{ info: music("com.netease.163music#1"), elements: els }]);
    const o = await ex.observe("com.netease.163music#1");
    const r = await ex.act({ action: { kind: "double_click", window: "com.netease.163music#1", target: "ocr:2" }, epoch: o.epoch, consent: app.forObject("window:com.netease.163music#1", "modify_user", "t1") });
    expect(r.status).toBe("ok");
    expect(desk.performed.at(-1)!.opts).toEqual({ foreground_ok: true });
  });

  it("the user's window without consent: a look goes ahead without it; a change asks and does nothing; a token for another window does not count", async () => {
    const { desk, app, ex, events } = await setup([{ info: music("com.netease.163music#1"), elements: els }, { info: music("com.netease.163music#9"), elements: els }]);
    const o = await ex.observe("com.netease.163music#1");
    expect((await ex.act({ action: { kind: "scroll", window: "com.netease.163music#1", dy: 3 }, epoch: o.epoch })).status).toBe("ok");
    expect(desk.performed.at(-1)!.opts).toBeUndefined();
    expect(lastAct(events).foreground_ok).toBeUndefined();
    const n = desk.performed.length;
    const o2 = await ex.observe("com.netease.163music#1");
    expect((await ex.act({ action: { kind: "double_click", window: "com.netease.163music#1", target: "ocr:2" }, epoch: o2.epoch })).status).toBe("needs_consent");
    expect(desk.performed.length).toBe(n);
    // a scroll carrying a valid token for the other window: still no foreground
    const o3 = await ex.observe("com.netease.163music#1");
    await ex.act({ action: { kind: "scroll", window: "com.netease.163music#1", dy: 3 }, epoch: o3.epoch, consent: app.forObject("window:com.netease.163music#9", "modify_user", "t1") });
    expect(desk.performed.at(-1)!.opts).toBeUndefined();
    // a forged object token for this window: not verified, no foreground
    const o4 = await ex.observe("com.netease.163music#1");
    await ex.act({ action: { kind: "scroll", window: "com.netease.163music#1", dy: 3 }, epoch: o4.epoch, consent: { ...app.forObject("window:com.netease.163music#1", "modify_user", "t1"), sig: Buffer.from("nope").toString("base64") } });
    expect(desk.performed.at(-1)!.opts).toBeUndefined();
  });

  it("a send the user consented to on its own card: set", async () => {
    const { desk, app, ex } = await setup([{ info: music("com.netease.163music#1"), elements: els }]);
    const o = await ex.observe("com.netease.163music#1");
    const send: Action = { kind: "click", window: "com.netease.163music#1", target: "ocr:1" };
    const r = await ex.act({ action: send, epoch: o.epoch, consequence: "external" });
    expect(r.status).toBe("needs_consent");
    expect((await ex.act({ action: send, epoch: o.epoch, consequence: "external", consent: app.forAction(r.challenge!) })).status).toBe("ok");
    expect(desk.performed.at(-1)).toEqual({ action: send, opts: { foreground_ok: true } });
  });

  it("the hands driver puts it inside the action dict, as hands#54 reads it", async () => {
    const { HandsDriver } = await import("../src/executor/hands.js");
    const d = new HandsDriver() as unknown as { begun: boolean; call: (op: string, body: Record<string, unknown>) => Promise<unknown>; perform: Driver["perform"] };
    const sent: Record<string, unknown>[] = [];
    d.begun = true; d.call = async (_op, body) => { sent.push(body); return { status: "ok" }; };
    await d.perform({ kind: "click", window: "w", target: "b" }, { foreground_ok: true });
    await d.perform({ kind: "click", window: "w", target: "b" });
    expect(sent).toEqual([{ action: { kind: "click", window: "w", target: "b", foreground_ok: true } }, { action: { kind: "click", window: "w", target: "b" } }]);
  });
});

describe("app_name for what the user reads", () => {
  it("the consent card names the app by hands' app_name; the bundle id when it is missing", async () => {
    const o = { epoch: 1, window: music("com.netease.163music#1"), modal: null, elements: els };
    expect(describeAction({ kind: "double_click", window: "com.netease.163music#1", target: "ocr:2" }, o, "modify_user")).toContain("网易云音乐「」");
    const { app_name: _a, ...bare } = o.window;
    expect(describeAction({ kind: "double_click", window: "com.netease.163music#1", target: "ocr:2" }, { ...o, window: bare }, "modify_user")).toContain("com.netease.163music「」");
  });
});

describe("app_name on the plan card", () => {
  it("an untitled window of the user's music app is 「网易云音乐 的主窗口」, and the foreground note names it so", async () => {
    const { Gateway } = await import("../src/gateway/index.js");
    const { FrontierRuntime } = await import("../src/runtime/loop.js");
    const { scriptedStream } = await import("../src/runtime/scripted.js");
    const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
    const desk = new Desk([{ info: music("com.netease.163music#1"), elements: els }]);
    const snap = desk.snapshot.bind(desk);
    desk.snapshot = () => ({ ...snap(), needs_foreground: ["com.netease.163music"] });
    const app = ConsentSigner.fresh();
    const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey });
    const gw = new Gateway(table); gw.script = Array(10).fill(() => ({ choice: "pass", reason: "ok" }));
    const cards: { text: string }[] = [];
    const model = { model: { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as any };
    const steps: any[] = [{ calls: [{ name: "plan", args: { steps: [{ purpose: "搜索并播放", objects: ["窗口 com.netease.163music#1"], consequence: "create" }] } }] }, { calls: [{ name: "finish", args: { outcome: "done", summary: "x" } }] }];
    const rt = new FrontierRuntime({ task: "t1", raw: "打开网易云播放安溥的宝贝", executor: ex, signer: app, user: { ask: (c: any) => { cards.push(c); return { option: c.options.findIndex((o: any) => o.kind === "approve") }; } }, gateway: gw, model: { ...model, streamFn: scriptedStream(steps) } });
    await rt.run();
    expect(cards[0]!.text).toContain("1. 搜索并播放（网易云音乐 的主窗口）——改你的东西");
    expect(cards[0]!.text).toContain("网易云音乐 只能在前台操作");
    expect(cards[0]!.text).not.toContain("com.netease");
  });
});

describe("skills by the computer's apps when the request names none", () => {
  it("a skill scoped to the app on screen is kept; one scoped to another app is not", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skills-"));
    const store = new SkillStore(dir);
    const mk = (name: string, apps: string[]): Skill => ({ name, description: name, meta: { source: "taught", status: "admitted", version: 1, scope: { apps, objects: [], family: "" }, effects: [] }, body: "x", confirmed: [], counter: [] });
    store.write(mk("play-on-netease", ["com.netease.163music"]));
    store.write(mk("tidy-finder", ["Finder"]));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ws-")); build(root, { "a.txt": "x" });
    const ws = new Workspace(root);
    const snap: Snapshot = { epoch: 1, locked: false, front_app: "DeskMind", windows: [music("com.netease.163music#1")] };
    const names = (s: ReturnType<typeof skillsFor>) => s.candidates("打开网易云播放安溥的宝贝").map((c) => c.name);
    expect(names(skillsFor({ raw: "打开网易云播放安溥的宝贝" }, ws, () => snap, [dir]))).toEqual(["play-on-netease"]);
    // the request's apps, when it has them, are the facts
    expect(names(skillsFor({ raw: "x", apps: ["Finder"] }, ws, () => snap, [dir]))).toEqual(["tidy-finder"]);
    // before begin (no snapshot yet): nothing to go on beyond the folder
    expect(names(skillsFor({ raw: "x" }, ws, () => null, [dir])).sort()).toEqual(["play-on-netease", "tidy-finder"]);
  });
});
