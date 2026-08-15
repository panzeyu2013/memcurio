import { createHash } from "node:crypto";
/** Stable identity for a rollout artifact. It is derived from the immutable
 * rollout key rather than the model-generated slug, so a slug change or a
 * same-slug collision cannot redirect usage or overwrite another summary. */
export function artifactIdForRolloutKey(rolloutKey) {
    return createHash("sha256").update(rolloutKey).digest("hex").slice(0, 24);
}
export function artifactFilenameForId(artifactId) {
    if (!/^[a-f0-9]{24}$/.test(artifactId)) {
        throw new Error(`invalid rollout artifact id: ${JSON.stringify(artifactId)}`);
    }
    return `rollout-${artifactId}.md`;
}
