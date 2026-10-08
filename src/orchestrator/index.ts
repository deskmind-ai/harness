/**
 * The orchestrator: the only writer of the run log and the only thing that commits state.
 *
 *   received → goal (model structures the user's text; code refuses checks it cannot run)
 *            → plan (an applicable skill instantiated by code; else the plan role over registered capabilities)
 *            → for every node that can run: bind (model says where each argument comes from; code resolves and
 *              typechecks) → one intent check over the bound nodes (a second model reads the raw text and the
 *              concrete actions) → execute (intent persisted → effect → receipt; resource versions re-checked)
 *            → after every effect the root requirements are checked by code; all pass → succeeded
 *            → semantic requirements go to the verify role once every node is done.
 *
 * Signals (changed resources, a goal update, a mismatch, unresolved bindings) re-enter the loop at the right stage.
 * A crash between effect and receipt is found from the log on restart and reconciled before anything else is written.
 */
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { Gateway, Reply } from "../gateway/index.js";
import * as R from "../protocol/roles.js";
import type { Binding, Goal, PlanNode, RunStatus } from "../protocol/schemas.js";
import { TERMINAL } from "../protocol/schemas.js";
import { describeCapability, type Capability, type Registry } from "../registry/capability.js";
import { matches as versionsMatch, reconcile as reconcileVersions } from "../registry/reconcile.js";
import { ABSENT, Workspace, sha } from "../registry/workspace.js";
import { Crash } from "../registry/capability.js";
import { Log, State, type NodeState } from "./log.js";
import * as P from "./prompts.js";

export interface User {
  /** Answer a question. `options` are shown as 1..n plus 「其他（直接输入）」; the answer may be a number or text. */
  clarify(question: string, options?: string[]): string | null;
  authorize(text: string): boolean;
}

/** A skill library: candidates for a task, instantiation into nodes, use bookkeeping. */
export interface SkillLibrary {
  candidates(raw: string, ws: Workspace): { id: string; title: string; applies_when: string }[];
  instantiate(skillId: string, ws: Workspace): { nodes: PlanNode[]; unsure: string[] };
}

export interface GuiApp {
  observe(): GuiObservation;
  act(kind: "press" | "set_value" | "type", targetId: string, observationEpoch: number, value?: string): { status: string; why?: string; note?: string };
}
export interface GuiElement { target_id: string; role: string; label: string; actions: string[]; value?: string; options?: string[]; enabled?: boolean; focused?: boolean; in_modal?: boolean }
export interface GuiObservation { observation_epoch: number; app: string; window: string; focus_app: string; modal: { title: string; blocking: boolean } | null; elements: GuiElement[]; documents: unknown[] }

export class Stale extends Error {}

export interface Hooks {
  before_execute?: (o: Orchestrator) => void;
  before_gui_step?: (o: Orchestrator) => void;
  after_reply?: (o: Orchestrator) => void;
  crash_on_first_effect?: boolean;
}

export const BUDGET = { model_calls: 40, actions: 30, replans: 2, asks: 3, rebinds: 2 };

const canon = (x: unknown) => JSON.stringify(x, Object.keys(x as object).sort());

const WIDTH: Record<string, string> = { "（": "(", "）": ")", "：": ":", "，": ",", "；": ";", "！": "!", "？": "?", "「": '"', "」": '"', "“": '"', "”": '"', "‘": "'", "’": "'", "、": "," };
/** Comparison form for quotes: full-width punctuation folded, whitespace removed. */
export const loose = (t: string) => t.replace(/[（）：，；！？「」“”‘’、]/g, (c) => WIDTH[c]!).replace(/\s+/g, "");

export function findQuote(texts: string[], quote: string, occurrence: number): { text: number; start: number; end: number } | null {
  let n = 0;
  for (let ti = 0; ti < texts.length; ti++) {
    const t = texts[ti]!;
    let from = 0;
    for (;;) {
      const i = t.indexOf(quote, from);
      if (i < 0) break;
      n += 1;
      if (n === occurrence) return { text: ti, start: [...t.slice(0, i)].length, end: [...t.slice(0, i)].length + [...quote].length };
      from = i + 1;
    }
  }
  return null;
}

