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
function hasControlChars(value) {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f)
            return true;
    }
    return false;
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function realpathOrSelf(path, realpath) {
    try {
        return realpath(path);
    }
    catch {
        return path;
    }
}
function pathApi(platform) {
    return platform === "win32" ? win32 : posix;
}
function comparisonKey(path, platform) {
    return platform === "win32" ? path.toLowerCase() : path;
}
/** Canonicalize and compare-normalize one absolute path. */
export function normalizeWorkspacePath(path, options = {}) {
    const realpath = options.realpath ?? realpathSync;
    const platform = options.platform ?? process.platform;
    // Resolve with the platform under test, not the process platform: a Windows
    // root (C:\) must stay C:\\ instead of being stripped to C: (drive-relative).
    const absolute = pathApi(platform).resolve(path);
    return comparisonKey(realpathOrSelf(absolute, realpath), platform);
}
/** Normalize one stored override key. Returns undefined for malformed keys
 *  (relative paths, control characters, over-long input). */
export function normalizeWorkspaceKey(raw, options = {}) {
    if (typeof raw !== "string")
        return undefined;
    const trimmed = raw.trim();
    if (trimmed === "")
        return undefined;
    if (trimmed === NO_CWD_WORKSPACE)
        return NO_CWD_WORKSPACE;
    if (trimmed.length > MAX_KEY_CHARS || hasControlChars(trimmed))
        return undefined;
    const platform = options.platform ?? process.platform;
    if (!pathApi(platform).isAbsolute(trimmed))
        return undefined;
    return normalizeWorkspacePath(trimmed, options);
}
/** Normalize the stored override map. Object-only: booleans are rejected so a
 *  hand-edited typo can never silently mean "enabled". Duplicate normalized
 *  keys keep the more restrictive value (false wins). */
export function normalizeWorkspaceOverrides(raw, options = {}) {
    if (!isRecord(raw))
        return {};
    const normalized = new Map();
    for (const [rawKey, rawValue] of Object.entries(raw)) {
        const key = normalizeWorkspaceKey(rawKey, options);
        if (key === undefined)
            continue;
        if (!isRecord(rawValue) || typeof rawValue.enabled !== "boolean")
            continue;
        const previous = normalized.get(key);
        const enabled = previous?.enabled === false ? false : rawValue.enabled;
        normalized.set(key, { enabled });
        if (normalized.size > MAX_OVERRIDES)
            break;
    }
    return Object.fromEntries(normalized);
}
/** Ordered lookup keys for one working directory. Canonical spelling comes
 *  first; the original (resolved) spelling is a fallback for a deleted symlink
 *  or a hand-edited original key. */
export function workspaceLookupKeys(workdir, options = {}) {
    if (!workdir)
        return [NO_CWD_WORKSPACE];
    const platform = options.platform ?? process.platform;
    const realpath = options.realpath ?? realpathSync;
    const original = pathApi(platform).resolve(workdir);
    const canonical = realpathOrSelf(original, realpath);
    const keys = [comparisonKey(canonical, platform), comparisonKey(original, platform)];
    return keys[0] === keys[1] ? [keys[0]] : keys;
}
/** Live workspace policy gate with a raw-identity cache: a settings write
 *  produces a new overrides object and invalidates the normalized view. */
export function createWorkspaceGate(options) {
    let lastDefault;
    let lastOverrides;
    let view;
    const noCwdDefault = options.noCwdDefaultEnabled ?? NO_CWD_DEFAULT_ENABLED;
    const refresh = () => {
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
    const settings = () => {
        refresh();
        return view;
    };
    const hasOverride = (keys) => {
        const overrides = settings().overrides;
        return keys.some((key) => Object.hasOwn(overrides, key));
    };
    const isKeysEnabled = (keys) => {
        const current = settings();
        for (const key of keys) {
            if (Object.hasOwn(current.overrides, key)) {
                return current.overrides[key]?.enabled === true;
            }
        }
        if (keys.includes(NO_CWD_WORKSPACE))
            return noCwdDefault;
        return current.defaultEnabled;
    };
    return {
        settings,
        key(workdir) {
            return workspaceLookupKeys(workdir, options)[0];
        },
        lookupKeys(workdir) {
            return workspaceLookupKeys(workdir, options);
        },
        isKeyEnabled(key) {
            return isKeysEnabled([key]);
        },
        isKeysEnabled,
        isWorkdirEnabled(workdir) {
            return isKeysEnabled(workspaceLookupKeys(workdir, options));
        },
        hasOverride,
        isExplicitlyDisabled(keys) {
            return hasOverride(keys) && !isKeysEnabled(keys);
        },
        explicitDisabledKeys() {
            return Object.entries(settings().overrides)
                .filter(([, value]) => value.enabled === false)
                .map(([key]) => key);
        },
        refresh,
    };
}
