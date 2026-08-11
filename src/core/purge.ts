import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { artifactFilenameForId } from "./artifacts.js";
import {
  applyGeneration,
  discardGeneration,
  generationMarkerFromMeta,
  markGenerationCommitted,
  prepareGeneration,
  recoverPendingGenerations,
} from "./generation.js";
import type { GenerationFileSnapshot } from "./generation.js";
import {
  renderRawMemories,
  RuleConsolidateProvider,
  withWorkspaceWriteLease,
} from "./consolidate.js";
import { atomicWrite } from "./transaction.js";
import { diffWorkspace, listWorkspaceFiles, loadBaseline, readWorkspaceText } from "./workspace.js";

export interface PurgeResult {
  rolloutKey: string;
  artifactId: string;
  artifactFilename: string;
  extractionJobs: number;
  sessionRows: number;
  auditRows: number;
  exportRecords: number;
}

function snapshotWorkspace(root: string): Record<string, GenerationFileSnapshot> {
  const present = new Set(listWorkspaceFiles(root));
  const rels = new Set([...present, "MEMORY.md", "memory_summary.md", "raw_memories.md"]);
  return Object.fromEntries(
    [...rels].sort().map((rel) => [rel, {
      present: present.has(rel),
      content: present.has(rel) ? readWorkspaceText(root, rel) : "",
    }]),
  );
}

function snapshotBaseline(root: string): Record<string, GenerationFileSnapshot> {
  return Object.fromEntries(Object.entries(loadBaseline(root)).map(([rel, content]) => [rel, { present: true, content }]));
}

function baselineAfterWorkspace(workspace: Record<string, GenerationFileSnapshot>): Record<string, GenerationFileSnapshot> {
  const baseline: Record<string, GenerationFileSnapshot> = {};
  for (const rel of ["MEMORY.md", "memory_summary.md", "raw_memories.md"]) {
    baseline[rel] = { present: true, content: workspace[rel]?.content ?? "" };
  }
  for (const [rel, snapshot] of Object.entries(workspace)) {
    if (rel.startsWith("rollout_summaries/") && snapshot.present) {
      baseline[rel] = { present: true, content: snapshot.content };
    }
  }
  return baseline;
}

function rawContainsManagedRow(raw: string, row: {
  rolloutKey: string;
  rolloutSlug: string;
  artifactFilename: string;
  rawMemory: string;
}): boolean {
  const body = row.rawMemory.trim();
  if (!body) {
    return false;
  }
  // Match the whole DB-backed block, not marker-looking lines in untrusted raw
  // content. Legacy projections used the readable slug in this position.
  const filenames = new Set([row.artifactFilename, row.rolloutSlug, `${row.rolloutSlug}.md`]);
  return [...filenames].some((filename) =>
    raw.includes(`<!-- rollout: ${row.rolloutKey} (${filename}) -->\n${body}`),
  );
}

function scrubExportText(text: string, rolloutKey: string): { text: string; removed: number } {
  let removed = 0;
  const lines: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let keep = true;
    try {
      const value = JSON.parse(line) as { type?: unknown; rolloutKey?: unknown };
      if (value.type === "stage1" && value.rolloutKey === rolloutKey) {
        keep = false;
        removed += 1;
      }
    } catch {
      // Do not silently rewrite a corrupt backup. The caller must fix it first.
      throw new Error("cannot hard-purge a malformed JSONL export");
    }
    if (keep) {
      lines.push(line);
    }
  }
  return { text: lines.length ? `${lines.join("\n")}\n` : "", removed };
}

/** Scrub one explicitly named JSONL export. Unknown backups and remote copies
 * are intentionally outside the local store's authority and remain manual
 * retention work. */
export function scrubExportFile(path: string, rolloutKey: string): number {
  const current = readFileSync(path, "utf-8");
  const scrubbed = scrubExportText(current, rolloutKey);
  if (scrubbed.removed > 0) {
    atomicWrite(path, scrubbed.text);
  }
  return scrubbed.removed;
}

/** Physically remove one rollout from the local source store, its generated
 * artifact, extraction queue/session rows, audit references, and the managed
 * Markdown projections. The generation protocol makes the file/SQLite change
 * recoverable if the process is killed between writes. */
