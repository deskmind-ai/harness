/**
 * The frontier runtime's three lines with a scripted model: nothing of the user's changes and nothing is sent without
 * a consent the user gave on a card; "done" is a claim an independent verdict has to back; a lock, a stop and a
 * declined action end honestly. The scripted model is adversarial where it matters (claims done with nothing done).
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
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import { FrontierRuntime, type RuntimeUser } from "../src/runtime/loop.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";
import { fileRegistry } from "../src/registry/fs.js";
import { Workspace, build } from "../src/registry/workspace.js";

const scriptedTable = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;
const model = { model: { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as any };

/** The last tool result's JSON (what the model would read the epoch and ids from). */
const last = (messages: Message[]): any => { const m = [...messages].reverse().find((x) => x.role === "toolResult") as any; const t = m?.content?.[0]?.text ?? "{}"; try { return JSON.parse(t.split("\n")[0]); } catch { return {}; } };
const act = (action: Record<string, unknown>, consequence: string, purpose = "step") => (ms: Message[]): Step => ({ calls: [{ name: "computer_act", args: { action, epoch: last(ms).epoch ?? last(ms).after?.epoch, consequence, purpose } }] });
const epochOf = (ms: Message[]) => { const j = last(ms); return j.after?.epoch ?? j.epoch; };

function mail() {
  const sim = new SimComputer();
  const w = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: ["m2"], inbox: [
    { id: "m1", from: "林晓", subject: "Q3 预算", body: ["你好，关于Q3 预算，", "会议时间：14:00", "谢谢"], time: "14:00" },
    { id: "m2", from: "林晓", subject: "周会纪要", body: ["会议时间：10:00"], time: "10:00" },
    { id: "m3", from: "苏然", subject: "Q3 预算", body: ["会议时间：09:30"], time: "09:30" },
  ] });
  return { sim, w: w.id };
}

/** A user who answers cards by kind: approve what `yes` allows, decline the rest. */
function user(policy: (card: Card) => Answer | null) {
  const cards: Card[] = [];
  const u: RuntimeUser & { cards: Card[] } = { cards, ask: (c) => { cards.push(c); return policy(c); } };
  return u;
}
const approveAll = (c: Card): Answer => ({ option: c.options.findIndex((o) => o.kind === "approve") });

function runtime(sim: SimComputer, steps: Step[], u: RuntimeUser, verify: unknown = { verdict: "pass", reason: "ok" }, extra: Partial<ConstructorParameters<typeof FrontierRuntime>[0]> = {}) {
  const app = ConsentSigner.fresh();
  const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey });
  const gw = new Gateway(scriptedTable);
  // the judge asks the intent role before every consequential action; unanswered, it falls through to consent
  gw.script = Array(60).fill((role: string) => (role === "verify" ? verify : role === "intent" ? { choice: "matches" } : { outcome: "error", error: "unexpected role " + role }));
  const seen: Message[][] = [];
  const rt = new FrontierRuntime({ task: "t1", raw: "在信鸽里回复林晓关于“Q3 预算”的邮件：“收到，谢谢”", executor: ex, signer: app, user: u, gateway: gw, model: { ...model, streamFn: scriptedStream(steps, seen) }, ...extra });
  return { rt, ex, gw, seen };
}

