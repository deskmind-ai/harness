/**
 * H-卡片 (m3-m6 plan §1, §3, §7 H2–H5):
 *  H2  a card's headline and beyond[] are made from what its yes signs, in the same pass: beyond = the signed objects
 *      and sites, no more and no fewer; the headline names the element and the selected item from the same look;
 *      option.detail from the reading's own field; the plan card's text has no line-end markers.
 *  H3  one run, one language: fixed text and the actions' plain words (Capability.human) in the app's language, never
 *      `k=「v」`; the runtime is told the language.
 *  H4  every wait for the user says what it waits for and until when; its resumed says how it ended.
 *  H5  a steer is never refused for an open card (but the card about an interrupted step): the card is voided first
 *      (ask_void steer) and the words taken; a voided card never yields consent.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { appRun, LineReader, toProtocol } from "../src/cli/app.js";
import type { AppEvent } from "../src/protocol/events.js";
import { SimComputer, ZH_MAIL_TEXTS } from "../src/executor/sim.js";
import { OUTGOING_QUESTION } from "../src/executor/judge.js";
import { Gateway } from "../src/gateway/index.js";
import { scriptedStream, type Step } from "../src/runtime/scripted.js";
import type { Action, Driver, Element, Snapshot, WindowInfo } from "../src/executor/types.js";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { FrontierRuntime } from "../src/host/frontier.js";
import type { Answer, Card } from "../src/protocol/cards.js";
import { Workspace, build } from "../src/registry/workspace.js";
import { fileRegistry } from "../src/registry/fs.js";

const roles = ["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"];
const table = Object.fromEntries(roles.map((r) => [r, { backend: "scripted", model: "scripted" }])) as never;
const MODEL = { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 1e6, maxTokens: 1e5 } as never;
const judges = (extra?: (role: string, u: string) => unknown) => {
  const gw = new Gateway(table);
  gw.script = Array(300).fill((role: string, _s: string, u: string) => extra?.(role, u) ?? (role === "verify" ? { choice: "pass", reason: "做完了" } : u.includes(OUTGOING_QUESTION.slice(0, 12)) ? { choice: /"目标名字命中发送词表":\s*true/.test(u) ? "sends" : "stays" } : { choice: "matches" }));
  return gw;
};
const lastJson = (ms: Message[]): any => { const m = [...ms].reverse().find((x) => x.role === "toolResult") as any; try { return JSON.parse(m.content[0].text.split("\n")[0]); } catch { return {}; } };
const epochOf = (m: Message[]) => lastJson(m).after?.epoch ?? lastJson(m).epoch;
const act = (action: Record<string, unknown>, consequence: string, extra: Record<string, unknown> = {}) => (m: Message[]): Step => ({ calls: [{ name: "computer_act", args: { action, epoch: epochOf(m), consequence, purpose: "做", ...extra } }] });
const look = (w: string): Step => ({ calls: [{ name: "computer_observe", args: { window: w } }] });
const finish: Step = { calls: [{ name: "finish", args: { outcome: "done", summary: "做完了" } }] };
const waitFor = async (cond: () => unknown, ms = 8000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) throw new Error("timed out waiting"); await new Promise((r) => setTimeout(r, 2)); } };

const mailSim = () => {
  const sim = new SimComputer();
  const w = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "m1", from: "林晓", subject: "Q3 预算", body: ["你好，关于Q3 预算，", "谢谢"], time: "14:00" }] }).id;
  return { sim, w };
};

/** FrontierRuntime on a sim, every card approved; the cards and the runtime's events kept. */
function frontier(sim: SimComputer, steps: Step[], o: { raw?: string; gw?: Gateway; lang?: "zh" | "en"; pick?: (c: Card) => Answer } = {}) {
  const app = ConsentSigner.fresh();
  const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, ...(o.lang ? { lang: o.lang } : {}) });
  const cards: Card[] = [], events: { k: string; b: Record<string, any> }[] = [];
  const user = { ask: (c: Card): Answer => { cards.push(c); return o.pick?.(c) ?? { option: c.options.findIndex((x) => x.kind === "approve") }; } };
  const rt = new FrontierRuntime({ task: "t1", raw: o.raw ?? "整理信鸽里的邮件", executor: ex, signer: app, user, gateway: o.gw ?? judges(), model: { model: MODEL, streamFn: scriptedStream(steps) }, onEvent: (k, b) => events.push({ k, b }), ...(o.lang ? { lang: o.lang } : {}) });
  return { rt, ex, cards, events };
}

// --- H2 -------------------------------------------------------------------------------------------------------------

/** A driver with one mail-like window: rows (one selected), a 「删除」 button. `opened`: the window comes up from the
 *  task's own open_window (hands#54 opened_window: DeskMind opened it, its content is the user's). */
