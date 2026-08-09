import { mkdirSync } from "node:fs";
import { join } from "node:path";

const outDir = join(import.meta.dir, "..", "dist");
mkdirSync(outDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(import.meta.dir, "..", "src", "adapters", "opencode", "plugin.ts")],
  outdir: outDir,
  target: "bun",
  naming: "opencode-memcurio-plugin.js",
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

console.log(`bundled -> ${join(outDir, "opencode-memcurio-plugin.js")}`);
