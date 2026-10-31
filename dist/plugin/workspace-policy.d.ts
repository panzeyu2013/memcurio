/** Reserved policy key for sessions without a working directory. It is not an
 *  absolute path, so it can never collide with a real workspace key. */
export declare const NO_CWD_WORKSPACE = "no-cwd";
/** no-cwd is a shared bucket without workspace isolation. It is OFF unless a
 *  workspace override explicitly enables it. Real workspaces follow
 *  defaultWorkspaceEnabled. */
export declare const NO_CWD_DEFAULT_ENABLED = false;
/** One stored workspace override. Object shape leaves room for future
 *  per-workspace fields without migrating the map. */
export interface WorkspaceOverrideValue {
    enabled: boolean;
}
export type WorkspaceOverrides = Record<string, WorkspaceOverrideValue>;
export interface WorkspacePolicySettings {
    defaultEnabled: boolean;
    overrides: WorkspaceOverrides;
}
export interface WorkspaceGateOptions {
    /** Live default value (already unwrapped from a volatile reference). */
    defaultEnabled: () => unknown;
    /** Live override map (already unwrapped from a volatile reference). The
     *  gate caches the normalized view until this object identity changes. */
    overrides: () => unknown;
    /** Injectable for tests; defaults to fs.realpathSync. */
    realpath?: (path: string) => string;
    /** Injectable for tests; defaults to process.platform. */
    platform?: NodeJS.Platform;
    /** no-cwd default; tests may opt into the compatibility behavior. */
    noCwdDefaultEnabled?: boolean;
}
export interface WorkspaceGate {
    settings(): WorkspacePolicySettings;
    /** Primary (comparison) key for one workdir: canonical path or no-cwd. */
    key(workdir: string): string;
    /** Ordered lookup keys: canonical first, then the original spelling. */
    lookupKeys(workdir: string): string[];
    isKeyEnabled(key: string): boolean;
    isKeysEnabled(keys: readonly string[]): boolean;
    isWorkdirEnabled(workdir: string): boolean;
    hasOverride(keys: readonly string[]): boolean;
    isExplicitlyDisabled(keys: readonly string[]): boolean;
    explicitDisabledKeys(): string[];
    refresh(): void;
}
/** Canonicalize and compare-normalize one absolute path. */
export declare function normalizeWorkspacePath(path: string, options?: Pick<WorkspaceGateOptions, "realpath" | "platform">): string;
/** Normalize one stored override key. Returns undefined for malformed keys
 *  (relative paths, control characters, over-long input). */
export declare function normalizeWorkspaceKey(raw: unknown, options?: Pick<WorkspaceGateOptions, "realpath" | "platform">): string | undefined;
/** Normalize the stored override map. Object-only: booleans are rejected so a
 *  hand-edited typo can never silently mean "enabled". Duplicate normalized
 *  keys keep the more restrictive value (false wins). */
export declare function normalizeWorkspaceOverrides(raw: unknown, options?: Pick<WorkspaceGateOptions, "realpath" | "platform">): WorkspaceOverrides;
/** Ordered lookup keys for one working directory. Canonical spelling comes
 *  first; the original (resolved) spelling is a fallback for a deleted symlink
 *  or a hand-edited original key. */
export declare function workspaceLookupKeys(workdir: string, options?: Pick<WorkspaceGateOptions, "realpath" | "platform">): string[];
/** Live workspace policy gate with a raw-identity cache: a settings write
 *  produces a new overrides object and invalidates the normalized view. */
export declare function createWorkspaceGate(options: WorkspaceGateOptions): WorkspaceGate;
