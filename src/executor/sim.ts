/**
 * A simulated computer for tests and the practice ground: several apps, each a window with an accessibility-style
 * element tree, driven exactly as the real one is (snapshot, observe, act on an element of an observation). The
 * user's windows are on screen before the task begins; the task opens its own.
 *
 * Apps:
 *   mail      the gym's mail app (hands tools/gym/mail.py): an inbox whose rows a word-matcher confuses, Reply /
 *             Delete (with a confirm dialog) / Flag (a toggle), a compose box whose Send is marked `sends`
 *   editor    a text editor: new document, body, save sheet (name, folder), writes into a workspace folder; with
 *             `newWindow`, also a 「新建纯文本文稿」 button that opens an empty untitled document in a window of its own
 *             (an open panel's: rc.11), reported as `new_window` the way hands proves it (the acted app's, no file, no text)
 *   browser   tabs with urls and page text; an address bar; navigation changes the active tab's url
 *   settings  a few toggles and a dropdown
 *
 * Disturbances: lock(), userActive(), a modal over a window, a user window appearing mid-task.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Action, Driver, Element, Observation, PerformResult, Snapshot, WindowInfo } from "./types.js";

export interface MailMessage { id: string; from: string; subject: string; body: string[]; time: string; date?: string }
export interface MailState { app: string; inbox: MailMessage[]; flagged: string[]; deleted: string[]; replies: { to: string; body: string }[]; selected: string | null; composing: { to: string; body: string } | null; dialog: { kind: "delete"; id: string } | null; texts: Record<string, string> }
export const ZH_MAIL_TEXTS: Record<string, string> = { replied: "已回复", inbox: "收件箱", reply: "回复", delete: "删除", flag: "加旗标", unflag: "取消旗标", send: "发送", cancel: "取消", confirm: "确认删除", confirmText: "确定删除这封邮件吗？", body: "回复内容", meeting: "会议时间：%s", empty: "选择一封邮件" };

interface Win { id: string; app: string; bundle?: string; kind: "mail" | "editor" | "browser" | "settings"; title: string; focused: boolean; minimized: boolean; modal: { title: string; buttons: string[] } | null; state: any; gen: number }

/** The browsers the simulated computer has installed: a url opened in any of them comes up in a new window of the
 *  task's own (perform → addBrowser), which is the promise `urlInOwnBrowserWindow` makes. */
export const SIM_BROWSERS = [
  { bundle: "com.apple.Safari", names: ["Safari", "Safari 浏览器"] },
  { bundle: "com.google.Chrome", names: ["Google Chrome", "Chrome"] },
  { bundle: "org.mozilla.firefox", names: ["Firefox"] },
];

/** One of the sim's browsers by any of its names or its bundle id, ignoring case. */
const simBrowser = (name: string) => { const n = name.trim().toLowerCase(); return SIM_BROWSERS.find((b) => b.bundle.toLowerCase() === n || b.names.some((x) => x.toLowerCase() === n)); };

export class SimComputer implements Driver {
  /** Like hands since #48: a url given to a browser opens in a window of the task's own (the sim always opens a new one). */
  readonly capabilities: { urlInOwnBrowserWindow?: boolean } = { urlInOwnBrowserWindow: true };
  epoch = 1;
  locked = false;
  user_active = false;
  wins: Win[] = [];
  private n = 0;
  log: Record<string, unknown>[] = [];

  constructor(readonly wsRoot?: string) {}

  /** Apps on this computer that are not on screen: a launch (open_window) brings up the window they restore from their
   *  last session, content and all — reported as hands does for a window it cannot prove the action made
   *  (`opened_window`, hands#54), so the executor counts it as one DeskMind opened for the user's app. */
  private installed: { app: string; kind: "mail" | "editor"; state: Record<string, unknown>; names: string[]; bundle?: string }[] = [];
  /** `names`: the app's other names (its English name, a bundle id), as a real Mac resolves a localized app by any of them. */
  installMail(state: Parameters<SimComputer["addMail"]>[0], o: { names?: string[]; bundle?: string } = {}) { this.installed.push({ app: state.app, kind: "mail", state, names: o.names ?? [], bundle: o.bundle }); }
  installEditor(app: string, doc: { title: string; text: string; path: string | null }, o: { names?: string[]; bundle?: string } = {}) { this.installed.push({ app, kind: "editor", state: { doc }, names: o.names ?? [], bundle: o.bundle }); }

