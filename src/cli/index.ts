#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { generateIndex, injectBaseline } from "../core/baseline.js";
import { loadConfig } from "../core/config.js";
import { applyCuratePlan, buildCuratePlan, formatCuratePlan, HttpProvider, NoopProvider } from "../core/curate.js";
import type { CurateProvider } from "../core/curate.js";
import { Index } from "../core/db.js";
import { makeEnvelope, parseEnvelope } from "../core/events.js";
import { KINDS, addEntry, readAll, updateKind } from "../core/mdStore.js";
import type { Entry, Kind, Status } from "../core/mdStore.js";
import { assertValidNs, configPath, ensureLayout, indexDb, memoryRoot, namespaceFor, namespaces, nsDir, rootDir, txnLog } from "../core/paths.js";
import { computeTransitions, formatTransition } from "../core/prune.js";
import { getRetriever } from "../core/retriever.js";
import { redactSecrets, sanitizeForInjection } from "../core/sanitize.js";
import { applyImport, applyMerge, planImport, planMerge, readExportFile, serializeExport, writeExport } from "../core/transfer.js";
import { Transaction, truncateLog } from "../core/transaction.js";
import { generateCodexPlugin } from "../adapters/codex/generate.js";
import { defaultSocketPath, runCodexDaemon } from "../adapters/codex/daemon.js";
import { runServer } from "../mcp/index.js";
import { t } from "./i18n.js";

function fail(msg: string): number {
  console.error(`error: ${msg}`);
  return 2;
}

async function withIndex<T>(fn: (idx: Index) => Promise<T>): Promise<T> {
  const idx = await Index.create(indexDb(rootDir()));
  try {
    return await fn(idx);
  } finally {
    idx.close();
  }
}

async function cmdInit(): Promise<number> {
  const root = rootDir();
  ensureLayout(root);
  loadConfig(root);
  const idx = await Index.create(indexDb(root));
  const backend = idx.backend;
  idx.audit("init", "-", "memcore initialized");
  idx.close();
  console.log(`initialized ${root}`);
  console.log(`index backend: ${backend}`);
  return 0;
}

async function cmdStatus(): Promise<number> {
  const root = rootDir();
  return withIndex(async (idx) => {
    console.log(`root      : ${root}`);
    console.log(`config    : ${configPath(root)} (${existsSync(configPath(root)) ? "ok" : "missing"})`);
    const counts = idx.counts();
    if (!Object.keys(counts).length) {
      console.log("namespaces: (none)");
    }
    for (const [ns, statuses] of Object.entries(counts)) {
      const parts = Object.entries(statuses)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      console.log(`  ${ns.padEnd(11)}: ${parts}`);
    }
    console.log(`index     : sqlite + ${idx.backend}`);
    console.log(`audit     : ${idx.auditCount()} records`);
    const pending = new Transaction(txnLog(root)).pending();
    console.log(`pending   : ${pending.length} txns`);
    return 0;
  });
}

function makeEntryId(content: string, ts: string): string {
  return createHash("sha1").update(`${ts}|${content}`).digest("hex").slice(0, 8);
}

