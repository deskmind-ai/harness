/**
 * The M0 additions to the app's event stream (deskmind 0.5 handoff, §1.3 and §6 M0), on one scripted run in process:
 * no model, no network. Each added event or field is read the way the app will read it — from the events written to
 * stdout and events.jsonl — and the run's trace is checked to name the same step.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { appRun, LineReader } from "../src/cli/app.js";
import { SimComputer } from "../src/executor/sim.js";
import { Gateway } from "../src/gateway/index.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";
import type { AppEvent } from "../src/protocol/events.js";

const roles = ["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"];
const model = { model: { id: "deepseek-flash", name: "deepseek-flash", api: "openai-completions", provider: "deepseek", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as never };
const lastJson = (ms: any[]) => { const m = [...ms].reverse().find((x) => x.role === "toolResult"); try { return JSON.parse(m.content[0].text.split("\n")[0]); } catch { return {}; } };

/** One run on a simulated editor: the model looks, plans to change the user's document (a plan card, approved), sets
 *  the text (plan step 1), clicks an element it never saw (stale: not done), and finishes; the verdict passes. */
export async function editorRun(o: { lang?: "zh" | "en"; extraSteps?: (w: string) => Step[] } = {}) {
  const sim = new SimComputer();
  const w = sim.addEditor("编辑器", { title: "笔记.txt", text: "旧的", path: null }).id;
  const gw = new Gateway(Object.fromEntries(roles.map((r) => [r, { backend: "scripted", model: "scripted" }])) as never);
  gw.script = Array(40).fill((role: string) => (role === "verify" ? { choice: "pass", reason: "正文已改" } : { choice: "matches" }));
  const steps: Step[] = [
    { calls: [{ name: "computer_snapshot", args: {} }] },
    { calls: [{ name: "computer_observe", args: { window: w } }] },
    { calls: [{ name: "plan", args: { steps: [{ purpose: "把正文改成「新的」", objects: [`window:${w}`], consequence: "modify_user" }] } }] },
    (m) => ({ calls: [{ name: "computer_observe", args: { window: w } }] }),
    (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "set_value", window: w, target: `${w}:0:textarea`, value: "新的" }, epoch: lastJson(m).epoch, consequence: "modify_user", purpose: "改正文", plan_step: 1 } }] }),
    (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "click", window: w, target: `${w}:0:nothing` }, epoch: lastJson(m).epoch ?? 1, consequence: "read", purpose: "看看" } }] }),
    ...(o.extraSteps?.(w) ?? []),
    { calls: [{ name: "finish", args: { outcome: "done", summary: "正文改成了「新的」" } }] },
  ];
  const input = new PassThrough();
  const events: AppEvent[] = [];
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "m0-"));
  // the app: approve every blocking card by its approve option's index, naming the card
  const out = (e: AppEvent) => {
    events.push(e);
    if (e.kind === "ask" && e.card.blocking) {
      const i = e.card.options.findIndex((x) => x.kind === "approve");
      setTimeout(() => input.write(JSON.stringify({ type: "answer", ask_id: e.ask_id, option: i }) + "\n"), 5);
    }
  };
  await appRun({ run_id: "run_m0", raw: "把笔记的正文改成「新的」", config: "ds-flash", lang: o.lang ?? "zh" }, {
    runs, out, input: new LineReader(input), linger: 0,
    inject: { driver: sim, gateway: gw, model: { ...model, streamFn: scriptedStream(steps) } },
  });
  const dir = path.join(runs, "run_m0");
  const read = (f: string) => fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { events, dir, w, trace: read("trace.jsonl"), calls: read("model_calls.jsonl"), read };
}

describe("M0 slice A: step lifecycle and readable text", () => {
  it("each act is a step with an id, the action in words and its element, and one step_result", async () => {
    const r = await editorRun();
    const done = r.events.find((e) => e.kind === "task_done") as any;
    expect(done.status).toBe("succeeded");
    const steps = r.events.filter((e) => e.kind === "step") as any[];
    const results = r.events.filter((e) => e.kind === "step_result") as any[];
    expect(steps).toHaveLength(2);
    expect(results.map((x) => x.step_id)).toEqual(steps.map((x) => x.step_id));
    expect(new Set(steps.map((x) => x.step_id)).size).toBe(2);
    // the first: the text set, under plan step 1, said in words from the element's label — no id, no JSON
    expect(steps[0]).toMatchObject({ plan_step: 1, purpose: "改正文", consequence: "modify_user", object: `window:${r.w}`, target: { id: `${r.w}:0:textarea`, label: "正文", role: "textArea" } });
    expect(steps[0].human).toBe("在 编辑器「笔记.txt」 把「正文」设为「新的」");
    expect(steps[0].human).not.toContain(r.w + ":");
    expect(JSON.parse(steps[0].text)).toMatchObject({ kind: "set_value" });        // the app as shipped reads the JSON
    expect(results[0]).toMatchObject({ status: "ok", executor_status: "ok", consequence: "modify_user" });
    // the second: an element never seen is not acted on (stale), said without its id
    expect(steps[1].human).toBe("在 编辑器「笔记.txt（已修改）」 点「一个元素」");     // the window as last observed
    expect(steps[1].plan_step).toBeUndefined();
    expect(results[1]).toMatchObject({ status: "stale", executor_status: "stale" });
    // every step's result comes after it and before the next step
    const at = (e: any) => r.events.indexOf(e);
    expect(at(results[0])).toBeGreaterThan(at(steps[0]));
    expect(at(steps[1])).toBeGreaterThan(at(results[0]));
  });

  it("the trace names the step every executor event served", async () => {
    const r = await editorRun();
    const steps = r.events.filter((e) => e.kind === "step") as any[];
    const acts = r.trace.filter((t: any) => t.kind === "executor.act");
    expect(acts.map((t: any) => t.step_id)).toEqual(steps.map((x) => x.step_id));
    const intent = r.trace.find((t: any) => t.kind === "executor.intent");
    expect(intent?.step_id).toBe(steps[0].step_id);
    // outside a step (the plan, a look) nothing is named
    expect(r.trace.find((t: any) => t.kind === "executor.plan")?.step_id).toBeUndefined();
  });

  it("in English the words are English", async () => {
    const r = await editorRun({ lang: "en" });
    const steps = r.events.filter((e) => e.kind === "step") as any[];
    expect(steps[0].human).toBe('In 编辑器「笔记.txt」: set "正文" to "新的"');
  });
});
