/**
 * A window any action made is the task's (docs/0.5-decisions.md「动作新建的窗口」). rc.11 run_69ec2a5a: the task
 * clicked 「新建纯文本文稿」 in TextEdit's open panel (a window of the user's), wrote into the new untitled window and
 * saved it — and every step in it asked its own card (4 extra cards), because the window counted as the user's.
 * The simulated computer reproduces the flow; a wrapped driver makes the proofs that must not be taken.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import { Executor } from "../src/executor/executor.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { SimComputer } from "../src/executor/sim.js";
import { Workspace } from "../src/registry/workspace.js";
import { fileRegistry } from "../src/registry/fs.js";
import { Gateway } from "../src/gateway/index.js";
import { Judge, OUTGOING_QUESTION } from "../src/executor/judge.js";
import type { Action, ActResult, WindowInfo } from "../src/executor/types.js";

const TE = "com.apple.TextEdit";
const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;

async function desk(opts: { judge?: Judge } = {}) {
  const root = fs.mkdtempSync("/private/tmp/created-window-");
  const sim = new SimComputer(root);
  const panel = sim.addEditor("文本编辑", null, { newWindow: true, bundle: TE });        // the open panel: the user's
  const app = ConsentSigner.fresh();
  const events: { k: string; b: Record<string, unknown> }[] = [];
  const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, files: { workspace: new Workspace(root), registry: fileRegistry() }, onEvent: (k, b) => events.push({ k, b }), ...(opts.judge ? { judge: opts.judge, raw: "在文本编辑里新建一个文档，写上「你好 DeskMind」，保存为 hello.txt 放到任务目录" } : {}) });
  await ex.begin();
  await ex.plan({ steps: [] });
  const clickNew = async () => {
    const o = await ex.observe(panel.id);
    return ex.act({ action: { kind: "click", window: panel.id, target: `${panel.id}:0:new_window_doc` }, epoch: o.epoch, consent: app.forObject(`window:${panel.id}`, "modify_user", "t1") });
  };
  return { root, sim, panel, app, ex, events, clickNew };
}

/** The steps the rc.11 run took in the new window: the text, the save sheet's name and place, save. */
async function writeAndSave(ex: Executor, win: string) {
  const out: ActResult[] = [];
  const step = async (a: Action) => { const o = await ex.observe(win); const r = await ex.act({ action: a, epoch: o.epoch }); out.push(r); return r; };
  const el = (key: string) => `${win}:0:${key}`;
  await step({ kind: "set_value", window: win, target: el("textarea"), value: "你好 DeskMind" });
  await step({ kind: "click", window: win, target: el("menu_saveas") });
  await step({ kind: "set_value", window: win, target: el("sheet_name"), value: "hello.txt" });
  await step({ kind: "select", window: win, target: el("sheet_folder"), option: "." });
  await step({ kind: "click", window: win, target: el("sheet_save") });
  return out;
}

