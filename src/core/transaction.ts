import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

export const LOCK_TIMEOUT_MS = 5_000;
export const STALE_LOCK_MS = 60_000;

export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${Date.now()}-${randomBytes(8).toString("hex")}.md`);
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

export function withFileLock<T>(lockPath: string, fn: () => T): T {
  mkdirSync(dirname(lockPath), { recursive: true });
  const start = Date.now();
  const holder = `${process.pid}|${Date.now()}`;
  for (;;) {
    try {
      writeFileSync(lockPath, holder, { flag: "wx" });
      try {
        return fn();
      } finally {
        unlinkSync(lockPath);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
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
  try {
    process.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      return false;
    }
    return true;
  }
  const ts = Number(parts[1]);
  if (!Number.isFinite(ts)) {
    return false;
  }
  return Date.now() - ts > STALE_LOCK_MS;
}

export function truncateLog(logPath: string): void {
  mkdirSync(dirname(logPath), { recursive: true });
  rotateLog(logPath);
  writeFileSync(logPath, "");
}

export function rotateLog(logPath: string, maxBytes = 1_048_576): void {
  try {
    const size = statSync(logPath).size;
    if (size <= maxBytes) {
      return;
    }
    renameSync(logPath, `${logPath}.${Date.now()}.old`);
  } catch {
    // no log yet
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
    appendFileSync(this.logPath, JSON.stringify(record) + "\n", { encoding: "utf-8", mode: 0o600 });
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
    const records = this.readAll();
    const begins = records.filter((r) => r.op === "BEGIN");
    const closed = new Set(records.filter((r) => r.op === "COMMIT" || r.op === "ROLLBACK").map((r) => r.txn));
    return begins.filter((r) => !closed.has(r.txn));
  }

  private readAll(): TxnRecord[] {
    const records: TxnRecord[] = [];
    let names: string[] = [];
    try {
      const base = basename(this.logPath);
      names = readdirSync(dirname(this.logPath))
        .filter((n) => n === base || n.startsWith(`${base}.`))
        .sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      try {
        const text = readFileSync(join(dirname(this.logPath), name), "utf-8");
        text
          .split("\n")
          .filter((l) => l.trim())
          .map((l, i) => {
            try {
              return JSON.parse(l) as TxnRecord;
            } catch {
              return { op: "BEGIN", txn: `unparsable-line-${i}`, ts: "" } as TxnRecord;
            }
          })
          .forEach((r) => records.push(r));
      } catch {
        void 0;
      }
    }
    return records;
  }
}
