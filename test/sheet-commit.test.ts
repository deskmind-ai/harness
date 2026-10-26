/**
 * rc.18: in TextEdit's save sheet (a window the task opened), cmd+shift+g — Go to Folder — drew the save-sheet floor's
 * card: "the save sheet could not be read whole". The floor exists to stop a save that may write over the user's file
 * where the sheet cannot say where it saves; moving around in the sheet saves nothing.
 *
 * Invariant: the save-sheet floor applies only to a step that can COMMIT the sheet — Return / Enter (any modifiers),
 * typed text with a newline, Space on a focused button, a click or double-click on a button (hands does not say which
 * is the default; Save, Replace and Cancel are all buttons), or on an element the look does not show (not known).
 * Navigation — other keys (cmd+shift+g, Escape, Tab), typing or setting a name or a path, clicks on rows, cells,
 * pop-ups, checkboxes, choices in a pop-up — gets no floor from the sheet. By structure: the key and the target's role.
 *
 * The table: action × sheet (none / readable, a new name / readable, the name taken / not read whole) × the window's
 * provenance (the task's own / DeskMind opened). Oracle: the rule above, written out.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { ALTERS_QUESTION, INTENT_QUESTION, OUTGOING_QUESTION, type Judge } from "../src/executor/judge.js";
import type { Action, Driver, Element, Observation, SaveSheet, Snapshot, WindowInfo } from "../src/executor/types.js";

const ELS: Element[] = [
  { id: "save", role: "button", label: "存储", actions: ["click"] },
  { id: "cancel", role: "button", label: "取消", actions: ["click"] },
  { id: "name", role: "textField", label: "存储为", value: "", actions: ["set_value", "type"] },
  { id: "goto", role: "textField", label: "前往文件夹", value: "", actions: ["set_value", "type"] },
  { id: "row", role: "row", label: "文稿", actions: ["click"] },
  { id: "cell", role: "cell", label: "桌面", actions: ["click"] },
  { id: "where", role: "popUpButton", label: "位置", value: "文稿", actions: ["select"], options: ["文稿", "桌面"] },
  { id: "hide", role: "checkBox", label: "隐藏扩展名", actions: ["click"] },
];

class Desk implements Driver {
  epoch = 1;
  wins: WindowInfo[] = [];
  sheet: SaveSheet | undefined;
  focus: string | null = null;
  readonly w: WindowInfo = { id: "TextEdit#7", app: "com.apple.TextEdit", app_name: "文本编辑", bundle: "com.apple.TextEdit", title: "未命名2" };
  constructor(private source: "made" | "opened") {}
  snapshot(): Snapshot { return { epoch: this.epoch, locked: false, front_app: "x", windows: [...this.wins] }; }
  observe(): Observation { return { epoch: this.epoch, window: this.w, modal: null, elements: ELS.map((e) => ({ ...e, ...(e.id === this.focus ? { focused: true } : {}) })), text: "", ...(this.sheet ? { save_sheet: { ...this.sheet } } : {}) }; }
  perform(a: Action) {
    this.epoch += 1;
    if (a.kind === "open_window") { this.wins.push(this.w); return { status: "ok" as const, window: this.w.id, ...(this.source === "made" ? { new_window: this.w } : { opened_window: { id: this.w.id, app: this.w.app, app_name: "文本编辑", bundle: this.w.bundle!, title: this.w.title, was_running: false } }) }; }
    return { status: "ok" as const, window: this.w.id };
  }
}
/** The judges say the step stays and keeps the user's content (as they did in rc.18): only the floor can raise it. */
const judge = { choose: async (q: string) => ({ choice: q === OUTGOING_QUESTION ? "stays" : q === ALTERS_QUESTION ? "keeps" : q === INTENT_QUESTION ? "matches" : "pass", by: "fake", confidence: 1, reason: "" }) } as unknown as Judge;

const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-commit-")); fs.writeFileSync(path.join(d, "hello.txt"), "the user's"); return d; };
const SHEETS = (d: string): Record<string, SaveSheet | undefined> => ({
  none: undefined,
  new_name: { read: true, name: "新的.txt", stem: "新的", name_focused: true, folder: d, path: path.join(d, "新的.txt"), nested_sheet: false },
  name_taken: { read: true, name: "hello.txt", stem: "hello", name_focused: true, folder: d, path: path.join(d, "hello.txt"), nested_sheet: false },
  not_read: { read: false, name: null, stem: null, name_focused: null, folder: null, path: null, nested_sheet: null },
});
const RISKY = new Set(["name_taken", "not_read"]);

