import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite, withFileLock } from "./transaction.js";
import { ENTRY_ID_RE, newEntryId } from "./ids.js";
import { nsName } from "./paths.js";

export const KINDS = ["MEMORY", "USER", "SESSION", "COMPACT"] as const;
export type Kind = (typeof KINDS)[number];

export const STATUSES = ["active", "stale", "archived", "deleted"] as const;
export type Status = (typeof STATUSES)[number];

export interface Entry {
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

const SEP = new RegExp(`^§ (${ENTRY_ID_RE.source.slice(1, -1)}) \\| ([A-Z_]+) \\| (\\S+) \\| (\\S+)(?: \\| ([01]))?$`);

export function isKnownKind(kind: string): boolean {
  return (KINDS as readonly string[]).includes(kind);
}

export function isKnownStatus(status: string): boolean {
  return (STATUSES as readonly string[]).includes(status);
}

function isHeader(lines: string[], idx: number, expectedKind?: Kind): boolean {
  if (idx > 0 && (lines[idx - 1] ?? "").trim() !== "") {
    return false;
  }
  // A header must be followed by a blank line (or EOF): the canonical renderEntry
  // format is "§ meta\n\ncontent", and this also prevents prose that merely looks
  // like a header (inside an entry body) from splitting entries.
  if (idx + 1 < lines.length && (lines[idx + 1] ?? "").trim() !== "") {
    return false;
  }
  const m = SEP.exec(lines[idx] ?? "");
  if (!m) {
    return false;
  }
  const [, , kind, , status] = m;
  if (kind === undefined || status === undefined || !isKnownKind(kind) || !isKnownStatus(status)) {
    return false;
  }
  // When the file kind is known (from the file name), a header declaring a
  // different kind is prose, not an entry header. This also guarantees the
  // header kind always matches the file kind, so writing back never silently
  // rewrites a header's declared kind.
  return expectedKind === undefined || kind === expectedKind;
}

export function renderEntry(e: Entry): string {
  const pinned = e.pinned ? " | 1" : "";
  const meta = `§ ${e.entryId} | ${e.kind} | ${e.createdAt} | ${e.status}${pinned}`;
  return `${meta}\n\n${e.content.trim()}\n`;
}

export function parseFile(text: string, ns: string, expectedKind?: Kind): Entry[] {
  const entries: Entry[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    if (isHeader(lines, i, expectedKind)) {
      const m = SEP.exec(lines[i] ?? "");
      if (m) {
        const [, entryId, kind, createdAt, status, pinned] = m;
        if (entryId === undefined || kind === undefined || createdAt === undefined || status === undefined) {
          i += 1;
          continue;
        }
        const body: string[] = [];
        i += 1;
        while (i < lines.length && !isHeader(lines, i, expectedKind)) {
          body.push(lines[i] ?? "");
          i += 1;
        }
        entries.push({
          entryId,
          ns,
          kind: (expectedKind ?? kind) as Kind,
          content: body.join("\n").trim(),
          createdAt,
          status: status as Status,
          pinned: pinned === "1",
          lastUsedAt: null,
          useCount: 0,
          valueScore: 1,
        });
        continue;
      }
    }
    i += 1;
  }
  return entries;
}

interface Block {
  type: "entry" | "text";
  entry?: Entry;
  raw: string;
}

function parseBlocks(text: string, ns: string, kind: Kind): Block[] {
  const blocks: Block[] = [];
  const lines = text.split("\n");
  let textBuf: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isHeader(lines, i, kind)) {
      if (textBuf.length) {
        blocks.push({ type: "text", raw: textBuf.join("\n") });
        textBuf = [];
      }
      const m = SEP.exec(lines[i] ?? "");
      if (!m) {
        i += 1;
        continue;
      }
      const [, entryId, , createdAt, status, pinned] = m;
      if (entryId === undefined || createdAt === undefined || status === undefined) {
        i += 1;
        continue;
      }
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isHeader(lines, i, kind)) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      blocks.push({
        type: "entry",
        entry: {
          entryId,
          ns,
          kind,
          content: body.join("\n").trim(),
          createdAt,
          status: status as Status,
          pinned: pinned === "1",
          lastUsedAt: null,
          useCount: 0,
          valueScore: 1,
        },
        raw: [m[0], ...body].join("\n"),
      });
      continue;
    }
    textBuf.push(lines[i] ?? "");
    i += 1;
  }
  if (textBuf.length) {
    blocks.push({ type: "text", raw: textBuf.join("\n") });
  }
  return blocks;
}

function entryEquals(a: Entry, b: Entry): boolean {
  return (
    a.entryId === b.entryId &&
    a.kind === b.kind &&
    a.content === b.content &&
    a.createdAt === b.createdAt &&
    a.status === b.status &&
    a.pinned === b.pinned
  );
}

export function kindFile(dir: string, kind: Kind): string {
  return join(dir, `${kind}.md`);
}

/** Factory for new entries so defaults never drift across call sites. */
export function newEntry(ns: string, kind: Kind, content: string, extra?: Partial<Entry>): Entry {
  return {
    entryId: newEntryId(),
    ns,
    kind,
    content,
    createdAt: new Date().toISOString(),
    status: "active",
    pinned: false,
    lastUsedAt: null,
    useCount: 0,
    valueScore: 1,
    ...extra,
  };
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    return "";
  }
}

