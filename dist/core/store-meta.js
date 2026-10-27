import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { atomicWrite } from "./transaction.js";
/** Store lifecycle metadata: origin (what workspace this store belongs to) and
 *  the dirty-token pair that lets a periodic sweep decide whether a store may
 *  hold undrained work WITHOUT opening its SQLite database.
 *
 *  Why a token and not a timestamp or a "dirty" flag:
 *  - A flag has to be cleared, and clearing races with a concurrent enqueue
 *    (lost wake-up). Tokens are never cleared: the sweeper records the token it
 *    read before draining, so any enqueue that commits afterwards necessarily
 *    differs from the recorded value.
 *  - A timestamp needs a shared clock and a monotonic ordering across
 *    processes; an opaque token only needs equality.
 *  - The writer stores the token AFTER its enqueue transaction commits, so a
 *    committed job always publishes a token the next sweep can see.
 *
 *  Writers are cheap and non-atomic on purpose: the activity token is rewritten
 *  on every checkpoint (turn/end), and an fsync there would tax the hot path. A
 *  torn or half-written token reads as "torn" (never equal to any recorded
 *  value), which only costs one extra sweep. origin.json is written once per
 *  session and keeps the atomic-write discipline.
 *
 *  A failed token write is not silently lost: the writer leaves
 *  state/activity-failed, which the dirty check treats as dirty until a later
 *  settle clears it. */
export const ORIGIN_VERSION = 1;
const TOKEN_RE = /^[0-9a-z]{1,16}-[0-9a-f]{12}$/;
export function storeStateDir(root) {
    return join(root, "state");
}
export function originPath(root) {
    return join(storeStateDir(root), "origin.json");
}
export function activityPath(root) {
    return join(storeStateDir(root), "activity");
}
export function sweptPath(root) {
    return join(storeStateDir(root), "swept");
}
/** Durable "the last token write failed" marker. Kept separate from the token
 *  so a failed publish cannot be mistaken for a settled store. */
export function activityFailurePath(root) {
    return join(storeStateDir(root), "activity-failed");
}
function readText(path) {
    try {
        return readFileSync(path, "utf-8");
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return "";
        }
        throw err;
    }
}
/** Canonical path used for the liveness probe. An empty workdir (the no-cwd
 *  store) has no canonical path at all: resolving "" would silently yield the
 *  process cwd and make an unrelated directory look like this store's owner. */
export function canonicalWorkdir(workdir) {
    if (!workdir) {
        return "";
    }
    const absolute = resolve(workdir);
    try {
        return realpathSync(absolute);
    }
    catch {
        return absolute;
    }
}
export function readStoreOrigin(root) {
    const raw = readText(originPath(root));
    if (!raw) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw);
        if (parsed.version !== ORIGIN_VERSION || typeof parsed.workdir !== "string") {
            return undefined;
        }
        if (typeof parsed.realpath !== "string") {
            return undefined;
        }
        if (typeof parsed.firstSeenAt !== "string" || typeof parsed.lastActivityAt !== "string") {
            return undefined;
        }
        return {
            version: ORIGIN_VERSION,
            workdir: parsed.workdir,
            realpath: parsed.realpath,
            firstSeenAt: parsed.firstSeenAt,
            lastActivityAt: parsed.lastActivityAt,
        };
    }
    catch {
        return undefined;
    }
}
export function writeStoreOrigin(root, origin) {
    if (!existsSync(root)) {
        return;
    }
    mkdirSync(storeStateDir(root), { recursive: true, mode: 0o700 });
    atomicWrite(originPath(root), `${JSON.stringify(origin)}\n`);
}
function maxIso(a, b) {
    if (!a) {
        return b;
    }
    const left = Date.parse(a);
    const right = Date.parse(b);
    if (!Number.isFinite(left)) {
        return b;
    }
    if (!Number.isFinite(right)) {
        return a;
    }
    return right > left ? b : a;
}
/** Record (or refresh) the origin of one store. Idempotent: firstSeenAt is
 *  preserved and lastActivityAt only moves forward. */
export function recordStoreOrigin(root, workdir, at = new Date().toISOString()) {
    const existing = readStoreOrigin(root);
    const canonical = canonicalWorkdir(workdir);
    const origin = {
        version: ORIGIN_VERSION,
        workdir,
        realpath: canonical,
        firstSeenAt: existing?.firstSeenAt ?? at,
        lastActivityAt: maxIso(existing?.lastActivityAt, at),
    };
    writeStoreOrigin(root, origin);
    return origin;
}
/** Move lastActivityAt forward without rewriting the rest of the record. */
export function touchStoreOriginActivity(root, at = new Date().toISOString()) {
    const existing = readStoreOrigin(root);
    if (!existing) {
        return;
    }
    writeStoreOrigin(root, { ...existing, lastActivityAt: maxIso(existing.lastActivityAt, at) });
}
/** A fresh opaque token. Ordering is irrelevant: only equality with the
 *  recorded swept value is ever compared. */
