import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MemcurioAdapter } from "../src/engine.js";
import type { LlmChannel } from "../src/core/channel.js";
import { addAdHocNote } from "../src/core/adhoc.js";
import { Index } from "../src/core/db.js";
import { indexDb } from "../src/core/paths.js";
import { writeWorkspaceText } from "../src/core/workspace.js";

let dir: string;
let prevRoot: string | undefined;
let prevProvider: string | undefined;
const PROJ = "/tmp/MyProject";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "engine-"));
  prevRoot = process.env.MEMCURIO_ROOT;
  process.env.MEMCURIO_ROOT = dir;
  prevProvider = process.env.MEMCURIO_LLM_PROVIDER;
  delete process.env.MEMCURIO_LLM_PROVIDER;
});

afterEach(() => {
  if (prevRoot === undefined) {
    delete process.env.MEMCURIO_ROOT;
  } else {
    process.env.MEMCURIO_ROOT = prevRoot;
  }
  if (prevProvider === undefined) {
    delete process.env.MEMCURIO_LLM_PROVIDER;
  } else {
    process.env.MEMCURIO_LLM_PROVIDER = prevProvider;
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Seed a stage-1 rollout plus its rollout_summaries artifact file; returns
 *  the absolute path of the summary file. */
async function seedRollout(rolloutKey: string): Promise<string> {
  const idx = await Index.create(indexDb(dir));
  try {
    idx.stageUpsert({
      rolloutKey,
      rawMemory: "raw",
      rolloutSummary: "summary",
      rolloutSlug: `slug-${rolloutKey.replace(/[^a-zA-Z0-9-]/g, "-")}`,
      sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
    });
    const filename = idx.stageGet(rolloutKey)?.artifactFilename ?? "";
    expect(filename).not.toBe("");
    writeWorkspaceText(dir, `rollout_summaries/${filename}`, "summary content");
    return join(dir, "memory", "rollout_summaries", filename);
  } finally {
    idx.close();
  }
}

/** Seed a rollout whose artifact filename is hand-picked (used for paths that
 *  contain spaces, which artifactFilenameForId never generates). */
async function seedRolloutWithFilename(rolloutKey: string, filename: string): Promise<string> {
  const idx = await Index.create(indexDb(dir));
  try {
    idx.driver.run(
      `INSERT INTO stage1_outputs(rollout_key, raw_memory, rollout_summary, rollout_slug,
         artifact_id, artifact_filename, source_updated_at, checkpoint_rank,
         checkpoint_source_event, generated_at, last_usage, usage_count,
         selected_for_phase2, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rolloutKey,
        "raw",
        "summary",
        "slug",
        `artid-${rolloutKey}`,
        filename,
        "2026-08-10T00:00:00.000Z",
        0,
        "",
        new Date().toISOString(),
        null,
        0,
        0,
        "pending",
      ],
    );
  } finally {
    idx.close();
  }
  writeWorkspaceText(dir, `rollout_summaries/${filename}`, "summary content");
  return join(dir, "memory", "rollout_summaries", filename);
}

/** Seed a never-selected pending stage-1 row whose timestamps are far in the
 *  past (outside any maxUnusedDays window) plus its summary artifact. */
async function seedOldPending(rolloutKey: string, filename: string): Promise<string> {
  const idx = await Index.create(indexDb(dir));
  try {
    idx.driver.run(
      `INSERT INTO stage1_outputs(rollout_key, raw_memory, rollout_summary, rollout_slug,
         artifact_id, artifact_filename, source_updated_at, checkpoint_rank,
         checkpoint_source_event, generated_at, last_usage, usage_count,
         selected_for_phase2, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        rolloutKey,
        "raw",
        "summary",
        "slug",
        "artid",
        filename,
        "2025-01-01T00:00:00.000Z",
        0,
        "",
        "2025-01-01T00:00:00.000Z",
        null,
        0,
        0,
        "pending",
      ],
    );
  } finally {
    idx.close();
  }
  writeWorkspaceText(dir, `rollout_summaries/${filename}`, "old summary content");
  return join(dir, "memory", "rollout_summaries", filename);
}

async function usageOf(rolloutKey: string): Promise<number | undefined> {
  const idx = await Index.create(indexDb(dir));
  try {
    return idx.stageGet(rolloutKey)?.usageCount;
  } finally {
    idx.close();
  }
}

describe("MemcurioAdapter retention prune (entry-side)", () => {
  test("sweeps orphan rollout summary files whose rows are gone (keep-set)", async () => {
    const adapter = new MemcurioAdapter({ durableQueue: true });
    const orphanPath = join(dir, "memory", "rollout_summaries", "orphan.md");
    writeWorkspaceText(dir, "rollout_summaries/orphan.md", "orphan content");
    const pending = await seedRollout("dsh|sweep-pending");
    await adapter.maybeConsolidate();
    expect(existsSync(orphanPath)).toBe(false);
    expect(existsSync(pending)).toBe(true);
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.stageGet("dsh|sweep-pending")).toBeDefined();
    } finally {
      idx.close();
    }
  });

  test("prunes retention-deleted rows even when consolidation never runs", async () => {
    const adapter = new MemcurioAdapter({ durableQueue: true });
    const idx = await Index.create(indexDb(dir));
    try {
      idx.stageUpsert({
        rolloutKey: "dsh|retention",
        rawMemory: "raw",
        rolloutSummary: "summary",
        rolloutSlug: "retention",
        sourceUpdatedAt: "2026-08-10T00:00:00.000Z",
      });
      idx.stageMarkDeleted(["dsh|retention"]);
    } finally {
      idx.close();
    }
    await adapter.maybeConsolidate();
    const idx2 = await Index.create(indexDb(dir));
    try {
      expect(idx2.stageGet("dsh|retention")).toBeUndefined();
      expect(
        idx2.rawAll<{ detail: string }>("SELECT detail FROM audit WHERE action = 'prune.retention'"),
      ).not.toEqual([]);
    } finally {
      idx2.close();
    }
  });

  test("recycles never-selected rows older than maxUnusedDays and deletes their summary files", async () => {
    const adapter = new MemcurioAdapter({ durableQueue: true });
    const oldPath = await seedOldPending("dsh|retention-old", "retention-old.md");
    await seedRollout("dsh|retention-fresh");
    await adapter.maybeConsolidate();
    expect(existsSync(oldPath)).toBe(false);
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.stageGet("dsh|retention-old")).toBeUndefined();
      expect(idx.stageGet("dsh|retention-fresh")).toBeDefined();
    } finally {
      idx.close();
    }
  });
});

