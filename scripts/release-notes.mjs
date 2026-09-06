#!/usr/bin/env node
/**
 * Compose GitHub Release notes from the CHANGELOG section of one version
 * (release-workflow gate). Usage:
 *
 *   node scripts/release-notes.mjs <version> --out <path>
 *
 * Fails when the section is missing, empty or undated, so a release can
 * never ship without notes.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const versionArg = args.find((arg) => !arg.startsWith("--"));
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : undefined;

if (!versionArg || !outPath) {
  console.error("usage: node scripts/release-notes.mjs <version> --out <path>");
  process.exit(2);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

const heading = new RegExp(`^## \\[${versionArg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]\\s+-\\s+(.+)$`, "m");
const match = heading.exec(changelog);
if (!match) {
  console.error(`release-notes: CHANGELOG has no dated section for [${versionArg}]`);
  process.exit(1);
}

const start = changelog.indexOf("\n", match.index) + 1;
const rest = changelog.slice(start);
const nextHeading = /^##\s/m.exec(rest);
const body = (nextHeading ? rest.slice(0, nextHeading.index) : rest).trim();

if (!body) {
  console.error(`release-notes: section [${versionArg}] is empty`);
  process.exit(1);
}

const notes = `# memcurio v${versionArg}\n\n> Released from the CHANGELOG section dated ${match[1]}.\n\n${body}\n`;
writeFileSync(outPath, notes, "utf8");
console.log(`release notes written: ${outPath} (${notes.length} chars)`);
