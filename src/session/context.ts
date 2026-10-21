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
/** What the model reads: the user's words, the assistant's (with the computer tasks it started in that turn: `calls`),
 *  and a task's result as a tool message. */
export type ContextMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; calls?: { id: string; goal: string }[] }
  | { role: "tool"; call_id: string; text: string };
const sizeOf = (m: ContextMessage) => m.text.length + (m.role === "assistant" && m.calls ? m.calls.reduce((a, c) => a + c.goal.length + 40, 0) : 0);
export interface BuiltContext { system: string; messages: ContextMessage[]; dropped: number; chars: number }

/** Share of the model's window the context may fill. */
export const WINDOW_SHARE = 0.6;
/** Once over the budget, the conversation is cut down to this share of it. */
export const CUT_TO = 0.5;

const SYSTEM: Record<Lang, string> = {
  zh: [
    "你是 DeskMind，运行在用户这台 Mac 上的个人助手。你和用户聊天：回答问题、出主意、帮他写东西和想清楚事情。",
    "你只能通过工具 computer_task 操作这台电脑（打开应用、读写文件、在网页或应用里点按和输入、发消息等）。用户要你在电脑上做事时，调用 computer_task，goal 写你对要做的事的转述。用户自己的原话会原样交给任务，转述只作参考；改用户东西、往外发之前，任务会自己出卡片请用户同意，你不用先问。一条用户消息最多开 3 个电脑任务。",
    "任务进行时你在等它的结果。结果里有 status、reason、summary、answer、changes（改动）、undo（open 表示用户现在可以在结果卡上撤回）、steers（用户中途补充的话）。你看不到屏幕、窗口和文件内容，只看得到这个结果。",
    "只有 status 是 succeeded 时才能说做成了；其他状态如实说没做成、停下了或不确定，并说原因。不要说你看到了屏幕或文件里结果之外的内容。不调用 computer_task 时，不要说你在电脑上做了什么。",
    "用用户说的语言回答，简洁直接。",
  ].join("\n"),
  en: [
    "You are DeskMind, a personal agent on the user's Mac. You chat with the user: answer questions, suggest ideas, help them write and think things through.",
    "You can operate this computer only through the tool computer_task (opening apps, reading and writing files, clicking and typing in apps and web pages, sending messages). When the user wants something done on the computer, call computer_task with goal set to your restatement of it. The user's own words go to the task as they are; your restatement is only a reference. The task asks the user's consent itself before changing their things or sending anything, so you need not ask first. At most 3 computer tasks per user message.",
    "While a task runs you wait for its result: status, reason, summary, answer, changes, undo (open: the user can undo it now on the result card), steers (what the user added mid-task). You cannot see the screen, windows or files; you see only this result.",
    "Say a task was done only when its status is succeeded; otherwise say plainly that it was not done, was stopped or is uncertain, and why. Never claim to have seen anything on the screen or in a file beyond the result. Without a computer_task call, never say you did anything on the computer.",
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

/** The exchanges of a conversation: each starts at a user message that follows a reply or a task (or the first
 *  message). A task's call with no result (still running) is left out: the model would read a call nobody answered. */
export function exchanges(history: StoredMessage[]): StoredMessage[][] {
  const answered = new Set(history.flatMap((m) => (m.role === "result" ? [m.call_id] : [])));
  const out: StoredMessage[][] = [];
  for (const m of history) {
    if (m.role === "assistant" && !m.text) continue;               // stopped before any text: nothing was said
    if (m.role === "call" && !answered.has(m.call_id)) continue;
    const cur = out[out.length - 1];
    const prev = cur?.[cur.length - 1];
    if (!cur || (m.role === "user" && prev && prev.role !== "user")) out.push([m]); else cur.push(m);
  }
  return out;
}

/** One exchange as the model reads it: consecutive messages of one role joined into one; a task's call joins the
 *  assistant's words before it (one assistant turn), its result is a tool message. */
function flatten(group: StoredMessage[], lang: Lang): ContextMessage[] {
  const out: ContextMessage[] = [];
  for (const m of group) {
    const last = out[out.length - 1];
    if (m.role === "call") {
      if (last?.role === "assistant") (last.calls ??= []).push({ id: m.call_id, goal: m.goal });
      else out.push({ role: "assistant", text: "", calls: [{ id: m.call_id, goal: m.goal }] });
      continue;
    }
    if (m.role === "result") { out.push({ role: "tool", call_id: m.call_id, text: m.text }); continue; }
    const text = m.role === "assistant" && m.stopped ? m.text + stoppedMark(lang) : m.text;
    if (last && last.role === m.role && !(last.role === "assistant" && last.calls)) last.text += "\n\n" + text;
    else out.push(m.role === "user" ? { role: "user", text } : { role: "assistant", text });
  }
  return out;
}

/** The system prompt and the conversation, cut to `budgetChars` by dropping the oldest whole exchanges. */
export function buildContext(history: StoredMessage[], o: { budgetChars: number; lang?: Lang; system?: string }): BuiltContext {
  const lang = o.lang ?? "zh";
  const base = o.system ?? systemPrompt(lang);
  const groups = exchanges(history).map((g) => { const msgs = flatten(g, lang); return { msgs, count: g.length, size: msgs.reduce((b, m) => b + sizeOf(m), 0) }; });
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
