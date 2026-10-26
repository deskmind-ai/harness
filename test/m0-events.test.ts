/**
 * The M0 additions to the app's event stream (deskmind 0.5 handoff, §1.3 and §6 M0), on one scripted run in process:
 * no model, no network. Each added event or field is read the way the app will read it — from the events written to
 * stdout and events.jsonl — and the run's trace is checked to name the same step.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { appRun, LineReader, StdioUser, toProtocol } from "../src/cli/app.js";
import { EventLog } from "../src/protocol/events.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import { OUTGOING_QUESTION } from "../src/executor/judge.js";
import { Gateway } from "../src/gateway/index.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";
import type { AppEvent } from "../src/protocol/events.js";

const roles = ["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"];
const model = { model: { id: "deepseek-flash", name: "deepseek-flash", api: "openai-completions", provider: "deepseek", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as never };
const lastJson = (ms: any[]) => { const m = [...ms].reverse().find((x) => x.role === "toolResult"); try { return JSON.parse(m.content[0].text.split("\n")[0]); } catch { return {}; } };

/** app-run in process on a simulated computer, with an app that approves every blocking card by its approve option's
 *  index (naming the card), and a gateway whose judges say "matches" / "stays" and whose verdict passes. */
export async function run(sim: SimComputer, raw: string, steps: Step[], o: { lang?: "zh" | "en"; linger?: number; respond?: string; runId?: string; scope?: string; afterDone?: string[]; endAfterDone?: boolean } = {}) {
  const gw = new Gateway(Object.fromEntries(roles.map((r) => [r, { backend: "scripted", model: "scripted" }])) as never);
  gw.script = Array(60).fill((role: string, _s: string, u: string) => (role === "verify" ? { choice: "pass", reason: "做完了" } : u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: /"目标名字命中发送词表":\s*true/.test(u) ? "sends" : "stays" } : { choice: "matches" }));
  const input = new PassThrough();
  const events: AppEvent[] = [];
  const runs = fs.mkdtempSync(path.join(os.tmpdir(), "m0-"));
  const runId = o.runId ?? "run_m0";
  const out = (e: AppEvent) => {
    events.push(e);
    if (e.kind === "ask" && e.card.blocking) {
      const i = e.card.options.findIndex((x) => x.kind === "approve");
      setTimeout(() => input.write(JSON.stringify({ type: "answer", ask_id: e.ask_id, option: i }) + "\n"), 5);
    }
    // during the linger: other lines first (afterDone), then the respond, or stdin closed (endAfterDone)
    if (e.kind === "task_done" && e.result_card && (o.respond || o.afterDone || o.endAfterDone)) {
      const i = o.respond ? e.result_card.options.findIndex((x) => x.kind === o.respond) : -1;
      setTimeout(() => {
        for (const l of o.afterDone ?? []) input.write(l + "\n");
        if (o.respond) input.write(JSON.stringify({ type: "respond", option: i }) + "\n");
        if (o.endAfterDone) input.end();
      }, 5);
    }
  };
  await appRun({ run_id: runId, raw, config: "ds-flash", lang: o.lang ?? "zh", ...(o.scope ? { scope: o.scope } : {}) }, {
    runs, out, input: new LineReader(input), linger: o.linger ?? 0,
    inject: { driver: sim, gateway: gw, model: { ...model, streamFn: scriptedStream(steps) } },
  });
  const dir = path.join(runs, runId);
  const read = (f: string) => fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { events, dir, runs, trace: read("trace.jsonl"), calls: read("model_calls.jsonl"), read };
}

/** One run on a simulated editor: the model looks, plans to change the user's document (a plan card, approved), sets
 *  the text (plan step 1), clicks an element it never saw (stale: not done), and finishes; the verdict passes. */
export async function editorRun(o: { lang?: "zh" | "en" } = {}) {
  const sim = new SimComputer();
  const w = sim.addEditor("编辑器", { title: "笔记.txt", text: "旧的", path: null }).id;
  const steps: Step[] = [
    { calls: [{ name: "computer_snapshot", args: {} }] },
    { calls: [{ name: "computer_observe", args: { window: w } }] },
    { calls: [{ name: "plan", args: { steps: [{ purpose: "把正文改成「新的」", objects: [`window:${w}`], consequence: "modify_user" }] } }] },
    { calls: [{ name: "computer_observe", args: { window: w } }] },
    (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "set_value", window: w, target: `${w}:0:textarea`, value: "新的" }, epoch: lastJson(m).epoch, consequence: "modify_user", purpose: "改正文", plan_step: 1 } }] }),
    (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "click", window: w, target: `${w}:0:nothing` }, epoch: lastJson(m).epoch ?? 1, consequence: "read", purpose: "看看" } }] }),
    { calls: [{ name: "finish", args: { outcome: "done", summary: "正文改成了「新的」" } }] },
  ];
  return { ...(await run(sim, "把笔记的正文改成「新的」", steps, o)), w };
}

