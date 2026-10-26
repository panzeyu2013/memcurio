import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync, } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { activityPath, clearSweptToken, readStoreOrigin, storeIsDirty, writeActivityToken, } from "./store-meta.js";
import { listWorkspaceFiles } from "./workspace.js";
import { atomicWrite, withFileLock } from "./transaction.js";
const DAY_MS = 86_400_000;
export function gcDirs(baseRoot) {
    const dsh = join(resolve(baseRoot), "dsh");
    const gc = join(dsh, ".gc");
    return {
        dsh,
        gc,
        trash: join(dsh, ".trash"),
        lock: join(gc, "lifecycle.lock"),
    };
}
/** Store directories under one base root (a directory counts when it carries an
 *  index.sqlite; dot-directories such as `.gc`/`.trash` are skipped). */
export function storeDirsUnder(baseRoot) {
    const { dsh } = gcDirs(baseRoot);
    let names;
    try {
        names = readdirSync(dsh);
    }
    catch {
        return [];
    }
    return names
        .filter((name) => !name.startsWith("."))
        .map((name) => join(dsh, name))
        .filter((dir) => existsSync(join(dir, "index.sqlite")))
        .sort();
}
function directoryExists(path) {
    try {
        return statSync(path).isDirectory();
    }
    catch (err) {
        // Only a positive ENOENT/ENOTDIR means "gone": EACCES, ELOOP, EIO and
        // the like must be treated as alive, never as a deleted workspace.
        const code = err.code;
        return code !== "ENOENT" && code !== "ENOTDIR";
    }
}
function realpathOrSelf(path) {
    try {
        return realpathSync(path);
    }
    catch {
        return path;
    }
}
function under(prefix, path) {
    const base = resolve(realpathOrSelf(prefix));
    const target = resolve(path);
    return target === base || target.startsWith(`${base}${sep}`);
}
function sizeOf(dir, depth = 0) {
    if (depth > 6) {
        return 0;
    }
    let total = 0;
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return 0;
    }
    for (const name of names) {
        const path = join(dir, name);
        try {
            const st = statSync(path);
            if (st.isDirectory()) {
                total += sizeOf(path, depth + 1);
            }
            else if (st.isFile()) {
                total += st.size;
            }
        }
        catch {
            // A racing removal must not abort the plan.
        }
    }
    return total;
}
/** A store that never produced memory content: no docs, no rollout summaries,
 *  no ad-hoc notes. The queue and stage rows are checked separately, under the
 *  live transaction (a staged row without a file is still content). */
export function isStoreEmpty(dir) {
    const memory = join(dir, "memory");
    let rels;
    try {
        // The readers walk memory/**/*.md (dot directories excluded), so the
        // emptiness check must use the same enumeration or an extension resource
        // would make a store look empty.
        rels = listWorkspaceFiles(dir);
    }
    catch {
        return false;
    }
    for (const rel of rels) {
        try {
            if (statSync(join(memory, rel)).size > 0) {
                return false;
            }
        }
        catch {
            return false;
        }
    }
    return true;
}
const MISSING_CONFIRM_MS = 3_600_000;
const STALE_QUEUE_MS = 7 * 86_400_000;
/** A pending job only blocks reclamation while it is plausibly still work in
 *  progress. After a week without a token write nothing can claim it any more
 *  (an orphan store has no live session), so the queue is dead weight. */
function staleQueue(dir, now) {
    try {
        return now - statSync(activityPath(dir)).mtimeMs > STALE_QUEUE_MS;
    }
    catch {
        return false;
    }
}
/** An entry is still usable while it has a manifest or a store. A quarantine
 *  in progress has the manifest first; a partially purged directory may have
 *  neither, in which case the tombstone is stale. */
function entryUsable(entryDir) {
    return existsSync(join(entryDir, "index.json")) || existsSync(join(entryDir, "store"));
}
function missingMarkPath(dir) {
    return join(dir, "state", "gc-missing-since");
}
/** How long the recorded workspace has been observed missing, or undefined
 *  when this is the first pass that sees it. */
