import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { PLATFORM_EXTERNALS } from "./platform-externals.js";
import { parsePackedPaths } from "./pack-output.js";

const repoRoot = resolve(import.meta.dir, "..");
const distRoot = join(repoRoot, "dist");

function pkgName(): string {
  return JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).name as string;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(path);
      } else {
        out.push(relative(repoRoot, path).replaceAll("\\", "/"));
      }
    }
  };
  walk(dir);
  return out.sort();
}

const expectedDist = new Set<string>();
for (const source of filesUnder(join(repoRoot, "src"))) {
  if (!source.endsWith(".ts")) {
    continue;
  }
  const stem = source.slice(0, -3);
  expectedDist.add(`${stem}.js`.replace(/^src\//, "dist/"));
  expectedDist.add(`${stem}.d.ts`.replace(/^src\//, "dist/"));
}
const unexpectedDist = filesUnder(distRoot).filter((file) => !expectedDist.has(file));
if (unexpectedDist.length) {
  throw new Error(`unexpected build files in dist/: ${unexpectedDist.join(", ")}`);
}
// Reverse check: a tsc config change could silently stop emitting a module
// without leaving any unexpected file behind. Every expected artifact must
// actually exist in dist/.
const missingDist = [...expectedDist].filter((file) => !existsSync(join(repoRoot, file)));
if (missingDist.length) {
  throw new Error(`missing build files in dist/: ${missingDist.join(", ")}`);
}

const result = Bun.spawnSync([process.execPath, "pm", "pack", "--dry-run", "--ignore-scripts"], {
  cwd: repoRoot,
  stdout: "pipe",
  stderr: "pipe",
});
if (result.exitCode !== 0) {
  throw new Error(new TextDecoder().decode(result.stderr));
}
const output = new TextDecoder().decode(result.stdout);
const packed = parsePackedPaths(output);
const allowed = /^(?:package\.json|README\.md|LICENSE|cordis\.patch\.yml|dist\/.*|lib\/client\.js)$/;
// The browser half ships prebuilt: the loader artifact must exist, wear the
// official factory shape, and carry the package id the host discovers.
const clientBundle = join(repoRoot, "lib", "client.js");
if (!existsSync(clientBundle)) {
  throw new Error("missing browser artifact: lib/client.js (run `bun run build:client`)");
}
const bundle = readFileSync(clientBundle, "utf8");
if (!bundle.includes("window.__ModuleLoader__.load({") || !bundle.includes(JSON.stringify(pkgName()))) {
  throw new Error("lib/client.js is not a __ModuleLoader__ artifact for this package name");
}
if (!/return module\.exports;/.test(bundle)) {
  throw new Error("lib/client.js factory does not return module.exports");
}
// Require purity: the loader serves ONLY the frozen platform seed table, so a
// value import of any other package would throw at runtime with no other gate
// noticing. Every `require("…")` specifier must be a seed module.
const required = [...bundle.matchAll(/require\("([^"]+)"\)/g)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
const notSeeded = [...new Set(required)].filter((specifier) => !PLATFORM_EXTERNALS.includes(specifier));
if (notSeeded.length > 0) {
  throw new Error(`lib/client.js requires non-platform modules: ${notSeeded.join(", ")}`);
}
const unexpectedPackageFiles = packed.filter((path) => !allowed.test(path));
if (unexpectedPackageFiles.length) {
  throw new Error(`unexpected files in package: ${unexpectedPackageFiles.join(", ")}`);
}

console.log(`pack check passed: ${packed.length} files; dist is clean and package allowlist holds`);
