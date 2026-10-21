/**
 * Review fixes to the M0 stack, slice A: a step the user declined says so.
 */
import { describe, expect, it } from "vitest";
import { SimComputer } from "../src/executor/sim.js";
import { Gateway } from "../src/gateway/index.js";

const roles = ["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"];

describe("M0 slice A: a step the user declined", () => {
  it("says the user declined it, not why consent was asked", async () => {
    const { ExecutorService } = await import("../src/executor/service.js");
    const { Executor } = await import("../src/executor/executor.js");
    const { ConsentSigner } = await import("../src/executor/consent.js");
    const { OUTGOING_QUESTION: OQ } = await import("../src/executor/judge.js");
    const { ZH_MAIL_TEXTS: texts } = await import("../src/executor/sim.js");
    const sim = new SimComputer();
    const w = sim.addMail({ app: "信鸽", texts, flagged: [], inbox: [{ id: "m1", from: "林晓", subject: "Q3", body: ["hi"], time: "14:00" }] }).id;
    const signer = ConsentSigner.fresh();
    const gw = new Gateway(Object.fromEntries(roles.map((r) => [r, { backend: "scripted", model: "scripted" }])) as never);
    gw.script = Array(40).fill((_r: string, _s: string, u: string) => (u.includes(OQ.slice(0, 12)) ? { choice: /"目标名字命中发送词表":\s*true/.test(u) ? "sends" : "stays" } : { choice: "matches" }));
    const events: [string, any][] = [];
    const svc = new ExecutorService({ task: "t", raw: "回复林晓", executor: new Executor(sim, { task: "t", publicKey: signer.publicKey }), signer, gateway: gw, onEvent: (k, b) => events.push([k, b]),
      user: { ask: (c) => ({ option: c.options.findIndex((o) => o.kind === (c.kind === "plan" ? "approve" : "skip_step")) }) } });
    await svc.port.begin();
    await svc.port.plan({ steps: [{ purpose: "发送", objects: [`window:${w}`], consequence: "external" }] });
    for (const [target, consequence, extra] of [["row:m1", "modify_user", {}], ["reply", "modify_user", {}], ["compose_body", "modify_user", { kind: "set_value", value: "好" }], ["send", "external", {}]] as const) {
      const o = await svc.port.observe(w);
      const id = o.elements.find((e) => e.id.endsWith(`:${target}`))?.id ?? (() => { throw new Error(target + " not in " + o.elements.map((e) => e.id).join(",") + JSON.stringify(events.filter(([k]) => k === "step.end" || k === "card"))); })();
      await svc.port.act({ action: { kind: "click", window: w, target: id, ...extra } as never, epoch: o.epoch, consequence, purpose: "回复" });
    }
    const end = events.filter(([k]) => k === "step.end").map(([, b]) => b);
    expect(end.slice(0, 3).map((e) => e.status)).toEqual(["ok", "ok", "ok"]);
    expect(end.slice(3), JSON.stringify(end)).toEqual([expect.objectContaining({ status: "refused", why: "the user declined this step", executor_status: "needs_consent" })]);
  });
});