class MailDesk implements Driver {
  epoch = 1;
  wins: { info: WindowInfo; elements: Element[] }[] = [];
  constructor(private opened: boolean) {
    if (!opened) this.wins.push(this.mail());
  }
  private mail() {
    const info: WindowInfo = { id: "com.mail#3", app: "com.mail", app_name: "邮件", title: "收件箱" };
    const elements: Element[] = [
      { id: "row:1", role: "row", label: "林晓 · Q3 预算", actions: ["click"], focused: true },
      { id: "row:2", role: "row", label: "王芳 · 周报", actions: ["click"] },
      { id: "btn:del", role: "button", label: "删除", actions: ["click"] },
      { id: "search", role: "textField", label: "搜索", actions: ["set_value"], focused: false },
    ];
    return { info, elements };
  }
  snapshot(): Snapshot { return { epoch: this.epoch, locked: false, front_app: "DeskMind", windows: this.wins.map((w) => w.info) }; }
  observe(id: string) { const w = this.wins.find((x) => x.info.id === id)!; return { epoch: this.epoch, window: w.info, modal: null, elements: w.elements, text: "" }; }
  perform(action: Action) {
    this.epoch += 1;
    if (action.kind === "open_window" && this.opened) { const m = this.mail(); this.wins.push(m); return { status: "ok" as const, window: m.info.id, opened_window: m.info }; }
    return { status: "ok" as const, window: "window" in action ? action.window : undefined };
  }
}