describe("MemcurioAdapter shell usage telemetry", () => {
  test("read commands count memory reads; redirect writes do not", async () => {
    const adapter = new MemcurioAdapter();
    await adapter.sessionCreated("s1", PROJ, "dsh");
    const summaryPath = await seedRollout("dsh|usage-shell");
    await adapter.toolExecuted("s1", "bash", { command: `cat -n ${summaryPath}` });
    await adapter.toolExecuted("s1", "bash", { command: `grep fts ${summaryPath}` });
    await adapter.toolExecuted("s1", "bash", { command: `echo done > ${summaryPath}` });
    expect(await usageOf("dsh|usage-shell")).toBe(2);
  });

  const shellPolicyCases: Array<{
    name: string;
    command: string;
    expect: Record<string, number>;
  }> = [
    {
      name: "cat with two memory files counts both",
      command: "cat $A $B",
      expect: { "dsh|pol-a": 1, "dsh|pol-b": 1 },
    },
    { name: "echo of a memory path never counts", command: "echo $A", expect: { "dsh|pol-a": 0 } },
    { name: "expr operands never count", command: "expr $A x y", expect: { "dsh|pol-a": 0 } },
    {
      name: "unknown command with a memory path counts nothing",
      command: "python $A",
      expect: { "dsh|pol-a": 0 },
    },
    {
      name: "quoted path with a space counts once",
      command: 'cat "$S"',
      expect: { "dsh|spaced": 1 },
    },
    {
      name: "cat then rm separated by && counts only the read",
      command: "cat $A && rm $B",
      expect: { "dsh|pol-a": 1, "dsh|pol-b": 0 },
    },
    {
      name: "duplicate operands dedupe within one command",
      command: "cat $A $A",
      expect: { "dsh|pol-a": 1 },
    },
    {
      name: "head with -n flag still counts the file operand",
      command: "head -n 5 $A",
      expect: { "dsh|pol-a": 1 },
    },
  ];
  for (const c of shellPolicyCases) {
    test(`shell operand policy: ${c.name}`, async () => {
      const adapter = new MemcurioAdapter();
      await adapter.sessionCreated("s1", PROJ, "dsh");
      const a = await seedRollout("dsh|pol-a");
      const b = await seedRollout("dsh|pol-b");
      const spaced = await seedRolloutWithFilename("dsh|spaced", "a b.md");
      const command = c.command.replaceAll("$A", a).replaceAll("$B", b).replaceAll("$S", spaced);
      await adapter.toolExecuted("s1", "bash", { command });
      for (const [key, expected] of Object.entries(c.expect)) {
        expect(await usageOf(key)).toBe(expected);
      }
    });
  }

  test("a file literally named with the old U+E000 placeholder token is never rewritten into quoted text", async () => {
    const adapter = new MemcurioAdapter();
    await adapter.sessionCreated("s1", PROJ, "dsh");
    await seedRollout("dsh|pua-target");
    // U+E000 is legal in Linux filenames; NUL placeholders make any such
    // filename a plain, never-restored token.
    await adapter.toolExecuted("s1", "bash", { command: `cat ${"\uE000q0\uE000"}` });
    expect(await usageOf("dsh|pua-target")).toBe(0);
    // Restore only ever rewrites a full placeholder token: a quoted segment
    // glued to other text (`"a b.md"x`) must not restore "a b.md" either.
    await seedRolloutWithFilename("dsh|pua-spaced", "a b.md");
    await adapter.toolExecuted("s1", "bash", { command: 'cat "a b.md"x' });
    expect(await usageOf("dsh|pua-spaced")).toBe(0);
  });

  test("glued delimiters stop operand scanning; grep/rg pattern operands never count as paths", async () => {
    let adapter = new MemcurioAdapter();
    const summariesDir = join(dir, "memory", "rollout_summaries");
    await adapter.sessionCreated("s1", summariesDir, "dsh");
    await seedRolloutWithFilename("dsh|glue-a", "a.md");
    await seedRolloutWithFilename("dsh|glue-b", "b.md");
    await adapter.toolExecuted("s1", "bash", { command: "cat a.md&&b.md" });
    expect(await usageOf("dsh|glue-a")).toBe(1);
    expect(await usageOf("dsh|glue-b")).toBe(0);

    adapter = new MemcurioAdapter();
    await adapter.sessionCreated("s2", join(dir, "memory"), "dsh");
    await seedRolloutWithFilename("dsh|pat-x", "x.md");
    await seedRolloutWithFilename("dsh|pat-y", "y.md");
    await adapter.toolExecuted("s2", "bash", { command: "grep -r rollout_summaries/x.md ." });
    expect(await usageOf("dsh|pat-x")).toBe(0);
    await adapter.toolExecuted("s2", "bash", { command: "grep -e foo rollout_summaries/y.md" });
    expect(await usageOf("dsh|pat-y")).toBe(1);
    expect(await usageOf("dsh|pat-x")).toBe(0);
  });

  test("command length over the cap is bounded and telemetry survives", async () => {
    const adapter = new MemcurioAdapter();
    await adapter.sessionCreated("s1", PROJ, "dsh");
    const summaryPath = await seedRollout("dsh|cap");
    await adapter.toolExecuted("s1", "bash", { command: `cat ${"x".repeat(8_500)} ${summaryPath}` });
    expect(await usageOf("dsh|cap")).toBe(0);
    await adapter.toolExecuted("s1", "bash", { command: `cat ${summaryPath}` });
    expect(await usageOf("dsh|cap")).toBe(1);
  });
});

describe("MemcurioAdapter automatic consolidation channel gate", () => {
  test("MEMCURIO_LLM_PROVIDER=none forces the rule provider (channel never called)", async () => {
    let channelCalls = 0;
    const spyChannel: LlmChannel = {
      name: "spy",
      async chat(): Promise<string> {
        channelCalls += 1;
        throw new Error("spy channel must not be called under PROVIDER=none");
      },
    };
    const adapter = new MemcurioAdapter({ channel: spyChannel, durableQueue: true });
    await adapter.sessionCreated("s1", PROJ, "dsh");
    await addAdHocNote(dir, "pending under none", "remember");
    process.env.MEMCURIO_LLM_PROVIDER = "none";
    await adapter.maybeConsolidate();
    const idx = await Index.create(indexDb(dir));
    try {
      expect(idx.metaGet("consolidation_auto_last")).toBeTruthy();
      expect(idx.metaGet("consolidation_auto_failed")).toBeUndefined();
    } finally {
      idx.close();
    }
    expect(channelCalls).toBe(0);
  });
});
