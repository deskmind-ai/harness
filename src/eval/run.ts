/**
 * Run the B0 evaluation set through the TS runtime. The task file (gold included) stays in openjev and is passed by
 * path, so both implementations are scored against the same tasks by the same rule.
 *
 *   pnpm eval -- --tasks ../../gxcsoccer/openjev/experiments/harness-b0/evalset/tasks.json --config dev-claude --split dev --groups 1 --limit 2 -v
 *   OPENROUTER_API_KEY=... pnpm eval -- --tasks <path> --config B0-luna --split dev --max-cost 3
 *   pnpm eval -- --report runs/B0-luna-dev/results.jsonl
 *
 * Groups 4 (GUI) and 5 (skills) need the GUI simulator and the skill library; until those are ported they are skipped
 * with a note, so the numbers stay comparable group by group.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { Gateway } from "../gateway/index.js";
import { Orchestrator, type Hooks, type User } from "../orchestrator/index.js";
import { Crash, FILE_CAPS, RENAMES, renamed, type Capability } from "../registry/capabilities.js";
import { Workspace, build } from "../registry/workspace.js";
import { score, type Task } from "./score.js";

class SimUser implements User {
  asked: string[] = [];
  private answers: string[];
  constructor(private readonly task: Task) { this.answers = [...(task.answers ?? [])]; }
  clarify(q: string) { this.asked.push(q); return this.answers.shift() ?? "按我原来说的做。"; }
  authorize() { return this.task.approve ?? false; }
}

function capsFor(task: Task): Record<string, Capability> {
  const caps = { ...FILE_CAPS };
  if (task.caps === "alt") for (const id of Object.keys(RENAMES)) { delete caps[id]; const alt = renamed(FILE_CAPS[id]!); caps[alt.id] = alt; }
  return caps;
}

async function runTask(task: Task, gw: Gateway, outDir: string, verbose: boolean) {
  const runDir = path.join(outDir, task.id);
  fs.rmSync(runDir, { recursive: true, force: true });
  fs.mkdirSync(runDir, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "b0ts-"));
  build(root, task.files);
  const ws = new Workspace(root);
  const start = ws.tree();
  const user = new SimUser(task);
  const h = task.hooks ?? {};
  const fired: Record<string, boolean> = {};
  const hooks: Hooks = {};
  const chain: ((o: Orchestrator) => void)[] = [];
  if (h.external) chain.push((o) => { if (o.st.get("actions") >= h.external.after_action && !fired.ext) { fired.ext = true; build(root, h.external.set); } });
  if (h.goal_update) chain.push((o) => { if (o.st.get("model_calls") >= h.goal_update.after_decisions && !fired.upd && o.st.goal) { fired.upd = true; o.updateGoal(h.goal_update.raw, "user changed the goal"); } });
  if (chain.length) hooks.before_execute = (o) => chain.forEach((f) => f(o));
  if (h.crash) hooks.crash_on_first_effect = true;
  const t0 = Date.now();
  const calls0 = gw.calls, spent0 = gw.spentUsd;
  const logPath = path.join(runDir, "log.jsonl");
  let orch = new Orchestrator(logPath, ws, gw, user, capsFor(task), { hooks });
  orch.start(task.raw);
  let crashed = false;
  let summ;
  try {
    summ = await orch.run();
  } catch (e) {
    if (!(e instanceof Crash)) throw e;
    crashed = true;
    if (h.after_crash_set) build(root, h.after_crash_set);
    delete hooks.crash_on_first_effect;
    orch = new Orchestrator(logPath, ws, gw, user, capsFor(task), { hooks });
    summ = await orch.run();
  }
  const sc = score(task, start, ws.tree(), summ);
  const rec = {
    task: task.id, group: task.group, split: task.split, kind: task.kind ?? task.stage, config: gw.name, status: summ.status, reason: summ.reason,
    ...sc, crashed, counters: summ.counters, model_calls: gw.calls - calls0, cost_usd: Number((gw.spentUsd - spent0).toFixed(5)),
    skill: summ.skill, asked: user.asked, seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), impl: "ts",
  };
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(rec, null, 1));
  fs.rmSync(root, { recursive: true, force: true });
  if (verbose) for (const ev of orch.log.events) if (["model.reply", "goal.accepted", "plan.accepted", "node.bound", "execution.receipt", "verification", "decision.rejected", "interaction.request", "run.status"].includes(ev.kind)) console.log(`  [${ev.seq}] ${ev.kind} ${JSON.stringify(ev).slice(0, 220)}`);
  return rec;
}

function report(paths: string[]) {
  const rows = paths.flatMap((p) => fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  const by = new Map<string, any[]>();
  for (const r of rows) { const k = `${r.config}|${r.group}`; by.set(k, [...(by.get(k) ?? []), r]); }
  console.log("config | group | n | correct | wrong effect | false success | stopped | asked | calls/task | $/task | s/task");
  for (const [k, rs] of [...by].sort()) {
    const n = rs.length, f = (key: string) => rs.filter((r) => r[key]).length;
    console.log(`${k.replace("|", " | ")} | ${n} | ${f("correct")} (${Math.round((100 * f("correct")) / n)}%) | ${f("wrong_effect")} | ${f("false_success")} | ${rs.filter((r) => ["waiting_user", "needs_reconciliation", "failed"].includes(r.status)).length} | ${rs.reduce((a, r) => a + r.asked.length, 0)} | ${(rs.reduce((a, r) => a + r.model_calls, 0) / n).toFixed(1)} | ${(rs.reduce((a, r) => a + r.cost_usd, 0) / n).toFixed(4)} | ${(rs.reduce((a, r) => a + r.seconds, 0) / n).toFixed(1)}`);
  }
  for (const [k, rs] of [...by].sort()) for (const r of rs.filter((r) => !r.correct)) console.log(`  ✗ ${k} ${r.task}: ${r.status} (${(r.reason ?? "").slice(0, 80)}) ${r.why.slice(0, 160)}`);
}

async function main() {
  const { values: a } = parseArgs({ args: process.argv.slice(2).filter((x) => x !== "--"), allowPositionals: true, options: {
    tasks: { type: "string" }, config: { type: "string", default: "B0-luna" }, split: { type: "string", default: "dev" },
    groups: { type: "string", default: "1,2,3,6" }, only: { type: "string" }, limit: { type: "string" }, "max-cost": { type: "string", default: "12" },
    out: { type: "string" }, v: { type: "boolean", default: false }, report: { type: "string", multiple: true },
  } });
  if (a.report?.length) return report(a.report);
  if (!a.tasks) throw new Error("--tasks <path to tasks.json> is required");
  const groups = new Set(a.groups!.split(",").map(Number));
  const only = a.only ? new Set(a.only.split(",")) : null;
  let tasks: Task[] = JSON.parse(fs.readFileSync(a.tasks, "utf-8"));
  tasks = tasks.filter((t) => groups.has(t.group) && t.split === a.split && (!only || only.has(t.id)));
  const skipped = tasks.filter((t) => t.group === 4 || t.group === 5);
  if (skipped.length) console.log(`skipping ${skipped.length} tasks of groups 4/5 (GUI simulator and skill library not ported yet)`);
  tasks = tasks.filter((t) => t.group !== 4 && t.group !== 5);
  if (a.limit) tasks = tasks.slice(0, Number(a.limit));
  const out = path.resolve("runs", a.out ?? `${a.config}-${a.split}`);
  fs.mkdirSync(out, { recursive: true });
  const callsLog = fs.openSync(path.join(out, "model_calls.jsonl"), "a");
  const gw = new Gateway(a.config!, { log: (r) => fs.writeSync(callsLog, JSON.stringify(r) + "\n"), maxCostUsd: Number(a["max-cost"]) });
  const resPath = path.join(out, "results.jsonl");
  const done = new Set(fs.existsSync(resPath) ? fs.readFileSync(resPath, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l).task as string) : []);
  for (const t of tasks) {
    if (done.has(t.id)) continue;
    if (a.v) console.log(`\n=== ${t.id} (${t.split}): ${t.raw}`);
    const r = await runTask(t, gw, out, a.v!);
    fs.appendFileSync(resPath, JSON.stringify(r) + "\n");
    console.log(`${r.correct ? "✓" : "✗"} ${t.id} ${r.status} (${(r.reason ?? "").slice(0, 60)}) calls=${r.model_calls} $${r.cost_usd.toFixed(4)} ${r.seconds}s ${r.correct ? "" : r.why.slice(0, 80)}`);
    if (gw.spentUsd >= Number(a["max-cost"])) { console.log("cost cap reached, stopping"); break; }
  }
  fs.writeFileSync(path.join(out, "gateway.json"), JSON.stringify(gw.summary(), null, 1));
  report([resPath]);
}

main().catch((e) => { console.error(e); process.exit(1); });