describe("H2: a card's headline and beyond[] are what its yes signs (one pass)", () => {
  it("action cards, table: (the user's window | a window DeskMind opened) × (zh | en) → beyond = the challenge's signed object; the headline names the element and the selected mail", async () => {
    const rows: string[] = [];
    for (const opened of [false, true]) for (const lang of ["zh", "en"] as const) {
      const desk = new MailDesk(opened);
      const app = ConsentSigner.fresh();
      const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, lang });
      await ex.begin(); await ex.plan({ steps: [] });
      if (opened) expect((await ex.act({ action: { kind: "open_window", app: "邮件" }, epoch: ex.currentEpoch })).status).toBe("ok");
      const o = await ex.observe("com.mail#3");
      const r = await ex.act({ action: { kind: "click", window: "com.mail#3", target: "btn:del" }, epoch: o.epoch });
      const row = `opened ${opened} × ${lang}`;
      rows.push(row);
      expect(r.status, row).toBe("needs_consent");
      const c = r.challenge!;
      // what a yes signs: an action token for this action on c.object (the digest is of action, object, class, binding)
      const tok = app.forAction(c);
      expect(c.beyond, row).toEqual([{ kind: "object", ref: tok.object, label: c.facts!.object_label }]);
      expect(c.site, row).toBeUndefined();
      expect(c.headline, row).toContain(lang === "en" ? "“删除”" : "「删除」");
      expect(c.headline, row).toContain("林晓 · Q3 预算");           // the selected mail, by the selection flag
      expect(c.headline, row).not.toContain("王芳");                  // not selected: not named
      if (opened) expect(c.facts!.object_label, row).toContain("DeskMind");
      // the card the app gets carries them; the model's view does not
      expect(JSON.stringify(r).includes("headline")).toBe(true);
    }
    expect(rows).toHaveLength(4);
  });

  it("a file action's card: beyond is the file the yes signs; the headline is the action in plain words", async () => {
    for (const lang of ["zh", "en"] as const) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "h2-file-"));
      build(root, { "notes.txt": "一" });
      const app = ConsentSigner.fresh();
      const ex = new Executor(new SimComputer(root), { task: "t1", publicKey: app.publicKey, lang, files: { workspace: new Workspace(root), registry: fileRegistry() } });
      await ex.begin(); await ex.plan({ steps: [] });
      await ex.act({ action: { kind: "file", capability: "fs.read_text", args: { target: "notes.txt" } }, epoch: ex.currentEpoch });
      const r = await ex.act({ action: { kind: "file", capability: "fs.trash", args: { target: "notes.txt" } }, epoch: ex.currentEpoch });
      expect(r.status).toBe("needs_consent");
      const tok = app.forAction(r.challenge!);
      expect(r.challenge!.beyond).toEqual([{ kind: "object", ref: tok.object, label: expect.any(String) }]);
      expect(r.challenge!.headline).toBe(lang === "en" ? "Move “notes.txt” to the trash?" : "要把「notes.txt」移到废纸篓吗？");
    }
  });

  it("plan cards, table: (objects | sites into the user's browser | both) → beyond = the objects and hosts signed on accept; no line-end markers", async () => {
    const browser = () => {
      const sim = new SimComputer();
      sim.capabilities.urlInOwnBrowserWindow = false;      // a url goes to the user's open browser window (rc11's floor)
      const m = sim.addMail({ app: "信鸽", texts: ZH_MAIL_TEXTS, flagged: [], inbox: [{ id: "m1", from: "林晓", subject: "Q3 预算", body: ["x"], time: "14:00" }] }).id;
      const b = sim.addBrowser("Google Chrome", [{ title: "新标签页", url: "about:blank" }]).id;
      return { sim, m, b };
    };
    const cases: { name: string; plan: (m: string, b: string) => unknown[] }[] = [
      { name: "objects", plan: (m) => [{ purpose: "给邮件加旗标", objects: [`window:${m}`], consequence: "modify_user" }] },
      { name: "sites", plan: (_m, b) => [{ purpose: "查天气", objects: [], consequence: "create", opens: [{ app: "Google Chrome", url: "https://www.google.com/search?q=weather", sends: "搜索 weather" }, { app: "Google Chrome", url: "https://wttr.in/" }] }].map((s) => ({ ...s, objects: [`window:${b}`] })) },
      // (review of #77: the user's Chrome window, named by no step: its site token is signed on it, so the card says so)
      { name: "sites, no objects", plan: () => [{ purpose: "查天气", objects: [], consequence: "create", opens: [{ app: "Google Chrome", url: "https://wttr.in/" }] }] },
      { name: "both", plan: (m, b) => [{ purpose: "加旗标", objects: [`window:${m}`], consequence: "modify_user" }, { purpose: "查天气", objects: [`window:${b}`], consequence: "create", opens: [{ app: "Google Chrome", url: "https://wttr.in/" }] }] },
    ];
    for (const k of cases) {
      const { sim, m, b } = browser();
      const { rt, cards, events } = frontier(sim, [{ calls: [{ name: "plan", args: { steps: k.plan(m, b) } }] }, finish]);
      await rt.run();
      const card = cards.find((c) => c.kind === "plan")!;
      expect(card, k.name).toBeTruthy();
      const confirmed = events.find((e) => e.k === "plan.confirmed")!.b;
      // the signed set, from what accept signed: object tokens, and site tokens (place + hosts); a place is the user's
      // when the ledger says so — the sim's windows are all the user's here
      const sites = confirmed.sites as Record<string, { hosts: string[]; sends: Record<string, string[]> }>;
      const userWindows = new Set(sim.snapshot().windows.map((w) => `window:${w.id}`));
      const signedObjects = [...new Set([...(confirmed.objects as string[]), ...Object.keys(sites).filter((o) => userWindows.has(o))])];
      const signedSites = Object.entries(sites).flatMap(([o, g]) => g.hosts.map((h) => `${o}|${h}`));
      expect(card.beyond!.filter((x) => x.kind === "object").map((x) => x.ref).sort(), k.name).toEqual(signedObjects.sort());
      expect(card.beyond!.filter((x) => x.kind === "site").map((x) => `${x.at}|${x.ref}`).sort(), k.name).toEqual(signedSites.sort());
      expect(card.headline, k.name).toBeTruthy();
      for (const x of card.beyond!) expect(card.headline, k.name).toContain(x.label);
      // "takes content there" only when something goes there
      const sends = Object.values(sites).some((g) => Object.values(g.sends ?? {}).some((v) => v.length));
      expect(card.headline!.includes("把内容带到"), k.name).toBe(sends);
      expect(card.text, k.name).not.toMatch(/——/);
      expect(card.plan!.steps.length, k.name).toBeGreaterThan(0);
    }
  });

  it("an ambiguity card: each reading's second line is the detail the plan role wrote for it (a field, not words)", async () => {
    const { sim, w } = mailSim();
    // the reading judge cannot tell them apart: the user settles it
    const gw = judges((role, u) => (u.includes("说不清") ? { choice: "r2" } : undefined));
    const steps: Step[] = [{ calls: [{ name: "plan", args: { steps: [{ purpose: "回复", objects: [`window:${w}`], consequence: "modify_user" }],
      readings: [{ point: "上周的报告", reading: "Q3 预算", alternatives: ["周报"], evidence: [], details: ["林晓 10-20 发的邮件", "王芳每周五发的那封"] }] } }] }, finish];
    const { rt, cards } = frontier(sim, steps, { gw, pick: (c) => ({ option: c.kind === "ambiguity" ? 0 : c.options.findIndex((x) => x.kind === "approve") }) });
    await rt.run();
    const card = cards.find((c) => c.kind === "ambiguity")!;
    expect(card).toBeTruthy();
    expect(card.options.filter((o) => o.kind === "reading").map((o) => [o.text, o.detail])).toEqual([["Q3 预算", "林晓 10-20 发的邮件"], ["周报", "王芳每周五发的那封"]]);
    expect(card.headline).toBe(card.text);
  });
});

