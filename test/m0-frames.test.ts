/**
 * Review fixes to M0 slice E: what only the app uses — a window's screen frame, the target's and window's frames in a
 * receipt, a step's picture, a card's fields — never reaches a judge or a model (the cloud judge's prompt, the agent
 * loop's context, an MCP caller); a picture is taken off the action's path and announced when it is on disk; a step that
 * did nothing takes none.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { appRun, LineReader } from "../src/cli/app.js";
import { McpExecutorServer } from "../src/cli/mcp.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import { OUTGOING_QUESTION } from "../src/executor/judge.js";
import { Gateway } from "../src/gateway/index.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";
import type { AppEvent } from "../src/protocol/events.js";

const roles = ["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"];
const model = { model: { id: "deepseek-flash", name: "deepseek-flash", api: "openai-completions", provider: "deepseek", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as never };
const lastJson = (ms: any[]) => { const m = [...ms].reverse().find((x) => x.role === "toolResult"); try { return JSON.parse(m.content[0].text.split("\n")[0]); } catch { return {}; } };
const UI_ONLY = /"frame"|target_frame|window_frame|shot_pending|"shot"|shots\/|"facts"|action_text|object_label/;

/** hands M0 as the simulated computer: a window frame and element rects on observe; a picture asked for is written a
 *  moment after the reply (hands takes it off the action's path), with the frames in the receipt. */
class LateShotSim extends SimComputer {
  asked: { kind: string; shot?: string; frames?: boolean }[] = [];
  override observe(id: string) {
    const ob = super.observe(id) as any;
    return { ...ob, window: { ...ob.window, frame: [100, 50, 800, 600] }, elements: ob.elements.map((e: any, i: number) => ({ ...e, rect: [40, 40 + 30 * i, 200, 24] })) } as never;
  }
  override perform(a: any, opts?: { foreground_ok?: boolean; shot?: string; frames?: boolean }) {
    const r = super.perform(a) as any;
    this.asked.push({ kind: a.kind, ...(opts?.shot ? { shot: opts.shot } : {}), ...(opts?.frames ? { frames: true } : {}) });
    if (!opts?.shot) return r;
    setTimeout(() => { fs.mkdirSync(path.dirname(opts.shot!), { recursive: true }); fs.writeFileSync(opts.shot!, "png"); }, 50);
    return { ...r, shot: opts.shot, shot_pending: true, window_frame: { x: 100, y: 50, w: 800, h: 600 }, target_frame: { x: 140, y: 120, w: 200, h: 24 } };
  }
}

