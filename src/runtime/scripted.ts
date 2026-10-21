/**
 * A scripted model for tests: each step is an assistant turn written in advance — tool calls (with arguments), or
 * text — so the three lines are tested with no model and no network, and the test asserts what the model was shown.
 *
 * A text turn streams like a real service: start, text_start, one text_delta per chunk (`chunks`, default the whole
 * text), text_end, done. `delayMs` waits before each chunk, and the caller's abort signal is honoured between chunks
 * (the turn then ends "aborted" with the text so far), so a stop mid-reply can be tested. `final`: the finished
 * message says this instead of what was streamed (a service whose final text differs). `error` is a turn the
 * service failed (its message as pi-ai reports one, e.g. "401 Authentication Fails").
 */
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export type Step =
  | { calls: { name: string; args: Record<string, unknown> }[] }
  | { text: string; chunks?: string[]; delayMs?: number; final?: string }
  | { error: string }
  | ((messages: Message[]) => Step);

export function scriptedStream(steps: Step[], seen: Message[][] = []): StreamFn {
  let n = 0;
  return (model, context, options) => {
    const s = createAssistantMessageEventStream();
    seen.push([...context.messages]);
    let step = steps[n++];
    while (typeof step === "function") step = step(context.messages);
    const msg: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now(), content: [] };
    if (step && "text" in step) {
      const parts = step.chunks ?? [step.text];
      const delay = step.delayMs ?? 0;
      const signal = options?.signal;
      const wait = (ms: number) => new Promise<void>((res) => { if (!ms || signal?.aborted) return res(); const t = setTimeout(res, ms); signal?.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });
      const block = { type: "text" as const, text: "" };
      const snap = (): AssistantMessage => ({ ...msg, content: [{ ...block }] });
      void (async () => {
        await Promise.resolve();
        s.push({ type: "start", partial: snap() });
        s.push({ type: "text_start", contentIndex: 0, partial: snap() });
        for (const p of parts) {
          await wait(delay);
          if (signal?.aborted) { const out: AssistantMessage = { ...snap(), stopReason: "aborted", errorMessage: "aborted" }; s.push({ type: "error", reason: "aborted", error: out }); s.end(out); return; }
          block.text += p;
          s.push({ type: "text_delta", contentIndex: 0, delta: p, partial: snap() });
        }
        s.push({ type: "text_end", contentIndex: 0, content: block.text, partial: snap() });
        const out = step.final !== undefined ? { ...msg, content: [{ type: "text" as const, text: step.final }] } : snap();
        s.push({ type: "done", reason: "stop", message: out }); s.end(out);
      })();
      return s;
    }
    if (!step) { msg.stopReason = "error"; msg.errorMessage = "script exhausted"; }
    else if ("error" in step) { msg.stopReason = "error"; msg.errorMessage = step.error; }
    else { msg.content = step.calls.map((c, i) => ({ type: "toolCall", id: `call_${n}_${i}`, name: c.name, arguments: c.args as never })); msg.stopReason = "toolUse"; }
    queueMicrotask(() => { s.push(msg.stopReason === "error" ? { type: "error", reason: "error", error: msg } : { type: "done", reason: msg.stopReason as "stop" | "toolUse", message: msg }); s.end(msg); });
    return s;
  };
}