// --- H3 -------------------------------------------------------------------------------------------------------------

/** Every string the app shows the user in a run's events: cards (text, headline, options, details, beyond labels), the
 *  step lines (human), the result card. Names are quoted (「」 or “ ”) and checked apart. */
function shown(evs: AppEvent[]): string[] {
  const out: string[] = [];
  const card = (c: any) => { if (!c) return; out.push(c.text, c.headline ?? "", ...c.options.flatMap((o: any) => [o.text, o.detail ?? ""]), ...(c.beyond ?? []).map((b: any) => b.label)); };
  for (const e of evs as any[]) {
    if (e.kind === "ask") card(e.card);
    if (e.kind === "step" && e.human) out.push(e.human);
    if (e.kind === "task_done") card(e.result_card);
  }
  return out.filter(Boolean);
}
const unquoted = (s: string) => s.replace(/「[^」]*」/g, "").replace(/“[^”]*”/g, "").replace(/"[^"]*"/g, "");

describe("H3: one run, one language; actions in plain words", () => {
  it("recorded runs zh / en: no k=「v」 anywhere; en shows no Chinese outside quoted names, zh no English words outside them", async () => {
    for (const lang of ["zh", "en"] as const) {
      const scope = fs.mkdtempSync(path.join(os.tmpdir(), "h3-"));
      build(scope, { "notes.txt": "一\n", "todo.txt": "买牛奶\n" });
      const steps: Step[] = [
        { calls: [{ name: "plan", args: { steps: [{ purpose: lang === "en" ? "tidy the notes" : "整理笔记", objects: ["path:notes.txt", "path:todo.txt"], consequence: "modify_user" }] } }] },
        { calls: [{ name: "fs_read_text", args: { target: "notes.txt" } }] },
        { calls: [{ name: "fs_read_text", args: { target: "todo.txt" } }] },
        { calls: [{ name: "fs_append_line", args: { target: "todo.txt", line: "eggs" } }] },
        { calls: [{ name: "fs_replace_text", args: { target: "notes.txt", text: "\n" } }] },
        { calls: [{ name: "fs_create_text", args: { parent: ".", name: "a.txt", text: "hi" } }] },
        { calls: [{ name: "fs_trash", args: { target: "a.txt" } }] },
        { calls: [{ name: "finish", args: { outcome: "done", summary: lang === "en" ? "done" : "做完了" } }] },
      ];
      const input = new PassThrough();
      const evs: AppEvent[] = [];
      const write = (c: unknown) => input.write(JSON.stringify(c) + "\n");
      const out = (e: AppEvent) => {
        evs.push(e);
        if (e.kind === "ask") setTimeout(() => write({ type: "answer", ask_id: e.ask_id, option: e.card.options.findIndex((x) => x.kind === "approve") }), 1);
        if (e.kind === "task_done") input.end();
      };
      await appRun({ run_id: `run_h3${lang}`, raw: lang === "en" ? "tidy my notes" : "整理笔记", config: "ds-flash", scope, lang }, { runs: fs.mkdtempSync(path.join(os.tmpdir(), "h3-runs-")), out, input: new LineReader(input), linger: 0,
        inject: { driver: new SimComputer(scope), gateway: judges(), model: { model: MODEL, streamFn: scriptedStream(steps) } } });
      const texts = shown(evs);
      expect(evs.find((e) => e.kind === "task_done"), lang).toBeTruthy();
      expect(texts.length, lang).toBeGreaterThan(5);
      for (const t of texts) {
        expect(t, `${lang}: ${t}`).not.toMatch(/\w+=「/);
        // (CJK ideographs and CJK punctuation — 「」（）、。： — none in English outside quoted names)
        if (lang === "en") expect(unquoted(t), `en: ${t}`).not.toMatch(/[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/);
        else expect(unquoted(t).replace(/\b(OK|PDF|URL|DeskMind)\b/g, ""), `zh: ${unquoted(t)}`).not.toMatch(/[A-Za-z]{3,}/);
      }
      // the result card lists the steps in the run's language (the journal's words)
      const rc = (evs.find((e) => e.kind === "task_done") as any).result_card;
      expect(rc.text, lang).toContain(lang === "en" ? "“todo.txt”" : "「todo.txt」");
    }
  }, 30_000);

  it("the runtime is told the language its words for the user are in", async () => {
    for (const lang of ["zh", "en"] as const) {
      const seen: Message[][] = [];
      const { sim } = mailSim();
      const { rt } = frontier(sim, [finish], { lang });
      (rt as any).o.model.streamFn = scriptedStream([finish], seen as never);
      await rt.run();
      const sys = JSON.stringify(seen[0]?.[0] ?? "");
      expect(sys, lang).toContain(lang === "en" ? "用户界面的语言：英文" : "用户界面的语言：中文");
    }
  });
});

// --- H4 -------------------------------------------------------------------------------------------------------------

describe("H4: a wait for the user says what it waits for and until when; its resumed says how it ended", () => {
  /** A desk whose user is busy for `busyPolls` snapshots; hands' quiet threshold 3 s. */
  class BusyDesk implements Driver {
    epoch = 1; polls = 0;
    info: WindowInfo = { id: "com.netease.163music#1", app: "com.netease.163music", app_name: "网易云音乐", title: "", needs_foreground: true };
    constructor(private busyPolls: number) {}
    snapshot(): Snapshot { this.polls += 1; return { epoch: this.epoch, locked: false, front_app: "x", windows: [this.info], user_active: this.polls <= this.busyPolls, user_quiet_s: 3 }; }
    observe() { return { epoch: this.epoch, window: this.info, modal: null, elements: [{ id: "e1", role: "button", label: "播放", actions: ["click"] }], text: "" }; }
    perform() { this.epoch += 1; return { status: "ok" as const, window: this.info.id }; }
  }
  async function waitRun(busyPolls: number, o: { stopAt?: number } = {}) {
    let now = 1_700_000_000_000;
    const events: { k: string; b: Record<string, any> }[] = [];
    const desk = new BusyDesk(busyPolls);
    const app = ConsentSigner.fresh();
    const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, now: () => now, userWait: { ms: 10_000, pollMs: 1 }, onEvent: (k, b) => { events.push({ k, b }); } });
    await ex.begin(); await ex.plan({ steps: [] });
    const o1 = await ex.observe(desk.info.id);
    const orig = desk.snapshot.bind(desk);
    desk.snapshot = () => { now += 1000; if (o.stopAt !== undefined && desk.polls >= o.stopAt) ex.stop(); return orig(); };
    const r = await ex.act({ action: { kind: "click", window: desk.info.id, target: "e1" }, epoch: o1.epoch });
    return { r, events, start: now };
  }
  const proto = (events: { k: string; b: Record<string, any> }[]) => events.map((e) => toProtocol(e.k, e.b)).filter((x): x is any => !!x && (x.kind === "waiting" || x.kind === "resumed"));

  it("our own wait, table: (the user pauses | keeps on until it gives up | the task is stopped) → waiting{why, quiet_s, needs_front, app_label, started_at, gives_up_at} then resumed{why, waited_s}", async () => {
    const rows = [
      { name: "pauses", busy: 3, end: "paused", status: "needs_consent" },        // (then the card: the window is the user's)
      { name: "gives up", busy: 1000, end: "timed_out", status: "blocked" },
      { name: "stopped", busy: 1000, stopAt: 4, end: "stopped", status: "stopped" },
    ];
    for (const row of rows) {
      const { r, events } = await waitRun(row.busy, row.stopAt !== undefined ? { stopAt: row.stopAt } : {});
      const p = proto(events);
      expect(p.map((x) => x.kind), row.name).toEqual(["waiting", "resumed"]);
      const [w, res] = p;
      expect(w, row.name).toMatchObject({ kind: "waiting", why: "user_active", quiet_s: 3, needs_front: true, app_label: "网易云音乐" });
      expect(w.gives_up_at - w.started_at, row.name).toBe(10_000);
      expect(w.started_at, row.name).toBeGreaterThan(1_600_000_000_000);       // ms since the epoch, like `t`
      expect(res, row.name).toMatchObject({ kind: "resumed", why: row.end });
      expect(res.waited_s, row.name).toBeGreaterThan(0);
      expect(r.status, row.name).toBe(row.status);
    }
  });

  it("the driver's own wait (hands#70 fields) after ours: two waiting/resumed pairs, each with its numbers; hands giving up is timed_out, its \"\" is paused, failed passes through", async () => {
    const { events } = await waitRun(2);
    const ex = new Executor(new BusyDesk(0), { task: "t2", publicKey: ConsentSigner.fresh().publicKey, onEvent: (k, b) => events.push({ k, b }) });
    const from = (ev: unknown) => (ex as any).fromDriver(ev);
    from({ kind: "user_wait", op: "act", app: "com.netease.163music", quiet_s: 1, needs_front: true, started_at: 1_700_000_100_000, gives_up_at: 1_700_000_220_000 });
    from({ kind: "user_resumed", op: "act", ended: "driver", why: "", waited_s: 4.2 });
    from({ kind: "user_wait", op: "act", needs_front: false });
    from({ kind: "user_resumed", op: "act", ended: "driver", why: "timed_out", waited_s: 120 });
    from({ kind: "user_wait", op: "act" });
    from({ kind: "user_resumed", op: "act", ended: "driver", why: "failed" });
    from({ kind: "user_wait", op: "act" });
    from({ kind: "user_resumed", op: "act", ended: "timeout" });              // this side gave up on the request
    const p = proto(events);
    expect(p.map((x) => x.kind)).toEqual(["waiting", "resumed", "waiting", "resumed", "waiting", "resumed", "waiting", "resumed", "waiting", "resumed"]);
    expect(p[0]).toMatchObject({ why: "user_active" });
    expect(p[1]).toMatchObject({ why: "paused" });
    expect(p[2]).toMatchObject({ why: "needs_front", quiet_s: 1, needs_front: true, started_at: 1_700_000_100_000, gives_up_at: 1_700_000_220_000 });
    expect(p[3]).toMatchObject({ why: "paused", waited_s: 4.2 });
    expect(p[4]).toMatchObject({ why: "user_active", needs_front: false });
    expect(p[5]).toMatchObject({ why: "timed_out", waited_s: 120 });
    expect(p[7]).toMatchObject({ why: "failed" });
    expect(p[9]).toMatchObject({ why: "timed_out" });
  });

  it("hands' wire: epoch seconds become ms; without hands#70's fields everything stays optional", async () => {
    const { HandsDriver } = await import("../src/executor/hands.js") as any;
    const told: any[] = [];
    const d = Object.create(HandsDriver.prototype);
    Object.assign(d, { listeners: [(e: any) => told.push(e)], pending: new Map([[7, { op: "act" }]]), waiting: null, log: [] });
    d.onEvent({ event: "user_wait", req: 7, app: "com.x", quiet_s: 3, needs_front: true, started_at: 1700000000.5, gives_up_at: 1700000120.25 });
    d.onEvent({ event: "user_resumed", req: 7, waited_s: 2, why: "" });
    d.onEvent({ event: "user_wait", req: 7 });
    expect(told[0]).toMatchObject({ kind: "user_wait", quiet_s: 3, needs_front: true, started_at: 1700000000500, gives_up_at: 1700000120250 });
    expect(told[1]).toMatchObject({ kind: "user_resumed", why: "", waited_s: 2 });
    expect(told[2]).toEqual({ kind: "user_wait", op: "act" });
  });
});

