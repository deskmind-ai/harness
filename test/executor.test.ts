/**
 * The execution layer's three lines, with no model at all: ownership from structure, the consequence floor, consent
 * tokens (signed by an app, verified here, bound to the action, spent once), the stop switch, the lock screen and
 * stale observations. A runtime above this layer cannot get an unconsented change through, whatever it is.
 */
import { describe, expect, it } from "vitest";
import { ConsentSigner, digestOf } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import type { Action } from "../src/executor/types.js";

function mailSim() {
  const sim = new SimComputer();
  const w = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: ["m2"], inbox: [
    { id: "m1", from: "林晓", subject: "Q3 预算", body: ["你好，关于Q3 预算，", "会议时间：14:00", "谢谢"], time: "14:00" },
    { id: "m2", from: "林晓", subject: "周会纪要", body: ["会议时间：10:00"], time: "10:00" },
    { id: "m3", from: "苏然", subject: "Q3 预算", body: ["会议时间：09:30"], time: "09:30" },
  ] });
  return { sim, w };
}

function setup(now?: () => number) {
  const app = ConsentSigner.fresh(now);
  const { sim, w } = mailSim();
  const events: string[] = [];
  const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, now, onEvent: (k) => events.push(k) });
  return { app, sim, w, ex, events };
}
/** begin, and open the start gate with an empty plan (the gate has tests of its own below). */
const started = async (ex: Executor) => { const s = await ex.begin(); await ex.plan({ steps: [] }); return s; };

const find = async (ex: Executor, win: string, label: string) => { const o = await ex.observe(win); const e = o.elements.find((x) => x.label.includes(label))!; return { o, e }; };
const click = async (ex: Executor, win: string, label: string, extra: Record<string, unknown> = {}) => { const { o, e } = await find(ex, win, label); return ex.act({ action: { kind: "click", window: win, target: e.id }, epoch: o.epoch, ...extra }); };

describe("executor: ownership and the consequence floor", () => {
  it("windows on screen at begin are the user's; a window the task opens is the task's", async () => {
    const { ex, w } = setup();
    const s = await ex.begin();
    expect(s.windows.find((x) => x.id === w.id)?.owner).toBe("user");
    const r = await ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: s.epoch });
    expect(r.status).toBe("ok");
    expect(r.consequence).toBe("create");
    const s2 = await ex.snapshot();
    const mine = s2.windows.find((x) => x.app === "编辑器")!;
    expect(mine.owner).toBe("task");
    // acting in the task's own window is "create"; in the user's it is at least "modify_user"
    const { o, e } = await find(ex, mine.id, "新建文档");
    expect(ex.preview({ action: { kind: "click", window: mine.id, target: e.id }, epoch: o.epoch })).toMatchObject({ consequence: "create", needs_consent: false });
    const { o: o2, e: e2 } = await find(ex, w.id, "林晓 · Q3 预算");
    expect(ex.preview({ action: { kind: "click", window: w.id, target: e2.id }, epoch: o2.epoch })).toMatchObject({ consequence: "modify_user", needs_consent: true });
  });

  it("a model may raise the class, never lower it", async () => {
    const { ex, w } = setup();
    await ex.begin();
    const { o, e } = await find(ex, w.id, "林晓 · Q3 预算");
    expect(ex.preview({ action: { kind: "click", window: w.id, target: e.id }, epoch: o.epoch, consequence: "read" }).consequence).toBe("modify_user");
    expect(ex.preview({ action: { kind: "click", window: w.id, target: e.id }, epoch: o.epoch, consequence: "external" }).consequence).toBe("external");
  });

  it("an element marked as sending floors at external, even in the task's own window", async () => {
    const { ex, sim, app } = setup();
    await started(ex);
    // the task's own mail window (the sim lets a test add one after begin)
    const mine = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "a1", from: "顾青", subject: "合同", body: ["x"], time: "10:00" }] });
    ex.ledger.created(`window:${mine.id}`);
    expect((await ex.snapshot()).windows.find((x) => x.id === mine.id)?.owner).toBe("task");
    expect((await click(ex, mine.id, "顾青 · 合同")).status).toBe("ok");
    expect((await click(ex, mine.id, "回复")).status).toBe("ok");
    const { o, e } = await find(ex, mine.id, "回复内容");
    expect((await ex.act({ action: { kind: "set_value", window: mine.id, target: e.id, value: "收到" }, epoch: o.epoch })).status).toBe("ok");
    const { o: o2, e: e2 } = await find(ex, mine.id, "发送");
    const send: Action = { kind: "click", window: mine.id, target: e2.id };
    const r = await ex.act({ action: send, epoch: o2.epoch });
    expect(r.status).toBe("needs_consent");
    expect(r.consequence).toBe("external");
    expect(r.challenge?.text).toContain("发送");
    expect(sim.mailState(mine.id).replies).toEqual([]);
    // the app signs the challenge; the same action with the token goes through; the token is spent
    const token = app.forAction(r.challenge!);
    const ok = await ex.act({ action: send, epoch: r.epoch, consent: token });
    expect(ok.status).toBe("ok");
    expect(sim.mailState(mine.id).replies).toEqual([{ to: "a1", body: "收到" }]);
    const again = await ex.act({ action: send, epoch: ok.epoch, consent: token });
    expect(again.status).not.toBe("ok");
  });
});

