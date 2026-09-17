import { appendFileSync, chmodSync, closeSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";

// Process start time for lock staleness: a lock whose recorded pid matches
// ours but whose acquisition timestamp predates our process could only have
// been left by a dead process whose pid was reused (see isStaleLock).
export const processStartedAt = Date.now();

// >= SQLite's busy_timeout (20000) so a competitor holding the md lock while
// committing to SQLite never trips a false lock timeout.
export const LOCK_TIMEOUT_MS = 20_000;
// A lock older than this is reclaimed even if its pid appears alive: a crash
// leaves the pid dead (reclaimed immediately, see isStaleLock), so an old
// lock whose pid is alive is a crashed holder whose pid got reused. The
// threshold must sit far above any legitimate hold (SQLite busy_timeout of
// 20s per statement + bulk reindex/import inside the lock), or a slow writer
// loses mutual exclusion to a contender.
export const STALE_LOCK_MS = 300_000;

/** A lock file with no parseable holder token is either mid-creation (the
 *  holder writes pid|timestamp in one call) or crash debris. Reclaim it after
 *  a short grace instead of the full STALE_LOCK_MS: the caller's lock timeout
 *  is 20s, so a 5-minute wait would guarantee a timeout on crash debris. */
export const STALE_EMPTY_LOCK_MS = 5_000;

// Rotate the transaction log once it exceeds this many bytes (two rotated
// segments are kept: <log>.1 and <log>.2).
export const LOG_ROTATE_BYTES = 1_048_576;

function logLockPath(logPath: string): string {
  return `${logPath}.lock`;
}

export function atomicWrite(path: string, content: string): void {
  // A symlinked target must keep receiving updates: rename() would replace
  // the link itself with a regular file, severing the external target.
  try {
    path = realpathSync(path);
  } catch {
    // not yet existing or a broken link: write at the given path
  }
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${Date.now()}-${randomBytes(8).toString("hex")}${extname(path) || ".md"}`);
  let mode = 0o600;
  try {
    mode = statSync(path).mode & 0o777;
  } catch {
    void 0;
  }
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", mode);
    // openSync applies the process umask to newly created files. Explicitly
    // restore the intended mode so replacing an existing 0644/0755 file does
    // not silently downgrade it (for example under umask 0077).
    chmodSync(tmp, mode);
    writeFileSync(fd, content);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmp, path);
    const dirFd = openSync(dirname(path), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        void 0;
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      void 0;
    }
    throw err;
  }
}

export interface LockOptions {
  /** Override LOCK_TIMEOUT_MS (used by tests to exercise the timeout path). */
  timeoutMs?: number;
}

export function withFileLock<T>(lockPath: string, fn: () => T, opts: LockOptions = {}): T {
  // 0700: the locks directory is created on demand and would otherwise inherit
  // the umask; the lock files themselves are 0600.
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  const timeoutMs = opts.timeoutMs ?? LOCK_TIMEOUT_MS;
  const start = Date.now();
  const holder = `${process.pid}|${Date.now()}`;
  for (;;) {
    try {
      writeFileSync(lockPath, holder, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      if (Date.now() - start > timeoutMs) {
        throw new Error(`file lock timeout: ${lockPath}`);
      }
      // Snapshot first, then judge: the reclaim uses the same snapshot to
      // verify that the file it removes is still the one judged stale. The
      // lock may have vanished between EEXIST and the read (a holder released
      // it): retry acquisition immediately.
      const snapshot = lockSnapshot(lockPath);
      if (snapshot === null) {
        continue;
      }
      if (isStaleSnapshot(snapshot)) {
        reclaimStaleLock(lockPath, snapshot);
        continue;
      }
      if (lockHeldByUs(lockPath)) {
        throw new Error(`re-entrant file lock: ${lockPath}`);
      }
      // Bounded synchronous sleep. The wait is capped at LOCK_TIMEOUT_MS (20s),
      // so the worst-case freeze is short even on a single-threaded host
      // process, where contention (another process holding the md lock) briefly
      // stalls event handling. Contention is rare: writers serialize on the
      // same md file, and the daemon itself holds each lock only briefly.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      continue;
    }
    // Keep callback errors outside the acquisition catch. In particular, an
    // EEXIST raised by the protected operation must not be mistaken for lock
    // contention and cause the callback to run a second time.
    try {
      return fn();
    } finally {
      // Release only the lock THIS call wrote. A contender may have reclaimed
      // our lock as stale and created its own at the same path; blindly
      // unlinking would delete the contender's lock and break mutual exclusion
      // for every later holder. The holder token (pid|timestamp) is compared
      // first, and the removal itself goes through the same rename-then-verify
      // path as stale reclaim, so a lock that changes hands in the window is
      // restored instead of deleted.
      const own = lockSnapshot(lockPath);
      if (own === null) {
        // Already gone (reclaimed or released): tolerate ENOENT instead of
        // failing the completed operation.
      } else if (own.raw !== holder) {
        console.warn(`[memcurio] file lock ${lockPath} changed hands before release; leaving it in place`);
      } else {
        reclaimStaleLock(lockPath, own);
      }
    }
  }
}

function lockHeldByUs(lockPath: string): boolean {
  try {
    const [pidStr] = readFileSync(lockPath, "utf-8").trim().split("|");
    return pidStr === String(process.pid);
  } catch {
    return false;
  }
}

export interface LockSnapshot {
  /** Lock content exactly as read (untrimmed); the reclaim compares it
   *  byte-for-byte with the file it moved aside. */
  raw: string;
  ino: number;
  mtimeMs: number;
}

/** Read a lock's content and identity; null when it is missing/unreadable. */
export function lockSnapshot(lockPath: string): LockSnapshot | null {
  try {
    const st = statSync(lockPath);
    return { raw: readFileSync(lockPath, "utf-8"), ino: st.ino, mtimeMs: st.mtimeMs };
  } catch {
    return null;
  }
}

function isStaleSnapshot(snapshot: LockSnapshot): boolean {
  const parts = snapshot.raw.trim().split("|");
  const pidStr = parts[0] ?? "";
  if (!pidStr) {
    return Date.now() - snapshot.mtimeMs > STALE_EMPTY_LOCK_MS;
  }
  const pid = Number(pidStr);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Date.now() - snapshot.mtimeMs > STALE_EMPTY_LOCK_MS;
  }
  if (pid === process.pid) {
    // A lock this process genuinely holds records an acquisition timestamp no
    // earlier than our own start; an older one belongs to a dead process whose
    // pid was reused, and must not wedge the file forever.
    const heldSince = Number(parts[1]);
    return Number.isFinite(heldSince) && heldSince > 0 && heldSince < processStartedAt;
  }
  const age = Date.now() - snapshot.mtimeMs;
  // A crash leaves the pid dead (ESRCH): reclaim immediately. EPERM means the
  // pid belongs to another user (still alive). If the pid is alive but the
  // lock is far older than any legitimate hold time, the pid was almost
  // certainly reused by an unrelated process: reclaim too.
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch (err) {
    alive = (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
  return !alive || age > STALE_LOCK_MS;
}

export function isStaleLock(lockPath: string): boolean {
  const snapshot = lockSnapshot(lockPath);
  // A lock that vanished between EEXIST and this read counts as stale; the
  // acquisition loop retries either way.
  return snapshot === null || isStaleSnapshot(snapshot);
}

/** Reclaim a stale lock without deleting a lock another process acquired in
 *  the meantime. The move to a private name is atomic, so exactly one
 *  contender wins it; the winner verifies the moved file still matches the
 *  snapshot the stale decision was based on (content, inode, mtime) before
 *  unlinking. A mismatch means the path held a freshly created lock at rename
 *  time: it is restored (link() never overwrites an existing path) and the
 *  reclaim is abandoned. Returns true when the sampled lock was removed. */
export function reclaimStaleLock(lockPath: string, snapshot?: LockSnapshot | null): boolean {
  const expected = snapshot ?? lockSnapshot(lockPath);
  if (expected === null) {
    return true; // already gone: the caller can retry acquisition
  }
  // Temp name matches the stale-tmp sweeper pattern and starts with a dot, so
  // a crash between rename and unlink leaves a file that readAll/truncateLog
  // (both keyed on the base log name) never mistake for a log segment.
  const tmp = join(dirname(lockPath), `.tmp-${Date.now()}-${randomBytes(8).toString("hex")}.${basename(lockPath)}`);
  try {
    renameSync(lockPath, tmp);
  } catch {
    // Another contender moved or released the path first. The acquisition loop
    // retries from scratch; nothing was deleted.
    return false;
  }
  const moved = lockSnapshot(tmp);
  if (
    moved !== null &&
    moved.raw === expected.raw &&
    moved.ino === expected.ino &&
    moved.mtimeMs === expected.mtimeMs
  ) {
    try {
      unlinkSync(tmp);
    } catch {
      void 0;
    }
    return true;
  }
  // We moved a lock created after our snapshot. Put the holder's file back if
  // the path is still free; link() is atomic and refuses to overwrite, unlike
  // rename() which would clobber a newer lock.
  try {
    linkSync(tmp, lockPath);
  } catch {
    // Residual three-party window: between our rename and this link another
    // process may have occupied lockPath. The holder whose lock we moved is
    // then silently abandoned (its temp file is dropped below) — but its own
    // release compares the token before unlinking, so it can no longer delete
    // the third party's lock. Strictly better than the old blind unlink, which
    // broke mutual exclusion outright.
    void 0;
  }
  try {
    unlinkSync(tmp);
  } catch {
    void 0;
  }
  return false;
}

export function truncateLog(logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  withFileLock(logLockPath(logPath), () => {
    const dir = dirname(logPath);
    const base = basename(logPath);
    try {
      for (const name of readdirSync(dir)) {
        // Only memcurio's own rotated segments (<base>.1/.2, legacy <base>.<ts>.old)
        // are removed; unrelated files sharing the prefix are left alone.
        const suffix = name.startsWith(`${base}.`) ? name.slice(base.length + 1) : "";
        const isLog = name === base || (suffix !== "" && /^(?:\d+|old|\d+\.old)$/.test(suffix));
        if (isLog) {
          try {
            unlinkSync(join(dir, name));
          } catch {
            void 0;
          }
        }
      }
    } catch {
      void 0;
    }
    writeFileSync(logPath, "", { mode: 0o600 });
  });
}

/** Rename a log larger than maxBytes to <log>.1, keeping one older segment.
 *  Callers must hold the log lock (Transaction.append does). */
export function rotateLog(logPath: string, maxBytes = LOG_ROTATE_BYTES): void {
  try {
    if (statSync(logPath).size <= maxBytes) {
      return;
    }
  } catch {
    return; // no log yet
  }
  try {
    unlinkSync(`${logPath}.2`);
  } catch {
    void 0;
  }
  try {
    renameSync(`${logPath}.1`, `${logPath}.2`);
  } catch {
    void 0;
  }
  try {
    renameSync(logPath, `${logPath}.1`);
  } catch {
    void 0;
  }
}

export interface TxnRecord {
  op: "BEGIN" | "COMMIT" | "ROLLBACK";
  txn: string;
  action?: string;
  ns?: string;
  detail?: string;
  ts: string;
  error?: string;
}

export class Transaction {
  constructor(private readonly logPath: string) {}

  private append(record: TxnRecord): void {
    mkdirSync(dirname(this.logPath), { recursive: true });
    withFileLock(logLockPath(this.logPath), () => {
      rotateLog(this.logPath);
      appendFileSync(this.logPath, `${JSON.stringify(record)}\n`, { encoding: "utf-8", mode: 0o600 });
    });
  }

  run(action: string, ns: string, detail: string, work: () => void): void {
    const txn = randomUUID().slice(0, 12);
    const ts = new Date().toISOString();
    this.append({ op: "BEGIN", txn, action, ns, detail, ts });
    try {
      work();
    } catch (err) {
      this.append({ op: "ROLLBACK", txn, error: String(err), ts: new Date().toISOString() });
      throw err;
    }
    try {
      this.append({ op: "COMMIT", txn, ts: new Date().toISOString() });
    } catch (err) {
      // The md/SQLite writes already committed; failing the caller here would
      // make it retry and duplicate the writes. Retry the append once, and if
      // it still fails, record a COMMIT line carrying the error so pending()
      // resolves this transaction (a bare BEGIN would leave a phantom pending
      // that `repair` misinterprets as an unfinished write).
      try {
        this.append({ op: "COMMIT", txn, ts: new Date().toISOString() });
      } catch {
        try {
          this.append({ op: "COMMIT", txn, error: String(err), ts: new Date().toISOString() });
        } catch (second) {
          console.warn(`[memcurio] failed to record COMMIT for ${txn} (business writes succeeded): ${String(second)}`);
        }
      }
    }
  }

  pending(): TxnRecord[] {
    const { records } = this.readAll();
    const begins = records.filter((r) => r.op === "BEGIN");
    const committed = new Set(records.filter((r) => r.op === "COMMIT").map((r) => r.txn));
    // ROLLBACK marks a transaction whose synchronous md/SQLite writes were
    // already rolled back, so it is resolved and must not count as pending.
    const rolledBack = new Set(records.filter((r) => r.op === "ROLLBACK").map((r) => r.txn));
    return begins.filter((r) => !committed.has(r.txn) && !rolledBack.has(r.txn));
  }

  /** Number of unparsable (torn/corrupt) lines across the log and rotated logs. */
  corruptLines(): number {
    return this.readAll().corrupt;
  }

  private readAll(): { records: TxnRecord[]; corrupt: number } {
    return withFileLock(logLockPath(this.logPath), () => {
      const records: TxnRecord[] = [];
      let corrupt = 0;
      let names: string[] = [];
      try {
        const base = basename(this.logPath);
        names = readdirSync(dirname(this.logPath))
          .filter((n) => !n.endsWith(".lock") && (n === base || n.startsWith(`${base}.`)))
          .sort();
      } catch {
        names = [];
      }
      for (const name of names) {
        try {
          const text = readFileSync(join(dirname(this.logPath), name), "utf-8");
          for (const line of text.split("\n")) {
            if (!line.trim()) {
              continue;
            }
            try {
              records.push(JSON.parse(line) as TxnRecord);
            } catch {
              corrupt += 1;
            }
          }
        } catch {
          // A segment that vanished mid-read is a concurrent truncate; a real
          // read failure is treated as corruption so it is not silently lost.
          corrupt += 1;
        }
      }
      return { records, corrupt };
    });
  }
}
