/**
 * The check set through the frontier runtime (`pnpm eval -- --engine runtime`): the same tasks, workspace, simulated
 * user and scorer as the orchestrator path, so the two engines compare on the same 105 tasks with the same model.
 *
 * Not carried over for this engine: the
 * skill revision (group 5 learn after a use: counterexamples are not written back yet), and the GUI group runs on the simulated
 * editor window (the user's, since it is on screen at begin, so acting in it is consented on a card).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Gateway } from "../gateway/index.js";
import { ConsentSigner } from "../executor/consent.js";
import { Executor } from "../executor/executor.js";
import { Crash } from "../registry/capability.js";
import { SimComputer } from "../executor/sim.js";
import type { Answer, Card } from "../orchestrator/index.js";
import { FrontierRuntime, type RuntimeStatus, type RuntimeUser } from "../runtime/loop.js";
import type { loopModel } from "../runtime/model.js";
import type { Registry } from "../registry/capability.js";
import { Workspace, build } from "../registry/workspace.js";
import { score, type Summary, type Talk, type Task } from "./score.js";
import { SkillStore } from "../skills/agentskills.js";
import { admit, teachFromRun, type Tree } from "../skills/teach.js";

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
  const ex_taskWindows: string[] = [];
  const open = task.hooks?.gui?.open as string | undefined;
  if (task.caps === "gui") sim.addEditor("编辑器", open ? { title: path.basename(open), text: ws.read(open), path: open } : null);
  // a window with the user's unsaved work is a user window; a bare editor is the task's to use (opened for it)
  if (task.caps === "gui" && !open) { const w = sim.wins.find((x) => x.kind === "editor"); if (w) ex_taskWindows.push(w.id); }
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
  // the GUI disturbances, as run.ts injects them into EditorSim: after the k-th screen action that went through, the
  // focus goes to another app (the user is active: the next action waits), a modal covers the window, or the window
  // is rebuilt (every element id changes); the focus comes back after the next model call
  const gui = h.gui as { at_step?: number; disturb?: "focus" | "modal" | "layout" } | undefined;
  let guiActs = 0, disturbed = false, restoreAfter = -1;
  const editor = () => sim.wins.find((x) => x.kind === "editor");
  const onEvent = (kind: string, body: Record<string, unknown>) => {
    tick += 1;
    events.push({ seq: tick, kind, ...body });
    if (kind === "fs.act" && body.consequence !== "read") writes.push({ ok: body.status === "ok", at: tick });
    if (kind === "executor.act" && gui && body.status === "ok" && (body.action as { kind?: string })?.kind !== "file") {
      guiActs += 1;
      if (!disturbed && guiActs === (gui.at_step ?? 1)) {
        disturbed = true;
        const w = editor();
        if (gui.disturb === "modal" && w) sim.modal(w.id, "有新版本可用", ["稍后", "立即更新"]);
        else if (gui.disturb === "layout" && w) sim.relayout(w.id);
        else if (gui.disturb === "focus") { sim.user_active = true; restoreAfter = tick; }
        events.push({ seq: ++tick, kind: "hook.gui", disturb: gui.disturb });
      }
    }
    if (kind === "tool.call" && restoreAfter >= 0 && tick > restoreAfter + 1) { sim.user_active = false; restoreAfter = -1; }
    const effects = writes.filter((w) => w.ok).length;
    if (h.external && !fired.ext && effects >= h.external.after_action) { fired.ext = true; build(root, h.external.set); ws.invalidate(); events.push({ seq: ++tick, kind: "hook.external", set: Object.keys(h.external.set) }); }
    if (h.goal_update && !fired.upd && rt && kind === "tool.call" && (rt.counters["model_calls"] ?? 0) >= h.goal_update.after_decisions) { fired.upd = true; rt.steer(h.goal_update.raw); }
  };
  // a crash task dies after its first effect; the next process finds the intent without a receipt in the journal,
  // reconciles it, and the model is told (as the orchestrator engine recovers from its log)
  const journal = path.join(runDir, "journal.jsonl");
  const makeExecutor = (crash: boolean) => { const e = new Executor(sim, { task: task.id, publicKey: app.publicKey, onEvent, journal, ...(crash ? { crashAfterFirstEffect: true } : {}) }); for (const id of ex_taskWindows) e.ledger.created(`window:${id}`); return e; };
  let ex = makeExecutor(!!h.crash);
  // every card the user answers is noted with its pick, in order with the writes
  const cardUser: RuntimeUser = {
    ask(card: Card): Answer | null | Promise<Answer | null> {
      const a = user.ask(card);
      const note = (ans: Answer | null) => { tick += 1; seen.push({ kind: card.kind, picked: ans && "option" in ans ? card.options[ans.option]?.kind ?? null : ans ? "other" : null, at: tick }); return ans; };
      return a instanceof Promise ? a.then(note) : note(a);
    },
  };
  const t0 = Date.now(), calls0 = gw.calls, spent0 = gw.spentUsd;
  // group 5: tutorials taught on this path live in the repetition's skills folder; a use-stage task sees the admitted
  // ones (chosen by structure: the folder's file types), a teach-stage task teaches after it succeeded
  const store = task.group === 5 ? new SkillStore(path.join(outDir, `rep${rep}`, "skills")) : null;
  if (store) fs.mkdirSync(store.dir, { recursive: true });
  const fileTypes = [...new Set(Object.keys(task.files).map((p) => (p.includes(".") ? p.slice(p.lastIndexOf(".") + 1).toLowerCase() : "")).filter(Boolean))];
  const skills = store ? store.source({ fileTypes }) : undefined;
  const makeRuntime = () => new FrontierRuntime({ task: task.id, raw: task.raw, executor: ex, signer: app, user: cardUser, gateway: gw, model, workspace: ws, registry, onEvent, ...(skills ? { skills } : {}) });
  rt = makeRuntime();
  let crashed = false;
  let r: Awaited<ReturnType<FrontierRuntime["run"]>>;
  try { r = await rt.run(); }
  catch (e) {
    if (!(e instanceof Crash)) throw e;
    crashed = true;
    if (h.after_crash_set) { build(root, h.after_crash_set); ws.invalidate(); }
    ex = makeExecutor(false);
    rt = makeRuntime();
    r = await rt.run();
  }
  // teach: the run the user confirmed becomes a tutorial, admitted only when doing the example again with it ends the same
  let taught: unknown = null;
  if (store && task.stage === "teach" && r.status === "succeeded") {
    const sk = await teachFromRun(gw, store, { raw: task.raw, answers: user.asked, before: start as Tree, after: ws.tree() as Tree, effects: r.effects, family: task.family, runId: task.id });
    if (sk) {
      const replay = async (raw: string, before: Tree, name: string): Promise<Tree | null> => {
        const root2 = fs.mkdtempSync(path.join(os.tmpdir(), "b0rt-replay-"));
        build(root2, before);
        const ws2 = new Workspace(root2), sim2 = new SimComputer(root2), app2 = ConsentSigner.fresh();
        const ex2 = new Executor(sim2, { task: task.id + "#replay", publicKey: app2.publicKey });
        const one = store.get(name)!;
        const rt2 = new FrontierRuntime({ task: task.id + "#replay", raw, executor: ex2, signer: app2, user: { ask: (c) => { const i = c.options.findIndex((o) => o.kind === "approve"); return i >= 0 ? { option: i } : null; } }, gateway: gw, model, workspace: ws2, registry, skills: { candidates: () => [{ name: one.name, description: one.description }], read: (n) => (n === one.name ? one.body : null) } });
        const r2 = await rt2.run().catch(() => null);
        const tree = r2?.status === "succeeded" ? ws2.tree() : null;
        fs.rmSync(root2, { recursive: true, force: true });
        return tree;
      };
      const a = await admit(store, sk.name, replay);
      taught = { name: sk.name, admitted: a.admitted, why: a.why };
    } else taught = { admitted: false, why: "the skill role gave no usable tutorial" };
  }
  const firstAsk = seen.find((s) => s.kind === "missing" || s.kind === "ambiguity" || s.kind === "plan")?.at ?? -1;
  const firstWrite = writes[0]?.at ?? -1;
  const last = seen.at(-1);
  const talk: Talk = {
    clarify: user.clarifies, authorize: user.authorizes, wrote: writes.some((w) => w.ok),
    askedBeforeFirstWrite: firstAsk >= 0 && (firstWrite < 0 || firstAsk < firstWrite),
    clarified: last?.kind === "missing" || last?.kind === "ambiguity", declinedPlan: last?.kind === "plan" && last.picked !== "approve" && last.picked !== "cancel", cancelled: last?.picked === "cancel",
    plans: seen.filter((s) => s.kind === "plan").length,
  };
  const summ: Summary = { status: STATUS[r.status], reason: r.reason, counters: { ...r.counters, actions: r.counters["actions"] ?? 0 }, ops: Object.fromEntries(r.effects.map((_, i) => [`op_${i + 1}`, "ok"])) };
  const bytesAt = (p: string) => { try { return fs.readFileSync(path.join(root, p)); } catch { return null; } };
  const sc = score(task, start, ws.tree(), summ, sim.log, talk, bytesAt);
  const rec = {
    task: task.id, group: task.group, split: task.split, kind: task.kind ?? task.stage, config: `${gw.name}@runtime`, engine: "runtime", status: summ.status, runtime_status: r.status, reason: r.reason,
    ...sc, crashed, counters: summ.counters, model_calls: gw.calls - calls0 + (r.counters["model_calls"] ?? 0), loop_calls: r.counters["model_calls"] ?? 0, cost_usd: Number((gw.spentUsd - spent0).toFixed(5)),
    tokens_in: r.counters["tokens_in"] ?? 0, tokens_out: r.counters["tokens_out"] ?? 0,
    category: task.category, policy: {}, skill: null, skills: store ? store.admitted().map((x) => x.name) : null, taught, learned: null, skills_read: r.counters["skills_read"] ?? 0, asked: user.asked, approvals: user.approvals, result_response: null, sim: user.sim,
    ask_decisions: [], consents: r.consents, cards: seen.map((s) => `${s.kind}:${s.picked ?? "-"}`), verdicts: r.verdicts, answer: r.answer, summary: r.summary,
    first_outcome: task.gold.outcomes?.[0]?.name ?? "gold", seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), impl: "ts",
  };
  fs.writeFileSync(path.join(runDir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(rec, null, 1));
  fs.rmSync(root, { recursive: true, force: true });
  if (verbose) for (const e of events) if (["tool.call", "card", "fs.act", "finish.claimed", "run.end", "executor.consent_needed"].includes(String(e.kind))) console.log("  " + JSON.stringify(e).slice(0, 220));
  return rec;
}
