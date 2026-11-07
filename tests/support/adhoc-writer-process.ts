/**
 * Child process for the cross-process store-open regression: writes ad-hoc
 * notes through the real memory_remember path (each note opens its own store
 * connection) and reports every failure as JSON.
 *
 * argv: store root, result file, ready file, go file, tag, note count.
 * The ready/go handshake makes both writers enter the store together even when
 * process startup is slow, so the test never silently degenerates into a
 * serialized run.
 */
import { existsSync, writeFileSync } from "node:fs";

import { addAdHocNote } from "../../src/core/adhoc.js";

const [root, outFile, readyFile, goFile, tag, countRaw] = process.argv.slice(2) as [
  string,
  string,
  string,
  string,
  string,
  string,
];
writeFileSync(readyFile, "ready");
const spin = new Int32Array(new SharedArrayBuffer(4));
while (!existsSync(goFile)) {
  Atomics.wait(spin, 0, 0, 5);
}
const written: string[] = [];
const failures: string[] = [];
for (let i = 0; i < Number(countRaw); i += 1) {
  try {
    const note = await addAdHocNote(root, `${tag} note ${i} ${"x".repeat(120)}`, "remember");
    written.push(note.filename);
  } catch (error) {
    const err = error as Error & { code?: string };
    const frames = String(err.stack ?? "").split("\n").slice(1, 5).map((line) => line.trim());
    failures.push(`i=${i} ${err.name}[${err.code ?? ""}]: ${String(err.message)} @ ${frames.join(" | ")}`);
  }
}
writeFileSync(outFile, JSON.stringify({ written: written.length, failures }));