describe("executor: consent tokens", () => {
  it("a token for another action, a forged one, an expired one and a lower class are refused", async () => {
    let now = 1_000_000;
    const { ex, w, app, sim } = setup(() => now);
    await started(ex);
    const { o, e } = await find(ex, w.id, "林晓 · Q3 预算");
    const click1: Action = { kind: "click", window: w.id, target: e.id };
    const r = await ex.act({ action: click1, epoch: o.epoch });
    expect(r.status).toBe("needs_consent");
    const other = app.forAction({ ...r.challenge!, digest: digestOf({ kind: "close_window", window: w.id }, `window:${w.id}`, "modify_user") });
    expect((await ex.act({ action: click1, epoch: r.epoch, consent: other })).why).toContain("another action");
    const forged = { ...app.forAction(r.challenge!), sig: Buffer.from("nope").toString("base64") };
    expect((await ex.act({ action: click1, epoch: r.epoch, consent: forged })).why).toContain("signature");
    const stranger = ConsentSigner.fresh().forAction(r.challenge!);
    expect((await ex.act({ action: click1, epoch: r.epoch, consent: stranger })).why).toContain("signature");
    const expired = app.forAction(r.challenge!, 10);
    now += 11;
    expect((await ex.act({ action: click1, epoch: r.epoch, consent: expired })).why).toContain("expired");
    const low = app.forObject(`window:${w.id}`, "create", "t1");
    expect((await ex.act({ action: click1, epoch: r.epoch, consent: low })).why).toContain("covers create");
    expect(sim.mailState(w.id).selected).toBeNull();
  });

  it("an object-scoped token covers every action on that object in this task, not in another", async () => {
    const { ex, w, app, sim } = setup();
    await started(ex);
    const token = app.forObject(`window:${w.id}`, "modify_user", "t1");
    expect((await click(ex, w.id, "林晓 · Q3 预算", { consent: token })).status).toBe("ok");
    expect((await click(ex, w.id, "加旗标", { consent: token })).status).toBe("ok");
    expect(sim.mailState(w.id).flagged).toContain("m1");
    // sending is external: the object token (modify_user) does not reach it
    expect((await click(ex, w.id, "回复", { consent: token })).status).toBe("ok");
    expect((await click(ex, w.id, "发送", { consent: token })).status).toBe("needs_consent");
    const otherTask = new Executor(sim, { task: "t2", publicKey: app.publicKey });
    await started(otherTask);
    expect((await click(otherTask, w.id, "取消", { consent: token })).why).toContain("another task");
  });

  it("a rule token is kept and covers later actions matching its pattern", async () => {
    const { ex, w, app, sim } = setup();
    await started(ex);
    const rule = app.forRule("关我的邮件窗口不用问", `window:${w.id}`, "modify_user");
    expect((await ex.act({ action: { kind: "close_window", window: w.id }, epoch: (await ex.snapshot()).epoch, consent: rule })).status).toBe("ok");
    expect(sim.wins.length).toBe(0);
  });
});

describe("executor: stop, lock, stale", () => {
  it("after stop every action is refused; a locked screen is an environment stop; a stale epoch is refused", async () => {
    const { ex, w, sim } = setup();
    const s = await ex.begin();
    const { o } = await find(ex, w.id, "取消旗标");
    sim.lock();
    expect((await ex.act({ action: { kind: "wait", ms: 1 }, epoch: o.epoch })).status).toBe("environment");
    sim.lock(false);
    expect((await ex.act({ action: { kind: "wait", ms: 1 }, epoch: s.epoch })).status).toBe("stale");
    const fresh = await ex.snapshot();
    expect((await ex.act({ action: { kind: "wait", ms: 1 }, epoch: fresh.epoch })).status).toBe("ok");
    ex.stop();
    expect((await ex.act({ action: { kind: "wait", ms: 1 }, epoch: (await ex.snapshot()).epoch })).status).toBe("stopped");
    expect(ex.receipts.map((r) => r.result.status)).toEqual(["environment", "stale", "ok", "stopped"]);
  });

  it("verify hands back the windows the task touched, observed again", async () => {
    const { ex } = setup();
    const s = await ex.begin();
    const r = await ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: s.epoch });
    const mine = r.after!.window.id;
    expect((await click(ex, mine, "新建文档")).status).toBe("ok");
    const v = await ex.verify();
    expect(v.windows.map((x) => x.window.id)).toEqual([mine]);
    expect(v.windows[0]!.elements.some((x) => x.label === "正文")).toBe(true);
    expect(v.receipts.length).toBe(2);
  });
});

