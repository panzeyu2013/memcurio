import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { basename, dirname, extname, join } from "node:path";

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
  mkdirSync(dirname(lockPath), { recursive: true });
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
      if (isStaleLock(lockPath)) {
        try {
          unlinkSync(lockPath);
        } catch {
          void 0;
        }
        continue;
      }
      if (lockHeldByUs(lockPath)) {
        throw new Error(`re-entrant file lock: ${lockPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      continue;
    }
    // Keep callback errors outside the acquisition catch. In particular, an
    // EEXIST raised by the protected operation must not be mistaken for lock
    // contention and cause the callback to run a second time.
    try {
      return fn();
    } finally {
      unlinkSync(lockPath);
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

export function isStaleLock(lockPath: string): boolean {
  let raw: string;
  let mtimeMs: number;
  try {
    mtimeMs = statSync(lockPath).mtimeMs;
    raw = readFileSync(lockPath, "utf-8").trim();
  } catch {
    return true;
  }
  const parts = raw.split("|");
  const pidStr = parts[0] ?? "";
  if (!pidStr) {
    return Date.now() - mtimeMs > STALE_LOCK_MS;
  }
  const pid = Number(pidStr);
  if (!Number.isFinite(pid) || pid <= 0) {
    return Date.now() - mtimeMs > STALE_LOCK_MS;
  }
  if (pid === process.pid) {
    return false;
  }
  const age = Date.now() - mtimeMs;
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

export function truncateLog(logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  withFileLock(logLockPath(logPath), () => {
    const dir = dirname(logPath);
    const base = basename(logPath);
    try {
      for (const name of readdirSync(dir)) {
        // Only memcore's own rotated segments (<base>.1/.2, legacy <base>.<ts>.old)
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
      appendFileSync(this.logPath, JSON.stringify(record) + "\n", { encoding: "utf-8", mode: 0o600 });
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
    this.append({ op: "COMMIT", txn, ts: new Date().toISOString() });
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
