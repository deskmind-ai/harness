/**
 * A stop while the runtime is looking at a window again after a stale action (review of harness #24): the real
 * HandsDriver over a stand-in executor process that, like hands', answers one request at a time. The look takes
 * seconds; the run must end soon after the stop, not after the look and an `end` queued behind it.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/index.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { HandsDriver } from "../src/executor/hands.js";
import { FrontierRuntime } from "../src/runtime/loop.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
const model = { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as any;

// one request at a time, as hands' executor: the second snapshot moves the epoch (the action goes stale), the second
// observe (the runtime's look again) says it started and then takes 3 s
const CHILD = `
const fs = require("node:fs"); const rl = require("node:readline").createInterface({ input: process.stdin });
const w = { id: "w", app: "Editor", title: "Doc" }; let snaps = 0, looks = 0; const queue = []; let busy = false;
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, ok: true, result }) + "\\n");
const next = () => { if (busy || !queue.length) return; busy = true; const m = queue.shift(); handle(m, () => { busy = false; next(); }); };
const handle = (m, done) => {
  if (m.op === "begin" || m.op === "snapshot") { snaps += 1; reply(m.id, { epoch: snaps >= 2 ? 2 : 1, locked: false, front_app: "Editor", windows: [w] }); return done(); }
  if (m.op === "observe") { looks += 1; const r = { epoch: snaps >= 2 ? 2 : 1, window: w, modal: null, elements: [{ id: "b", role: "button", label: "Go", actions: ["click"] }] };
    if (looks < 2) { reply(m.id, r); return done(); }
    fs.writeFileSync(process.env.MARK, "looking"); return setTimeout(() => { reply(m.id, r); done(); }, 3000); }
  reply(m.id, {}); done();
};
rl.on("line", (l) => { queue.push(JSON.parse(l)); next(); });
`;

describe("a stop during the runtime's look again, on the real HandsDriver", () => {
  it("ends the run soon after the stop: the look is not waited for, nor an end queued behind it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hands-stop-")), mark = path.join(dir, "mark");
    fs.writeFileSync(path.join(dir, "child.cjs"), CHILD);
    process.env.MARK = mark;
    const driver = new HandsDriver({ cmd: `${process.execPath} child.cjs`, dir, timeoutMs: 10_000 });
    const app = ConsentSigner.fresh(), ex = new Executor(driver, { task: "t", publicKey: app.publicKey });
    const steps: Step[] = [
      { calls: [{ name: "computer_observe", args: { window: "w" } }] },
      { calls: [{ name: "computer_act", args: { action: { kind: "click", window: "w", target: "b" }, epoch: 1, consequence: "read", purpose: "go" } }] },
      { calls: [{ name: "finish", args: { outcome: "cannot", summary: "x" } }] },
    ];
    const rt = new FrontierRuntime({ task: "t", raw: "go", executor: ex, signer: app, user: { ask: () => null }, gateway: new Gateway(table), model: { model, streamFn: scriptedStream(steps) } });
    const running = rt.run();
    for (let i = 0; i < 200 && !fs.existsSync(mark); i++) await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(mark)).toBe(true);                        // the look again has started in the process
    const t0 = Date.now();
    rt.stop("the app stopped the task");
    const r = await running;
    expect({ status: r.status, fast: Date.now() - t0 < 1500 }).toEqual({ status: "stopped", fast: true });
  }, 15_000);
});
