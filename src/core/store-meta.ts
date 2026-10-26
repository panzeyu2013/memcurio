import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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

export const ORIGIN_VERSION = 1 as const;

/** Shape of state/origin.json: the workspace a store was created for. */
export interface StoreOrigin {
  version: typeof ORIGIN_VERSION;
  /** Raw working directory the session reported (may be "" for no-cwd). */
  workdir: string;
  /** Canonical (realpath) form of workdir; the liveness probe target. */
  realpath: string;
  firstSeenAt: string;
  lastActivityAt: string;
  workspaceId?: string;
}

/** One token state as read from disk. `absent` means "never written"; `torn`
 *  means the file exists but does not hold a full token (mid-write, truncated,
 *  or corrupted) and must never satisfy an equality check. */
export type TokenState =
  | { kind: "absent" }
  | { kind: "torn" }
  | { kind: "token"; value: string };

/** What settled a store after a drain, for logging/statistics. */
export type DrainSettlement = "advanced" | "pending" | "repaired" | "unchanged";

const TOKEN_RE = /^[0-9a-z]{1,16}-[0-9a-f]{12}$/;

export function storeStateDir(root: string): string {
  return join(root, "state");
}

export function originPath(root: string): string {
  return join(storeStateDir(root), "origin.json");
}

export function activityPath(root: string): string {
  return join(storeStateDir(root), "activity");
}

export function sweptPath(root: string): string {
  return join(storeStateDir(root), "swept");
}

/** Durable "the last token write failed" marker. Kept separate from the token
 *  so a failed publish cannot be mistaken for a settled store. */
export function activityFailurePath(root: string): string {
  return join(storeStateDir(root), "activity-failed");
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw err;
  }
}

/** Canonical path used for the liveness probe. An empty workdir (the no-cwd
 *  store) has no canonical path at all: resolving "" would silently yield the
 *  process cwd and make an unrelated directory look like this store's owner. */
export function canonicalWorkdir(workdir: string): string {
  if (!workdir) {
    return "";
  }
  const absolute = resolve(workdir);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function readStoreOrigin(root: string): StoreOrigin | undefined {
  const raw = readText(originPath(root));
  if (!raw) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<StoreOrigin>;
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
      ...(typeof parsed.workspaceId === "string" && parsed.workspaceId ? { workspaceId: parsed.workspaceId } : {}),
    };
  } catch {
    return undefined;
  }
}

export function writeStoreOrigin(root: string, origin: StoreOrigin): void {
  mkdirSync(storeStateDir(root), { recursive: true, mode: 0o700 });
  atomicWrite(originPath(root), JSON.stringify(origin) + "\n");
}

function maxIso(a: string | undefined, b: string): string {
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
export function recordStoreOrigin(
  root: string,
  workdir: string,
  at = new Date().toISOString(),
  workspaceId?: string,
): StoreOrigin {
  const existing = readStoreOrigin(root);
  const canonical = canonicalWorkdir(workdir);
  const origin: StoreOrigin = {
    version: ORIGIN_VERSION,
    workdir,
    realpath: canonical,
    firstSeenAt: existing?.firstSeenAt ?? at,
    lastActivityAt: maxIso(existing?.lastActivityAt, at),
    ...(workspaceId ?? existing?.workspaceId ? { workspaceId: workspaceId ?? existing?.workspaceId } : {}),
  };
  writeStoreOrigin(root, origin);
  return origin;
}

/** Move lastActivityAt forward without rewriting the rest of the record. */
export function touchStoreOriginActivity(root: string, at = new Date().toISOString()): void {
  const existing = readStoreOrigin(root);
  if (!existing) {
    return;
  }
  writeStoreOrigin(root, { ...existing, lastActivityAt: maxIso(existing.lastActivityAt, at) });
}

/** A fresh opaque token. Ordering is irrelevant: only equality with the
 *  recorded swept value is ever compared. */
export function newActivityToken(now = Date.now()): string {
  return now.toString(36) + "-" + randomBytes(6).toString("hex");
}

/** Read one token file. ANY read/validation failure degrades to `torn` (never
 *  throws): a corrupted file must not crash the sweep or the plugin load. */
export function readTokenState(path: string): TokenState {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent" };
    }
    return { kind: "torn" };
  }
  const trimmed = raw.trim();
  return TOKEN_RE.test(trimmed) ? { kind: "token", value: trimmed } : { kind: "torn" };
}

export function readActivityState(root: string): TokenState {
  return readTokenState(activityPath(root));
}

export function readSweptState(root: string): TokenState {
  return readTokenState(sweptPath(root));
}

/** True when the last token write failed (or a torn marker exists). */
export function hasActivityFailure(root: string): boolean {
  try {
    readFileSync(activityFailurePath(root));
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Leave a durable trace that a publish failed. The file stays until a later
 *  settle proves the queue empty, so a committed job can never be invisible. */
export function markActivityFailure(root: string, detail: string): void {
  try {
    mkdirSync(storeStateDir(root), { recursive: true, mode: 0o700 });
    writeFileSync(activityFailurePath(root), new Date().toISOString() + " " + detail + "\n", { mode: 0o600 });
  } catch {
    // Best effort: the caller already logged the original failure.
  }
}

export function clearActivityFailure(root: string, observedAt?: number): void {
  try {
    // A failure recorded AFTER the drain started belongs to an enqueue this
    // settle never saw; clearing it would hide a committed job.
    // Same-millisecond writes are kept: a concurrent enqueue that failed its
    // token write must never be mistaken for a marker this drain already saw.
    if (observedAt !== undefined && Math.floor(statSync(activityFailurePath(root)).mtimeMs) >= observedAt) {
      return;
    }
    unlinkSync(activityFailurePath(root));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/** True when this store may hold work the periodic sweep should look at.
 *  Absent/absent is the only state considered settled: everything else (a token
 *  that differs, a torn file, a token with no swept value, a failed publish)
 *  means "open it once and find out". */
export function isStoreDirty(activity: TokenState, swept: TokenState, failed = false): boolean {
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

export function storeIsDirty(root: string): boolean {
  return isStoreDirty(readActivityState(root), readSweptState(root), hasActivityFailure(root));
}

/** Cheap, tear-tolerant token publication. Deliberately NOT atomicWrite: this
 *  runs once per checkpoint and the only consequence of an unreadable token is
 *  one extra sweep (a torn value never compares equal to swept). */
export function writeActivityToken(root: string, token = newActivityToken()): string {
  mkdirSync(storeStateDir(root), { recursive: true, mode: 0o700 });
  writeFileSync(activityPath(root), token, { mode: 0o600 });
  return token;
}

export function writeSweptToken(root: string, token: string): void {
  mkdirSync(storeStateDir(root), { recursive: true, mode: 0o700 });
  writeFileSync(sweptPath(root), token, { mode: 0o600 });
}

/** Forget the swept watermark (never the activity token). Used when the store
 *  becomes clean after an absent activity token and by restore, so a restored
 *  store is re-examined on the next sweep. */
export function clearSweptToken(root: string): void {
  try {
    unlinkSync(sweptPath(root));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
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
export function settleAfterDrain(
  root: string,
  snapshot: TokenState,
  count: number,
  observedAt = Date.now(),
): DrainSettlement {
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