  private bump() { this.epoch += 1; }
  private nextId(app: string) { this.n += 1; return `${app}-${this.n}`; }

  // --- setup ---------------------------------------------------------------------------------------------------------
  addMail(state: Omit<MailState, "selected" | "composing" | "dialog" | "replies" | "deleted"> & Partial<MailState>): Win {
    const w: Win = { id: this.nextId("mail"), app: state.app, kind: "mail", title: state.texts.inbox ?? "Inbox", focused: this.wins.length === 0, minimized: false, modal: null, gen: 0,
      state: { selected: null, composing: null, dialog: null, replies: [], deleted: [], ...state } as MailState };
    this.wins.push(w); this.bump(); return w;
  }
  addEditor(app = "编辑器", doc: { title: string; text: string; path: string | null } | null = null, opts: { newWindow?: boolean; bundle?: string } = {}): Win {
    const w: Win = { id: this.nextId("editor"), app, ...(opts.bundle ? { bundle: opts.bundle } : {}), kind: "editor", title: doc?.title ?? app, focused: this.wins.length === 0, minimized: false, modal: null, gen: 0, state: { doc, sheet: null, newWindow: !!opts.newWindow } };
    this.wins.push(w); this.bump(); return w;
  }
  addBrowser(app: string, tabs: { title: string; url: string; text?: string }[]): Win {
    const id = this.nextId("browser");
    const w: Win = { id, app, ...(simBrowser(app) ? { bundle: simBrowser(app)!.bundle } : {}), kind: "browser", title: tabs[0]?.title ?? app, focused: this.wins.length === 0, minimized: false, modal: null, gen: 0,
      state: { tabs: tabs.map((t, i) => ({ id: `${id}-tab${i + 1}`, ...t, text: t.text ?? "" })), active: 0, address: tabs[0]?.url ?? "" } };
    this.wins.push(w); this.bump(); return w;
  }
  addSettings(app = "系统设置", toggles: Record<string, boolean> = {}, dropdowns: Record<string, { value: string; options: string[] }> = {}): Win {
    const w: Win = { id: this.nextId("settings"), app, kind: "settings", title: app, focused: this.wins.length === 0, minimized: false, modal: null, gen: 0, state: { toggles: { ...toggles }, dropdowns: JSON.parse(JSON.stringify(dropdowns)) } };
    this.wins.push(w); this.bump(); return w;
  }
  lock(v = true) { this.locked = v; this.bump(); }
  modal(windowId: string, title: string, buttons: string[]) { const w = this.win(windowId); w.modal = { title, buttons }; this.bump(); }
  relayout(windowId: string) { this.win(windowId).gen += 1; this.bump(); }

  private win(id: string): Win { const w = this.wins.find((x) => x.id === id); if (!w) throw new Error(`no window ${id}`); return w; }
  private info(w: Win): WindowInfo {
    const base: WindowInfo = { id: w.id, app: w.app, title: w.title, focused: w.focused, minimized: w.minimized };
    if (w.bundle) base.bundle = w.bundle;
    if (w.kind === "browser") { base.browser = true; base.url = w.state.tabs[w.state.active]?.url; base.tabs = w.state.tabs.map((t: any, i: number) => ({ id: t.id, title: t.title, url: t.url, active: i === w.state.active })); }
    return base;
  }

  // --- driver --------------------------------------------------------------------------------------------------------
  snapshot(): Snapshot {
    return { epoch: this.epoch, locked: this.locked, front_app: this.wins.find((w) => w.focused)?.app ?? "", windows: this.wins.map((w) => this.info(w)), user_active: this.user_active, browsers: SIM_BROWSERS };
  }

