import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite, withFileLock } from "./transaction.js";

export const KINDS = ["MEMORY", "USER", "SESSION"] as const;
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

export function renderEntry(e: Entry): string {
  const pinned = e.pinned ? " | 1" : "";
  const meta = `§ ${e.entryId} | ${e.kind} | ${e.createdAt} | ${e.status}${pinned}`;
  return `${meta}\n\n${e.content.trim()}\n`;
}

export function parseFile(text: string, ns: string): Entry[] {
  const entries: Entry[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = SEP.exec(lines[i]);
    if (m) {
      const [, entryId, kind, createdAt, status, pinned] = m;
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !SEP.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      entries.push({
        entryId,
        ns,
        kind: kind as Kind,
        content: body.join("\n").trim(),
        createdAt,
        status: status as Status,
        pinned: pinned === "1",
        lastUsedAt: null,
        useCount: 0,
        valueScore: 1,
      });
    } else {
      i += 1;
    }
  }
  return entries;
}

export function kindFile(nsDir_: string, kind: Kind): string {
  return join(nsDir_, `${kind}.md`);
}

export function addEntry(nsDir_: string, entry: Entry): void {
  const path = kindFile(nsDir_, entry.kind);
  withFileLock(`${nsDir_}/.lock-${entry.kind}.md`, () => {
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      text = "";
    }
    const next = text.trim() ? text.trimEnd() + "\n\n" + renderEntry(entry) : renderEntry(entry);
    atomicWrite(path, next);
  });
}

export function updateKind(nsDir_: string, kind: Kind, mutate: (entries: Entry[]) => Entry[]): void {
  const path = kindFile(nsDir_, kind);
  const ns = nsDir_.split("/").filter(Boolean).at(-1) ?? "";
  withFileLock(`${nsDir_}/.lock-${kind}.md`, () => {
    let text: string;
    try {
      text = readFileSync(path, "utf-8");
    } catch {
      text = "";
    }
    const next = mutate(parseFile(text, ns));
    atomicWrite(path, next.map((e) => renderEntry(e).trim()).join("\n\n"));
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