describe("executor: files under the same guard", () => {
  const fsSetup = async () => {
    const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
    const { Workspace, build } = await import("../src/registry/workspace.js");
    const { fileRegistry } = await import("../src/registry/fs.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ex-files-"));
    build(root, { "todo.txt": "交房租\n", "other.txt": "x" });
    const ws = new Workspace(root), app = ConsentSigner.fresh(), sim = new SimComputer(root);
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() } });
    const s = await started(ex);
    const file = (capability: string, args: Record<string, string>, consent?: any) => ex.act({ action: { kind: "file", capability, args }, epoch: ex.currentEpoch, consent });
    return { fs, ws, app, ex, file, root, s };
  };

  it("a file another program changed since the task saw it is refused, recorded as an external change, and writable again after a read", async () => {
    const { fs, ws, file, ex, root } = await fsSetup();
    fs.writeFileSync(`${root}/todo.txt`, "交房租\n别人加的一行\n"); ws.invalidate();
    const r = await file("fs.append_line", { target: "todo.txt", line: "买牛奶" });
    expect(r.status).toBe("stale");
    expect(r.why).toContain("todo.txt");
    expect(ex.externalChanges.map((c) => c.path)).toEqual(["todo.txt"]);
    expect(ws.read("todo.txt")).toBe("交房租\n别人加的一行\n");
    // reading it is the observation; the append then goes on top of the other program's line (with consent: the user's file)
    expect((await file("fs.read_text", { target: "todo.txt" })).status).toBe("ok");
    const again = await file("fs.append_line", { target: "todo.txt", line: "买牛奶" });
    expect(again.status).toBe("needs_consent");
    expect(again.consequence).toBe("modify_user");
    const stranger = await file("fs.append_line", { target: "todo.txt", line: "买牛奶" }, ConsentSigner.fresh().forAction(again.challenge!));
    expect(stranger.status).not.toBe("ok");                 // a stranger's signature
  });

  it("creating a new file needs no consent; discarding content the task did not write does, even on a file the task created", async () => {
    const { ws, file, app, fs, root } = await fsSetup();
    expect((await file("fs.create_text", { parent: ".", name: "备忘.txt", text: "买牛奶" })).status).toBe("ok");
    expect(ws.read("备忘.txt")).toBe("买牛奶");
    // the task's own content: replacing it is the task's business
    expect((await file("fs.replace_text", { target: "备忘.txt", text: "买鸡蛋" })).status).toBe("ok");
    // another program rewrote the task's file: the content is not the task's any more, so it is stale first…
    fs.writeFileSync(`${root}/备忘.txt`, "用户改的"); ws.invalidate();
    expect((await file("fs.replace_text", { target: "备忘.txt", text: "x" })).status).toBe("stale");
    await file("fs.read_text", { target: "备忘.txt" });
    // …and, once read, discarding it is modify_user
    const r = await file("fs.replace_text", { target: "备忘.txt", text: "x" });
    expect(r.status).toBe("needs_consent");
    expect(r.why).toBe("no consent");
    const ok = await file("fs.replace_text", { target: "备忘.txt", text: "x" }, app.forAction(r.challenge!));
    expect(ok.status).toBe("ok");
    expect(ws.read("备忘.txt")).toBe("x");
    // trashing a user's file asks too
    expect((await file("fs.trash", { target: "other.txt" })).status).toBe("needs_consent");
  });

  it("a moved user file stays the user's at its new path", async () => {
    const { ws, file, app } = await fsSetup();
    const mv = await file("fs.move", { source: "todo.txt", destination: "moved.txt" });
    expect(mv.status).toBe("needs_consent");
    expect((await file("fs.move", { source: "todo.txt", destination: "moved.txt" }, app.forAction(mv.challenge!))).status).toBe("ok");
    expect(ws.exists("moved.txt")).toBe(true);
    expect((await file("fs.trash", { target: "moved.txt" })).status).toBe("needs_consent");
    expect((await file("fs.read_text", { target: "moved.txt" })).output).toEqual({ text: "交房租\n" });
  });
});