function missingAgeMs(dir, now, workdir) {
    try {
        const raw = JSON.parse(readFileSync(missingMarkPath(dir), "utf-8"));
        // A different workdir means a different disappearance: start over.
        if (raw.workdir !== workdir || typeof raw.at !== "string") {
            return undefined;
        }
        const at = Date.parse(raw.at);
        if (Number.isFinite(at)) {
            return Math.max(0, now - at);
        }
        return Math.max(0, now - statSync(missingMarkPath(dir)).mtimeMs);
    }
    catch {
        return undefined;
    }
}
function markMissing(dir, now, workdir) {
    if (!existsSync(dir)) {
        return;
    }
    try {
        mkdirSync(join(dir, "state"), { recursive: true, mode: 0o700 });
        writeFileSync(missingMarkPath(dir), JSON.stringify({ at: new Date(now).toISOString(), workdir }), { mode: 0o600 });
    }
    catch {
        void 0;
    }
}
function clearMissingMark(dir) {
    try {
        unlinkSync(missingMarkPath(dir));
    }
    catch {
        void 0;
    }
}
function ageDaysOf(iso, now) {
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) {
        return undefined;
    }
    return (now - at) / DAY_MS;
}
/** Read-only reclamation plan. Every store that is not a candidate carries a
 *  reason, so an operator can explain the inventory without opening SQLite. */
