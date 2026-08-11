import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import type { EvidenceInput } from "../../core/extract.js";
import { Index } from "../../core/db.js";
import { indexDb } from "../../core/paths.js";
import { atomicWrite, withFileLock } from "../../core/transaction.js";

const SPOOL_RELATIVE_DIR = "state/codex-spool";
const SPOOL_VERSION = 1;
const MAX_SPOOL_BYTES = 8 * 1024 * 1024;
const MAX_SPOOL_TOTAL_BYTES = 64 * 1024 * 1024;
const MAX_SPOOL_RECORDS = 4096;
const DEAD_SPOOL_RETENTION_MS = 30 * 86_400_000;
const MAX_DEAD_SPOOL_RECORDS = 256;
const MAX_DEAD_SPOOL_TOTAL_BYTES = 64 * 1024 * 1024;
const SPOOL_CAPACITY_LOCK = ".capacity.lock";

export interface CodexSpoolRecord {
  version: 1;
  id: string;
  createdAt: string;
  input: Record<string, unknown>;
  transcriptEvidence: EvidenceInput[];
}

export type CodexSpoolLog = (message: string, extra?: Record<string, unknown>) => void;

export function codexSpoolDir(root: string): string {
  return join(root, SPOOL_RELATIVE_DIR);
}

function ensureSpoolDir(root: string): string {
  const dir = codexSpoolDir(root);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best effort on filesystems without chmod support.
  }
  return dir;
}

function activeSpoolNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((entry) => /^[a-z0-9-]{16,80}\.json$/.test(entry)).sort();
  } catch {
    return [];
  }
}

function pruneExpiredDeadSpool(dir: string, now = Date.now()): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  const entries = names
    .filter((entry) => /^[a-z0-9-]{16,80}\.json\.dead$/.test(entry))
    .flatMap((name) => {
      try {
        const stat = statSync(join(dir, name));
        return [{ name, size: stat.size, mtimeMs: stat.mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name));
  let retainedBytes = entries.reduce((total, entry) => total + entry.size, 0);
  let retainedCount = entries.length;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    const expired = now - entry.mtimeMs > DEAD_SPOOL_RETENTION_MS;
    const overCapacity = retainedCount > MAX_DEAD_SPOOL_RECORDS || retainedBytes > MAX_DEAD_SPOOL_TOTAL_BYTES;
    if (!expired && !overCapacity) {
      continue;
    }
    try {
      unlinkSync(path);
      retainedCount -= 1;
      retainedBytes -= entry.size;
      removed += 1;
    } catch {
      // Best effort: a concurrent doctor/drain may already have handled it.
    }
  }
  return removed;
}

export interface CodexSpoolStats {
  active: number;
  dead: number;
  activeBytes: number;
  overCapacity: boolean;
}

export function inspectCodexSpool(root: string): CodexSpoolStats {
  const dir = codexSpoolDir(root);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { active: 0, dead: 0, activeBytes: 0, overCapacity: false };
  }
  const activeNames = names.filter((entry) => /^[a-z0-9-]{16,80}\.json$/.test(entry));
  const dead = names.filter((entry) => /^[a-z0-9-]{16,80}\.json\.dead$/.test(entry)).length;
  let activeBytes = 0;
  let oversized = false;
  for (const name of activeNames) {
    try {
      const size = statSync(join(dir, name)).size;
      activeBytes += size;
      oversized ||= size > MAX_SPOOL_BYTES;
    } catch {
      // Concurrent drains can remove a file after readdir.
    }
  }
  return {
    active: activeNames.length,
    dead,
    activeBytes,
    overCapacity: oversized || activeNames.length >= MAX_SPOOL_RECORDS || activeBytes >= MAX_SPOOL_TOTAL_BYTES,
  };
}

/** Persist the complete SessionEnd payload before the hook attempts a daemon
 * connection. `atomicWrite` fsyncs the file and its directory, so a killed
 * hook leaves either the old record or the complete new record. */
export function writeCodexSessionEndSpool(
  root: string,
  input: Record<string, unknown>,
  transcriptEvidence: readonly EvidenceInput[],
): string {
  const dir = ensureSpoolDir(root);
  pruneExpiredDeadSpool(dir);
  const id = randomUUID();
  const path = join(dir, `${id}.json`);
  const record: CodexSpoolRecord = {
    version: SPOOL_VERSION,
    id,
    createdAt: new Date().toISOString(),
    input,
    transcriptEvidence: transcriptEvidence.map((item) => ({ ...item })),
  };
  const serialized = `${JSON.stringify(record)}\n`;
  const bytes = Buffer.byteLength(serialized);
  if (bytes > MAX_SPOOL_BYTES) {
    throw new Error(`Codex spool record exceeds ${MAX_SPOOL_BYTES} bytes`);
  }
  // Capacity check + rename must be one cross-process critical section.
  // SessionEnd has a short process budget, so contention fails closed quickly
  // and lets Codex retry instead of waiting behind an unbounded hook queue.
  return withFileLock(join(dir, SPOOL_CAPACITY_LOCK), () => {
    const stats = inspectCodexSpool(root);
    if (stats.active >= MAX_SPOOL_RECORDS || stats.activeBytes + bytes > MAX_SPOOL_TOTAL_BYTES) {
      throw new Error(`Codex spool capacity exceeded (${stats.active} records, ${stats.activeBytes} bytes)`);
    }
    atomicWrite(path, serialized);
    return path;
  }, { timeoutMs: 250 });
}

