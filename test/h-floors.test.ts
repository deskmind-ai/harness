/**
 * H-floors: hands#70's facts (K1) as floors of structure, read before any judge — a judge's "stays" never clears them.
 *  1. A close button known by its AX subrole (AXCloseButton, from the window's own buttons; never a label) closes the
 *     window: in a window DeskMind opened or the user's it asks, like cmd+w; in the task's own window it does not.
 *  2. `opened_window` is a window of the launch's own only with hands' proof the app was not running (was_running
 *     false); without the field (an older hands) or with true, it is plainly the user's — fail closed.
 *  3. A save sheet open on the window: a step that can commit it (click, key, choice) is modify_user when it may write
 *     over a file — an alert inside the sheet, a sheet not read whole or any fact unknown, its path a file of the user's,
 *     a file of its stem in its folder, or the folder unreadable — whoever's window it is.
 * Oracle: computed from the facts the desk was given (the floor's rule as the plan states it), not by the executor.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { INTENT_QUESTION, OUTGOING_QUESTION, type Judge } from "../src/executor/judge.js";
import type { Action, Driver, Element, Observation, SaveSheet, Snapshot, WindowInfo } from "../src/executor/types.js";
import { Workspace, build } from "../src/registry/workspace.js";
import { fileRegistry } from "../src/registry/fs.js";

const ELS: Element[] = [
  { id: "x", role: "button", label: "", actions: ["click"], ax_subrole: "AXCloseButton" },       // known only by its subrole
  { id: "min", role: "button", label: "", actions: ["click"], ax_subrole: "AXMinimizeButton" },
  { id: "save", role: "button", label: "存储", actions: ["click"] },
  { id: "name", role: "textField", label: "存储为", actions: ["set_value"], value: "" },
  { id: "row", role: "row", label: "张三 · 会议时间", actions: ["click"] },
];

type Source = "user" | "opened" | "made";
/** A desk with one window of the given provenance; `wasRunning` what hands' opened_window says (undefined: an older
 *  hands, no field); `sheet` the save sheet its looks report. */
class Desk implements Driver {
  epoch = 1;
  wins: WindowInfo[] = [];
  sheet: SaveSheet | undefined;
  constructor(private source: Source, private wasRunning: boolean | undefined, readonly target: WindowInfo) { if (source === "user") this.wins.push(target); }
  snapshot(): Snapshot { return { epoch: this.epoch, locked: false, front_app: "DeskMind", windows: [...this.wins] }; }
  observe(id: string): Observation { const w = this.wins.find((x) => x.id === id)!; return { epoch: this.epoch, window: w, modal: null, elements: ELS.map((e) => ({ ...e })), text: "", ...(this.sheet ? { save_sheet: { ...this.sheet } } : {}) }; }
  perform(action: Action) {
    this.epoch += 1;
    if (action.kind === "open_window") {
      this.wins.push(this.target);
      // hands' opened_window: exactly the contract's keys (test/fixtures/contracts/opened_window.json)
      const ow = { id: this.target.id, app: this.target.app, app_name: this.target.app_name ?? this.target.app, bundle: this.target.bundle ?? this.target.app, title: this.target.title, ...(this.wasRunning !== undefined ? { was_running: this.wasRunning } : {}) };
      return { status: "ok" as const, window: this.target.id, ...(this.source === "made" ? { new_window: this.target } : { opened_window: ow }) };
    }
    return { status: "ok" as const, window: "window" in action ? action.window : undefined };
  }
}

function judge(outgoing: string | null) {
  return { choose: async (q: string) => { const c = q === OUTGOING_QUESTION ? outgoing : q === INTENT_QUESTION ? "matches" : "pass"; return c ? { choice: c, by: "fake", confidence: 1, reason: "" } : null; } } as unknown as Judge;
}