describe("frontier runtime: consent", () => {
  it("a plan the user approved covers the user's window; sending still asks once, with the content; the end is verified", async () => {
    const { sim, w } = mail();
    const steps: Step[] = [
      { calls: [{ name: "computer_snapshot", args: {} }] },
      { calls: [{ name: "plan", args: { steps: [{ purpose: "打开林晓的 Q3 预算邮件并回复", objects: [`window:${w}`], consequence: "modify_user" }, { purpose: "发送回复", objects: [`window:${w}`], consequence: "external" }] } }] },
      { calls: [{ name: "computer_observe", args: { window: w } }] },
      act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "modify_user"),
      act({ kind: "click", window: w, target: `${w}:0:reply` }, "modify_user"),
      act({ kind: "set_value", window: w, target: `${w}:0:compose_body`, value: "收到，谢谢" }, "modify_user"),
      act({ kind: "click", window: w, target: `${w}:0:send` }, "external"),
      { calls: [{ name: "finish", args: { outcome: "done", summary: "已在用户的信鸽窗口回复并发送" } }] },
    ];
    const u = user(approveAll);
    const { rt, seen } = runtime(sim, steps, u);
    const r = await rt.run();
    expect(r.status).toBe("succeeded");
    expect(sim.mailState(w).replies).toEqual([{ to: "m1", body: "收到，谢谢" }]);
    expect(u.cards.map((c) => c.kind)).toEqual(["plan", "action"]);
    expect(u.cards[1]!.text).toContain("发送");
    expect(u.cards[1]!.text).toContain("发出去");
    expect(r.consents.map((c) => c.scope)).toEqual(["object", "action"]);
    expect(r.verdicts).toEqual([{ verdict: "pass", reason: "ok" }]);
    // what the model was shown: the base skill and the snapshot with owners
    const sys = seen[0]![0] as any;
    expect(sys.content).toContain("看得宽，动得窄");
    expect((seen[0]![1] as any).content).toContain('"owner":"user"');
  });

  it("without a plan, the first touch of the user's window asks on the spot; a declined send is never sent and the run does not claim success", async () => {
    const { sim, w } = mail();
    const steps: Step[] = [
      { calls: [{ name: "computer_observe", args: { window: w } }] },
      act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "modify_user"),
      act({ kind: "click", window: w, target: `${w}:0:reply` }, "create"),          // the model under-classes: the floor still says modify_user
      act({ kind: "set_value", window: w, target: `${w}:0:compose_body`, value: "收到，谢谢" }, "modify_user"),
      act({ kind: "click", window: w, target: `${w}:0:send` }, "create"),           // under-classed again: the Send button's structure says external
      { calls: [{ name: "finish", args: { outcome: "cannot", summary: "用户不让发送" } }] },
    ];
    const u = user((c) => (c.kind === "action" && c.text.includes("发送") ? { option: c.options.findIndex((o) => o.kind === "skip_step") } : approveAll(c)));
    const { rt } = runtime(sim, steps, u);
    const r = await rt.run();
    expect(r.status).toBe("failed");
    expect(r.reason).toContain("cannot");
    expect(sim.mailState(w).replies).toEqual([]);
    expect(u.cards.filter((c) => c.kind === "action").length).toBe(4);     // every action in the user's window asked, then the send
    expect(u.cards.at(-1)!.text).toContain("发出去");
  });

  it("a model that claims done with nothing done is not believed: the verdict fails, and the honest end is unconfirmed", async () => {
    const { sim, w } = mail();
    const steps: Step[] = [
      { calls: [{ name: "finish", args: { outcome: "done", summary: "回复好了" } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "真的回复好了" } }] },
      { calls: [{ name: "finish", args: { outcome: "unconfirmed", summary: "", missing: ["没有看到发送后的状态"] } }] },
    ];
    const u = user(approveAll);
    const { rt, seen } = runtime(sim, steps, u, { verdict: "fail", reason: "收件箱里没有回复" });
    const r = await rt.run();
    expect(r.status).toBe("unconfirmed");
    expect(r.verdicts.length).toBe(2);
    expect(sim.mailState(w).replies).toEqual([]);
    const shown = (seen[1]!.at(-1) as any).content[0].text;
    expect(shown).toContain("核对没有通过");
  });

  it("an unknown verdict is not success either; retries run out into unconfirmed", async () => {
    const { sim } = mail();
    const steps: Step[] = Array(4).fill({ calls: [{ name: "finish", args: { outcome: "done", summary: "x" } }] });
    const { rt } = runtime(sim, steps, user(approveAll), { verdict: "unknown", reason: "看不到" });
    const r = await rt.run();
    expect(r.status).toBe("unconfirmed");
  });

  it("a turn that only talks is sent back to the tools; the model's words never end a run", async () => {
    const { sim } = mail();
    const steps: Step[] = [{ text: "任务完成了。" }, { text: "已经完成。" }, { calls: [{ name: "finish", args: { outcome: "cannot", summary: "算了" } }] }];
    const { rt, seen } = runtime(sim, steps, user(approveAll));
    const r = await rt.run();
    expect(r.status).toBe("failed");
    expect((seen[1]!.at(-1) as any).content).toContain("请继续");
  });
});