/** One reply in a simulated mail app: a plan card (open, reply, send), then the send's own consent card. */
export async function mailRun() {
  const sim = new SimComputer();
  const w = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "m1", from: "林晓", subject: "Q3 预算", body: ["你好，关于Q3 预算，", "谢谢"], time: "14:00" }] }).id;
  const act = (action: Record<string, unknown>, consequence: string, plan_step: number) => (m: any[]): Step => ({ calls: [{ name: "computer_act", args: { action, epoch: lastJson(m).after?.epoch ?? lastJson(m).epoch, consequence, purpose: "回复", plan_step } }] });
  const steps: Step[] = [
    { calls: [{ name: "computer_snapshot", args: {} }] },
    { calls: [{ name: "plan", args: { steps: [{ purpose: "打开林晓的邮件并写回复", objects: [`window:${w}`], consequence: "modify_user" }, { purpose: "发送回复", objects: [`window:${w}`], consequence: "external", opens: [{ app: "Safari", url: "https://www.example.com/s?q=Q3", sends: "搜索「Q3」" }] }] } }] },
    { calls: [{ name: "computer_observe", args: { window: w } }] },
    act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "modify_user", 1),
    act({ kind: "click", window: w, target: `${w}:0:reply` }, "modify_user", 1),
    act({ kind: "set_value", window: w, target: `${w}:0:compose_body`, value: "收到，谢谢" }, "modify_user", 1),
    act({ kind: "click", window: w, target: `${w}:0:send` }, "external", 2),
    { calls: [{ name: "finish", args: { outcome: "done", summary: "回复并发送了" } }] },
  ];
  return { ...(await run(sim, "回复林晓：收到，谢谢", steps)), w };
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
    // (U3) the window named as the card would name it, beside its ref — for the app's list of what the task changed
    expect(steps[0].object_label).toBe("编辑器「笔记.txt」");
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
    // (H3: one language — English quotes names with curly quotes, never 「」)
    expect(steps[0].human).toBe("In 编辑器 \u201c笔记.txt\u201d: set \u201c正文\u201d to \u201c新的\u201d");
  });
});

describe("M0 slice B: card facts in fields", () => {
  it("the plan card and the send's consent card carry their facts; the text is as before", async () => {
    const r = await mailRun();
    expect((r.events.find((e) => e.kind === "task_done") as any).status).toBe("succeeded");
    const asks = r.events.filter((e) => e.kind === "ask") as any[];
    expect(asks.map((a) => a.card.kind)).toEqual(["plan", "action"]);
    const plan = asks[0].card;
    expect(plan.text).toContain("我打算这样做");
    expect(plan.plan.steps).toHaveLength(2);
    expect(plan.plan.steps[0]).toMatchObject({ purpose: "打开林晓的邮件并写回复", class: "modify_user", sites: [] });
    expect(plan.plan.steps[0].objects).toEqual([{ ref: `window:${r.w}`, label: "信鸽「收件箱」", owner: "user", marks: ["changes"] }]);
    expect(plan.plan.steps[1]).toMatchObject({ class: "external", sites: [{ host: "www.example.com", sends: "搜索「Q3」", asks_each: false }] });
    expect(plan.plan.steps[1].objects[0].marks).toEqual(["changes", "sends"]);
    expect(plan.plan.foreground).toBeNull();
    const consent = asks[1].card;
    expect(consent.text).toContain("要发出去的");
    expect(consent.consent).toMatchObject({ action: "click", target: "发送", object: `window:${r.w}`, consequence: "external", site: null });
    expect(consent.consent.action_text).toContain("点「发送」");
    expect(consent.consent.object_label).toContain("信鸽");
    expect(consent.consent.outgoing).toContainEqual({ kind: "field", label: "回复内容", value: "收到，谢谢" });
    expect(consent.consent.outgoing).toContainEqual({ kind: "selected", label: "林晓 · Q3 预算", value: "" });
    // (U3) a driver that gives no rects: the card carries no target box (never a made-up one)
    expect(consent.consent.target_box).toBeUndefined();
  });
});