export function planStoreGc(baseRoot, policy, deps = {}) {
    const now = deps.now ?? Date.now();
    const protectedRoots = deps.protectedRoots ?? new Set();
    const isAlive = deps.isWorkdirAlive ?? directoryExists;
    const { dsh } = gcDirs(baseRoot);
    const plan = { candidates: [], skipped: [], trashEligible: [] };
    // The inventory (trash entries, no-index directories) is reported even when
    // reclamation is disabled: an operator must be able to see what purging would
    // remove. Only candidate selection is gated.
    const reclaimEnabled = policy.retentionDays > 0 || policy.emptyStoreHours > 0;
    // Directories that never got a database are invisible to the main
    // enumeration; report them so an operator can explain the inventory.
    try {
        for (const name of readdirSync(dsh)) {
            if (name.includes(".stale-")) {
                continue;
            }
            if (!name.startsWith(".") && !existsSync(join(dsh, name, "index.sqlite"))) {
                plan.skipped.push({ key: name, reason: "no-index" });
            }
        }
    }
    catch {
        void 0;
    }
    for (const dir of storeDirsUnder(baseRoot)) {
        const key = basename(dir);
        if (key === "no-cwd") {
            plan.skipped.push({ key, reason: "no-cwd" });
            continue;
        }
        if (resolve(dir) === resolve(baseRoot) || resolve(dir) === resolve(dsh)) {
            plan.skipped.push({ key, reason: "base-root" });
            continue;
        }
        if (protectedRoots.has(dir)) {
            plan.skipped.push({ key, reason: "active" });
            continue;
        }
        const origin = readStoreOrigin(dir);
        if (!origin) {
            plan.skipped.push({ key, reason: "no-origin" });
            continue;
        }
        if (!origin.workdir) {
            plan.skipped.push({ key, reason: "no-workdir" });
            continue;
        }
        const emptyStore = policy.emptyStoreHours > 0 && isStoreEmpty(dir);
        if (!emptyStore && (isAlive(origin.workdir) || (origin.realpath !== origin.workdir && isAlive(origin.realpath)))) {
            if (!deps.dryRun) {
                clearMissingMark(dir);
            }
            plan.skipped.push({ key, reason: "workdir-exists" });
            continue;
        }
        if (policy.scope === "dsh-home" &&
            !under(realpathOrSelf(join(policy.dshHomeRoot, "worktrees")), origin.realpath) &&
            // A symlinked DSH home makes the recorded realpath miss the prefix even
            // though the store belongs to the worktrees tree; accept the raw path too.
            !under(join(policy.dshHomeRoot, "worktrees"), origin.workdir)) {
            plan.skipped.push({ key, reason: "outside-dsh-home" });
            continue;
        }
        // Age comes from the origin only: repair/restore/ensureOrigin rewrite the
        // activity token and must not reset the retention clock.
        const lastRaw = Math.max(Number.isFinite(Date.parse(origin.lastActivityAt)) ? Date.parse(origin.lastActivityAt) : 0, Number.isFinite(Date.parse(origin.firstSeenAt)) ? Date.parse(origin.firstSeenAt) : 0);
        // A clock jump or a restored backup can put the mtime in the future; treat
        // it as "now" so the store is not permanently un-reclaimable.
        const lastMs = lastRaw > 0 ? Math.min(lastRaw, now) : 0;
        if (lastMs === 0) {
            plan.skipped.push({ key, reason: "bad-origin" });
            continue;
        }
        const effectiveAge = (now - lastMs) / DAY_MS;
        if (emptyStore && reclaimEnabled) {
            if (effectiveAge * 24 < policy.emptyStoreHours) {
                plan.skipped.push({ key, reason: "too-recent" });
                continue;
            }
            if (storeIsDirty(dir)) {
                plan.skipped.push({ key, reason: "dirty-token" });
                continue;
            }
            if (plan.candidates.length >= Math.max(1, policy.maxPerRun)) {
                plan.skipped.push({ key, reason: "run-cap" });
                continue;
            }
            plan.candidates.push({
                key,
                path: dir,
                workdir: origin.realpath,
                lastActivityAt: origin.lastActivityAt,
                ageDays: Math.round(effectiveAge * 10) / 10,
                sizeBytes: sizeOf(dir),
                reasons: ["empty-store", "age>=" + String(policy.emptyStoreHours) + "h"],
                tier: "empty",
            });
            continue;
        }
        if (!(policy.retentionDays > 0) || effectiveAge < policy.retentionDays) {
            plan.skipped.push({ key, reason: "too-recent" });
            continue;
        }
        // A dirty store is normally fenced, but a queue nobody can claim any more
        // must not keep the registration alive forever.
        if (storeIsDirty(dir) && !staleQueue(dir, now)) {
            plan.skipped.push({ key, reason: "dirty-token" });
            continue;
        }
        if (plan.candidates.length >= Math.max(1, policy.maxPerRun)) {
            plan.skipped.push({ key, reason: "run-cap" });
            continue;
        }
        plan.candidates.push({
            key,
            path: dir,
            workdir: origin.realpath,
            lastActivityAt: origin.lastActivityAt,
            ageDays: Math.round(effectiveAge * 10) / 10,
            sizeBytes: sizeOf(dir),
            tier: "orphan",
            reasons: ["workdir-missing", `age>=${String(policy.retentionDays)}d`],
        });
    }
    plan.trashEligible =
        policy.trashDays > 0
            ? trashEntries(baseRoot)
                .filter((entry) => {
                const conflict = existsSync(join(entry.dir, ".restore-conflict"));
                const keepDays = conflict ? policy.trashDays * 2 : policy.trashDays;
                const age = ageDaysOf(entry.quarantinedAt, now);
                return age !== undefined && age >= keepDays;
            })
                .map((entry) => entry.dir)
            : [];
    return plan;
}
/** Drop-by-name order keeps "newest entry" deterministic without parsing. */
export function trashEntries(baseRoot) {
    const { trash } = gcDirs(baseRoot);
    let names;
    try {
        names = readdirSync(trash);
    }
    catch {
        return [];
    }
    const out = [];
    for (const name of names) {
        if (name.startsWith(".")) {
            continue;
        }
        const dir = join(trash, name);
        let key;
        let quarantinedAt;
        try {
            const manifest = JSON.parse(readFileSync(join(dir, "index.json"), "utf-8"));
            if (typeof manifest.key === "string" && typeof manifest.quarantinedAt === "string") {
                key = manifest.key;
                quarantinedAt = manifest.quarantinedAt;
            }
        }
        catch {
            void 0;
        }
        if (!key || !quarantinedAt) {
            // A non-atomic purge or a partial write can lose the manifest while the
            // store itself survives. Recover what the directory name and mtime still
            // tell us instead of leaking the entry forever.
            if (!existsSync(join(dir, "store", "index.sqlite"))) {
                continue;
            }
            const recovered = name.length > 25 ? name.slice(25) : name;
            key = /^[0-9a-z][0-9a-z-]{0,63}$/.test(recovered) ? recovered : name;
            quarantinedAt = new Date(statSync(dir).mtimeMs).toISOString();
        }
        if (!existsSync(join(dir, "store"))) {
            continue;
        }
        out.push({ dir, key, quarantinedAt });
    }
    return out.sort((a, b) => (a.dir < b.dir ? 1 : a.dir > b.dir ? -1 : 0));
}
export function quarantineStore(baseRoot, candidate, extras = {}, now = Date.now()) {
    const { trash, gc } = gcDirs(baseRoot);
    const stamp = new Date(now)
        .toISOString()
        .replaceAll(":", "-")
        .replaceAll(".", "-");
    const entry = join(trash, `${stamp}-${candidate.key}`);
    mkdirSync(entry, { recursive: true, mode: 0o700 });
    mkdirSync(gc, { recursive: true, mode: 0o700 });
    const manifest = {
        version: 1,
        key: candidate.key,
        workdir: candidate.workdir,
        lastActivityAt: candidate.lastActivityAt,
        ageDays: candidate.ageDays,
        bytes: candidate.sizeBytes,
        quarantinedAt: new Date(now).toISOString(),
        reasons: candidate.reasons,
        ...extras,
    };
    // Manifest first: a crash after this point leaves an entry that still names
    // its store, so a human can restore it even if the rename never happened.
    atomicWrite(join(entry, "index.json"), JSON.stringify(manifest) + "\n");
    // Tombstone before the destructive rename: a crash between the two still
    // points a later adoption at this entry.
    writeTombstone(baseRoot, candidate.key, entry, now);
    try {
        renameSync(candidate.path, join(entry, "store"));
    }
    catch (err) {
        rmSync(entry, { recursive: true, force: true });
        clearTombstone(baseRoot, candidate.key);
        throw err;
    }
    return { entry, restoredPath: join(entry, "store") };
}
/** Remove half-written trash entries (mkdir succeeded, rename never ran). They
 *  carry no store directory, so no reader can use them. */
