// Aggregate service surface. Several modules export a `list` (memory, usage,
// queue, audit); star re-exports would drop those names as ambiguous, so the
// barrel re-exports each module under its own namespace-style alias
// (queueList / usageList / auditList) while `list` stays the memory listing.
export { listStores, resolveStoreRoot } from "./context.js";
export { list, read, search, status } from "./memory.js";
export { simulate, staticContext } from "./inject.js";
export { byKey, list as usageList } from "./usage.js";
export { consolidation, list as queueList } from "./queue.js";
export { count as auditCount, list as auditList } from "./audit.js";
export { draft } from "./intent.js";
export * from "./snapshot.js";
