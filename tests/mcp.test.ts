import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../src/mcp/index.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let prevRoot: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcp-"));
  prevRoot = process.env.MEMCORE_ROOT;
  process.env.MEMCORE_ROOT = dir;
});

afterEach(() => {
  if (prevRoot === undefined) {
    delete process.env.MEMCORE_ROOT;
  } else {
    process.env.MEMCORE_ROOT = prevRoot;
  }
  rmSync(dir, { recursive: true, force: true });
});

interface CallResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function parseText(result: CallResult): unknown {
  return JSON.parse(result.content?.[0]?.text ?? "");
}

describe("memcore MCP server", () => {
  test("exposes the four memory tools", async () => {
    const client = new Client({ name: "test", version: "0.0.1" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await Promise.all([client.connect(clientT), server.connect(serverT)]);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(["memory_forget", "memory_remember", "memory_search", "memory_status"]);
    await client.close();
    await server.close();
  });

  test("remember + search + status round-trip", async () => {
    const client = new Client({ name: "test", version: "0.0.1" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await Promise.all([client.connect(clientT), server.connect(serverT)]);

    const remembered = parseText(
      (await client.callTool({
        name: "memory_remember",
        arguments: { content: "跨会话记忆系统剪枝策略", kind: "MEMORY", ns: "proj-a" },
      })) as CallResult,
    ) as { entryId: string; ns: string };
    expect(remembered.ns).toBe("proj-a");
    expect(remembered.entryId).toHaveLength(32);

    const search = parseText(
      (await client.callTool({
        name: "memory_search",
        arguments: { query: "记忆系统", topK: 5 },
      })) as CallResult,
    ) as { hits: Array<{ entryId: string; content: string; ns: string }> };
    expect(search.hits.length).toBeGreaterThan(0);
    expect(search.hits[0].entryId).toBe(remembered.entryId);
    expect(search.hits[0].content).toContain("剪枝策略");

    const status = parseText(
      (await client.callTool({ name: "memory_status", arguments: {} })) as CallResult,
    ) as { backend: string; namespaces: string[]; counts: Record<string, Record<string, number>> };
    expect(status.namespaces).toContain("proj-a");
    expect(status.counts["proj-a"].active).toBe(1);
    expect(["trigram", "like"]).toContain(status.backend);

    const forgotten = parseText(
      (await client.callTool({
        name: "memory_forget",
        arguments: { entryId: remembered.entryId },
      })) as CallResult,
    ) as { removed: boolean };
    expect(forgotten.removed).toBe(true);

    const searchAfter = parseText(
      (await client.callTool({
        name: "memory_search",
        arguments: { query: "剪枝", topK: 5 },
      })) as CallResult,
    ) as { hits: unknown[] };
    expect(searchAfter.hits).toHaveLength(0);

    await client.close();
    await server.close();
  });

  test("forget of unknown entry reports not removed", async () => {
    const client = new Client({ name: "test", version: "0.0.1" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await Promise.all([client.connect(clientT), server.connect(serverT)]);

    const result = parseText(
      (await client.callTool({
        name: "memory_forget",
        arguments: { entryId: "00000000" },
      })) as CallResult,
    ) as { removed: boolean; reason: string };
    expect(result.removed).toBe(false);
    expect(result.reason).toBe("not found");

    await client.close();
    await server.close();
  });

  test("zod validation rejects out-of-range arguments", async () => {
    const client = new Client({ name: "test", version: "0.0.1" });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = createServer();
    await Promise.all([client.connect(clientT), server.connect(serverT)]);

    const bad = (await client.callTool({
      name: "memory_search",
      arguments: { query: "x", topK: 0 },
    })) as CallResult;
    expect(bad.isError).toBe(true);
    const tooBig = (await client.callTool({
      name: "memory_search",
      arguments: { query: "x", topK: 51 },
    })) as CallResult;
    expect(tooBig.isError).toBe(true);

    await client.close();
    await server.close();
  });
});