function purgeDebris(baseRoot, now) {
    const { trash } = gcDirs(baseRoot);
    let names;
    try {
        names = readdirSync(trash);
    }
    catch {
        return;
    }
    for (const name of names) {
        if (name.startsWith(".")) {
            continue;
        }
        const dir = join(trash, name);
        try {
            if (existsSync(join(dir, "store"))) {
                continue;
            }
            if (now - statSync(dir).mtimeMs < 3_600_000) {
                continue;
            }
            rmSync(dir, { recursive: true, force: true });
        }
        catch {
            void 0;
        }
    }
}
/** Purge quarantined stores past their retention. Returns the removed entries. */
export function purgeTrash(baseRoot, policy, now = Date.now()) {
    if (!(policy.trashDays > 0)) {
        return [];
    }
    const removed = [];
    purgeDebris(baseRoot, now);
    for (const entry of trashEntries(baseRoot)) {
        const conflict = existsSync(join(entry.dir, ".restore-conflict"));
        const age = ageDaysOf(entry.quarantinedAt, now);
        // A conflicted entry keeps its data for twice the window, then goes too.
        const keepDays = conflict ? policy.trashDays * 2 : policy.trashDays;
        if (age === undefined || age < keepDays) {
            continue;
        }
        try {
            rmSync(entry.dir, { recursive: true, force: true });
            // Only the tombstone that points at THIS entry may be dropped: the same
            // key can have an older and a newer quarantined copy.
            if (readTombstone(baseRoot, entry.key)?.entry === entry.dir) {
                clearTombstone(baseRoot, entry.key);
            }
            removed.push(entry.dir);
        }
        catch {
            // Best effort: a locked file keeps the entry for the next run.
        }
    }
    return removed;
}
/** Restore the newest quarantined entry for a key. Refuses to overwrite a live
 *  store at the same path, and invalidates the swept watermark so the restored
 *  store is examined by the next sweep. */
