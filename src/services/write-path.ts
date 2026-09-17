/**
 * Write-path classification of audit actions.
 *
 * Shared by the host bridge (which only projects write-path audit rows into
 * browser receipts) and the snapshot service (which flags receipt rows), so
 * the two host consumers can never drift apart.
 *
 * The browser bundle keeps its own copy in `client/ui/model.ts`: the built
 * client may require nothing but react, so it cannot import this module.
 * `tests/write-path.test.ts` pins both copies to the same behavior.
 *
 * @module
 */

/** Write-path action prefixes: only these mutate durable memory. Actions
 *  outside them (adapter.*, integration.*, warn.*) are lifecycle noise. */
export const WRITE_PATH_PREFIXES = ["extract.", "adhoc.", "consolidate.", "prune.", "purge."] as const;

/** extract.* rows that are bookkeeping/notices, never durable writes: an
 *  unread badge and a "memory updated" toast for a queue hop or a policy
 *  repair would be a false write notification. */
export const NON_WRITE_EXTRACT_ACTIONS: ReadonlySet<string> = new Set([
  "extract.noop",
  "extract.stale",
  "extract.repaired",
  "extract.requeued",
  "extract.queued",
  "extract.queue_complete",
  "extract.queue_retry",
  "extract.queue_dead",
  "extract.queue_blocked",
  "extract.queue_unblocked",
]);

/** True when one audit action label names a durable memory write. */
export function isWritePathAction(action: string): boolean {
  if (NON_WRITE_EXTRACT_ACTIONS.has(action)) {
    return false;
  }
  return WRITE_PATH_PREFIXES.some((prefix) => action.startsWith(prefix));
}
