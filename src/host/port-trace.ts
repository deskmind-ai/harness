/**
 * The executor's own record of what its runtime asked (executor split P2): every port call as a `tool.call` before it
 * and a `tool.result` after it (the reply's text as the model reads it, cut to 2000 characters, and the time the
 * executor took, `ms`), under the tool names our loop gives the model (computer_act, fs_write, …). These used to be
 * the loop's events; since the loop may run in another process, the executor writes them from what reaches the port,
 * so the trace (trace.jsonl) and the app's `step` events (cli/app.ts toProtocol: a computer_act call is a step) are
 * the same whichever way the runtime runs — and come from the side that acted, not from the caller's account of it.
 * The loop's own events (its model turns, compaction) are the runtime's log (runtime.jsonl).
 */
import type { ExecutorPort, ToolReply } from "../protocol/port.js";

type Emit = (kind: string, body: Record<string, unknown>) => void;

export function tracedPort(port: ExecutorPort, emit: Emit, onEnd?: (p: ReturnType<ExecutorPort["end"]>) => void): ExecutorPort {
  const files = new Map<string, string>();      // capability → the tool name the loop offers for it
  const shown = (r: unknown) => (typeof (r as ToolReply)?.text === "string" && Object.keys(r as object).every((k) => ["text", "isError", "done", "steers"].includes(k)) ? (r as ToolReply).text : JSON.stringify(r));
  const traced = async <R>(name: string, args: unknown, f: () => Promise<R>): Promise<R> => {
    emit("tool.call", { name, args });
    const t0 = performance.now();
    const ms = () => Math.round((performance.now() - t0) * 10) / 10;
    try {
      const r = await f();
      emit("tool.result", { name, isError: !!(r as ToolReply)?.isError, text: shown(r).slice(0, 2000), ms: ms() });
      return r;
    } catch (e) {
      emit("tool.result", { name, isError: true, text: String(e instanceof Error ? e.message : e).slice(0, 2000), ms: ms() });
      throw e;
    }
  };
  return Object.freeze({
    begin: async () => { const b = await port.begin(); for (const f of b.files) files.set(f.capability, f.name); return b; },
    snapshot: () => traced("computer_snapshot", {}, () => port.snapshot()),
    observe: (window) => traced("computer_observe", { window }, () => port.observe(window)),
    classify: (p) => port.classify(p),
    act: (p) => traced("computer_act", p, () => port.act(p)),
    file: (p) => traced(files.get(p.capability) ?? `file:${p.capability}`, p.args, () => port.file(p)),
    plan: (p) => traced("plan", p, () => port.plan(p)),
    askUser: (p) => traced("ask_user", p, () => port.askUser(p)),
    answer: (p) => traced("answer", p, () => port.answer(p)),
    readSkill: (p) => traced("read_skill", p, () => port.readSkill(p)),
    finish: (p) => traced("finish", p, () => port.finish(p)),
    steers: () => port.steers(),
    end: (p) => { const r = port.end(p); onEnd?.(r); return r; },
  } satisfies ExecutorPort);
}