export function newActivityToken(now = Date.now()) {
    return `${now.toString(36)}-${randomBytes(6).toString("hex")}`;
}
/** Read one token file. ANY read/validation failure degrades to `torn` (never
 *  throws): a corrupted file must not crash the sweep or the plugin load. */
export function readTokenState(path) {
    let raw;
    try {
        raw = readFileSync(path, "utf-8");
    }
    catch (err) {
        if (err.code === "ENOENT") {
            return { kind: "absent" };
        }
        return { kind: "torn" };
    }
    const trimmed = raw.trim();
    return TOKEN_RE.test(trimmed) ? { kind: "token", value: trimmed } : { kind: "torn" };
}
export function readActivityState(root) {
    return readTokenState(activityPath(root));
}
export function readSweptState(root) {
    return readTokenState(sweptPath(root));
}
/** True when the last token write failed (or a torn marker exists). */
export function hasActivityFailure(root) {
    try {
        readFileSync(activityFailurePath(root));
        return true;
    }
    catch (err) {
        return err.code !== "ENOENT";
    }
}
/** Publish the dirty token, leaving the durable failure marker if the write
 *  fails (the enqueue already committed). */
export function publishActivitySafely(root) {
    try {
        writeActivityToken(root);
    }
    catch (err) {
        markActivityFailure(root, `activity token write failed: ${String(err)}`);
    }
}
/** Leave a durable trace that a publish failed. The file stays until a later
 *  settle proves the queue empty, so a committed job can never be invisible. */
export function markActivityFailure(root, detail) {
    if (!existsSync(root)) {
        return;
    }
    try {
        mkdirSync(storeStateDir(root), { recursive: true, mode: 0o700 });
        writeFileSync(activityFailurePath(root), `${new Date().toISOString()} ${detail}\n`, { mode: 0o600 });
    }
    catch {
        // Best effort: the caller already logged the original failure.
    }
}
export function clearActivityFailure(root, observedAt) {
    try {
        // A failure recorded AFTER the drain started belongs to an enqueue this
        // settle never saw; clearing it would hide a committed job.
        // Same-millisecond writes are kept: a concurrent enqueue that failed its
        // token write must never be mistaken for a marker this drain already saw.
        if (observedAt !== undefined && Math.floor(statSync(activityFailurePath(root)).mtimeMs) >= observedAt) {
            return;
        }
        unlinkSync(activityFailurePath(root));
    }
    catch (err) {
        if (err.code !== "ENOENT") {
            throw err;
        }
    }
}
/** True when this store may hold work the periodic sweep should look at.
 *  Absent/absent is the only state considered settled: everything else (a token
 *  that differs, a torn file, a token with no swept value, a failed publish)
 *  means "open it once and find out". */
export function isStoreDirty(activity, swept, failed = false) {
    if (failed) {
        return true;
    }
    if (activity.kind === "torn") {
        return true;
    }
    if (activity.kind === "absent") {
        return swept.kind !== "absent";
    }
    return !(swept.kind === "token" && swept.value === activity.value);
}
export function storeIsDirty(root) {
    return isStoreDirty(readActivityState(root), readSweptState(root), hasActivityFailure(root));
}
/** Cheap, tear-tolerant token publication. Deliberately NOT atomicWrite: this
 *  runs once per checkpoint and the only consequence of an unreadable token is
 *  one extra sweep (a torn value never compares equal to swept). */
export function writeActivityToken(root, token = newActivityToken()) {
    // A quarantined store must not be resurrected as an empty directory by a
    // late settle: that ghost would defeat restore-on-adopt.
    if (!existsSync(root)) {
        return token;
    }
    mkdirSync(storeStateDir(root), { recursive: true, mode: 0o700 });
    writeFileSync(activityPath(root), token, { mode: 0o600 });
    return token;
}
export function writeSweptToken(root, token) {
    if (!existsSync(root)) {
        return;
    }
    mkdirSync(storeStateDir(root), { recursive: true, mode: 0o700 });
    writeFileSync(sweptPath(root), token, { mode: 0o600 });
}
/** Forget the swept watermark (never the activity token). Used when the store
 *  becomes clean after an absent activity token and by restore, so a restored
 *  store is re-examined on the next sweep. */
