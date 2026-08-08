import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.tmp-${Date.now()}-${randomBytes(8).toString("hex")}.md`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
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
    let fd: number | null = null;
    try {
      fd = openSync(lockPath, "wx");
      writeFileSync(fd, holder);
      try {
        return fn();
      } finally {
        closeSync(fd);
        unlinkSync(lockPath);
      }
    } catch (err) {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          void 0;
        }
      }
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      if (Date.now() - start > 5000) {
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
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

function isStaleLock(lockPath: string): boolean {
  try {
    const [pidStr, tsStr] = readFileSync(lockPath, "utf-8").trim().split("|");
    const pid = Number(pidStr);
    const ts = Number(tsStr);
    if (!Number.isFinite(pid) || !Number.isFinite(ts)) {
      return true;
    }
    if (pid === process.pid) {
      return false;
    }
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() - ts > 60_000) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
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
    appendFileSync(this.logPath, JSON.stringify(record) + "\n", "utf-8");
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
    try {
      return readFileSync(this.logPath, "utf-8")
        .split("\n")
        .filter((l) => l.trim())
        .map((l, i) => {
          try {
            return JSON.parse(l) as TxnRecord;
          } catch {
            return { op: "BEGIN", txn: `unparsable-line-${i}`, ts: "" };
          }
        });
    } catch {
      return [];
    }
  }
}