export async function purgeRollout(root: string, rolloutKey: string, exportPaths: string[] = []): Promise<PurgeResult | null> {
  return withWorkspaceWriteLease(root, async (idx, renew) => {
    let generationId: string | undefined;
    try {
      recoverPendingGenerations(root, generationMarkerFromMeta(idx.metaGet("consolidation_generation")));
      const row = idx.stageGet(rolloutKey);
      if (!row) {
        return null;
      }
      let exportRecords = 0;
      for (const path of exportPaths) {
        exportRecords += scrubExportFile(path, rolloutKey);
        renew();
      }
      const beforeWorkspace = snapshotWorkspace(root);
      const beforeBaseline = snapshotBaseline(root);
      const afterWorkspace = Object.fromEntries(Object.entries(beforeWorkspace).map(([rel, value]) => [rel, { ...value }])) as Record<string, GenerationFileSnapshot>;
      const artifactNames = new Set([row.artifactFilename]);
      const legacyFilename = `${row.rolloutSlug}.md`;
      if (legacyFilename !== row.artifactFilename && idx.stageBySlug(row.rolloutSlug)?.rolloutKey === rolloutKey) {
        artifactNames.add(legacyFilename);
      }
      for (const filename of artifactNames) {
        delete afterWorkspace[`rollout_summaries/${filename}`];
      }
      const currentRaw = beforeWorkspace["raw_memories.md"]?.content ?? "";
      const remainingRaw = renderRawMemories(
        idx.stageList().filter((candidate) =>
          candidate.rolloutKey !== rolloutKey &&
          candidate.status !== "deleted" &&
          rawContainsManagedRow(currentRaw, candidate),
        ),
      );
      afterWorkspace["raw_memories.md"] = {
        present: true,
        content: remainingRaw,
      };

      // MEMORY.md, its summary, and skills can contain facts without complete
      // provenance (including output written by older providers). Rebuild the
      // aggregate documents only from the surviving published raw projection
      // and independently authored, already-applied notes. This is deliberately
      // conservative: privacy deletion takes precedence over preserving an
      // unattributed model rewrite.
      const rebuilt = await new RuleConsolidateProvider().consolidate({
        workspace: { "MEMORY.md": "", "memory_summary.md": "" },
        diff: remainingRaw ? [diffWorkspace("raw_memories.md", "", remainingRaw)] : [],
        notes: idx.noteList()
          .filter((note) => note.applied)
          .map((note) => ({ kind: note.kind, filename: note.filename, content: note.content })),
        memoryRoot: root,
      });
      const rebuiltMemory = rebuilt.edits.find((edit) => edit.rel === "MEMORY.md")?.content ?? "";
      const rebuiltSummary = rebuilt.edits.find((edit) => edit.rel === "memory_summary.md")?.content ?? "";
      afterWorkspace["MEMORY.md"] = { present: true, content: rebuiltMemory };
      afterWorkspace["memory_summary.md"] = { present: true, content: rebuiltSummary };
      for (const rel of Object.keys(afterWorkspace)) {
        if (rel.startsWith("skills/") && rel.endsWith("/SKILL.md")) {
          delete afterWorkspace[rel];
        }
      }
      const generation = prepareGeneration(
        root,
        randomUUID().replaceAll("-", ""),
        beforeWorkspace,
        afterWorkspace,
        beforeBaseline,
        baselineAfterWorkspace(afterWorkspace),
      );
      generationId = generation.id;
      try {
        renew();
        applyGeneration(root, generation, "after");
        renew();
        let extractionJobs = 0;
        let sessionRows = 0;
        let auditRows = 0;
        idx.withTransaction(() => {
          const purged = idx.stagePurge(rolloutKey);
          if (!purged) {
            throw new Error(`rollout disappeared during purge: ${rolloutKey}`);
          }
          const separator = rolloutKey.indexOf("|");
          const host = separator > 0 ? rolloutKey.slice(0, separator) : "";
          const sessionId = separator > 0 ? rolloutKey.slice(separator + 1) : "";
          if (host && sessionId) {
            extractionJobs = idx.purgeExtractionJobs(host, sessionId);
            sessionRows = idx.purgeSession(host, sessionId);
          }
          auditRows = idx.purgeAuditMatches([rolloutKey, row.artifactId, row.artifactFilename]);
          auditRows += idx.purgeAuditExact([sessionId]);
          idx.metaSet("consolidation_generation", generation.id);
          // Record the operation without re-introducing any purged identifier.
          idx.audit("purge.hard", "-", `exports=${exportRecords}; jobs=${extractionJobs}; sessions=${sessionRows}; audit=${auditRows}`);
        });
        const committed = markGenerationCommitted(root, generation);
        discardGeneration(root, committed.id);
        generationId = undefined;
        return {
          rolloutKey,
          artifactId: row.artifactId,
          artifactFilename: row.artifactFilename,
          extractionJobs,
          sessionRows,
          auditRows,
          exportRecords,
        };
      } catch (err) {
        recoverPendingGenerations(root, generationMarkerFromMeta(idx.metaGet("consolidation_generation")));
        throw err;
      }
    } finally {
      if (generationId) {
        try {
          recoverPendingGenerations(root, generationMarkerFromMeta(idx.metaGet("consolidation_generation")));
        } catch {
          // Preserve the manifest for the next doctor/consolidation recovery.
        }
      }
    }
  });
}

/** Keep the artifact filename helper close to purge callers without exposing
 * the database implementation details. */
export { artifactFilenameForId };