function validRecord(value: unknown): value is CodexSpoolRecord {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Partial<CodexSpoolRecord>;
  return record.version === SPOOL_VERSION
    && typeof record.id === "string"
    && /^[a-z0-9-]{16,80}$/.test(record.id)
    && typeof record.createdAt === "string"
    && Boolean(record.input && typeof record.input === "object" && !Array.isArray(record.input))
    && Array.isArray(record.transcriptEvidence);
}

export function readCodexSpoolRecords(root: string, log: CodexSpoolLog = () => {}): Array<{ path: string; record: CodexSpoolRecord }> {
  const dir = ensureSpoolDir(root);
  pruneExpiredDeadSpool(dir);
  const records: Array<{ path: string; record: CodexSpoolRecord }> = [];
  for (const name of activeSpoolNames(dir)) {
    const path = join(dir, name);
    const record = readSpoolRecord(path, log);
    if (record) {
      records.push({ path, record });
    }
  }
  return records;
}

function readSpoolRecord(path: string, log: CodexSpoolLog): CodexSpoolRecord | undefined {
  try {
    if (statSync(path).size > MAX_SPOOL_BYTES) {
      throw new Error(`spool record exceeds ${MAX_SPOOL_BYTES} bytes`);
    }
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    if (!validRecord(parsed)) {
      throw new Error("invalid spool record");
    }
    return parsed;
  } catch (err) {
    // Keep a recoverable forensic copy out of the active queue. A malformed
    // record must not block every later SessionEnd record forever.
    try {
      renameSync(path, `${path}.dead`);
    } catch {
      // The next daemon start can retry the rename/read.
    }
    log("invalid Codex spool record", { path, error: String(err) });
    return undefined;
  }
}

export function removeCodexSpool(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

/** Map a hook event name to the engine's queue sourceEvent naming. */
function queueSourceEvent(hookEventName: string): string {
  if (hookEventName === "SessionEnd") {
    return "session_end";
  }
  if (hookEventName === "Stop") {
    return "idle";
  }
  if (hookEventName === "PostCompact") {
    return "post_compact";
  }
  return hookEventName.toLowerCase();
}

/** True when a live job for the same host/session/source event already exists.
 *  The SessionEnd hook writes its spool record before knowing whether the
 *  daemon accepted the event directly; when the daemon did, the replayed
 *  record would otherwise create a second job whose evidence hash differs
 *  from the direct delivery (transcript-only vs full snapshot), defeating
 *  the queue's idempotency key. Dead jobs are deliberately NOT matched: a
 *  dead-lettered delivery deserves a fresh attempt from the spool. */
async function hasLiveJob(root: string, host: string, sessionId: string, sourceEvent: string): Promise<boolean> {
  if (!sessionId || !sourceEvent) {
    return false;
  }
  try {
    const idx = await Index.create(indexDb(root));
    try {
      const rows = idx.rawAll<{ job_id: string }>(
        `SELECT job_id FROM extraction_jobs
         WHERE host=? AND session_id=? AND source_event=?
           AND status IN ('pending','processing','completed','blocked')
         LIMIT 1`,
        [host, sessionId, sourceEvent],
      );
      return rows.length > 0;
    } finally {
      idx.close();
    }
  } catch {
    // A locked/unavailable store must not block the drain; the spool record
    // stays and the next daemon start retries it.
    return false;
  }
}

/** Drain records after the daemon is listening. The handler remains the single
 * source of session/queue idempotency; a record is removed only after a
 * non-error handler response. */
export async function drainCodexSpool(
  root: string,
  handle: (input: unknown) => Promise<Record<string, unknown>>,
  log: CodexSpoolLog = () => {},
): Promise<number> {
  let drained = 0;
  const dir = ensureSpoolDir(root);
  pruneExpiredDeadSpool(dir);
  // Parse and process one record at a time. Capacity is bounded for new
  // writes, and this streaming path also safely recovers older oversized
  // queues without loading every transcript into memory at once.
  for (const name of activeSpoolNames(dir)) {
    const path = join(dir, name);
    const record = readSpoolRecord(path, log);
    if (!record) {
      continue;
    }
    const hookEventName = typeof record.input.hook_event_name === "string" ? record.input.hook_event_name : "";
    const sessionId = typeof record.input.session_id === "string" ? record.input.session_id : "";
    const sourceEvent = queueSourceEvent(hookEventName);
    if (await hasLiveJob(root, "codex", sessionId, sourceEvent)) {
      log("Codex spool record already processed; dropping replay", { id: record.id });
      removeCodexSpool(path);
      continue;
    }
    try {
      const output = await handle({
        ...record.input,
        __memcurio_spool_id: record.id,
        __memcurio_transcript_evidence: record.transcriptEvidence,
      });
      const systemMessage = typeof output.systemMessage === "string" ? output.systemMessage : "";
      if (output.continue === true && !systemMessage.startsWith("memcurio error")) {
        removeCodexSpool(path);
        drained += 1;
      } else {
        log("Codex spool record was not acknowledged", { id: record.id });
      }
    } catch (err) {
      log("Codex spool drain failed", { id: record.id, error: String(err) });
    }
  }
  return drained;
}