// --- H5 -------------------------------------------------------------------------------------------------------------

/** app-run on the mail sim: plan card approved by the app; every action card handled by `onCard`. */
function mailRun(onCard: (e: Extract<AppEvent, { kind: "ask" }>, send: (c: Record<string, unknown>) => void, batch: (cs: Record<string, unknown>[]) => void, n: number) => void, o: { sendTries?: number; steers?: Step[] } = {}) {
  const { sim, w } = mailSim();
  const input = new PassThrough();
  const events: AppEvent[] = [];
  const lines: Record<string, unknown>[] = [];
  const send = (c: Record<string, unknown>) => { lines.push(c); input.write(JSON.stringify(c) + "\n"); };
  const batch = (cs: Record<string, unknown>[]) => { lines.push(...cs); input.write(cs.map((c) => JSON.stringify(c) + "\n").join("")); };
  let n = 0;
  const sendStep = (m: Message[]): Step => act({ kind: "click", window: w, target: (lastJson(m).elements ?? []).find((e: { id: string }) => e.id.endsWith(":send"))?.id ?? `${w}:0:send` }, "external", { plan_step: 2 })(m);
  const steps: Step[] = [
    { calls: [{ name: "plan", args: { steps: [{ purpose: "写回复", objects: [`window:${w}`], consequence: "modify_user" }, { purpose: "发送回复", objects: [`window:${w}`], consequence: "external" }] } }] },
    look(w),
    act({ kind: "click", window: w, target: `${w}:0:row:m1` }, "modify_user", { plan_step: 1 }),
    act({ kind: "click", window: w, target: `${w}:0:reply` }, "modify_user", { plan_step: 1 }),
    act({ kind: "set_value", window: w, target: `${w}:0:compose_body`, value: "收到，谢谢" }, "modify_user", { plan_step: 1 }),
    ...Array.from({ length: o.sendTries ?? 1 }, (): Step[] => [look(w), sendStep]).flat(),
    finish,
  ];
  const out = (e: AppEvent) => {
    events.push(e);
    if (e.kind === "ask" && e.card.kind === "plan") setTimeout(() => send({ type: "answer", ask_id: e.ask_id, option: e.card.options.findIndex((x) => x.kind === "approve") }), 1);
    else if (e.kind === "ask") onCard(e, send, batch, n++);
    if (e.kind === "task_done") setTimeout(() => input.end(), 1);
  };
  const done = appRun({ run_id: "run_h5", raw: "回复林晓：收到，谢谢", config: "ds-flash", lang: "zh" }, { runs: fs.mkdtempSync(path.join(os.tmpdir(), "h5-")), out, input: new LineReader(input), linger: 0,
    inject: { driver: sim, gateway: judges(), model: { model: MODEL, streamFn: scriptedStream(steps) } } });
  return { done, events, lines, sent: () => sim.mailState(w).replies.length };
}
type H5Run = ReturnType<typeof mailRun>;

