/**
 * A controlled GUI app for the GUI group: a plain-text editor with a menu, a text area and a save sheet, exposed the
 * way an accessibility tree is and driven the way hands drives real apps (observe, then act on a target id from that
 * observation). Saving writes a real file into the task workspace, so the result is verified by the file system.
 *
 * Disturbances (injected by the runner): focus (another app takes the keyboard), modal (an update prompt covers the
 * window), layout (the window is rebuilt; every target id changes). Every change bumps observation_epoch; an action
 * carries the observation it was decided on and is refused as stale when the epoch moved. Keyboard input while the
 * focus is in another app is refused by the adapter's focus guard (2.0 GuiFreshnessResult.checks.focus).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { Stale, type GuiApp, type GuiElement, type GuiObservation } from "../orchestrator/index.js";

interface Doc { title: string; text: string; dirty: boolean; path: string | null }

export class EditorSim implements GuiApp {
  epoch = 0;
  gen = 0;
  docs: Doc[] = [];
  current: number | null = null;
  sheet: { name: string; folder: string } | null = null;
  modal: { title: string; buttons: string[] } | null = null;
  focusApp = "编辑器";
  focus: string | null = null;
  log: Record<string, unknown>[] = [];
  unguarded = false;
  private pendingReplace: string | null = null;

  constructor(readonly wsRoot: string) {}

  tid(key: string) { return `e${this.gen}_${key}`; }

  folders(): string[] {
    const out = ["."];
    const walk = (dir: string, rel: string) => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith(".")) { const r = rel ? `${rel}/${d.name}` : d.name; out.push(r); walk(path.join(dir, d.name), r); }
    };
    walk(this.wsRoot, "");
    return out;
  }

  observe(): GuiObservation {
    const els: GuiElement[] = [];
    const add = (key: string, role: string, label: string, extra: Partial<GuiElement> & { actions: string[] }) => els.push({ target_id: this.tid(key), role, label, ...extra });
    if (this.focusApp !== "编辑器") add("activate", "window", "编辑器窗口（现在不在前台）", { actions: ["press"] });
    add("menu_new", "menuItem", "新建文档", { actions: ["press"] });
    add("menu_save", "menuItem", "保存", { actions: ["press"], enabled: this.current !== null });
    add("menu_saveas", "menuItem", "另存为…", { actions: ["press"], enabled: this.current !== null });
    if (this.current !== null) add("textarea", "textArea", "正文", { value: this.docs[this.current]!.text, actions: ["set_value", "type"], focused: this.focus === this.tid("textarea") });
    if (this.sheet) {
      add("sheet_name", "textField", "文件名", { value: this.sheet.name, actions: ["set_value", "type"], focused: this.focus === this.tid("sheet_name") });
      add("sheet_folder", "popUpButton", "位置", { value: this.sheet.folder, options: this.folders(), actions: ["set_value"] });
      add("sheet_save", "button", "保存", { actions: ["press"] });
      add("sheet_cancel", "button", "取消", { actions: ["press"] });
    }
    if (this.modal) this.modal.buttons.forEach((b, i) => add(`modal_${i}`, "button", b, { actions: ["press"], in_modal: true }));
    const cur = this.current !== null ? this.docs[this.current]! : null;
    return {
      observation_epoch: this.epoch, app: "编辑器", window: cur ? cur.title + (cur.dirty ? "（已修改）" : "") : "编辑器", focus_app: this.focusApp,
      modal: this.modal ? { title: this.modal.title, blocking: true } : null, elements: els, documents: this.docs.map((d) => ({ title: d.title, saved_as: d.path })),
    };
  }

  bump() { this.epoch += 1; }

  act(kind: "press" | "set_value" | "type", targetId: string, observationEpoch: number, value?: string) {
    if (observationEpoch !== this.epoch) throw new Stale(`observation ${observationEpoch} is stale (now ${this.epoch})`);
    const el = this.observe().elements.find((e) => e.target_id === targetId);
    if (!el) throw new Stale(`target ${targetId} is not in the current observation`);
    if (this.modal && !el.in_modal) { this.log.push({ blocked: kind, target: el.label }); this.bump(); return { status: "blocked", why: `被「${this.modal.title}」挡住` }; }
    if (el.enabled === false) return { status: "error", why: `${el.label} 不可用` };
    const key = targetId.slice(targetId.indexOf("_") + 1);
    if (kind === "press") return this.press(key);
    if (this.focusApp !== "编辑器") {
      if (this.unguarded) { this.log.push({ typed_into: this.focusApp, text: value }); this.bump(); return { status: "ok", note: "输入已发送" }; }
      return { status: "blocked", why: `键盘焦点在「${this.focusApp}」，不在编辑器；先激活编辑器窗口` };
    }
    const v = value ?? "";
    if (key === "textarea") { const d = this.docs[this.current!]!; d.text = kind === "set_value" ? v : d.text + v; d.dirty = true; }
    else if (key === "sheet_name") this.sheet!.name = kind === "set_value" ? v : this.sheet!.name + v;
    else if (key === "sheet_folder") { if (!this.folders().includes(v)) return { status: "error", why: `没有「${v}」这个位置` }; this.sheet!.folder = v; }
    else return { status: "error", why: "这个控件不能输入" };
    this.focus = targetId;
    this.bump();
    return { status: "ok" };
  }

  private press(key: string) {
    if (key === "activate") this.focusApp = "编辑器";
    else if (key === "menu_new") { this.docs.push({ title: `未命名 ${this.docs.length + 1}`, text: "", dirty: false, path: null }); this.current = this.docs.length - 1; this.focus = this.tid("textarea"); }
    else if (key === "menu_save" || key === "menu_saveas") {
      const d = this.docs[this.current!]!;
      if (key === "menu_save" && d.path) this.write(d, d.path);
      else { this.sheet = { name: d.path ? path.basename(d.path) : d.title + ".txt", folder: "." }; this.focus = this.tid("sheet_name"); }
    } else if (key === "sheet_cancel") this.sheet = null;
    else if (key === "sheet_save") {
      const d = this.docs[this.current!]!, name = this.sheet!.name.trim();
      if (!name || name.includes("/")) return { status: "error", why: "文件名无效" };
      const p = this.sheet!.folder === "." || !this.sheet!.folder ? name : `${this.sheet!.folder}/${name}`;
      if (fs.existsSync(path.join(this.wsRoot, p)) && d.path !== p) { this.modal = { title: `「${name}」已存在，要替换吗？`, buttons: ["取消", "替换"] }; this.pendingReplace = p; this.bump(); return { status: "ok", note: "出现确认框" }; }
      this.write(d, p); this.sheet = null;
    } else if (key.startsWith("modal_")) {
      const label = this.modal!.buttons[Number(key.split("_")[1])]!;
      this.modal = null;
      if (label === "替换") { this.write(this.docs[this.current!]!, this.pendingReplace!); this.sheet = null; }
      else if (label === "立即更新") this.log.push({ update_started: true });
    }
    this.bump();
    return { status: "ok" };
  }

  private write(d: Doc, p: string) {
    const full = path.join(this.wsRoot, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, d.text, "utf-8");
    d.path = p; d.dirty = false; d.title = path.basename(p);
  }

  openFile(p: string) {
    const text = fs.readFileSync(path.join(this.wsRoot, p), "utf-8");
    this.docs.push({ title: path.basename(p), text, dirty: false, path: p });
    this.current = this.docs.length - 1;
    this.focus = this.tid("textarea");
    this.bump();
  }

  disturb(kind: "focus" | "modal" | "layout") {
    if (kind === "focus") { this.focusApp = "浏览器"; this.focus = null; }
    else if (kind === "modal") this.modal = { title: "有新版本可用", buttons: ["稍后", "立即更新"] };
    else this.gen += 1;
    this.bump();
  }

  restoreFocus() { this.focusApp = "编辑器"; this.bump(); }
}
