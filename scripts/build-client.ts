// Browser-half build: esbuild bundles client/entry.ts into the official
// window.__ModuleLoader__.load({ id, factory }) artifact at lib/client.js.
//
// Externals mirror the frozen platform seed table (PLATFORM_MODULES in the
// dsh client shell): the loader serves exactly those specifiers from its seed
// table, and a third-party bundle may require nothing else. The bundle's
// @deepseek-ai/* imports are type-only by construction.
//
// Runs under node (CI) or bun (local): both execute the esbuild JS API.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

import { PLATFORM_EXTERNALS } from "./platform-externals.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string };

const result = await build({
  entryPoints: [join(root, "client", "entry.ts")],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  external: [...PLATFORM_EXTERNALS],
  sourcemap: false,
  minify: false,
  logLevel: "warning",
  write: false,
  outfile: join(root, "lib", "client.js"),
});

const output = result.outputFiles?.[0];
if (!output) throw new Error("esbuild produced no output");
const code = output.text;
const wrapped = `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${code}\n\t\treturn module.exports;\n\t}\n});\n`;
mkdirSync(join(root, "lib"), { recursive: true });
writeFileSync(join(root, "lib", "client.js"), wrapped);
console.log("build-client ok: lib/client.js");
