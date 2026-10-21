/**
 * The execution layer as an MCP service: the executor port (protocol/port.ts) over JSON-RPC, so a foreign runtime gets
 * the start gate, consent (act-and-wait: the executor asks the card and signs), the verdict and the task's status
 * without knowing any of our code. Standalone, cards are answered by `--consent auto` (approve) or not at all.
 */
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/index.js";
import { McpExecutorServer, TOOLS } from "../src/cli/mcp.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import { PORT_TOOLS } from "../src/protocol/tools.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as any;

function server(consent: "auto" | "none") {
  const gw = new Gateway(table);
  gw.script = Array(40).fill((role: string) => (role === "verify" ? { choice: "pass", reason: "看到了旗标" } : role === "intent" ? { choice: "matches" } : { choice: "r0" }));
  const sim = new SimComputer();
  const w = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "m1", from: "林晓", subject: "Q3 预算", body: ["会议时间：14:00"], time: "14:00" }] });
  const log: string[] = [];
  const s = new McpExecutorServer({ driver: () => sim, gateway: gw, consent, log: (l) => log.push(l) });
  let n = 0;
  const rpc = async (method: string, params?: unknown) => (await s.handle({ jsonrpc: "2.0", id: ++n, method, params: params as never })) as any;
  const call = async (name: string, args: unknown = {}) => { const r = await rpc("tools/call", { name, arguments: args }); return { ...r.result.structuredContent, isError: r.result.isError, content: r.result.content }; };
  return { s, rpc, call, sim, w: w.id, log };
}

describe("MCP executor service", () => {
  it("speaks the protocol and lists the port's tools (and the caller's stop switch)", async () => {
    const { rpc, s } = server("none");
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toBe("deskmind-executor");
    expect(s.steerPush).toBe(false);
    expect((await rpc("tools/list")).result.tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect(TOOLS.map((t) => t.name)).toEqual(["begin", "snapshot", "observe", "classify", "act", "file", "plan", "ask_user", "answer", "read_skill", "finish", "steers", "end", "stop"]);
    expect(TOOLS.map((t) => t.inputSchema)).toEqual(PORT_TOOLS.map((t) => JSON.parse(JSON.stringify(t.parameters))));
    expect((await rpc("nope")).error.code).toBe(-32601);
    expect(await rpc("notifications/initialized")).toBeNull();
    // a client that asks for the steer push gets it
    await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: { experimental: { deskmind: { steer: "push" } } } });
    expect(s.steerPush).toBe(true);
  });

  it("a foreign runtime hits the start gate, then the plan card (the executor asks and signs), and ends only with a verdict", async () => {
    const { call, w, sim, log } = server("auto");
    expect((await call("observe", { window: w })).content[0].text).toBe("begin first");
    const b = await call("begin", { raw: "给林晓那封 Q3 预算的邮件加旗标" });
    expect(b.ended).toBe(false);
    expect(b.snapshot.windows[0].owner).toBe("user");
    let obs = await call("observe", { window: w });
    const row = obs.elements.find((e: any) => e.role === "row");
    const r1 = await call("act", { action: { kind: "click", window: w, target: row.id }, epoch: obs.epoch, consequence: "modify_user", purpose: "选中" });
    expect(r1.isError).toBe(true);
    expect(r1.text).toContain("先交计划");
    const plan = await call("plan", { steps: [{ purpose: "加旗标", objects: [`window:${w}`], consequence: "modify_user" }] });
    expect(plan.isError).toBe(false);
    expect(log.some((l) => l.includes("auto_consent") && l.includes('"kind":"plan"'))).toBe(true);
    expect((await call("act", { action: { kind: "click", window: w, target: row.id }, epoch: obs.epoch, consequence: "modify_user", purpose: "选中" })).isError).toBe(false);
    obs = await call("observe", { window: w });
    const flag = obs.elements.find((e: any) => e.label === "加旗标");
    expect((await call("act", { action: { kind: "click", window: w, target: flag.id }, epoch: obs.epoch, consequence: "modify_user", purpose: "加旗标" })).isError).toBe(false);
    expect(sim.mailState(w).flagged).toEqual(["m1"]);
    expect(await call("steers")).toMatchObject({ steers: [] });
    const f = await call("finish", { outcome: "done", summary: "加好了" });
    expect(f.done).toBe(true);
    const r = await call("end");
    expect(r.status).toBe("succeeded");
    expect(r.result_card.kind).toBe("result");
  });

  it("with --consent none no card is answered: a step that needs the user's yes is not done, and the task ends", async () => {
    const { call, w, sim, log } = server("none");
    await call("begin", { raw: "给林晓那封 Q3 预算的邮件加旗标" });
    const plan = await call("plan", { steps: [{ purpose: "加旗标", objects: [`window:${w}`], consequence: "modify_user" }] });
    expect(log.some((l) => l.includes("card_unanswered"))).toBe(true);
    expect(plan.done).toBe(true);
    const obs = await call("observe", { window: w });
    const row = obs.elements.find((e: any) => e.role === "row");
    const r = await call("act", { action: { kind: "click", window: w, target: row.id }, epoch: obs.epoch, consequence: "modify_user", purpose: "选中" });
    expect(r).toMatchObject({ isError: true, done: true });
    expect(sim.mailState(w).selected).toBeNull();
    expect((await call("end")).status).toBe("failed");
  });

  it("arguments are checked against the shared schema; the caller's stop refuses every later step", async () => {
    const { call } = server("auto");
    await call("begin", { raw: "看看" });
    const bad = await call("act", { action: { kind: "wait", ms: 1 }, epoch: 0 });
    expect(bad.isError).toBe(true);
    expect(bad.content[0].text).toContain("purpose");
    expect((await call("stop")).stopped).toBe(true);
    const r = await call("act", { action: { kind: "wait", ms: 1 }, epoch: 0, consequence: "read", purpose: "等" });
    expect(r).toMatchObject({ isError: true, done: true });
    expect((await call("end")).status).toBe("stopped");
  });
});