async function cmdRemember(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { ns: { type: "string" }, kind: { type: "string" } },
  });
  const content = positionals[0];
  if (!content) {
    return fail(t("remember.missing"));
  }
  const root = rootDir();
  ensureLayout(root);
  const config = loadConfig(root);
  const explicitNs = values.ns as string | undefined;
  let ns: string;
  try {
    ns = assertValidNs(explicitNs ?? config.namespace.default);
  } catch (err) {
    return fail(String((err as Error).message));
  }
  const kind = ((values.kind as string | undefined) ?? "MEMORY").toUpperCase() as Kind;
  if (!KINDS.includes(kind)) {
    return fail(`remember: invalid kind '${kind}' (${KINDS.join("|")})`);
  }
  if (!explicitNs && ns !== namespaceFor(process.cwd())) {
    console.error(t("remember.nsNote", ns, namespaceFor(process.cwd())));
  }
  const redacted = redactSecrets(content);
  const flags = sanitizeForInjection(redacted.text);
  const ts = new Date().toISOString();
  const entry: Entry = {
    entryId: makeEntryId(redacted.text, ts),
    ns,
    kind,
    content: redacted.text,
    createdAt: ts,
    status: "active",
    pinned: false,
    lastUsedAt: null,
    useCount: 0,
    valueScore: 1,
  };
  return withIndex(async (idx) => {
    const txn = new Transaction(txnLog(root));
    txn.run("remember", ns, entry.entryId, () => {
      addEntry(nsDir(root, ns), entry);
      idx.add(entry);
      idx.audit("remember", ns, entry.entryId);
      if (redacted.redacted) {
        idx.audit("warn.redacted", ns, `secret redacted in ${entry.entryId}`);
      }
      if (!flags.safe) {
        idx.audit("warn.promptware", ns, `injection pattern on write: ${entry.entryId} (${flags.flags[0]})`);
      }
    });
    console.log(`${entry.entryId} ${ns}/${kind}${redacted.redacted ? " [secrets redacted]" : ""}`);
    return 0;
  });
}

async function cmdList(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { ns: { type: "string" }, kind: { type: "string" }, all: { type: "boolean" } },
  });
  const kind = values.kind ? ((values.kind as string).toUpperCase() as Kind) : undefined;
  return withIndex(async (idx) => {
    for (const e of idx.list({ ns: values.ns as string | undefined, kind, allStatus: values.all })) {
      const preview = e.content.replaceAll("\n", " ").slice(0, 60);
      console.log(`${e.entryId} ${e.ns}/${e.kind} ${e.status} use=${e.useCount} ${preview}`);
    }
    return 0;
  });
}

async function cmdSearch(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      ns: { type: "string" },
      kind: { type: "string" },
      "top-k": { type: "string" },
    },
  });
  const query = positionals[0];
  if (!query) {
    return fail(t("search.missing"));
  }
  const kind = values.kind ? ((values.kind as string).toUpperCase() as Kind) : undefined;
  const topK = Math.max(1, Number(values["top-k"] ?? 10) || 10);
  return withIndex(async (idx) => {
    const retriever = getRetriever(idx, (err) =>
      console.error(`fts search failed, falling back to LIKE: ${String(err)}`),
    );
    const hits = retriever.search({
      query,
      topK,
      ns: values.ns as string | undefined,
      kinds: kind ? [kind] : (["MEMORY", "USER"] as Kind[]),
    });
    const safeHits = hits.filter((h) => sanitizeForInjection(h.content).safe);
    for (const h of safeHits) {
      const preview = h.content.replaceAll("\n", " ").slice(0, 80);
      console.log(`${h.score.toFixed(2).padStart(7)} ${h.reason.padEnd(12)} ${h.entryId} ${h.ns}/${h.kind} ${preview}`);
    }
    idx.touch(safeHits.map((h) => h.entryId));
    idx.audit("search", values.ns as string | undefined ?? "-", `${JSON.stringify(redactSecrets(query).text)} -> ${safeHits.length} hits${hits.length !== safeHits.length ? ` (${hits.length - safeHits.length} filtered)` : ""}`);
    if (!safeHits.length) {
      console.error(t("search.note", values.ns ?? "all"));
    }
    return 0;
  });
}

async function cmdForget(rest: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true });
  const entryId = positionals[0];
  if (!entryId) {
    return fail(t("forget.missing"));
  }
  const root = rootDir();
  return withIndex(async (idx) => {
    const entry = idx.get(entryId);
    if (!entry) {
      return fail(`forget: no such entry ${entryId}`);
    }
    const txn = new Transaction(txnLog(root));
    txn.run("forget", entry.ns, entryId, () => {
      updateKind(nsDir(root, entry.ns), entry.kind, (entries) => entries.filter((e) => e.entryId !== entryId));
      idx.delete(entryId);
      idx.audit("forget", entry.ns, entryId);
    });
    console.log(`forgot ${entryId}`);
    return 0;
  });
}

