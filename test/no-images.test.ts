/**
 * The privacy promise the app's first run makes (U2 first-run copy: 「截图在本机识别，不上传」), checked rather than
 * asserted — hands' assert_no_images_sent, on this side: no request this process sends to a model carries an image
 * content part, or a picture's bytes as text, on the 0.5 paths — the task loop, every judge (intent, outgoing,
 * provenance, verify), compaction, and the chat session that starts a task. The check is live: a driver that hands
 * pixels over unasked, on every look, and a window small enough that compaction runs; and the check itself is shown
 * to catch an image part when one is put in front of it. runtime/model.ts declares input ["text", "image"] and
 * compact.ts knows images, so a later change could send one without any other test noticing.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { appRun, LineReader } from "../src/cli/app.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import { OUTGOING_QUESTION } from "../src/executor/judge.js";
import { Gateway } from "../src/gateway/index.js";
import { compact } from "../src/runtime/compact.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";
import { SessionHost } from "../src/session/host.js";
import type { ExecutorHandle, Launcher } from "../src/session/task.js";
import type { AppEvent } from "../src/protocol/events.js";

const roles = ["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"];
const model = (contextWindow: number) => ({ id: "deepseek-flash", name: "deepseek-flash", api: "openai-completions", provider: "deepseek", baseUrl: "", input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow, maxTokens: 1e5 } as never);
const lastJson = (ms: any[]) => { const m = [...ms].reverse().find((x) => x.role === "toolResult"); try { return JSON.parse(m.content[0].text.split("\n")[0]); } catch { return {}; } };

/** A PNG's bytes as a driver would hand them over: the base64 of the PNG signature, then bulk. */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB" + "A".repeat(3000);
/** Marks of a picture smuggled as text: a data URL, or the PNG signature in base64. */
const PICTURE_AS_TEXT = /data:image\/|iVBORw0KGgo/;

/** Every image part in these messages, and every picture-as-text, named: the check (empty: none). */
export function imagesIn(ms: Message[]): string[] {
  const found: string[] = [];
  ms.forEach((m, i) => {
    if (Array.isArray(m.content)) {
      (m.content as { type: string; mimeType?: string }[]).forEach((c, j) => { if (c.type === "image") found.push(`${i}:${m.role}[${j}] image part (${c.mimeType ?? "?"})`); });
    }
    if (PICTURE_AS_TEXT.test(JSON.stringify(m))) found.push(`${i}:${m.role} picture bytes as text`);
  });
  return found;
}

/** A driver that puts a screenshot in every observation, asked for or not (hands never does unasked; a bug might). */
class PixelSim extends SimComputer {
  looks = 0;
  override observe(id: string) {
    this.looks += 1;
    return { ...(super.observe(id) as object), screenshot_png: PNG } as never;
  }
}

/** The gateway with scripted judges, every prompt kept. */
function judges(prompts: string[]) {
  const gw = new Gateway(Object.fromEntries(roles.map((r) => [r, { backend: "scripted", model: "scripted" }])) as never);
  gw.script = Array(80).fill((role: string, sys: string, u: string) => { prompts.push(sys + "\n" + u); return role === "verify" ? { choice: "pass", reason: "ok" } : u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: /"目标名字命中发送词表":\s*true/.test(u) ? "sends" : "stays" } : { choice: "matches" }; });
  return gw;
}