async function stage(source: Source, o: { wasRunning?: boolean; sheet?: SaveSheet; outgoing?: string | null; root?: string } = {}) {
  const target: WindowInfo = { id: "Pages#7", app: "Pages", app_name: "Pages", bundle: "com.apple.iWork.Pages", title: "报告" };
  const desk = new Desk(source, "wasRunning" in o ? o.wasRunning : false, target);
  const app = ConsentSigner.fresh();
  const files = o.root ? { files: { workspace: new Workspace(o.root), registry: fileRegistry() } } : {};
  const ex = new Executor(desk, { task: "t1", publicKey: app.publicKey, raw: "把报告另存一份", taskOpened: "task", judge: judge(o.outgoing === undefined ? "stays" : o.outgoing), ...files });
  await ex.begin(); await ex.plan({ steps: [] });
  if (source !== "user") expect((await ex.act({ action: { kind: "open_window", app: "Pages" }, epoch: ex.currentEpoch })).status).toBe("ok");
  desk.sheet = o.sheet;
  const look = await ex.observe(target.id);
  return { desk, ex, target, look };
}
const act = async (s: Awaited<ReturnType<typeof stage>>, a: Action) => { const r = await s.ex.act({ action: a, epoch: s.look.epoch }); return { status: r.status, consequence: r.consequence }; };

describe("H-floors 1: a close button by its AX subrole closes the window", () => {
  it("table: owner (user | opened | made) × judge (stays | alters | unsure | none) × button (close by subrole | minimise) → a card exactly where closing asks", async () => {
    const rows: string[] = [];
    for (const source of ["user", "opened", "made"] as Source[]) for (const outgoing of ["stays", "alters", "unsure", null]) for (const btn of ["x", "min"]) {
      const s = await stage(source, { outgoing });
      const r = await act(s, { kind: "click", window: s.target.id, target: btn });
      // the rule: closing a window that is not the task's own asks, whatever the judge says; otherwise a click is a click
      // like any other: the outgoing judge is asked of every click, and alters / unsure / no answer raise it
      const closeAsks = btn === "x" && source !== "made";
      const judgeRaises = outgoing !== "stays";
      const wantCard = source === "user" || closeAsks || judgeRaises;
      rows.push(`${source} ${outgoing} ${btn} → ${r.status} ${r.consequence}`);
      expect(r.status === "needs_consent", rows.at(-1)).toBe(wantCard);
      if (closeAsks) expect(["modify_user", "external"], rows.at(-1)).toContain(r.consequence);      // (a judge may raise it further, never lower)
    }
    expect(rows).toHaveLength(24);
  });
});

describe("H-floors 2: opened_window counts as the launch's own only on hands' proof the app was not running", () => {
  it("table: was_running (false | true | absent) × judge stays → a step in it goes without a card only on false", async () => {
    for (const wasRunning of [false, true, undefined]) {
      const s = await stage("opened", { wasRunning });
      expect(s.ex.opened(`window:${s.target.id}`), String(wasRunning)).toBe(wasRunning === false);
      const r = await act(s, { kind: "set_value", window: s.target.id, target: "name", value: "副本" });
      expect(r.status, String(wasRunning)).toBe(wasRunning === false ? "ok" : "needs_consent");
    }
  });

  it("the fake's opened_window is exactly hands' contract (fixtures/contracts/opened_window.json, mirrored; checked against hands' own when DESKMIND_HANDS_DIR has it)", () => {
    const mine = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "contracts", "opened_window.json"), "utf-8"));
    const desk = new Desk("opened", false, { id: "A#1", app: "A", title: "t" });
    const ow = (desk.perform({ kind: "open_window", app: "A" }) as any).opened_window;
    expect(Object.keys(ow).sort()).toEqual([...mine.keys].sort());
    const hands = process.env.DESKMIND_HANDS_DIR && path.join(process.env.DESKMIND_HANDS_DIR, "fixtures", "contracts", "opened_window.json");
    if (hands && fs.existsSync(hands)) expect(JSON.parse(fs.readFileSync(hands, "utf-8")).keys).toEqual(mine.keys);
  });
});