async function cmdCompact(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { ns: { type: "string" } },
  });
  const content = positionals[0];
  if (!content) {
    return fail(t("compact.missing"));
  }
  const root = rootDir();
  ensureLayout(root);
  const config = loadConfig(root);
  const explicitNs = values.ns as string | undefined;
  let ns: string;
  try {
    ns = assertValidNs(explicitNs ?? config.namespace.default);
  } catch (err) {
    return fail(String((err as Error).message));
  }
  const redacted = redactSecrets(content);
  const flags = sanitizeForInjection(redacted.text);
  const ts = new Date().toISOString();
  const entry: Entry = {
    entryId: makeEntryId(redacted.text, ts),
    ns,
    kind: "COMPACT",
    content: redacted.text,
    createdAt: ts,
    status: "active",
    pinned: false,
    lastUsedAt: null,
    useCount: 0,
    valueScore: 1,
  };
  return withIndex(async (idx) => {
    const old = idx.list({ ns, kind: "COMPACT", allStatus: true });
    const txn = new Transaction(txnLog(root));
    txn.run("compact", ns, entry.entryId, () => {
      for (const e of old) {
        updateKind(nsDir(root, e.ns), e.kind, (entries) => entries.filter((x) => x.entryId !== e.entryId));
        idx.delete(e.entryId);
      }
      addEntry(nsDir(root, ns), entry);
      idx.add(entry);
      idx.audit("compact", ns, `${entry.entryId} replaced ${old.length} old strategy entries`);
      if (redacted.redacted) {
        idx.audit("warn.redacted", ns, `secret redacted in ${entry.entryId}`);
      }
      if (!flags.safe) {
        idx.audit("warn.promptware", ns, `injection pattern on write: ${entry.entryId} (${flags.flags[0]})`);
      }
    });
    console.log(t("compact.written", entry.entryId, ns, String(old.length)));
    return 0;
  });
}

async function cmdReindex(): Promise<number> {
  const root = rootDir();
  return withIndex(async (idx) => {
    const entries: Entry[] = [];
    for (const ns of namespaces(root)) {
      entries.push(...readAll(nsDir(root, ns)));
    }
    idx.rebuild(entries);
    idx.audit("reindex", "-", `${entries.length} entries`);
    console.log(`reindexed ${entries.length} entries (backend=${idx.backend})`);
    return 0;
  });
}

async function cmdRepair(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { execute: { type: "boolean" } },
  });
  const root = rootDir();
  const pending = new Transaction(txnLog(root)).pending();
  if (!pending.length) {
    console.log(t("repair.none"));
    return 0;
  }
  console.log(t("repair.pendingHeader", String(pending.length)));
  for (const p of pending) {
    console.log(`  ${p.txn} ${p.action ?? "?"} ns=${p.ns ?? "-"} ${p.detail ?? ""}`);
  }
  console.log(t("repair.truth"));
  if (!values.execute) {
    console.log(t("repair.fix"));
    return 0;
  }
  return withIndex(async (idx) => {
    const entries: Entry[] = [];
    for (const ns of namespaces(root)) {
      entries.push(...readAll(nsDir(root, ns)));
    }
    idx.rebuild(entries);
    idx.audit("repair", "-", `rebuilt from md: ${entries.length} entries, cleared ${pending.length} pending txns`);
    truncateLog(txnLog(root));
    console.log(`repaired: rebuilt ${entries.length} entries from md truth source, transaction log cleared`);
    return 0;
  });
}

async function cmdAudit(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { limit: { type: "string" } },
  });
  const limit = Math.max(1, Number(values.limit ?? 20) || 20);
  return withIndex(async (idx) => {
    for (const r of idx.auditRecent(limit)) {
      console.log(`${String(r.ts)} ${String(r.action).padEnd(10)} ${String(r.ns).padEnd(11)} ${String(r.detail)}`);
    }
    return 0;
  });
}

