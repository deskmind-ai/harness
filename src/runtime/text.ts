/**
 * What the user reads on cards, in the request's language (plan §四: 卡片和步骤的文字跟着请求的语言走). The model is
 * spoken to in Chinese regardless; only the user-facing strings live here.
 */
export type Lang = "zh" | "en";

const ZH = {
  ok: "可以", okPlan: "可以，就这样做", skipStep: "这一步不要", cancel: "先别做了", delegate: "由你决定", fine: "好的", undo: "撤回",
  planTitle: "我打算这样做：", planAsk: "可以吗？", modifyYours: "——改你的东西", external: "——往外发，到时候再确认一次", modifyAndExternal: "——改你的东西，也会往外发；发之前再确认一次",
  ambiguity: (point: string) => `「${point}」可以有几种理解，你指的是哪一种？`,
  did: (what: string[]) => `做了：${what.join("；")}`, changedYours: (objs: string[]) => `改动了你的：${objs.join("、")}`, noUndo: (why: string) => `（${why}）`,
  at: (where: string) => `在 ${where} `, click: (l: string) => `点「${l}」`, doubleClick: (l: string) => `双击「${l}」`, set: (l: string, v: string) => `把「${l}」设为「${v}」`, type: (l: string, t: string) => `在「${l}」里输入「${t}」`,
  select: (l: string, o: string) => `把「${l}」选成「${o}」`, key: (c: string) => `按 ${c}`, closeWindow: "关闭窗口", openWindow: (a: string) => `打开 ${a}`, focusWindow: "切到窗口", scroll: "滚动", wait: "等待",
  sends: "这会把内容发出去", modifies: "这会改动你的东西", modifiesFile: "这会改动你的文件", undoable: "界面上的操作撤不回", noUndoFor: (cap: string) => `${cap} 没有撤回的办法`,
  openedInYours: "在你已开着的窗口里打开的页面撤不回",
  outgoing: (fields: string[], shown: string[]) => `\n要发出去的：${fields.length || shown.length ? [...fields, ...shown].map((f) => `\n· ${f}`).join("") : "窗口里看不到要发出的内容"}`,
  byRule: (rules: string[]) => `按你以前定的规则做的：${rules.join("、")}`,
  typed: (t: string) => `这次任务打的字：${t}`,
  mainWindow: (app: string) => `${app} 的主窗口`,
  openInYours: (app: string, hosts: string[]) => `在你的 ${app} 窗口里打开这些网站的网页：${hosts.join("、")}`,
  openUrl: (app: string, url: string) => `在 ${app} 里打开网页 ${url}`,
  openSite: (app: string, host: string, url: string, _by: "read") => `在 ${app} 里打开网站 ${host}（这次是 ${url}）。这次任务读过你的文件或窗口里的内容，打开 ${host} 可能把这些内容带过去。同意后，这次任务里再打开 ${host} 的网页不再问`,
  openLink: (app: string, url: string, _by: "read") => `在 ${app} 里打开 ${url}。这次任务读过你的文件或窗口里的内容，打开它可能把这些内容带过去。这类链接每次都会问`,
  openSites: (app: string, sites: string[]) => `在 ${app} 里打开这些网站：${sites.join("、")}`,
  site: (host: string, sends: string | null) => (sends ? `${host}（发过去的：${sends}）` : host),
  toSites: "——会发到这些网站；同意后，这次任务里打开这些网站不再逐次问", modifyAndSites: "——改你的东西，也会发到这些网站；同意后，这次任务里打开这些网站不再逐次问",
  openedMain: (app: string) => `DeskMind 打开的 ${app} 主窗口`, openedTitled: (app: string, title: string) => `DeskMind 打开的 ${app}「${title}」`,
  leftOpen: (app: string) => `打开 ${app}（撤回时不关它：窗口里可能有你的东西）`,
  undoKeepsOpen: (apps: string[]) => `撤回不会关掉：${apps.join("、")}`,
  checkYourself: (what: string) => `该做的都做了，但我没法确认结果，请你看一下：${what}`,
  foreground: (apps: string[]) => `注意：${apps.join("、")} 只能在前台操作。做这些步骤时，我会把它短暂切到前台；这段时间请先别用电脑。`,
};
const EN: typeof ZH = {
  ok: "OK", okPlan: "OK, go ahead", skipStep: "Skip this step", cancel: "Stop here", delegate: "You decide", fine: "Fine", undo: "Undo",
  planTitle: "Here is what I plan to do:", planAsk: "OK?", modifyYours: " — changes your things", external: " — sends something out; I will confirm then", modifyAndExternal: " — changes your things, and sends something out; I will confirm before sending",
  ambiguity: (point: string) => `"${point}" can be read in more than one way. Which do you mean?`,
  did: (what: string[]) => `Done: ${what.join("; ")}`, changedYours: (objs: string[]) => `Changed yours: ${objs.join(", ")}`, noUndo: (why: string) => `(${why})`,
  at: (where: string) => `In ${where}: `, click: (l: string) => `click "${l}"`, doubleClick: (l: string) => `double-click "${l}"`, set: (l: string, v: string) => `set "${l}" to "${v}"`, type: (l: string, t: string) => `type "${t}" into "${l}"`,
  select: (l: string, o: string) => `choose "${o}" in "${l}"`, key: (c: string) => `press ${c}`, closeWindow: "close the window", openWindow: (a: string) => `open ${a}`, focusWindow: "switch to the window", scroll: "scroll", wait: "wait",
  sends: "this sends something out", modifies: "this changes your things", modifiesFile: "this changes your file", undoable: "an action on screen cannot be undone", noUndoFor: (cap: string) => `${cap} cannot be undone`,
  openedInYours: "a page opened in a window of yours cannot be undone",
  outgoing: (fields: string[], shown: string[]) => `\nWhat goes out:${fields.length || shown.length ? [...fields, ...shown].map((f) => `\n· ${f}`).join("") : " not visible in the window"}`,
  byRule: (rules: string[]) => `Under your standing rule: ${rules.join(", ")}`,
  typed: (t: string) => `typed by this task: ${t}`,
  mainWindow: (app: string) => `${app}'s main window`,
  openInYours: (app: string, hosts: string[]) => `open pages of these sites in your ${app} window: ${hosts.join(", ")}`,
  openUrl: (app: string, url: string) => `open ${url} in ${app}`,
  openSite: (app: string, host: string, url: string, _by: "read") => `open the site ${host} in ${app} (this time ${url}). This task has read your files or windows; opening ${host} may carry what it read there. Once you agree, other pages of ${host} open without asking in this task`,
  openLink: (app: string, url: string, _by: "read") => `open ${url} in ${app}. This task has read your files or windows; opening it may carry that along. Links like this ask every time`,
  openSites: (app: string, sites: string[]) => `open these sites in ${app}: ${sites.join(", ")}`,
  site: (host: string, sends: string | null) => (sends ? `${host} (sending: ${sends})` : host),
  toSites: " — sends to these sites; once you agree, opening them asks no more in this task", modifyAndSites: " — changes your things, and sends to these sites; once you agree, opening them asks no more in this task",
  openedMain: (app: string) => `the ${app} main window DeskMind opened`, openedTitled: (app: string, title: string) => `${app} "${title}" (opened by DeskMind)`,
  leftOpen: (app: string) => `open ${app} (left open on undo: it may hold your things)`,
  undoKeepsOpen: (apps: string[]) => `Undo will not close: ${apps.join(", ")}`,
  checkYourself: (what: string) => `Everything was done, but I could not confirm the result; please check: ${what}`,
  foreground: (apps: string[]) => `Note: ${apps.join(", ")} can only be operated in front. For these steps I will bring it to the front briefly; please leave the Mac alone meanwhile.`,
};
export const T = (lang?: string) => (lang === "en" ? EN : ZH);