describe("M0 slice A, a real-shaped run: the mail reply", () => {
  it("each step says its element by label, and the plan step the model gave", async () => {
    const r = await mailRun();
    const steps = r.events.filter((e) => e.kind === "step") as any[];
    expect(steps.map((s) => s.human)).toEqual(["在 信鸽「收件箱」 点「林晓 · Q3 预算」", "在 信鸽「收件箱」 点「回复」", "在 信鸽「收件箱」 把「回复内容」设为「收到，谢谢」", "在 信鸽「收件箱」 点「发送」"]);
    expect(steps.map((s) => s.plan_step)).toEqual([1, 1, 1, 2]);
    expect((r.events.filter((e) => e.kind === "step_result") as any[]).map((x) => x.status)).toEqual(["ok", "ok", "ok", "ok"]);
  });
});

describe("M0 slice A: what a step may say", () => {
  it("an element is named only from the look the caller decided on; a file step carries the executor's class", async () => {
    const sim = new SimComputer();
    const w = sim.addEditor("编辑器", { title: "笔记.txt", text: "旧的", path: null }).id;
    let first = 0;
    const steps: Step[] = [
      { calls: [{ name: "plan", args: { steps: [{ purpose: "改正文", objects: [`window:${w}`], consequence: "modify_user" }] } }] },
      { calls: [{ name: "computer_observe", args: { window: w } }] },
      (m) => { first = lastJson(m).epoch; return { calls: [{ name: "computer_act", args: { action: { kind: "set_value", window: w, target: `${w}:0:textarea`, value: "新的" }, epoch: first, consequence: "modify_user", purpose: "改" } }] }; },
      // the same id, decided on the look before the edit: the executor's newer look is not what the caller saw
      () => ({ calls: [{ name: "computer_act", args: { action: { kind: "click", window: w, target: `${w}:0:menu_save` }, epoch: first, consequence: "modify_user", purpose: "存" } }] }),
      { calls: [{ name: "finish", args: { outcome: "done", summary: "改了" } }] },
    ];
    const r = await run(sim, "把正文改成「新的」", steps);
    const s = r.events.filter((e) => e.kind === "step") as any[];
    expect(s[0].target?.label).toBe("正文");
    expect(s[1].target).toBeUndefined();
    expect(s[1].human).toContain("一个元素");
  });
});

describe("M0 slice B: a consent card's fields say what its text says", () => {
  it("every item, in the text's order, however many: what the task typed and who is selected are never cut", async () => {
    const { outgoing, outgoingItems } = await import("../src/executor/executor.js");
    const els = [...Array.from({ length: 50 }, (_, i) => ({ id: `l${i}`, role: "staticText", label: `行 ${i}`, actions: [] as string[] })),
      { id: "to", role: "row", label: "林晓", actions: ["click"], focused: true }, { id: "send", role: "button", label: "发送", actions: ["click"], sends: true }];
    const obs = { epoch: 1, window: { id: "w", app: "信鸽", title: "写信", url: "https://mail.example.com/c" }, modal: null, elements: els, text: "行 3\n一行窗口里的字" } as never;
    const items = outgoingItems(obs, ["收到，谢谢"]);
    const o = outgoing(obs);
    expect(items).toHaveLength(o.fields.length + 1 + o.shown.length);
    expect(items[0]).toEqual({ kind: "field", label: "URL", value: "https://mail.example.com/c" });
    expect(items).toContainEqual({ kind: "selected", label: "林晓", value: "" });
    expect(items).toContainEqual({ kind: "typed", label: "", value: "收到，谢谢" });
    expect(items.at(-1)).toEqual({ kind: "text", label: "", value: "一行窗口里的字" });
    expect(items.filter((x) => x.value === "行 3")).toHaveLength(1);         // a line already in a field is not repeated
  });
});

