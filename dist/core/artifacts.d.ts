/** Stable identity for a rollout artifact. It is derived from the immutable
 * rollout key rather than the model-generated slug, so a slug change or a
 * same-slug collision cannot redirect usage or overwrite another summary. */
export declare function artifactIdForRolloutKey(rolloutKey: string): string;
export declare function artifactFilenameForId(artifactId: string): string;
