/**
 * `harness.mjs runtime`: the agent loop as a child process of the executor (executor split P2, deskmind#90 item 6;
 * the topology is in host/agent.ts). It speaks MCP to the executor on stdin/stdout as a client and gets its spec (the
 * request, its model, its budget, its log) in the initialize result's `_meta` ("deskmind/agent") — not from its
 * environment or command line, which other processes of the same user can read (`ps eww`) and which have a size limit.
 * It writes only its own files: runtime.jsonl (its events and each call's round trip, `mcp.rtt`); its stderr is
 * runtime.log. Its model calls and spans go to the executor (transport/report.ts).
 *
 * It exits 0 after `end`, and at once when its stdin ends — the executor is gone (even by kill -9), so nobody is left
 * to act for. SIGINT is ignored: a terminal's ^C reaches the whole process group, and the executor's stop comes as a
 * notification (the executor then still serves the loop's `end`).
 */
import { SPEC_META, jsonl, loopFromSpec, type AgentSpec } from "../host/agent.js";
import type { AgentLoop } from "../runtime/loop.js";
import { JsonRpcPeer } from "../transport/jsonrpc.js";
import { McpPort, STEER_NOTIFICATION, STOP_NOTIFICATION } from "../transport/mcp-port.js";
import { reportingContext } from "../transport/report.js";
import { current, within } from "../otel/context.js";

export const EXIT_EXECUTOR_GONE = 3;

export async function runtimeMain(): Promise<number> {
  process.on("SIGINT", () => {});
  const peer = new JsonRpcPeer(process.stdin, process.stdout);
  const port = new McpPort(peer, "");
  let log = jsonl(undefined);
  let loop: AgentLoop | null = null, stopped = false;
  peer.onNotification = (method) => {
    if (method === STOP_NOTIFICATION) { stopped = true; loop?.stop(); log("control.stop", {}); }
    else if (method === STEER_NOTIFICATION) { port.steerWaiting(); log("control.steer", {}); }
  };
  peer.onRequest = (msg) => peer.respond({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "the runtime serves nothing" } });
  void peer.closed.then((why) => { process.stderr.write(`runtime: the executor is gone (${why})\n`); process.exit(EXIT_EXECUTOR_GONE); });
  port.onCall = (c) => log("mcp.rtt", c);
  const t0 = Date.now();
  const init = await port.initialize();
  const spec = ((init._meta as Record<string, unknown> | undefined)?.[SPEC_META] ?? null) as AgentSpec | null;
  if (!spec || typeof spec.raw !== "string") { process.stderr.write("runtime: the executor sent no spec\n"); return 2; }
  port.raw = spec.raw;
  log = jsonl(spec.log);
  log("runtime.start", { pid: process.pid, init_ms: Date.now() - t0 });
  loop = loopFromSpec(spec, port);
  const l = loop;
  port.counters = () => l.counters;
  if (stopped) l.stop();
  // its model calls and spans go to the executor, which owns the run's records (transport/report.ts)
  const r = await within(reportingContext(peer, spec.report, current), () => l.run());
  log("runtime.end", { status: r.status, reason: r.reason });
  return 0;
}