/** The invariant from the events and the sim: a card voided (ask_void) is never taken (no resumed for it without
 *  `voided`); a reply goes out only after an action card's answer was taken as approve; every answer line gets one
 *  outcome (taken or refused); every steer is applied (steered) or refused, with its reason. */
function h5Oracle(r: H5Run, ctx: string) {
  const ev = r.events as any[];
  const voided = new Set(ev.filter((e) => e.kind === "ask_void").map((e) => e.ask_id));
  const taken = ev.filter((e) => e.kind === "resumed" && e.ask_id && !e.voided).map((e) => e.ask_id);
  for (const id of taken) expect(voided.has(id), `${ctx}: ${id} voided and taken`).toBe(false);
  // an action card answered before its void yields at most one token; one that got ask_void yields none
  const approvals = ev.filter((e) => e.kind === "consent" && e.picked === "approve").length;
  const actionAsks = new Set(ev.filter((e) => e.kind === "ask" && e.card.kind === "action").map((e) => e.ask_id));
  const takenAction = taken.filter((id) => actionAsks.has(id)).length;
  expect(approvals, ctx).toBeLessThanOrEqual(takenAction);
  expect(r.sent(), ctx).toBeLessThanOrEqual(approvals);
  // one outcome per answer line
  const answers = r.lines.filter((l) => l.type === "answer").length;
  const refusedAnswers = ev.filter((e) => e.kind === "refused" && String(e.what).startsWith("answer")).length;
  expect(taken.length + refusedAnswers, ctx).toBe(answers);
  // every steer: applied, or refused with a reason
  const steers = r.lines.filter((l) => l.type === "steer").length;
  const applied = ev.filter((e) => e.kind === "steered").length;
  const refusedSteers = ev.filter((e) => e.kind === "refused" && String(e.what).startsWith("steer")).length;
  expect(applied + refusedSteers, ctx).toBe(steers);
}

