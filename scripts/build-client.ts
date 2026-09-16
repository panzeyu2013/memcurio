// Browser-half build: esbuild bundles client/entry.ts into the official
// window.__ModuleLoader__.load({ id, factory }) artifact at lib/client.js.
//
// Externals mirror the frozen platform seed table (PLATFORM_MODULES in the
// dsh client shell): the loader serves exactly those specifiers from its seed
// table, and a third-party bundle may require nothing else. The bundle's
// @deepseek-ai/* imports are type-only by construction.
//
// Runs under node (CI) or bun (local): both execute the esbuild JS API.
// `buildClientBundle` is exported so tests can assert the committed artifact
// is exactly the current output (a stale lib/client.js would otherwise ship an
// old browser half without any gate noticing).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

import { PLATFORM_EXTERNALS } from "./platform-externals.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string };

/** Bundle the browser half in memory; returns the exact shipped bytes. */
export async function buildClientBundle(): Promise<string> {
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
  return `window.__ModuleLoader__.load({\n\tid: ${JSON.stringify(pkg.name)},\n\tfactory: (require) => {\n\t\tvar module = { exports: {} };\n\t\tvar exports = module.exports;\n${code}\n\t\treturn module.exports;\n\t}\n});\n`;
}

async function main(): Promise<void> {
  const wrapped = await buildClientBundle();
  mkdirSync(join(root, "lib"), { recursive: true });
  writeFileSync(join(root, "lib", "client.js"), wrapped);
  console.log("build-client ok: lib/client.js");
}

const invoked = (import.meta as { main?: boolean }).main === true
  || (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href);
if (invoked) await main();