describe("executor: the judge before a consequential action", () => {
  const withJudge = async (answer: (role: string, user: string) => unknown) => {
    const { Gateway } = await import("../src/gateway/index.js");
    const { Judge } = await import("../src/executor/judge.js");
    const gw = new Gateway(Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any);
    gw.script = Array(20).fill((role: string, _s: string, u: string) => answer(role, u));
    const app = ConsentSigner.fresh();
    const { sim, w } = mailSim();
    const events: Record<string, unknown>[] = [];
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, judge: new Judge([{ name: "test", gateway: gw }]), raw: "把林晓那封 Q3 预算的邮件加旗标", onEvent: (k, b) => events.push({ k, ...b }) });
    await started(ex);
    return { ex, sim, w, app, events, gw };
  };

  it("a mismatch is refused with the judge's reason; nothing is performed and no consent is asked", async () => {
    const seen: string[] = [];
    const { ex, sim, w, app, events } = await withJudge((role, u) => { seen.push(u); return { choice: "mismatch", reason: "用户说的是林晓的 Q3 预算，这是苏然的" }; });
    const token = app.forObject(`window:${w.id}`, "modify_user", "t1");
    const r = await click(ex, w.id, "苏然 · Q3 预算", { consent: token });
    expect(r.status).toBe("refused");
    expect(r.why).toContain("苏然");
    expect(sim.mailState(w.id).selected).toBeNull();
    expect(events.some((e) => e.k === "executor.consent_needed")).toBe(false);
    // the judge saw the user's words, the action and the element
    expect(seen[0]).toContain("把林晓那封");
    expect(seen[0]).toContain("苏然 · Q3 预算");
  });

  it("matches goes on to consent as before; the same action is judged once (cache)", async () => {
    let calls = 0;
    const { ex, w, app } = await withJudge(() => { calls += 1; return { choice: "matches" }; });
    const r = await click(ex, w.id, "林晓 · Q3 预算");
    expect(r.status).toBe("needs_consent");
    expect((await click(ex, w.id, "林晓 · Q3 预算", { consent: app.forAction(r.challenge!) })).status).toBe("ok");
    expect(calls).toBe(1);
  });

  it("a judge that cannot answer, or says the evidence is not enough, leaves the decision to the user", async () => {
    const { ex, w } = await withJudge(() => ({ outcome: "error", error: "down" }));
    expect((await click(ex, w.id, "林晓 · Q3 预算")).status).toBe("needs_consent");
    const { ex: ex2, w: w2 } = await withJudge(() => ({ choice: "insufficient", reason: "看不出是哪封" }));
    expect((await click(ex2, w2.id, "林晓 · Q3 预算")).status).toBe("needs_consent");
  });

  it("read-only and task-own actions are never judged", async () => {
    let calls = 0;
    const { ex } = await withJudge(() => { calls += 1; return { choice: "mismatch" }; });
    const r = await ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: (await ex.snapshot()).epoch });
    expect(r.status).toBe("ok");
    expect((await click(ex, r.after!.window.id, "新建文档")).status).toBe("ok");
    expect(calls).toBe(0);
  });
});

describe("judge tiers", () => {
  it("a lower tier approves on its own when confident, never refuses alone; empty scores are no confidence", async () => {
    const { Gateway } = await import("../src/gateway/index.js");
    const { Judge } = await import("../src/executor/judge.js");
    const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
    const low = new Gateway(table), top = new Gateway(table);
    const opts = [{ id: "matches", text: "yes" }, { id: "mismatch", text: "no" }, { id: "insufficient", text: "?" }];
    const judge = () => new Judge([{ name: "low", gateway: low, floor: 0.9 }, { name: "top", gateway: top }]);
    low.script = [() => ({ choice: "matches", scores: { matches: 0.95, mismatch: 0.05 } })];
    top.script = [() => ({ choice: "mismatch" })];
    expect((await judge().choose("q1", {}, opts))?.by).toBe("low");
    low.script = [() => ({ choice: "mismatch", scores: { matches: 0.02, mismatch: 0.98 } })];
    top.script = [() => ({ choice: "matches" })];
    expect(await judge().choose("q2", {}, opts)).toMatchObject({ by: "top", choice: "matches" });
    low.script = [() => ({ choice: "matches", scores: { matches: 0.6, mismatch: 0.4 } })];
    top.script = [() => ({ choice: "insufficient", scores: {} })];
    expect(await judge().choose("q3", {}, opts)).toMatchObject({ by: "top", choice: "insufficient", confidence: undefined });
    // the top tier fails (the service is down): a lower tier's refusal does not become final — null, the user decides
    low.script = [() => ({ choice: "mismatch", scores: { matches: 0, mismatch: 1 } })];
    top.script = [() => ({ outcome: "error", error: "HTTP 503" })];
    expect(await judge().choose("q4", {}, opts)).toBeNull();
  });
});

