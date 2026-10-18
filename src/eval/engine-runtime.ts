/**
 * The check set through the frontier runtime (`pnpm eval -- --engine runtime`): the same tasks, workspace, simulated
 * user and scorer as the orchestrator path, so the two engines compare on the same 105 tasks with the same model.
 *
 * Not carried over for this engine: task hooks (external changes, goal updates, crashes, GUI disturbances) and the
 * skill library (group 5 teach / learn): the row says `skills: "unsupported"`, and the GUI group runs on the simulated
 * editor window (the user's, since it is on screen at begin, so acting in it is consented on a card).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Gateway } from "../gateway/index.js";
import { ConsentSigner } from "../executor/consent.js";
import { Executor } from "../executor/executor.js";
import { SimComputer } from "../executor/sim.js";
import type { Answer, Card } from "../orchestrator/index.js";
import { FrontierRuntime, type RuntimeStatus, type RuntimeUser } from "../runtime/loop.js";
import type { loopModel } from "../runtime/model.js";
import type { Registry } from "../registry/capability.js";
import { Workspace, build } from "../registry/workspace.js";
import { score, type Summary, type Talk, type Task } from "./score.js";

const STATUS: Record<RuntimeStatus, Summary["status"]> = { succeeded: "succeeded", unconfirmed: "failed", failed: "failed", environment: "failed", stopped: "failed", cancelled: "cancelled" };

/** The cards the simulated user saw and what it picked, for talkOf's questions (the runtime has no event log). */
interface Seen { kind: Card["kind"]; picked: string | null; at: number }

export async function runTaskRuntime(task: Task, gw: Gateway, model: ReturnType<typeof loopModel>, registry: Registry, user: RuntimeUser & { clarifies: number; authorizes: number; asked: string[]; approvals: unknown[]; sim: unknown }, outDir: string, verbose: boolean, rep = 0) {
  const runDir = path.join(outDir, `rep${rep}`, task.id);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b0rt-"));
  build(root, task.files);
  const ws = new Workspace(root);
  const start = ws.tree();
  const sim = new SimComputer(root);
  const open = task.hooks?.gui?.open as string | undefined;
  if (task.caps === "gui") sim.addEditor("编辑器", open ? { title: path.basename(open), text: ws.read(open), path: open } : null);
  const app = ConsentSigner.fresh();
  const events: Record<string, unknown>[] = [];
  let tick = 0;
  const seen: Seen[] = [];
  const writes: { ok: boolean; at: number }[] = [];
  // the task's hooks, as the orchestrator engine fires them: another program changes files after N effects; the user
  // changes the request after N model calls (steer). Crash and GUI disturbances are not carried over.
  const h = task.hooks ?? {};
  const fired = { ext: false, upd: false };
  let rt: FrontierRuntime | null = null;
  const onEvent = (kind: string, body: Record<string, unknown>) => {
    tick += 1;
    events.push({ seq: tick, kind, ...body });
    if (kind === "fs.act" && body.consequence !== "read") writes.push({ ok: body.status === "ok", at: tick });
    const effects = writes.filter((w) => w.ok).length;
    if (h.external && !fired.ext && effects >= h.external.after_action) { fired.ext = true; build(root, h.external.set); ws.invalidate(); events.push({ seq: ++tick, kind: "hook.external", set: Object.keys(h.external.set) }); }
    if (h.goal_update && !fired.upd && rt && kind === "tool.call" && (rt.counters["model_calls"] ?? 0) >= h.goal_update.after_decisions) { fired.upd = true; rt.steer(h.goal_update.raw); }
  };
  const ex = new Executor(sim, { task: task.id, publicKey: app.publicKey, onEvent });
  // every card the user answers is noted with its pick, in order with the writes
  const cardUser: RuntimeUser = {
    ask(card: Card): Answer | null | Promise<Answer | null> {
      const a = user.ask(card);
      const note = (ans: Answer | null) => { tick += 1; seen.push({ kind: card.kind, picked: ans && "option" in ans ? card.options[ans.option]?.kind ?? null : ans ? "other" : null, at: tick }); return ans; };
      return a instanceof Promise ? a.then(note) : note(a);
    },
  };
  const t0 = Date.now(), calls0 = gw.calls, spent0 = gw.spentUsd;
  rt = new FrontierRuntime({ task: task.id, raw: task.raw, executor: ex, signer: app, user: cardUser, gateway: gw, model, workspace: ws, registry, onEvent });
  const r = await rt.run();
  const firstAsk = seen.find((s) => s.kind === "missing" || s.kind === "ambiguity" || s.kind === "plan")?.at ?? -1;
  const firstWrite = writes[0]?.at ?? -1;
  const last = seen.at(-1);
  const talk: Talk = {
    clarify: user.clarifies, authorize: user.authorizes, wrote: writes.some((w) => w.ok),
    askedBeforeFirstWrite: firstAsk >= 0 && (firstWrite < 0 || firstAsk < firstWrite),
    clarified: last?.kind === "missing" || last?.kind === "ambiguity", declinedPlan: last?.kind === "plan" && last.picked !== "approve" && last.picked !== "cancel", cancelled: last?.picked === "cancel",
  };
  const summ: Summary = { status: STATUS[r.status], reason: r.reason, counters: { ...r.counters, actions: r.counters["actions"] ?? 0 }, ops: Object.fromEntries(r.effects.map((_, i) => [`op_${i + 1}`, "ok"])) };
  const bytesAt = (p: string) => { try { return fs.readFileSync(path.join(root, p)); } catch { return null; } };
  const sc = score(task, start, ws.tree(), summ, sim.log, talk, bytesAt);
  const rec = {
    task: task.id, group: task.group, split: task.split, kind: task.kind ?? task.stage, config: `${gw.name}@runtime`, engine: "runtime", status: summ.status, runtime_status: r.status, reason: r.reason,
    ...sc, crashed: false, counters: summ.counters, model_calls: gw.calls - calls0 + (r.counters["model_calls"] ?? 0), loop_calls: r.counters["model_calls"] ?? 0, cost_usd: Number((gw.spentUsd - spent0).toFixed(5)),
    tokens_in: r.counters["tokens_in"] ?? 0, tokens_out: r.counters["tokens_out"] ?? 0,
    category: task.category, policy: {}, skill: null, skills: task.group === 5 ? "unsupported" : null, taught: null, learned: null, asked: user.asked, approvals: user.approvals, result_response: null, sim: user.sim,
    ask_decisions: [], consents: r.consents, cards: seen.map((s) => `${s.kind}:${s.picked ?? "-"}`), verdicts: r.verdicts, answer: r.answer, summary: r.summary,
    first_outcome: task.gold.outcomes?.[0]?.name ?? "gold", seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), impl: "ts",
  };
  fs.writeFileSync(path.join(runDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(rec, null, 1));
  fs.rmSync(root, { recursive: true, force: true });
  if (verbose) for (const e of events) if (["tool.call", "card", "fs.act", "finish.claimed", "run.end", "executor.consent_needed"].includes(String(e.kind))) console.log("  " + JSON.stringify(e).slice(0, 220));
  return rec;
}
