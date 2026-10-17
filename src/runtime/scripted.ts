/**
 * A scripted model for tests: each step is an assistant turn written in advance — tool calls (with arguments), or
 * text — so the three lines are tested with no model and no network, and the test asserts what the model was shown.
 */
import { createAssistantMessageEventStream, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";

export type Step = { calls: { name: string; args: Record<string, unknown> }[] } | { text: string } | ((messages: Message[]) => Step);

export function scriptedStream(steps: Step[], seen: Message[][] = []): StreamFn {
  let n = 0;
  return (model, context) => {
    const s = createAssistantMessageEventStream();
    seen.push([...context.messages]);
    let step = steps[n++];
    while (typeof step === "function") step = step(context.messages);
    const msg: AssistantMessage = { role: "assistant", api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now(), content: [] };
    if (!step) { msg.stopReason = "error"; msg.errorMessage = "script exhausted"; }
    else if ("text" in step) msg.content = [{ type: "text", text: step.text }];
    else { msg.content = step.calls.map((c, i) => ({ type: "toolCall", id: `call_${n}_${i}`, name: c.name, arguments: c.args as never })); msg.stopReason = "toolUse"; }
    queueMicrotask(() => { s.push(msg.stopReason === "error" ? { type: "error", reason: "error", error: msg } : { type: "done", reason: msg.stopReason as "stop" | "toolUse", message: msg }); s.end(msg); });
    return s;
  };
}
