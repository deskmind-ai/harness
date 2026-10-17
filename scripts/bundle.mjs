// One file for the app: `pnpm bundle` → dist/harness.mjs, run with the Node the app ships
// (openjev docs/design/harness-app-integration-2026-10-17.md §1). Checked with `node dist/harness.mjs --selftest`.
//
// Two things in the sources resolve files next to themselves with import.meta.url, which the bundle cannot:
//   - the base skill (src/runtime/loop.ts BASE_SKILL): its text is embedded here at bundle time, so the file is
//     not needed beside the binary;
//   - the Swift helper's source (src/registry/mac.ts): the app ships a prebuilt helper and points DESKMIND_MACTOOLS
//     at it, so the source path is never used there.
import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skill = fs.readFileSync(path.join(root, "skills", "deskmind-computer-use", "SKILL.md"), "utf-8").replace(/^---[\s\S]*?---\s*/, "");

const embedSkill = {
  name: "embed-base-skill",
  setup(build) {
    build.onLoad({ filter: /src[\\/]runtime[\\/]loop\.ts$/ }, (args) => {
      const src = fs.readFileSync(args.path, "utf-8");
      const needle = 'fs.existsSync(BASE_SKILL) ? body(fs.readFileSync(BASE_SKILL, "utf-8")) : ""';
      if (!src.includes(needle)) throw new Error("bundle: loop.ts no longer reads BASE_SKILL as expected; update scripts/bundle.mjs");
      return { contents: src.replace(needle, JSON.stringify(skill)), loader: "ts" };
    });
  },
};

await esbuild.build({
  entryPoints: [path.join(root, "src", "cli", "app.ts")],
  outfile: path.join(root, "dist", "harness.mjs"),
  bundle: true, platform: "node", format: "esm", target: "node22", sourcemap: false, legalComments: "none",
  plugins: [embedSkill],
  // ESM has no require(); a few dependencies still call it (esbuild's usual shim)
  banner: { js: 'import { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);' },
  logLevel: "info",
});
const size = fs.statSync(path.join(root, "dist", "harness.mjs")).size;
console.log(`dist/harness.mjs ${(size / 1024 / 1024).toFixed(2)} MB`);
