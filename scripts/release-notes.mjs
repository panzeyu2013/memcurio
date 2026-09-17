#!/usr/bin/env node
/**
 * Compose GitHub Release notes from the CHANGELOG section of one version
 * (release-workflow gate). Usage:
 *
 *   node scripts/release-notes.mjs <version> --out <path> [--changelog <path>]
 *
 * Selection order:
 *   1. the dated `## [<version>] - <date>` section (preferred);
 *   2. otherwise a non-empty `## [Unreleased]` block, so notes cannot lag the
 *      tree while the version heading has not been renamed yet;
 *   3. otherwise fail — an empty pair must never produce notes.
 *
 * A non-empty [Unreleased] next to a dated section emits a lag warning: the
 * release still uses the dated section, and prep should fold [Unreleased] in.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const versionArg = args.find((arg) => !arg.startsWith("--"));
const flagValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const outPath = flagValue("--out");
const changelogArg = flagValue("--changelog");

if (!versionArg || !outPath) {
  console.error("usage: node scripts/release-notes.mjs <version> --out <path> [--changelog <path>]");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const changelog = readFileSync(changelogArg ?? join(root, "CHANGELOG.md"), "utf8");

/** Body of a `## <heading>` section; undefined when the heading is absent. */
function section(heading) {
  const match = heading.exec(changelog);
  if (!match) return undefined;
  const start = changelog.indexOf("\n", match.index) + 1;
  const rest = changelog.slice(start);
  const nextHeading = /^##\s/m.exec(rest);
  return { label: match[1], body: (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim() };
}

const escaped = versionArg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const dated = section(new RegExp(`^## \\[${escaped}\\]\\s+-\\s+(.+)$`, "m"));
const unreleased = section(/^## \[Unreleased\]\s*$/m);

let notes;
if (dated?.body) {
  if (unreleased?.body) {
    console.warn(
      `release-notes: [Unreleased] is non-empty but NOT part of the [${versionArg}] notes — fold it into the dated section before tagging`,
    );
  }
  notes = `# memcurio v${versionArg}\n\n> Released from the CHANGELOG section dated ${dated.label}.\n\n${dated.body}\n`;
} else if (unreleased?.body) {
  notes = `# memcurio v${versionArg}\n\n> Composed from the CHANGELOG [Unreleased] section (no dated [${versionArg}] section in the tree yet).\n\n${unreleased.body}\n`;
  console.warn(
    `release-notes: no dated [${versionArg}] section; using the [Unreleased] block as the release notes`,
  );
} else {
  const reason = dated ? `section [${versionArg}] is empty` : `CHANGELOG has no dated section for [${versionArg}]`;
  console.error(`release-notes: ${reason} and [Unreleased] is empty — prepare the release section first`);
  process.exit(1);
}

writeFileSync(outPath, notes, "utf8");
console.log(`release notes written: ${outPath} (${notes.length} chars)`);