describe("M0 slice C: cost and timing", () => {
  it("every model call is recorded and sent: the acting model's turns, the judges' — with the step and judge question", async () => {
    const r = await editorRun();
    const calls = r.events.filter((e) => e.kind === "model_call") as any[];
    const loop = calls.filter((c) => c.role === "loop");
    expect(loop).toHaveLength(7);                                   // one per turn of the script
    expect(loop[0]).toMatchObject({ model: "deepseek|deepseek-flash", tokens_in: 1, tokens_out: 1, outcome: "answered" });
    expect(loop[0].cost_usd).toBeCloseTo(1.5e-6, 9);                 // by the price table: pi-ai's entry says 0
    expect(loop.every((c) => c.latency_ms >= 0 && c.call_id.startsWith("mc_"))).toBe(true);
    // the judges: the intent check inside the set_value step, the verdict at the end — each names its question
    const judges = r.events.filter((e) => e.kind === "judge") as any[];
    const steps = r.events.filter((e) => e.kind === "step") as any[];
    const intent = judges.find((j) => j.question === "intent");
    expect(intent).toMatchObject({ answer: "matches", by: "frontier", step_id: steps[0].step_id, tiers: [{ tier: "frontier", outcome: "answered", choice: "matches", settled: true }] });
    expect(judges.find((j) => j.question === "verify")).toMatchObject({ answer: "pass", by: "frontier" });
    expect(judges.find((j) => j.question === "verify").step_id).toBeUndefined();
    const judged = calls.filter((c) => c.judge_id === intent.judge_id);
    expect(judged).toHaveLength(1);
    expect(judged[0]).toMatchObject({ role: "intent", step_id: steps[0].step_id });
    // on disk: every call, with its id and start; and the trace's intent event names the judge question
    expect(r.calls.map((c: any) => c.call_id)).toEqual(calls.map((c) => c.call_id));
    expect(r.calls.every((c: any) => typeof c.started_at === "number")).toBe(true);
    expect(r.trace.find((t: any) => t.kind === "executor.intent").judge_id).toBe(intent.judge_id);
    // the sum on task_done
    const done = r.events.find((e) => e.kind === "task_done") as any;
    expect(done.usage.calls).toBe(calls.length);
    expect(done.usage.by_role.loop.calls).toBe(7);
    expect(done.usage.cost_usd).toBeCloseTo(7 * 1.5e-6, 8);
    // nothing after task_done
    expect(r.events.at(-1)!.kind).toBe("task_done");
  });

  it("a judge question says every tier asked and the shadow comparison", async () => {
    const { Judge } = await import("../src/executor/judge.js");
    const fast = new Gateway(Object.fromEntries(roles.map((x) => [x, { backend: "scripted", model: "scripted" }])) as never);
    const slow = new Gateway(Object.fromEntries(roles.map((x) => [x, { backend: "scripted", model: "scripted" }])) as never);
    fast.script = [() => ({ choice: "a", scores: { a: 0.95, b: 0.05 } })];
    slow.script = [() => ({ choice: "b" })];
    const events: [string, any][] = [];
    const j = new Judge([{ name: "brain", gateway: fast, floor: 0.9 }, { name: "frontier", gateway: slow }], { shadow: true, onEvent: (k, b) => events.push([k, b]) });
    const ans = await j.choose("问题", {}, [{ id: "a", text: "A" }, { id: "b", text: "B" }]);
    expect(ans).toMatchObject({ choice: "a", by: "brain" });
    expect(ans!.judge_id).toMatch(/^jd_/);
    const [, a] = events.find(([k]) => k === "judge.answer")!;
    expect(a).toMatchObject({ judge_id: ans!.judge_id, name: "other", tiers: [{ tier: "brain", choice: "a", confidence: 0.95, settled: true }], shadow: { tier: "brain", top: "b", agree: false } });
    // the same question again is answered from the cache: no new question, no event
    expect((await j.choose("问题", {}, [{ id: "a", text: "A" }, { id: "b", text: "B" }]))!.cached).toBe(true);
    expect(events.filter(([k]) => k === "judge.answer")).toHaveLength(1);
  });
});

describe("M5-H: the judge questions' material in a run's trace", () => {
  it("a scripted run: every judge.answer in trace.jsonl has its judge.asked; the protocol has none", async () => {
    for (const r of [await editorRun(), await mailRun()]) {
      const ev: [string, any][] = r.trace.map((t: any) => [t.kind, t]);
      const answers = ev.filter(([k]) => k === "judge.answer");
      expect(answers.length).toBeGreaterThan(0);
      // (M5-H) each answer has exactly one asked before it with its id
      const ids = ev.filter(([k]) => k === "judge.asked").map(([, b]) => b.judge_id);
      expect(new Set(ids).size).toBe(ids.length);
      ev.forEach(([k, b], i) => { if (k === "judge.answer") expect(ev.slice(0, i).filter(([k2, b2]) => k2 === "judge.asked" && b2.judge_id === b.judge_id)).toHaveLength(1); });
      for (const [, a] of ev.filter(([k]) => k === "judge.asked")) {
        // (the prompt holds the user's words and window text: its length and kind only)
        expect(typeof a.prompt).toBe("string");
        expect(a.prompt.length).toBeGreaterThan(0);
        expect(typeof a.question_kind).toBe("string");
        expect(Array.isArray(a.options) && a.options.length > 0).toBe(true);
      }
      expect(r.events.some((e: any) => e.kind === "judge.asked")).toBe(false);
    }
  });
});

