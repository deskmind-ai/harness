/**
 * What the session model reads (docs/protocol.md 「会话（第 1 版）」): the system prompt and the stored conversation.
 *
 * Compaction: the budget is 60% of the model's window (a character taken as a token, as runtime/compact.ts). When the
 * conversation outgrows it, the oldest whole exchanges are dropped — an exchange is the user's message(s) and the
 * reply — down to about half the budget in one go, and the system prompt says how many messages were left out. So the
 * cut moves once in a while, not every turn, and what the model reads keeps the same beginning for several turns (the
 * service's prompt cache). The cut is found by replaying the conversation exchange by exchange (one pass, sizes
 * computed once), so the same history always gives the same cut and appending to it never moves the cut until the
 * budget is passed again. The newest exchange, the one with the newest user message, is never cut, whatever its size
 * (a user message is at most 32k characters, well under any budget).
 *
 * Consecutive user messages (a reply that never came: the process was killed, the service failed) are read as one
 * message, so the model always sees user and assistant taking turns. An empty reply (stopped before any text) is left
 * out; a stopped one is marked as such.
 */
import type { StoredMessage } from "./log.js";

export type Lang = "zh" | "en";
export interface ContextMessage { role: "user" | "assistant"; text: string }
export interface BuiltContext { system: string; messages: ContextMessage[]; dropped: number; chars: number }

/** Share of the model's window the context may fill. */
export const WINDOW_SHARE = 0.6;
/** Once over the budget, the conversation is cut down to this share of it. */
export const CUT_TO = 0.5;

const SYSTEM: Record<Lang, string> = {
  zh: [
    "你是 DeskMind，运行在用户这台 Mac 上的个人助手。你和用户聊天：回答问题、出主意、帮他写东西和想清楚事情。",
    "你只能通过「电脑任务」操作这台电脑（打开应用、读写文件、在网页或应用里点按和输入、发消息等）。电脑任务现在还没有接进这个对话，所以此刻你不能操作电脑，也看不到屏幕、窗口和文件。",
    "因此：不要说你已经在电脑上做了什么、打开了什么、改了什么或发了什么，也不要说你看到了屏幕或文件里的内容。用户要你在电脑上动手时，直说现在这个对话里还做不到，需要的话告诉他怎么自己做。",
    "用用户说的语言回答，简洁直接。",
  ].join("\n"),
  en: [
    "You are DeskMind, a personal agent on the user's Mac. You chat with the user: answer questions, suggest ideas, help them write and think things through.",
    "You can operate this computer only through computer tasks (opening apps, reading and writing files, clicking and typing in apps and web pages, sending messages). Computer tasks are not connected to this chat yet, so right now you cannot operate the computer, and you cannot see the screen, windows or files.",
    "So never say you did, opened, changed or sent anything on the computer, and never claim to see what is on the screen or in a file. When the user asks you to do something on the computer, say plainly that this chat cannot do it yet and, if useful, tell them how to do it themselves.",
    "Answer in the user's language, briefly and directly.",
  ].join("\n"),
};

/** The local date, YYYY-MM-DD. */
export const localDate = (d: Date = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** The session's system prompt, with today's date (local) at the end. */
export function systemPrompt(lang: Lang = "zh", now: Date = new Date()): string {
  return SYSTEM[lang] + (lang === "en" ? `\nToday is ${localDate(now)} (local time).` : `\n今天是 ${localDate(now)}（本地时间）。`);
}

const omitted = (n: number, lang: Lang) => lang === "en" ? `\n\n(${n} earlier messages of this conversation are omitted.)` : `\n\n（更早的 ${n} 条对话已省略）`;
const stoppedMark = (lang: Lang) => lang === "en" ? "\n\n(The user stopped this reply partway.)" : "\n\n（这条回复被用户中途停下了）";

/** The exchanges of a conversation: each starts at a user message that follows a reply (or the first message). */
export function exchanges(history: StoredMessage[]): StoredMessage[][] {
  const out: StoredMessage[][] = [];
  for (const m of history) {
    if (m.role === "assistant" && !m.text) continue;               // stopped before any text: nothing was said
    const cur = out[out.length - 1];
    const prev = cur?.[cur.length - 1];
    if (!cur || (m.role === "user" && prev?.role === "assistant")) out.push([m]); else cur.push(m);
  }
  return out;
}

/** One exchange as the model reads it: consecutive messages of one role joined into one. */
function flatten(group: StoredMessage[], lang: Lang): ContextMessage[] {
  const out: ContextMessage[] = [];
  for (const m of group) {
    const text = m.role === "assistant" && m.stopped ? m.text + stoppedMark(lang) : m.text;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.text += "\n\n" + text; else out.push({ role: m.role, text });
  }
  return out;
}

/** The system prompt and the conversation, cut to `budgetChars` by dropping the oldest whole exchanges. */
export function buildContext(history: StoredMessage[], o: { budgetChars: number; lang?: Lang; system?: string }): BuiltContext {
  const lang = o.lang ?? "zh";
  const base = o.system ?? systemPrompt(lang);
  const groups = exchanges(history).map((g) => { const msgs = flatten(g, lang); return { msgs, count: g.length, size: msgs.reduce((b, m) => b + m.text.length, 0) }; });
  const room = o.budgetChars - base.length;
  // replay: add the exchanges one by one; whenever the kept ones pass the room, drop the oldest down to CUT_TO of it
  // (never the one just added)
  let start = 0, kept = 0;
  for (let k = 0; k < groups.length; k++) {
    kept += groups[k]!.size;
    if (kept <= room) continue;
    while (start < k && kept > room * CUT_TO) kept -= groups[start++]!.size;
  }
  const dropped = groups.slice(0, start).reduce((a, g) => a + g.count, 0);
  const system = dropped ? base + omitted(dropped, lang) : base;
  return { system, messages: groups.slice(start).flatMap((g) => g.msgs), dropped, chars: system.length + kept };
}