describe("a window an action made is the task's", () => {
  it("rc.11's flow: 「新建」 in the user's panel, then text and save in the new window — no card for any step in it", async () => {
    const { root, sim, ex, events, clickNew } = await desk();
    const made = await clickNew();
    expect(made).toMatchObject({ status: "ok", consequence: "modify_user", created_window: "editor-2" });
    expect(events.find((e) => e.k === "executor.window_created")?.b).toMatchObject({ id: "editor-2", by: "click" });
    const o = await ex.observe("editor-2");
    expect([o.window.owner, ex.ledger.ownerOf("window:editor-2")]).toEqual(["task", "task"]);
    const steps = await writeAndSave(ex, "editor-2");
    expect(steps.map((r) => [r.status, r.consequence])).toEqual(Array(5).fill(["ok", "create"]));
    expect(steps.at(-1)!.files).toEqual(["hello.txt"]);
    expect(fs.readFileSync(`${root}/hello.txt`, "utf-8")).toBe("你好 DeskMind");
    // the receipts and the run's changes say what the task made
    expect(ex.receipts.filter((r) => r.result.created_window).map((r) => r.result.created_window)).toEqual(["editor-2"]);
    expect(ex.changes()).toMatchObject({ created: ["hello.txt"], created_windows: ["editor-2"] });
    expect(sim.state("editor-1").doc).toBeNull();                     // the user's panel is as it was
  });

  it("a window seen before in the task is not claimed, whatever the driver says: steps in it ask", async () => {
    const { sim, panel, ex, events, clickNew } = await desk();
    // the user's own empty untitled window, on screen at begin, hidden since; the click brings it back
    const theirs = sim.addEditor("文本编辑", { title: "未命名-1", text: "", path: null }, { bundle: TE });
    await ex.snapshot();
    sim.wins = sim.wins.filter((w) => w !== theirs);
    const perform = sim.perform.bind(sim);
    sim.perform = (a: Action) => {
      if (a.kind === "click" && "target" in a && a.target.endsWith("new_window_doc")) {
        sim.wins.push(theirs);
        return { status: "ok", window: panel.id, new_window: sim.snapshot().windows.find((w) => w.id === theirs.id)!, files: [] };
      }
      return perform(a);
    };
    const r = await clickNew();
    expect(r.status).toBe("ok");
    expect(r.created_window).toBeUndefined();
    expect(ex.ledger.ownerOf(`window:${theirs.id}`)).toBe("user");
    expect(events.find((e) => e.k === "executor.window_not_created")?.b).toMatchObject({ id: theirs.id, why: "seen before in this task" });
    const o = await ex.observe(theirs.id);
    const w = await ex.act({ action: { kind: "set_value", window: theirs.id, target: `${theirs.id}:0:textarea`, value: "x" }, epoch: o.epoch });
    expect([w.status, w.consequence]).toEqual(["needs_consent", "modify_user"]);
    expect(ex.changes().created_windows).toEqual([]);
  });

  it("a proof on a window of another app is not taken", async () => {
    const { sim, panel, ex, events, clickNew } = await desk();
    const perform = sim.perform.bind(sim);
    let other: WindowInfo | undefined;
    sim.perform = (a: Action) => {
      if (a.kind === "click" && "target" in a && a.target.endsWith("new_window_doc")) {
        const w = sim.addEditor("备忘录", { title: "未命名", text: "", path: null }, { bundle: "com.apple.Notes" });
        other = sim.snapshot().windows.find((x) => x.id === w.id)!;
        return { status: "ok", window: panel.id, new_window: other, files: [] };
      }
      return perform(a);
    };
    const r = await clickNew();
    expect(r.created_window).toBeUndefined();
    expect(ex.ledger.ownerOf(`window:${other!.id}`)).toBe("user");
    expect(events.find((e) => e.k === "executor.window_not_created")?.b).toMatchObject({ id: other!.id, why: "a window of another app than the one acted in" });
  });

  it("without a bundle on either side, the app's name is what tells the app", async () => {
    const { sim, panel, ex, clickNew } = await desk();
    const perform = sim.perform.bind(sim);
    sim.perform = (a: Action) => {
      if (a.kind === "click" && "target" in a && a.target.endsWith("new_window_doc")) {
        const w = sim.addEditor("另一个编辑器", { title: "未命名", text: "", path: null });
        const { bundle: _b, ...info } = sim.snapshot().windows.find((x) => x.id === w.id)!;
        return { status: "ok", window: panel.id, new_window: info, files: [] };
      }
      return perform(a);
    };
    const r = await clickNew();
    expect(r.created_window).toBeUndefined();
  });

  it("the driver's word on what appeared and was not claimed goes to the trace and credits nothing", async () => {
    const { sim, panel, ex, events, clickNew } = await desk();
    const perform = sim.perform.bind(sim);
    let quoted = "";
    sim.perform = (a: Action) => {
      if (a.kind === "click" && "target" in a && a.target.endsWith("new_window_doc")) {
        const w = sim.addEditor("文本编辑", { title: "回复", text: "> 原邮件", path: null }, { bundle: TE });
        quoted = w.id;
        return { status: "ok", window: panel.id, appeared: [{ id: w.id, why: "it holds content" }], files: [] };
      }
      return perform(a);
    };
    const r = await clickNew();
    expect(r.created_window).toBeUndefined();
    expect(ex.ledger.ownerOf(`window:${quoted}`)).toBe("user");
    expect(events.find((e) => e.k === "executor.window_appeared")?.b).toEqual({ windows: [{ id: quoted, why: "it holds content" }] });
  });

  it("sending from a window the task made is still the outgoing question's: the judge says it sends, the user is asked", async () => {
    let sends = false;
    const gw = new Gateway(table);
    gw.script = Array(80).fill((_r: string, _s: string, u: string) => (u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: sends ? "sends" : "stays" } : { choice: "matches" }));
    const { ex, clickNew } = await desk({ judge: new Judge([{ name: "frontier", gateway: gw }]) });
    expect((await clickNew()).created_window).toBe("editor-2");
    const o = await ex.observe("editor-2");
    const typed = await ex.act({ action: { kind: "set_value", window: "editor-2", target: "editor-2:0:textarea", value: "你好" }, epoch: o.epoch });
    expect([typed.status, typed.consequence]).toEqual(["ok", "create"]);
    sends = true;                                                       // this click, the judge says, sends it out
    const o2 = await ex.observe("editor-2");
    const r = await ex.act({ action: { kind: "click", window: "editor-2", target: "editor-2:0:menu_save" }, epoch: o2.epoch });
    expect([r.status, r.consequence]).toEqual(["needs_consent", "external"]);
  });
});