  observe(windowId: string): Observation {
    const w = this.win(windowId);
    const els: Element[] = [];
    const el = (key: string, role: string, label: string, extra: Partial<Element> & { actions: string[] }) => els.push({ id: `${w.id}:${w.gen}:${key}`, role, label, ...extra });
    let text = "";
    if (w.kind === "mail") {
      const s = w.state as MailState, T = s.texts;
      const rows = s.inbox.filter((m) => !s.deleted.includes(m.id));
      // a replied-to message carries the reply arrow every mail app shows: what a verdict can see after Send
      for (const m of rows) el(`row:${m.id}`, "row", `${m.from} · ${m.subject}${s.flagged.includes(m.id) ? " · ⚑" : ""}${s.replies.some((r) => r.to === m.id) ? " · ↩" : ""}`, { actions: ["click"], focused: s.selected === m.id });
      if (s.selected && !s.deleted.includes(s.selected)) {
        const m = s.inbox.find((x) => x.id === s.selected)!;
        const sent = s.replies.filter((r) => r.to === m.id);
        text = [`${m.from} — ${m.subject}`, ...m.body, ...sent.map((r) => `↩ ${T.replied ?? "已回复"}：${r.body}`)].join("\n");
        el("body", "staticText", text, { actions: [] });
        el("reply", "button", T.reply!, { actions: ["click"] });
        el("delete", "button", T.delete!, { actions: ["click"] });
        el("flag", "button", s.flagged.includes(m.id) ? T.unflag! : T.flag!, { actions: ["click"] });
      } else el("empty", "staticText", T.empty!, { actions: [] });
      if (s.composing) {
        el("compose_body", "textArea", T.body!, { actions: ["set_value", "type"], value: s.composing.body, focused: true });
        el("send", "button", T.send!, { actions: ["click"], sends: true });
        el("compose_cancel", "button", T.cancel!, { actions: ["click"] });
      }
      if (s.dialog) { el("confirm_delete", "button", T.confirm!, { actions: ["click"], in_modal: true }); el("confirm_cancel", "button", T.cancel!, { actions: ["click"], in_modal: true }); }
      return this.finish(w, els, text, s.dialog ? { title: T.confirmText! } : null);
    }
    if (w.kind === "editor") {
      const s = w.state;
      el("menu_new", "menuItem", "新建文档", { actions: ["click"] });
      if (s.newWindow) el("new_window_doc", "button", "新建纯文本文稿", { actions: ["click"] });
      el("menu_save", "menuItem", "保存", { actions: ["click"], enabled: !!s.doc });
      el("menu_saveas", "menuItem", "另存为…", { actions: ["click"], enabled: !!s.doc });
      if (s.doc) { el("textarea", "textArea", "正文", { actions: ["set_value", "type"], value: s.doc.text, focused: !s.sheet }); text = s.doc.text; }
      if (s.sheet) {
        el("sheet_name", "textField", "文件名", { actions: ["set_value", "type"], value: s.sheet.name, focused: true });
        el("sheet_folder", "popUpButton", "位置", { actions: ["select"], value: s.sheet.folder, options: this.folders() });
        el("sheet_save", "button", "保存", { actions: ["click"] });
        el("sheet_cancel", "button", "取消", { actions: ["click"] });
      }
      return this.finish(w, els, text, null);
    }
    if (w.kind === "browser") {
      const s = w.state, tab = s.tabs[s.active];
      el("address", "textField", "地址栏", { actions: ["set_value", "type"], value: s.address });
      el("go", "button", "前往", { actions: ["click"] });
      s.tabs.forEach((t: any, i: number) => el(`tab:${t.id}`, "tab", t.title, { actions: ["click"], focused: i === s.active }));
      el("newtab", "button", "新标签页", { actions: ["click"] });
      if (tab) { el("page", "staticText", tab.text || tab.title, { actions: [] }); text = tab.text; }
      return this.finish(w, els, text, null);
    }
    const s = w.state;
    for (const [k, v] of Object.entries(s.toggles)) el(`toggle:${k}`, "checkBox", k, { actions: ["click"], value: v ? "开" : "关" });
    for (const [k, d] of Object.entries<any>(s.dropdowns)) el(`dd:${k}`, "popUpButton", k, { actions: ["select"], value: d.value, options: d.options });
    return this.finish(w, els, "", null);
  }