describe("M0 slice E review: the app's fields stay the app's", () => {
  it("no judge prompt and no model context carries a frame, a picture or a card's fields; the late picture is announced; a stale step asks for none", async () => {
    const sim = new LateShotSim();
    const w = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "m1", from: "林晓", subject: "Q3", body: ["hi"], time: "14:00" }] }).id;
    const prompts: string[] = [];
    const gw = new Gateway(Object.fromEntries(roles.map((r) => [r, { backend: "scripted", model: "scripted" }])) as never);
    gw.script = Array(80).fill((role: string, sys: string, u: string) => { prompts.push(sys + "\n" + u); return role === "verify" ? { choice: "pass", reason: "ok" } : u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: /"目标名字命中发送词表":\s*true/.test(u) ? "sends" : "stays" } : { choice: "matches" }; });
    const act = (target: string, consequence: string, extra: Record<string, unknown> = {}) => (m: any[]): Step => ({ calls: [{ name: "computer_act", args: { action: { kind: "click", window: w, target: `${w}:0:${target}`, ...extra }, epoch: lastJson(m).after?.epoch ?? lastJson(m).epoch, consequence, purpose: "回复" } }] });
    const steps: Step[] = [
      { calls: [{ name: "plan", args: { steps: [{ purpose: "回复并发送", objects: [`window:${w}`], consequence: "external" }] } }] },
      { calls: [{ name: "computer_observe", args: { window: w } }] },
      act("row:m1", "modify_user"),
      act("reply", "modify_user"),
      act("compose_body", "modify_user", { kind: "set_value", value: "收到" }),
      act("nothing_here", "modify_user"),                              // stale: never seen, nothing done, no picture
      (m) => ({ calls: [{ name: "computer_observe", args: { window: w } }] }),
      act("send", "external"),                                          // a send: its consent card carries facts
      { calls: [{ name: "finish", args: { outcome: "done", summary: "回复了" } }] },
    ];
    const seen: Message[][] = [];
    const input = new PassThrough();
    const events: AppEvent[] = [];
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), "m0-frames-"));
    await appRun({ run_id: "r", raw: "回复林晓：收到", config: "ds-flash" }, {
      runs, input: new LineReader(input), linger: 0,
      out: (e) => { events.push(e); if (e.kind === "ask" && e.card.blocking) setTimeout(() => input.write(JSON.stringify({ type: "answer", ask_id: e.ask_id, option: e.card.options.findIndex((x) => x.kind === "approve") }) + "\n"), 5); },
      inject: { driver: sim, gateway: gw, model: { ...model, streamFn: scriptedStream(steps, seen) } },
    });
    expect((events.find((e) => e.kind === "task_done") as any).status).toBe("succeeded");
    // the app got them
    const results = events.filter((e) => e.kind === "step_result") as any[];
    expect(results.map((x) => x.status)).toEqual(["ok", "ok", "ok", "stale", "ok"]);
    expect((events.find((e) => e.kind === "step") as any).target.rect_norm).toBeDefined();
    expect(results[0]).toMatchObject({ shot_pending: true, window_frame: { x: 100 }, target_frame: { x: 140 } });
    expect((events.find((e) => e.kind === "ask" && (e as any).card.kind === "action") as any).card.consent).toBeDefined();
    // the stale step asked for no picture, and its result names none
    expect(results[3].shot).toBeUndefined();
    expect(sim.asked.map((x) => x.kind)).toEqual(["click", "click", "set_value", "click"]);
    expect(sim.asked.every((x) => x.shot && x.frames)).toBe(true);
    // nobody else did: every judge prompt and every context the acting model was sent
    expect(prompts.length).toBeGreaterThan(3);
    for (const p of prompts) expect(p).not.toMatch(UI_ONLY);
    for (const ctx of seen) expect(JSON.stringify(ctx)).not.toMatch(UI_ONLY);
    // the late pictures are announced once on disk (the last may come after task_done, while the process lives)
    await new Promise((r) => setTimeout(r, 300));
    const ready = fs.readFileSync(path.join(runs, "r", "events.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.kind === "shot_ready");
    expect(ready.map((e) => e.shot).sort()).toEqual(results.filter((x) => x.shot).map((x) => x.shot).sort());
    for (const e of ready) expect(fs.existsSync(path.join(runs, "r", e.shot))).toBe(true);
  });

  it("an MCP caller (a model) reads no frame, picture or card fields either", async () => {
    // a driver that puts frames and a picture in every receipt, asked or not
    class Loud extends LateShotSim { override perform(a: any) { return { ...(super.perform(a) as any), shot: "/x/shots/a.png", shot_pending: true, window_frame: { x: 1, y: 2, w: 3, h: 4 }, target_frame: { x: 1, y: 2, w: 3, h: 4 } }; } }
    const sim = new Loud();
    const w = sim.addEditor("编辑器", { title: "笔记.txt", text: "旧的", path: null }).id;
    const gw = new Gateway(Object.fromEntries(roles.map((r) => [r, { backend: "scripted", model: "scripted" }])) as never);
    gw.script = Array(20).fill(() => ({ choice: "matches" }));
    const s = new McpExecutorServer({ driver: () => sim, gateway: gw, consent: "auto" });
    await s.call("begin", { raw: "改正文" });
    await s.call("plan", { steps: [{ purpose: "改正文", objects: [`window:${w}`], consequence: "modify_user" }] });
    // tools v2 (executor split P2): the server is the port, whose replies are what the model reads
    const o = await s.call("observe", { window: w });
    expect(JSON.stringify(o)).not.toMatch(UI_ONLY);
    const obs = o.out as any;
    const r = await s.call("act", { action: { kind: "set_value", window: w, target: `${w}:0:textarea`, value: "新的" }, epoch: obs.epoch, consequence: "modify_user", purpose: "改正文" });
    expect(r.isError).toBe(false);
    const view = JSON.parse(r.text.split("\n")[0]!);
    expect(view.status).toBe("ok");
    expect(view.after).toBeDefined();
    expect(JSON.stringify(r)).not.toMatch(UI_ONLY);
  });
});