describe("frontier runtime: steer", () => {
  it("a changed request reaches the model before its next turn and is what the verdict judges against", async () => {
    const { sim, w } = mail();
    let steered = false;
    const steps: Step[] = [
      { calls: [{ name: "computer_observe", args: { window: w } }] },
      (ms) => { if (!steered) { steered = true; rt.steer("算了，不用回复了，告诉我那封邮件里会议几点就行"); } return { calls: [{ name: "computer_observe", args: { window: w } }] }; },
      { calls: [{ name: "answer", args: { text: "14:00" } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "已回答会议时间" } }] },
    ];
    const { rt, seen, gw } = runtime(sim, steps, user(approveAll));
    const asked: string[] = [];
    gw.script = Array(30).fill((role: string, _sys: string, u: string) => { if (role === "intent") return { choice: "matches" }; asked.push(u); return { verdict: "pass", reason: "ok" }; });
    const r = await rt.run();
    expect(r.status).toBe("succeeded");
    expect(r.counters["steers"]).toBe(1);
    // the third model call saw the new words as a user message after the steer
    const third = seen[2]!.map((m: any) => (typeof m.content === "string" ? m.content : "")).join("\n");
    expect(third).toContain("用户改了要求");
    expect(third).toContain("会议几点");
    // the verdict was asked about the new request, not the old one
    expect(asked[0]).toContain("会议几点");
    expect(asked[0]).not.toContain("收到，谢谢");
  });
});

describe("frontier runtime: stop, lock, files", () => {
  it("a locked screen ends as an environment stop before any model call", async () => {
    const { sim } = mail();
    sim.lock();
    const { rt, seen } = runtime(sim, [], user(approveAll));
    const r = await rt.run();
    expect(r.status).toBe("environment");
    expect(seen.length).toBe(0);
  });

  it("the app's stop ends the run; a later action is refused by the executor", async () => {
    const { sim, w } = mail();
    const steps: Step[] = [
      { calls: [{ name: "computer_observe", args: { window: w } }] },
      (ms) => { rt.stop("user pressed stop"); return act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "modify_user")(ms); },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "x" } }] },
    ];
    const { rt, ex } = runtime(sim, steps, user(approveAll));
    const r = await rt.run();
    expect(r.status).toBe("stopped");
    expect(ex.receipts.every((x) => x.result.status !== "ok")).toBe(true);
    expect(sim.mailState(w).selected).toBeNull();
  });

  it("files: a file that existed at begin is the user's (append asks), a new file is the task's (no card); verified at the end", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "rt-fs-"));
    build(root, { "todo.txt": "交房租\n" });
    const ws = new Workspace(root);
    const sim = new SimComputer(root);
    const steps: Step[] = [
      { calls: [{ name: "fs_create_text", args: { parent: ".", name: "备忘.txt", text: "买牛奶" } }] },
      { calls: [{ name: "fs_append_line", args: { target: "todo.txt", line: "买牛奶" } }] },
      { calls: [{ name: "finish", args: { outcome: "done", summary: "新建了 备忘.txt，并在 todo.txt 末尾加了一行" } }] },
    ];
    const u = user(approveAll);
    const { rt } = runtime(sim, steps, u, { verdict: "pass", reason: "ok" }, { workspace: ws, registry: fileRegistry(), raw: "新建 备忘.txt 写上买牛奶，再把买牛奶加到 todo.txt 末尾" } as any);
    const r = await rt.run();
    expect(r.status).toBe("succeeded");
    expect(ws.read("备忘.txt")).toBe("买牛奶");
    expect(ws.read("todo.txt")).toBe("交房租\n买牛奶\n");
    expect(u.cards.map((c) => c.kind)).toEqual(["action"]);
    expect(u.cards[0]!.text).toContain("todo.txt");
    expect(r.consents).toEqual([{ scope: "action", object: "path:todo.txt", consequence: "modify_user" }]);
  });
});