async function cmdEvent(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { json: { type: "string" } },
  });
  let env;
  try {
    if (values.json) {
      env = parseEnvelope(values.json);
    } else {
      if (process.stdin.isTTY) {
        return fail(t("event.tty"));
      }
      env = makeEnvelope(JSON.parse(readFileSync(0, "utf-8")));
    }
  } catch (err) {
    return fail(`event: invalid envelope: ${String(err)}`);
  }
  const root = rootDir();
  return withIndex(async (idx) => {
    if (env.event === "session_start") {
      idx.recordSession(env.sessionId, env.host, env.workdir, env.ts);
      idx.audit("event.session_start", env.workdir || "-", env.sessionId);
    } else if (env.event === "session_end") {
      idx.endSession(env.sessionId, env.ts);
      idx.audit("event.session_end", env.workdir || "-", env.sessionId);
    } else {
      idx.audit(`event.${env.event}`, env.workdir || "-", env.sessionId || env.host);
    }
    console.log(JSON.stringify(env));
    return 0;
  });
}

async function cmdPrune(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { execute: { type: "boolean" }, ns: { type: "string" } },
  });
  const root = rootDir();
  const config = loadConfig(root);
  const ns = values.ns as string | undefined;
  return withIndex(async (idx) => {
    const entries = idx.list({ ns, allStatus: true });
    const transitions = computeTransitions(entries, new Date(), config.prune);
    if (!transitions.length) {
      console.log("nothing to prune");
      return 0;
    }
    for (const t of transitions) {
      console.log(formatTransition(t));
    }
    if (!values.execute) {
      console.log(`${transitions.length} transitions proposed (dry-run). Re-run with --execute to apply.`);
      return 0;
    }
    const txn = new Transaction(txnLog(root));
    txn.run("prune", ns ?? "-", `${transitions.length} transitions`, () => {
      for (const t of transitions) {
        const e = idx.get(t.entryId);
        if (!e) {
          continue;
        }
        e.status = t.to as Status;
        idx.add(e);
        updateKind(nsDir(root, e.ns), e.kind, (entries) =>
          entries.map((x) => (x.entryId === e.entryId ? { ...x, status: t.to as Status } : x)),
        );
      }
      idx.audit(
        "prune",
        ns ?? "-",
        transitions.map((t) => `${t.entryId}:${t.from}->${t.to}`).join(","),
      );
    });
    console.log(`applied ${transitions.length} transitions`);
    return 0;
  });
}

async function cmdPin(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { unset: { type: "boolean" } },
  });
  const entryId = positionals[0];
  if (!entryId) {
    return fail("pin: missing entry_id");
  }
  const root = rootDir();
  const pinned = !values.unset;
  return withIndex(async (idx) => {
    const entry = idx.get(entryId);
    if (!entry) {
      return fail(`pin: no such entry ${entryId}`);
    }
    const txn = new Transaction(txnLog(root));
    txn.run(pinned ? "pin" : "unpin", entry.ns, entryId, () => {
      entry.pinned = pinned;
      idx.add(entry);
      updateKind(nsDir(root, entry.ns), entry.kind, (entries) =>
        entries.map((x) => (x.entryId === entryId ? { ...x, pinned } : x)),
      );
      idx.audit(pinned ? "pin" : "unpin", entry.ns, entryId);
    });
    console.log(`${entryId} ${pinned ? "pinned" : "unpinned"}`);
    return 0;
  });
}

async function cmdRevive(rest: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true });
  const entryId = positionals[0];
  if (!entryId) {
    return fail("revive: missing entry_id");
  }
  const root = rootDir();
  return withIndex(async (idx) => {
    const entry = idx.get(entryId);
    if (!entry) {
      return fail(`revive: no such entry ${entryId}`);
    }
    const txn = new Transaction(txnLog(root));
    txn.run("revive", entry.ns, entryId, () => {
      entry.status = "active";
      entry.lastUsedAt = new Date().toISOString();
      idx.add(entry);
      updateKind(nsDir(root, entry.ns), entry.kind, (entries) =>
        entries.map((x) => (x.entryId === entryId ? { ...x, status: "active" as Status } : x)),
      );
      idx.audit("revive", entry.ns, entryId);
    });
    console.log(`${entryId} revived`);
    return 0;
  });
}

