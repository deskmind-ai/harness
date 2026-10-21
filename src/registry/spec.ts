/**
 * What the built-in capabilities share (fs.ts, tools.ts): field helpers, path helpers, the receipt, and `make`, which
 * builds a capability from a short spec with the common argument checks.
 */
import * as fs from "node:fs";
import { Crash, schemaCheck, type Args, type Capability, type Derivation, type Effect, type ExecResult, type FieldSchema, type Footprint } from "./capability.js";
import { Workspace } from "./workspace.js";

export const s = (description: string): FieldSchema => ({ type: "string", minLength: 1, description });
export const p = (description: string): FieldSchema => s(description + "。相对任务目录的路径，'/' 分隔，不能含 '..'");

export const norm = (x: string) => (x.trim() === "." || x.trim() === "./" ? "" : x.trim().replace(/^(\.\/)+/, "").replace(/^\/+|\/+$/g, ""));
export const join = (parent: string, name: string) => (norm(parent) === "" ? name : `${norm(parent)}/${name}`);
export const parentOf = (q: string) => (q.includes("/") ? q.slice(0, q.lastIndexOf("/")) : "");
export const folderOk = (ws: Workspace, d: string) => d === "" || ws.isDir(d);

/** Receipt versions: every written path and its parent folder. */
export function after(ws: Workspace, writes: string[], output: Record<string, unknown> = {}): ExecResult {
  const parents = new Set(writes.filter((w) => w.includes("/")).map(parentOf));
  const versions_after: Record<string, string> = {};
  for (const k of [...writes, ...parents]) versions_after[k] = ws.version(k);
  return { status: "ok", output, versions_after };
}

export interface Spec {
  id: string;
  description: string;
  fields: Record<string, FieldSchema>;
  effect: Effect;
  confirm?: boolean;
  discards?: boolean;
  pathFields?: string[];
  footprint: (ws: Workspace, a: Args) => Footprint;
  pre: (ws: Workspace, a: Args) => string | null;
  run: (ws: Workspace, a: Args) => ExecResult;
  /** Values a model produces after binding (Capability.derive); their fields are left out of the schema check. */
  derive?: { fields: string[]; from: (ws: Workspace, a: Args) => Derivation };
  /** reversible = `undo` exists (or the capability only observes). `check` says whether undo can run now without
   *  changing anything; `undo` checks again and acts. `prep` records before the action what undo will need. */
  undo?: (ws: Workspace, a: Args, r: ExecResult) => string | null;
  check?: (ws: Workspace, a: Args, r: ExecResult, ours: ReadonlySet<string>) => string | null;
  prep?: (ws: Workspace, a: Args) => Record<string, unknown>;
}

/** A capability from a spec, with the shared argument checks (schema, '..', bare names) applied first. */
export function make(sp: Spec): Capability {
  const schema = { type: "object" as const, properties: sp.fields, required: Object.keys(sp.fields), additionalProperties: false as const };
  return {
    id: sp.id, version: "1.0.0", description: sp.description, schema, effect: sp.effect, channel: "filesystem", requiresConfirmation: !!sp.confirm, pathFields: sp.pathFields ?? [], discards: !!sp.discards, reversible: sp.effect === "observe" || !!sp.undo,
    typecheck(a) {
      if (sp.derive) a = Object.fromEntries(Object.entries(a).filter(([k]) => !sp.derive!.fields.includes(k)));
      const err = schemaCheck(schema, a);
      if (err) return err;
      for (const k of sp.pathFields ?? []) if (a[k]!.split("/").includes("..")) return `bad path ${a[k]}`;
      if ("name" in a && (a.name!.includes("/") || a.name === "." || a.name === "..")) return "name must be a bare file name";
      return null;
    },
    footprint: sp.footprint,
    preconditions: sp.pre,
    execute: sp.run,
    ...(sp.undo ? { undo: sp.undo } : {}),
    ...(sp.check ? { undoCheck: sp.check } : {}),
    ...(sp.prep ? { prepareUndo: sp.prep } : {}),
    ...(sp.derive ? { derive: sp.derive.from } : {}),
  };
}

export const CRASH_FLAG = { crashAfterEffect: false };     // test hook: die after the effect, before the receipt
export const maybeCrash = () => { if (CRASH_FLAG.crashAfterEffect) throw new Crash("crash after the effect, before the receipt"); };

/** An undo may only touch paths still exactly as the action left them. */
export const untouched = (ws: Workspace, r: ExecResult, paths: string[]) => {
  const moved = paths.filter((q) => q in r.versions_after && ws.version(q) !== r.versions_after[q]);
  return moved.length ? `changed since the action: ${moved.join(", ")}` : null;
};

