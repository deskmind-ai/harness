/**
 * Run the B0 evaluation set through the TS runtime. The task file (gold included) stays in the design-notes repository and is passed by
 * path, so both implementations are scored against the same tasks by the same rule.
 *
 *   pnpm eval -- --tasks <design-notes repo>/experiments/harness-b0/evalset/tasks.json --config dev-claude --split dev --groups 1 --limit 2 -v
 *   OPENROUTER_API_KEY=... pnpm eval -- --tasks <path> --config B0-luna --split dev --max-cost 3
 *   pnpm eval -- --report runs/B0-luna-dev/results.jsonl
 *
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { CONFIGS, Gateway, withOverrides } from "../gateway/index.js";
import { readRows } from "./rows.js";
import { Orchestrator, POLICY, cardUser, type Answer, type Card, type CardUser, type Hooks, type Policy } from "../orchestrator/index.js";
import { Crash, Registry } from "../registry/capability.js";
import { RENAMES, fileRegistry } from "../registry/fs.js";
import { helperProblem, prepareHelper } from "../registry/mac.js";
import { guiRegistry } from "../gui/sim.js";
import { Workspace, build } from "../registry/workspace.js";
import { EditorSim } from "../gui/sim.js";
import { Library, movesBetween, useConfirmation, useOutcome, useSignals } from "../skills/library.js";
import { spawnSync } from "node:child_process";
import { score, talkOf, type Task } from "./score.js";
import { runTaskRuntime } from "./engine-runtime.js";
import { loopModel } from "../runtime/model.js";

const loose = (t: string) => t.replace(/\s+/g, "").toLowerCase();

/** The simulated user's own judgement: a small model reads what the user really means (task.user_facts) and the
 *  question or plan. This is the evaluation's stand-in for a person, not part of the harness. */
// Answers are cached by prompt, so the same question gets the same answer in every run and arm (a model's
// answer can vary between calls). The cache lives next to the task file.
let simCachePath = "";
type Cache = Record<string, Record<string, unknown>>;
/** The file is the shared truth between parallel processes: read it fresh, let entries already there win, and replace
 *  it atomically (write a temp file, then rename). A file that exists but does not parse stops the run instead of
 *  being silently overwritten. */
