/**
 * M5-H: every judge question's material is in the trace (deskmind M5, the 过程 pane's judge view and its annotations):
 * one `judge.asked {judge_id, question_kind, prompt, options}` per question, before any tier is asked and with exactly
 * what the tiers were given; every `judge.answer` has one with its id. Trace only, never a protocol event; written whole
 * (the general 4000-char cut does not apply). Scripted models, no network.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ASKED_MAX, toProtocol, traceWriter } from "../src/cli/app.js";
import { Judge, OUTGOING_QUESTION } from "../src/executor/judge.js";
import type { Gateway } from "../src/gateway/index.js";

type Ev = [string, any];
const opts = [{ id: "sends", text: "会" }, { id: "stays", text: "不会" }];

/** A gateway that records every prompt it is given and answers by `reply`; `hang`: kept open until its signal fires. */
function recording(reply: () => unknown, o: { hang?: boolean } = {}) {
  const prompts: string[] = [];
  const gw = {
    ask: (_role: string, _sys: string, user: string, _schema: unknown, _run = "", signal?: AbortSignal) => {
      prompts.push(user);
      if (o.hang) return new Promise((res) => {
        const go = () => res({ outcome: "error", error: "aborted", data: null });
        if (signal?.aborted) go(); else signal?.addEventListener("abort", go, { once: true });
      });
      const r = reply();
      return Promise.resolve(r && typeof r === "object" && "outcome" in r ? r : { outcome: "answered", error: "", data: r });
    },
  };
  return { gw: gw as unknown as Gateway, prompts };
}

/** The pairing every row must keep: each answer has exactly one asked before it with its id; at most one asked per id. */
function paired(ev: Ev[]) {
  const asked = ev.filter(([k]) => k === "judge.asked").map(([, b]) => b.judge_id);
  expect(new Set(asked).size).toBe(asked.length);
  ev.forEach(([k, b], i) => {
    if (k !== "judge.answer") return;
    expect(ev.slice(0, i).filter(([k2, b2]) => k2 === "judge.asked" && b2.judge_id === b.judge_id)).toHaveLength(1);
  });
}

