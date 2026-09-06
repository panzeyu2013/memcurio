import { integrationList, integrationRead, integrationSearch, integrationStatus, } from "../api.js";
/** Search the memory workspace (redacted, injection-filtered, 500-char
 *  truncated hits). Workbench previews opt out of usage telemetry
 *  (trackUsage:false) — only model-driven reuse should move the window. */
export function search(root, query, topK = 10) {
    return integrationSearch(root, query, topK, { trackUsage: false });
}
export function list(root, options) {
    return integrationList(root, options);
}
/** Read one memory file. UI previews opt out of usage telemetry (see
 *  {@link search}); the plugin's model-facing memory_read tool keeps the
 *  default counting behavior through api.integrationRead. */
export function read(root, options) {
    return integrationRead(root, { ...options, trackUsage: false });
}
export function status(root) {
    return integrationStatus(root);
}
