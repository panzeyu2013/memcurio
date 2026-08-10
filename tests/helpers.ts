import { main } from "../src/cli/index.js";

/** Stringify a stdout/stderr chunk: strings pass through, Buffers decode. */
function chunkText(chunk: unknown): string {
  return chunk instanceof Uint8Array ? new TextDecoder().decode(chunk) : String(chunk);
}

/** Run the CLI in-process with stdout/stderr captured separately. Warnings
 *  (console.warn, e.g. clamping notes) are routed to `err` so tests can
 *  assert them and they do not leak to the test console. Captures
 *  process.stdout/stderr.write too (cmdExport writes the stream directly). */
export async function runCli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  const origStdout = process.stdout.write;
  const origStderr = process.stderr.write;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => err.push(a.map(String).join(" "));
  process.stdout.write = ((chunk: unknown) => {
    out.push(chunkText(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    err.push(chunkText(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }
}
