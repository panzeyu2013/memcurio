import { readFileSync, statSync } from "node:fs";

import type { Index } from "./db.js";
import { KINDS, updateKindsAtomically } from "./mdStore.js";
import type { Entry, Kind, Status } from "./mdStore.js";
import { assertValidNs, nsDir } from "./paths.js";
import { redactSecrets, scanInjection } from "./sanitize.js";
import { atomicWrite } from "./transaction.js";
import { derivedEntryId, ENTRY_ID_RE } from "./ids.js";

export interface ExportRow {
  entryId: string;
  ns: string;
  kind: Kind;
  content: string;
  createdAt: string;
  status: Status;
  pinned: boolean;
  lastUsedAt: string | null;
  useCount: number;
  valueScore: number;
}

export const MAX_MEMORY_CONTENT_CHARS = 100_000;

function validTimestamp(value: string): boolean {
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function toExportRow(e: Entry): ExportRow {
  return {
    entryId: e.entryId,
    ns: e.ns,
    kind: e.kind,
    content: e.content,
    createdAt: e.createdAt,
    status: e.status,
    pinned: e.pinned,
    lastUsedAt: e.lastUsedAt,
    useCount: e.useCount,
    valueScore: e.valueScore,
  };
}

export function serializeExport(entries: Entry[]): string {
  // "deleted" rows are physical-removal markers, never real state (forget
  // removes from truth; parseExport rejects them), so they must not enter an
  // export stream or export -> import round-trips would fail on them.
  return `${entries
    .filter((e) => e.status !== "deleted")
    .map((e) => JSON.stringify(toExportRow(e)))
    .join("\n")}\n`;
}

export function parseExport(text: string): Entry[] {
  const out: Entry[] = [];
  let lineNo = 0;
  for (const line of text.split("\n")) {
    lineNo += 1;
    if (!line.trim()) {
      continue;
    }
    let r: Partial<ExportRow>;
    try {
      r = JSON.parse(line) as Partial<ExportRow>;
    } catch {
      throw new Error(`invalid export line ${lineNo}: not valid JSON`);
    }
    if (!r.entryId || typeof r.entryId !== "string" || !ENTRY_ID_RE.test(r.entryId)) {
      throw new Error(`invalid export line ${lineNo}: entryId must be legacy 8-hex or new 32-hex`);
    }
    if (typeof r.content !== "string" || !r.content.trim() || r.content.length > MAX_MEMORY_CONTENT_CHARS) {
      throw new Error(`invalid export line ${lineNo}: content must be 1-${MAX_MEMORY_CONTENT_CHARS} characters`);
    }
    if (typeof r.createdAt !== "string" || !validTimestamp(r.createdAt)) {
      throw new Error(`invalid export line ${lineNo}: createdAt must be a valid timestamp`);
    }
    const kind = r.kind ?? "MEMORY";
    if (!KINDS.includes(kind)) {
      throw new Error(`invalid export line ${lineNo}: kind ${JSON.stringify(kind)}`);
    }
    const status = (r.status ?? "active") as Status;
    if (!["active", "stale", "archived", "deleted"].includes(status)) {
      throw new Error(`invalid export line ${lineNo}: status ${JSON.stringify(status)}`);
    }
    if (status === "deleted") {
      // Nothing in the system writes "deleted" rows (forget physically
      // removes); accepting them on import would create unprunable zombies.
      throw new Error(`invalid export line ${lineNo}: status "deleted" is not importable`);
    }
    if (r.pinned !== undefined && typeof r.pinned !== "boolean") {
      throw new Error(`invalid export line ${lineNo}: pinned must be a boolean`);
    }
    if (r.useCount !== undefined && (!Number.isInteger(r.useCount) || r.useCount < 0)) {
      throw new Error(`invalid export line ${lineNo}: useCount must be a non-negative integer`);
    }
    if (
      r.valueScore !== undefined &&
      (typeof r.valueScore !== "number" || !Number.isFinite(r.valueScore) || r.valueScore < 0 || r.valueScore > 2)
    ) {
      throw new Error(`invalid export line ${lineNo}: valueScore must be a number in [0, 2]`);
    }
    if (r.lastUsedAt !== undefined && r.lastUsedAt !== null && (typeof r.lastUsedAt !== "string" || !validTimestamp(r.lastUsedAt))) {
      throw new Error(`invalid export line ${lineNo}: lastUsedAt must be a valid timestamp or null`);
    }
    if (r.ns !== undefined && typeof r.ns !== "string") {
      throw new Error(`invalid export line ${lineNo}: ns must be a string`);
    }
    out.push({
      entryId: r.entryId,
      ns: assertValidNs(r.ns ?? "default"),
      kind,
      content: r.content,
      createdAt: r.createdAt,
      status,
      pinned: r.pinned ?? false,
      lastUsedAt: r.lastUsedAt ?? null,
      useCount: r.useCount ?? 0,
      valueScore: r.valueScore ?? 1,
    });
  }
  return out;
}

export function writeExport(path: string, entries: Entry[]): void {
  atomicWrite(path, serializeExport(entries));
}

export interface ImportPlan {
  added: Entry[];
  skippedExisting: number;
  skippedDuplicate: number;
  conflicts: Array<{ entryId: string; ns: string }>;
}

export function planImport(parsed: Entry[], idx: Index, nsOverride?: string): ImportPlan {
  const plan: ImportPlan = { added: [], skippedExisting: 0, skippedDuplicate: 0, conflicts: [] };
  const plannedById = new Map<string, Entry>();
  const reservedIds = new Set([...idx.list({ allStatus: true }), ...parsed].map((e) => e.entryId));
  // Only load content for namespaces that the import actually touches.
  const contentByNs = new Map<string, Set<string>>();
  const relevantNs = new Set(parsed.map((e) => (nsOverride ? assertValidNs(nsOverride) : e.ns)));
  for (const ns of relevantNs) {
    contentByNs.set(ns, new Set(idx.list({ ns, allStatus: true }).map((e) => e.content)));
  }
  for (const e of parsed) {
    const ns = nsOverride ? assertValidNs(nsOverride) : e.ns;
    const normalized = { ...e, ns, content: redactSecrets(e.content).text };
    const planned = plannedById.get(normalized.entryId);
    if (planned) {
      if (planned.content === normalized.content && planned.ns === ns) {
        plan.skippedDuplicate += 1;
      } else {
        plan.conflicts.push({ entryId: normalized.entryId, ns });
      }
      continue;
    }
    const existing = idx.get(normalized.entryId);
    if (existing) {
      if (existing.ns === ns && existing.content === normalized.content) {
        plan.skippedExisting += 1;
      } else if (nsOverride && existing.ns !== ns) {
        const bucket = contentByNs.get(ns) ?? new Set();
        if (bucket.has(normalized.content)) {
          plan.skippedDuplicate += 1;
        } else {
          bucket.add(normalized.content);
          const added = {
            ...normalized,
            entryId: derivedEntryId(`import|${ns}|${normalized.entryId}|${normalized.content}`, reservedIds),
          };
          plan.added.push(added);
          plannedById.set(normalized.entryId, added);
        }
      } else {
        plan.conflicts.push({ entryId: normalized.entryId, ns });
      }
    } else {
      const bucket = contentByNs.get(ns) ?? new Set();
      if (bucket.has(normalized.content)) {
        plan.skippedDuplicate += 1;
      } else {
        bucket.add(normalized.content);
        const added = normalized;
        plan.added.push(added);
        plannedById.set(normalized.entryId, added);
      }
    }
  }
  return plan;
}

export interface MergePlan {
  toCopy: Entry[];
  conflicts: Array<{ entryId: string; srcNs: string; dstNs: string }>;
  dupsByContent: Array<{ entryId: string; content: string }>;
}

function copyEntryId(entry: Entry, dstNs: string, reserved: Set<string>): string {
  return derivedEntryId(`${dstNs}|${entry.entryId}|${entry.content}`, reserved);
}

export function planMerge(
  src: Entry[],
  dst: Entry[],
  dstNs: string,
  reservedIds: Set<string> = new Set([...src, ...dst].map((e) => e.entryId)),
): MergePlan {
  const plan: MergePlan = { toCopy: [], conflicts: [], dupsByContent: [] };
  const dstById = new Map(dst.map((e) => [e.entryId, e]));
  const dstByContent = new Map(dst.map((e) => [e.content, e]));
  for (const e of src) {
    const byId = dstById.get(e.entryId);
    if (byId) {
      if (byId.content === e.content) {
        continue;
      }
      plan.conflicts.push({ entryId: e.entryId, srcNs: e.ns, dstNs });
      continue;
    }
    if (dstByContent.has(e.content)) {
      plan.dupsByContent.push({ entryId: e.entryId, content: e.content.slice(0, 60) });
      continue;
    }
    plan.toCopy.push({ ...e, entryId: copyEntryId(e, dstNs, reservedIds), ns: dstNs });
  }
  return plan;
}

function auditWriteWarnings(idx: Index, entry: Entry): void {
  const flags = scanInjection(entry.content);
  if (flags.length) {
    idx.audit("warn.promptware", entry.ns, `injection pattern on write: ${entry.entryId} (${flags[0]})`);
  }
}

export function applyImport(plan: ImportPlan, idx: Index, root: string): void {
  const entries = plan.added.map((e) => {
    const redacted = redactSecrets(e.content);
    return { entry: redacted.redacted ? { ...e, content: redacted.text } : e, redacted: redacted.redacted };
  });
  updateKindsAtomically(
    entries.map(({ entry }) => ({
      nsDir: nsDir(root, entry.ns),
      kind: entry.kind,
      mutate: (current) => [...current, entry],
    })),
    () => idx.withTransaction(() => {
      for (const { entry, redacted } of entries) {
        idx.add(entry);
        if (redacted) {
          idx.audit("warn.redacted", entry.ns, `secret redacted in ${entry.entryId}`);
        }
        auditWriteWarnings(idx, entry);
      }
    }),
  );
}

export function applyMerge(plan: MergePlan, idx: Index, root: string): void {
  const entries = plan.toCopy.map((e) => {
    const redacted = redactSecrets(e.content);
    return { entry: redacted.redacted ? { ...e, content: redacted.text } : e, redacted: redacted.redacted };
  });
  updateKindsAtomically(
    entries.map(({ entry }) => ({
      nsDir: nsDir(root, entry.ns),
      kind: entry.kind,
      mutate: (current) => [...current, entry],
    })),
    () => idx.withTransaction(() => {
      for (const { entry, redacted } of entries) {
        idx.add(entry);
        if (redacted) {
          idx.audit("warn.redacted", entry.ns, `secret redacted in ${entry.entryId}`);
        }
        auditWriteWarnings(idx, entry);
      }
    }),
  );
}

/** Refuse obviously pathological export files before reading them into
 *  memory; the content cap per entry is far smaller, so a healthy export is
 *  nowhere near this bound. */
const MAX_EXPORT_FILE_BYTES = 512 * 1024 * 1024;

export function readExportFile(path: string): Entry[] {
  const size = statSync(path).size;
  if (size > MAX_EXPORT_FILE_BYTES) {
    throw new Error(`export file too large (${size} bytes > ${MAX_EXPORT_FILE_BYTES})`);
  }
  return parseExport(readFileSync(path, "utf-8"));
}
