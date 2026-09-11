// Lightweight `prepare` (must run under plain node: `npm install -g
// github:...` executes prepare on user machines that may not have bun).
// Verifies committed build artifacts instead of building — dist/ is fully
// committed, so git-spec installs need no build step. Local development
// builds are explicit: `bun run build`.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const required = [
  "dist/plugin/index.js",
  "dist/plugin/index.d.ts",
  "dist/engine.js",
  "lib/client.js",
];

const missing = required.filter((rel) => !existsSync(join(repoRoot, rel)));

if (missing.length > 0) {
  console.warn(
    `memcurio: missing build artifacts: ${missing.join(", ")}\n` +
      "run `bun run build` once for a source checkout",
  );
} else {
  console.log("memcurio: build artifacts verified");
}
