/**
 * Native tool contract: every registered memory_* tool executes end-to-end
 * through the real tool runtime, not just its registration metadata.
 *
 * plugin.test.ts only exercised argument validation for most tools; the
 * success paths (and the no-session guard) lived entirely in the handlers.
 * This file owns that contract so a broken handler cannot hide behind a
 * well-covered service layer.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { ToolCallId } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";

import { Index } from "../src/core/db.js";
import { ensureLayout, indexDb } from "../src/core/paths.js";
import { writeWorkspaceText } from "../src/core/workspace.js";
import { createTestHost, disposeTestHost, executeOne } from "./support/host.js";
import type { TestHost } from "./support/host.js";
import { createTempRoots } from "./support/temp.js";

const plugin = await import("../src/plugin/index.js");

const temp = createTempRoots();

afterEach(() => {
  temp.cleanup();
});

interface Harness extends TestHost {
  root: string;
  session: ReturnType<TestHost["ctx"]["sessions"]["prepare"]>;
  detach: () => void;
  fiber: { dispose(): Promise<void> };
}

async function boot(): Promise<Harness> {
  const root = temp.root("memcurio-tools-");
  ensureLayout(root);
  const host = await createTestHost();
  const session = host.ctx.sessions.prepare(SessionId("tools-session"), {
    meta: { cwd: join(root, "workspace") },
  });
  const detach = host.ctx.sessions.enter(session);
  host.ctx.sessions.announce(session);
  const fiber = await host.ctx.plugin(plugin, {
    root,
    scope: "global",
    injectContext: false,
  });
  return { ...host, root, session, detach, fiber };
}

async function withPlugin(run: (harness: Harness) => Promise<void>): Promise<void> {
  const harness = await boot();
  try {
    await run(harness);
  } finally {
    harness.detach();
    await harness.fiber.dispose();
    await disposeTestHost(harness.fibers);
  }
}

function exec(
  harness: Harness,
  name: string,
  args: Record<string, unknown>,
  options: { session?: boolean } = {},
) {
  return executeOne(harness.ctx, {
    callId: ToolCallId(`tools-${name}`),
    name,
    arguments: args,
    ...(options.session === false ? {} : { agent: { session: harness.session } }),
  });
}

function toolValue(result: Awaited<ReturnType<typeof exec>>): unknown {
  if (result.isError) throw new Error(result.error.message);
  return JSON.parse(String(result.value));
}

describe("memory_search tool", () => {
  test("returns redacted hits and audits the integration call", async () => {
    await withPlugin(async (harness) => {
      writeWorkspaceText(
        harness.root,
        "MEMORY.md",
        "# Memory\n\n- the project uses SQLite FTS5 trigram search\n",
      );
      const result = await exec(harness, "memory_search", { query: "SQLite FTS5" });
      expect(result.isError).toBe(false);
      const body = toolValue(result) as { hits: Array<{ rel: string; content: string }>; blocked: number };
      expect(body.blocked).toBe(0);
      expect(body.hits.length).toBeGreaterThan(0);
      expect(body.hits.some((hit) => hit.rel === "MEMORY.md" && hit.content.includes("SQLite FTS5"))).toBe(true);

      const index = await Index.create(indexDb(harness.root));
      try {
        expect(index.auditRecent(10).some((row) => row.action === "integration.search")).toBe(true);
      } finally {
        index.close();
      }
    });
  });

  test("rejects a blank query before touching the workspace", async () => {
    await withPlugin(async (harness) => {
      const result = await exec(harness, "memory_search", { query: "   " });
      expect(result.isError).toBe(true);
      if (result.isError) expect(result.error.message).toContain("query must be a non-empty string");
    });
  });
});

describe("memory_list tool", () => {
  test("lists the memory workspace root", async () => {
    await withPlugin(async (harness) => {
      writeWorkspaceText(harness.root, "MEMORY.md", "# Memory\n");
      writeWorkspaceText(harness.root, "skills/SKILL.md", "# Skill\n");
      const body = toolValue(await exec(harness, "memory_list", {})) as {
        entries: Array<{ path: string; type: string }>;
      };
      expect(body.entries).toContainEqual({ path: "MEMORY.md", type: "file" });
      expect(body.entries).toContainEqual({ path: "skills", type: "directory" });
    });
  });
});

describe("memory_status tool", () => {
  test("reports the stage, note, extraction and audit counters", async () => {
    await withPlugin(async (harness) => {
      const body = toolValue(await exec(harness, "memory_status", {})) as {
        root: string;
        stage1: Record<string, number>;
        notes: Record<string, number>;
        extraction: Record<string, number>;
        auditCount: number;
      };
      expect(body.root).toBe(harness.root);
      expect(body.stage1).toEqual({ pending: 0, selected: 0, deleted: 0 });
      expect(body.notes).toEqual({ total: 0, pending: 0 });
      expect(body.extraction).toEqual({ pending: 0, processing: 0, blocked: 0, dead: 0 });
      expect(body.auditCount).toBeGreaterThanOrEqual(0);
    });
  });
});

describe("memory_context tool", () => {
  test("returns the summary and the read-path guide once a summary exists", async () => {
    await withPlugin(async (harness) => {
      writeWorkspaceText(harness.root, "memory_summary.md", "v1\n\n## Facts\n\n- project uses bun\n");
      const body = toolValue(await exec(harness, "memory_context", {})) as {
        summary: string;
        instructions: string;
      };
      expect(body.summary).toContain("MEMORY_SUMMARY");
      expect(body.summary).toContain("project uses bun");
      expect(body.instructions).toContain("memory_cite");
    });
  });

  test("answers no instructions while the store has no summary", async () => {
    await withPlugin(async (harness) => {
      const body = toolValue(await exec(harness, "memory_context", {})) as {
        summary: string;
        instructions: string;
      };
      expect(body.summary).toBe("");
      expect(body.instructions).toBe("");
    });
  });
});

describe("tool session guard", () => {
  test("a memory tool without an owning agent fails closed", async () => {
    await withPlugin(async (harness) => {
      const result = await exec(harness, "memory_status", {}, { session: false });
      expect(result.isError).toBe(true);
      if (result.isError) expect(result.error.message).toContain("requires an active DSH agent session");
    });
  });
});