describe("M0 slice D: the run as an OpenTelemetry trace", () => {
  const spansOf = (r: { read: (f: string) => any[] }) => r.read("trace.otel.jsonl").flatMap((l: any) => l.resourceSpans.flatMap((rs: any) => rs.scopeSpans.flatMap((ss: any) => ss.spans)));
  const attr = (s: any, k: string) => { const a = s.attributes.find((x: any) => x.key === k); return a ? Object.values(a.value)[0] : undefined; };

  it("run → turn → model call / tool call → step → classify, judge → model call, perform; plan → ask_user; verify → judge", async () => {
    const r = await editorRun();
    const spans = spansOf(r);
    const by = new Map(spans.map((s: any) => [s.spanId, s]));
    const parent = (s: any) => by.get(s.parentSpanId);
    const named = (n: string) => spans.filter((s: any) => s.name === n);
    // one trace, one root, no span without its parent, every span ended after it began, all OK
    expect(new Set(spans.map((s: any) => s.traceId)).size).toBe(1);
    const roots = spans.filter((s: any) => !s.parentSpanId);
    expect(roots.map((s: any) => s.name)).toEqual(["invoke_agent deskmind"]);
    expect(attr(roots[0], "gen_ai.operation.name")).toBe("invoke_agent");
    expect(attr(roots[0], "deskmind.status")).toBe("succeeded");
    expect(spans.filter((s: any) => s.parentSpanId && !by.has(s.parentSpanId))).toEqual([]);
    expect(spans.every((s: any) => BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano) && s.status.code === 1)).toBe(true);
    // turns under the run; the acting model's call in each, with the GenAI attributes
    const turns = named("deskmind.turn");
    expect(turns).toHaveLength(7);
    expect(turns.every((t: any) => parent(t) === roots[0])).toBe(true);
    const loopChats = named("chat deepseek-flash");
    expect(loopChats).toHaveLength(7);
    expect(loopChats.every((c: any) => parent(c).name === "deskmind.turn" && c.kind === 3)).toBe(true);
    expect(attr(loopChats[0], "gen_ai.operation.name")).toBe("chat");
    expect(attr(loopChats[0], "gen_ai.provider.name")).toBe("deepseek");
    expect(attr(loopChats[0], "gen_ai.request.model")).toBe("deepseek-flash");
    expect(attr(loopChats[0], "gen_ai.usage.input_tokens")).toBe("1");
    expect(attr(loopChats[0], "deskmind.role")).toBe("loop");
    // the set_value step: under its tool call, the class settled, the intent judge (its tier's call below it), the driver
    const steps = named("deskmind.step");
    expect(steps.map((s: any) => attr(s, "deskmind.step.status"))).toEqual(["ok", "stale"]);
    expect(parent(steps[0]).name).toBe("execute_tool computer_act");
    expect(attr(parent(steps[0]), "gen_ai.tool.name")).toBe("computer_act");
    const stepEvents = r.events.filter((e) => e.kind === "step") as any[];
    expect(attr(steps[0], "deskmind.step_id")).toBe(stepEvents[0].step_id);
    const under = (p: any) => spans.filter((s: any) => s.parentSpanId === p.spanId).map((s: any) => s.name);
    expect(under(steps[0])).toEqual(expect.arrayContaining(["deskmind.classify", "deskmind.judge intent", "deskmind.perform"]));
    const judge = named("deskmind.judge intent")[0];
    expect(attr(judge, "deskmind.tier")).toBe("frontier");
    expect(attr(judge, "deskmind.judge_id")).toBe((r.events.find((e) => e.kind === "judge") as any).judge_id);
    expect(under(judge)).toEqual(["chat scripted"]);
    expect(attr(spans.find((s: any) => s.parentSpanId === judge.spanId), "deskmind.tier")).toBe("frontier");
    const perform = named("deskmind.perform")[0];
    expect(attr(perform, "deskmind.token_kind")).toBe("object");           // the plan's consent for the user's window
    expect(attr(perform, "deskmind.consequence")).toBe("modify_user");
    // the plan card's wait under the plan; the verdict's judge under verify, under finish
    expect(parent(named("deskmind.ask_user")[0]).name).toBe("deskmind.plan");
    expect(parent(named("deskmind.verify")[0]).name).toBe("execute_tool finish");
    expect(parent(named("deskmind.judge verify")[0]).name).toBe("deskmind.verify");
    // the trace's lines say where in the chain they were written
    const act = r.trace.find((t: any) => t.kind === "executor.act");
    expect(by.has(act.span_id)).toBe(true);
  });

  it("harness.mjs trace export writes one OTLP/JSON request with every span", async () => {
    const r = await editorRun();
    const out = path.join(r.runs, "export.json");
    const p = spawnSync(process.execPath, ["--import", "tsx", "src/cli/app.ts", "trace", "export", "--run", "run_m0", "--runs", r.runs, "--out", out], { encoding: "utf-8", timeout: 60_000 });
    expect(p.status, p.stderr).toBe(0);
    expect(JSON.parse(p.stdout.trim())).toMatchObject({ ok: true, spans: spansOf(r).length });
    const req = JSON.parse(fs.readFileSync(out, "utf-8"));
    expect(req.resourceSpans).toHaveLength(1);
    expect(req.resourceSpans[0].resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "deskmind-harness" } });
    expect(req.resourceSpans[0].scopeSpans[0].spans).toHaveLength(spansOf(r).length);
  }, 60_000);
});