describe("executor: files an app writes are the task's", () => {
  it("a save through the app's own window is credited to the task; reads are never refused as stale; folders do not count", async () => {
    const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
    const { Workspace, build } = await import("../src/registry/workspace.js");
    const { fileRegistry } = await import("../src/registry/fs.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ex-save-"));
    build(root, { "old.txt": "旧\n" });
    const ws = new Workspace(root), app = ConsentSigner.fresh();
    const sim = new SimComputer(root);
    const events: Record<string, unknown>[] = [];
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() }, onEvent: (k, b) => events.push({ k, ...b }) });
    await started(ex);
    // the task opens its own editor window and saves with cmd+s: the file the app wrote is the task's, not "external"
    const opened = await ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: ex.currentEpoch });
    const win = opened.after!.window.id;
    const w = sim.wins.find((x) => x.id === win)!;
    w.state.doc = { title: "note.txt", text: "你好", path: "note.txt" };
    const saved = await ex.act({ action: { kind: "key", window: win, chord: "cmd+s" }, epoch: ex.currentEpoch });
    expect(saved.status).toBe("ok");
    expect(saved.files).toEqual(["note.txt"]);
    expect(fs.readFileSync(path.join(root, "note.txt"), "utf-8")).toBe("你好");
    expect(ex.changes()).toMatchObject({ created: ["note.txt"], external: [] });
    expect(events.some((e) => e.k === "executor.files_written")).toBe(true);
    // reading it right after is a read, not a stale write
    expect((await ex.act({ action: { kind: "file", capability: "fs.read_text", args: { target: "note.txt" } }, epoch: ex.currentEpoch })).status).toBe("ok");
    // another program changes old.txt: listing the folder and reading the file go ahead (the change is a recorded fact), writing it is refused until read
    build(root, { "old.txt": "别人改的\n" }); ws.invalidate();
    expect((await ex.act({ action: { kind: "file", capability: "fs.list", args: { path: "." } }, epoch: ex.currentEpoch })).status).toBe("ok");
    expect(ex.externalChanges.map((c) => c.path)).toEqual([]);                                    // a folder is not an external change
    build(root, { "old.txt": "别人又改了\n" }); ws.invalidate();
    const r = await ex.act({ action: { kind: "file", capability: "fs.read_text", args: { target: "old.txt" } }, epoch: ex.currentEpoch });
    expect(r.status).toBe("ok");
    expect(ex.externalChanges.map((c) => c.path)).toEqual(["old.txt"]);
    expect(ex.changes().external).toEqual(["old.txt"]);
  });
});

describe("executor: a stop that arrives while an action waits", () => {
  it("a stop during the judge's or the user's wait is seen before the effect: the file is not written", async () => {
    const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
    const { Workspace } = await import("../src/registry/workspace.js");
    const { fileRegistry } = await import("../src/registry/fs.js");
    const { Gateway } = await import("../src/gateway/index.js");
    const { Judge } = await import("../src/executor/judge.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ex-stop-"));
    const { build } = await import("../src/registry/workspace.js");
    build(root, { "todo.txt": "交房租\n" });
    const ws = new Workspace(root), app = ConsentSigner.fresh();
    const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
    const gw = new Gateway(table);
    const ex = new Executor(new SimComputer(root), { task: "t1", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() }, judge: new Judge([{ name: "t", gateway: gw }]), raw: "在 todo.txt 末尾加一行 买牛奶" });
    await started(ex);
    // the judge approves, but the stop switch is thrown while it deliberates (the user's file: the judge is asked)
    gw.script = [() => { ex.stop(); return { choice: "matches" }; }];
    const r = await ex.act({ action: { kind: "file", capability: "fs.append_line", args: { target: "todo.txt", line: "买牛奶" } }, epoch: ex.currentEpoch, consent: app.forObject("path:todo.txt", "modify_user", "t1") });
    expect(r.status).toBe("stopped");
    expect(fs.readFileSync(path.join(root, "todo.txt"), "utf-8")).toBe("交房租\n");
    // the same on the screen: the stop lands during the judge, the click does not happen
    const { ex: ex2, w, app: app2 } = setup();
    const gw2 = new Gateway(table);
    ex2.opts.judge = new Judge([{ name: "t", gateway: gw2 }]); ex2.setRequest("给林晓那封邮件加旗标");
    await started(ex2);
    gw2.script = [() => { ex2.stop(); return { choice: "matches" }; }];
    const c = await click(ex2, w.id, "林晓 · Q3 预算", { consent: app2.forObject(`window:${w.id}`, "modify_user", "t1") });
    expect(c.status).toBe("stopped");
    const o = await ex2.observe(w.id);
    expect(o.elements.find((e) => e.label.includes("林晓 · Q3 预算"))!.focused).not.toBe(true);   // the row was never selected
  });
});