async function cmdExport(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { ns: { type: "string" }, kind: { type: "string" }, output: { type: "string" } },
  });
  const kind = values.kind ? ((values.kind as string).toUpperCase() as Kind) : undefined;
  return withIndex(async (idx) => {
    const entries = idx.list({ ns: values.ns as string | undefined, kind, allStatus: true });
    const text = serializeExport(entries);
    if (values.output) {
      writeExport(values.output, entries);
      console.log(`exported ${entries.length} entries -> ${values.output}`);
    } else {
      process.stdout.write(text);
    }
    return 0;
  });
}

async function cmdImport(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { ns: { type: "string" } },
  });
  const path = positionals[0];
  if (!path) {
    return fail("import: missing <file.jsonl>");
  }
  const nsOverride = values.ns as string | undefined;
  if (nsOverride) {
    assertValidNs(nsOverride);
  }
  const root = rootDir();
  return withIndex(async (idx) => {
    const parsed = readExportFile(path);
    const plan = planImport(parsed, idx, nsOverride);
    for (const c of plan.conflicts) {
      console.log(`conflict ${c.entryId} exists with different content (skipped, ns=${c.ns})`);
    }
    const txn = new Transaction(txnLog(root));
    txn.run("import", nsOverride ?? "-", path, () => {
      applyImport(plan, idx, root);
      idx.audit("import", nsOverride ?? "-", `${path}: +${plan.added.length}, skip ${plan.skippedExisting}, dup ${plan.skippedDuplicate}, conflict ${plan.conflicts.length}`);
    });
    console.log(`imported ${plan.added.length} entries (${plan.skippedExisting} existing, ${plan.skippedDuplicate} content-dup, ${plan.conflicts.length} conflicts)`);
    return 0;
  });
}

async function cmdMerge(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { execute: { type: "boolean" } },
  });
  const srcNs = positionals[0];
  const dstNs = positionals[1];
  if (!srcNs || !dstNs) {
    return fail("merge: missing <src-ns> <dst-ns>");
  }
  try {
    assertValidNs(srcNs);
    assertValidNs(dstNs);
  } catch (err) {
    return fail(String((err as Error).message));
  }
  const root = rootDir();
  return withIndex(async (idx) => {
    const src = idx.list({ ns: srcNs, allStatus: true });
    const dst = idx.list({ ns: dstNs, allStatus: true });
    const plan = planMerge(src, dst, dstNs);
    for (const e of plan.toCopy) {
      console.log(`copy ${e.entryId} ${e.ns}/${e.kind} ${e.content.replaceAll("\n", " ").slice(0, 60)}`);
    }
    for (const c of plan.conflicts) {
      console.log(`conflict ${c.entryId} exists in both with different content (not copied)`);
    }
    for (const d of plan.dupsByContent) {
      console.log(`dup ${d.entryId} content already in ${dstNs} (skipped)`);
    }
    if (!values.execute) {
      console.log(`merge plan: ${plan.toCopy.length} to copy, ${plan.conflicts.length} conflicts, ${plan.dupsByContent.length} dups (dry-run). Re-run with --execute to apply.`);
      return 0;
    }
    const txn = new Transaction(txnLog(root));
    txn.run("merge", `${srcNs}->${dstNs}`, `${plan.toCopy.length} copied`, () => {
      applyMerge(plan, idx, root);
      idx.audit("merge", `${srcNs}->${dstNs}`, `copied ${plan.toCopy.length}, conflicts ${plan.conflicts.length}`);
    });
    console.log(`merged ${plan.toCopy.length} entries into ${dstNs}`);
    return 0;
  });
}