  private finish(w: Win, els: Element[], text: string, modal: { title: string } | null): Observation {
    if (w.modal) { w.modal.buttons.forEach((b, i) => els.push({ id: `${w.id}:${w.gen}:modal_${i}`, role: "button", label: b, actions: ["click"], in_modal: true })); modal = { title: w.modal.title }; }
    return { epoch: this.epoch, window: this.info(w), modal, elements: els, text };
  }

  private folders(): string[] {
    if (!this.wsRoot) return ["."];
    const out = ["."];
    const walk = (dir: string, rel: string) => { for (const d of fs.readdirSync(dir, { withFileTypes: true })) if (d.isDirectory() && !d.name.startsWith(".")) { const r = rel ? `${rel}/${d.name}` : d.name; out.push(r); walk(path.join(dir, d.name), r); } };
    walk(this.wsRoot, "");
    return out;
  }

  perform(a: Action): ReturnType<Driver["perform"]> {
    this.wrote = [];
    const r = this.performOne(a) as PerformResult;
    return { ...r, files: this.wrote };                       // the sim knows what it wrote: [] says nothing
  }
  /** What the action being performed saved: its receipt (PerformResult.files), [] when it saved nothing. */
  private wrote: { path: string; sha256: string }[] = [];

  private performOne(a: Action): ReturnType<Driver["perform"]> {
    if (a.kind === "wait") return { status: "ok" };
    if (a.kind === "file") return { status: "unsupported", why: "files are the executor's, not the desktop driver's" };
    if (a.kind === "double_click") a = { ...a, kind: "click" };     // the fake apps open on a click; a real one may need two
    if (a.kind === "open_window") {
      // which fake app opens: the kind an app of that name already has on this desktop (as a real one is resolved
      // from the running apps), one of its installed browsers by name or bundle id (the executor hands it the bundle
      // it settled on), a browser when a URL is asked for, otherwise an editor — no app names in code
      // an installed app not on screen: its restored window comes up, the user's content in it (opened_window, no proof made)
      const want = a.app.trim().toLowerCase();
      const inst = this.installed.find((x) => [x.app, x.bundle, ...x.names].some((n) => n?.toLowerCase() === want));
      if (inst && !this.wins.some((x) => x.app.toLowerCase() === inst.app.toLowerCase())) {
        const w = inst.kind === "mail" ? this.addMail(inst.state as Parameters<SimComputer["addMail"]>[0]) : this.addEditor(inst.app, inst.state.doc as { title: string; text: string; path: string | null });
        if (inst.bundle) w.bundle = inst.bundle;
        for (const x of this.wins) x.focused = x === w;
        this.log.push({ launched: w.id });
        // (hands' contract: was_running false — a launch of an app that was not running, the only proof hands gives)
        return { status: "ok", window: w.id, opened_window: { ...this.info(w), was_running: false } };
      }
      const b = simBrowser(a.app), name = b ? b.names[0]! : a.app;
      const known = this.wins.find((x) => x.app.toLowerCase() === name.toLowerCase() || x.bundle?.toLowerCase() === a.app.toLowerCase())?.kind ?? (b ? "browser" : undefined);
      const w = known === "mail" ? null : known === "browser" || (!known && a.url) ? this.addBrowser(name, [{ title: a.url ?? "新标签页", url: a.url ?? "about:blank" }]) : this.addEditor(name);
      if (!w) return { status: "unsupported", why: `cannot open ${a.app}` };
      for (const x of this.wins) x.focused = x === w;
      this.log.push({ opened: w.id });
      return { status: "ok", window: w.id, new_window: this.info(w) };
    }
    const w = this.win(a.window);
    if (a.kind === "focus_window") { for (const x of this.wins) x.focused = x === w; this.bump(); return { status: "ok", window: w.id }; }
    if (a.kind === "close_window") { this.wins = this.wins.filter((x) => x !== w); this.bump(); this.log.push({ closed: w.id }); return { status: "ok" }; }
    if (a.kind === "scroll") { this.bump(); return { status: "ok", window: w.id }; }
    if (a.kind === "key") {
      if (w.kind === "editor" && /cmd\+s/i.test(a.chord) && w.state.doc) return this.editorPress(w, "menu_save");
      this.bump(); return { status: "unverified", why: `${a.chord} sent; nothing read back`, window: w.id };
    }
    const obs = this.observe(a.window);
    const el = obs.elements.find((e) => e.id === a.target);
    if (!el) return { status: "error", why: `no element ${a.target} in the current observation of ${a.window}` };
    if (w.modal && !el.in_modal) { this.bump(); return { status: "blocked", why: `被「${w.modal.title}」挡住`, window: w.id }; }
    if (el.enabled === false) return { status: "error", why: `${el.label} 不可用`, window: w.id };
    if (!el.actions.includes(a.kind)) return { status: "error", why: `${el.label} 不支持 ${a.kind}`, window: w.id };
    const key = a.target.slice(a.target.lastIndexOf(":", a.target.indexOf(":", w.id.length + 1)) + 1);   // after "<win>:<gen>:"
    if (w.modal && key.startsWith("modal_")) { this.log.push({ modal_button: el.label, window: w.id }); w.modal = null; this.bump(); return { status: "ok", window: w.id }; }
    const r = w.kind === "mail" ? this.mailAct(w, key, a) : w.kind === "editor" ? this.editorAct(w, key, a) : w.kind === "browser" ? this.browserAct(w, key, a) : this.settingsAct(w, key, a);
    this.bump();
    return { window: w.id, ...r };
  }

