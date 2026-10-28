/**
 * Coverage gate: run the suite once with coverage and enforce the floor.
 *
 * Bun has no threshold flag, so this wrapper parses the text reporter's
 * summary row. The floor is a ratchet, not a target: raise it when the suite
 * improves, never lower it to make a change pass.
 *
 * Deliberately serial (--isolate, no --parallel): parallel workers under-report
 * the merged coverage table (measured 89.6% lines vs 95.9% serial), which would
 * spuriously fail the floor.
 */
import { spawnSync } from "node:child_process";

const MIN_FUNCS = 90;
const MIN_LINES = 93;

const result = spawnSync(
  process.execPath,
  ["test", "--isolate", "--coverage", "--coverage-reporter=text"],
  { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (text: string): string => text.replace(ANSI, "");
const stdout = stripAnsi(result.stdout ?? "");
const stderr = stripAnsi(result.stderr ?? "");
process.stdout.write(stdout);
process.stderr.write(stderr);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

// Bun writes the coverage table to stderr; test results share that stream.
const report = `${stderr}\n${stdout}`;
const summary = /^All files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/m.exec(report);
if (!summary) {
  console.error("coverage gate: the text reporter has no 'All files' row");
  process.exit(1);
}
const funcs = Number(summary[1]);
const lines = Number(summary[2]);
console.log(`coverage gate: functions ${funcs}% (min ${MIN_FUNCS}%), lines ${lines}% (min ${MIN_LINES}%)`);
if (funcs < MIN_FUNCS || lines < MIN_LINES) {
  console.error("coverage gate: below the configured floor");
  process.exit(1);
}
