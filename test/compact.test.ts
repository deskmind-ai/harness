import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { compact, sizeOf } from "../src/runtime/compact.js";

const t = Date.now();
const user = (text: string): Message => ({ role: "user", content: text, timestamp: t });
const result = (id: string, text: string, image = false): Message => ({ role: "toolResult", toolCallId: id, toolName: "computer_observe", content: [...(image ? [{ type: "image" as const, data: "x", mimeType: "image/png" }] : []), { type: "text" as const, text }], isError: false, timestamp: t });

describe("context compaction", () => {
  it("under budget nothing changes; over budget old observations are stubbed oldest first, the user's words and the newest results stay whole", () => {
    const big = "元素".repeat(600);
    const ms: Message[] = [{ role: "system", content: "基础技能", timestamp: t }, user("把林晓那封邮件加旗标"), ...Array.from({ length: 10 }, (_, i) => result(`c${i}`, `观察 ${i} ${big}`))];
    expect(compact(ms, 1_000_000).compaction).toBeNull();
    const { messages, compaction } = compact(ms, sizeOf(ms) - 3000);
    expect(compaction).toMatchObject({ kept: ms.length, images_dropped: 0 });
    expect(compaction!.stubbed).toBeGreaterThan(0);
    expect(compaction!.chars_after).toBeLessThanOrEqual(sizeOf(ms) - 3000);
    expect(messages[1]).toEqual(ms[1]);                                              // the user's words, untouched
    expect(messages.at(-1)).toEqual(ms.at(-1));                                      // the newest result, whole
    const first = messages[2] as Extract<Message, { role: "toolResult" }>;
    expect((first.content[0] as { text: string }).text).toContain("已省略");
    expect((first.content[0] as { text: string }).text.startsWith("观察 0")).toBe(true);
  });

  it("images go first", () => {
    const ms: Message[] = [user("x"), result("a", "短文字", true), result("b", "短文字", true), result("c", "短文字")];
    const { messages, compaction } = compact(ms, sizeOf(ms) - 3900);
    expect(compaction!.images_dropped).toBe(1);
    expect(compaction!.stubbed).toBe(0);
    expect(JSON.stringify(messages[1])).toContain("截图已省略");
    expect(JSON.stringify(messages[2])).toContain('"type":"image"');
  });
});