describe("H-floors 3: a save sheet that may write over a file asks, whoever's window it is", () => {
  const folder = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-")); fs.writeFileSync(path.join(d, "报告.docx"), "x"); fs.writeFileSync(path.join(d, "Notes.txt"), "y"); return d; };
  const read = (f: string, name: string, extra: Partial<SaveSheet> = {}): SaveSheet => {
    const ext = path.extname(name);
    return { read: true, name, stem: ext && ext !== name ? name.slice(0, -ext.length) : name, name_focused: true, folder: f, path: null, nested_sheet: false, ...extra };
  };
  /** The oracle: may this sheet write over something? (the plan's rule, from the facts given) */
  const risky = (sh: SaveSheet | undefined, f: string): boolean => {
    if (!sh) return false;
    if (sh.nested_sheet === true || !sh.read || !sh.name || !sh.stem || !sh.folder || sh.nested_sheet === null) return true;
    let names: string[]; try { names = fs.readdirSync(sh.folder); } catch { return true; }
    if (!path.isAbsolute(sh.folder)) return true;
    // a file of that stem, or the shown name with a hidden extension after it
    return names.some((n) => n.replace(/\.[^.]*$/, "").toLowerCase() === sh.stem!.toLowerCase() || n.toLowerCase().startsWith(sh.name!.toLowerCase() + "."));
  };
  it("table: sheet (none | a new name | stem there | other extension | case | alert | not read | folder unknown | folder gone) × owner (opened | made | user) × judge stays × step (click save | Return | type a name) → modify_user exactly when it may write over a file", async () => {
    const f = folder();
    const sheets: Record<string, SaveSheet | undefined> = {
      none: undefined, new_name: read(f, "新报告.docx"), stem_there: read(f, "报告.docx"), other_ext: read(f, "报告.pages"), case: read(f, "notes.md"),
      alert: read(f, "报告.docx", { nested_sheet: true }), not_read: { read: false, name: null, stem: null, name_focused: null, folder: null, path: null, nested_sheet: null },
      folder_unknown: read(f, "新报告.docx", { folder: null }), folder_gone: read(path.join(f, "nope"), "新报告.docx"),
    };
    const rows: string[] = [];
    for (const [k, sheet] of Object.entries(sheets)) for (const source of ["opened", "made", "user"] as Source[]) for (const step of ["click", "key", "type"] as const) {
      const s = await stage(source, { sheet });
      const a: Action = step === "click" ? { kind: "click", window: s.target.id, target: "save" } : step === "key" ? { kind: "key", window: s.target.id, chord: "return" } : { kind: "set_value", window: s.target.id, target: "name", value: "副本" };
      const r = await act(s, a);
      const floor = step !== "type" && risky(sheet, f);
      const want = source === "user" || floor;
      rows.push(`${k} ${source} ${step} → ${r.status} ${r.consequence}`);
      expect(r.consequence === "modify_user" || r.consequence === "external", rows.at(-1)).toBe(want);
      if (want) expect(r.status, rows.at(-1)).toBe("needs_consent");
    }
    expect(rows).toHaveLength(81);
  });

  it("a path that is a file of the user's in the task folder (the sheet read whole, extension shown): asks", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-ws-"));
    build(root, { "报告.docx": "原稿" });
    const s = await stage("made", { root, sheet: { read: true, name: "报告.docx", stem: "报告", name_focused: true, folder: root, path: path.join(root, "报告.docx"), nested_sheet: false } });
    expect(await act(s, { kind: "click", window: s.target.id, target: "save" })).toEqual({ status: "needs_consent", consequence: "modify_user" });
  });

  it("property: random sheets × owners × judge answers — the judge never clears a risky sheet, and a safe one under the task's window is no card", async () => {
    const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const f = folder();
    for (let seed = 1; seed <= 60; seed++) {
      const rand = rng(seed);
      const pick = <X,>(xs: X[]) => xs[Math.floor(rand() * xs.length)]!;
      const name = pick(["报告.docx", "报告", "新的.docx", "notes.txt", "全新"]);
      const sheet = pick([undefined, read(f, name), read(f, name, { nested_sheet: true }), read(f, name, { read: false }), read(f, name, { folder: null }), read(f, name, { nested_sheet: null })]);
      const source = pick(["opened", "made"] as Source[]);
      const outgoing = pick(["stays", "alters", "unsure", null]);
      const s = await stage(source, { sheet, outgoing });
      const r = await act(s, { kind: "click", window: s.target.id, target: "save" });
      const ctx = `seed ${seed}: ${JSON.stringify(sheet)} ${source} ${outgoing}`;
      if (risky(sheet, f)) expect(r.status, ctx).toBe("needs_consent");
      else if (source === "made" && outgoing === "stays") expect(r.status, ctx).toBe("ok");
    }
  });
});

