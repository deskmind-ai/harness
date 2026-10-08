/**
 * Run the B0 evaluation set through the TS runtime. The task file (gold included) stays in openjev and is passed by
 * path, so both implementations are scored against the same tasks by the same rule.
 *
 *   pnpm eval -- --tasks ../../gxcsoccer/openjev/experiments/harness-b0/evalset/tasks.json --config dev-claude --split dev --groups 1 --limit 2 -v
 *   OPENROUTER_API_KEY=... pnpm eval -- --tasks <path> --config B0-luna --split dev --max-cost 3
 *   pnpm eval -- --report runs/B0-luna-dev/results.jsonl
 *
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { CONFIGS, Gateway, withOverrides } from "../gateway/index.js";
import { Orchestrator, type Hooks, type User } from "../orchestrator/index.js";
import { Crash, Registry } from "../registry/capability.js";
import { RENAMES, fileRegistry } from "../registry/fs.js";
import { guiRegistry } from "../gui/sim.js";
import { Workspace, build } from "../registry/workspace.js";
import { EditorSim } from "../gui/sim.js";
import { Library } from "../skills/library.js";
import { score, type Task } from "./score.js";

class SimUser implements User {
  asked: string[] = [];
  private answers: string[];
  constructor(private readonly task: Task) { this.answers = [...(task.answers ?? [])]; }
  clarify(q: string, options: string[] = []) {
    this.asked.push(options.length ? `${q} [${options.map((o, i) => `${i + 1}.${o}`).join(" ")}]` : q);
    const a = this.answers.shift() ?? "按我原来说的做。";
    // the scripted user picks an option only when the answer IS that option; a richer answer stays free text
    const hit = options.findIndex((o) => a.trim() === o.trim());
    return hit >= 0 ? String(hit + 1) : a;
  }
  authorize() { return this.task.approve ?? false; }
}

function capsFor(task: Task): Registry {
  if (task.caps === "gui") return guiRegistry();
  return task.caps === "alt" ? fileRegistry().withRenamed(RENAMES) : fileRegistry();
}

async function runTask(task: Task, gw: Gateway, outDir: string, verbose: boolean, library: Library | null, rep = 0) {
  const runDir = path.join(outDir, `rep${rep}`, task.id);          // one directory per repetition: logs are never overwritten
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
  let gui: EditorSim | undefined;
  if (h.gui) {
    gui = new EditorSim(root);
    if (h.gui.open) gui.openFile(h.gui.open);
    const g = gui;
    hooks.before_gui_step = (o) => {
      const k = o.st.get("actions");
      if (k === h.gui.at_step && !fired.gd) { fired.gd = true; g.disturb(h.gui.disturb); (fired as any).gd_at = k; (fired as any).gd_calls = o.st.get("model_calls"); }
      else if (h.gui.disturb === "focus" && fired.gd && !fired.gr && k >= (fired as any).gd_at + 1 && o.st.get("model_calls") > (fired as any).gd_calls) { fired.gr = true; g.restoreFocus(); }
    };
  }
  const skills = task.group === 5 ? library ?? undefined : undefined;
  const t0 = Date.now();
  const calls0 = gw.calls, spent0 = gw.spentUsd;
  const logPath = path.join(runDir, "log.jsonl");
  let orch = new Orchestrator(logPath, ws, gw, user, capsFor(task), { hooks, gui, skills });
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
    orch = new Orchestrator(logPath, ws, gw, user, capsFor(task), { hooks, gui, skills });
    summ = await orch.run();
  }
  let taught: unknown = null;
  if (library && task.group === 5 && task.stage === "teach" && summ.status === "succeeded" && !summ.skill) {
    const filesBefore = Object.entries(start).filter(([, v]) => v !== null).map(([p]) => p);
    const contents = Object.fromEntries(Object.entries(start).filter(([, v]) => v !== null)) as Record<string, string>;
    const end = ws.tree();
    const moves: Record<string, string> = {};
    for (const p of filesBefore) if (!(p in end)) { const dst = Object.entries(end).find(([q, v]) => v === start[p] && !(q in start) && !Object.values(moves).includes(q))?.[0]; if (dst) moves[p] = dst; }
    const rec = await library.teach(gw, task.raw + "\n用户说过：" + (task.answers ?? []).join(" "), filesBefore, contents, moves, task.family!, summ.run_id);
    taught = { id: rec.id, status: rec.status, admission: rec.admission };
  }
  if (library && summ.skill) library.recordUse(summ.skill, summ.status === "succeeded", (summ.counters["calls:plan"] ?? 0) + (summ.counters["calls:bind"] ?? 0));
  const sc = score(task, start, ws.tree(), summ, gui?.log ?? []);
  const rec = {
    task: task.id, group: task.group, split: task.split, kind: task.kind ?? task.stage, config: gw.name, status: summ.status, reason: summ.reason,
    ...sc, crashed, counters: summ.counters, model_calls: gw.calls - calls0, cost_usd: Number((gw.spentUsd - spent0).toFixed(5)),
    skill: summ.skill, taught, asked: user.asked, seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), impl: "ts",
  };
  fs.writeFileSync(path.join(runDir, "result.json"), JSON.stringify(rec, null, 1));
  fs.rmSync(root, { recursive: true, force: true });
  if (verbose) for (const ev of orch.log.events) if (["model.reply", "goal.accepted", "plan.accepted", "node.bound", "execution.receipt", "verification", "decision.rejected", "interaction.request", "run.status"].includes(ev.kind)) console.log(`  [${ev.seq}] ${ev.kind} ${JSON.stringify(ev).slice(0, 220)}`);
  return rec;
}

/** Add this process's gateway summary to the one on disk (a resumed run spans several processes). */
function mergeSummaries(prev: any, cur: any) {
  if (!prev || prev.config !== cur.config) return cur;
  const roles: Record<string, any> = { ...prev.roles };
  for (const [role, s] of Object.entries<any>(cur.roles)) {
    const p = roles[role];
    roles[role] = !p ? s : { ...s, calls: p.calls + s.calls, tokens_in: p.tokens_in + s.tokens_in, tokens_out: p.tokens_out + s.tokens_out, cost_usd: p.cost_usd + s.cost_usd,
      outcomes: Object.fromEntries([...new Set([...Object.keys(p.outcomes), ...Object.keys(s.outcomes)])].map((k) => [k, (p.outcomes[k] ?? 0) + (s.outcomes[k] ?? 0)])),
      latency_p50: Math.round((p.latency_p50 * p.calls + s.latency_p50 * s.calls) / (p.calls + s.calls)), latency_p90: Math.max(p.latency_p90, s.latency_p90) };
  }
  return { config: cur.config, calls: prev.calls + cur.calls, spent_usd: Number((prev.spent_usd + cur.spent_usd).toFixed(4)), roles, processes: (prev.processes ?? 1) + 1 };
}

