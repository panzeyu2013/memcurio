import { realpathSync } from "node:fs";
import { posix, win32 } from "node:path";

/** Reserved policy key for sessions without a working directory. It is not an
 *  absolute path, so it can never collide with a real workspace key. */
export const NO_CWD_WORKSPACE = "no-cwd";

/** no-cwd is a shared bucket without workspace isolation. It is OFF unless a
 *  workspace override explicitly enables it. Real workspaces follow
 *  defaultWorkspaceEnabled. */
export const NO_CWD_DEFAULT_ENABLED = false;

const MAX_KEY_CHARS = 4_096;
const MAX_OVERRIDES = 10_000;

function hasControlChars(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function realpathOrSelf(path: string, realpath: (path: string) => string): string {
  try {
    return realpath(path);
  } catch {
    return path;
  }
}

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

function comparisonKey(path: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? path.toLowerCase() : path;
}

/** Canonicalize and compare-normalize one absolute path. */
export function normalizeWorkspacePath(
  path: string,
  options: Pick<WorkspaceGateOptions, "realpath" | "platform"> = {},
): string {
  const realpath = options.realpath ?? realpathSync;
  const platform = options.platform ?? process.platform;
  // Resolve with the platform under test, not the process platform: a Windows
  // root (C:\) must stay C:\\ instead of being stripped to C: (drive-relative).
  const absolute = pathApi(platform).resolve(path);
  return comparisonKey(realpathOrSelf(absolute, realpath), platform);
}

/** Normalize one stored override key. Returns undefined for malformed keys
 *  (relative paths, control characters, over-long input). */
export function normalizeWorkspaceKey(
  raw: unknown,
  options: Pick<WorkspaceGateOptions, "realpath" | "platform"> = {},
): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  if (trimmed === NO_CWD_WORKSPACE) return NO_CWD_WORKSPACE;
  if (trimmed.length > MAX_KEY_CHARS || hasControlChars(trimmed)) return undefined;
  const platform = options.platform ?? process.platform;
  if (!pathApi(platform).isAbsolute(trimmed)) return undefined;
  return normalizeWorkspacePath(trimmed, options);
}

/** Normalize the stored override map. Object-only: booleans are rejected so a
 *  hand-edited typo can never silently mean "enabled". Duplicate normalized
 *  keys keep the more restrictive value (false wins). */
export function normalizeWorkspaceOverrides(
  raw: unknown,
  options: Pick<WorkspaceGateOptions, "realpath" | "platform"> = {},
): WorkspaceOverrides {
  if (!isRecord(raw)) return {};
  const normalized = new Map<string, WorkspaceOverrideValue>();
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = normalizeWorkspaceKey(rawKey, options);
    if (key === undefined) continue;
    if (!isRecord(rawValue) || typeof rawValue.enabled !== "boolean") continue;
    const previous = normalized.get(key);
    const enabled = previous?.enabled === false ? false : rawValue.enabled;
    normalized.set(key, { enabled });
    if (normalized.size > MAX_OVERRIDES) break;
  }
  return Object.fromEntries(normalized);
}

/** Ordered lookup keys for one working directory. Canonical spelling comes
 *  first; the original (resolved) spelling is a fallback for a deleted symlink
 *  or a hand-edited original key. */
export function workspaceLookupKeys(
  workdir: string,
  options: Pick<WorkspaceGateOptions, "realpath" | "platform"> = {},
): string[] {
  if (!workdir) return [NO_CWD_WORKSPACE];
  const platform = options.platform ?? process.platform;
  const realpath = options.realpath ?? realpathSync;
  const original = pathApi(platform).resolve(workdir);
  const canonical = realpathOrSelf(original, realpath);
  const keys = [comparisonKey(canonical, platform), comparisonKey(original, platform)];
  return keys[0] === keys[1] ? [keys[0] as string] : keys;
}

/** Live workspace policy gate with a raw-identity cache: a settings write
 *  produces a new overrides object and invalidates the normalized view. */
export function createWorkspaceGate(options: WorkspaceGateOptions): WorkspaceGate {
  let lastDefault: unknown;
  let lastOverrides: unknown;
  let view: WorkspacePolicySettings | undefined;
  const noCwdDefault = options.noCwdDefaultEnabled ?? NO_CWD_DEFAULT_ENABLED;

  const refresh = (): void => {
    const rawDefault = options.defaultEnabled();
    const rawOverrides = options.overrides();
    if (view !== undefined && Object.is(rawDefault, lastDefault) && Object.is(rawOverrides, lastOverrides)) {
      return;
    }
    lastDefault = rawDefault;
    lastOverrides = rawOverrides;
    view = {
      defaultEnabled: rawDefault !== false,
      overrides: normalizeWorkspaceOverrides(rawOverrides, options),
    };
  };

  const settings = (): WorkspacePolicySettings => {
    refresh();
    return view as WorkspacePolicySettings;
  };

  const hasOverride = (keys: readonly string[]): boolean => {
    const overrides = settings().overrides;
    return keys.some((key) => Object.hasOwn(overrides, key));
  };

  const isKeysEnabled = (keys: readonly string[]): boolean => {
    const current = settings();
    for (const key of keys) {
      if (Object.hasOwn(current.overrides, key)) {
        return current.overrides[key]?.enabled === true;
      }
    }
    if (keys.includes(NO_CWD_WORKSPACE)) return noCwdDefault;
    return current.defaultEnabled;
  };

  return {
    settings,
    key(workdir: string): string {
      return workspaceLookupKeys(workdir, options)[0] as string;
    },
    lookupKeys(workdir: string): string[] {
      return workspaceLookupKeys(workdir, options);
    },
    isKeyEnabled(key: string): boolean {
      return isKeysEnabled([key]);
    },
    isKeysEnabled,
    isWorkdirEnabled(workdir: string): boolean {
      return isKeysEnabled(workspaceLookupKeys(workdir, options));
    },
    hasOverride,
    isExplicitlyDisabled(keys: readonly string[]): boolean {
      return hasOverride(keys) && !isKeysEnabled(keys);
    },
    explicitDisabledKeys(): string[] {
      return Object.entries(settings().overrides)
        .filter(([, value]) => value.enabled === false)
        .map(([key]) => key);
    },
    refresh,
  };
}