describe("M5-H: judge.asked", () => {
  it("the table: each way through a question says what it asked, before any tier, or nothing", async () => {
    // (path) -> the judge events in order
    const rows: { name: string; make: () => { j: Judge; prompts: () => string[] }; stop?: "before" | "during"; budget?: boolean; want: string[] }[] = [
      { name: "settled by the top tier", make: () => { const t = recording(() => ({ choice: "stays" })); return { j: new Judge([{ name: "frontier", gateway: t.gw }], {}), prompts: () => t.prompts }; },
        want: ["judge.asked", "judge.answer"] },
      { name: "settled by a lower tier, shadowed, sampled, raced", make: () => {
          const low = recording(() => ({ choice: "sends", scores: { sends: 0.99 } })), top = recording(() => ({ choice: "stays" }));
          return { j: new Judge([{ name: "brain", gateway: low.gw, floor: 0.9 }, { name: "frontier", gateway: top.gw }], { shadow: true, samples: true, race: true }), prompts: () => [...low.prompts, ...top.prompts] }; },
        want: ["judge.asked", "judge.sample", "judge.shadow", "judge.answer"] },
      { name: "every tier failed (gateway error)", make: () => { const t = recording(() => ({ outcome: "error", error: "boom" })); return { j: new Judge([{ name: "frontier", gateway: t.gw }], {}), prompts: () => t.prompts }; },
        want: ["judge.asked", "judge.tier_failed", "judge.answer"] },
      { name: "stopped before asking", stop: "before", make: () => { const t = recording(() => ({ choice: "stays" })); return { j: new Judge([{ name: "frontier", gateway: t.gw }], {}), prompts: () => t.prompts }; },
        want: [] },
      { name: "stopped while the tiers are asked", stop: "during", make: () => { const t = recording(() => null, { hang: true }); return { j: new Judge([{ name: "frontier", gateway: t.gw }], {}), prompts: () => t.prompts }; },
        want: ["judge.asked", "judge.tier_failed", "judge.stopped"] },
      { name: "the budget reached", budget: true, make: () => { const t = recording(() => ({ choice: "stays" })); return { j: new Judge([{ name: "frontier", gateway: t.gw }], { budget: 0 }), prompts: () => t.prompts }; },
        want: ["judge.budget"] },
    ];
    for (const row of rows) {
      const ev: Ev[] = [];
      const { j, prompts } = row.make();
      (j.opts as any).onEvent = (k: string, b: any) => ev.push([k, b]);
      const stop = new AbortController();
      if (row.stop === "before") stop.abort();
      const a = j.choose(OUTGOING_QUESTION, { window: "w1" }, opts, undefined, { signal: stop.signal });
      if (row.stop === "during") { await new Promise((r) => setTimeout(r, 5)); stop.abort(); }
      await a;
      const kinds = ev.map(([k]) => k).filter((k) => k.startsWith("judge.") && k !== "judge.escalate" && k !== "judge.raced");
      expect(kinds, row.name).toEqual(row.want);
      paired(ev);
      const asked = ev.find(([k]) => k === "judge.asked")?.[1];
      if (asked) {
        // exactly what every tier was given, from the one prompt; the options as asked; the kind as judge.answer says it
        expect(prompts().length, row.name).toBeGreaterThan(0);
        expect(prompts().every((p) => p === asked.prompt), row.name).toBe(true);
        expect(asked.options).toEqual(opts);
        expect(asked.judge_id).toMatch(/^jd_/);
        const end = ev.find(([k]) => k === "judge.answer" || k === "judge.stopped")![1];
        expect(end.judge_id).toBe(asked.judge_id);
        if (end.question_kind) expect(asked.question_kind).toBe(end.question_kind);
      } else {
        expect(prompts(), row.name).toHaveLength(0);
      }
    }
  });

  it("a cached question asks nothing and says nothing", async () => {
    const ev: Ev[] = [];
    const t = recording(() => ({ choice: "stays" }));
    const j = new Judge([{ name: "frontier", gateway: t.gw }], { onEvent: (k, b) => ev.push([k, b]) });
    await j.choose(OUTGOING_QUESTION, { window: "w1" }, opts);
    expect((await j.choose(OUTGOING_QUESTION, { window: "w1" }, opts))!.cached).toBe(true);
    expect(ev.filter(([k]) => k === "judge.asked")).toHaveLength(1);
    expect(t.prompts).toHaveLength(1);
  });

  it("is never a protocol event", () => {
    expect(toProtocol("judge.asked", { judge_id: "jd_1", question_kind: "outgoing", prompt: "p", options: opts })).toBeNull();
  });

  it("the trace keeps it whole past the general cut; past ASKED_MAX it is cut and says so", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m5h-"));
    const file = path.join(dir, "trace.jsonl");
    const w = traceWriter(file);
    w("judge.asked", { judge_id: "jd_1", question_kind: "outgoing", prompt: "p".repeat(20000), options: opts });
    w("judge.sample", { prompt: "p".repeat(20000) });
    w("judge.asked", { judge_id: "jd_2", question_kind: "outgoing", prompt: "p".repeat(ASKED_MAX + 10), options: opts });
    w("judge.asked", { judge_id: "jd_3", question_kind: "outgoing", prompt: "short", options: opts });
    const lines = fs.readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines[0].prompt).toHaveLength(20000);
    expect(lines[0].cut).toBeUndefined();
    expect(lines[1].prompt.length).toBeLessThan(4100);                 // everything else: the 4000-char rule
    expect(lines[2].cut).toBe(true);
    expect(lines[2].prompt.startsWith("p".repeat(ASKED_MAX))).toBe(true);
    expect(lines[2].prompt).toContain("…(+10)");
    expect(lines[3].cut).toBeUndefined();                              // (a cut line before does not mark the next)
  });
});
