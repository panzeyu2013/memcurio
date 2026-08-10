import { chmodSync } from "node:fs";
import { fileURLToPath } from "node:url";

// tsc emits dist/cli/index.js without the executable bit; npm restores 0755
// on install, but a checked-out dist (or `bun run build` alone) would leave
// the bin unusable. Make the bit explicit here instead of relying on npm.
chmodSync(fileURLToPath(new URL("../dist/cli/index.js", import.meta.url)), 0o755);
