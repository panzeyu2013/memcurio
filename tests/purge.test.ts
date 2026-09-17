import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactFilenameForId, artifactIdForRolloutKey } from "../src/core/artifacts.js";
import { RuleConsolidateProvider, runConsolidation } from "../src/core/consolidate.js";
import { Index } from "../src/core/db.js";
import { stageSession } from "../src/core/extract.js";
import { purgeRollout } from "../src/core/purge.js";
import { ensureLayout, indexDb } from "../src/core/paths.js";
import { readWorkspaceText, rolloutSlugs, writeWorkspaceText } from "../src/core/workspace.js";
import type { ExtractProvider, RolloutSnapshot, Stage1Output } from "../src/core/extract.js";

/** Selection windows are measured against the wall clock; keep fixture rows
 *  inside the default maxUnusedDays window. */
const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

let root: string;

afterEach(() => {
  if (root) {
    rmSync(root, { recursive: true, force: true });
  }
});

const snapshot: RolloutSnapshot = {
  sessionId: "s-purge",
  workdir: "/tmp/purge",
  host: "codex",
  messages: 2,
  tools: ["edit"],
  files: ["MEMORY.md"],
  startedAt: daysAgo(6),
  endedAt: daysAgo(5),
};

class Provider implements ExtractProvider {
  readonly name = "purge-test";
  async extract(): Promise<Stage1Output> {
    return {
      rolloutKey: "codex|s-purge",
      rawMemory: "task_group: purge\n\n### Task 1: cleanup\n\nReusable knowledge:\n- remove safely",
      rolloutSummary: "# purge recap",
      rolloutSlug: "same-readable-slug",
      sourceUpdatedAt: snapshot.endedAt,
    };
  }
}

