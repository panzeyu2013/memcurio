import { integrationList, integrationRead, integrationSearch, integrationStatus, } from "../api.js";
/** Search the memory workspace (redacted, injection-filtered, 500-char
 *  truncated hits — identical semantics to the host integration surface). */
export function search(root, query, topK = 10) {
    return integrationSearch(root, query, topK);
}
export function list(root, options) {
    return integrationList(root, options);
}
export function read(root, options) {
    return integrationRead(root, options);
}
export function status(root) {
    return integrationStatus(root);
}