  private mailAct(w: Win, key: string, a: Action): { status: "ok" | "error"; why?: string } {
    const s = w.state as MailState;
    if (key.startsWith("row:")) { if (s.dialog || s.composing) return { status: "error", why: "先处理打开的对话框或回复框" }; s.selected = key.slice(4); return { status: "ok" }; }
    if (key === "reply") { s.composing = { to: s.selected!, body: "" }; return { status: "ok" }; }
    if (key === "delete") { s.dialog = { kind: "delete", id: s.selected! }; return { status: "ok" }; }
    if (key === "flag") { const id = s.selected!; s.flagged = s.flagged.includes(id) ? s.flagged.filter((x) => x !== id) : [...s.flagged, id]; return { status: "ok" }; }
    if (key === "compose_body") { s.composing!.body = a.kind === "set_value" ? a.value : a.kind === "type" ? s.composing!.body + a.text : s.composing!.body; return { status: "ok" }; }
    if (key === "send") { s.replies.push({ to: s.composing!.to, body: s.composing!.body }); this.log.push({ sent: { ...s.composing } }); s.composing = null; return { status: "ok" }; }
    if (key === "compose_cancel") { s.composing = null; return { status: "ok" }; }
    if (key === "confirm_delete") { s.deleted.push(s.dialog!.id); this.log.push({ deleted: s.dialog!.id }); s.dialog = null; if (s.selected === s.deleted.at(-1)) s.selected = null; return { status: "ok" }; }
    if (key === "confirm_cancel") { s.dialog = null; return { status: "ok" }; }
    return { status: "error", why: "这个控件不能这样操作" };
  }

  private editorPress(w: Win, key: string): ReturnType<Driver["perform"]> { const r = this.editorAct(w, key, { kind: "click", window: w.id, target: key }); this.bump(); return { window: w.id, ...r }; }

