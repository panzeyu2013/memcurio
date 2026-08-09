import { readFileSync } from "node:fs";

import { Index } from "./db.js";
import { KINDS, addEntry } from "./mdStore.js";
import type { Entry, Kind, Status } from "./mdStore.js";
import { assertValidNs, nsDir } from "./paths.js";
import { redactSecrets, scanInjection } from "./sanitize.js";
import { atomicWrite } from "./transaction.js";

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
  return entries.map((e) => JSON.stringify(toExportRow(e))).join("\n") + "\n";
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
    if (!r.entryId || typeof r.entryId !== "string" || !/^[0-9a-f]{8}$/.test(r.entryId)) {
      throw new Error(`invalid export line ${lineNo}: entryId must be 8-hex`);
    }
    if (typeof r.content !== "string" || !r.content) {
      throw new Error(`invalid export line ${lineNo}: content must be a non-empty string`);
    }
    if (typeof r.createdAt !== "string" || !r.createdAt) {
      throw new Error(`invalid export line ${lineNo}: createdAt missing`);
    }
    const kind = r.kind ?? "MEMORY";
    if (!KINDS.includes(kind)) {
      throw new Error(`invalid export line ${lineNo}: kind ${JSON.stringify(kind)}`);
    }
    const status = (r.status ?? "active") as Status;
    if (!["active", "stale", "archived", "deleted"].includes(status)) {
      throw new Error(`invalid export line ${lineNo}: status ${JSON.stringify(status)}`);
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
    if (r.lastUsedAt !== undefined && r.lastUsedAt !== null && typeof r.lastUsedAt !== "string") {
      throw new Error(`invalid export line ${lineNo}: lastUsedAt must be a string or null`);
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
  // Only load content for namespaces that the import actually touches.
  const contentByNs = new Map<string, Set<string>>();
  const relevantNs = new Set(parsed.map((e) => (nsOverride ? assertValidNs(nsOverride) : e.ns)));
  for (const ns of relevantNs) {
    contentByNs.set(ns, new Set(idx.list({ ns, allStatus: true }).map((e) => e.content)));
  }
  for (const e of parsed) {
    const ns = nsOverride ? assertValidNs(nsOverride) : e.ns;
    const existing = idx.get(e.entryId);
    if (existing) {
      if (existing.content === e.content) {
        plan.skippedExisting += 1;
      } else {
        plan.conflicts.push({ entryId: e.entryId, ns });
      }
    } else {
      const bucket = contentByNs.get(ns) ?? new Set();
      if (bucket.has(e.content)) {
        plan.skippedDuplicate += 1;
      } else {
        bucket.add(e.content);
        plan.added.push({ ...e, ns });
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

export function planMerge(src: Entry[], dst: Entry[], dstNs: string): MergePlan {
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
    plan.toCopy.push({ ...e, ns: dstNs });
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
  for (const e of plan.added) {
    const redacted = redactSecrets(e.content);
    const entry = redacted.redacted ? { ...e, content: redacted.text } : e;
    addEntry(nsDir(root, entry.ns), entry);
    idx.add(entry);
    if (redacted.redacted) {
      idx.audit("warn.redacted", entry.ns, `secret redacted in ${entry.entryId}`);
    }
    auditWriteWarnings(idx, entry);
  }
}

export function applyMerge(plan: MergePlan, idx: Index, root: string): void {
  for (const e of plan.toCopy) {
    const redacted = redactSecrets(e.content);
    const entry = redacted.redacted ? { ...e, content: redacted.text } : e;
    addEntry(nsDir(root, entry.ns), entry);
    idx.add(entry);
    if (redacted.redacted) {
      idx.audit("warn.redacted", entry.ns, `secret redacted in ${entry.entryId}`);
    }
    auditWriteWarnings(idx, entry);
  }
}

export function readExportFile(path: string): Entry[] {
  return parseExport(readFileSync(path, "utf-8"));
}
