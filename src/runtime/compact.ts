/**
 * Context compaction for the loop (design notes docs/research/harness-survey-2026-10-18.md §上下文压缩): when the
 * transcript outgrows the model's window, old observations are cut down to a stub, oldest first, images first; the
 * user's words are never touched (they are the evidence), nor are the model's own turns (tool calls must stay paired
 * with their results), nor the newest results (what the model is working from). Applied to the copy sent to the
 * model; the transcript itself keeps everything, and every compaction is reported as an event.
 */
import type { Message } from "@earendil-works/pi-ai";

export interface Compaction { kept: number; stubbed: number; images_dropped: number; chars_before: number; chars_after: number }

const KEEP_LAST_RESULTS = 6;         // the newest tool results stay whole: the model is acting on them
const STUB_HEAD = 240;                // what remains of a stubbed result: enough to know what it was

const textOf = (m: Message): string => {
  if (typeof m.content === "string") return m.content;
  return (m.content as { type: string; text?: string }[]).map((c) => (c.type === "text" ? c.text ?? "" : c.type === "image" ? "[image]" : "")).join("");
};
export const sizeOf = (ms: Message[]) => ms.reduce((a, m) => a + textOf(m).length + ("content" in m && Array.isArray(m.content) ? (m.content as { type: string }[]).filter((c) => c.type === "image").length * 4000 : 0), 0);

/** Cut the transcript down to `budgetChars` (a character is taken as a token: Chinese text makes that about right). */
export function compact(messages: Message[], budgetChars: number): { messages: Message[]; compaction: Compaction | null } {
  const before = sizeOf(messages);
  if (before <= budgetChars) return { messages, compaction: null };
  const out = [...messages];
  let images = 0, stubbed = 0;
  // images first, oldest first, every tool result's
  for (let i = 0; i < out.length && sizeOf(out) > budgetChars; i++) {
    const m = out[i]!;
    if (m.role !== "toolResult" || !Array.isArray(m.content)) continue;
    const kept = m.content.filter((c) => c.type !== "image");
    if (kept.length !== m.content.length) { images += m.content.length - kept.length; out[i] = { ...m, content: [...kept, { type: "text", text: "[截图已省略：需要就重新观察]" }] } as Message; }
  }
  // then old tool results, oldest first, the newest KEEP_LAST_RESULTS left whole
  const resultIdx = out.map((m, i) => (m.role === "toolResult" ? i : -1)).filter((i) => i >= 0);
  const protectedFrom = resultIdx.length - KEEP_LAST_RESULTS;
  for (let k = 0; k < resultIdx.length && sizeOf(out) > budgetChars; k++) {
    if (k >= protectedFrom) break;
    const i = resultIdx[k]!, m = out[i]! as Extract<Message, { role: "toolResult" }>;
    const t = textOf(m);
    if (t.length <= STUB_HEAD + 80) continue;
    out[i] = { ...m, content: [{ type: "text", text: `${t.slice(0, STUB_HEAD)}…[已省略 ${t.length - STUB_HEAD} 字：这是早先的观察，界面可能已变，需要就重新观察]` }] } as Message;
    stubbed += 1;
  }
  return { messages: out, compaction: { kept: out.length, stubbed, images_dropped: images, chars_before: before, chars_after: sizeOf(out) } };
}
