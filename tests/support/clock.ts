/**
 * Clock-independent fixtures.
 *
 * Selection windows and retention math are measured against Date.now(), so a
 * hard-coded calendar date silently ages out of the window. Tests that feed
 * such logic must derive timestamps from these helpers instead.
 *
 * Test-only module; never imported by shipped code.
 */

const DAY_MS = 86_400_000;

/** ISO timestamp N whole days before the current wall clock. */
export function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/** Run `work` with `TZ` pinned to `zone`, then restore the process zone.
 *  Restoring `TZ=undefined` is not enough: bun parses and caches the zone when
 *  it first sees a concrete value, so the pinned zone would leak into every
 *  later test file of the same process (and --isolate does not help: the
 *  process-level state is shared). Restoring the zone that was resolved before
 *  the call keeps later files on the calendar they started with. */
export function withTimeZone<T>(zone: string, work: () => T): T {
  const previous = process.env.TZ;
  const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone;
  process.env.TZ = zone;
  try {
    return work();
  } finally {
    process.env.TZ = previous ?? resolved;
  }
}
