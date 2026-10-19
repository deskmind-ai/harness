/**
 * Independent review of the 0.5 execution layer: each test asserts the behaviour the three guarantees require and
 * FAILS on the current code, demonstrating one bug. Nothing here is a style check.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { Gateway } from "../src/gateway/index.js";
import type { Answer, Card } from "../src/orchestrator/index.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { HandsDriver } from "../src/executor/hands.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import type { Driver } from "../src/executor/types.js";
import { FrontierRuntime, type RuntimeUser } from "../src/runtime/loop.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";
import { fileRegistry } from "../src/registry/fs.js";
import { Workspace, build } from "../src/registry/workspace.js";

const scriptedTable = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
const model = { model: { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as any };
const approveAll = (c: Card): Answer => ({ option: c.options.findIndex((o) => o.kind === "approve") });
function user(policy: (card: Card) => Answer | null) {
  const cards: Card[] = [];
  const u: RuntimeUser & { cards: Card[] } = { cards, ask: (c) => { cards.push(c); return policy(c); } };
  return u;
}
function runtime(driver: Driver, steps: Step[], u: RuntimeUser, extra: Record<string, unknown> = {}) {
  const app = ConsentSigner.fresh();
  const ex = new Executor(driver, { task: "t1", publicKey: app.publicKey });
  const gw = new Gateway(scriptedTable);
  gw.script = Array(20).fill((role: string) => (role === "verify" ? { choice: "pass", reason: "ok" } : role === "intent" ? { choice: "matches" } : { outcome: "error", error: "unexpected role " + role }));
  const seen: Message[][] = [];
  const rt = new FrontierRuntime({ task: "t1", raw: "x", executor: ex, signer: app, user: u, gateway: gw, model: { ...model, streamFn: scriptedStream(steps, seen) }, ...extra } as any);
  return { rt, ex };
}

/** A task-owned mail window with a reply open, so a `sends` button exists in it. */
function taskMailWithCompose() {
  const sim = new SimComputer();
  sim.addEditor("编辑器");                                               // something of the user's on screen at begin
  const app = ConsentSigner.fresh();
  const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey });
  return { sim, app, ex, open: async () => {
    await ex.begin();
    const mine = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], selected: "a1", composing: { to: "a1", body: "hi" }, inbox: [{ id: "a1", from: "顾青", subject: "合同", body: ["x"], time: "10:00" }] });
    ex.ledger.created(`window:${mine.id}`);
    return mine;
  } };
}

