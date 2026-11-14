/**
 * Lockfile closure gate: the development host must be the single supported DSH
 * version, and the Cordis ecosystem must move with it. An incremental
 * `bun install` on an old lockfile keeps the stale peer closure (cordis-plugin-
 * group/include and a nested cosmokit), while every unit test can still pass;
 * this check fails loudly instead.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const lock = readFileSync(join(root, "bun.lock"), "utf8");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  devDependencies?: Record<string, string>;
};

/** `@deepseek-ai/dsh-*` versions the manifest pins (the supported host line). */
function manifestDshVersions(): string[] {
  return [
    ...new Set(
      Object.entries(manifest.devDependencies ?? {})
        .filter(([name]) => name.startsWith("@deepseek-ai/dsh-"))
        .map(([, version]) => version),
    ),
  ].sort();
}

/** Every resolved version token of one package in the lockfile (all entries, not just the first). */
function versionsOf(pkg: string): string[] {
  const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...lock.matchAll(new RegExp(`"@deepseek-ai/${escaped}@([^"]+)"`, "g"))].map((match) => match[1] as string);
}

test("every dsh package in the lockfile is the manifest's supported host version", () => {
  const lockVersions = [...new Set([...lock.matchAll(/@deepseek-ai\/dsh-[a-z0-9-]+@([^"\s,]+)/g)].map((match) => match[1] as string))];
  expect(lockVersions.length).toBeGreaterThan(0);
  expect(lockVersions.sort()).toEqual(manifestDshVersions());
});

test("the cordis ecosystem in the lockfile matches the supported host", () => {
  const expected: Record<string, string> = {
    cordis: "4.1.0",
    "cordis-plugin-loader": "1.1.0",
    "cordis-plugin-group": "1.1.0",
    "cordis-plugin-include": "1.1.0",
    schemastery: "3.19.0",
    cosmokit: "1.9.0",
  };
  for (const [pkg, version] of Object.entries(expected)) {
    expect([pkg, [...new Set(versionsOf(pkg))]]).toEqual([pkg, [version]]);
  }
});

test("the lockfile carries no version from an older host line", () => {
  for (const stale of [
    "0.2.2-alpha.",
    "0.2.2-rc.1",
    "0.2.2-rc.2",
    "0.2.0-rc.",
    "0.2.1-rc.",
    "4.0.6-alpha.",
    "1.0.7-alpha.",
    "1.0.6-alpha.",
    "1.0.11-alpha.",
    "3.18.6-alpha.",
    "1.8.7-alpha.",
  ]) {
    expect([stale, lock.includes(stale)]).toEqual([stale, false]);
  }
});
