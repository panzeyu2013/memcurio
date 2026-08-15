export declare function rootDir(): string;
export declare function ensureLayout(root: string): void;
export declare function memoryRoot(root: string): string;
/** The memory workspace: markdown source of truth for the v2 pipeline. */
export declare function memoryWorkspace(root: string): string;
export declare function rolloutSummariesDir(root: string): string;
export declare function adHocNotesDir(root: string): string;
export declare function skillsDir(root: string): string;
export declare function baselineDir(root: string): string;
export declare function indexDb(root: string): string;
export declare function configPath(root: string): string;
export declare function txnLog(root: string): string;
/** Resolve a workspace-relative path against the memory workspace and reject
 *  anything that escapes it (symlinks, "..", absolute paths). */
export declare function resolveWorkspacePath(root: string, rel: string): string;
