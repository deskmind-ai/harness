// rv-h13 repro (#67 Q1): an answer line in the same stdin chunk as the request goes to LineReader's queue (onAnswer is
// not set until appRun builds StdioUser) and nobody routes it: neither delivered nor refused. Before #67's redesign the
// card wait read it through next() and refused it ("no card … is open").
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { appRun, LineReader } from "../src/cli/app.js";
import { SimComputer } from "../src/executor/sim.js";
import { Gateway } from "../src/gateway/index.js";
import { scriptedStream } from "../src/runtime/scripted.js";

const MODEL = { id: "scripted", name: "scripted", api: "openai-completions", provider: "test", baseUrl: "", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, reasoning: false, contextWindow: 128_000, maxTokens: 8_000 } as never;
const gateway = () => {
  const gw = new Gateway(Object.fromEntries(["goal", "plan", "bind", "intent", "choice", "skill", "verify", "transform"].map((r) => [r, { backend: "scripted", model: "scripted" }])) as never);
  gw.script = Array(20).fill((role: string) => (role === "verify" ? { choice: "pass", reason: "ok" } : { choice: "matches" }));
  return gw;
};

describe("rv-h13 #67: an answer in the request's stdin chunk", () => {
  it("gets an outcome (refused: no such card)", async () => {
    const runs = fs.mkdtempSync(path.join(os.tmpdir(), "rv67-"));
    const pt = new PassThrough();
    const input = new LineReader(pt);
    // as main(): one chunk with the request and an answer, then `await input.next()` for the request
    pt.write(JSON.stringify({ raw: "看一眼" }) + "\n" + JSON.stringify({ type: "answer", ask_id: "ask_zzz", option: 0 }) + "\n");
    const req = JSON.parse(await input.next());
    const evs: any[] = [];
    await appRun(req, { runs, out: (e) => evs.push(e), input, linger: 0,
      inject: { driver: new SimComputer(), gateway: gateway(), model: { model: MODEL, streamFn: scriptedStream([{ calls: [{ name: "finish", args: { outcome: "cannot", summary: "no" } }] }]) } } });
    pt.end();
    await new Promise((r) => setTimeout(r, 50));
    expect(evs.some((e) => e.kind === "task_done")).toBe(true);
    expect(evs.filter((e) => e.kind === "refused" && e.what === "answer for ask_zzz")).toHaveLength(1);
  });
});
