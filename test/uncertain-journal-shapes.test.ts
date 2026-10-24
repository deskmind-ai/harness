/** Journal shapes on restart (the reviewer's, adopted as they were): the uncertain list equals the result card's unsure consent steps,
 *  for handcrafted journals, after 1..3 restarts. Copy into test/ of a worktree and run with vitest. */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { expect, it } from "vitest";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { stepLines } from "../src/executor/possibly.js";
import { SimComputer } from "../src/executor/sim.js";

const click = (n: string) => ({ kind: "click", window: "w", target: n });
const I = (n: string, c = "modify_user") => JSON.stringify({ t: 1, kind: "intent", action: click(n), object: "window:w", consequence: c, text: `点 ${n}` });
const R = (s: string, extra = {}) => JSON.stringify({ t: 1, kind: "receipt", status: s, seq: 1, ...extra });
const shapes: Record<string, [string, string[]]> = {
  "crash mid-step": [[I("A")].join("\n") + "\n", ["点 A"]],
  "torn receipt": [I("A") + "\n" + R("ok").slice(0, 25), ["点 A"]],
  "torn intent (never acted)": [I("A") + "\n" + R("ok") + "\n" + I("B").slice(0, 30), []],
  "receipt after the next intent": [[I("A"), I("B"), R("ok")].join("\n") + "\n", ["点 A"]],
  "unverified, then crash": [[I("A", "external"), R("unverified"), I("B")].join("\n") + "\n", ["点 A", "点 B"]],
  "performed:false and create are off": [[I("A"), R("blocked", { performed: false }), I("B", "create")].join("\n") + "\n", []],
};
for (const [name, [raw, want]] of Object.entries(shapes)) {
  it(name, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rv9-shape-")), journal = path.join(dir, "j.jsonl");
    fs.writeFileSync(journal, raw);
    const app = ConsentSigner.fresh();
    for (let i = 0; i < 3; i++) {
      const ex = new Executor(new SimComputer(), { task: "t1", publicKey: app.publicKey, journal });
      await ex.begin();
      const card = stepLines(ex.possiblySteps().filter((s) => s.consequence === "modify_user" || s.consequence === "external")).unsure;
      const list = ex.uncertainSteps().map((s) => s.text);
      expect(list).toEqual(card);
      expect(list).toEqual(want);
    }
  });
}