/** One reply in a simulated mail app, then a send: a plan card, three changes, the send's consent card. */
function mailSteps(w: string): Step[] {
  const act = (action: Record<string, unknown>, consequence: string, plan_step: number) => (m: any[]): Step => ({ calls: [{ name: "computer_act", args: { action, epoch: lastJson(m).after?.epoch ?? lastJson(m).epoch, consequence, purpose: "回复", plan_step } }] });
  return [
    { calls: [{ name: "computer_snapshot", args: {} }] },
    { calls: [{ name: "plan", args: { steps: [{ purpose: "打开林晓的邮件并写回复", objects: [`window:${w}`], consequence: "modify_user" }, { purpose: "发送回复", objects: [`window:${w}`], consequence: "external" }] } }] },
    { calls: [{ name: "computer_observe", args: { window: w } }] },
    act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "modify_user", 1),
    { calls: [{ name: "computer_observe", args: { window: w } }] },
    act({ kind: "click", window: w, target: `${w}:0:reply` }, "modify_user", 1),
    act({ kind: "set_value", window: w, target: `${w}:0:compose_body`, value: "收到，谢谢" }, "modify_user", 1),
    { calls: [{ name: "computer_observe", args: { window: w } }] },
    act({ kind: "click", window: w, target: `${w}:0:send` }, "external", 2),
    { calls: [{ name: "finish", args: { outcome: "done", summary: "回复并发送了" } }] },
  ];
}
const mailSim = () => { const sim = new PixelSim(); const w = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "m1", from: "林晓", subject: "Q3 预算", body: ["你好，关于Q3 预算，", "谢谢"], time: "14:00" }] }).id; return { sim, w }; };
const readJsonl = (f: string) => (fs.existsSync(f) ? fs.readFileSync(f, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

describe("no image reaches a model: the first run's promise, checked on the 0.5 paths", () => {
  it("the task loop, its judges and verify, with compaction running, on a driver that hands pixels over on every look", async () => {
    const { sim, w } = mailSim();
    const prompts: string[] = [];
    const seen: Message[][] = [];
    const input = new PassThrough();
    const events: AppEvent[] = [];
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), "no-images-"));
    // a window small enough that the loop compacts (old observations are stubbed): the compaction path is on the record
    await appRun({ run_id: "r", raw: "回复林晓：收到，谢谢", config: "ds-flash" }, {
      runs, input: new LineReader(input), linger: 0,
      out: (e) => { events.push(e); if (e.kind === "ask" && e.card.blocking) setTimeout(() => input.write(JSON.stringify({ type: "answer", ask_id: e.ask_id, option: e.card.options.findIndex((x) => x.kind === "approve") }) + "\n"), 5); },
      inject: { driver: sim, gateway: judges(prompts), model: { model: model(2_000), streamFn: scriptedStream(mailSteps(w), seen) } },
    });
    expect((events.find((e) => e.kind === "task_done") as any).status).toBe("succeeded");
    expect(sim.looks).toBeGreaterThanOrEqual(3);
    // compaction ran: an old observation reached the model as its stub
    expect(seen.some((ctx) => JSON.stringify(ctx).includes("已省略"))).toBe(true);
    expect(seen.length).toBeGreaterThan(5);
    expect(prompts.length).toBeGreaterThan(3);
    // every context the acting model was sent, after compaction; every judge's prompt
    for (const ctx of seen) expect(imagesIn(ctx)).toEqual([]);
    for (const p of prompts) expect(p).not.toMatch(PICTURE_AS_TEXT);
    // and nothing of the kind on disk in the run's own record of what was sent
    expect(JSON.stringify(readJsonl(path.join(runs, "r", "model_calls.jsonl")))).not.toMatch(PICTURE_AS_TEXT);
  });

  it("the chat session that starts a task: the session model's contexts and the task's", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "no-images-s-"));
    const taskSeen: Message[][] = [], prompts: string[] = [];
    let sim: PixelSim | null = null;
    const launch: Launcher = (req, o) => {
      const made = mailSim(); sim = made.sim;
      const input = new PassThrough();
      let cb: ((l: string) => void) | null = null; const early: string[] = [];
      const exited = appRun(req as never, { runs: o.runs, out: (e) => { const l = JSON.stringify(e); if (cb) cb(l); else early.push(l); }, input: new LineReader(input), linger: o.linger,
        inject: { driver: made.sim, gateway: judges(prompts), model: { model: model(9_000), streamFn: scriptedStream(mailSteps(made.w), taskSeen) } } }).then(() => ({ code: 0 as const, signal: null }));
      const h: ExecutorHandle = { write: (l) => input.write(l + "\n"), close: () => input.end(), onLine: (f) => { cb = f; for (const l of early.splice(0)) f(l); }, exited };
      return h;
    };
    const sessionSeen: Message[][] = [];
    const evs: any[] = [];
    const chat: Step[] = [{ calls: [{ name: "computer_task", args: { goal: "回复林晓：收到，谢谢" } }] }, { text: "回复发出去了" }];
    const h = new SessionHost({ dir, sessionId: "ses_img", out: (e: any) => { evs.push(e); if (e.kind === "ask") setTimeout(() => h.handle(JSON.stringify({ type: "answer", run_id: e.run_id, ask_id: e.ask_id, option: e.card.options.findIndex((x: any) => x.kind === "approve") })), 5); },
      coalesceMs: 5, model: { model: model(128_000), streamFn: scriptedStream(chat, sessionSeen) }, launch, onExit: () => {} });
    h.start();
    try {
      h.handle(JSON.stringify({ type: "say", text: "回复林晓说收到，谢谢" }));
      await h.idle();
      await new Promise((r) => setTimeout(r, 30));
      await h.idle();
      expect(evs.find((e) => e.kind === "task_done")?.status).toBe("succeeded");
      expect(evs.find((e) => e.kind === "session.task_end")).toMatchObject({ status: "succeeded" });
      expect(sim!.looks).toBeGreaterThanOrEqual(3);
      expect(sessionSeen.length).toBeGreaterThanOrEqual(2);
      for (const ctx of sessionSeen) expect(imagesIn(ctx)).toEqual([]);
      for (const ctx of taskSeen) expect(imagesIn(ctx)).toEqual([]);
      for (const p of prompts) expect(p).not.toMatch(PICTURE_AS_TEXT);
      expect(fs.readFileSync(path.join(dir, "sessions", "ses_img", "session.jsonl"), "utf-8")).not.toMatch(PICTURE_AS_TEXT);
    } finally { h.end(); await new Promise((r) => setTimeout(r, 50)); }
  });

  it("the check sees an image: an image part, or a picture's bytes as text, in a context like the ones above", () => {
    const clean: Message[] = [{ role: "user", content: "回复林晓", timestamp: 1 } as Message, { role: "toolResult", toolCallId: "t1", toolName: "computer_observe", content: [{ type: "text", text: '{"epoch":1}' }], isError: false, timestamp: 2 } as Message];
    expect(imagesIn(clean)).toEqual([]);
    const withPart = [...clean, { role: "toolResult", toolCallId: "t2", toolName: "computer_observe", content: [{ type: "text", text: "看" }, { type: "image", data: PNG, mimeType: "image/png" }], isError: false, timestamp: 3 } as Message];
    expect(imagesIn(withPart)).toEqual(["2:toolResult[1] image part (image/png)", "2:toolResult picture bytes as text"]);
    const asText = [...clean, { role: "user", content: `看这个 data:image/png;base64,${PNG.slice(0, 40)}`, timestamp: 3 } as Message];
    expect(imagesIn(asText)).toEqual(["2:user picture bytes as text"]);
    // compaction is not the guard: it drops images only when the transcript outgrows the window; under it, an image
    // part goes to the model as it is — which is why the paths above are checked on what was sent, after compaction
    expect(compact(withPart, 1_000_000).compaction).toBeNull();
    expect(imagesIn(compact(withPart, 1_000_000).messages)).toEqual(imagesIn(withPart));
    expect(compact(withPart, 100).compaction?.images_dropped).toBe(1);
  });
});
