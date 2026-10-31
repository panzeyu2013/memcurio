import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, withFileLock } from "../core/transaction.js";
/** Version of the durable workspace gate metadata. */
export const WORKSPACE_GATE_VERSION = 1;
/** Bounded map size: old keys are dropped rather than growing the file
 *  without limit. A dropped key only loses a replay fence; it can never
 *  re-enable a workspace or delete data. */
const MAX_KEYS = 10_000;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function emptyDocument() {
    return { version: WORKSPACE_GATE_VERSION, disabled: {}, defaultOff: {} };
}
function parseMap(value) {
    if (!isRecord(value))
        return {};
    const parsed = {};
    for (const [key, at] of Object.entries(value)) {
        if (typeof key === "string" && key !== "" && typeof at === "string")
            parsed[key] = at;
    }
    return parsed;
}
/**
 * Durable workspace gate metadata.
 *
 * It lives outside every store because a disabled workspace may never have
 * created one. `disabled` is the explicit per-workspace fence; `defaultOff`
 * records the global default-off window without making that workspace
 * impossible to re-open when the default is turned back on.
 *
 * Reads are deliberately uncached (session adoption / settings reconcile are
 * rare): another process may have written a key and a stale in-memory cache
 * would re-open history replay. Writes are read-merge-write under the shared
 * file lock so concurrent processes cannot drop each other's keys.
 */
export class WorkspaceGateMeta {
    baseRoot;
    warn;
    now;
    warnedUnreadable = false;
    constructor(baseRoot, options = {}) {
        this.baseRoot = baseRoot;
        this.warn = options.warn ?? (() => undefined);
        this.now = options.now ?? Date.now;
    }
    stateDir() {
        return join(this.baseRoot, "state");
    }
    filePath() {
        return join(this.stateDir(), "workspace-gates.json");
    }
    readState() {
        const path = this.filePath();
        if (!existsSync(path))
            return { document: emptyDocument(), unreadable: false };
        try {
            const parsed = JSON.parse(readFileSync(path, "utf-8"));
            if (!isRecord(parsed) || parsed.version !== WORKSPACE_GATE_VERSION || !isRecord(parsed.disabled)) {
                throw new Error("invalid workspace gate document");
            }
            return {
                document: {
                    version: WORKSPACE_GATE_VERSION,
                    disabled: parseMap(parsed.disabled),
                    defaultOff: parseMap(parsed.defaultOff),
                },
                unreadable: false,
            };
        }
        catch (error) {
            if (!this.warnedUnreadable) {
                this.warnedUnreadable = true;
                this.warn(`workspace gate metadata is unreadable (${String(error)}); history replay stays disabled`);
            }
            return { document: emptyDocument(), unreadable: true };
        }
    }
    /** Read one fence snapshot for a lookup-key set. An unreadable marker
     *  reports neither marker: it blocks replay, not the workspace itself. */
    fence(keys) {
        const state = this.readState();
        if (state.unreadable)
            return { everDisabled: false, everDefaultOff: false, unreadable: true };
        return {
            everDisabled: keys.some((key) => Object.hasOwn(state.document.disabled, key)),
            everDefaultOff: keys.some((key) => Object.hasOwn(state.document.defaultOff, key)),
            unreadable: false,
        };
    }
    /** True when any lookup key was explicitly disabled before. An unreadable
     *  marker reports false (it only suppresses replay; see fence()). */
    hasEverDisabled(keys) {
        return this.fence(keys).everDisabled;
    }
    /** True when any key was observed under a global default-off window. Does
     *  not block re-enabling; only suppresses replay. */
    hasEverDefaultOff(keys) {
        return this.fence(keys).everDefaultOff;
    }
    /** True when the durable marker cannot be read. Callers must suppress
     *  replay; the workspace itself stays governed by the live policy. */
    isUnreadable() {
        return this.readState().unreadable;
    }
    /** Record an explicit per-workspace disable observation. Idempotent; best
     *  effort. */
    markDisabled(keys, at = new Date(this.now()).toISOString()) {
        this.mark("disabled", keys, at);
    }
    /** Record a default-off observation. Idempotent; best effort. */
    markDefaultOff(keys, at = new Date(this.now()).toISOString()) {
        this.mark("defaultOff", keys, at);
    }
    mark(kind, keys, at) {
        try {
            const stateDir = this.stateDir();
            mkdirSync(stateDir, { recursive: true, mode: 0o700 });
            try {
                chmodSync(stateDir, 0o700);
            }
            catch {
                void 0;
            }
            withFileLock(join(stateDir, "workspace-gates.lock"), () => {
                const state = this.readState();
                if (state.unreadable) {
                    // Do not replace a corrupt marker with an empty document: the
                    // unreadable file already fails closed for every key, and overwriting
                    // it would erase the other keys' protection.
                    this.warn("workspace gate metadata is unreadable; refusing to overwrite it");
                    return;
                }
                const current = { ...state.document[kind] };
                let changed = false;
                for (const key of keys) {
                    if (typeof key !== "string" || key === "" || Object.hasOwn(current, key))
                        continue;
                    current[key] = at;
                    changed = true;
                }
                if (!changed)
                    return;
                if (Object.keys(current).length > MAX_KEYS) {
                    const oldest = Object.entries(current)
                        .sort((a, b) => (Date.parse(a[1]) || 0) - (Date.parse(b[1]) || 0))
                        .slice(0, Object.keys(current).length - MAX_KEYS);
                    for (const [key] of oldest)
                        delete current[key];
                }
                const next = {
                    version: WORKSPACE_GATE_VERSION,
                    disabled: kind === "disabled" ? current : state.document.disabled,
                    defaultOff: kind === "defaultOff" ? current : state.document.defaultOff,
                };
                atomicWrite(this.filePath(), `${JSON.stringify(next, null, 2)}\n`);
            });
        }
        catch (error) {
            this.warn(`failed to persist workspace gate metadata: ${String(error)}`);
        }
    }
    /** Read-only view for tests/observability. */
    snapshot() {
        return structuredClone(this.readState().document);
    }
}