export function describe(cap: Capability, args: Record<string, string>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}=「${v}」（${(cap.schema.properties[k]?.description ?? "").split("。")[0]}）`);
  return `调用能力「${cap.description.split("；")[0]!.replace(/。$/, "")}」：${parts.join("，")}`;
}

export class Orchestrator {
  readonly log: Log;
  readonly st = new State();
  readonly budget: typeof BUDGET;

  constructor(
    logPath: string,
    readonly ws: Workspace,
    readonly gw: Gateway,
    readonly user: User,
    readonly registry: Registry,
    readonly opts: { skills?: SkillLibrary; gui?: GuiApp; hooks?: Hooks; budget?: Partial<typeof BUDGET> } = {},
  ) {
    this.log = new Log(logPath);
    this.budget = { ...BUDGET, ...(opts.budget ?? {}) };
    for (const ev of this.log.events) this.st.apply(ev);
    const inFlight = [...this.st.ops].filter(([, v]) => v.state === "in_flight").map(([k]) => k);
    if (inFlight.length) this.emit("run.recovered", { unknown: inFlight });
  }

  private cap(id: string): Capability {
    const c = this.registry.get(id);
    if (!c) throw new Error(`capability ${id} vanished from the registry`);
    return c;
  }

  emit(kind: string, body: Record<string, unknown> = {}) {
    const ev = this.log.append(kind, body);
    this.st.apply(ev);
    return ev;
  }

  private hook(name: keyof Hooks) {
    const f = this.opts.hooks?.[name];
    if (typeof f === "function") f(this);
  }

  private async askModel<S extends z.ZodTypeAny>(role: R.Role, user: string, schema: S): Promise<Reply<z.infer<S>>> {
    this.st.count("model_calls");
    this.st.count(`calls:${role}`);
    const rep = await this.gw.ask(role, P.SYSTEM, user, schema, this.st.runId);
    this.emit("model.reply", { role, outcome: rep.outcome, model: rep.model, error: rep.error.slice(0, 200), data: rep.outcome === "answered" ? rep.data : null, context: this.st.context() });
    this.hook("after_reply");
    return rep;
  }

  // --- entry ------------------------------------------------------------------------------------------------------
  start(raw: string, scope = ".") {
    const versions: Record<string, string> = {};
    for (const p of Object.keys(this.ws.entries())) versions[p] = this.ws.version(p);
    versions["/"] = this.ws.version("/");
    this.emit("run.start", { run_id: `run_${randomUUID().slice(0, 8)}`, raw, scope, versions });
  }

  /** The user changed what they want. Everything downstream of the goal is stale; effects stay. */
  updateGoal(newRaw: string, reason: string) {
    this.emit("goal.update", { raw: newRaw, reason });
  }

  // --- main loop ---------------------------------------------------------------------------------------------------
  async run() {
    const st = this.st;
    while (!TERMINAL.has(st.status) && st.status !== "waiting_user") {
      if (st.status === "needs_reconciliation") {
        if (!this.reconcile()) break;
        continue;
      }
      if (st.get("model_calls") > this.budget.model_calls) { this.finish("failed", "budget: model calls"); break; }
      if (!st.goal) { await this.doGoal(); continue; }
      if (this.opts.gui) { await this.doGuiStep(); continue; }
      if (!st.plan) { await this.doPlan(); continue; }
      if (await this.rootCheck(false)) break;
      const nodes = [...st.nodes.values()];
      const ready = nodes.filter((n) => n.status === "pending" && n.node.depends_on.every((d) => st.nodes.get(d)?.status === "verified"));
      const bound = nodes.filter((n) => n.status === "ready");
      if (bound.length) { this.doExecute(bound[0]!); continue; }
      if (ready.length) {
        const boundNow: NodeState[] = [];
        for (const n of ready) {
          if (await this.doBind(n, "", true)) boundNow.push(n);
          if ((st.status !== "running" && st.status !== "received") || st.nodes.size === 0) break;
        }
        if (boundNow.length && boundNow.every((n) => st.nodes.has(n.node.id))) await this.intentCheck(boundNow);
        continue;
      }
      if (nodes.some((n) => n.status === "failed")) {
        const declined = nodes.filter((n) => n.status === "failed" && st.declined.size > 0);
        if (declined.length && st.get("replans") < this.budget.replans) {
          await this.doPlan({ nodes: st.plan.nodes, source: st.plan.source }, "用户拒绝了其中一步（见提示）；已发生的效果保留，请换一种不需要那一步的做法，做不到就 cannot");
          if (TERMINAL.has(st.status) || (st.status as RunStatus) === "waiting_user") break;
          continue;
        }
        this.finish("failed", "a node failed and nothing else can run");
        break;
      }
      if (await this.rootCheck(true)) break;
      if (TERMINAL.has(st.status)) break;
      if (st.plan.source === "skill" && st.get("replans") < this.budget.replans) {
        await this.doPlan({ nodes: st.plan.nodes, source: "skill" }, "教材处理完了它认识的文件，还有要求没满足；教材处理不了的文件：" + JSON.stringify(st.plan.unsure ?? []));
        if (TERMINAL.has(st.status) || (st.status as RunStatus) === "waiting_user") break;
        continue;
      }
      this.finish("failed", "all nodes done but the goal is not met");
      break;
    }
    return this.summary();
  }

  finish(status: RunStatus, reason: string) {
    this.emit("run.status", { status, reason });
  }

  // --- goal -------------------------------------------------------------------------------------------------------
  private async doGoal() {
    const st = this.st;
    const caps = this.registry.list().map((c) => ({ id: c.id, description: c.description }));
    const rep = await this.askModel("goal", P.goalPrompt(st.raw, st.answersText(), this.ws.listing(), caps, st.scope), R.GoalAnswer);
    if (rep.outcome !== "answered") return this.modelFailed(rep);
    const g = rep.data!;
    if (g.feasible === "needs_capability_we_lack") return this.finish("failed", "cannot: " + (g.infeasible_reason ?? "需要没有注册的能力"));
    const info = g.missing.filter((m) => m.kind !== "approval");
    if (info.length) return this.clarify(info[0]!.question, "goal: " + info[0]!.what, info[0]!.options);
    if (g.missing.length) this.emit("note", { text: "模型想先要批准；批准由执行前的确认处理：" + g.missing.map((m) => m.what).join("；") });
    const bad = g.requirements.filter((r) => r.check.kind === "deterministic" && (!r.check.name || !(C_CHECKS as readonly string[]).includes(r.check.name) || typeof r.check.args !== "object"));
    if (bad.length) {
      this.emit("decision.rejected", { why: "goal: unknown check " + JSON.stringify(bad.map((r) => r.check)).slice(0, 200) });
      return this.finish("failed", "goal: proposed checks the verifier does not have");
    }
    if (!g.requirements.length) return this.finish(st.answers.length ? "cancelled" : "failed", st.answers.length ? "the user withdrew the request" : "goal: no requirements");
    const shown = this.ws.listing().entries;                       // the model saw only these; so only these count as evidence
    const texts = [st.raw, ...st.answersText(), ...shown.map((e) => e.path), ...shown.filter((e) => e.kind === "file").map((e) => this.ws.read(e.path).slice(0, 2000))].map(loose);
    for (const r of g.requirements) for (const q of r.quotes) {
      if (!texts.some((t) => t.includes(loose(q)))) {
        this.emit("decision.rejected", { why: `goal: quote not in evidence: ${q.slice(0, 40)}` });
        return this.finish("failed", "goal: cited words the user did not say");
      }
    }
    const goal: Goal = { requirements: g.requirements, constraints: g.constraints };
    this.emit("goal.accepted", { goal });
  }

  // --- plan -------------------------------------------------------------------------------------------------------
  private async doPlan(previous: unknown = null, why = ""): Promise<void> {
    const st = this.st;
    if (this.opts.skills && previous === null && st.get("skill_tried") === 0) {
      st.count("skill_tried");
      if (await this.trySkill()) return;
    }
    if (previous !== null && st.get("replans") >= this.budget.replans) return this.finish("failed", "budget: replans");
    const caps = this.registry.list().map(describeCapability);
    const rep = await this.askModel("plan", P.planPrompt(st.goal!, st.raw, st.answersText(), this.ws.listing(), caps, st.effects, previous, why, st.notes.slice(-3)), R.PlanAnswer);
    if (rep.outcome !== "answered") return this.modelFailed(rep);
    const p = rep.data!;
    if (p.outcome === "cannot") return this.finish("failed", "cannot: " + (p.reason ?? ""));
    if (p.outcome === "need_user") return this.clarify(p.question || "请把要求说得更具体一些。", "plan");
    const err = this.checkPlan(p.nodes);
    if (err) {
      this.emit("decision.rejected", { why: "plan: " + err });
      if (previous === null && st.get("plan_retry") < 1) { st.count("plan_retry"); return this.doPlan(p, "上一版计划不合格：" + err); }
      return this.finish("failed", "plan: " + err);
    }
    this.emit("plan.accepted", { plan: { nodes: p.nodes, source: "planner" }, replan: previous !== null ? 1 : 0 });
  }

  private checkPlan(nodes: Omit<PlanNode, "args">[]): string | null {
    const ids = nodes.map((n) => n.id);
    if (!ids.length) return "no nodes";
    if (new Set(ids).size !== ids.length) return "duplicate node ids";
    for (const n of nodes) {
      if (!this.registry.has(n.capability)) return `unknown capability ${n.capability}`;
      for (const d of n.depends_on) if (!ids.includes(d) || d === n.id) return `bad dependency ${d}`;
    }
    const seen = new Set<string>();
    const visit = (i: string, stack: Set<string>): boolean => {
      if (stack.has(i)) return false;
      if (seen.has(i)) return true;
      for (const d of nodes.find((n) => n.id === i)!.depends_on) if (!visit(d, new Set([...stack, i]))) return false;
      seen.add(i);
      return true;
    };
    for (const i of ids) if (!visit(i, new Set())) return "cycle";
    const covered = new Set(nodes.flatMap((n) => n.requirement_ids));
    const reqs = this.st.goal!.requirements;
    const uncovered = reqs.filter((r) => !covered.has(r.id) && !["unchanged", "file_absent"].includes(r.check.name ?? "") && r.check.kind !== "user_confirmation");
    if (uncovered.length && uncovered.length === reqs.length) return "no node serves any requirement";
    if (nodes.length > 12) return "too many nodes";
    return null;
  }

  private async trySkill(): Promise<boolean> {
    const st = this.st, lib = this.opts.skills!;
    const cands = lib.candidates(st.raw, this.ws);
    if (!cands.length) return false;
    const options = [...cands.map((s) => ({ id: s.id, text: `${s.title}。适用：${s.applies_when}` })), { id: "none", text: "都不适用，另外规划" }];
    const ids = options.map((o) => o.id) as [string, ...string[]];
    const rep = await this.askModel("choice", P.choicePrompt("哪份已有的教材适用于这个任务？", { 用户原文: st.raw, 目录: this.ws.listing() }, options), R.choiceAnswer(ids));
    if (rep.outcome !== "answered" || rep.data!.choice === "none") return false;
    const { nodes, unsure } = lib.instantiate(rep.data!.choice, this.ws);
    if (unsure.length) this.emit("note", { text: `教材 ${rep.data!.choice} 处理不了：${JSON.stringify(unsure)}` });
    if (!nodes.length) { this.emit("note", { text: `教材 ${rep.data!.choice} 选中但没有产生任何动作` }); return false; }
    this.emit("plan.accepted", { plan: { nodes, source: "skill", skill: rep.data!.choice, unsure } });
    return true;
  }

  // --- bind -------------------------------------------------------------------------------------------------------
  /** Bind one node. Returns true when it is bound and its intent check is left to the caller. */
  private async doBind(nd: NodeState, why = "", deferIntent = false): Promise<boolean> {
    const st = this.st, node = nd.node, cap = this.cap(node.capability);
    if (node.args) {                                   // a skill fixed the arguments
      const err = cap.typecheck(node.args);
      if (err) { this.emit("node.failed", { node_id: node.id, why: err }); return false; }
      this.emit("node.bound", { node_id: node.id, bindings: { source: "skill" }, args: node.args });
      if (deferIntent) return true;
      await this.intentCheck([nd]);
      return false;
    }
    if (nd.attempts > this.budget.rebinds) { this.finish("failed", `budget: rebinds on ${node.id}`); return false; }
    const upstream: Record<string, unknown> = {};
    for (const d of node.depends_on) { const out = st.nodes.get(d)?.output; if (out) upstream[d] = out; }
    const capView = { id: cap.id, description: cap.description, input: cap.schema.properties, required: cap.schema.required };
    const reason = why || nd.why || "";
    nd.why = undefined;
    const { args: _a, ...nodeView } = node;
    const rep = await this.askModel("bind", P.bindPrompt(st.raw, st.answersText(), nodeView, capView, this.ws.listing(), upstream, st.scope, reason), R.BindAnswer);
    if (rep.outcome !== "answered") { this.modelFailed(rep); return false; }
    const b = rep.data!;
    if (b.unresolved.length) {
      const u = b.unresolved[0]!;
      if (u.reason === "missing_user_intent" || u.reason === "ambiguous") this.clarify(u.question || `请说明 ${u.parameter} 应该是什么。`, `bind: ${u.reason}`);
      else this.finish("failed", `bind: ${u.reason} on ${u.parameter}`);
      return false;
    }
    const res = this.resolve(cap, b.bindings, upstream);
    if ("error" in res) {
      this.emit("decision.rejected", { why: "bind: " + res.error });
      nd.attempts += 1;
      return this.doBind(nd, res.error, deferIntent);
    }
    this.emit("node.bound", { node_id: node.id, bindings: b.bindings, args: res.args });
    if (deferIntent) return true;
    await this.intentCheck([nd]);
    return false;
  }

  resolve(cap: Capability, bindings: Record<string, Binding>, upstream: Record<string, unknown>): { args: Record<string, string> } | { error: string } {
    const texts = [this.st.raw, ...this.st.answersText()];
    const args: Record<string, string> = {};
    for (const k of cap.schema.required) if (!(k in bindings)) return { error: `required parameter ${k} not bound` };
    for (const [k, b] of Object.entries(bindings)) {
      if (!(k in cap.schema.properties)) return { error: `unknown parameter ${k}` };
      switch (b.kind) {
        case "source_span": {
          if (!b.quote || !findQuote(texts, b.quote, b.occurrence || 1)) return { error: `${k}: quote not found verbatim in the user's words: ${JSON.stringify(b.quote.slice(0, 40))}` };
          args[k] = b.quote;
          break;
        }
        case "resource_ref": {
          const p = b.path.trim().replace(/^\/+|\/+$/g, "");
          if (p === "" || p === ".") args[k] = ".";
          else if (!this.ws.exists(p)) return { error: `${k}: resource ${p} does not exist` };
          else args[k] = p;
          break;
        }
        case "upstream_output": {
          const out = upstream[b.node_id] as Record<string, unknown> | undefined;
          if (!out || !(b.field in out)) return { error: `${k}: upstream ${b.node_id}.${b.field} is not available` };
          args[k] = String(out[b.field]);
          break;
        }
        case "literal":
          args[k] = b.value;
          break;
        case "derived": {
          const srcs = b.from_paths.map((p) => p.trim().replace(/^\/+|\/+$/g, ""));
          if (!srcs.length || !b.how) return { error: `${k}: derived value needs from_paths and how` };
          const missing = srcs.filter((p) => !this.ws.exists(p));
          if (missing.length) return { error: `${k}: derived from files that do not exist: ${JSON.stringify(missing)}` };
          args[k] = b.value;
          break;
        }
      }
    }
    const err = cap.typecheck(args);
    return err ? { error: err } : { args };
  }

  private async intentCheck(nodes: NodeState[]) {
    const st = this.st;
    const actions: string[] = [];
    const evidence: Record<string, string> = {};
    for (const n of nodes) {
      const cap = this.cap(n.node.capability);
      const derived = Object.entries((n.bindings as Record<string, Binding> | null) ?? {}).filter((e): e is [string, Extract<Binding, { kind: "derived" }>] => (e[1] as Binding)?.kind === "derived");
      const hows = derived.map(([k, b]) => `${k} 的来历：${b.how}（依据 ${JSON.stringify(b.from_paths)}）`);
      actions.push(describe(cap, n.args!) + (hows.length ? "；" + hows.join("；") : ""));
      const { reads, writes } = cap.footprint(this.ws, n.args!);
      for (const p of [...reads, ...writes, ...derived.flatMap(([, b]) => b.from_paths)]) if (this.ws.exists(p) && !this.ws.isDir(p) && !(p in evidence)) evidence[p] = this.ws.read(p).slice(0, 600);
      for (const [k, b] of Object.entries((n.bindings as Record<string, Binding> | null) ?? {})) {
        if (b?.kind !== "upstream_output") continue;
        // the value came from an earlier read: show which file that node read, and the file as it is now
        const up = st.nodes.get(b.node_id);
        if (!up) continue;
        const upCap = this.registry.get(up.node.capability);
        const upReads = up.args && upCap ? upCap.footprint(this.ws, up.args).reads : [];
        const what = upReads.length ? `读取了 ${upReads.join(", ")}` : `${up.node.capability} ${JSON.stringify(up.args ?? {})}`;
        evidence[`${k} 的来源：节点 ${b.node_id}（${what}）的输出字段 ${b.field}`] = JSON.stringify(up.output ?? {}).slice(0, 600);
        for (const p of upReads) if (this.ws.exists(p) && !this.ws.isDir(p) && !(p in evidence)) evidence[p] = this.ws.read(p).slice(0, 600);
      }
    }
    const rep = await this.askModel("intent", P.intentPrompt(st.raw, st.answersText(), actions, st.goal!.constraints, evidence), R.IntentAnswer);
    if (rep.outcome !== "answered") return this.modelFailed(rep);
    const v = rep.data!.verdict;
    this.emit("verification", { subject: "intent", node_ids: nodes.map((n) => n.node.id), passed: v === "matches", verdict: v, reason: rep.data!.reason });
    if (v === "matches" || v === "requires_more_steps") return;
    for (const n of nodes) this.emit("node.unbound", { node_id: n.node.id });
    if (v === "mismatch") {
      if (nodes[0]!.node.args) { for (const n of nodes) this.emit("node.failed", { node_id: n.node.id, why: "intent mismatch on a skill action" }); return; }
      if (nodes.every((n) => n.attempts <= this.budget.rebinds)) { for (const n of nodes) n.why = "意图核对认为不对：" + rep.data!.reason; return; }
      return this.finish("failed", "intent: mismatch twice");
    }
    return this.clarify("请把要求说得更具体一些：" + rep.data!.reason, "intent: insufficient");
  }

  // --- execute ------------------------------------------------------------------------------------------------------
  private doExecute(nd: NodeState) {
    const st = this.st, node = nd.node, cap = this.cap(node.capability), args = nd.args!;
    if (st.unknownOps().length) { this.emit("decision.rejected", { why: "unverified effect pending" }); return; }
    if (st.get("actions") >= this.budget.actions) return this.finish("failed", "budget: actions");
    const rev = `${st.revs.goal_rev}/${st.revs.plan_rev}`;
    this.hook("before_execute");
    if (`${st.revs.goal_rev}/${st.revs.plan_rev}` !== rev || !st.nodes.has(node.id)) { this.emit("decision.rejected", { why: "stale: the goal or plan changed before execution" }); return; }
    const fp = cap.footprint(this.ws, args);
    const derivedFrom = Object.values((nd.bindings as Record<string, Binding> | null) ?? {}).filter((b): b is Extract<Binding, { kind: "derived" }> => b?.kind === "derived").flatMap((b) => b.from_paths.map((p) => p.trim().replace(/^\/+|\/+$/g, "")));
    const reads = [...new Set([...fp.reads, ...derivedFrom])], writes = fp.writes, expectAfter = fp.expectAfter;
    const now: Record<string, string> = {};
    for (const p of [...reads, ...writes]) now[p] = this.ws.version(p);
    const changed = Object.keys(now).filter((p) => p in st.lastVersions && st.lastVersions[p] !== now[p]);
    if (changed.length) {
      this.emit("env.changed", { paths: changed });
      this.emit("observation", { versions: { ...st.lastVersions, ...now } });
      this.emit("decision.rejected", { why: `resource_changed: ${JSON.stringify(changed)}` });
      this.emit("node.unbound", { node_id: node.id });
      return;
    }
    this.emit("observation", { versions: { ...st.lastVersions, ...now } });
    const pre = cap.preconditions(this.ws, args);
    if (pre) {
      this.emit("decision.rejected", { why: "precondition: " + pre });
      this.emit("node.unbound", { node_id: node.id });
      if (nd.attempts > this.budget.rebinds) return this.finish("failed", "precondition keeps failing: " + pre);
      nd.why = "前置条件不成立：" + pre;
      return;
    }
    const text = describe(cap, args);
    const digest = sha(canon({ cap: cap.id, args }));
    // Discarding content this run did not create is consequential: the user's (or another program's) data would be
    // lost. Only content written by this run may be overwritten without asking.
    // The request itself authorizes rewriting a file the user named for rewriting (「把 X 的内容改成…」). It does not
    // authorize discarding a file the user asked to *create* (「新建 X」 when X exists) or one the user never named.
    const foreign = !!cap.discards && writes.some((p) => !this.createdByUs(p) && !this.userAskedToRewrite(p));
    const delegated = st.get("delegated") > 0 && cap.effect !== "observe";
    if ((cap.requiresConfirmation || foreign || delegated) && !st.approvals.has(digest)) {
      if (st.declined.has(digest)) { this.emit("node.failed", { node_id: node.id, why: "declined by the user" }); return; }
      const ask = foreign && !cap.requiresConfirmation ? `${text}（注意：这个文件不是本次任务新建的，这一步会丢掉它现在的内容）`
        : delegated && !cap.requiresConfirmation ? `${text}（你让我决定的；这是我打算做的，可以吗？）` : text;
      this.emit("interaction.request", { body: { kind: "authorize", text: ask, digest } });
      const ok = this.user.authorize(ask);
      this.emit("interaction.reply", { body: { kind: "authorize", text: ask, digest, approved: ok } });
      if (!ok) {
        this.emit("node.failed", { node_id: node.id, why: "declined by the user" });
        if (delegated && !cap.requiresConfirmation && !foreign) {
          // the user delegated, then rejected our proposal: guessing again is not useful, the user has to choose
          return this.finish("waiting_user", "the user declined the proposed action; their choice is needed");
        }
        this.emit("note", { text: `用户不同意：${ask}。要换一种不覆盖别人改动的做法。` });
      }
      return;
    }
    const cmd = { operation_id: `op_${randomUUID().replace(/-/g, "").slice(0, 10)}`, node_id: node.id, capability: cap.id, args, reads, writes, versions_before: now, expect_after: expectAfter, context: st.context(), text };
    this.emit("execution.intent", { command: cmd });
    if (this.opts.hooks?.crash_on_first_effect && st.get("actions") === 0 && cap.effect !== "observe") this.crashNext = true;
    const result = this.crashNext ? this.executeAndCrash(cap, args) : cap.execute(this.ws, args);   // Crash propagates: no receipt
    this.ws.invalidate();
    const ok = versionsMatch(cmd.expect_after, this.ws);
    this.emit("execution.receipt", { operation_id: cmd.operation_id, result: { ...result, status: ok ? "ok" : "post_mismatch" }, text });
    if (ok) this.emit("node.verified", { node_id: node.id, output: result.output });
    else this.emit("node.failed", { node_id: node.id, why: "postcondition mismatch" });
  }

  private crashNext = false;
  private lastGuiSig = "";

  /** Test hook: run the effect, then die before the receipt (what a power cut at the wrong moment does). */
  private executeAndCrash(cap: Capability, args: Record<string, string>): never {
    this.crashNext = false;
    cap.execute(this.ws, args);
    this.ws.invalidate();
    throw new Crash("crash after the effect, before the receipt");
  }

  /** The user named this file and asked for it to be changed (not created): its content may be replaced on their word. */
  private userAskedToRewrite(p: string): boolean {
    const base = p.slice(p.lastIndexOf("/") + 1);
    const words = [this.st.raw, ...this.st.answersText()].join("\n");
    if (!words.includes(base)) return false;
    const idx = words.indexOf(base);
    const around = words.slice(Math.max(0, idx - 12), idx + base.length + 2);
    return !/新建|创建|新增|建一个|建个|新文件/.test(around);
  }

  /** True when the path's current content was written by this run (so rewriting it loses nothing of anyone else's). */
  private createdByUs(p: string): boolean {
    const now = this.ws.version(p);
    if (now === ABSENT) return true;
    if (now.startsWith("dir:")) return false;
    return [...this.st.ops.values()].some((op) => op.state === "ok" && op.receipt?.versions_after?.[p] === now);
  }

  private reconcile(): boolean {
    for (const oid of this.st.unknownOps()) {
      const it = this.st.ops.get(oid)!.intent;
      const finding = reconcileVersions(this.ws, it.versions_before, it.expect_after);
      const ps = [...it.writes, ...it.writes.filter((w) => w.includes("/")).map((w) => w.slice(0, w.lastIndexOf("/")))];
      const versions: Record<string, string> = {};
      for (const p of ps) versions[p] = this.ws.version(p);
      this.emit("reconciliation", { operation_id: oid, finding, text: it.text, versions });
      if (finding === "happened") this.emit("node.verified", { node_id: it.node_id, output: null });
      else if (finding === "not_happened") this.emit("node.unbound", { node_id: it.node_id });
      else { this.finish("needs_reconciliation", `${oid}: effect unknown, needs the user`); return false; }
    }
    return true;
  }

  // --- verification ---------------------------------------------------------------------------------------------------
  check(name: string, a: Record<string, string>): [boolean | null, string] {
    const ws = this.ws, v = (p: string) => ws.version(p);
    const need = (...ks: string[]) => ks.every((k) => typeof a[k] === "string");
    switch (name) {
      case "file_exists": return need("path") ? [ws.exists(a.path!), `${a.path} 存在`] : [null, "缺参数"];
      case "file_absent": return need("path") ? [!ws.exists(a.path!), `${a.path} 不存在`] : [null, "缺参数"];
      case "is_folder": return need("path") ? [ws.isDir(a.path!), `${a.path} 是文件夹`] : [null, "缺参数"];
      case "text_equals": return need("path", "text") ? [ws.exists(a.path!) && !ws.isDir(a.path!) && ws.read(a.path!).replace(/\n+$/, "") === a.text!.replace(/\n+$/, ""), `${a.path} 全文是「${a.text}」`] : [null, "缺参数"];
      case "text_contains": return need("path", "text") ? [ws.exists(a.path!) && !ws.isDir(a.path!) && ws.read(a.path!).includes(a.text!), `${a.path} 含「${a.text}」`] : [null, "缺参数"];
      case "last_line_is": {
        if (!need("path", "line")) return [null, "缺参数"];
        if (!ws.exists(a.path!) || ws.isDir(a.path!)) return [false, `${a.path} 不存在`];
        const lines = ws.read(a.path!).replace(/\n+$/, "").split("\n");
        return [lines[lines.length - 1] === a.line && lines.filter((l) => l === a.line).length === 1, `${a.path} 末行是「${a.line}」且只出现一次`];
      }
      case "same_text": return need("path", "other") ? [[a.path!, a.other!].every((x) => ws.exists(x) && !ws.isDir(x)) && ws.read(a.path!) === ws.read(a.other!), `${a.path} 与 ${a.other} 内容相同`] : [null, "缺参数"];
      case "unchanged": {
        if (!need("path")) return [null, "缺参数"];
        const p = a.path!;
        const ours = [...this.st.ops.values()].some((op) => op.state === "ok" && op.intent.writes.some((w) => w === p || w.startsWith(p + "/")));
        return [!ours, ours ? `${p} 被本次任务改动了` : `${p} 没有被本次任务改动`];
      }
      case "last_line_is_content_of": {
        if (!need("path", "source")) return [null, "缺参数"];
        if (!ws.exists(a.path!) || ws.isDir(a.path!) || !ws.exists(a.source!) || ws.isDir(a.source!)) return [false, `${a.path} 或 ${a.source} 不存在`];
        const lines = ws.read(a.path!).replace(/\n+$/, "").split("\n"), want = ws.read(a.source!).replace(/\n+$/, "");
        return [lines[lines.length - 1] === want, `${a.path} 的末行等于 ${a.source} 现在的内容`];
      }
      case "text_equals_content_of": {
        if (!need("path", "source")) return [null, "缺参数"];
        const ok = ws.exists(a.path!) && !ws.isDir(a.path!) && ws.exists(a.source!) && !ws.isDir(a.source!) && ws.read(a.path!).replace(/\n+$/, "") === ws.read(a.source!).replace(/\n+$/, "");
        return [ok, `${a.path} 的内容等于 ${a.source} 现在的内容`];
      }
      case "content_moved": {
        if (!need("from", "to")) return [null, "缺参数"];
        const sv = this.st.lastSeen[a.from!] ?? this.st.startVersions[a.from!] ?? ABSENT;
        return [sv !== ABSENT && v(a.to!) === sv, `${a.to} 的内容等于移动前的 ${a.from}`];
      }
    }
    return [null, `没有检查 ${name}`];
  }

  private deterministicAllPass(): boolean {
    const reqs = this.st.goal!.requirements;
    return reqs.some((r) => r.check.kind !== "deterministic") &&
      reqs.filter((r) => r.check.kind === "deterministic").every((r) => this.check(r.check.name!, r.check.args ?? {})[0] === true);
  }

  /** Code checks every deterministic requirement; semantic ones go to the verify role only at the end. */
  async rootCheck(final: boolean): Promise<boolean> {
    const st = this.st;
    if (st.unknownOps().length) return false;
    const results: Record<string, { passed: boolean; evidence: string }> = {};
    const failed: string[] = [];
    const semantic = [];
    for (const r of st.goal!.requirements) {
      if (r.check.kind === "deterministic") {
        const [ok, what] = this.check(r.check.name!, r.check.args ?? {});
        results[r.id] = { passed: !!ok, evidence: what };
        if (!ok) failed.push(what);
      } else semantic.push(r);
    }
    const onlyTrivial = st.goal!.requirements.filter((r) => r.check.kind === "deterministic").every((r) => r.check.name === "unchanged");
    if (!failed.length && !semantic.length && onlyTrivial && !st.effects.length) failed.push("需求里只有「不改动」类约束，没有可以判定完成的要求");
    if (failed.length || (semantic.length && !final)) {
      if (final) this.emit("verification", { subject: "goal", passed: false, checks: results, failed });
      return false;
    }
    for (const r of semantic) {
      if (r.check.kind === "user_confirmation") {
        // only the user can judge this one: ask once, remember the answer (never the verify model)
        const key = `confirm:${r.id}`;
        if (!(key in st.n)) {
          this.emit("interaction.request", { body: { kind: "authorize", text: r.statement, digest: sha(r.statement) } });
          const ok = this.user.authorize(r.statement);
          this.emit("interaction.reply", { body: { kind: "authorize", text: r.statement, digest: sha(r.statement), approved: ok } });
          st.n[key] = ok ? 1 : 0;
        }
        results[r.id] = { passed: st.n[key] === 1, evidence: st.n[key] === 1 ? "用户确认" : "用户未确认" };
        if (st.n[key] !== 1) failed.push(r.statement);
        continue;
      }
      const evidence: Record<string, unknown> = { 目录: this.ws.listing(), 本任务做过的动作: st.effects };
      if (st.externalChanges.length) evidence["任务期间被别的程序改过的文件（这些改动不是本任务造成的，保留它们不算违反需求）"] = st.externalChanges;
      for (const p of Object.keys(r.check.args ?? {}).map((k) => r.check.args![k]!).filter((v) => this.ws.exists(v) && !this.ws.isDir(v))) evidence[`文件内容 ${p}`] = this.ws.read(p).slice(0, 600);
      const rep = await this.askModel("verify", P.verifyPrompt(r, st.raw, evidence), R.VerifyAnswer);
      const ok = rep.outcome === "answered" && rep.data!.verdict === "pass";
      results[r.id] = { passed: ok, evidence: rep.data?.reason ?? rep.error };
      if (!ok) failed.push(r.statement);
    }
    this.emit("verification", { subject: "goal", passed: !failed.length, checks: results, failed });
    if (!failed.length) { this.finish("succeeded", "acceptance passed" + (final ? " (final)" : " after an effect")); return true; }
    return false;
  }

  // --- GUI: observe -> candidates -> choice -> guard -> act -> observe ----------------------------------------------------
  private async doGuiStep() {
    const st = this.st, gui = this.opts.gui!;
    if (await this.rootCheck(false)) return;
    // every code-checkable requirement holds and only semantic ones remain: ask the verifier now instead of waiting
    // for the model to pick "done" (a GUI run otherwise loops until its action budget)
    if (this.deterministicAllPass() && st.get("semantic_checked_epoch") !== st.revs.evidence_epoch) {
      st.n["semantic_checked_epoch"] = st.revs.evidence_epoch;
      if (await this.rootCheck(true)) return;
    }
    if (st.get("actions") >= this.budget.actions) return this.finish("failed", "budget: actions");
    this.hook("before_gui_step");
    const obs = gui.observe();
    this.emit("observation", { versions: st.lastVersions, gui_epoch: obs.observation_epoch });
    const opts: P.Option[] = [];
    const acts = new Map<string, ["press" | "set_value" | "type", string, string | undefined]>();
    const values = this.guiValues();
    for (const e of obs.elements) {
      if (e.enabled === false) continue;
      if (e.actions.includes("press")) {
        const id = `press:${e.target_id}`;
        opts.push({ id, text: `点「${e.label}」${e.in_modal ? "（弹窗里的按钮）" : ""}` });
        acts.set(id, ["press", e.target_id, undefined]);
      }
      if (e.actions.includes("set_value") && e.role === "popUpButton") {
        for (const o of e.options ?? []) { const id = `set:${e.target_id}:${o}`; opts.push({ id, text: `把「${e.label}」选成「${o}」` }); acts.set(id, ["set_value", e.target_id, o]); }
      } else if (e.actions.includes("set_value")) {
        for (const [k, v] of Object.entries(values)) {
          const id = `set:${e.target_id}:${k}`;
          opts.push({ id, text: `把「${e.label}」的内容设为「${v}」` });
          acts.set(id, ["set_value", e.target_id, v]);
          if (e.role === "textArea" && e.value) {
            const aid = `append:${e.target_id}:${k}`;
            opts.push({ id: aid, text: `在「${e.label}」现有内容的末尾另起一行加上「${v}」` });
            acts.set(aid, ["set_value", e.target_id, e.value + (e.value.endsWith("\n") ? "" : "\n") + v]);
          }
        }
      }
    }
    opts.push({ id: "done", text: "任务已经完成" }, { id: "ask", text: "问用户" }, { id: "cannot", text: "做不到，停下" });
    const ctx = {
      用户原文: st.raw, 窗口: obs.window, "键盘焦点在哪个 App": obs.focus_app, 弹窗: obs.modal,
      界面元素: obs.elements.map((e) => ({ target_id: e.target_id, role: e.role, label: e.label, value: e.value, focused: e.focused, in_modal: e.in_modal })),
      已保存的文档: obs.documents, 最近的动作: st.effects.slice(-4), 提示: st.notes.slice(-2),
    };
    const ids = opts.map((o) => o.id) as [string, ...string[]];
    const rep = await this.askModel("choice", P.choicePrompt("下一步做什么？目标是让任务目录里出现用户要的文件；保存前要确认文件名和位置都对。", ctx, opts), R.choiceAnswer(ids));
    if (rep.outcome !== "answered") return this.modelFailed(rep);
    const c = rep.data!.choice;
    if (c === "done") {
      if (!(await this.rootCheck(true))) {
        this.emit("note", { text: "还没完成：任务目录里还没有符合要求的文件" });
        if (st.get("done_rejected") >= 3) this.finish("waiting_user", "said done three times but the file is not right");
      }
      return;
    }
    if (c === "ask") return this.clarify("请说明还缺什么信息。", "gui");
    if (c === "cannot") return this.finish("failed", "cannot: " + (rep.data!.reason ?? ""));
    const [kind, target, value] = acts.get(c)!;
    const text = opts.find((o) => o.id === c)!.text;
    const sig = `${c}@${JSON.stringify(obs.elements.map((e) => [e.target_id, e.value ?? ""]))}`;
    if (this.lastGuiSig === sig) {                 // the same choice on an identical screen: nothing is moving
      this.emit("note", { text: `同一个界面上重复选择「${text}」，没有进展` });
      return this.finish("waiting_user", "no progress: the same action on an unchanged screen");
    }
    this.lastGuiSig = sig;
    if (text.includes("立即更新") || text.includes("替换")) {          // consequences the user did not ask for need the user
      const digest = sha(text);
      if (!st.approvals.has(digest)) {
        this.emit("interaction.request", { body: { kind: "authorize", text, digest } });
        const ok = this.user.authorize(text);
        this.emit("interaction.reply", { body: { kind: "authorize", text, digest, approved: ok } });
        if (!ok) { this.emit("note", { text: `用户不同意：${text}` }); return; }
      }
    }
    this.hook("before_execute");
    const cmd = { operation_id: `op_${randomUUID().replace(/-/g, "").slice(0, 10)}`, node_id: "gui", capability: `gui.${kind}`, args: { target, value: value ?? "" }, reads: [], writes: [], versions_before: {}, expect_after: {}, context: st.context(), text, observation_epoch: obs.observation_epoch };
    if (!st.nodes.has("gui")) st.nodes.set("gui", { node: { id: "gui", capability: "gui", depends_on: [], purpose: "", requirement_ids: [] }, status: "running", bindings: null, args: null, output: null, operationIds: [], attempts: 0 });
    this.emit("execution.intent", { command: cmd });
    let res: { status: string; why?: string; note?: string };
    try {
      res = gui.act(kind, target, obs.observation_epoch, value);
    } catch (e) {
      if (!(e instanceof Stale)) throw e;
      res = { status: "stale", why: e.message };
      this.emit("env.changed", { paths: ["gui"] });
    }
    this.emit("execution.receipt", { operation_id: cmd.operation_id, result: { ...res, versions_after: {} }, text });
    if (res.status !== "ok") {
      this.emit("note", { text: `上一步没有生效：${res.why ?? res.status}` });
      this.emit("decision.rejected", { why: `gui:${res.status}` });
    }
    await this.rootCheck(false);
  }

  /** Text the model may put into a field: only words the user said (quoted runs and file-like tokens). */
  private guiValues(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const t of [this.st.raw, ...this.st.answersText()]) {
      for (const m of t.matchAll(/[「“"]([^」”"]+)[」”"]/g)) out[`q${Object.keys(out).length}`] = m[1]!;
      for (const m of t.matchAll(/[A-Za-z0-9_一-鿿][A-Za-z0-9_一-鿿.\-]*\.[a-z]{2,4}/g)) if (!Object.values(out).includes(m[0])) out[`f${Object.keys(out).length}`] = m[0];
    }
    return out;
  }

  // --- interaction --------------------------------------------------------------------------------------------------------
  /** A model asking "shall I really do X?" is asking for approval, not information: that goes through authorize. */
  private static isApprovalRequest(q: string): boolean {
    return /确认|批准|同意|是否要|要不要|可以(删|移|覆盖|执行)|真的要/.test(q) && !/叫什么|哪个|哪一|什么内容|放到哪|写什么|名字/.test(q);
  }

  private clarify(question: string, why = "", options: string[] = []) {
    const st = this.st;
    // options the model offers must exist in the evidence; the rest are dropped (a candidate is a fact, not a guess)
    const shown = this.ws.listing().entries.map((e) => e.path);
    const evidence = [st.raw, ...st.answersText(), ...shown].map(loose);
    const valid = options.filter((o) => /由你决定|你定|都可以/.test(o) || evidence.some((t) => t.includes(loose(o))));
    if (Orchestrator.isApprovalRequest(question)) {
      st.count("approval_regex_fired");                       // the structural path is missing[].kind; this is the backstop
      const digest = sha("approval:" + question);
      if (!st.approvals.has(digest) && !st.declined.has(digest)) {
        this.emit("interaction.request", { body: { kind: "authorize", text: question, digest } });
        const ok = this.user.authorize(question);
        this.emit("interaction.reply", { body: { kind: "authorize", text: question, digest, approved: ok } });
        // the answer is recorded as the user's words so the next goal/plan round sees it
        this.emit("interaction.reply", { body: { kind: "clarify", question, text: ok ? "确认，照做。" : "不要做。" } });
        st.goal = null; st.plan = null; st.nodes = new Map();
        if (!ok) this.finish("cancelled", "the user declined");
        return;
      }
    }
    if (st.get("ask:clarify") >= this.budget.asks) return this.finish("waiting_user", "asked the user too often without progress");
    if (st.answers.some((a) => loose(a.question) === loose(question))) return this.finish("waiting_user", "the same question was already answered; not asking again");
    this.emit("interaction.request", { body: { kind: "clarify", question, why, options: valid } });
    let text = this.user.clarify(question, valid);
    if (text === null) return this.finish("waiting_user", "no answer from the user");
    const n = /^\s*(\d+)\s*[.．、)]?\s*$/.exec(text);
    if (n && valid[Number(n[1]) - 1]) text = valid[Number(n[1]) - 1]!;        // a number picks an option
    this.emit("interaction.reply", { body: { kind: "clarify", question, text, options: valid } });
    if (Orchestrator.isUninformative(text)) {
      // 「随便」「你看着办」 delegates the choice: the model may decide, but every write it then proposes is shown to
      // the user for approval first (a blank cheque it is not)
      this.emit("note", { text: "用户把这个选择交给了我们；由此决定的每个改动执行前都先给用户确认" });
      st.count("delegated");
    }
    st.goal = null; st.plan = null; st.nodes = new Map();        // the answer may change what the goal means
  }

  private static isUninformative(t: string): boolean {
    return /^(随便|你看着办|你定|都行|无所谓|按我原来说的做|照原话做|按原来的做)/.test(t.trim());
  }

  private modelFailed(rep: Reply) {
    if (rep.outcome === "error" || rep.outcome === "timeout") return this.finish("failed", `model error: ${rep.role} ${rep.outcome} ${rep.error.slice(0, 120)}`);
    return this.finish("waiting_user", `model ${rep.role}: ${rep.outcome} ${rep.error.slice(0, 120)}`);
  }

  summary() {
    const st = this.st;
    return {
      status: st.status, reason: st.reason, counters: { ...st.n }, revs: st.revs,
      ops: Object.fromEntries([...st.ops].map(([k, v]) => [k, v.state])), effects: st.effects, skill: st.skillUsed,
      nodes: Object.fromEntries([...st.nodes].map(([k, v]) => [k, v.status])), answers: st.answersText(), run_id: st.runId,
    };
  }
}

const C_CHECKS = ["file_exists", "file_absent", "is_folder", "text_equals", "text_contains", "last_line_is", "same_text", "unchanged", "content_moved", "last_line_is_content_of", "text_equals_content_of"] as const;
