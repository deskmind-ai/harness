/**
 * The execution layer as an MCP service: the same guard reached over JSON-RPC, so a foreign runtime gets the start
 * gate, consent and the verdict without knowing any of our code.
 */
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/index.js";
import { McpExecutorServer, TOOLS } from "../src/cli/mcp.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";

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
  const call = async (name: string, args: unknown = {}) => { const r = await rpc("tools/call", { name, arguments: args }); return { ...r.result.structuredContent, isError: r.result.isError }; };
  return { rpc, call, sim, w: w.id, log };
}

describe("MCP executor service", () => {
  it("speaks the protocol and lists the seven tools", async () => {
    const { rpc } = server("none");
    const init = await rpc("initialize", { protocolVersion: "2024-11-05" });
    expect(init.result.serverInfo.name).toBe("deskmind-executor");
    expect((await rpc("tools/list")).result.tools.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    expect((await rpc("nope")).error.code).toBe(-32601);
    expect(await s0(rpc)).toBeNull();
  });

  it("a foreign runtime hits the start gate, then consent, and ends only with a verdict", async () => {
    const { call, w, sim } = server("none");
    const snap = await call("begin", { raw: "给林晓那封 Q3 预算的邮件加旗标" });
    expect(snap.windows[0].owner).toBe("user");
    const obs = await call("observe", { window: w });
    const row = obs.elements.find((e: any) => e.role === "row");
    const r1 = await call("act", { action: { kind: "click", window: w, target: row.id }, epoch: obs.epoch, consequence: "modify_user" });
    expect(r1.status).toBe("needs_plan");
    expect(r1.isError).toBe(true);
    const plan = await call("plan", { steps: [{ purpose: "加旗标", objects: [`window:${w}`], consequence: "modify_user" }] });
    expect(plan.accepted).toBe(true);
    const r2 = await call("act", { action: { kind: "click", window: w, target: row.id }, epoch: obs.epoch, consequence: "modify_user" });
    expect(r2.status).toBe("needs_consent");
    expect(r2.challenge.text).toContain("林晓");
    expect(sim.mailState(w).selected).toBeNull();
    const v = await call("verify", { summary: "加好了" });
    expect(v.verdict).toBe("pass");                      // the scripted judge; what matters is that the tool exists and runs the judge
  });

  it("with --consent auto (development) the service signs challenges itself and logs each one", async () => {
    const { call, w, sim, log } = server("auto");
    await call("begin", { raw: "给林晓那封 Q3 预算的邮件加旗标" });
    await call("plan", { steps: [{ purpose: "加旗标", objects: [`window:${w}`], consequence: "modify_user" }] });
    let obs = await call("observe", { window: w });
    const row = obs.elements.find((e: any) => e.role === "row");
    expect((await call("act", { action: { kind: "click", window: w, target: row.id }, epoch: obs.epoch, consequence: "modify_user" })).status).toBe("ok");
    obs = await call("observe", { window: w });
    const flag = obs.elements.find((e: any) => e.label === "加旗标");
    expect((await call("act", { action: { kind: "click", window: w, target: flag.id }, epoch: obs.epoch, consequence: "modify_user" })).status).toBe("ok");
    expect(sim.mailState(w).flagged).toEqual(["m1"]);
    expect(log.filter((l) => l.includes("auto_consent")).length).toBe(2);
    await call("stop");
    expect((await call("act", { action: { kind: "wait", ms: 1 }, epoch: 0 })).status).toBe("stopped");
    expect((await call("end")).receipts.length).toBeGreaterThan(0);
  });
});

async function s0(rpc: (m: string, p?: unknown) => Promise<any>) { return rpc("notifications/initialized"); }
