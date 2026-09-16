/**
 * Browser-artifact drift gate: `lib/client.js` is a committed build product, so
 * a source edit that skipped `bun run build:client` would ship a stale browser
 * half (the host serves this file verbatim). The check rebuilds the bundle in
 * memory through the exact production path and compares bytes.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { buildClientBundle } from "../scripts/build-client.js";

test("lib/client.js is the current esbuild output", async () => {
  const built = await buildClientBundle();
  const shipped = readFileSync(join(import.meta.dir, "..", "lib", "client.js"), "utf8");
  expect(shipped).toBe(built);
});