describe("review of #78 (adopted): dotted names with a hidden extension; a relative folder; a typed Return", () => {
  const sh = (folder: string, name: string, stem: string, extra: Partial<SaveSheet> = {}): SaveSheet => ({ read: true, name, stem, name_focused: true, folder, path: null, nested_sheet: false, ...extra });
  it("E1 hidden extension, dotted name: sheet shows report.v2 (stem per hands' splitext: report), folder has report.v2.pages", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "e1-")); fs.writeFileSync(path.join(d, "report.v2.pages"), "x");
    const s = await stage("made", { sheet: sh(d, "report.v2", "report") });
    expect(await act(s, { kind: "click", window: s.target.id, target: "save" })).toEqual({ status: "needs_consent", consequence: "modify_user" });
  });
  it("E1b hidden extension, a.tar shown for a.tar.gz", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "e1b-")); fs.writeFileSync(path.join(d, "a.tar.gz"), "x");
    const s = await stage("made", { sheet: sh(d, "a.tar", "a") });
    expect(await act(s, { kind: "key", window: s.target.id, chord: "return" })).toEqual({ status: "needs_consent", consequence: "modify_user" });
  });
  it("E4 relative folder read against the harness cwd", async () => {
    const s = await stage("made", { sheet: sh("src", "new.ts", "new") });
    expect(await act(s, { kind: "click", window: s.target.id, target: "save" })).toEqual({ status: "needs_consent", consequence: "modify_user" });
  });
  it("a newline typed into a risky sheet commits it; plain text does not", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "e7-")); fs.writeFileSync(path.join(d, "Notes.txt"), "x");
    for (const [text, card] of [["Notes\n", true], ["Notes\r", true], ["Notes", false]] as const) {
      const s = await stage("made", { sheet: sh(d, "Notes.txt", "Notes") });
      const r = await act(s, { kind: "type", window: s.target.id, target: "name", text });
      expect(r.status === "needs_consent", JSON.stringify(text)).toBe(card);
    }
  });
  it("the sim's launch of an installed app reports was_running false (hands' contract): its restored window counts as opened", async () => {
    const { SimComputer } = await import("../src/executor/sim.js");
    const sim = new SimComputer();
    sim.installEditor("Pages", { title: "报告", text: "x", path: null });
    const ex = new Executor(sim, { task: "t1", publicKey: ConsentSigner.fresh().publicKey, taskOpened: "task" });
    await ex.begin(); await ex.plan({ steps: [] });
    const r = await ex.act({ action: { kind: "open_window", app: "Pages" }, epoch: ex.currentEpoch });
    expect(r.status).toBe("ok");
    expect(ex.opened(`window:${sim.snapshot().windows.find((w) => w.app === "Pages")!.id}`)).toBe(true);
  });
});

