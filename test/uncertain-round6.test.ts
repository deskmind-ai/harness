/**
 * Review of harness#66 round 6. What went out is kept whole (to a byte bound, with its true length, in no language) and
 * cut once, at the card, in the card's language; the last draw before acting is kept when it differs from the card's.
 * A stored rule the uncertain gate refuses is not recorded as used. A plan accepted again while a step is uncertain
 * signs no site grant, and the executor takes none.
 *
 * Fail on 03f9488: the journal kept 80 characters with a Chinese suffix, so the card said 「共 9x 字」 (the cut length)
 * and an English card carried 「（共 N 字）」; no final draw was kept; the refused rule was in rulesUsed; the service
 * case kills mutant M6 (a re-plan that still signs the plan's site tokens).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/index.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { ExecutorService } from "../src/executor/service.js";
import { SimComputer } from "../src/executor/sim.js";
import { fileRegistry } from "../src/registry/fs.js";
import { Workspace, build } from "../src/registry/workspace.js";
import type { Action, Driver, Element, PerformResult, WindowInfo } from "../src/executor/types.js";

const table = Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as never;
const UNSURE = { status: "unverified" as const, why: "no answer in time" };

/** A compose window of the user's: a body field with `body`, a send button; a click answers the next queued reply. */
class Compose implements Driver {
  epoch = 1; replies: PerformResult[] = [];
  info: WindowInfo = { id: "w", app: "Mail", title: "Re: contract" };
  elements: Element[];
  constructor(body: string) {
    this.elements = [
      { id: "body", role: "textArea", label: "Message", value: body, actions: ["set_value", "type"] },
      { id: "send", role: "button", label: "Send", actions: ["click"], sends: true },
      { id: "flag", role: "button", label: "Flag", actions: ["click"] },
    ];
  }
  snapshot() { return { epoch: this.epoch, locked: false, front_app: "Mail", windows: [this.info] }; }
  observe() { return { epoch: this.epoch, window: this.info, modal: null, elements: this.elements, text: "" }; }
  perform() { this.epoch += 1; return this.replies.shift() ?? { status: "ok" as const, window: "w" }; }
}

async function sendUnsure(lang: "zh" | "en", body: string, beforeActing?: (d: Compose) => void) {
  const d = new Compose(body), app = ConsentSigner.fresh();
  const ex = new Executor(d, { task: "t1", publicKey: app.publicKey, lang });
  await ex.begin(); await ex.plan({ steps: [] });
  const send: Action = { kind: "click", window: "w", target: "send" };
  let o = await ex.observe("w");
  const asked = await ex.act({ action: send, epoch: o.epoch });
  expect(asked.status).toBe("needs_consent");
  beforeActing?.(d);
  d.replies.push(UNSURE);
  expect((await ex.act({ action: send, epoch: asked.epoch, consent: app.forAction(asked.challenge!) })).status).toBe("unverified");
  o = await ex.observe("w");
  const next = await ex.act({ action: { kind: "click", window: "w", target: "flag" }, epoch: o.epoch, consequence: "modify_user" });
  expect(next.status).toBe("needs_consent");
  const intent = (ex as unknown as { jlines: Record<string, unknown>[] }).jlines.find((l) => l.kind === "intent")!;
  return { ex, card: next.challenge!, intent };
}

describe("what went out: kept whole, cut once at the card, in its language", () => {
  const body = "长".repeat(300);

  it("the journal keeps the whole text and its length, in no language", async () => {
    const { intent } = await sendUnsure("zh", body);
    const out = intent.outgoing as { value: string; chars: number }[];
    const item = out.find((o) => o.value.startsWith("长"))!;
    expect(item.value).toBe(body);
    expect(item.chars).toBe(300);
    expect(JSON.stringify(intent)).not.toMatch(/共 \d+ 字|characters in all/);
  });

  it("a Chinese card says the true length", async () => {
    const { card } = await sendUnsure("zh", body);
    const line = card.text.split("\n")[0]!;
    expect(line).toContain("共 300 字");
    expect(card.facts?.uncertain?.[0]?.outgoing.some((o) => o.value.endsWith("…（共 300 字）"))).toBe(true);
  });

  it("an English card cuts in English, with the true length", async () => {
    const { card } = await sendUnsure("en", body);
    expect(card.text).toContain("300 characters in all");
    expect(card.text).not.toMatch(/共 \d+ 字/);
  });

  it("the last draw before acting is kept when it differs from the card's, and the card names it", async () => {
    const { card, intent } = await sendUnsure("zh", "收到", (d) => { d.elements = [...d.elements, { id: "t9", role: "staticText", label: "对方刚发来：明天见", actions: [] }]; });
    expect(intent.outgoing_final).toBeDefined();
    expect(JSON.stringify(intent.outgoing_final)).toContain("对方刚发来：明天见");
    expect(JSON.stringify(intent.outgoing)).not.toContain("对方刚发来");
    expect(card.text.split("\n")[0]).toContain("对方刚发来：明天见");
  });
});