describe("M0 slice D: spans left open", () => {
  it("a run that ends with a span still open (a stop that did not wait) closes it as an error, the tree whole", async () => {
    const { Tracer, span } = await import("../src/otel/trace.js");
    const { within } = await import("../src/otel/context.js");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "otel-")), "t.jsonl");
    const t = new Tracer(file);
    const root = t.start("invoke_agent deskmind", { parent: null });
    let hang!: () => void;
    void within({ tracer: t, span: root }, () => span("deskmind.perform", {}, () => new Promise<void>((r) => { hang = r; })));
    t.closeAll("stopped", root); t.end(root);
    const spans = fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l).resourceSpans[0].scopeSpans[0].spans[0]);
    expect(spans.map((s) => [s.name, s.status.code])).toEqual([["deskmind.perform", 2], ["invoke_agent deskmind", 1]]);
    expect(spans[0].parentSpanId).toBe(spans[1].spanId);
    hang();                                                        // the late end writes nothing more
    await new Promise((r) => setTimeout(r, 10));
    expect(fs.readFileSync(file, "utf-8").trim().split("\n")).toHaveLength(2);
  });
});

/** The simulated computer with what hands M0 adds: a window frame and element rects on observe, and on a perform asked
 *  for a picture, the picture written and the frames in the receipt. */
class ShotSim extends SimComputer {
  asked: (string | undefined)[] = [];
  override observe(id: string) {
    const ob = super.observe(id) as ReturnType<SimComputer["observe"]> & { window: any; elements: any[] };
    return { ...ob, window: { ...ob.window, frame: [100, 50, 800, 600] }, elements: ob.elements.map((e: any, i: number) => ({ ...e, rect: [40, 40 + 30 * i, 200, 24] })) } as never;
  }
  override perform(a: any, opts?: { foreground_ok?: boolean; shot?: string }) {
    const r = super.perform(a) as any;
    this.asked.push(opts?.shot);
    if (!opts?.shot) return r;
    fs.mkdirSync(path.dirname(opts.shot), { recursive: true });
    fs.writeFileSync(opts.shot, "png");
    return { ...r, shot: opts.shot, window_frame: { x: 100, y: 50, w: 800, h: 600 }, target_frame: { x: 140, y: 120, w: 200, h: 24 } };
  }
}

