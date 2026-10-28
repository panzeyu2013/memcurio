/**
 * Shared asynchronous test helpers.
 *
 * Fixed sleeps are only acceptable when the target really is a delay (a
 * retry backoff, a lock hold). Waiting for a detached side effect must poll a
 * predicate instead, so a loaded CI runner cannot turn it into a flake.
 *
 * Test-only module; never imported by shipped code.
 */

/** Resolve after `ms` milliseconds (only for real delays, never for ordering). */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll `predicate` until it is true, or throw once the deadline passes. */
export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(intervalMs);
  }
  throw new Error("waitFor timed out");
}

/** The `/events` (SSE) calls of a recorded fetch log. */
export function eventCalls(calls: readonly string[]): string[] {
  return calls.filter((call) => call.includes("/events"));
}