function resolveCurateProvider(): CurateProvider {
  const apiKey = process.env.MEMCORE_LLM_API_KEY;
  if (!apiKey) {
    return new NoopProvider();
  }
  return new HttpProvider({
    baseUrl: process.env.MEMCORE_LLM_BASE_URL ?? "https://api.openai.com/v1",
    apiKey,
    model: process.env.MEMCORE_LLM_MODEL ?? "gpt-4o-mini",
  });
}

async function cmdCurate(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      execute: { type: "boolean" },
      ns: { type: "string" },
      "min-use": { type: "string" },
      "max-checks": { type: "string" },
    },
  });
  const root = rootDir();
  const provider = resolveCurateProvider();
  return withIndex(async (idx) => {
    const plan = await buildCuratePlan(idx, provider, {
      ns: values.ns as string | undefined,
      minUseForReeval: values["min-use"] ? Math.max(1, Number(values["min-use"]) || 5) : undefined,
      maxChecks: values["max-checks"] ? Math.max(1, Number(values["max-checks"]) || 100) : undefined,
    });
    for (const line of formatCuratePlan(plan)) {
      console.log(line);
    }
    const lines = [
      `curate plan (provider=${provider.name}): ${plan.reevaluations.length} reevaluations, ${plan.contradictions.length} contradictions, ${plan.umbrellas.length} umbrellas${plan.unparsable ? `, ${plan.unparsable} unparsable` : ""} (dry-run).`,
    ];
    if (provider.name === "noop") {
      lines.push(t("curate.noKeyNote"));
    }
    console.log(lines.join("\n"));
    if (!values.execute) {
      return 0;
    }
    if (provider.name === "noop") {
      return fail(t("curate.needProvider"));
    }
    await applyCuratePlan(idx, root, plan);
    console.log(`curate applied: ${plan.reevaluations.length} scores, ${plan.contradictions.length} contradictions, ${plan.umbrellas.length} umbrellas`);
    return 0;
  });
}

async function cmdCodexDaemon(): Promise<number> {
  const root = rootDir();
  ensureLayout(root);
  const socketPath = process.env.MEMCORE_CODEX_SOCKET ?? defaultSocketPath(root);
  console.log(`memcore codex daemon listening on ${socketPath}`);
  const daemon = await runCodexDaemon({ socketPath, root });
  await daemon.closed;
  return 0;
}

async function cmdCodexPlugin(rest: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true });
  const root = rootDir();
  ensureLayout(root);
  const outDir = positionals[0] ?? join(root, "codex-plugin");
  const generated = await generateCodexPlugin(outDir);
  console.log(`codex plugin generated in ${generated.outDir}`);
  console.log(`  daemon  : ${generated.daemonPath}`);
  console.log(`  hook    : ${generated.hookPath}`);
  console.log(`  plugin  : ${generated.pluginJsonPath}`);
  console.log(`  snippet : ${generated.snippetPath}${t("codexPlugin.snippet")}`);
  console.log(t("codexPlugin.hint"));
  return 0;
}

async function cmdIndex(): Promise<number> {
  const root = rootDir();
  await generateIndex();
  console.log(`index regenerated: ${memoryRoot(root)}/INDEX.md`);
  return 0;
}

async function cmdBaseline(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { "top-k": { type: "string" } },
  });
  const workdir = positionals[0] ?? process.cwd();
  const topK = values["top-k"] ? Math.max(1, Number(values["top-k"]) || 10) : undefined;
  const root = rootDir();
  ensureLayout(root);
  loadConfig(root);
  await generateIndex();
  const ns = namespaceFor(workdir);
  const count = await injectBaseline(workdir, topK);
  console.log(`baseline written: ${workdir}/AGENTS.md (${count} entries injected, ns=${ns})`);
  return 0;
}

async function cmdMcp(): Promise<number> {
  await runServer();
  return 0;
}

