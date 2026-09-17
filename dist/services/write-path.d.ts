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
export declare const WRITE_PATH_PREFIXES: readonly ["extract.", "adhoc.", "consolidate.", "prune.", "purge."];
/** extract.* rows that are bookkeeping/notices, never durable writes: an
 *  unread badge and a "memory updated" toast for a queue hop or a policy
 *  repair would be a false write notification. */
export declare const NON_WRITE_EXTRACT_ACTIONS: ReadonlySet<string>;
/** True when one audit action label names a durable memory write. */
export declare function isWritePathAction(action: string): boolean;