function readCache(): Cache {
  if (!simCachePath || !fs.existsSync(simCachePath)) return {};
  const raw = fs.readFileSync(simCachePath, "utf-8");
  try { return JSON.parse(raw); } catch { throw new Error(`simulated-user cache ${simCachePath} does not parse; refusing to overwrite it`); }
}
export function setSimCache(p: string) { simCachePath = p; readCache(); }
function simJudge(prompt: string, stats: { calls: number; cached: number; fallbacks: number }): Record<string, unknown> | null {
  const key = crypto.createHash("sha256").update(prompt).digest("hex").slice(0, 32);
  const hit = readCache()[key];
  if (hit) { stats.cached++; return hit; }
  stats.calls++;
  const p = spawnSync("claude", ["-p", "--model", "haiku"], { input: prompt, encoding: "utf-8", timeout: 120_000 });
  const out = p.stdout ?? "";
  let r: Record<string, unknown>;
  try { r = JSON.parse(out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1)); } catch { stats.fallbacks++; return null; }
  if (!simCachePath) return r;
  const merged: Cache = { [key]: r, ...readCache() };        // an answer another process stored first wins
  const tmp = `${simCachePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged));
  fs.renameSync(tmp, simCachePath);
  return merged[key]!;
}

export class SimUser implements CardUser {
  asked: string[] = [];
  clarifies = 0;                                             // blocking questions (missing, ambiguity; can't-do under policy.cannot "ask")
  authorizes = 0;                                            // blocking confirmations (plan, action, result)
  approvals: { text: string; approved: boolean; picked?: string }[] = [];
  sim = { calls: 0, cached: 0, fallbacks: 0 };              // the simulated user's model: answered, from cache, failed
  private answers: string[];
  private legacy: CardUser;
  constructor(private readonly task: Task) {
    this.answers = [...(task.answers ?? [])];
    // v1 tasks: the scripted answers and a fixed yes / no, seen through cards
    this.legacy = cardUser({
      clarify: (_q, options) => {
        const a = this.answers.shift() ?? "按我原来说的做。";
        const hit = options.findIndex((o) => a.trim() === o.trim());
        return hit >= 0 ? { option: hit } : { text: a };
      },
      authorize: () => this.task.approve ?? false,
    });
  }

  ask(card: Card): Answer | null {
    const question = ["missing", "ambiguity", "cannot"].includes(card.kind);
    if (question) { this.clarifies++; this.asked.push(`${card.text} [${card.options.map((o, i) => `${i + 1}.${o.text}`).join(" ")}]`); }
    else if (card.blocking) this.authorizes++;
    const a = this.answer(card);
    if (!question && card.blocking) {
      const picked = a && "option" in a ? card.options[a.option]?.kind : "other";
      this.approvals.push({ text: card.text.slice(0, 200), approved: picked === "approve", picked });
    }
    return a;
  }

  private answer(card: Card): Answer | null {
    const f = this.task.user_facts;
    if (!f) return this.legacy.ask(card);
    const at = (k: string) => card.options.findIndex((o) => o.kind === k);
    if (at("approve") >= 0 && f.approve === "yes") return { option: at("approve") };
    if (card.kind === "missing" || card.kind === "ambiguity") {
      // an option naming what the user wants (the task's own acceptable answers) is picked directly
      const wanted = (f.choice_texts ?? []).map(loose).filter(Boolean);
      const exact = card.options.findIndex((o) => wanted.includes(loose(o.text)));
      const hit = exact >= 0 ? exact : card.options.findIndex((o) => ["value", "proposal", "reading"].includes(o.kind) && wanted.some((c) => loose(o.text).includes(c)));
      if (hit >= 0) return { option: hit };
    }
    const question = card.kind === "missing" || card.kind === "ambiguity" || card.kind === "cannot";
    const r = simJudge((question ? [
      // questions: the same wording as before cards, so an option is picked only when it loses nothing the user cares about
      "你在扮演一位用户。你心里真正的意思是：" + f.intent,
      "被问到时你会这样说：" + f.answer,
      `助手问你：${card.text}`,
      "选项：\n" + card.options.map((o, i) => `${i}. ${o.text}`).join("\n"),
      "如果某个选项完全符合你的意思（不丢掉你在意的细节），就选它；否则用你自己的话回答，尽量照你会说的原话。不要选「由你决定」，除非你心里的意思就是让助手决定。只有你根本不想让助手做这件事时，才选「先别做了」。",
      '只输出 JSON：{"option": 编号} 或 {"text": "你的回答"}',
    ] : [
      "你在扮演一位用户。你心里真正的意思是：" + f.intent,
      ...(f.approve === "no" ? ["你不同意助手照现在这样做。"] : []),
      `助手请你确认：${card.text}`,
      "选项：\n" + card.options.map((o, i) => `${i}. ${o.text}`).join("\n"),
      "确认的内容完全是你要的（结果对、没有多做、不丢掉你在意的细节）才选「可以」；助手把你的意思理解错了，而某个选项正好说对了，就选那一项；不想做了才选「先别做了」；都不合适就用你自己的话说清楚你要什么。",
      '只输出 JSON：{"option": 编号} 或 {"text": "你的回答"}',
    ]).join("\n"), this.sim);
    if (r && typeof r.option === "number" && r.option >= 0 && r.option < card.options.length) return { option: r.option };
    if (r && typeof r.text === "string" && r.text.trim() && card.free_text) return { text: r.text };
    if (r) this.sim.fallbacks++;                               // parsed, but neither a valid option nor usable text
    if (at("approve") >= 0) return at("cancel") >= 0 ? { option: at("cancel") } : null;   // no judgement: do not approve
    return card.free_text ? { text: f.answer } : null;
  }

  /** The result card is not blocking: the user looks at the result and may undo it. A can't-do card (policy.cannot
   *  "report") is read like the question it is under "ask" (same wording), but it did not stop the run, so it is no
   *  interruption. */
  review(card: Card, effects: string[]): Answer | null {
    const f = this.task.user_facts;
    if (!f) return null;
    if (card.kind === "cannot") return this.answer(card);
    const r = simJudge([
      "你在扮演一位用户。你心里真正的意思是：" + f.intent,
      `助手做完了，并告诉你：${card.text}`,
      "它做了这些改动：\n" + effects.slice(-12).join("\n"),
      "选项：\n" + card.options.map((o, i) => `${i}. ${o.text}`).join("\n"),
      "结果是你要的就选「好的」；理解错了就选撤回（如果有「撤回，改成…」正好是你的意思，就选它）。",
      '只输出 JSON：{"option": 编号}',
    ].join("\n"), this.sim);
    if (r && typeof r.option === "number" && r.option >= 0 && r.option < card.options.length) return { option: r.option };
    if (r) this.sim.fallbacks++;
    return null;
  }
}

function capsFor(task: Task): Registry {
  if (task.caps === "gui") return guiRegistry();
  return task.caps === "alt" ? fileRegistry().withRenamed(RENAMES) : fileRegistry();
}

async function runTask(task: Task, gw: Gateway, outDir: string, verbose: boolean, library: Library | null, rep = 0, policy: Partial<Policy> = {}) {
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
  let orch = new Orchestrator(logPath, ws, gw, user, capsFor(task), { hooks, gui, skills, policy });
  orch.start(task.raw);
  let crashed = false;
  // A crash task crashes on the first effect of whichever run() gets there: after a can't-do card, that can be the
  // run started again by the user's new wording, so every run() recovers the same way.
  const runOrRecover = async () => {
    try {
      return await orch.run();
    } catch (e) {
      if (!(e instanceof Crash)) throw e;
      crashed = true;
      if (h.after_crash_set) build(root, h.after_crash_set);
      delete hooks.crash_on_first_effect;
      orch = new Orchestrator(logPath, ws, gw, user, capsFor(task), { hooks, gui, skills, policy });
      return await orch.run();
    }
  };
  let summ = await runOrRecover();
  // the result card is shown with the result: the simulated user may undo, or undo and pick another reading; on a
  // can't-do card it may say it differently, which starts the run again (and may end on another can't-do card)
  let resultResponse: string | null = null;
  let noticeShown = !!summ.skill_notice;
  for (let looks = 0; summ.result_card && looks <= orch.budget.asks; looks++) {     // a new wording spends an ask
    const card = summ.result_card;
    const a = user.review(card, summ.effects);
    if (!a) break;
    resultResponse = "option" in a ? card.options[a.option]?.kind ?? null : "other";
    orch.respond(card, a);
    if (orch.st.status !== "running") { summ = orch.summary(); break; }      // answered: ok, undone, let it be
    summ = await runOrRecover();
    noticeShown ||= !!summ.skill_notice;
    if (card.kind !== "cannot") break;                            // one look at a redone result, as before
  }
  let taught: unknown = null;
  if (library && task.group === 5 && task.stage === "teach" && summ.status === "succeeded" && !summ.skill) {
    const filesBefore = Object.entries(start).filter(([, v]) => v !== null).map(([p]) => p);
    const contents = Object.fromEntries(Object.entries(start).filter(([, v]) => v !== null)) as Record<string, string>;
    const moves = movesBetween(start, ws.tree());
    const rec = await library.teach(gw, task.raw + "\n用户说过：" + (task.answers ?? []).join(" "), filesBefore, contents, moves, task.family!, summ.run_id);
    taught = { id: rec.id, status: rec.status, admission: rec.admission };
  }
  let learned: unknown = null;
  if (library && summ.skill) {
    // the use, and what it teaches the skill: the right moves of a run that ended right (useOutcome), and how much of
    // it the user stood behind (useConfirmation; the simulated user approves most plans, so most uses are confirmed)
    const events = orch.log.events as any;
    const signals = useSignals(events);
    const files = Object.entries(start).filter(([, v]) => v !== null).map(([p]) => p);
    const { right, corrected } = useOutcome(summ.status, events, signals);
    const { confirmed, declined } = useConfirmation(events, resultResponse !== null || !!summ.result_card);
    learned = await library.learn(gw, summ.skill, { files, contents: Object.fromEntries(files.map((f) => [f, start[f]!])),
      final: right ? movesBetween(start, ws.tree()) : null, signals, ok: summ.status === "succeeded",
      teacherCalls: (summ.counters["calls:plan"] ?? 0) + (summ.counters["calls:bind"] ?? 0), confirmed, declined,
      corrected, noticeShown }, user, summ.run_id);
  }
  const bytesAt = (p: string) => { try { return fs.readFileSync(path.join(root, p)); } catch { return null; } };   // a zip or a PDF is checked on its bytes
  const sc = score(task, start, ws.tree(), summ, gui?.log ?? [], talkOf(orch.log.events as any, user), bytesAt);
  const rec = {
    task: task.id, group: task.group, split: task.split, kind: task.kind ?? task.stage, config: gw.name, status: summ.status, reason: summ.reason,
    ...sc, crashed, counters: summ.counters, model_calls: gw.calls - calls0, cost_usd: Number((gw.spentUsd - spent0).toFixed(5)),
    category: task.category, policy: summ.policy, skill: summ.skill, taught, learned, asked: user.asked, approvals: user.approvals, result_response: resultResponse, sim: user.sim,
    ask_decisions: orch.log.events.filter((e: any) => e.kind === "ask.decided").map((e: any) => e.decision),
    first_outcome: task.gold.outcomes?.[0]?.name ?? "gold", seconds: Number(((Date.now() - t0) / 1000).toFixed(1)), impl: "ts",
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

function reportV2(rows: any[]) {
  const by = new Map<string, any[]>();
  for (const r of rows) { const k = `${r.config}|${r.category}`; by.set(k, [...(by.get(k) ?? []), r]); }
  console.log("config | category | n | correct | lack: completed / gap / stopped / wrong / done but reported failed | wrong action | of which guessed | false success | errored | interruptions | unnecessary | declined plan | sim fallbacks | acted on own reading | of which not the first outcome | outcomes | s/task");
  const pct: Record<string, number[]> = {};
  for (const [k, rs] of [...by].sort()) {
    const n = rs.length, f = (key: string) => rs.filter((r) => r[key]).length;
    const outs = Object.entries(rs.reduce((a: Record<string, number>, r) => { if (r.correct) a[r.outcome ?? "?"] = (a[r.outcome ?? "?"] ?? 0) + 1; return a; }, {})).map(([o, c]) => `${o}:${c}`).join(" ");
    console.log(`${k.replace("|", " | ")} | ${n} | ${f("correct")} (${Math.round((100 * f("correct")) / n)}%) | ${["completed", "gap", "stopped", "wrong", "done_but_reported_failed"].map((o) => rs.filter((r) => r.lack_outcome === o).length).join(" / ")} | ${f("wrong_effect")} | ${f("guessed")} | ${f("false_success")} | ${f("errored")} | ${rs.reduce((a, r) => a + (r.interruptions ?? 0), 0)} | ${rs.reduce((a, r) => a + (r.unnecessary ?? 0), 0)} | ${f("declined_plan")} | ${rs.reduce((a, r) => a + (r.sim?.fallbacks ?? 0), 0)} | ${rs.filter((r) => (r.ask_decisions ?? []).includes("act")).length} | ${rs.filter((r) => (r.ask_decisions ?? []).includes("act") && r.outcome && r.outcome !== r.first_outcome).length} | ${outs} | ${(rs.reduce((a, r) => a + r.seconds, 0) / n).toFixed(1)}`);
    const cfg = k.split("|")[0]!;
    (pct[cfg] ??= []).push(f("correct") / n);
  }
  for (const [cfg, ps] of Object.entries(pct)) console.log(`${cfg}: lowest category ${Math.round(100 * Math.min(...ps))}%, unweighted mean ${Math.round((100 * ps.reduce((a, b) => a + b, 0)) / ps.length)}% (a capability gap — an honest stop on a request we lack the means for — counts as not correct)`);
  console.log("Rows are as scored when they ran: result files from before the three-tier can't-do scoring (10-16) are not rescored; rerun those tasks with a new --out and pass both files with --supersede.");
  for (const [k, rs] of [...by].sort()) for (const r of rs.filter((r) => !r.correct)) console.log(`  ${r.gap ? "◌" : "✗"} ${k} ${r.task}: ${r.status} (${(r.reason ?? "").slice(0, 70)}) ${r.why.slice(0, 160)}`);
}

function report(paths: string[], supersede = false) {
  const all = readRows(paths, supersede);
  if (all.length && all.every((r) => r.category)) return reportV2(all);
  const rows = all;
  const by = new Map<string, any[]>();
  for (const r of rows) { const k = `${r.config}|${r.group}`; by.set(k, [...(by.get(k) ?? []), r]); }
  console.log("config | group | n | correct | wrong effect | false success | unconfirmed write | errored | stopped | asked | calls/task | $/task | s/task");
  for (const [k, rs] of [...by].sort()) {
    const n = rs.length, f = (key: string) => rs.filter((r) => r[key]).length;
    console.log(`${k.replace("|", " | ")} | ${n} | ${f("correct")} (${Math.round((100 * f("correct")) / n)}%) | ${f("wrong_effect")} | ${f("false_success")} | ${f("unconfirmed_write")} | ${f("errored")} | ${rs.filter((r) => ["waiting_user", "needs_reconciliation", "failed"].includes(r.status)).length} | ${rs.reduce((a, r) => a + r.asked.length, 0)} | ${(rs.reduce((a, r) => a + r.model_calls, 0) / n).toFixed(1)} | ${(rs.reduce((a, r) => a + r.cost_usd, 0) / n).toFixed(4)} | ${(rs.reduce((a, r) => a + r.seconds, 0) / n).toFixed(1)}`);
  }
  for (const [k, rs] of [...by].sort()) for (const r of rs.filter((r) => !r.correct)) console.log(`  ✗ ${k} ${r.task}: ${r.status} (${(r.reason ?? "").slice(0, 80)}) ${r.why.slice(0, 160)}`);
}

/** --policy name=value, for the switches in orchestrator POLICY; an unknown name or value stops the run. */
function parsePolicy(args: string[]): Partial<Policy> {
  const choices: Record<string, string[]> = { cannot: ["ask", "report"], evidence: ["v1", "v2"] };
  const out: Record<string, string> = {};
  for (const arg of args) {
    const [k, v] = arg.split("=");
    if (!k || !(k in POLICY) || !v || !choices[k]?.includes(v)) throw new Error(`--policy ${arg}: expected one of ${Object.entries(choices).map(([n, vs]) => `${n}=${vs.join("|")}`).join(", ")}`);
    out[k] = v;
  }
  return out as Partial<Policy>;
}

async function main() {
  const { values: a, positionals } = parseArgs({ args: process.argv.slice(2).filter((x) => x !== "--"), allowPositionals: true, options: {
    tasks: { type: "string" }, config: { type: "string", default: "B0-luna" }, split: { type: "string", default: "dev" },
    groups: { type: "string", default: "1,2,3,4,5,6,7" }, only: { type: "string" }, limit: { type: "string" }, "max-cost": { type: "string", default: "12" },
    out: { type: "string" }, v: { type: "boolean", default: false }, report: { type: "string", multiple: true },
    supersede: { type: "boolean", default: false },      // with --report: a later file's row replaces an earlier one for the same task
    role: { type: "string", multiple: true, default: [] },
    repeat: { type: "string", default: "1" },
    policy: { type: "string", multiple: true, default: [] },     // e.g. --policy cannot=report --policy evidence=v1
    engine: { type: "string", default: "orchestrator" },         // orchestrator (the role loop) or runtime (the frontier loop, engine-runtime.ts)
    loop: { type: "string" },                                    // --engine runtime: the loop's model as <provider>|<model>; default the config's goal model
  } });
  // `--report a b c` reads all three: a file after the first used to be taken as a stray argument and dropped unseen
  if (a.report?.length) return report([...a.report, ...positionals], a.supersede);
  if (positionals.length) throw new Error(`unexpected arguments: ${positionals.join(" ")}`);
  if (!a.tasks) throw new Error("--tasks <path to tasks.json> is required");
  const groups = new Set(a.groups!.split(",").map(Number));
  const only = a.only ? new Set(a.only.split(",")) : null;
  let tasks: Task[] = JSON.parse(fs.readFileSync(a.tasks, "utf-8"));
  setSimCache(path.join(path.dirname(path.resolve(a.tasks)), "sim-cache.json"));
  // The macOS helper is built (or found) before the first task, so every task sees the same capabilities: PDF and OCR
  // are offered only once it answers (registry/tools.ts).
  await prepareHelper();
  console.log(`macOS helper: ${helperProblem() ?? "ready (fs.convert_to_pdf, fs.ocr_image offered)"}`);
  tasks = tasks.filter((t) => groups.has(t.group) && t.split === a.split && (!only || only.has(t.id)));
  if (a.limit) tasks = tasks.slice(0, Number(a.limit));
  const policy = parsePolicy(a.policy!);
  if (!["orchestrator", "runtime"].includes(a.engine!)) throw new Error(`--engine ${a.engine}: expected orchestrator or runtime`);
  const out = path.resolve("runs", a.out ?? `${a.config}${a.engine === "runtime" ? "@runtime" : ""}${a.role!.length ? "+" + a.role!.map((r) => r.split("=")[0]).join("+") : ""}${Object.entries(policy).map(([k, v]) => `+${k}-${v}`).join("")}-${a.split}`);
  fs.mkdirSync(out, { recursive: true });
  const callsLog = fs.openSync(path.join(out, "model_calls.jsonl"), "a");
  const table = a.role!.length ? withOverrides(CONFIGS[a.config!]!, a.role!) : a.config!;
  const gw = new Gateway(table, { log: (r) => fs.writeSync(callsLog, JSON.stringify(r) + "\n"), maxCostUsd: Number(a["max-cost"]) });
  const roleTable = typeof table === "string" ? CONFIGS[table]! : table;
  const model = a.engine === "runtime" ? loopModel(a.loop ?? roleTable.goal.model) : null;
  const resPath = path.join(out, "results.jsonl");
  const done = new Set(fs.existsSync(resPath) ? fs.readFileSync(resPath, "utf-8").split("\n").filter(Boolean).map((l) => { const r = JSON.parse(l); return `${r.task}#${r.rep ?? 0}`; }) : []);
  const repeats = Number(a.repeat);
  outer: for (let rep = 0; rep < repeats; rep++) {
    const library = new Library(path.join(out, `rep${rep}`, "skills.json"));   // a fresh skill library per repetition
    fs.mkdirSync(path.join(out, `rep${rep}`), { recursive: true });
    for (const t of tasks) {
      if (done.has(`${t.id}#${rep}`)) continue;
      if (a.v) console.log(`\n=== ${t.id} (${t.split}, rep ${rep}): ${t.raw}`);
      const r = { ...(model ? await runTaskRuntime(t, gw, model, capsFor(t), new SimUser(t), out, a.v!, rep) : await runTask(t, gw, out, a.v!, library, rep, policy)), rep };
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
