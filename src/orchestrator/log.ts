/**
 * The run log (append-only, fsync'd per event) and the State folded from it. Nothing the orchestrator knows lives
 * anywhere else: a new process rebuilds the same state from the same log, which is how a crash between an effect and
 * its receipt is found (an intent without a receipt).
 */
import * as fs from "node:fs";
import type { Context, ExecutionCommand, ExecutionResult, Goal, Plan, PlanNode, RunStatus } from "../protocol/schemas.js";
import { ABSENT } from "../registry/workspace.js";

export interface Event { seq: number; t: number; kind: string; [k: string]: unknown }

export class Log {
  events: Event[] = [];

  constructor(readonly path: string) {
    if (fs.existsSync(path)) {
      this.events = fs.readFileSync(path, "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Event);
    }
  }

  append(kind: string, body: Record<string, unknown>): Event {
    const ev: Event = { seq: this.events.length + 1, t: Math.round(Date.now()) / 1000, kind, ...body };
    const fd = fs.openSync(this.path, "a");
    try {
      fs.writeSync(fd, JSON.stringify(ev) + "\n");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.events.push(ev);
    return ev;
  }
}

export type NodeStatus = "pending" | "ready" | "verified" | "failed" | "running";

export interface NodeState {
  node: PlanNode;
  status: NodeStatus;
  bindings: unknown;
  args: Record<string, string> | null;
  output: Record<string, unknown> | null;
  operationIds: string[];
  attempts: number;
  why?: string;
}

export interface OpState { intent: ExecutionCommand; state: "in_flight" | "ok" | "unknown" | "not_executed" | string; receipt?: ExecutionResult }

export class State {
  runId = "";
  status: RunStatus = "received";
  reason: string | null = null;
  raw = "";
  scope = ".";
  answers: { question: string; text: string }[] = [];
  goal: Goal | null = null;
  revs: Context = { goal_rev: 0, plan_rev: 0, policy_rev: 1, evidence_epoch: 0 };
  plan: Plan | null = null;
  nodes = new Map<string, NodeState>();
  ops = new Map<string, OpState>();
  startVersions: Record<string, string> = {};
  startContents: Record<string, string> = {};   // small files as they were when the run started
  lastVersions: Record<string, string> = {};
  lastSeen: Record<string, string> = {};
  approvals = new Set<string>();
  declined = new Set<string>();
  effects: string[] = [];
  externalChanges: string[] = [];       // paths another program changed while we were running (facts, not our effects)
  n: Record<string, number> = {};
  skillUsed: string | null = null;
  notes: string[] = [];

  count(key: string, by = 1) {
    this.n[key] = (this.n[key] ?? 0) + by;
  }
  get(key: string) {
    return this.n[key] ?? 0;
  }

  private seen(versions: Record<string, string>) {
    for (const [p, v] of Object.entries(versions)) if (v !== ABSENT && !v.startsWith("dir:")) this.lastSeen[p] = v;
  }

  apply(ev: Event) {
    const e = ev as Record<string, any>;
    switch (ev.kind) {
      case "run.start":
        this.runId = e.run_id; this.raw = e.raw; this.scope = e.scope;
        this.startVersions = e.versions; this.lastVersions = { ...e.versions }; this.seen(e.versions);
        this.startContents = e.contents ?? {};
        break;
      case "goal.update":
        this.raw = e.raw; this.goal = null; this.plan = null; this.nodes = new Map();
        this.revs.goal_rev += 1; this.revs.evidence_epoch += 1;
        this.notes.push(`用户改了要求：${e.raw}`);
        break;
      case "goal.accepted":
        this.goal = e.goal; this.revs.goal_rev += 1; this.revs.evidence_epoch += 1;
        break;
      case "plan.accepted":
        this.plan = e.plan; this.revs.plan_rev += 1; this.revs.evidence_epoch += 1;
        this.nodes = new Map((e.plan as Plan).nodes.map((n) => [n.id, { node: n, status: "pending", bindings: null, args: null, output: null, operationIds: [], attempts: 0 }]));
        this.skillUsed = e.plan.skill ?? null;
        this.count("replans", e.replan ?? 0);
        break;
      case "node.bound": {
        const nd = this.nodes.get(e.node_id)!;
        nd.bindings = e.bindings; nd.args = e.args; nd.status = "ready"; nd.attempts += 1;
        break;
      }
      case "node.unbound": {
        const nd = this.nodes.get(e.node_id);
        if (nd) { nd.bindings = null; nd.args = null; nd.status = "pending"; }
        break;
      }
      case "node.verified": {
        const nd = this.nodes.get(e.node_id);
        if (nd) { nd.status = "verified"; nd.output = e.output ?? null; }
        break;
      }
      case "node.failed": {
        const nd = this.nodes.get(e.node_id);
        if (nd) nd.status = "failed";
        break;
      }
      case "env.changed":
        this.revs.evidence_epoch += 1;
        for (const p of (e.paths as string[]) ?? []) if (p !== "gui" && !this.externalChanges.includes(p)) this.externalChanges.push(p);
        break;
      case "observation":
        this.lastVersions = e.versions; this.seen(e.versions);
        break;
      case "interaction.reply": {
        const b = e.body;
        if (b.kind === "clarify") { this.answers.push({ question: b.question, text: b.text }); this.revs.evidence_epoch += 1; }
        else if (b.kind === "authorize") {
          (b.approved ? this.approvals : this.declined).add(b.digest);
          if (!b.approved) this.notes.push(`用户拒绝了：${b.text}`);
        }
        this.count(`ask:${b.kind}`);
        break;
      }
      case "execution.intent": {
        const c = e.command as ExecutionCommand;
        this.ops.set(c.operation_id, { intent: c, state: "in_flight" });
        this.nodes.get(c.node_id)?.operationIds.push(c.operation_id);
        break;
      }
      case "execution.receipt": {
        const op = this.ops.get(e.operation_id)!;
        const r = e.result as ExecutionResult;
        op.state = r.status; op.receipt = r;
        if (r.status === "ok") {
          Object.assign(this.lastVersions, r.versions_after); this.seen(r.versions_after);
          this.effects.push(e.text); this.count("actions");
        } else this.effects.push(`${e.text}（没有生效：${r.why ?? r.status}）`);
        this.revs.evidence_epoch += 1;
        break;
      }
      case "run.recovered":
        for (const oid of e.unknown as string[]) this.ops.get(oid)!.state = "unknown";
        this.status = "needs_reconciliation";
        break;
      case "reconciliation": {
        const op = this.ops.get(e.operation_id)!;
        op.state = ({ happened: "ok", not_happened: "not_executed" } as Record<string, string>)[e.finding] ?? "unknown";
        if (e.finding === "happened") { Object.assign(this.lastVersions, e.versions); this.seen(e.versions); this.effects.push(e.text); this.count("actions"); }
        if (this.status === "needs_reconciliation" && this.unknownOps().length === 0) this.status = "running";
        this.revs.evidence_epoch += 1;
        break;
      }
      case "verification":
        this.count("verifications");
        if (e.subject === "goal" && !e.passed) this.count("done_rejected");
        break;
      case "decision.rejected":
        this.count("rejected"); this.count("rejected:" + String(e.why).split(":")[0]);
        break;
      case "run.status":
        this.status = e.status; this.reason = e.reason ?? null;
        break;
      case "note":
        this.notes.push(e.text);
        break;
    }
  }

  unknownOps(): string[] {
    return [...this.ops].filter(([, v]) => v.state === "unknown" || v.state === "in_flight").map(([k]) => k);
  }

  context(): Context {
    return { ...this.revs };
  }

  answersText(): string[] {
    return this.answers.map((a) => a.text);
  }
}
