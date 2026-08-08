import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { loadConfig } from "./config.js";
import { fitLines, renderBudgetNotice } from "./budget.js";
import { Index } from "./db.js";
import type { Entry } from "./mdStore.js";
import { indexDb, memoryRoot, namespaceFor, namespaces, nsDir, rootDir, txnLog } from "./paths.js";
import { sanitizeForInjection } from "./sanitize.js";
import { selectStatic } from "./select.js";
import { atomicWrite, withFileLock } from "./transaction.js";

const START_MARKER = "<!-- memcore:start -->";
const END_MARKER = "<!-- memcore:end -->";

function oneLine(content: string, max = 80): string {
  const flat = content.replaceAll("\n", " ");
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

function entryLine(e: Entry): string {
  return `- [${e.entryId}] ${oneLine(e.content)}（${e.kind.toLowerCase()}, use=${e.useCount}, score=${e.valueScore.toFixed(2)}）`;
}

export async function renderIndexMarkdown(idx: Index): Promise<string> {
  const root = rootDir();
  const lines = [
    "# Memcore 记忆索引",
    "",
    "> 由 memcore 自动生成（memcore index）。记忆真源按命名空间存放，可直接编辑 md 文件。",
    "",
  ];
  const nss = namespaces(root);
  if (!nss.length) {
    lines.push("_暂无命名空间。_");
    lines.push("");
  }
  for (const ns of nss) {
    const counts = idx.counts()[ns] ?? {};
    const top = selectStatic(idx, { ns, topN: 5 });
    lines.push(`## ${ns}`, "");
    lines.push(`- 路径: \`${nsDir(root, ns)}\``);
    const stats = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ");
    lines.push(`- 统计: ${stats || "empty"}`);
    if (top.length) {
      lines.push("", "顶级条目（按价值分）：", "", ...top.map(entryLine));
    }
    lines.push("");
  }
  lines.push("## 使用方式", "");
  lines.push("1. 新会话开始时读取本文件了解记忆概况；");
  lines.push("2. 需要细节时读取对应命名空间的 MEMORY.md / USER.md；");
  lines.push("3. 支持 memcore MCP 工具：memory_search / memory_remember / memory_forget / memory_status。");
  lines.push("");
  return lines.join("\n");
}

export function renderBaselineSection(ns: string, topEntries: Entry[], maxTokens?: number): string {
  const root = rootDir();
  const lines = topEntries
    .filter((e) => sanitizeForInjection(e.content).safe)
    .map(entryLine);
  const fitted = fitLines(lines, maxTokens ?? 1500);
  const body = [
    START_MARKER,
    "## 记忆系统（memcore）",
    "",
    "长期记忆由 memcore 维护。记忆真源为 Markdown 文件（人可读、可手动编辑）：",
    `- 全局索引: \`${join(memoryRoot(root), "INDEX.md")}\``,
    `- 本命名空间 MEMORY.md: \`${join(nsDir(root, ns), "MEMORY.md")}\``,
    `- 本命名空间 USER.md: \`${join(nsDir(root, ns), "USER.md")}\``,
    "",
    fitted.lines.length
      ? "当前注入的记忆（按价值分）："
      : "（本命名空间暂无记忆，可调用 memory_remember 沉淀）",
    ...fitted.lines,
    renderBudgetNotice(fitted.truncated),
    "",
    "记忆工具（MCP）：memory_search 检索 / memory_remember 写入 / memory_forget 删除 / memory_status 状态。",
    END_MARKER,
  ];
  return body.filter((l) => l !== "").join("\n") + "\n";
}

export function updateAgentsMd(workdir: string, section: string): void {
  const path = join(workdir, "AGENTS.md");
  const lockPath = join(
    rootDir(),
    "state",
    "locks",
    `${createHash("sha1").update(resolve(path)).digest("hex")}.lock`,
  );
  withFileLock(lockPath, () => {
    const existing = existsSync(path) ? readFileSync(path, "utf-8") : "";
    const start = existing.indexOf(START_MARKER);
    const end = existing.indexOf(END_MARKER);
    let next: string;
    if (start >= 0 && end >= 0) {
      next = existing.slice(0, start) + section + existing.slice(end + END_MARKER.length).replace(/^\n/, "");
    } else if (start >= 0 || end >= 0) {
      throw new Error("AGENTS.md contains unmatched memcore marker");
    } else {
      next = existing.trimEnd() ? existing.trimEnd() + "\n\n" + section : section;
    }
    atomicWrite(path, next);
  });
}

export async function generateIndex(): Promise<string> {
  const root = rootDir();
  const idx = await Index.create(indexDb(root));
  try {
    const content = await renderIndexMarkdown(idx);
    atomicWrite(join(memoryRoot(root), "INDEX.md"), content);
    idx.audit("index", "-", `regenerated INDEX.md`);
    return content;
  } finally {
    idx.close();
  }
}

export async function injectBaseline(workdir: string, topN?: number): Promise<number> {
  const root = rootDir();
  const config = loadConfig(root);
  const ns = namespaceFor(workdir);
  const idx = await Index.create(indexDb(root));
  try {
    const n = topN ?? config.budget.topKStatic;
    const top = selectStatic(idx, { ns, kinds: ["MEMORY", "USER"], topN: n });
    const blocked = top.filter((e) => !sanitizeForInjection(e.content).safe).length;
    const safe = top.filter((e) => sanitizeForInjection(e.content).safe);
    const fitted = fitLines(safe.map(entryLine), config.budget.maxInjectTokens);
    updateAgentsMd(workdir, renderBaselineSection(ns, top, config.budget.maxInjectTokens));
    idx.audit("baseline", ns, `${workdir} -> ${fitted.lines.length} injected of ${top.length}${blocked ? ` (${blocked} blocked by injection scan)` : ""}`);
    return fitted.lines.length;
  } finally {
    idx.close();
  }
}