describe("M0 slice E: where the target is, and a picture after the step", () => {
  it("the step says where its element is; the result names the picture in the run folder; looks and stale steps take none", async () => {
    const sim = new ShotSim();
    const w = sim.addEditor("编辑器", { title: "笔记.txt", text: "旧的", path: null }).id;
    const steps: Step[] = [
      { calls: [{ name: "computer_snapshot", args: {} }] },
      { calls: [{ name: "plan", args: { steps: [{ purpose: "改正文", objects: [`window:${w}`], consequence: "modify_user" }] } }] },
      { calls: [{ name: "computer_observe", args: { window: w } }] },
      (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "set_value", window: w, target: `${w}:0:textarea`, value: "新的" }, epoch: lastJson(m).epoch, consequence: "modify_user", purpose: "改正文", plan_step: 1 } }] }),
      (m) => ({ calls: [{ name: "computer_act", args: { action: { kind: "wait", ms: 1 }, epoch: lastJson(m).epoch ?? 1, consequence: "read", purpose: "等" } }] }),
      { calls: [{ name: "finish", args: { outcome: "done", summary: "改了" } }] },
    ];
    const r = await run(sim, "把正文改成「新的」", steps);
    const step = r.events.find((e) => e.kind === "step") as any;
    const results = r.events.filter((e) => e.kind === "step_result") as any[];
    // the textarea is the 5th element of the editor's observation (index 4 → y 160): placed in its window, and on screen
    const el = (sim.observe(w) as any).elements.findIndex((e: any) => e.id === `${w}:0:textarea`);
    expect(step.target.rect_norm).toEqual([0.05, Math.round(((40 + 30 * el) / 600) * 10_000) / 10_000, 0.25, 0.04]);
    expect(step.target.frame).toEqual([140, 50 + 40 + 30 * el, 200, 24]);
    expect(results[0]).toMatchObject({ status: "ok", shot: `shots/${step.step_id}.png`, window_frame: { x: 100, y: 50, w: 800, h: 600 }, target_frame: { x: 140, y: 120, w: 200, h: 24 } });
    expect(fs.existsSync(path.join(r.dir, results[0].shot))).toBe(true);
    // the wait changed nothing: no picture asked for
    expect(sim.asked).toEqual([path.join(r.dir, "shots", `${step.step_id}.png`), undefined]);
    expect(results[1].shot).toBeUndefined();
    // the model never reads them
    const shown = r.trace.filter((t: any) => t.kind === "tool.result" && t.name === "computer_act").map((t: any) => t.text).join("\n");
    expect(shown).not.toContain("shots/");
    expect(shown).not.toContain("target_frame");
    const looked = r.trace.filter((t: any) => t.kind === "tool.result" && t.name === "computer_observe").map((t: any) => t.text).join("\n");
    expect(looked).toContain('"elements"');
    expect(looked).not.toContain('"frame"');
  });
});

describe("M0 slice E: the hands driver", () => {
  it("names the picture's file beside the action, and leaves the request as before without one", async () => {
    const { HandsDriver } = await import("../src/executor/hands.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hands-shot-"));
    const fake = path.join(dir, "fake.mjs"), seen = path.join(dir, "seen.jsonl");
    fs.writeFileSync(fake, `import * as fs from "node:fs"; import * as rl from "node:readline";
      rl.createInterface({ input: process.stdin }).on("line", (l) => { fs.appendFileSync(${JSON.stringify(seen)}, l + "\\n"); const m = JSON.parse(l);
        const result = m.op === "perform" ? { status: "ok", ...(m.shot ? { shot: m.shot } : {}) } : { epoch: 1, locked: false, front_app: "", windows: [] };
        process.stdout.write(JSON.stringify({ id: m.id, ok: true, result }) + "\\n"); });`);
    const d = new HandsDriver({ cmd: `${process.execPath} ${fake}`, dir });
    try {
      expect(await d.perform({ kind: "wait", ms: 1 }, { shot: "/runs/r/shots/st_1.png" })).toMatchObject({ shot: "/runs/r/shots/st_1.png" });
      await d.perform({ kind: "wait", ms: 1 }, { foreground_ok: true });
      const lines = fs.readFileSync(seen, "utf-8").trim().split("\n").map((l) => JSON.parse(l)).filter((m) => m.op === "perform");
      expect(lines[0]).toMatchObject({ action: { kind: "wait" }, shot: "/runs/r/shots/st_1.png" });
      expect(lines[1]).not.toHaveProperty("shot");
      expect(lines[1].action.foreground_ok).toBe(true);
    } finally { await d.end(); }
  });
});

