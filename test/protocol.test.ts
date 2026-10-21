/**
 * The three interfaces' versions (docs/protocol.md): MCP initialize names them, the event stream's start carries its
 * own, and control lines are typed — with the untyped lines of before still read (control v1). The tool set the MCP
 * server lists is pinned by a golden file, so a change to it is a deliberate one. The consent types live in protocol/
 * and the executor's old names are the same things.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { Gateway } from "../src/gateway/index.js";
import { McpExecutorServer, TOOLS } from "../src/cli/mcp.js";
import { LineReader, StdioUser } from "../src/cli/app.js";
import { SimComputer } from "../src/executor/sim.js";
import { EventLog, type AppEvent } from "../src/protocol/events.js";
import type { Card } from "../src/orchestrator/index.js";
import { isForeignControl, parseControl } from "../src/protocol/control.js";
import { MCP_PROTOCOL_VERSION, PROTOCOL } from "../src/protocol/version.js";
import * as PC from "../src/protocol/consent.js";
import * as EC from "../src/executor/consent.js";
import * as ET from "../src/executor/types.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "protocol-"));
const GOLDEN = path.join(import.meta.dirname, "fixtures", "mcp-tools.golden.json");

describe("versions", () => {
  it("initialize negotiates the MCP revision (2025-06-18 preferred, 2024-11-05 echoed) and names tools/events/control v1 under experimental.deskmind", async () => {
    const s = new McpExecutorServer({ driver: () => new SimComputer(), gateway: new Gateway({} as never), consent: "none" });
    const r = (await s.handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as any;
    expect(r.result.protocolVersion).toBe("2025-06-18");
    expect(MCP_PROTOCOL_VERSION).toBe("2025-06-18");
    expect(r.result.capabilities.tools).toEqual({});
    expect(r.result.capabilities.experimental.deskmind).toEqual({ tools: 1, events: 1, control: 1 });
    // negotiation: a revision we speak is echoed; any other gets ours
    const ask = async (v: unknown) => ((await s.handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: v } })) as any).result.protocolVersion;
    expect(await ask("2024-11-05")).toBe("2024-11-05");
    expect(await ask("2025-06-18")).toBe("2025-06-18");
    expect(await ask("2099-01-01")).toBe("2025-06-18");
    expect(await ask(undefined)).toBe("2025-06-18");
    expect(PROTOCOL).toEqual({ tools: 1, events: 1, control: 1 });
  });

  it("the start event carries protocol.events, and a start without it (an older run's log) still reads", () => {
    const log = new EventLog(path.join(tmp(), "e.jsonl"), "r1");
    expect(log.emit({ kind: "start", raw: "x", lang: "zh", engine: "runtime", protocol: { events: PROTOCOL.events } })).toMatchObject({ kind: "start", protocol: { events: 1 } });
    expect(log.emit({ kind: "start", raw: "x", lang: "zh", engine: "runtime" })).not.toHaveProperty("protocol");
  });
});

describe("control lines", () => {
  it("typed lines parse; the untyped lines of before map onto the same types", () => {
    expect(parseControl('{"type":"answer","ask_id":"ask_1","option":2}')).toEqual({ type: "answer", ask_id: "ask_1", option: 2 });
    expect(parseControl('{"type":"answer","ask_id":"ask_1","text":"买牛奶"}')).toEqual({ type: "answer", ask_id: "ask_1", text: "买牛奶" });
    expect(parseControl('{"type":"stop"}')).toEqual({ type: "stop" });
    expect(parseControl('{"type":"respond","option":0}')).toEqual({ type: "respond", option: 0 });
    expect(parseControl('{"type":"steer","text":"只看今天的"}')).toEqual({ type: "steer", text: "只看今天的" });
    // v0, untyped
    expect(parseControl('{"ask_id":"ask_1","option":1}')).toEqual({ type: "answer", ask_id: "ask_1", option: 1 });
    expect(parseControl('{"text":"买牛奶"}')).toEqual({ type: "answer", text: "买牛奶" });
    expect(parseControl('{"stop":true}')).toEqual({ type: "stop" });
    expect(parseControl('{"respond":1}')).toEqual({ type: "respond", option: 1 });
    // not controls
    expect(parseControl("not json")).toBeNull();
    expect(parseControl("[1]")).toBeNull();
    expect(parseControl('{"type":"pause"}')).toBeNull();
    expect(parseControl('{"type":"steer"}')).toBeNull();
    expect(isForeignControl('{"type":"pause"}')).toBe(true);
    expect(isForeignControl('{"type":"stop"}')).toBe(false);
    expect(isForeignControl('{"ask_id":"a"}')).toBe(false);
  });

  it("a typed answer answers the open card; a typed stop lets go of it; a steer and an unknown type never answer it", async () => {
    const input = new PassThrough();
    const sent: AppEvent[] = [];
    const log = new EventLog(path.join(tmp(), "e.jsonl"), "r1", (ev) => sent.push(ev));
    const reader = new LineReader(input);
    const steers: string[] = [];
    let stops = 0;
    reader.onSteer = (t) => steers.push(t);
    reader.onStop = () => { stops++; };
    const u = new StdioUser(log, reader);
    const card: Card = { kind: "action", text: "点「发送」", free_text: false, blocking: true, options: [{ kind: "approve", text: "可以" }, { kind: "cancel", text: "先别做了" }] };
    const p = u.ask(card);
    await new Promise((r) => setTimeout(r, 10));
    const ask = sent.find((e) => e.kind === "ask") as Extract<AppEvent, { kind: "ask" }>;
    input.write(JSON.stringify({ type: "steer", text: "只发给林晓" }) + "\n");
    input.write(JSON.stringify({ type: "pause" }) + "\n");
    input.write(JSON.stringify({ type: "answer", ask_id: ask.ask_id, option: 0 }) + "\n");
    expect(await p).toEqual({ option: 0 });
    expect(steers).toEqual(["只发给林晓"]);
    const p2 = u.ask(card);
    await new Promise((r) => setTimeout(r, 10));
    input.write(JSON.stringify({ type: "stop" }) + "\n");
    expect(await p2).toBeNull();
    input.write(JSON.stringify({ stop: true }) + "\n");       // a second stop (v0 form) is the same stop: handled once
    await new Promise((r) => setTimeout(r, 10));
    expect(stops).toBe(1);
    expect(reader.stopped).toBe(true);
  });
});

describe("the MCP tool set", () => {
  it("tools/list matches the golden file (names and input schemas): UPDATE_GOLDEN=1 rewrites it, on purpose", async () => {
    const s = new McpExecutorServer({ driver: () => new SimComputer(), gateway: new Gateway({} as never), consent: "none" });
    const r = (await s.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" })) as any;
    const now = r.result.tools.map((t: any) => ({ name: t.name, inputSchema: t.inputSchema }));
    expect(now.map((t: any) => t.name)).toEqual(TOOLS.map((t) => t.name));
    if (process.env.UPDATE_GOLDEN === "1") fs.writeFileSync(GOLDEN, JSON.stringify(now, null, 2) + "\n");
    expect(now).toEqual(JSON.parse(fs.readFileSync(GOLDEN, "utf-8")));
  });
});

describe("consent types live in protocol/", () => {
  it("the executor's names are the protocol's, not copies", () => {
    expect(EC.canon).toBe(PC.canon);
    expect(EC.siteOf).toBe(PC.siteOf);
    const signer: PC.ConsentProvider = EC.ConsentSigner.fresh();      // the executor's signer is a protocol ConsentProvider
    expect(typeof signer.forAction).toBe("function");
    expect(EC.digestOf).toBe(PC.digestOf);
    expect(ET.CONSEQUENCES).toBe(PC.CONSEQUENCES);
    expect(ET.rank).toBe(PC.rank);
    expect(ET.higher).toBe(PC.higher);
    expect(PC.canon({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(EC.digestOf({ kind: "wait", ms: 1 }, "window:w", "external")).toBe(PC.digestOf({ kind: "wait", ms: 1 }, "window:w", "external"));
    expect(PC.digestOf({ kind: "click" }, "window:w", "external")).toMatch(/^sha256:[0-9a-f]{32}$/);
  });
});
