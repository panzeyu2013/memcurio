import { pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "../core/config.js";
import { Index } from "../core/db.js";
import { KINDS, newEntry, updateKindsAtomically } from "../core/mdStore.js";
import type { Kind } from "../core/mdStore.js";
import { assertValidNs, indexDb, ensureLayout, namespaces, nsDir, rootDir, txnLog } from "../core/paths.js";
import { redactSecrets, sanitizeForInjection } from "../core/sanitize.js";
import { safeSearch } from "../core/safeSearch.js";
import { Transaction } from "../core/transaction.js";
import { MAX_MEMORY_CONTENT_CHARS } from "../core/transfer.js";

const VERSION = "0.1.0";

const MODEL_KINDS = KINDS.filter((k) => k !== "SESSION");

async function openIndex(): Promise<Index> {
  const root = rootDir();
  ensureLayout(root);
  return Index.create(indexDb(root));
}

function text(content: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(content) }] };
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "memcurio", version: VERSION });

  server.registerTool(
    "memory_search",
    {
      title: "Search memories",
      description:
        "跨会话长期记忆中检索条目，返回匹配的 memory 条目（内容 + 命名空间 + 相关度分）。记忆来自本项目与其他项目的历史会话沉淀。命中即计入使用次数（价值分）。",
      inputSchema: {
        query: z.string().trim().min(1).max(10_000).describe("检索关键词，中文/英文均可"),
        topK: z.number().int().min(1).max(50).default(10).describe("返回条数上限"),
        ns: z.string().max(40).optional().describe("命名空间过滤（默认全部）"),
        kind: z.enum(MODEL_KINDS).optional().describe("条目类型：MEMORY=事实/决策/约束，USER=用户偏好"),
      },
    },
    async (args) => {
      const idx = await openIndex();
      try {
        const result = safeSearch(idx, {
          query: args.query,
          topK: args.topK,
          ns: args.ns,
          kinds: args.kind ? [args.kind as Kind] : MODEL_KINDS,
        }, {
          onError: (err) => console.error(`fts search failed, falling back to LIKE: ${String(err)}`),
          onBlocked: (h, flag) => idx.audit("warn.promptware", h.ns, `blocked from mcp result: ${h.entryId} (${flag})`),
        });
        const filtered = result.hits;
        idx.touch(filtered.map((h) => h.entryId));
        idx.audit("mcp.search", args.ns ?? "-", `${redactSecrets(args.query).text} -> ${filtered.length} hits${result.blocked ? ` (${result.blocked} filtered)` : ""}`);
        return text({
          hits: filtered.map((h) => ({
            entryId: h.entryId,
            ns: h.ns,
            kind: h.kind,
            content: h.content,
            score: h.score,
            reason: h.reason,
          })),
        });
      } finally {
        idx.close();
      }
    },
  );

  server.registerTool(
    "memory_remember",
    {
      title: "Remember a memory",
      description:
        "把一条长期记忆写入跨会话记忆库（事实、决策、约束、用户偏好）。写入后未来所有 harness 的会话都能检索到。内容将自动脱敏（密钥 → [REDACTED]）。",
      inputSchema: {
        content: z.string().trim().min(1).max(MAX_MEMORY_CONTENT_CHARS).describe("记忆内容，自包含、简洁、可作为独立条目"),
        kind: z.enum(MODEL_KINDS).default("MEMORY").describe("MEMORY=事实/决策/约束，USER=用户偏好"),
        ns: z.string().max(40).optional().describe("命名空间（默认取配置 namespace.default，通常等于项目目录名）"),
      },
    },
    async (args) => {
      const root = rootDir();
      const config = loadConfig(root);
      const ns = assertValidNs(args.ns ?? config.namespace.default);
      const idx = await openIndex();
      try {
        const redacted = redactSecrets(args.content);
        const flags = sanitizeForInjection(redacted.text);
        const entry = newEntry(ns, args.kind, redacted.text);
        const txn = new Transaction(txnLog(root));
        txn.run("mcp.remember", entry.ns, entry.entryId, () => {
          updateKindsAtomically(
            [{ nsDir: nsDir(root, entry.ns), kind: entry.kind, mutate: (entries) => [...entries, entry] }],
            () => idx.withTransaction(() => {
              idx.add(entry);
              idx.audit("mcp.remember", entry.ns, entry.entryId);
              if (redacted.redacted) idx.audit("warn.redacted", entry.ns, `secret redacted in ${entry.entryId}`);
              if (!flags.safe) idx.audit("warn.promptware", entry.ns, `injection pattern on write: ${entry.entryId} (${flags.flags[0]})`);
            }),
          );
        });
        return text({ entryId: entry.entryId, ns: entry.ns, kind: entry.kind, redacted: redacted.redacted });
      } finally {
        idx.close();
      }
    },
  );

  server.registerTool(
    "memory_forget",
    {
      title: "Forget a memory",
      description: "按 entry_id 删除一条记忆（同时从 Markdown 真源与索引移除，留审计）。",
      inputSchema: {
        entryId: z.string().regex(/^[0-9a-f]{8}(?:[0-9a-f]{24})?$/).describe("memory_search 返回的 entryId"),
      },
    },
    async (args) => {
      const root = rootDir();
      const idx = await openIndex();
      try {
        const entry = idx.get(args.entryId);
        if (!entry) {
          return text({ removed: false, reason: "not found" });
        }
        const txn = new Transaction(txnLog(root));
        txn.run("mcp.forget", entry.ns, args.entryId, () => {
          updateKindsAtomically(
            [{ nsDir: nsDir(root, entry.ns), kind: entry.kind, mutate: (entries) => entries.filter((e) => e.entryId !== args.entryId) }],
            () => idx.withTransaction(() => {
              idx.delete(args.entryId);
              idx.audit("mcp.forget", entry.ns, args.entryId);
            }),
          );
        });
        return text({ removed: true, entryId: args.entryId });
      } finally {
        idx.close();
      }
    },
  );

  server.registerTool(
    "memory_status",
    {
      title: "Memory store status",
      description: "查看记忆库状态：命名空间、条目统计、索引后端、最近审计。",
      inputSchema: {},
    },
    async () => {
      const root = rootDir();
      const idx = await openIndex();
      try {
        return text({
          root,
          backend: idx.backend,
          namespaces: namespaces(root),
          counts: idx.counts(),
          auditCount: idx.auditCount(),
        });
      } finally {
        idx.close();
      }
    },
  );

  return server;
}

export async function runServer(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  try {
    await server.connect(transport);
  } catch (err) {
    console.error(`memcurio mcp server error: ${String(err)}`);
    process.exitCode = 1;
  }
}

const isMain = (() => {
  try {
    return pathToFileURL(process.argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isMain) {
  await runServer();
}