export function restoreStore(baseRoot, key, now = Date.now()) {
    // The lifecycle lock serializes this against the 6h purge and a concurrent
    // adoption; without it a purge can delete the copy mid-rename.
    return withFileLock(gcDirs(baseRoot).lock, () => restoreStoreInner(baseRoot, key, now));
}
function restoreStoreInner(baseRoot, key, now) {
    if (!/^[0-9a-z][0-9a-z-]{0,63}$/.test(key)) {
        throw new Error("invalid store key: " + JSON.stringify(key));
    }
    const { dsh } = gcDirs(baseRoot);
    const entry = trashEntries(baseRoot).find((candidate) => candidate.key === key);
    if (!entry) {
        throw new Error(`no quarantined store for key ${key}`);
    }
    if (!existsSync(join(entry.dir, "store", "index.sqlite"))) {
        // A purge interrupted mid-rmSync leaves a partial copy. Restoring it would
        // hand a broken store to the session and audit it as success.
        try {
            writeFileSync(join(entry.dir, ".restore-conflict"), new Date(now).toISOString());
        }
        catch {
            void 0;
        }
        return { conflict: true, existing: entry.dir, entry: entry.dir };
    }
    const target = join(dsh, key);
    if (existsSync(target)) {
        try {
            writeFileSync(join(entry.dir, ".restore-conflict"), new Date(now).toISOString());
        }
        catch {
            void 0;
        }
        return { conflict: true, existing: target, entry: entry.dir };
    }
    const source = join(entry.dir, "store");
    renameSync(source, target);
    writeActivityToken(target);
    clearSweptToken(target);
    clearTombstone(baseRoot, key);
    // The entry now holds only its manifest; leaving it behind would accumulate
    // dead directories (and keep the key "restorable" forever).
    try {
        rmSync(entry.dir, { recursive: true, force: true });
    }
    catch {
        void 0;
    }
    return { restoredTo: target, entry: entry.dir };
}
export function tombstonePath(baseRoot, key) {
    return join(gcDirs(baseRoot).gc, "tombstones", key + ".json");
}
/** Remember that this key was quarantined, so a later adoption of the same
 *  workspace path restores the memory instead of silently starting empty
 *  (the recreate-after-quarantine data-loss chain). */
export function writeTombstone(baseRoot, key, entry, now = Date.now()) {
    mkdirSync(join(gcDirs(baseRoot).gc, "tombstones"), { recursive: true, mode: 0o700 });
    atomicWrite(tombstonePath(baseRoot, key), JSON.stringify({ key, entry, at: new Date(now).toISOString() }) + "\n");
}
export function readTombstone(baseRoot, key) {
    try {
        const parsed = JSON.parse(readFileSync(tombstonePath(baseRoot, key), "utf-8"));
        if (typeof parsed.key !== "string" || typeof parsed.entry !== "string" || typeof parsed.at !== "string") {
            return undefined;
        }
        return { key: parsed.key, entry: parsed.entry, at: parsed.at };
    }
    catch {
        return undefined;
    }
}
export function clearTombstone(baseRoot, key) {
    try {
        rmSync(tombstonePath(baseRoot, key), { force: true });
    }
    catch {
        void 0;
    }
}
/** Restore a quarantined store whose key is being adopted again (the same
 *  workspace path was recreated). A live store at the path wins: the tombstone
 *  is stale and is dropped. */