describe("H5: a steer while a card is open voids it first, then is taken; a voided card never yields consent", () => {
  it("table: the card's state when the steer arrives → the card's outcome and the steer's", async () => {
    const approve = (e: any) => ({ type: "answer", ask_id: e.ask_id, option: e.card.options.findIndex((x: any) => x.kind === "approve") });
    // unanswered: void (steer) before the steer is applied; the reply never goes out
    const a = mailRun((e, send) => { send({ type: "steer", text: "先别发了" }); });
    await a.done;
    const ia = a.events.findIndex((e: any) => e.kind === "ask_void" && e.why === "steer"), sa = a.events.findIndex((e) => e.kind === "steered");
    expect(ia).toBeGreaterThanOrEqual(0); expect(sa).toBeGreaterThan(ia);
    expect(a.sent()).toBe(0);
    h5Oracle(a, "unanswered");
    // answer sent before the steer (same chunk): the answer is taken, the steer applied after; no void
    const b = mailRun((e, _s, batch) => { batch([approve(e), { type: "steer", text: "发完就行" }]); });
    await b.done;
    expect(b.events.some((e: any) => e.kind === "ask_void" && e.why === "steer")).toBe(false);
    expect(b.sent()).toBe(1);
    h5Oracle(b, "answered first");
    // the answer arrives after the steer (late, e.g. from the undo window of a choice): voided, the answer refused
    const c = mailRun((e, _s, batch) => { batch([{ type: "steer", text: "先别发了" }, approve(e)]); });
    await c.done;
    expect(c.events.some((e: any) => e.kind === "refused" && /voided \(steer\)/.test(e.why))).toBe(true);
    expect(c.sent()).toBe(0);
    h5Oracle(c, "late answer");
    // two steers before any step: the first voids, both are applied in order
    const d = mailRun((e, _s, batch) => { batch([{ type: "steer", text: "改成：好的" }, { type: "steer", text: "还是先别发" }]); });
    await d.done;
    expect(d.events.filter((e) => e.kind === "steered").map((e: any) => e.text)).toEqual(["改成：好的", "还是先别发"]);
    expect(d.events.filter((e: any) => e.kind === "ask_void" && e.why === "steer")).toHaveLength(1);
    h5Oracle(d, "two steers");
  }, 30_000);

  it("the plan card open when the steer arrives: voided (steer), the runtime is told and may plan again", async () => {
    const { sim, w } = mailSim();
    const input = new PassThrough();
    const events: AppEvent[] = [];
    const steps: Step[] = [
      { calls: [{ name: "plan", args: { steps: [{ purpose: "加旗标", objects: [`window:${w}`], consequence: "modify_user" }] } }] },
      { calls: [{ name: "plan", args: { steps: [{ purpose: "不加旗标，只看", objects: [`window:${w}`], consequence: "read" }] } }] },
      finish,
    ];
    let first = true;
    const out = (e: AppEvent) => {
      events.push(e);
      if (e.kind === "ask" && first) { first = false; input.write(JSON.stringify({ type: "steer", text: "别加旗标了" }) + "\n"); }
      else if (e.kind === "ask") input.write(JSON.stringify({ type: "answer", ask_id: e.ask_id, option: 0 }) + "\n");
      if (e.kind === "task_done") setTimeout(() => input.end(), 1);
    };
    await appRun({ run_id: "run_h5p", raw: "给林晓的邮件加旗标", config: "ds-flash", lang: "zh" }, { runs: fs.mkdtempSync(path.join(os.tmpdir(), "h5p-")), out, input: new LineReader(input), linger: 0,
      inject: { driver: sim, gateway: judges(), model: { model: MODEL, streamFn: scriptedStream(steps) } } });
    const ask = events.find((e) => e.kind === "ask") as any;
    expect(ask.card.kind).toBe("plan");
    expect(events.find((e: any) => e.kind === "ask_void" && e.ask_id === ask.ask_id)).toMatchObject({ why: "steer" });
    expect(events.find((e) => e.kind === "steered")).toMatchObject({ text: "别加旗标了" });
    expect(events.filter((e: any) => e.kind === "consent" && e.picked === "approve")).toEqual([]);
  });

  it("property: random answer / steer / stop lines, batched or not, at every action card → the oracle holds (voided never consents; one outcome each; every steer accounted)", async () => {
    const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    for (let seed = 1; seed <= 30; seed++) {
      const rand = rng(seed);
      const r = mailRun((e, send, batch) => {
        const ap = { type: "answer", ask_id: e.ask_id, option: e.card.options.findIndex((x) => x.kind === "approve") };
        const skip = { type: "answer", ask_id: e.ask_id, option: e.card.options.findIndex((x) => x.kind === "skip_step") };
        const st = (t: string) => ({ type: "steer", text: t });
        const plans: Record<string, unknown>[][] = [[ap], [st("等等"), ap], [ap, st("好")], [st("先别发")], [st("一"), st("二"), ap], [skip, st("嗯")], [{ type: "stop" }], [st("不发了"), skip]];
        const p = plans[Math.floor(rand() * plans.length)]!;
        if (rand() < 0.5) batch(p); else for (const [i, c] of p.entries()) setTimeout(() => send(c), i);
      }, { sendTries: 3 });
      await r.done;
      h5Oracle(r, `seed ${seed}`);
    }
  }, 60_000);

  it("the card about an interrupted step is answered first: a steer is refused (executor) — through the session, card_open", async () => {
    const { ExecutorService } = await import("../src/executor/service.js") as any;
    const s = Object.create(ExecutorService.prototype);
    const emitted: [string, any][] = [];
    Object.assign(s, { status: null, executorEnded: false, openCardHolds: true, pending: [], counters: {}, emit: (k: string, b: any) => emitted.push([k, b]), openCard: { abort: () => { throw new Error("must not void it"); } }, expiredWait: null });
    s.count = () => undefined;
    s.steer("别管了");
    expect(s.pending).toEqual([]);
    expect(emitted).toEqual([["steer.refused", { raw: "别管了", why: expect.stringContaining("card_open") }]]);
    const { SessionHost } = await import("../src/session/host.js");
    const errs: any[] = [];
    const h = new SessionHost({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "h5r-")), sessionId: "ses_r", out: (e: any) => { if (e.kind === "session.error") errs.push(e); }, coalesceMs: 5, model: { model: MODEL, streamFn: scriptedStream([]) }, launch: (() => { throw new Error("no"); }) as never, linger: 0 });
    (h as any).current = { runId: "run_r", card: "ask_1", cardHolds: true, handle: { write: () => { throw new Error("must not be sent"); } } };
    h.steer("别管了", undefined, "k1");
    expect(errs.at(-1)).toMatchObject({ code: "card_open", control: "steer", client_id: "k1" });
    (h as any).current = { runId: "run_r", card: null, state: "lingering" };
    // the task is over (only its result card is open): no running task, refused — the app makes it a new task (M1)
    (h as any).current = undefined;
    h.steer("再做一次", undefined, "k2");
    expect(errs.at(-1)).toMatchObject({ code: "no_task", control: "steer", client_id: "k2" });
  });
});
