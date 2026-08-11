import { existsSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "..");
const distRoot = join(repoRoot, "dist");

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

const expectedDist = new Set<string>(["dist/opencode-memcurio-plugin.js"]);
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
const packed = output
  .split("\n")
  .map((line) => line.match(/^packed\s+\S+\s+(.+)$/)?.[1])
  .filter((path): path is string => Boolean(path));
const allowed = /^(?:package\.json|README\.md|CONTRIBUTING\.md|LICENSE|dist\/|docs\/)/;
const unexpectedPackageFiles = packed.filter((path) => !allowed.test(path));
if (unexpectedPackageFiles.length) {
  throw new Error(`unexpected files in package: ${unexpectedPackageFiles.join(", ")}`);
}

console.log(`pack check passed: ${packed.length} files; dist is clean and package allowlist holds`);