export function restoreTombstonedStore(baseRoot, key, now = Date.now()) {
    return withFileLock(gcDirs(baseRoot).lock, () => restoreTombstonedStoreInner(baseRoot, key, now));
}
function restoreTombstonedStoreInner(baseRoot, key, now) {
    if (!readTombstone(baseRoot, key)) {
        return undefined;
    }
    const target = join(gcDirs(baseRoot).dsh, key);
    if (existsSync(target) && !existsSync(join(target, "index.sqlite"))) {
        // Ghost directory (a late settle re-created state/ after the quarantine).
        // Move it aside instead of deleting: it may hold another process's lease
        // files or a half-created store.
        try {
            renameSync(target, target + ".stale-" + String(now));
        }
        catch {
            void 0;
        }
    }
    if (existsSync(join(target, "index.sqlite"))) {
        // A live or half-created store wins the path, but the tombstone must
        // stay: dropping it would let the quarantined copy be purged later.
        const tombstone = readTombstone(baseRoot, key);
        if (tombstone) {
            if (!entryUsable(tombstone.entry)) {
                // The quarantined copy is gone (purged or removed by hand): the
                // tombstone is stale and must not turn every adoption into a conflict.
                clearTombstone(baseRoot, key);
                return undefined;
            }
            try {
                writeFileSync(join(tombstone.entry, ".restore-conflict"), new Date(now).toISOString());
            }
            catch {
                void 0;
            }
        }
        return { conflict: true, existing: target };
    }
    try {
        const result = restoreStoreInner(baseRoot, key, now);
        if ("conflict" in result) {
            return result;
        }
        clearTombstone(baseRoot, key);
        return { restoredTo: result.restoredTo };
    }
    catch (err) {
        appendLifecycleAudit(baseRoot, {
            at: new Date(now).toISOString(),
            action: "store.restore_failed",
            key,
            reason: String(err),
        });
        // Clear only when the entry itself is gone. A transient rename failure
        // (entry present, store/ still there) must keep the tombstone so a later
        // adoption can retry.
        const tombstone = readTombstone(baseRoot, key);
        if (!tombstone || !entryUsable(tombstone.entry)) {
            clearTombstone(baseRoot, key);
        }
        return undefined;
    }
}
export function appendLifecycleAudit(baseRoot, record) {
    const { gc } = gcDirs(baseRoot);
    mkdirSync(gc, { recursive: true, mode: 0o700 });
    const file = join(gc, "audit.jsonl");
    try {
        if (statSync(file).size > 1_048_576) {
            renameSync(file, file + ".1");
        }
    }
    catch {
        void 0;
    }
    appendFileSync(file, `${JSON.stringify(record)}\n`, {
        mode: 0o600,
    });
}
export function readLifecycleAudit(baseRoot, limit = 50) {
    const { gc } = gcDirs(baseRoot);
    let raw;
    try {
        raw = readFileSync(join(gc, "audit.jsonl"), "utf-8");
    }
    catch {
        return [];
    }
    return raw
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .flatMap((line) => {
        try {
            return [JSON.parse(line)];
        }
        catch {
            return [];
        }
    });
}
/** Execute one reclamation pass.
 *
 *  Destructive steps are fenced twice: the caller's inspection (queue depth,
 *  lease, content) is advisory until the lock re-checks the store inode/mtime,
 *  the absence of a WAL sidecar, the live-session set and the workspace path;
 *  after the rename the moved database is inspected again and the move is
 *  rolled back if any work appeared. Purge is maintenance and runs even when
 *  reclamation itself is disabled. */