describe("executor: the user's answers reach the judge", () => {
  it("an answer given during the task is in every judge question's context, next to the request", async () => {
    const { Gateway } = await import("../src/gateway/index.js");
    const { Judge } = await import("../src/executor/judge.js");
    const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
    const gw = new Gateway(table);
    const prompts: string[] = [];
    gw.script = Array(6).fill((role: string, _s: string, user: string) => { prompts.push(user); return role === "verify" ? { choice: "pass" } : { choice: "matches" }; });
    const { sim, w } = mailSim();
    const app = ConsentSigner.fresh();
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, judge: new Judge([{ name: "t", gateway: gw }]), raw: "给那封邮件加旗标" });
    await started(ex);
    ex.addAnswer("哪封邮件？", "林晓的 Q3 预算");
    ex.addSkill("flag-budget-mail", "## 怎么做\n预算邮件都加旗标");
    await click(ex, w.id, "林晓 · Q3 预算", { consent: app.forObject(`window:${w.id}`, "modify_user", "t1") });
    await ex.verdict("done");
    expect(prompts.length).toBeGreaterThanOrEqual(2);
    for (const p of prompts) { expect(p).toContain("给那封邮件加旗标"); expect(p).toContain("林晓的 Q3 预算"); expect(p).toContain("预算邮件都加旗标"); }
  });
});

describe("executor: the start gate", () => {
  it("nothing of the user's is touched before a plan; a plan is accepted when its readings are settled", async () => {
    const { ex, w, app } = setup();
    await ex.begin();
    const r = await click(ex, w.id, "林晓 · Q3 预算", { consent: app.forObject(`window:${w.id}`, "modify_user", "t1") });
    expect(r.status).toBe("needs_plan");
    expect((await ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: (await ex.snapshot()).epoch })).status).toBe("ok");   // the task's own things need no plan
    // a reading with alternatives and no evidence (or evidence that is the request's own words) is the user's to settle
    const open = await ex.plan({ steps: [{ purpose: "加旗标", objects: [`window:${w.id}`], consequence: "modify_user" }], readings: [{ point: "那封", reading: "Q3 预算", alternatives: ["周会纪要"], evidence: [] }] });
    expect(open).toMatchObject({ accepted: false });
    expect(ex.hasPlan).toBe(false);
    const settled = await ex.plan({ steps: [{ purpose: "加旗标", objects: [`window:${w.id}`], consequence: "modify_user" }], readings: [{ point: "那封", reading: "Q3 预算", alternatives: [], evidence: ["用户的回答：Q3 预算"] }] });
    expect(settled.accepted).toBe(true);
    expect((await click(ex, w.id, "林晓 · Q3 预算", { consent: app.forObject(`window:${w.id}`, "modify_user", "t1") })).status).toBe("ok");
  });

  it("with a judge, evidence that tells the readings apart settles them; evidence that does not hands them back", async () => {
    const { Gateway } = await import("../src/gateway/index.js");
    const { Judge } = await import("../src/executor/judge.js");
    const gw = new Gateway(Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any);
    const asked: string[] = [];
    gw.script = [(_r: string, _s: string, u: string) => { asked.push(u); return { choice: "r0" }; }, () => ({ choice: "r2" })];
    const app = ConsentSigner.fresh();
    const { sim, w } = mailSim();
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, judge: new Judge([{ name: "t", gateway: gw }]), raw: "给林晓那封邮件加旗标" });
    await ex.begin();
    const reading = { point: "那封", reading: "林晓 · Q3 预算", alternatives: ["林晓 · 周会纪要"], evidence: ["林晓 · Q3 预算", "林晓 · 周会纪要"] };
    expect((await ex.plan({ steps: [], readings: [reading] })).accepted).toBe(true);
    expect(asked[0]).toContain("那封");
    const ex2 = new Executor(sim, { task: "t2", publicKey: app.publicKey, judge: new Judge([{ name: "t", gateway: gw }]), raw: "给林晓那封邮件加旗标" });
    await ex2.begin();
    expect(await ex2.plan({ steps: [], readings: [reading] })).toMatchObject({ accepted: false, open: [reading] });
    void w;
  });
});

