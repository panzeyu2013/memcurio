import { main } from "../src/cli/index.js";

/** Run the CLI in-process with stdout/stderr captured separately. Warnings
 *  (console.warn, e.g. clamping notes) are routed to `err` so tests can
 *  assert them and they do not leak to the test console. */
export async function runCli(...argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...a: unknown[]) => out.push(a.map(String).join(" "));
  console.error = (...a: unknown[]) => err.push(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => err.push(a.map(String).join(" "));
  try {
    const code = await main(argv);
    return { code, out: out.join("\n"), err: err.join("\n") };
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
}
