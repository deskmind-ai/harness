/** Gateway: a hung CLI call or an unreadable reply is asked again once; a cut-off answer is not. Goal prompt: inputs the
 *  request names are checked before preferences are asked. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { Gateway, TRUNCATED, type CallRecord } from "../src/gateway/index.js";
import { goalPrompt } from "../src/orchestrator/prompts.js";
import { ROLES, choiceAnswer } from "../src/protocol/roles.js";

const table = (backend: string, model: string, timeoutMs?: number) =>
  Object.fromEntries(ROLES.map((r) => [r, { backend, model, ...(timeoutMs ? { timeoutMs } : {}) }])) as any;

describe("gateway retries", () => {
  it("an unreadable reply is asked again once, and the second call says it is a retry", async () => {
    const saved = globalThis.fetch, logged: CallRecord[] = [];
    let n = 0;
    globalThis.fetch = (async () => {
      const content = n++ === 0 ? '{"choice": "a", "reason": "x"' : '{"choice": "a"}';
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content } }] }), { status: 200 });
    }) as any;
    try {
      const rep = await new Gateway(table("local_chat", "local:http://127.0.0.1:1/x"), { log: (r) => logged.push(r) }).ask("choice", "s", "u", choiceAnswer(["a", "b"]));
      expect(rep.outcome).toBe("answered");
      expect(logged.map((r) => [r.outcome, r.retry_of ?? null])).toEqual([["invalid", null], ["answered", "invalid"]]);
    } finally { globalThis.fetch = saved; }
  });

  it("a cut-off answer is not asked again (it would be cut again)", async () => {
    const saved = globalThis.fetch;
    let n = 0;
    globalThis.fetch = (async () => { n++; return new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: '{"choi' } }] }), { status: 200 }); }) as any;
    try {
      const rep = await new Gateway(table("local_chat", "local:http://127.0.0.1:1/x")).ask("choice", "s", "u", choiceAnswer(["a", "b"]));
      expect(rep.error).toBe(TRUNCATED);
      expect(n).toBe(1);
    } finally { globalThis.fetch = saved; }
  });

  it("a claude CLI call that times out is asked again once", async () => {
    // a stand-in `claude` on PATH: hangs the first time, answers the second
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "fake-claude-"));
    const count = path.join(bin, "count");
    fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh\ncat >/dev/null\nif [ ! -f "${count}" ]; then touch "${count}"; sleep 5; fi\necho '{"choice": "b"}'\n`, { mode: 0o755 });
    const savedPath = process.env.PATH, logged: CallRecord[] = [];
    process.env.PATH = `${bin}:${savedPath}`;
    try {
      const rep = await new Gateway(table("claude_cli", "sonnet", 1500), { log: (r) => logged.push(r) }).ask("choice", "s", "u", choiceAnswer(["a", "b"]));
      expect(rep.outcome).toBe("answered");
      expect((rep.data as any).choice).toBe("b");
      expect(logged.map((r) => r.outcome)).toEqual(["timeout", "answered"]);
      expect(logged[1]!.retry_of).toBe("timeout");
    } finally { process.env.PATH = savedPath; }
  }, 20_000);
});

describe("goal prompt", () => {
  it("asks the model to check that the named inputs exist before asking about preferences", () => {
    const p = goalPrompt("把 截图.png 识别成文字", [], { entries: [], truncated: false } as any, [], "");
    expect(p).toContain("先核对要求里提到的输入在不在");
  });
});