describe("executor: the user at the keyboard", () => {
  it("a state-changing action waits for the user to pause, then goes; past the limit it is blocked; a look never waits", async () => {
    const app = ConsentSigner.fresh();
    const { sim, w } = mailSim();
    const events: string[] = [];
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, userWait: { ms: 300, pollMs: 20 }, onEvent: (k) => events.push(k) });
    await started(ex);
    const r = await ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: (await ex.snapshot()).epoch });
    const mine = r.after!.window.id;
    sim.user_active = true;
    setTimeout(() => { sim.user_active = false; }, 80);                   // the user pauses while the executor waits
    expect((await click(ex, mine, "新建文档")).status).toBe("ok");
    expect(events).toContain("executor.user_wait"); expect(events).toContain("executor.user_resumed");
    sim.user_active = true;
    expect((await ex.act({ action: { kind: "wait", ms: 1 }, epoch: (await ex.snapshot()).epoch })).status).toBe("ok");   // read-only: no wait
    const t0 = Date.now();
    const b = await click(ex, mine, "新建文档");
    expect(b.status).toBe("blocked"); expect(Date.now() - t0).toBeGreaterThanOrEqual(280);   // waited the limit, then gave up
    void w;
  });

  it("a URL handed to a browser the user has open is the user's window: plan and consent first", async () => {
    const { ex, sim, app } = setup();
    const b = sim.addBrowser("Safari", [{ title: "首页", url: "https://example.com" }]);
    await ex.begin();
    const pre = ex.preview({ action: { kind: "open_window", app: "Safari", url: "https://music.163.com" }, epoch: ex.currentEpoch });
    expect(pre).toMatchObject({ consequence: "modify_user", object: `window:${b.id}`, needs_consent: true });
    expect((await ex.act({ action: { kind: "open_window", app: "Safari", url: "https://music.163.com" }, epoch: ex.currentEpoch })).status).toBe("needs_plan");
    // no URL, or an app the user does not have open: the task's own window
    expect(ex.preview({ action: { kind: "open_window", app: "Safari" }, epoch: ex.currentEpoch }).consequence).toBe("create");
    expect(ex.preview({ action: { kind: "open_window", app: "编辑器", url: "x" }, epoch: ex.currentEpoch }).consequence).toBe("create");
    void app;
  });
});

describe("executor: undo", () => {
  it("file actions are taken back newest first; a window the task opened is closed; a screen action makes the run irreversible", async () => {
    const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
    const { Workspace, build } = await import("../src/registry/workspace.js");
    const { fileRegistry } = await import("../src/registry/fs.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ex-undo-"));
    build(root, { "todo.txt": "交房租\n" });
    const ws = new Workspace(root), app = ConsentSigner.fresh(), sim = new SimComputer(root);
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() } });
    await started(ex);
    const file = (capability: string, args: Record<string, string>, consent?: any) => ex.act({ action: { kind: "file", capability, args }, epoch: ex.currentEpoch, consent });
    expect((await file("fs.create_text", { parent: ".", name: "备忘.txt", text: "买牛奶" })).status).toBe("ok");
    const tok = app.forObject("path:todo.txt", "modify_user", "t1");
    expect((await file("fs.append_line", { target: "todo.txt", line: "买牛奶" }, tok)).status).toBe("ok");
    const win = await ex.act({ action: { kind: "open_window", app: "编辑器" }, epoch: ex.currentEpoch });
    expect(ex.undoable()).toMatchObject({ reversible: true });
    expect(ex.undoable().steps.map((s) => s.text)).toEqual(["打开 编辑器", expect.stringContaining("追加"), expect.stringContaining("新建")]);
    const u = await ex.undo();
    expect(u).toEqual({ undone: 3, total: 3, refused: null });
    expect(ws.read("todo.txt")).toBe("交房租\n");
    expect(ws.exists("备忘.txt")).toBe(false);
    expect(sim.wins.some((w) => w.id === win.after!.window.id)).toBe(false);
  });

  it("nothing is touched when one step cannot be taken back, or when a file changed since", async () => {
    const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
    const { Workspace, build } = await import("../src/registry/workspace.js");
    const { fileRegistry } = await import("../src/registry/fs.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ex-undo2-"));
    build(root, { "todo.txt": "交房租\n" });
    const ws = new Workspace(root), app = ConsentSigner.fresh(), sim = new SimComputer(root);
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() } });
    await started(ex);
    const file = (capability: string, args: Record<string, string>, consent?: any) => ex.act({ action: { kind: "file", capability, args }, epoch: ex.currentEpoch, consent });
    expect((await file("fs.create_text", { parent: ".", name: "a.txt", text: "1" })).status).toBe("ok");
    // the task's own text replaced: fs.replace_text has no undo, so the run is not reversible as a whole
    expect((await file("fs.replace_text", { target: "a.txt", text: "2" })).status).toBe("ok");
    expect(ex.undoable().reversible).toBe(false);
    expect((await ex.undo()).undone).toBe(0);
    expect(ws.read("a.txt")).toBe("2");
    // a reversible run whose file someone changed since: refused by the capability, nothing else undone either
    const ex2 = new Executor(new SimComputer(root), { task: "t2", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() } });
    await started(ex2);
    const file2 = (capability: string, args: Record<string, string>) => ex2.act({ action: { kind: "file", capability, args }, epoch: ex2.currentEpoch });
    expect((await file2("fs.create_text", { parent: ".", name: "b.txt", text: "1" })).status).toBe("ok");
    fs.writeFileSync(path.join(root, "b.txt"), "someone else"); ws.invalidate();
    const u = await ex2.undo();
    expect(u.undone).toBe(0);
    expect(u.refused).toBeTruthy();
    expect(ws.read("b.txt")).toBe("someone else");
  });
});

