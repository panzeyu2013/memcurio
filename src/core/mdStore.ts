import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite, withFileLock } from "./transaction.js";

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

const SEP = /^§ ([0-9a-f]{8}) \| ([A-Z_]+) \| (\S+) \| (\S+)(?: \| ([01]))?$/;

function isKnownKind(kind: string): boolean {
  return (KINDS as readonly string[]).includes(kind);
}

function isKnownStatus(status: string): boolean {
  return (STATUSES as readonly string[]).includes(status);
}

function isHeader(lines: string[], idx: number): boolean {
  if (idx > 0 && lines[idx - 1].trim() !== "") {
    return false;
  }
  // A header must be followed by a blank line (or EOF): the canonical renderEntry
  // format is "§ meta\n\ncontent", and this also prevents prose that merely looks
  // like a header (inside an entry body) from splitting entries.
  if (idx + 1 < lines.length && lines[idx + 1].trim() !== "") {
    return false;
  }
  const m = SEP.exec(lines[idx]);
  return !!m && isKnownKind(m[2]) && isKnownStatus(m[4]);
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
    if (isHeader(lines, i)) {
      const m = SEP.exec(lines[i]);
      if (m) {
        const [, entryId, kind, createdAt, status, pinned] = m;
        const body: string[] = [];
        i += 1;
        while (i < lines.length && !isHeader(lines, i)) {
          body.push(lines[i]);
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
    if (isHeader(lines, i)) {
      if (textBuf.length) {
        blocks.push({ type: "text", raw: textBuf.join("\n") });
        textBuf = [];
      }
      const m = SEP.exec(lines[i]);
      if (!m) {
        i += 1;
        continue;
      }
      const [, entryId, , createdAt, status, pinned] = m;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !isHeader(lines, i)) {
        body.push(lines[i]);
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
    textBuf.push(lines[i]);
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

export function kindFile(nsDir_: string, kind: Kind): string {
  return join(nsDir_, `${kind}.md`);
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

export function addEntry(nsDir_: string, entry: Entry): void {
  const path = kindFile(nsDir_, entry.kind);
  withFileLock(`${nsDir_}/.lock-${entry.kind}.md`, () => {
    const text = readText(path);
    const next = text.trim() ? text.trimEnd() + "\n\n" + renderEntry(entry) : renderEntry(entry);
    atomicWrite(path, next);
  });
}

export function updateKind(nsDir_: string, kind: Kind, mutate: (entries: Entry[]) => Entry[]): void {
  const path = kindFile(nsDir_, kind);
  const ns = nsDir_.split("/").filter(Boolean).at(-1) ?? "";
  withFileLock(`${nsDir_}/.lock-${kind}.md`, () => {
    const text = readText(path);
    const parsed = parseBlocks(text, ns, kind);
    const next = mutate(parsed.filter((b) => b.type === "entry").map((b) => b.entry!));
    const nextById = new Map(next.map((e) => [e.entryId, e]));
    const used = new Set<string>();
    const out: string[] = [];
    for (const b of parsed) {
      if (b.type === "text") {
        out.push(b.raw);
        continue;
      }
      const e = nextById.get(b.entry!.entryId);
      if (!e || used.has(e.entryId)) {
        continue;
      }
      used.add(e.entryId);
      out.push(entryEquals(b.entry!, e) ? b.raw : renderEntry(e));
    }
    for (const e of next) {
      if (!used.has(e.entryId)) {
        used.add(e.entryId);
        out.push(renderEntry(e));
      }
    }
    const rendered = out.join("\n").trimEnd() + "\n";
    if (rendered === text.trimEnd() + "\n") {
      return;
    }
    atomicWrite(path, rendered);
  });
}

export function readAll(nsDir_: string): Entry[] {
  const entries: Entry[] = [];
  for (const name of readdirSync(nsDir_).sort()) {
    if (!name.endsWith(".md") || name.startsWith(".")) {
      continue;
    }
    const text = readFileSync(join(nsDir_, name), "utf-8");
    entries.push(...parseFile(text, nsDir_.split("/").filter(Boolean).at(-1) ?? ""));
  }
  return entries;
}