export function addEntry(dir: string, entry: Entry): void {
  const path = kindFile(dir, entry.kind);
  withFileLock(`${dir}/.lock-${entry.kind}.md`, () => {
    const text = readText(path);
    const next = text.trim() ? `${text.trimEnd()}\n\n${renderEntry(entry)}` : renderEntry(entry);
    atomicWrite(path, next);
  });
}

export function updateKind(dir: string, kind: Kind, mutate: (entries: Entry[]) => Entry[]): void {
  const path = kindFile(dir, kind);
  const ns = nsName(dir);
  withFileLock(`${dir}/.lock-${kind}.md`, () => {
    const text = readText(path);
    const rendered = renderMutation(text, ns, kind, mutate);
    if (rendered === `${text.trimEnd()}\n`) {
      return;
    }
    atomicWrite(path, rendered);
  });
}

export interface KindMutation {
  nsDir: string;
  kind: Kind;
  mutate: (entries: Entry[]) => Entry[];
}

function renderMutation(text: string, ns: string, kind: Kind, mutate: KindMutation["mutate"]): string {
  const parsed = parseBlocks(text, ns, kind);
  const isEntry = (b: Block): b is Block & { entry: Entry } => b.type === "entry";
  const next = mutate(parsed.filter(isEntry).map((b) => b.entry));
  const nextById = new Map(next.map((e) => [e.entryId, e]));
  const used = new Set<string>();
  const out: string[] = [];
  for (const b of parsed) {
    if (b.type === "text") {
      out.push(b.raw);
      continue;
    }
    const entry = b.entry;
    if (!entry) {
      continue;
    }
    const e = nextById.get(entry.entryId);
    if (!e || used.has(e.entryId)) {
      continue;
    }
    used.add(e.entryId);
    out.push(entryEquals(entry, e) ? b.raw : renderEntry(e));
  }
  for (const e of next) {
    if (!used.has(e.entryId)) {
      used.add(e.entryId);
      out.push(renderEntry(e));
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}

/**
 * Apply mutations spanning several truth files while holding every file lock.
 * Markdown is written first, then `commit` is called with the final entries as
 * parsed from the (possibly rewritten) files, so index updates can be derived
 * from the post-lock truth rather than a pre-lock snapshot. Any synchronous
 * failure restores every file before releasing the locks, so callers never
 * observe a partially applied batch.
 */
export function updateKindsAtomically(mutations: KindMutation[], commit: (entries: Entry[]) => void): void {
  const grouped = new Map<string, { nsDir: string; kind: Kind; mutates: KindMutation["mutate"][] }>();
  for (const mutation of mutations) {
    const path = kindFile(mutation.nsDir, mutation.kind);
    const group = grouped.get(path) ?? { nsDir: mutation.nsDir, kind: mutation.kind, mutates: [] };
    group.mutates.push(mutation.mutate);
    grouped.set(path, group);
  }
  // Deterministic, locale-independent ordering: every process must acquire
  // the per-file locks in the same sequence or concurrent writers could
  // deadlock across processes with different locales.
  const groups = [...grouped.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lockAll = (index: number, work: () => void): void => {
    if (index >= groups.length) {
      work();
      return;
    }
    const entry = groups[index];
    if (entry === undefined) {
      // Unreachable: the recursion stops exactly at groups.length.
      return;
    }
    const [, group] = entry;
    withFileLock(`${group.nsDir}/.lock-${group.kind}.md`, () => lockAll(index + 1, work));
  };

  lockAll(0, () => {
    const originals = new Map<string, { existed: boolean; text: string }>();
    const rendered = new Map<string, string>();
    for (const [path, group] of groups) {
      const text = readText(path);
      originals.set(path, { existed: existsSync(path), text });
      const ns = nsName(group.nsDir);
      rendered.set(
        path,
        renderMutation(text, ns, group.kind, (entries) => group.mutates.reduce((current, mutate) => mutate(current), entries)),
      );
    }
    const written: string[] = [];
    try {
      for (const [path, text] of rendered) {
        const original = originals.get(path);
        if (original && text !== `${original.text.trimEnd()}\n`) {
          atomicWrite(path, text);
          written.push(path);
        }
      }
      const finalEntries: Entry[] = [];
      for (const [path, group] of groups) {
        const text = rendered.get(path);
        if (text === undefined) {
          throw new Error(`batch write missing rendered content for ${path}`);
        }
        finalEntries.push(...parseFile(text, nsName(group.nsDir), group.kind));
      }
      commit(finalEntries);
    } catch (err) {
      const rollbackErrors: unknown[] = [];
      for (const path of written.reverse()) {
        const original = originals.get(path);
        if (original === undefined) {
          rollbackErrors.push(new Error(`batch rollback missing original content for ${path}`));
          continue;
        }
        try {
          if (original.existed) {
            atomicWrite(path, original.text);
          } else if (existsSync(path)) {
            unlinkSync(path);
          }
        } catch (rollbackErr) {
          rollbackErrors.push(rollbackErr);
        }
      }
      if (rollbackErrors.length) {
        throw new AggregateError([err, ...rollbackErrors], "batch failed and Markdown rollback was incomplete");
      }
      throw err;
    }
  });
}

export function readAll(dir: string): Entry[] {
  const entries: Entry[] = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".md") || name.startsWith(".")) {
      continue;
    }
    const text = readFileSync(join(dir, name), "utf-8");
    const fileKind = name.slice(0, -3) as Kind;
    const expectedKind = KINDS.includes(fileKind) ? fileKind : undefined;
    entries.push(...parseFile(text, nsName(dir), expectedKind));
  }
  return entries;
}
