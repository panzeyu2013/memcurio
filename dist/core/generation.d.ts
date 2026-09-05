/** A file snapshot used by the generation protocol. `present` is kept
 * separate from `content` so an empty file and a deleted file cannot be
 * confused during crash recovery. */
export interface GenerationFileSnapshot {
    present: boolean;
    content: string;
}
type GenerationTargetKind = "workspace" | "baseline";
interface GenerationTarget {
    kind: GenerationTargetKind;
    rel: string;
    before: {
        present: boolean;
        hash: string;
        path?: string;
    };
    after: {
        present: boolean;
        hash: string;
        path?: string;
    };
}
export interface GenerationManifest {
    version: 1;
    id: string;
    phase: "prepared" | "committed";
    createdAt: string;
    targets: GenerationTarget[];
}
export type GenerationDirection = "before" | "after";
export interface ApplyGenerationOptions {
    /** Test-only fault injection. The manifest is deliberately left pending so
     * recovery can be exercised as if the process had been killed. */
    failAfter?: number;
}
/** Prepare a durable manifest and stage both old and new contents. Until the
 * database generation marker is committed, recovery always rolls back to the
 * `before` side. */
export declare function prepareGeneration(root: string, id: string, beforeWorkspace: Record<string, GenerationFileSnapshot>, afterWorkspace: Record<string, GenerationFileSnapshot>, beforeBaseline: Record<string, GenerationFileSnapshot>, afterBaseline: Record<string, GenerationFileSnapshot>): GenerationManifest;
/** Apply one side of a generation. On an injected or real I/O failure the
 * manifest remains in place; the next startup can deterministically choose
 * either the old or new side using the SQLite generation marker. */
export declare function applyGeneration(root: string, manifest: GenerationManifest, direction: GenerationDirection, opts?: ApplyGenerationOptions): void;
export declare function markGenerationCommitted(root: string, manifest: GenerationManifest): GenerationManifest;
export declare function discardGeneration(root: string, id: string): void;
export interface GenerationManifestInfo {
    id: string;
    phase: "prepared" | "committed" | "invalid";
    createdAt?: string;
    targetCount?: number;
}
/** Read-only inspection for recovery and audit. Unlike recovery, this also
 * reports an orphaned or malformed generation directory instead of silently
 * ignoring it. */
export declare function inspectGenerationManifests(root: string): GenerationManifestInfo[];
/** Recover every leftover generation. `committedGeneration` must come from
 * SQLite in the same workspace: a matching marker means the DB commit won
 * and files are completed forward; any other generation is rolled back. */
export declare function recoverPendingGenerations(root: string, committedGeneration?: string): string[];
/** Read the committed marker without making the generation module depend on
 *  the SQLite implementation. */
export declare function generationMarkerFromMeta(value: string | undefined): string | undefined;
export {};
