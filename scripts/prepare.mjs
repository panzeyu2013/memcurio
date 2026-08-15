// Lightweight `prepare` (must run under plain node: `npm install -g
// github:...` executes prepare on user machines that may not have bun).
// Verifies committed build artifacts instead of building — dist/ is fully
// committed, so git-spec installs need no build step. Local development
// builds are explicit: `bun run build` (+ `bun run bundle:plugin`).
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const required = [
  "dist/cli/index.js",
  "dist/cli/index.d.ts",
  "dist/opencode-memcurio-plugin.js",
];

const missing = required.filter((rel) => !existsSync(join(repoRoot, rel)));

if (missing.length > 0) {
  console.warn(
    `memcurio: missing build artifacts: ${missing.join(", ")}\n` +
      "run `bun run build && bun run bundle:plugin` once for a source checkout",
  );
} else {
  console.log("memcurio: build artifacts verified");
}
