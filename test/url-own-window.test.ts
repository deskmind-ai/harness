/**
 * rc.10, "搜索今天北京天气": 9 consent cards and 11 stales for a task that only searched the user's own words.
 *  - every card was the "user's window" floor on an open_window with a url, while the driver (hands since #48) loads
 *    urls only in the task's own window: a driver that promises so (capabilities.urlInOwnWindow) makes it the task's
 *    step; the per-site rule (#33) is left as it is;
 *  - 8 of the 11 stales were actions that read no observation (wait, open_window) held stale on a title that settled
 *    or a helper window that came and went: only an action that reads the observation goes stale on an epoch change.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { ConsentSigner } from "../src/executor/consent.js";
import { Executor } from "../src/executor/executor.js";
import { SimComputer } from "../src/executor/sim.js";
import { Workspace, build } from "../src/registry/workspace.js";
import { fileRegistry } from "../src/registry/fs.js";

/** The sim desktop with hands' promise: a url opens in a window of the task's own (the sim always opens a new one). */
class OwnWindowSim extends SimComputer { readonly capabilities = { urlInOwnBrowserWindow: true }; }

const google = (q: string) => "https://www.google.com/search?q=" + encodeURIComponent(q);

const setup = async (Desk: typeof SimComputer = OwnWindowSim) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "own-window-")); build(root, { "合同.txt": "合同金额 98000 元\n" });
  const sim = new Desk(root);
  const theirs = sim.addBrowser("Google Chrome", [{ title: "收件箱 - Gmail", url: "https://mail.google.com" }]).id;
  const app = ConsentSigner.fresh(), events: string[] = [];
  const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey, raw: "搜索今天北京天气", files: { workspace: new Workspace(root), registry: fileRegistry() }, onEvent: (k) => events.push(k) });
  await ex.begin(); await ex.plan({ steps: [] });
  const open = (url?: string, epoch = ex.currentEpoch) => ex.act({ action: { kind: "open_window", app: "Google Chrome", ...(url ? { url } : {}) }, epoch });
  return { ex, sim, theirs, events, open };
};

describe("A: a url opens in the task's own window when the driver promises so", () => {
  it("with the promise, a url with the user's browser open is the task's step — no plan, no card — on the task's window", async () => {
    const { ex, theirs, events, open } = await setup();
    const mine = (await open()).after!.window.id;                     // the task's own Chrome window, as in rc.10
    await ex.snapshot();
    const f = ex.floor({ kind: "open_window", app: "Google Chrome", url: google("今天北京天气") });
    expect([f.consequence, f.object]).toEqual(["create", `window:${mine}`]);
    const r = await open(google("今天北京天气"));
    expect([r.status, r.consequence]).toEqual(["ok", "create"]);
    expect(events.includes("executor.consent_needed")).toBe(false);
    expect(ex.ledger.ownerOf(`window:${theirs}`)).toBe("user");
  });

  it("without the promise, the old floor stands: a url with the user's browser open is a change to their window", async () => {
    const { ex, theirs } = await setup(SimComputer);
    expect(ex.floor({ kind: "open_window", app: "Google Chrome", url: google("今天北京天气") })).toMatchObject({ consequence: "modify_user", object: `window:${theirs}` });
  });

  it("only in a browser: with the promise, a url handed to another app the user has open still lands in their window", async () => {
    const { ex, sim } = await setup();
    const editor = sim.addEditor("编辑器").id;                          // the user's own, not a browser (no browser flag)
    await ex.snapshot();
    expect(ex.floor({ kind: "open_window", app: "编辑器", url: "x-editor://doc/1" })).toMatchObject({ consequence: "modify_user", object: `window:${editor}` });
  });

  it("the per-site rule is untouched: after a file read, an unapproved host is still a send", async () => {
    const { ex, open } = await setup();
    await ex.act({ action: { kind: "file", capability: "fs.read_text", args: { target: "合同.txt" } }, epoch: ex.currentEpoch });
    const r = await open(google("今天北京天气"));
    expect([r.status, r.consequence, r.challenge?.site]).toEqual(["needs_consent", "external", "www.google.com"]);
  });
});

describe("C: only an action that reads the observation, or needs consent, goes stale on an epoch change", () => {
  it("closing the user's window with their consent, decided before the epoch moved, is stale: the window stays", async () => {
    const sim = new SimComputer(), app = ConsentSigner.fresh();
    const theirs = sim.addEditor("编辑器").id;
    const ex = new Executor(sim, { task: "t1", publicKey: app.publicKey });
    const s = await ex.begin(); await ex.plan({ steps: [] });
    const consent = app.forObject(`window:${theirs}`, "modify_user", "t1");
    sim.epoch += 3;                                                   // the user edited the window since the card
    const r = await ex.act({ action: { kind: "close_window", window: theirs }, epoch: s.epoch, consent });
    expect([r.status, r.consequence]).toEqual(["stale", "modify_user"]);
    expect(sim.snapshot().windows.some((w) => w.id === theirs)).toBe(true);
  });


  it("open_window, focus_window and wait decided before the epoch moved still go; a click on the old look is refused", async () => {
    const { ex, sim, open } = await setup();
    const first = await open();
    const mine = first.after!.window.id, old = first.after!.epoch;
    const button = first.after!.elements.find((e) => e.actions.includes("click"))!;
    sim.epoch += 1;                                                   // a title settled, a helper window came and went
    expect((await open(google("今天北京天气"), old)).status).toBe("ok");
    expect((await ex.act({ action: { kind: "focus_window", window: mine }, epoch: old })).status).toBe("ok");
    expect((await ex.act({ action: { kind: "wait", ms: 1 }, epoch: old })).status).toBe("ok");
    sim.epoch += 1;
    expect((await ex.act({ action: { kind: "click", window: mine, target: button.id }, epoch: old })).status).toBe("stale");
  });
});
