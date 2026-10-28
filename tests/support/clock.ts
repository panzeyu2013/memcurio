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