describe("a stored rule the uncertain gate refuses is not recorded as used", () => {
  it("the card's yes is what the step went by; rulesUsed stays empty", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "r6-rule-"));
    build(root, { "plan.txt": "开头\n" });
    const ws = new Workspace(root), journal = path.join(path.dirname(root), `${path.basename(root)}.jsonl`), app = ConsentSigner.fresh();
    const mk = (crash = false) => new Executor(new SimComputer(root), { task: "t1", publicKey: app.publicKey, files: { workspace: ws, registry: fileRegistry() }, journal, ...(crash ? { crashAfterFirstEffect: true } : {}) });
    const first = mk(true);
    await first.begin(); await first.plan({ steps: [] });
    await expect(first.act({ action: { kind: "file", capability: "fs.append_line", args: { target: "plan.txt", line: "x" } }, epoch: 0, consent: app.forObject("path:plan.txt", "modify_user", "t1") })).rejects.toThrow();
    const ex = mk();
    await ex.begin([], [app.forRule("改计划不用问", "path:*", "modify_user")]);
    await ex.plan({ steps: [] });
    expect(ex.uncertainCount).toBe(1);
    expect(ex.preview({ action: { kind: "file", capability: "fs.append_line", args: { target: "plan.txt", line: "y" } }, epoch: ex.currentEpoch, consequence: "modify_user" }).needs_consent).toBe(true);
    const a = { kind: "file" as const, capability: "fs.append_line", args: { target: "plan.txt", line: "y" } };
    const asked = await ex.act({ action: a, epoch: ex.currentEpoch });
    expect(asked.status).toBe("needs_consent");
    expect([...ex.consent.rulesUsed]).toEqual([]);
    expect((await ex.act({ action: a, epoch: ex.currentEpoch, consent: app.forAction(asked.challenge!) })).status).toBe("ok");
    expect([...ex.consent.rulesUsed]).toEqual([]);
  });
});

describe("a plan accepted again while a step is uncertain (mutant M6)", () => {
  it("signs no site grant, and the executor takes no plan site content", async () => {
    const sim = new SimComputer(), signer = ConsentSigner.fresh(), events: { k: string; b: Record<string, unknown> }[] = [];
    const user = sim.addMail({ app: "信鸽", texts: (await import("../src/executor/sim.js")).ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "u1", from: "林晓", subject: "Q3 预算", body: ["x"], time: "09:00" }] });
    const gw = new Gateway(table); gw.script = Array(80).fill(() => ({ choice: "matches" }));
    const ex = new Executor(sim, { task: "t", publicKey: signer.publicKey });
    const svc = new ExecutorService({ task: "t", raw: "给林晓那封邮件加旗标，再搜一下天气", executor: ex, signer, user: { ask: () => ({ option: 0 }) }, gateway: gw, onEvent: (k, b) => events.push({ k, b }) });
    await svc.port.begin();
    await svc.port.plan({ steps: [{ purpose: "加旗标", objects: [`window:${user.id}`], consequence: "modify_user" }] });
    let o = await ex.observe(user.id);
    await svc.port.act({ action: { kind: "click", window: user.id, target: o.elements.find((e) => e.label.includes("林晓"))!.id }, epoch: o.epoch, consequence: "modify_user", purpose: "选中" });
    const real = sim.perform.bind(sim); let n = 1;
    sim.perform = ((a: Action) => (n-- > 0 && a.kind === "click" ? { status: "unverified", why: "no answer" } : real(a))) as typeof sim.perform;
    o = await ex.observe(user.id);
    await svc.port.act({ action: { kind: "click", window: user.id, target: o.elements.find((e) => e.label.includes("加旗标"))!.id }, epoch: o.epoch, consequence: "modify_user", purpose: "加旗标" });
    expect(ex.uncertainCount).toBe(1);
    await svc.port.plan({ steps: [{ purpose: "搜天气", objects: [], consequence: "create", opens: [{ app: "Google Chrome", url: "https://www.google.com/search?q=weather", sends: "weather" }] }] });
    const s = svc as unknown as { siteTokens: unknown[] };
    expect(s.siteTokens).toHaveLength(0);
    expect((ex as unknown as { planSites: Map<string, unknown> }).planSites.size).toBe(0);
  });
});