export async function executeStoreGc(baseRoot, policy, deps) {
    const result = { quarantined: [], rolledBack: [], skipped: 0, purged: [] };
    const audit = (record) => {
        deps.audit({ at: new Date(deps.now).toISOString(), ...record });
    };
    try {
        result.purged = deps.lock(() => purgeTrash(baseRoot, policy, deps.now));
        for (const dir of result.purged) {
            audit({ action: "store.purge", entry: dir });
        }
    }
    catch {
        void 0;
    }
    if (!(policy.retentionDays > 0) && !(policy.emptyStoreHours > 0)) {
        return result;
    }
    let plan;
    try {
        plan = deps.lock(() => planStoreGc(baseRoot, policy, { now: deps.now, protectedRoots: deps.protectedRoots }));
    }
    catch {
        return result;
    }
    if (plan.candidates.length > 0) {
        audit({
            action: "store.gc_plan",
            candidates: plan.candidates.map((candidate) => candidate.key),
            skipped: plan.skipped.length,
        });
    }
    for (const candidate of plan.candidates) {
        try {
            if (candidate.tier === "orphan") {
                // Two independent passes must agree the workspace is gone: a network
                // mount that is briefly absent must not authorize a destructive move.
                const missingFor = missingAgeMs(candidate.path, deps.now, candidate.workdir);
                if (missingFor === undefined) {
                    markMissing(candidate.path, deps.now, candidate.workdir);
                    result.skipped += 1;
                    audit({ action: "store.quarantine_skipped", key: candidate.key, reason: "missing-unconfirmed" });
                    continue;
                }
                if (missingFor < MISSING_CONFIRM_MS) {
                    result.skipped += 1;
                    audit({ action: "store.quarantine_skipped", key: candidate.key, reason: "missing-unconfirmed" });
                    continue;
                }
            }
            const before = statSync(join(candidate.path, "index.sqlite"));
            const verified = await deps.inspect(candidate.path);
            const deadQueue = candidate.tier === "orphan" && verified !== undefined && verified.pending > 0
                ? staleQueue(candidate.path, deps.now)
                : false;
            if (deadQueue) {
                audit({ action: "store.dead_queue", key: candidate.key, pending: verified?.pending ?? 0 });
            }
            const blockedReason = !verified
                ? "inspect-failed"
                : verified.pending > 0 && !deadQueue
                    ? "pending"
                    : verified.leaseActive
                        ? "lease"
                        : candidate.tier === "empty" && verified.content
                            ? "content"
                            : undefined;
            if (blockedReason !== undefined) {
                result.skipped += 1;
                audit({ action: "store.quarantine_skipped", key: candidate.key, reason: blockedReason });
                continue;
            }
            let entry;
            let fence;
            deps.lock(() => {
                try {
                    const after = statSync(join(candidate.path, "index.sqlite"));
                    if (after.ino !== before.ino || after.mtimeMs !== before.mtimeMs) {
                        fence = "store-changed";
                        return;
                    }
                    if (existsSync(join(candidate.path, "index.sqlite-wal"))) {
                        fence = "wal";
                        return;
                    }
                    if (deps.isProtected(candidate.path)) {
                        fence = "adopted";
                        return;
                    }
                    // Applies to both tiers: an unsettled token means an enqueue may have
                    // committed work this pass cannot see.
                    if (storeIsDirty(candidate.path) &&
                        !(candidate.tier === "orphan" && staleQueue(candidate.path, deps.now))) {
                        fence = "dirty-token";
                        return;
                    }
                    if (candidate.tier === "orphan") {
                        const origin = readStoreOrigin(candidate.path);
                        if (origin &&
                            (existsSync(origin.workdir) ||
                                (origin.realpath !== origin.workdir && existsSync(origin.realpath)))) {
                            fence = "workdir-revived";
                            return;
                        }
                    }
                    entry = quarantineStore(baseRoot, candidate, { sweep: "gc" }, deps.now).entry;
                }
                catch {
                    fence = "error";
                }
            });
            if (entry === undefined) {
                result.skipped += 1;
                audit({ action: "store.quarantine_skipped", key: candidate.key, reason: fence ?? "unknown" });
                continue;
            }
            const quarantinedPath = entry;
            const moved = await deps.inspect(join(quarantinedPath, "store"));
            if (!moved ||
                (moved.pending > 0 && !deadQueue) ||
                moved.leaseActive ||
                (candidate.tier === "empty" && moved.content)) {
                deps.lock(() => {
                    try {
                        renameSync(join(quarantinedPath, "store"), candidate.path);
                        rmSync(quarantinedPath, { recursive: true, force: true });
                        clearTombstone(baseRoot, candidate.key);
                    }
                    catch {
                        // The entry stays; the tombstone still points at it.
                    }
                });
                result.rolledBack.push(candidate.key);
                audit({ action: "store.quarantine_rolled_back", key: candidate.key, tier: candidate.tier, entry: quarantinedPath });
                continue;
            }
            result.quarantined.push(candidate.key);
            audit({
                action: "store.quarantine",
                key: candidate.key,
                tier: candidate.tier,
                workdir: candidate.workdir,
                ageDays: candidate.ageDays,
                bytes: candidate.sizeBytes,
                entry: quarantinedPath,
            });
        }
        catch {
            // One broken candidate must not abort the pass.
        }
    }
    return result;
}