describe("executor: the journal and a crash", () => {
  it("an effect without a receipt is found on restart and reconciled from versions, not repeated", async () => {
    const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
    const { Workspace, build } = await import("../src/registry/workspace.js");
    const { fileRegistry } = await import("../src/registry/fs.js");
    const { Crash } = await import("../src/registry/capability.js");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ex-crash-"));
    build(root, { "todo.txt": "交房租\n" });
    const ws = new Workspace(root), app = ConsentSigner.fresh();
    const journal = path.join(root, "..", `journal-${Date.now()}.jsonl`);
    const ex = new Executor(new SimComputer(root), { task: "t1", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() }, journal, crashAfterFirstEffect: true });
    await started(ex);
    await expect(ex.act({ action: { kind: "file", capability: "fs.create_text", args: { parent: ".", name: "备忘.txt", text: "买牛奶" } }, epoch: ex.currentEpoch })).rejects.toBeInstanceOf(Crash);
    expect(ws.read("备忘.txt")).toBe("买牛奶");                                   // the effect happened; the receipt was never written
    const lines = fs.readFileSync(journal, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.kind)).toEqual(["begin", "intent"]);                 // begin: the folder's versions, for a restart to compare against
    // while no process was watching, another program rewrote todo.txt
    build(root, { "todo.txt": "全被改了\n" }); ws.invalidate();
    // the next process: the intent is found, the versions say it happened, and that is told, not redone; the change
    // by someone else is a fact of the task (not its new starting point), the task's own write is not one
    const ex2 = new Executor(new SimComputer(root), { task: "t1", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() }, journal });
    await ex2.begin();
    expect(ex2.recovered).toMatchObject({ finding: "happened", action: { kind: "file", capability: "fs.create_text" }, external: ["todo.txt"] });
    expect(ex2.recovered!.text).toContain("备忘.txt");
    expect(ex2.externalChanges.map((c) => c.path)).toEqual(["todo.txt"]);
    expect(ex2.changes().external).toEqual(["todo.txt"]);
    const after = fs.readFileSync(journal, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(after.at(-1)).toMatchObject({ kind: "receipt", recovered: true, finding: "happened", external: ["todo.txt"] });
    // a third start finds nothing pending
    const ex3 = new Executor(new SimComputer(root), { task: "t1", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() }, journal });
    await ex3.begin();
    expect(ex3.recovered).toBeNull();
  });
});

describe("executor: standing rules from the app", () => {
  it("rules handed over at begin cover matching actions and are named on use; a rule for sending or a forged one is dropped", async () => {
    const app = ConsentSigner.fresh();
    const { sim, w } = mailSim();
    const events: Record<string, unknown>[] = [];
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, onEvent: (k, b) => events.push({ k, ...b }) });
    const ok = app.forRule("关我的邮件窗口不用问", `window:${w.id}`, "modify_user");
    const sendRule = app.forRule("发邮件不用问", `window:${w.id}`, "external");
    const forged = { ...ok, sig: Buffer.from("x").toString("base64") };
    await ex.begin([], [ok, sendRule, forged]);
    const loaded = events.find((e) => e.k === "executor.rules") as { kept: number; dropped: string[] };
    expect(loaded.kept).toBe(1);
    expect(loaded.dropped.length).toBe(2);
    await ex.plan({ steps: [] });
    expect((await ex.act({ action: { kind: "close_window", window: w.id }, epoch: (await ex.snapshot()).epoch })).status).toBe("ok");
    expect([...ex.consent.rulesUsed]).toEqual(["关我的邮件窗口不用问"]);
  });
});
