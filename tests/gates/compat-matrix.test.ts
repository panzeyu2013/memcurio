import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { SUPPORTED_HOSTS } from "../../scripts/compat-hosts.js";

const repoRoot = join(import.meta.dir, "..", "..");

/** The `dsh:` list under the `compat` job in ci.yml, in file order. */
function ciMatrixVersions(): string[] {
  const text = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
  const job = text.indexOf("\n  compat:");
  if (job < 0) throw new Error("ci.yml has no compat job");
  const rest = text.slice(job);
  const marker = "\n        dsh:";
  const at = rest.indexOf(marker);
  if (at < 0) throw new Error("compat job has no dsh matrix");
  const versions: string[] = [];
  for (const raw of rest.slice(at + marker.length).split("\n").slice(1)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const entry = /^-\s+(\S+)$/.exec(line);
    if (entry === null) break;
    versions.push(entry[1] as string);
  }
  return versions;
}

describe("compatibility matrix", () => {
  test("ci.yml samples exactly the hosts SUPPORTED_HOSTS names", () => {
    // One source for the release gate (--all) and CI (matrix); a silent drift
    // would let one lane test hosts the other never sees.
    expect(ciMatrixVersions()).toEqual([...SUPPORTED_HOSTS]);
  });
});