async function cmdDoctor(): Promise<number> {
  const root = rootDir();
  let ok = true;
  const check = (name: string, pass: boolean, detail = ""): void => {
    console.log(`${pass ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!pass) {
      ok = false;
    }
  };
  check(t("doctor.layout"), existsSync(join(root, "memory")) && existsSync(join(root, "state")), root);
  try {
    loadConfig(root);
    check("config", true, t("doctor.parsable"));
  } catch (err) {
    check("config", false, String(err));
  }
  try {
    const idx = await Index.create(indexDb(root));
    const counts = idx.counts();
    const total = Object.values(counts).reduce((s, m) => s + Object.values(m).reduce((a, b) => a + b, 0), 0);
    check(t("doctor.index"), true, `backend=${idx.backend}, entries=${total}`);
    const pending = new Transaction(txnLog(root)).pending();
    check(t("doctor.txn"), pending.length === 0, pending.length ? `${pending.length} pending (memcore repair)` : t("doctor.noPending"));
    idx.close();
  } catch (err) {
    check(t("doctor.index"), false, String(err));
  }
  const socketPath = process.env.MEMCORE_CODEX_SOCKET ?? defaultSocketPath(root);
  const pluginDir = join(root, "codex-plugin");
  console.log(`· codex daemon${existsSync(socketPath) ? "" : t("doctor.daemonIdle")}: ${socketPath}`);
  console.log(`${t("doctor.pluginLabel")}${existsSync(join(pluginDir, "plugin.json")) ? "" : t("doctor.pluginMissing")}: ${pluginDir}`);
  console.log(ok ? t("doctor.ok") : t("doctor.bad"));
  return ok ? 0 : 1;
}

const HELP_CMDS = new Set([
  "init",
  "status",
  "remember",
  "list",
  "search",
  "forget",
  "pin",
  "revive",
  "prune",
  "curate",
  "export",
  "import",
  "merge",
  "baseline",
  "index",
  "reindex",
  "compact",
  "repair",
  "doctor",
  "audit",
  "event",
  "mcp",
  "codex-daemon",
  "codex-plugin",
  "help",
]);

async function cmdHelp(rest: string[]): Promise<number> {
  const cmd = rest[0];
  if (cmd && HELP_CMDS.has(cmd)) {
    console.log(t(`help.${cmd}`));
    return 0;
  }
  console.log(t("usage.main"));
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    switch (cmd) {
      case undefined:
      case "-h":
      case "--help":
      case "help":
        return await cmdHelp(rest);
      case "init":
        return await cmdInit();
      case "status":
        return await cmdStatus();
      case "remember":
        return await cmdRemember(rest);
      case "list":
        return await cmdList(rest);
      case "search":
        return await cmdSearch(rest);
      case "forget":
        return await cmdForget(rest);
      case "reindex":
        return await cmdReindex();
      case "compact":
        return await cmdCompact(rest);
      case "repair":
        return await cmdRepair(rest);
      case "audit":
        return await cmdAudit(rest);
      case "event":
        return await cmdEvent(rest);
      case "index":
        return await cmdIndex();
      case "baseline":
        return await cmdBaseline(rest);
      case "mcp":
        return await cmdMcp();
      case "prune":
        return await cmdPrune(rest);
      case "pin":
        return await cmdPin(rest);
      case "revive":
        return await cmdRevive(rest);
      case "export":
        return await cmdExport(rest);
      case "import":
        return await cmdImport(rest);
      case "merge":
        return await cmdMerge(rest);
      case "curate":
        return await cmdCurate(rest);
      case "codex-daemon":
        return await cmdCodexDaemon();
      case "codex-plugin":
        return await cmdCodexPlugin(rest);
      case "doctor":
        return await cmdDoctor();
      default:
        console.error(`error: unknown command: ${cmd}\n${t("unknownCommand")}`);
        return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`error: ${msg}`);
    const isUsage = /unknown option|invalid option|expected a value|missing required|unexpected option|no such option/i.test(
      msg,
    );
    return isUsage ? 2 : 1;
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
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
