/**
 * What a capability is: one self-contained object that declares itself to the model (description, input schema with
 * described fields, effect class) and to the runtime (which paths an action reads and writes, the preconditions, the
 * versions it should leave, the executor). The orchestrator never switches on a capability's id; it calls these.
 *
 * Capabilities arrive through a Registry. Today they are built in code (`fs/*`). The 2.0 design's `build_capability`
 * path (a Teacher proposes a new capability, it is validated in a sandbox and registered as an immutable version) only
 * needs a loader that produces objects of this shape and runs `contract()` before `register()`; nothing in the
 * orchestrator changes.
 */
import type { Workspace } from "./workspace.js";

export type Effect = "observe" | "create" | "update" | "delete" | "external";
export type Channel = "filesystem" | "gui" | "api" | "compute";
export type Args = Record<string, string>;

export interface FieldSchema { type: "string"; minLength?: number; description: string }
export interface InputSchema { type: "object"; properties: Record<string, FieldSchema>; required: string[]; additionalProperties: false }

/** The declarative footprint of one action: what it touches and what it should leave. */
export interface Footprint {
  reads: string[];
  writes: string[];
  /** path -> expected version afterwards ("absent", a digest, or "dir:*" for any folder). Used to confirm a receipt
   *  and to reconcile a lost one. */
  expectAfter: Record<string, string>;
}

/** `undo` holds what the capability needs to take the action back (kept in the receipt, never shown to models). */
export interface ExecResult { status: string; output: Record<string, unknown>; versions_after: Record<string, string>; why?: string; undo?: Record<string, unknown> }

export interface Capability {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly schema: InputSchema;
  readonly effect: Effect;
  readonly channel: Channel;
  /** Consequential: the user approves the exact action before it runs. */
  readonly requiresConfirmation: boolean;
  /** A wrong run of this action can be undone without loss (create, move, copy, append). Replacing a whole file,
   *  deleting or sending cannot. Decides whether an action taken on the model's reading of an ambiguous request may
   *  go ahead and be reported, or must be shown to the user first (docs/ask-policy.md). */
  readonly reversible: boolean;
  /** Take a finished action back from its receipt. Refuses (returns the reason) when a written path changed since
   *  the receipt, so an undo never destroys someone else's later work. Required when reversible and not observe. */
  undo?(ws: Workspace, args: Args, receipt: ExecResult): string | null;
  /** The action discards existing content of a written path (replace, trash). Overwriting content this run did not
   *  write then needs the user's approval; an append or a move does not discard anything. */
  readonly discards?: boolean;
  /** Set on a renamed variant: variant field -> base field. The runtime maps before calling the implementation. */
  readonly rename?: Record<string, string>;
  /** Argument checks beyond the schema (paths without '..', bare file names). Returns an error or null. */
  typecheck(args: Args): string | null;
  footprint(ws: Workspace, args: Args): Footprint;
  preconditions(ws: Workspace, args: Args): string | null;
  execute(ws: Workspace, args: Args): ExecResult;
}

export class Crash extends Error {}

/** A capability's self-description for prompts: never the implementation. */
export const describeCapability = (c: Capability) => ({ id: c.id, description: c.description, effect: c.effect, input: c.schema.properties, required: c.schema.required });

export const toBase = (c: Capability, args: Args): Args =>
  c.rename ? Object.fromEntries(Object.entries(args).map(([k, v]) => [c.rename![k] ?? k, v])) : { ...args };

/** The same implementation under other field names (the descriptions carry the meaning). */
export function renamed(c: Capability, map: Record<string, string>, suffix = ".alt"): Capability {
  const properties: Record<string, FieldSchema> = {};
  for (const [nu, old] of Object.entries(map)) {
    const f = c.schema.properties[old];
    if (!f) throw new Error(`${c.id} has no field ${old}`);
    properties[nu] = f;
  }
  const schema: InputSchema = { type: "object", properties, required: Object.keys(properties), additionalProperties: false };
  const base = c;
  const inv = (a: Args) => Object.fromEntries(Object.entries(a).map(([k, v]) => [map[k] ?? k, v]));
  return {
    id: c.id + suffix, version: c.version, description: c.description, schema, effect: c.effect, channel: c.channel, requiresConfirmation: c.requiresConfirmation, reversible: c.reversible, discards: c.discards, rename: map,
    typecheck: (a) => schemaCheck(schema, a) ?? base.typecheck(inv(a)),
    footprint: (ws, a) => base.footprint(ws, inv(a)),
    preconditions: (ws, a) => base.preconditions(ws, inv(a)),
    execute: (ws, a) => base.execute(ws, inv(a)),
    ...(base.undo ? { undo: (ws: Workspace, a: Args, r: ExecResult) => base.undo!(ws, inv(a), r) } : {}),
  };
}

/** The checks every capability shares: required fields present, strings, non-empty where the schema says so. */
export function schemaCheck(schema: InputSchema, args: Args): string | null {
  const extra = Object.keys(args).filter((k) => !(k in schema.properties));
  if (extra.length) return `unexpected arguments ${JSON.stringify(extra)}`;
  for (const k of schema.required) if (!(k in args)) return `missing argument ${k}`;
  for (const [k, v] of Object.entries(args)) {
    if (typeof v !== "string") return `${k} must be a string`;
    if (schema.properties[k]!.minLength && !v) return `${k} is empty`;
  }
  return null;
}

export class Registry {
  private readonly caps = new Map<string, Capability>();

  register(c: Capability): this {
    const err = contract(c);
    if (err) throw new Error(`capability ${c.id}@${c.version} fails its contract: ${err}`);
    if (this.caps.has(c.id)) throw new Error(`capability ${c.id} already registered (versions are immutable; register a new id or version)`);
    this.caps.set(c.id, c);
    return this;
  }

  get(id: string): Capability | undefined {
    return this.caps.get(id);
  }

  has(id: string) {
    return this.caps.has(id);
  }

  list(): Capability[] {
    return [...this.caps.values()];
  }

  /** A registry with some capabilities replaced by renamed variants (the dynamic-schema evaluation group). */
  withRenamed(renames: Record<string, Record<string, string>>): Registry {
    const r = new Registry();
    for (const c of this.list()) r.register(renames[c.id] ? renamed(c, renames[c.id]!) : c);
    return r;
  }

  toRecord(): Record<string, Capability> {
    return Object.fromEntries(this.caps);
  }
}

/** Static contract a capability must meet to be registered: the model-facing part is complete and consistent. */
export function contract(c: Capability): string | null {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(c.id)) return "id must look like channel.name";
  if (!c.version) return "version is empty";
  if (c.description.length < 8) return "description too short for a model to choose by";
  if (c.schema.type !== "object" || c.schema.additionalProperties !== false) return "schema must be a closed object";
  for (const [k, f] of Object.entries(c.schema.properties)) if (!f.description || f.description.length < 4) return `field ${k} has no description`;
  for (const k of c.schema.required) if (!(k in c.schema.properties)) return `required field ${k} is not a property`;
  for (const m of ["typecheck", "footprint", "preconditions", "execute"] as const) if (typeof c[m] !== "function") return `${m} missing`;
  if (typeof c.reversible !== "boolean") return "reversible must be declared";
  if (c.reversible && c.effect !== "observe" && typeof c.undo !== "function") return "reversible but has no undo";
  return null;
}
