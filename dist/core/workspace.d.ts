import { existsSync } from "node:fs";
export declare const MEMORY_DOCS: readonly ["MEMORY.md", "memory_summary.md", "raw_memories.md"];
export declare const MAX_WORKSPACE_FILE_BYTES: number;
export declare const MAX_WORKSPACE_FILES = 4096;
/** Workspace-relative path sanity: "a/b.md" ok, absolute/.. rejected. */
export declare function assertWorkspaceRel(rel: string): string;
/** Read a workspace file; missing files read as "". */
export declare function readWorkspaceText(root: string, rel: string): string;
/** Write a workspace file atomically under its lock. Enforces the same size
 *  limit as the read side: writers must not be able to produce a file that
 *  would then throw on every reader (that would wedge the pipeline with no
 *  self-healing path). */
export declare function writeWorkspaceText(root: string, rel: string, content: string): void;
export declare function deleteWorkspaceText(root: string, rel: string): void;
/** Recursively list workspace .md files (skipping .baseline and dot dirs). */
export declare function listWorkspaceFiles(root: string, sub?: string): string[];
/** Snapshot of workspace text files keyed by relative path. */
export declare function snapshotWorkspace(root: string, includeRollouts?: boolean): Record<string, string>;
export interface DiffHunk {
    kind: "add" | "del";
    text: string;
}
export interface WorkspaceDiff {
    rel: string;
    hunks: DiffHunk[];
    text: string;
}
/** Line-level diff of two texts (unique-line LCS via occurrence maps; a
 *  deterministic approximation good enough for a model-facing change list). */
export declare function diffTexts(before: string, after: string): DiffHunk[];
export declare function diffWorkspace(rel: string, before: string, after: string): WorkspaceDiff;
export declare function saveBaseline(root: string): void;
export declare function loadBaseline(root: string): Record<string, string>;
/** True when any managed doc differs from the last successful baseline.
 *  Covers MEMORY_DOCS plus skills/ (codex diffs the whole memory root); the
 *  skills comparison is only meaningful when the baseline actually covers
 *  skills (saveBaseline snapshots them; the consolidator's generation
 *  protocol intentionally resets the baseline to docs + rollout summaries,
 *  after which skills drift is out of its authority). */
export declare function hasWorkspaceChanges(root: string): boolean;
export declare function rolloutSummaryPath(root: string, filename: string): string;
export declare function readRolloutSummary(root: string, filename: string): string;
export declare function writeRolloutSummary(root: string, filename: string, content: string): void;
export declare function deleteRolloutSummary(root: string, filename: string): void;
export declare function rolloutSlugs(root: string): string[];
export declare const NOTE_FILENAME_RE: RegExp;
export declare function noteFilePath(root: string, filename: string): string;
export declare function readAdHocNoteFile(root: string, filename: string): string;
export declare function writeAdHocNoteFile(root: string, filename: string, content: string): void;
export declare function deleteAdHocNoteFile(root: string, filename: string): void;
export declare function listAdHocNoteFiles(root: string): string[];
export { existsSync };