export function clearSweptToken(root) {
    try {
        unlinkSync(sweptPath(root));
    }
    catch (err) {
        if (err.code !== "ENOENT") {
            throw err;
        }
    }
}
/** Apply the post-drain rule that keeps the token protocol race-free:
 *
 *  - count == 0 and the activity token read before the drain is a token ->
 *    record it as swept (the store is settled for that token);
 *  - count == 0 with an absent activity token -> drop swept as well;
 *  - count == 0 with a torn token -> repair with a fresh token and stay dirty
 *    (there is no trustworthy value to record);
 *  - count > 0 -> never advance; repair a missing/torn token so the store keeps
 *    being noticed.
 *
 *  The advancement value is always the token observed BEFORE the drain, never a
 *  fresh read: an enqueue that committed in between publishes a different
 *  token, so the store stays dirty and is examined again. */
export function settleAfterDrain(root, snapshot, count, observedAt = Date.now()) {
    if (count <= 0) {
        clearActivityFailure(root, observedAt);
        if (snapshot.kind === "token") {
            writeSweptToken(root, snapshot.value);
            return "advanced";
        }
        if (snapshot.kind === "absent") {
            clearSweptToken(root);
            return "advanced";
        }
        writeActivityToken(root);
        return "repaired";
    }
    if (snapshot.kind !== "token") {
        writeActivityToken(root);
        return "repaired";
    }
    return "pending";
}
/** Cross-process ownership fence for the lifecycle GC.
 *
 *  A live session writes one lease file per (pid, session); the plugin's
 *  periodic sweep refreshes it, so a session that sits idle is still visibly
 *  owned. Any process's GC sees the file, which closes the window where a store
 *  used by another harness process could be quarantined. Stale files (no
 *  heartbeat within SESSION_LEASE_STALE_MS) are ignored and pruned. */
export const SESSION_LEASE_STALE_MS = 15 * 60_000;
export function sessionLeaseDir(root) {
    return join(storeStateDir(root), "live");
}
function sessionLeaseName(pid, sessionId) {
    const safe = sessionId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80) || "session";
    return `${pid}-${safe}.json`;
}
export function touchSessionLease(root, pid, sessionId, at = Date.now()) {
    if (!existsSync(root)) {
        return;
    }
    try {
        const dir = sessionLeaseDir(root);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        writeFileSync(join(dir, sessionLeaseName(pid, sessionId)), JSON.stringify({ pid, sessionId, at: new Date(at).toISOString() }), { mode: 0o600 });
    }
    catch {
        // A failed heartbeat only costs the fence its strongest signal; the age
        // gate still protects the store.
    }
}
export function clearSessionLease(root, pid, sessionId) {
    try {
        unlinkSync(join(sessionLeaseDir(root), sessionLeaseName(pid, sessionId)));
    }
    catch (err) {
        if (err.code !== "ENOENT") {
            throw err;
        }
    }
}
/** True when any session lease is fresh enough to mean "someone is using this
 *  store right now" (in any process). */
export function sessionLeaseActive(root, now = Date.now(), staleMs = SESSION_LEASE_STALE_MS) {
    const dir = sessionLeaseDir(root);
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return false;
    }
    for (const name of names) {
        try {
            const file = join(dir, name);
            if (now - statSync(file).mtimeMs > staleMs) {
                continue;
            }
            // A lease left by a dead process is stale immediately, not after 15 min:
            // otherwise it hides the store from the startup pass.
            const parsed = JSON.parse(readFileSync(file, "utf-8"));
            if (typeof parsed.pid === "number" && parsed.pid !== process.pid && !processAlive(parsed.pid)) {
                continue;
            }
            return true;
        }
        catch {
            // A torn lease is still evidence that someone wrote it: fail closed
            // while its mtime is fresh.
            try {
                const file = join(dir, name);
                if (now - statSync(file).mtimeMs <= staleMs) {
                    return true;
                }
            }
            catch {
                void 0;
            }
        }
    }
    return false;
}
function processAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === "EPERM";
    }
}
/** Drop lease files whose owner stopped heartbeating. */
export function pruneSessionLeases(root, now = Date.now(), staleMs = SESSION_LEASE_STALE_MS) {
    const dir = sessionLeaseDir(root);
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return 0;
    }
    let removed = 0;
    for (const name of names) {
        try {
            if (now - statSync(join(dir, name)).mtimeMs > staleMs) {
                unlinkSync(join(dir, name));
                removed += 1;
            }
        }
        catch {
            void 0;
        }
    }
    return removed;
}