  private editorAct(w: Win, key: string, a: Action): { status: "ok" | "error" | "unverified"; why?: string; new_window?: WindowInfo } {
    const s = w.state;
    if (key === "menu_new") { s.doc = { title: "未命名", text: "", path: null }; w.title = "未命名"; return { status: "ok" }; }
    if (key === "new_window_doc") {
      // a window of the same app, untitled, no file, no text: what hands reports as made by this action
      const n = this.wins.filter((x) => x.kind === "editor" && x.app === w.app && x.state.doc?.path === null && /^未命名-\d+$/.test(x.title)).length + 1;
      const made = this.addEditor(w.app, { title: `未命名-${n}`, text: "", path: null }, w.bundle ? { bundle: w.bundle } : {});
      this.log.push({ opened: made.id, from: w.id });
      return { status: "ok", why: `opened a new plain-text document '未命名-${n}'`, new_window: this.info(made) };
    }
    if (key === "menu_save" || key === "menu_saveas") {
      if (key === "menu_save" && s.doc.path) { this.write(w, s.doc.path); return { status: "ok" }; }
      s.sheet = { name: s.doc.path ? path.basename(s.doc.path) : s.doc.title + ".txt", folder: "." }; return { status: "ok" };
    }
    if (key === "textarea") { s.doc.text = a.kind === "set_value" ? a.value : a.kind === "type" ? s.doc.text + a.text : s.doc.text; w.title = s.doc.title + "（已修改）"; return { status: "ok" }; }
    if (key === "sheet_name") { s.sheet.name = a.kind === "set_value" ? a.value : a.kind === "type" ? s.sheet.name + a.text : s.sheet.name; return { status: "ok" }; }
    if (key === "sheet_folder") { if (a.kind !== "select" || !this.folders().includes(a.option)) return { status: "error", why: "没有这个位置" }; s.sheet.folder = a.option; return { status: "ok" }; }
    if (key === "sheet_cancel") { s.sheet = null; return { status: "ok" }; }
    if (key === "sheet_save") {
      const name = String(s.sheet.name).trim();
      if (!name || name.includes("/")) return { status: "error", why: "文件名无效" };
      const p = s.sheet.folder === "." ? name : `${s.sheet.folder}/${name}`;
      if (this.wsRoot && fs.existsSync(path.join(this.wsRoot, p)) && s.doc.path !== p) { w.modal = { title: `「${name}」已存在，要替换吗？`, buttons: ["取消", "替换"] }; s.pendingReplace = p; return { status: "ok" }; }
      this.write(w, p); s.sheet = null; return { status: "ok" };
    }
    return { status: "error", why: "这个控件不能这样操作" };
  }

  private write(w: Win, p: string) {
    if (!this.wsRoot) return;
    const full = path.join(this.wsRoot, p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, w.state.doc.text, "utf-8");
    this.wrote.push({ path: p, sha256: createHash("sha256").update(w.state.doc.text, "utf-8").digest("hex") });
    w.state.doc.path = p; w.state.doc.title = path.basename(p); w.title = w.state.doc.title;
  }

  private browserAct(w: Win, key: string, a: Action): { status: "ok" | "error"; why?: string } {
    const s = w.state;
    if (key === "address") { s.address = a.kind === "set_value" ? a.value : a.kind === "type" ? s.address + a.text : s.address; return { status: "ok" }; }
    if (key === "go") { const t = s.tabs[s.active]; t.url = s.address; t.title = s.address; t.text = this.pageText(s.address); w.title = t.title; this.log.push({ navigated: { tab: t.id, url: s.address } }); return { status: "ok" }; }
    if (key.startsWith("tab:")) { s.active = s.tabs.findIndex((t: any) => t.id === key.slice(4)); s.address = s.tabs[s.active].url; w.title = s.tabs[s.active].title; return { status: "ok" }; }
    if (key === "newtab") { const id = `${w.id}-tab${s.tabs.length + 1}`; s.tabs.push({ id, title: "新标签页", url: "about:blank", text: "" }); s.active = s.tabs.length - 1; s.address = ""; return { status: "ok" }; }
    return { status: "error", why: "这个控件不能这样操作" };
  }

  /** Pages the sim knows (tests register them); anything else is an empty page with its url as text. */
  pages: Record<string, string> = {};
  private pageText(url: string) { return this.pages[url] ?? `（${url}）`; }

  private settingsAct(w: Win, key: string, a: Action): { status: "ok" | "error"; why?: string } {
    const s = w.state;
    if (key.startsWith("toggle:")) { const k = key.slice(7); s.toggles[k] = !s.toggles[k]; return { status: "ok" }; }
    if (key.startsWith("dd:")) { const d = s.dropdowns[key.slice(3)]; if (a.kind !== "select" || !d.options.includes(a.option)) return { status: "error", why: "没有这个选项" }; d.value = a.option; return { status: "ok" }; }
    return { status: "error", why: "这个控件不能这样操作" };
  }

  mailState(windowId: string): MailState { return this.win(windowId).state; }
  state(windowId: string): any { return this.win(windowId).state; }
}