describe("hard purge", () => {
  test("removes local stage, artifact, queue/session data, markdown support, and named export records", async () => {
    root = mkdtempSync(join(tmpdir(), "purge-"));
    ensureLayout(root);
    await stageSession(root, snapshot, new Provider());
    await runConsolidation(root, new RuleConsolidateProvider(), { execute: true });
    const artifactFilename = artifactFilenameForId(artifactIdForRolloutKey("codex|s-purge"));
    writeWorkspaceText(
      root,
      "MEMORY.md",
      `${readWorkspaceText(root, "MEMORY.md")}\n# Task Group: legacy citation\n\n### rollout_summary_files\n\n- rollout_summaries/same-readable-slug.md\n\n# Task Group: mixed sensitive facts\n\nprivate fact A\n\n### rollout_summary_files\n\n- rollout_summaries/same-readable-slug.md\n- rollout_summaries/other-rollout.md\n\n# Task Group: citationless legacy output\n\nPRIVATE_SOURCE_FACT\n`,
    );
    writeWorkspaceText(root, "skills/private/SKILL.md", "# Private skill\n\nPRIVATE_SOURCE_FACT\n");
    writeWorkspaceText(root, "skills/related/SKILL.md", "# Related skill\n\nSee rollout_summaries/same-readable-slug.md\n");
    const exportPath = join(root, "backup.jsonl");
    writeFileSync(exportPath, `${JSON.stringify({ type: "stage1", rolloutKey: "codex|s-purge", rawMemory: "secret" })}\n`);

    const idx = await Index.create(indexDb(root));
    try {
      idx.recordSession("s-purge", "codex", "/tmp/purge", new Date().toISOString());
      idx.extractionEnqueue({
        idempotencyKey: "purge-job",
        host: "codex",
        sessionId: "s-purge",
        sourceEvent: "session_end",
        workdir: "/tmp/purge",
        evidenceRef: "sha256:purge",
        contentHash: "purge",
        snapshotJson: JSON.stringify(snapshot),
      });
      idx.audit("test", "codex|s-purge", "codex|s-purge secret detail");
    } finally {
      idx.close();
    }

    const result = await purgeRollout(root, "codex|s-purge", [exportPath]);
    expect(result?.artifactFilename).toBe(artifactFilename);
    expect(result?.exportRecords).toBe(1);
    expect(readFileSync(exportPath, "utf-8")).toBe("");
    expect(rolloutSlugs(root)).toEqual([]);
    expect(readWorkspaceText(root, "raw_memories.md")).toBe("# Raw Memories\n\nNo raw memories yet.\n");
    expect(readWorkspaceText(root, "MEMORY.md")).not.toContain("Task Group: purge");
    // Blocks citing only the purged artifact are removed; mixed and
    // citationless blocks are preserved so unrelated content survives.
    expect(readWorkspaceText(root, "MEMORY.md")).not.toContain("legacy citation");
    expect(readWorkspaceText(root, "MEMORY.md")).toContain("mixed sensitive facts");
    expect(readWorkspaceText(root, "MEMORY.md")).toContain("PRIVATE_SOURCE_FACT");
    expect(readWorkspaceText(root, "skills/private/SKILL.md")).toBe("# Private skill\n\nPRIVATE_SOURCE_FACT\n");
    expect(readWorkspaceText(root, "skills/related/SKILL.md")).toBe("");
    expect(result?.skillsRemoved).toBe(1);

    const idx2 = await Index.create(indexDb(root));
    try {
      expect(idx2.stageGet("codex|s-purge")).toBeUndefined();
      expect(idx2.extractionList()).toHaveLength(0);
      expect(idx2.driver.get("SELECT * FROM sessions WHERE session_id='s-purge'")).toBeNull();
      expect(idx2.auditRecent(20).some((row) => String(row.action) === "purge.hard")).toBe(true);
      expect(idx2.auditRecent(20).some((row) => String(row.detail).includes("codex|s-purge"))).toBe(false);
      expect(idx2.auditRecent(20).some((row) => String(row.detail).includes(artifactIdForRolloutKey("codex|s-purge")))).toBe(false);
    } finally {
      idx2.close();
    }
  });

  test("rebuilds from surviving published sources without projecting unrelated pending rows", async () => {
    root = mkdtempSync(join(tmpdir(), "purge-"));
    ensureLayout(root);
    const idx = await Index.create(indexDb(root));
    try {
      idx.stageUpsert({
        rolloutKey: "codex|target",
        rawMemory: "task_group: target\ncwd: /tmp/target\n\n### Task 1\n\nReusable knowledge:\n- TARGET_PRIVATE_FACT",
        rolloutSummary: "target recap",
        rolloutSlug: "target",
        sourceUpdatedAt: daysAgo(5),
      });
      idx.stageUpsert({
        rolloutKey: "codex|survivor",
        rawMemory: "task_group: survivor\ncwd: /tmp/survivor\n\n### Task 1\n\nReusable knowledge:\n- SURVIVING_FACT",
        rolloutSummary: "survivor recap",
        rolloutSlug: "survivor",
        sourceUpdatedAt: daysAgo(5),
      });
    } finally {
      idx.close();
    }
    await runConsolidation(root, new RuleConsolidateProvider(), { execute: true });
    const idx2 = await Index.create(indexDb(root));
    try {
      idx2.stageUpsert({
        rolloutKey: "codex|pending",
        rawMemory: "task_group: pending\n\nReusable knowledge:\n- UNSELECTED_PENDING_FACT",
        rolloutSummary: "pending recap",
        rolloutSlug: "pending",
        sourceUpdatedAt: daysAgo(4),
      });
    } finally {
      idx2.close();
    }

    await purgeRollout(root, "codex|target");
    const raw = readWorkspaceText(root, "raw_memories.md");
    const memory = readWorkspaceText(root, "MEMORY.md");
    expect(raw).toContain("SURVIVING_FACT");
    expect(memory).toContain("SURVIVING_FACT");
    expect(raw).not.toContain("TARGET_PRIVATE_FACT");
    expect(memory).not.toContain("TARGET_PRIVATE_FACT");
    expect(raw).not.toContain("UNSELECTED_PENDING_FACT");
    expect(memory).not.toContain("UNSELECTED_PENDING_FACT");
  });

  test("refuses a malformed named export before changing the store", async () => {
    root = mkdtempSync(join(tmpdir(), "purge-"));
    ensureLayout(root);
    await stageSession(root, snapshot, new Provider());
    const exportPath = join(root, "broken.jsonl");
    writeFileSync(exportPath, "not-json\n");
    await expect(purgeRollout(root, "codex|s-purge", [exportPath])).rejects.toThrow(/malformed JSONL/);
    const idx = await Index.create(indexDb(root));
    try {
      expect(idx.stageGet("codex|s-purge")).toBeDefined();
    } finally {
      idx.close();
    }
  });
});
