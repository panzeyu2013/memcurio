import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  integrationContext,
  integrationList,
  integrationRead,
  integrationRemember,
  integrationSearch,
  integrationStatus,
} from "../src/integration.js";
import { ensureLayout } from "../src/core/paths.js";
import { writeWorkspaceText } from "../src/core/workspace.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "integration-"));
  ensureLayout(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("stable integration surface", () => {
  test("searches, lists, reads, and renders context for an explicit root", async () => {
    writeWorkspaceText(root, "MEMORY.md", "# Task Group: sqlite\nUse FTS5 trigram indexing.\n");
    writeWorkspaceText(root, "memory_summary.md", "SQLite search decisions.\n");

    const search = await integrationSearch(root, "FTS5", 5);
    expect(search.hits[0]?.content).toContain("FTS5");
    expect((await integrationList(root)).entries.some((entry) => entry.path === "MEMORY.md")).toBe(true);
    expect((await integrationRead(root, { path: "MEMORY.md" })).content).toContain("trigram");
    expect((await integrationContext(root)).summary).toContain("SQLite search decisions");
  });

  test("remembers content and exposes pipeline status", async () => {
    const note = await integrationRemember(root, "Prefer workspace-isolated DSH memory stores.");
    expect(note.kind).toBe("remember");
    const status = await integrationStatus(root);
    expect(status.root).toBe(root);
    expect(status.notes).toEqual({ total: 1, pending: 1 });
  });
});