type Row = { name: string; action: (w: string) => Action; focus?: string; commits: boolean };
const ROWS: Row[] = [
  { name: "key cmd+shift+g (Go to Folder)", action: (w) => ({ kind: "key", window: w, chord: "cmd+shift+g" }), commits: false },
  { name: "key Escape", action: (w) => ({ kind: "key", window: w, chord: "escape" }), commits: false },
  { name: "key Tab", action: (w) => ({ kind: "key", window: w, chord: "tab" }), commits: false },
  { name: "key Return", action: (w) => ({ kind: "key", window: w, chord: "return" }), commits: true },
  { name: "key Enter", action: (w) => ({ kind: "key", window: w, chord: "enter" }), commits: true },
  { name: "key cmd+Return", action: (w) => ({ kind: "key", window: w, chord: "cmd+return" }), commits: true },
  { name: "key Space, the Save button focused", action: (w) => ({ kind: "key", window: w, chord: "space" }), focus: "save", commits: true },
  { name: "key Space, the name field focused", action: (w) => ({ kind: "key", window: w, chord: "space" }), focus: "name", commits: false },
  { name: "type a name", action: (w) => ({ kind: "type", window: w, target: "name", text: "hello" }), commits: false },
  { name: "type a name with Return", action: (w) => ({ kind: "type", window: w, target: "name", text: "hello\n" }), commits: true },
  { name: "type a path in Go to Folder", action: (w) => ({ kind: "type", window: w, target: "goto", text: "/tmp/x" }), commits: false },
  { name: "set_value the name", action: (w) => ({ kind: "set_value", window: w, target: "name", value: "hello.txt" }), commits: false },
  { name: "click the Save button", action: (w) => ({ kind: "click", window: w, target: "save" }), commits: true },
  { name: "click the Cancel button (a button: hands does not say which is the default)", action: (w) => ({ kind: "click", window: w, target: "cancel" }), commits: true },
  { name: "double-click the Save button", action: (w) => ({ kind: "double_click", window: w, target: "save" }), commits: true },
  { name: "click a folder row", action: (w) => ({ kind: "click", window: w, target: "row" }), commits: false },
  { name: "double-click a folder row", action: (w) => ({ kind: "double_click", window: w, target: "row" }), commits: false },
  { name: "click a sidebar cell", action: (w) => ({ kind: "click", window: w, target: "cell" }), commits: false },
  { name: "click the location pop-up", action: (w) => ({ kind: "click", window: w, target: "where" }), commits: false },
  { name: "choose in the location pop-up", action: (w) => ({ kind: "select", window: w, target: "where", option: "桌面" }), commits: false },
  { name: "click the hide-extension checkbox", action: (w) => ({ kind: "click", window: w, target: "hide" }), commits: false },
  { name: "click an element the look does not show (not known)", action: (w) => ({ kind: "click", window: w, target: "gone" }), commits: true },
];

describe("the save-sheet floor applies only to a step that can commit the sheet (rc.18)", () => {
  // every row its own test: action × sheet × window
  const d = dir();
  for (const source of ["made", "opened"] as const) for (const [sheetName, sheet] of Object.entries(SHEETS(d))) for (const row of ROWS) {
    const want = row.commits && RISKY.has(sheetName) ? "modify_user" : "create";
    it(`${source} window × sheet ${sheetName} × ${row.name} → ${want}`, async () => {
      const desk = new Desk(source);
      const ex = new Executor(desk, { task: "t1", publicKey: ConsentSigner.fresh().publicKey, raw: "用文本编辑新建 hello.txt，存到任务目录", taskOpened: "task", judge });
      await ex.begin(); await ex.plan({ steps: [] });
      expect((await ex.act({ action: { kind: "open_window", app: "TextEdit" }, epoch: ex.currentEpoch })).status).toBe("ok");
      desk.sheet = sheet; desk.focus = row.focus ?? null;
      const o = await ex.observe(desk.w.id);
      expect((await ex.classify(row.action(desk.w.id), o.epoch)).consequence).toBe(want);
    });
  }

  it("rc.18's step: cmd+shift+g in a sheet that could not be read whole, in a window the task opened — no card, it goes", async () => {
    const desk = new Desk("opened");
    const ex = new Executor(desk, { task: "t1", publicKey: ConsentSigner.fresh().publicKey, raw: "用文本编辑新建 hello.txt，存到任务目录", taskOpened: "task", judge });
    await ex.begin(); await ex.plan({ steps: [] });
    await ex.act({ action: { kind: "open_window", app: "TextEdit" }, epoch: ex.currentEpoch });
    desk.sheet = SHEETS(dir()).not_read;
    const o = await ex.observe(desk.w.id);
    const r = await ex.act({ action: { kind: "key", window: desk.w.id, chord: "cmd+shift+g" }, epoch: o.epoch });
    expect([r.status, r.consequence]).toEqual(["ok", "create"]);
    // and Return in the same sheet still asks
    const o2 = await ex.observe(desk.w.id);
    const r2 = await ex.act({ action: { kind: "key", window: desk.w.id, chord: "return" }, epoch: o2.epoch });
    expect([r2.status, r2.consequence]).toEqual(["needs_consent", "modify_user"]);
  });
});