describe("M0 slice F: the remaining events the new app needs", () => {
  it("a verdict, the changes after each step that changed something, and the undo in fields", async () => {
    const scope = fs.mkdtempSync(path.join(os.tmpdir(), "m0-scope-"));
    const steps: Step[] = [
      { calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "写了 a.txt" } }] },
    ];
    const r = await run(new SimComputer(scope), "在任务目录里新建 a.txt，写 hi", steps, { scope, linger: 5, respond: "undo" });
    const kinds = r.events.map((e) => e.kind);
    const changes = r.events.filter((e) => e.kind === "changes") as any[];
    expect(changes).toHaveLength(1);
    expect(changes[0].created).toEqual(["a.txt"]);
    // the file step carries the executor's class, before it is done
    expect(r.events.find((e) => e.kind === "step")).toMatchObject({ consequence: "create", text: expect.stringContaining("fs.create_text") });
    expect(kinds.indexOf("changes")).toBeGreaterThan(kinds.indexOf("step_result"));
    expect(r.events.find((e) => e.kind === "verify")).toMatchObject({ verdict: "pass", by: "frontier" });
    expect((r.events.find((e) => e.kind === "verify") as any).judge_id).toMatch(/^jd_/);
    const done = r.events.find((e) => e.kind === "task_done") as any;
    expect(done.result_card.options.map((x: any) => x.kind)).toContain("undo");
    expect(r.events.at(-1)).toMatchObject({ kind: "result_response", picked: "undo", undone: 1, total: 1, refused: null });
    expect(fs.existsSync(path.join(scope, "a.txt"))).toBe(false);
  });

  it("the linger reads past lines that are not a respond, and ends on stdin closed or the deadline", async () => {
    const steps = (): Step[] => [
      { calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "写了 a.txt" } }] },
    ];
    // a late answer to a card that is gone, a line that is not JSON, then the undo: the undo is still done
    const scope = fs.mkdtempSync(path.join(os.tmpdir(), "linger-"));
    const r = await run(new SimComputer(scope), "在任务目录里新建 a.txt，写 hi", steps(), { scope, linger: 5, respond: "undo",
      afterDone: [JSON.stringify({ type: "answer", ask_id: "ask_gone", option: 0 }), "not json", JSON.stringify({ ask_id: "ask_gone", text: "好" })] });
    expect(r.events.at(-1)).toMatchObject({ kind: "result_response", picked: "undo", undone: 1, total: 1 });
    expect(fs.existsSync(path.join(scope, "a.txt"))).toBe(false);
    // the app closes stdin: the wait ends at once, nothing is undone
    const scope2 = fs.mkdtempSync(path.join(os.tmpdir(), "linger-"));
    let t0 = Date.now();
    const r2 = await run(new SimComputer(scope2), "在任务目录里新建 a.txt，写 hi", steps(), { scope: scope2, linger: 30, afterDone: ["not json"], endAfterDone: true });
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r2.events.at(-1)!.kind).toBe("task_done");
    expect(fs.existsSync(path.join(scope2, "a.txt"))).toBe(true);
    // no respond and stdin open: the deadline ends it
    const scope3 = fs.mkdtempSync(path.join(os.tmpdir(), "linger-"));
    t0 = Date.now();
    const r3 = await run(new SimComputer(scope3), "在任务目录里新建 a.txt，写 hi", steps(), { scope: scope3, linger: 0.3, afterDone: ["not json"] });
    expect(Date.now() - t0).toBeLessThan(10_000);
    // (M2 H2: the deadline closes the card, said after task_done; no respond came, so no result_response)
    expect(r3.events.slice(-2).map((e) => e.kind)).toEqual(["task_done", "result_card_closed"]);
    expect(fs.existsSync(path.join(scope3, "a.txt"))).toBe(true);
  });

  it("a card let go says why: the user changed the request, stopped, or the app went away", async () => {
    const card = { kind: "action" as const, text: "点「发送」", free_text: false, blocking: true, options: [{ kind: "approve" as const, text: "可以" }] };
    for (const how of ["steer", "stop", "ended"] as const) {
      const input = new PassThrough();
      const sent: any[] = [];
      const reader = new LineReader(input);
      const u = new StdioUser(new EventLog(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "void-")), "e.jsonl"), "r1", (e) => sent.push(e)), reader);
      const ctl = new AbortController();
      const p = u.ask(card, { signal: ctl.signal });
      await new Promise((res) => setTimeout(res, 5));
      if (how === "steer") ctl.abort(); else if (how === "stop") reader.stop(); else input.end();
      expect(await p).toBeNull();
      const ask = sent.find((e) => e.kind === "ask");
      expect(sent.filter((e) => e.kind === "ask_void")).toEqual([expect.objectContaining({ ask_id: ask.ask_id, why: how })]);
    }
  });

  it("the end of a wait for the user, and a steer applied, are said", () => {
    expect(toProtocol("executor.user_resumed", {})).toEqual({ kind: "resumed", why: "" });
    expect(toProtocol("executor.user_resumed", { timed_out: true })).toEqual({ kind: "resumed", why: "timed_out" });
    expect(toProtocol("executor.user_resumed", { stopped: true })).toEqual({ kind: "resumed", why: "stopped" });
    expect(toProtocol("steer.applied", { raw: "只整理今天的" })).toEqual({ kind: "steered", text: "只整理今天的" });
    expect(toProtocol("executor.verdict", { verdict: "unknown", by: "frontier", reason: "看不到", missing_kind: "evidence" })).toEqual({ kind: "verify", verdict: "unknown", by: "frontier", reason: "看不到", missing_kind: "evidence" });
  });
});