function report(paths: string[]) {
  const rows = paths.flatMap((p) => fs.readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  const by = new Map<string, any[]>();
  for (const r of rows) { const k = `${r.config}|${r.group}`; by.set(k, [...(by.get(k) ?? []), r]); }
  console.log("config | group | n | correct | wrong effect | false success | unconfirmed write | errored | stopped | asked | calls/task | $/task | s/task");
  for (const [k, rs] of [...by].sort()) {
    const n = rs.length, f = (key: string) => rs.filter((r) => r[key]).length;
    console.log(`${k.replace("|", " | ")} | ${n} | ${f("correct")} (${Math.round((100 * f("correct")) / n)}%) | ${f("wrong_effect")} | ${f("false_success")} | ${f("unconfirmed_write")} | ${f("errored")} | ${rs.filter((r) => ["waiting_user", "needs_reconciliation", "failed"].includes(r.status)).length} | ${rs.reduce((a, r) => a + r.asked.length, 0)} | ${(rs.reduce((a, r) => a + r.model_calls, 0) / n).toFixed(1)} | ${(rs.reduce((a, r) => a + r.cost_usd, 0) / n).toFixed(4)} | ${(rs.reduce((a, r) => a + r.seconds, 0) / n).toFixed(1)}`);
  }
  for (const [k, rs] of [...by].sort()) for (const r of rs.filter((r) => !r.correct)) console.log(`  ✗ ${k} ${r.task}: ${r.status} (${(r.reason ?? "").slice(0, 80)}) ${r.why.slice(0, 160)}`);
}

async function main() {
  const { values: a } = parseArgs({ args: process.argv.slice(2).filter((x) => x !== "--"), allowPositionals: true, options: {
    tasks: { type: "string" }, config: { type: "string", default: "B0-luna" }, split: { type: "string", default: "dev" },
    groups: { type: "string", default: "1,2,3,4,5,6" }, only: { type: "string" }, limit: { type: "string" }, "max-cost": { type: "string", default: "12" },
    out: { type: "string" }, v: { type: "boolean", default: false }, report: { type: "string", multiple: true },
    role: { type: "string", multiple: true, default: [] },
    repeat: { type: "string", default: "1" },
  } });
  if (a.report?.length) return report(a.report);
  if (!a.tasks) throw new Error("--tasks <path to tasks.json> is required");
  const groups = new Set(a.groups!.split(",").map(Number));
  const only = a.only ? new Set(a.only.split(",")) : null;
  let tasks: Task[] = JSON.parse(fs.readFileSync(a.tasks, "utf-8"));
  tasks = tasks.filter((t) => groups.has(t.group) && t.split === a.split && (!only || only.has(t.id)));
  if (a.limit) tasks = tasks.slice(0, Number(a.limit));
  const out = path.resolve("runs", a.out ?? `${a.config}${a.role!.length ? "+" + a.role!.map((r) => r.split("=")[0]).join("+") : ""}-${a.split}`);
  fs.mkdirSync(out, { recursive: true });
  const callsLog = fs.openSync(path.join(out, "model_calls.jsonl"), "a");
  const table = a.role!.length ? withOverrides(CONFIGS[a.config!]!, a.role!) : a.config!;
  const gw = new Gateway(table, { log: (r) => fs.writeSync(callsLog, JSON.stringify(r) + "\n"), maxCostUsd: Number(a["max-cost"]) });
  const resPath = path.join(out, "results.jsonl");
  const done = new Set(fs.existsSync(resPath) ? fs.readFileSync(resPath, "utf-8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.task}#${r.rep ?? 0}`; }) : []);
  const repeats = Number(a.repeat);
  outer: for (let rep = 0; rep < repeats; rep++) {
    const library = new Library(path.join(out, `rep${rep}`, "skills.json"));   // a fresh skill library per repetition
    fs.mkdirSync(path.join(out, `rep${rep}`), { recursive: true });
    for (const t of tasks) {
      if (done.has(`${t.id}#${rep}`)) continue;
      if (a.v) console.log(`\n=== ${t.id} (${t.split}, rep ${rep}): ${t.raw}`);
      const r = { ...(await runTask(t, gw, out, a.v!, library, rep)), rep };
      fs.appendFileSync(resPath, JSON.stringify(r) + "\n");
      console.log(`${r.correct ? "✓" : "✗"} ${t.id}#${rep} ${r.status} (${(r.reason ?? "").slice(0, 60)}) calls=${r.model_calls} $${r.cost_usd.toFixed(4)} ${r.seconds}s ${r.correct ? "" : r.why.slice(0, 80)}`);
      if (gw.spentUsd >= Number(a["max-cost"])) { console.log("cost cap reached, stopping"); break outer; }
    }
  }
  const gwPath = path.join(out, "gateway.json");
  const previous = fs.existsSync(gwPath) ? JSON.parse(fs.readFileSync(gwPath, "utf-8")) : null;
  fs.writeFileSync(gwPath, JSON.stringify(mergeSummaries(previous, gw.summary()), null, 1));
  report([resPath]);
}

main().catch((e) => { console.error(e); process.exit(1); });
