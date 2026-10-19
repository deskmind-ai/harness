/**
 * What the user reads on cards, in the request's language (plan §四: 卡片和步骤的文字跟着请求的语言走). The model is
 * spoken to in Chinese regardless; only the user-facing strings live here.
 */
export type Lang = "zh" | "en";

const ZH = {
  ok: "可以", okPlan: "可以，就这样做", skipStep: "这一步不要", cancel: "先别做了", delegate: "由你决定", fine: "好的", undo: "撤回",
  planTitle: "我打算这样做：", planAsk: "可以吗？", modifyYours: "——改你的东西", external: "——往外发，到时候再确认一次",
  ambiguity: (point: string) => `「${point}」可以有几种理解，你指的是哪一种？`,
  did: (what: string[]) => `做了：${what.join("；")}`, changedYours: (objs: string[]) => `改动了你的：${objs.join("、")}`, noUndo: (why: string) => `（${why}）`,
  at: (where: string) => `在 ${where} `, click: (l: string) => `点「${l}」`, doubleClick: (l: string) => `双击「${l}」`, set: (l: string, v: string) => `把「${l}」设为「${v}」`, type: (l: string, t: string) => `在「${l}」里输入「${t}」`,
  select: (l: string, o: string) => `把「${l}」选成「${o}」`, key: (c: string) => `按 ${c}`, closeWindow: "关闭窗口", openWindow: (a: string) => `打开 ${a}`, focusWindow: "切到窗口", scroll: "滚动", wait: "等待",
  sends: "这会把内容发出去", modifies: "这会改动你的东西", modifiesFile: "这会改动你的文件", undoable: "界面上的操作撤不回", noUndoFor: (cap: string) => `${cap} 没有撤回的办法`,
  openedInYours: "在你已开着的窗口里打开的页面撤不回",
  outgoing: (fields: string[], context: string) => `\n要发出去的：${fields.length ? fields.map((f) => `\n· ${f}`).join("") : "窗口里看不到要发出的内容"}${context ? `\n窗口里显示的：${context}` : ""}`,
  byRule: (rules: string[]) => `按你以前定的规则做的：${rules.join("、")}`,
};
const EN: typeof ZH = {
  ok: "OK", okPlan: "OK, go ahead", skipStep: "Skip this step", cancel: "Stop here", delegate: "You decide", fine: "Fine", undo: "Undo",
  planTitle: "Here is what I plan to do:", planAsk: "OK?", modifyYours: " — changes your things", external: " — sends something out; I will confirm then",
  ambiguity: (point: string) => `"${point}" can be read in more than one way. Which do you mean?`,
  did: (what: string[]) => `Done: ${what.join("; ")}`, changedYours: (objs: string[]) => `Changed yours: ${objs.join(", ")}`, noUndo: (why: string) => `(${why})`,
  at: (where: string) => `In ${where}: `, click: (l: string) => `click "${l}"`, doubleClick: (l: string) => `double-click "${l}"`, set: (l: string, v: string) => `set "${l}" to "${v}"`, type: (l: string, t: string) => `type "${t}" into "${l}"`,
  select: (l: string, o: string) => `choose "${o}" in "${l}"`, key: (c: string) => `press ${c}`, closeWindow: "close the window", openWindow: (a: string) => `open ${a}`, focusWindow: "switch to the window", scroll: "scroll", wait: "wait",
  sends: "this sends something out", modifies: "this changes your things", modifiesFile: "this changes your file", undoable: "an action on screen cannot be undone", noUndoFor: (cap: string) => `${cap} cannot be undone`,
  openedInYours: "a page opened in a window of yours cannot be undone",
  outgoing: (fields: string[], context: string) => `\nWhat goes out:${fields.length ? fields.map((f) => `\n· ${f}`).join("") : " not visible in the window"}${context ? `\nThe window shows: ${context}` : ""}`,
  byRule: (rules: string[]) => `Under your standing rule: ${rules.join(", ")}`,
};
export const T = (lang?: string) => (lang === "en" ? EN : ZH);