describe("review: guarantee 2 — nothing of the user's changes without consent", () => {
  it("fs.move hands the user's content to a task-owned path; the next trash / overwrite of it asks nobody", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rv-fs-"));
    build(root, { "todo.txt": "交房租\n" });
    const ws = new Workspace(root);
    const steps: Step[] = [
      // the start gate (added later) wants a plan before the user's file is touched; the plan names only the move, so
      // the trash of the moved content is outside it and has to be consented on its own
      { calls: [{ name: "plan", args: { steps: [{ purpose: "move", objects: ["path:todo.txt"], consequence: "modify_user" }] } }] },
      { calls: [{ name: "fs_move", args: { source: "todo.txt", destination: "moved.txt" } }] },
      { calls: [{ name: "fs_trash", args: { target: "moved.txt" } }] },
      { calls: [{ name: "finish", args: { outcome: "cannot", summary: "stop here" } }] },
    ];
    const u = user(approveAll);
    const { rt } = runtime(new SimComputer(root), steps, u, { workspace: ws, registry: fileRegistry() });
    await rt.run();
    // the move was consented (the plan); trashing the user's content under its new name must be consented too
    expect(u.cards.map((c) => c.kind)).toEqual(["plan", "action"]);
    expect(u.cards[1]!.text).toContain("moved.txt");
  });

  it("a click on an element the executor never observed skips the `sends` floor: the mail goes out with no consent", async () => {
    const { sim, ex, open } = taskMailWithCompose();
    const mine = await open();
    const s = await ex.snapshot();                                        // epoch is current; the window was never observed
    const r = await ex.act({ action: { kind: "click", window: mine.id, target: `${mine.id}:0:send` }, epoch: s.epoch, consequence: "create" });
    expect(sim.mailState(mine.id).replies).toEqual([]);                   // sent without any consent on the current code
    expect(r.status).not.toBe("ok");
  });

  it("floor(): Return / cmd+Return / a typed newline in a window with a `sends` button is not `create`", async () => {
    const { ex, open } = taskMailWithCompose();
    const mine = await open();
    const o = await ex.observe(mine.id);
    const body = o.elements.find((e) => e.label === "回复内容")!;
    expect(ex.preview({ action: { kind: "key", window: mine.id, chord: "cmd+return" }, epoch: o.epoch }).consequence).toBe("external");
    expect(ex.preview({ action: { kind: "type", window: mine.id, target: body.id, text: "收到\n" }, epoch: o.epoch }).consequence).toBe("external");
  });

  it("an action token answers a challenge this executor never issued: another executor with the same app key accepts it", async () => {
    const app = ConsentSigner.fresh();
    const mk = () => { const sim = new SimComputer(); const w = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "m1", from: "林晓", subject: "Q3", body: ["x"], time: "10:00" }] }); return { sim, w }; };
    const a = mk(), b = mk();                                             // two runs; window ids coincide (mail-1)
    const exA = new Executor(a.sim, { task: "run-a", publicKey: app.publicKey });
    const exB = new Executor(b.sim, { task: "run-b", publicKey: app.publicKey });
    await exA.begin(); await exB.begin();
    await exA.plan({ steps: [] }); await exB.plan({ steps: [] });
    const oa = await exA.observe(a.w.id);
    const row = oa.elements.find((e) => e.role === "row")!;
    const action = { kind: "click" as const, window: a.w.id, target: row.id };
    const ra = await exA.act({ action, epoch: oa.epoch });
    expect(ra.status).toBe("needs_consent");
    const token = app.forAction(ra.challenge!);                           // the user said yes to run A's card
    const ob = await exB.observe(b.w.id);
    const rb = await exB.act({ action, epoch: ob.epoch, consent: token });
    expect(rb.status).toBe("needs_consent");                              // run B issued no challenge; the token is a replay
    expect(b.sim.mailState(b.w.id).selected).toBeNull();
  });
});

describe("review: guarantee 3 — an honest end on the real driver path", () => {
  it("run() rejects instead of ending with a status when the driver fails at begin (the app then gets no task_done)", async () => {
    const dead: Driver = {
      snapshot: () => { throw new Error("hands executor exited (127)"); },
      observe: () => { throw new Error("hands executor exited (127)"); },
      perform: () => { throw new Error("hands executor exited (127)"); },
    };
    const { rt } = runtime(dead, [], user(approveAll));
    await expect(rt.run()).resolves.toMatchObject({ status: expect.stringMatching(/^(environment|failed)$/) });
  });

  it("HandsDriver: a broken stdin pipe is not handled — the pending call waits for its timeout, and with no listener the EPIPE is an uncaught exception", async () => {
    const d = new HandsDriver({ cmd: "exec 0<&-; sleep 3", timeoutMs: 400 });   // hands closes its stdin and lingers
    await expect(d.snapshot()).rejects.toThrow(/no answer/);
    const stdin = (d as any).proc.stdin as NodeJS.WritableStream;
    expect(stdin.listenerCount("error")).toBeGreaterThan(0);              // the driver never listens: EPIPE kills the process
    const errs: Error[] = [];
    stdin.on("error", (e: Error) => errs.push(e));                        // (keeps this worker alive for the next assertion)
    await expect(d.snapshot()).rejects.not.toThrow(/no answer/);         // the call should fail on the pipe error, not on the timer
    await d.end();
  });
});
