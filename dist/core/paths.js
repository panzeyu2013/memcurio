import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { chmodSync, lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync } from "node:fs";
export function rootDir() {
    const env = process.env.MEMCURIO_ROOT;
    return env?.trim() ? env.trim() : join(homedir(), ".memcurio");
}
export function ensureLayout(root) {
    for (const sub of ["memory", "state"]) {
        const d = join(root, sub);
        mkdirSync(d, { recursive: true, mode: 0o700 });
        try {
            chmodSync(d, 0o700);
        }
        catch {
            void 0;
        }
    }
    const ws = memoryWorkspace(root);
    for (const sub of ["rollout_summaries", "extensions/ad_hoc/notes", "skills", ".baseline"]) {
        const d = join(ws, sub);
        mkdirSync(d, { recursive: true, mode: 0o700 });
        try {
            chmodSync(d, 0o700);
        }
        catch {
            void 0;
        }
    }
    try {
        chmodSync(root, 0o700);
    }
    catch {
        void 0;
    }
    sweepStaleTmpFiles(root);
}
/** Remove `.tmp-*` files left behind by a process killed between write and
 *  rename (they are invisible to readers and would accumulate forever). Files
 *  younger than SWEEP_GRACE_MS are left alone — a concurrent process may be
 *  mid-`atomicWrite` with its temp file still in place, and unlinking it would
 *  make the writer's rename fail and roll back its batch. */
const SWEEP_GRACE_MS = 30_000;
function sweepStaleTmpFiles(root) {
    const TMP_RE = /^\.tmp-\d+-[0-9a-f]{16}\./;
    const visited = new Set();
    const sweep = (dir, depth) => {
        if (depth > 2 || visited.has(dir)) {
            return;
        }
        visited.add(dir);
        let names;
        try {
            names = readdirSync(dir);
        }
        catch {
            return;
        }
        for (const name of names) {
            const p = join(dir, name);
            try {
                // lstat: never follow symlinks, so a hand-placed `.tmp-*` symlink
                // cannot redirect the sweep (or the recursion) outside the root.
                const st = lstatSync(p);
                if (st.isDirectory()) {
                    sweep(p, depth + 1);
                }
                else if (st.isFile() && TMP_RE.test(name) && Date.now() - st.mtimeMs > SWEEP_GRACE_MS) {
                    unlinkSync(p);
                }
            }
            catch {
                void 0;
            }
        }
    };
    sweep(join(root, "memory"), 0);
    sweep(join(root, "state"), 0);
}
export function memoryRoot(root) {
    return join(root, "memory");
}
/** The memory workspace: markdown source of truth for the v2 pipeline. */
export function memoryWorkspace(root) {
    return memoryRoot(root);
}
export function rolloutSummariesDir(root) {
    return join(memoryWorkspace(root), "rollout_summaries");
}
export function adHocNotesDir(root) {
    return join(memoryWorkspace(root), "extensions", "ad_hoc", "notes");
}
export function skillsDir(root) {
    return join(memoryWorkspace(root), "skills");
}
export function baselineDir(root) {
    return join(memoryWorkspace(root), ".baseline");
}
export function indexDb(root) {
    return join(root, "index.sqlite");
}
export function configPath(root) {
    return join(root, "config.json");
}
export function txnLog(root) {
    return join(root, "state", "transactions.jsonl");
}
/** Resolve a workspace-relative path against the memory workspace and reject
 *  anything that escapes it (symlinks, "..", absolute paths). */
export function resolveWorkspacePath(root, rel) {
    const base = resolve(memoryWorkspace(root));
    const target = resolve(base, rel);
    if (target !== base && !target.startsWith(`${base}/`)) {
        throw new Error(`workspace path escapes the memory root: ${JSON.stringify(rel)}`);
    }
    const baseReal = realpathOrSelf(base);
    let actual = baseReal;
    const remaining = relative(base, target).split(sep).filter(Boolean);
    for (const [index, segment] of remaining.entries()) {
        const candidate = join(actual, segment);
        try {
            actual = realpathOrSelf(candidate);
        }
        catch (err) {
            if (err.code === "ENOENT") {
                actual = join(actual, ...remaining.slice(index));
                break;
            }
            throw err;
        }
        if (actual !== baseReal && !actual.startsWith(`${baseReal}${sep}`)) {
            throw new Error(`workspace path escapes the memory root: ${JSON.stringify(rel)}`);
        }
    }
    return actual;
}
function realpathOrSelf(path) {
    try {
        return realpathSync(path);
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return path;
        }
        throw err;
    }
}
