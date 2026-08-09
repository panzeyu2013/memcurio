#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { generateIndex, injectBaseline } from "../core/baseline.js";
import { loadConfig, validateConfig } from "../core/config.js";
import { applyCuratePlan, buildCuratePlan, formatCuratePlan, HttpProvider, NoopProvider } from "../core/curate.js";
import type { CurateProvider } from "../core/curate.js";
import { Index } from "../core/db.js";
import { makeEnvelope, parseEnvelope } from "../core/events.js";
import { KINDS, newEntry, readAll, updateKindsAtomically } from "../core/mdStore.js";
import type { Entry, Kind, Status } from "../core/mdStore.js";
import { assertValidNs, configPath, ensureLayout, indexDb, memoryRoot, namespaceFor, namespaces, nsDir, rootDir, txnLog } from "../core/paths.js";
import { computeTransitions, formatTransition } from "../core/prune.js";
import { redactSecrets, sanitizeForInjection } from "../core/sanitize.js";
import { safeSearch } from "../core/safeSearch.js";
import { applyImport, applyMerge, MAX_MEMORY_CONTENT_CHARS, planImport, planMerge, readExportFile, serializeExport, writeExport } from "../core/transfer.js";
import { Transaction, truncateLog } from "../core/transaction.js";
import { llmEnv } from "../core/llm.js";
import { generateCodexPlugin } from "../adapters/codex/generate.js";
import { defaultSocketPath, runCodexDaemon } from "../adapters/codex/daemon.js";
import { runServer } from "../mcp/index.js";
import { t } from "./i18n.js";

// exit code convention: 2 = usage errors (unknown command/option, missing
// required argument), 1 = data/runtime errors, 0 = success.
function fail(msg: string): number {
  console.error(`error: ${msg}`);
  return 1;
}

function failUsage(msg: string): number {
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

function positiveInt(value: string | undefined, fallback: number, max = 1000, name?: string): number {
  if (value === undefined) {
    return fallback;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    console.warn(t("note.invalidInt", name ?? "value", value, String(fallback)));
    return fallback;
  }
  if (n > max) {
    console.warn(t("note.clamped", name ?? "value", value, String(max)));
    return max;
  }
  return Math.round(n);
}

function nsArg(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  return assertValidNs(raw);
}

const WRITABLE_KINDS: Kind[] = KINDS.filter((k) => k !== "SESSION" && k !== "COMPACT");
// Read-only commands (list/search/export) may filter on any kind.
const READONLY_KINDS: Kind[] = KINDS.filter((k) => !WRITABLE_KINDS.includes(k));

function kindArg(raw: string | undefined, extra: Kind[] = []): Kind | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const kind = raw.toUpperCase() as Kind;
  if (!KINDS.includes(kind) || ![...WRITABLE_KINDS, ...extra].includes(kind)) {
    throw new Error(`invalid kind '${kind}' (${KINDS.join("|")})`);
  }
  return kind;
}

/** Build per-file mutations that redact secrets found in the md truth, plus
 *  identity mutations for every other truth file, so a rebuild can read the
 *  full truth under the same locks that the mutation runs under. */
function collectTruthRedactionMutations(root: string): {
  mutations: Array<{ nsDir: string; kind: Kind; mutate: (entries: Entry[]) => Entry[] }>;
  redacted: number;
} {
  const mutations: Array<{ nsDir: string; kind: Kind; mutate: (entries: Entry[]) => Entry[] }> = [];
  let redacted = 0;
  for (const ns of namespaces(root)) {
    const dir = nsDir(root, ns);
    for (const kind of KINDS) {
      if (!existsSync(join(dir, `${kind}.md`))) {
        continue;
      }
      mutations.push({
        nsDir: dir,
        kind,
        mutate: (entries) =>
          entries.map((entry) => {
            const result = redactSecrets(entry.content);
            if (result.redacted) {
              redacted += 1;
              return { ...entry, content: result.text };
            }
            return entry;
          }),
      });
    }
  }
  return { mutations, redacted };
}

async function cmdInit(): Promise<number> {
  const root = rootDir();
  ensureLayout(root);
  loadConfig(root);
  const idx = await Index.create(indexDb(root));
  const backend = idx.backend;
  idx.audit("init", "-", "memcurio initialized");
  idx.close();
  console.log(t("init.done", root));
  console.log(t("init.backend", backend));
  return 0;
}

async function cmdStatus(): Promise<number> {
  const root = rootDir();
  return withIndex(async (idx) => {
    console.log(t("status.root", root));
    console.log(
      t("status.config", configPath(root), existsSync(configPath(root)) ? t("status.configOk") : t("status.configMissing")),
    );
    const counts = idx.counts();
    const indexedTotal = Object.values(counts).reduce((s, m) => s + Object.values(m).reduce((a, b) => a + b, 0), 0);
    if (!indexedTotal) {
      console.log(t("status.namespaces"));
    }
    for (const [ns, statuses] of Object.entries(counts)) {
      const parts = Object.entries(statuses)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join(", ");
      console.log(`  ${ns.padEnd(11)}: ${parts}`);
    }
    // The index alone can lie (crash between md write and index commit):
    // surface a drift warning when the md truth has content the index lacks.
    const truthTotal = namespaces(root).reduce((s, ns) => s + readAll(nsDir(root, ns)).length, 0);
    if (truthTotal > 0 && truthTotal !== indexedTotal) {
      console.warn(t("status.drift", String(truthTotal), String(indexedTotal)));
    }
    console.log(t("status.index", idx.backend));
    console.log(t("status.audit", String(idx.auditCount())));
    const txn = new Transaction(txnLog(root));
    console.log(t("status.pending", String(txn.pending().length)));
    return 0;
  });
}

async function cmdRemember(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { ns: { type: "string" }, kind: { type: "string" } },
  });
  const content = positionals[0];
  if (!content) {
    return failUsage(t("remember.missing"));
  }
  if (content.length > MAX_MEMORY_CONTENT_CHARS) {
    return failUsage(t("remember.tooLong", String(MAX_MEMORY_CONTENT_CHARS)));
  }
  const root = rootDir();
  ensureLayout(root);
  const config = loadConfig(root);
  const explicitNs = values.ns as string | undefined;
  let ns: string;
  try {
    ns = assertValidNs(explicitNs ?? config.namespace.default);
  } catch (err) {
    return failUsage(String((err as Error).message));
  }
  let kind: Kind;
  try {
    // SESSION/COMPACT are maintained by the harness/adapters, not by `remember`.
    kind = kindArg(values.kind as string | undefined, []) ?? "MEMORY";
  } catch (err) {
    return failUsage(String((err as Error).message));
  }
  if (!explicitNs && ns !== namespaceFor(process.cwd())) {
    console.error(t("remember.nsNote", ns, namespaceFor(process.cwd())));
  }
  const redacted = redactSecrets(content);
  const flags = sanitizeForInjection(redacted.text);
  const entry = newEntry(ns, kind, redacted.text);
  return withIndex(async (idx) => {
    const txn = new Transaction(txnLog(root));
    txn.run("remember", ns, entry.entryId, () => {
      updateKindsAtomically(
        [{ nsDir: nsDir(root, ns), kind, mutate: (entries) => [...entries, entry] }],
        () => idx.withTransaction(() => {
          idx.add(entry);
          idx.audit("remember", ns, entry.entryId);
          if (redacted.redacted) idx.audit("warn.redacted", ns, `secret redacted in ${entry.entryId}`);
          if (!flags.safe) idx.audit("warn.promptware", ns, `injection pattern on write: ${entry.entryId} (${flags.flags[0]})`);
        }),
      );
    });
    console.log(`${entry.entryId} ${ns}/${kind}${redacted.redacted ? ` ${t("remember.redacted")}` : ""}`);
    return 0;
  });
}

async function cmdList(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { ns: { type: "string" }, kind: { type: "string" }, all: { type: "boolean" } },
  });
  let ns: string | undefined;
  let kind: Kind | undefined;
  try {
    ns = nsArg(values.ns as string | undefined);
    kind = kindArg(values.kind as string | undefined, READONLY_KINDS);
  } catch (err) {
    return failUsage(String((err as Error).message));
  }
  return withIndex(async (idx) => {
    for (const e of idx.list({ ns, kind, allStatus: values.all })) {
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
    return failUsage(t("search.missing"));
  }
  let ns: string | undefined;
  let kind: Kind | undefined;
  try {
    ns = nsArg(values.ns as string | undefined);
    kind = kindArg(values.kind as string | undefined, READONLY_KINDS);
  } catch (err) {
    return failUsage(String((err as Error).message));
  }
  const topK = positiveInt(values["top-k"], 10, 1000, "top-k");
  return withIndex(async (idx) => {
    const result = safeSearch(idx, {
      query,
      topK,
      ns,
      kinds: kind ? [kind] : (["MEMORY", "USER"] as Kind[]),
    }, {
      onError: (err) => console.error(t("search.fallback", String(err))),
      onBlocked: (h, flag) => idx.audit("warn.promptware", h.ns, `blocked from cli result: ${h.entryId} (${flag})`),
    });
    const safeHits = result.hits;
    for (const h of safeHits) {
      const preview = h.content.replaceAll("\n", " ").slice(0, 80);
      console.log(`${h.score.toFixed(2).padStart(7)} ${h.reason.padEnd(12)} ${h.entryId} ${h.ns}/${h.kind} ${preview}`);
    }
    idx.touch(safeHits.map((h) => h.entryId));
    const filtered = result.blocked;
    idx.audit("search", ns ?? "-", `${JSON.stringify(redactSecrets(query).text)} -> ${safeHits.length} hits${filtered > 0 ? ` (${filtered} filtered)` : ""}`);
    if (!safeHits.length && !filtered) {
      console.error(t("search.note", ns ?? "all"));
    } else if (filtered > 0) {
      console.error(t("search.filtered", String(filtered)));
    }
    return 0;
  });
}

async function cmdForget(rest: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true });
  const entryId = positionals[0];
  if (!entryId) {
    return failUsage(t("forget.missing"));
  }
  const root = rootDir();
  return withIndex(async (idx) => {
    const entry = idx.get(entryId);
    if (!entry) {
      return fail(`forget: no such entry ${entryId}`);
    }
    const txn = new Transaction(txnLog(root));
    txn.run("forget", entry.ns, entryId, () => {
      updateKindsAtomically(
        [{ nsDir: nsDir(root, entry.ns), kind: entry.kind, mutate: (entries) => entries.filter((e) => e.entryId !== entryId) }],
        () => idx.withTransaction(() => {
          idx.delete(entryId);
          idx.audit("forget", entry.ns, entryId);
        }),
      );
    });
    console.log(t("forget.done", entryId));
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
    return failUsage(t("compact.missing"));
  }
  if (content.length > MAX_MEMORY_CONTENT_CHARS) {
    return failUsage(t("compact.tooLong", String(MAX_MEMORY_CONTENT_CHARS)));
  }
  const root = rootDir();
  ensureLayout(root);
  const config = loadConfig(root);
  const explicitNs = values.ns as string | undefined;
  let ns: string;
  try {
    ns = assertValidNs(explicitNs ?? config.namespace.default);
  } catch (err) {
    return failUsage(String((err as Error).message));
  }
  const redacted = redactSecrets(content);
  const flags = sanitizeForInjection(redacted.text);
  const entry = newEntry(ns, "COMPACT", redacted.text);
  return withIndex(async (idx) => {
    const txn = new Transaction(txnLog(root));
    let replaced = 0;
    txn.run("compact", ns, entry.entryId, () => {
      const oldIds: string[] = [];
      updateKindsAtomically(
        [{ nsDir: nsDir(root, ns), kind: "COMPACT", mutate: (entries) => {
          // Re-read the truth under the lock (never a pre-lock snapshot): a
          // daemon PostCompact reflection may have been appended meanwhile.
          // Replace only active/stale strategies; archived history (kept by
          // the daemon's compaction capping) is preserved.
          const toRemove = entries.filter((e) => e.status === "active" || e.status === "stale");
          oldIds.push(...toRemove.map((e) => e.entryId));
          replaced = toRemove.length;
          const kept = entries.filter((e) => e.status === "archived");
          return [...kept, entry];
        } }],
        () => idx.withTransaction(() => {
          for (const id of oldIds) {
            idx.delete(id);
          }
          idx.add(entry);
          idx.audit("compact", ns, `${entry.entryId} replaced ${replaced} old strategy entries`);
          if (redacted.redacted) idx.audit("warn.redacted", ns, `secret redacted in ${entry.entryId}`);
          if (!flags.safe) idx.audit("warn.promptware", ns, `injection pattern on write: ${entry.entryId} (${flags.flags[0]})`);
        }),
      );
    });
    console.log(t("compact.written", entry.entryId, ns, String(replaced)));
    return 0;
  });
}

async function cmdReindex(): Promise<number> {
  const root = rootDir();
  return withIndex(async (idx) => {
    const txn = new Transaction(txnLog(root));
    let total = 0;
    // Hold every truth-file lock for the whole md-redaction + index-rebuild
    // so concurrent adapter writes cannot be silently dropped, and log the
    // operation so a crash between md rewrite and rebuild leaves a pending
    // marker for `repair`.
    txn.run("reindex", "-", "rebuild from md truth", () => {
      const { mutations, redacted } = collectTruthRedactionMutations(root);
      updateKindsAtomically(mutations, (entries) => {
        total = entries.length;
        // Rebuild + audits commit in one SQLite transaction: if the audit
        // insert fails, the index rebuild rolls back with the md truth.
        idx.withTransaction(() => {
          idx.rebuild(entries);
          idx.audit("reindex", "-", `${entries.length} entries${redacted ? ` (${redacted} redacted)` : ""}`);
          if (redacted) {
            idx.audit("warn.redacted", "-", `secrets redacted during reindex: ${redacted} entries`);
          }
        });
      });
    });
    console.log(t("reindex.done", String(total), idx.backend));
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
  const txnLogObj = new Transaction(txnLog(root));
  const pending = txnLogObj.pending();
  const corrupt = txnLogObj.corruptLines();
  if (!pending.length && corrupt === 0) {
    console.log(t("repair.none"));
    return 0;
  }
  if (pending.length) {
    console.log(t("repair.pendingHeader", String(pending.length)));
  }
  if (corrupt > 0) {
    console.log(t("repair.corrupt", String(corrupt)));
  }
  for (const p of pending) {
    console.log(`  ${p.txn} ${p.action ?? "?"} ns=${p.ns ?? "-"} ${p.detail ?? ""}`);
  }
  if (pending.length) {
    console.log(t("repair.truth"));
  }
  if (!values.execute) {
    console.log(t("repair.fix"));
    // Issues exist but were not fixed: let scripts detect "needs repair".
    return 1;
  }
  return withIndex(async (idx) => {
    const txn = new Transaction(txnLog(root));
    let total = 0;
    txn.run("repair", "-", `cleared ${pending.length} pending txns`, () => {
      const { mutations, redacted } = collectTruthRedactionMutations(root);
      updateKindsAtomically(mutations, (entries) => {
        total = entries.length;
        idx.withTransaction(() => {
          idx.rebuild(entries);
          idx.audit(
            "repair",
            "-",
            `rebuilt from md: ${entries.length} entries, cleared ${pending.length} pending txns${redacted ? ` (${redacted} redacted)` : ""}`,
          );
          if (redacted) {
            idx.audit("warn.redacted", "-", `secrets redacted during repair: ${redacted} entries`);
          }
        });
      });
    });
    truncateLog(txnLog(root));
    console.log(t("repair.done", String(total)));
    return 0;
  });
}

async function cmdAudit(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { limit: { type: "string" } },
  });
  const limit = positiveInt(values.limit, 20, 1000, "limit");
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
  let ns: string | undefined;
  try {
    ns = nsArg(values.ns as string | undefined);
  } catch (err) {
    return failUsage(String((err as Error).message));
  }
  return withIndex(async (idx) => {
    const entries = idx.list({ ns, allStatus: true });
    const transitions = computeTransitions(entries, new Date(), config.prune);
    if (!transitions.length) {
      console.log(t("prune.none"));
      return 0;
    }
    for (const t of transitions) {
      console.log(formatTransition(t));
    }
    if (!values.execute) {
      console.log(t("prune.dryRun", String(transitions.length)));
      return 0;
    }
    const txn = new Transaction(txnLog(root));
    txn.run("prune", ns ?? "-", `${transitions.length} transitions`, () => {
      const ids = transitions.map((t) => t.entryId);
      const byId = new Map(transitions.map((t) => [t.entryId, t]));
      updateKindsAtomically(
        ids.map((id) => {
          const t = byId.get(id)!;
          return {
            nsDir: nsDir(root, t.ns),
            kind: t.kind as Kind,
            mutate: (entries) =>
              entries.map((x) => (x.entryId === id ? { ...x, status: t.to } : x)),
          };
        }),
        () => idx.withTransaction(() => {
          // Patch status only: a concurrent touch must keep its stats, and a
          // snapshot write from before the lock would regress them.
          for (const t of transitions) {
            idx.patch(t.entryId, { status: t.to });
          }
          idx.audit(
            "prune",
            ns ?? "-",
            transitions.map((t) => `${t.entryId}:${t.from}->${t.to}`).join(","),
          );
        }),
      );
    });
    console.log(t("prune.applied", String(transitions.length)));
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
    return failUsage("pin: missing entry_id");
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
      const fields: Partial<Entry> = { pinned };
      if (!pinned) {
        // Restart the idle clock on unpin: the pinned period did not count
        // against the entry, so it must not be pruned immediately.
        fields.lastUsedAt = new Date().toISOString();
      }
      updateKindsAtomically(
        [{ nsDir: nsDir(root, entry.ns), kind: entry.kind, mutate: (entries) =>
          entries.map((x) => (x.entryId === entryId ? { ...x, ...fields } : x)) }],
        () => idx.withTransaction(() => {
          idx.patch(entryId, fields);
          idx.audit(pinned ? "pin" : "unpin", entry.ns, entryId);
        }),
      );
    });
    console.log(pinned ? t("pin.done", entryId) : t("unpin.done", entryId));
    return 0;
  });
}

async function cmdRevive(rest: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true });
  const entryId = positionals[0];
  if (!entryId) {
    return failUsage("revive: missing entry_id");
  }
  const root = rootDir();
  return withIndex(async (idx) => {
    const entry = idx.get(entryId);
    if (!entry) {
      return fail(`revive: no such entry ${entryId}`);
    }
    const txn = new Transaction(txnLog(root));
    txn.run("revive", entry.ns, entryId, () => {
      const fields: Partial<Entry> = { status: "active" as Status, lastUsedAt: new Date().toISOString() };
      updateKindsAtomically(
        [{ nsDir: nsDir(root, entry.ns), kind: entry.kind, mutate: (entries) =>
          entries.map((x) => (x.entryId === entryId ? { ...x, status: "active" as Status } : x)) }],
        () => idx.withTransaction(() => {
          idx.patch(entryId, fields);
          idx.audit("revive", entry.ns, entryId);
        }),
      );
    });
    console.log(t("revive.done", entryId));
    return 0;
  });
}

async function cmdExport(rest: string[]): Promise<number> {
  const { values } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { ns: { type: "string" }, kind: { type: "string" }, output: { type: "string" } },
  });
  let ns: string | undefined;
  let kind: Kind | undefined;
  try {
    ns = nsArg(values.ns as string | undefined);
    kind = kindArg(values.kind as string | undefined, READONLY_KINDS);
  } catch (err) {
    return failUsage(String((err as Error).message));
  }
  return withIndex(async (idx) => {
    const entries = idx.list({ ns, kind, allStatus: true });
    const text = serializeExport(entries);
    if (values.output) {
      writeExport(values.output, entries);
      console.log(t("export.done", String(entries.length), values.output));
    } else {
      process.stdout.write(text);
    }
    idx.audit("export", ns ?? "-", `${entries.length} entries${values.output ? ` -> ${values.output}` : " -> stdout"}`);
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
    return failUsage("import: missing <file.jsonl>");
  }
  const nsOverride = values.ns as string | undefined;
  if (nsOverride) {
    try {
      assertValidNs(nsOverride);
    } catch (err) {
      return failUsage(String((err as Error).message));
    }
  }
  const root = rootDir();
  return withIndex(async (idx) => {
    const parsed = readExportFile(path);
    const plan = planImport(parsed, idx, nsOverride);
    for (const c of plan.conflicts) {
      console.log(t("import.conflict", c.entryId, c.ns));
    }
    if (plan.conflicts.length) {
      return fail(t("import.conflictFail", String(plan.conflicts.length)));
    }
    const txn = new Transaction(txnLog(root));
    txn.run("import", nsOverride ?? "-", path, () => {
      applyImport(plan, idx, root);
      idx.audit("import", nsOverride ?? "-", `${path}: +${plan.added.length}, skip ${plan.skippedExisting}, dup ${plan.skippedDuplicate}, conflict ${plan.conflicts.length}`);
    });
    console.log(t("import.done", String(plan.added.length), String(plan.skippedExisting), String(plan.skippedDuplicate), String(plan.conflicts.length)));
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
    return failUsage("merge: missing <src-ns> <dst-ns>");
  }
  try {
    assertValidNs(srcNs);
    assertValidNs(dstNs);
  } catch (err) {
    return failUsage(String((err as Error).message));
  }
  const root = rootDir();
  return withIndex(async (idx) => {
    const src = idx.list({ ns: srcNs, allStatus: true });
    const dst = idx.list({ ns: dstNs, allStatus: true });
    const reservedIds = new Set(idx.list({ allStatus: true }).map((e) => e.entryId));
    const plan = planMerge(src, dst, dstNs, reservedIds);
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
      console.log(t("merge.dryRun", String(plan.toCopy.length), String(plan.conflicts.length), String(plan.dupsByContent.length)));
      return 0;
    }
    const txn = new Transaction(txnLog(root));
    txn.run("merge", `${srcNs}->${dstNs}`, `${plan.toCopy.length} copied`, () => {
      applyMerge(plan, idx, root);
      idx.audit("merge", `${srcNs}->${dstNs}`, `copied ${plan.toCopy.length}, conflicts ${plan.conflicts.length}`);
    });
    console.log(t("merge.done", String(plan.toCopy.length), dstNs));
    return 0;
  });
}

function resolveCurateProvider(): CurateProvider {
  const env = llmEnv();
  if (!env.apiKey) {
    return new NoopProvider();
  }
  return new HttpProvider({
    baseUrl: env.baseUrl,
    apiKey: env.apiKey,
    model: env.model,
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
  const maxChecks = values["max-checks"] ? positiveInt(values["max-checks"], 100, 1000, "max-checks") : undefined;
  return withIndex(async (idx) => {
    const plan = await buildCuratePlan(idx, provider, {
      ns: values.ns as string | undefined,
      minUseForReeval: values["min-use"] ? positiveInt(values["min-use"], 5, 1_000_000, "min-use") : undefined,
      maxChecks,
    });
    for (const line of formatCuratePlan(plan)) {
      console.log(line);
    }
    if (plan.unparsable > 0) {
      console.log(t("curate.unparsable", String(plan.unparsable)));
    }
    if (plan.checksExhausted) {
      console.log(t("curate.exhausted", String(maxChecks ?? 100)));
    }
    const lines = [
      t("curate.plan", provider.name, String(plan.reevaluations.length), String(plan.contradictions.length), String(plan.umbrellas.length)),
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
    console.log(t("curate.applied", String(plan.reevaluations.length), String(plan.contradictions.length), String(plan.umbrellas.length)));
    return 0;
  });
}

async function cmdCodexDaemon(): Promise<number> {
  const root = rootDir();
  ensureLayout(root);
  const socketPath = process.env.MEMCURIO_CODEX_SOCKET ?? defaultSocketPath(root);
  console.log(t("daemon.listening", socketPath));
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
  console.log(t("codexPlugin.generated", generated.outDir));
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
  console.log(t("index.done", memoryRoot(root)));
  return 0;
}

async function cmdBaseline(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { "top-k": { type: "string" } },
  });
  const workdir = positionals[0] ?? process.cwd();
  const topK = values["top-k"] ? positiveInt(values["top-k"], 10, 1000, "top-k") : undefined;
  const root = rootDir();
  ensureLayout(root);
  loadConfig(root);
  await generateIndex();
  const ns = namespaceFor(workdir);
  const count = await injectBaseline(workdir, topK);
  console.log(t("baseline.done", workdir, String(count), ns));
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
    validateConfig(root);
    check(t("doctor.config"), true, t("doctor.parsable"));
  } catch (err) {
    check(t("doctor.config"), false, String(err));
  }
  try {
    // Doctor performs its own read-only mirror comparison below; do not heal
    // the mismatch during open or the diagnostic would become false-green.
    const idx = await Index.create(indexDb(root), { verifyFts: false });
    const counts = idx.counts();
    const total = Object.values(counts).reduce((s, m) => s + Object.values(m).reduce((a, b) => a + b, 0), 0);
    check(t("doctor.index"), true, `backend=${idx.backend}, entries=${total}`);
    const truth = namespaces(root).flatMap((ns) => readAll(nsDir(root, ns)));
    const indexed = idx.list({ allStatus: true });
    const indexedById = new Map(indexed.map((e) => [e.entryId, e]));
    const truthIds = new Set(truth.map((e) => e.entryId));
    const duplicateIds = truth.length - truthIds.size;
    check(t("doctor.truthIds"), duplicateIds === 0, duplicateIds ? t("doctor.duplicateIds", String(duplicateIds)) : t("doctor.unique"));
    const drift = truth.filter((e) => {
      const row = indexedById.get(e.entryId);
      return !row || row.ns !== e.ns || row.kind !== e.kind || row.content !== e.content ||
        row.createdAt !== e.createdAt || row.status !== e.status || row.pinned !== e.pinned;
    }).length + indexed.filter((e) => !truthIds.has(e.entryId)).length;
    check(t("doctor.truthIndex"), drift === 0, drift ? t("doctor.mismatch", String(drift)) : t("doctor.aligned", String(truth.length)));
    if (idx.backend === "trigram") {
      const ftsCount = idx.driver.get<{ c: number }>("SELECT count(*) AS c FROM fts")?.c ?? 0;
      const bad = idx.driver.get<{ bad: number }>(
        `SELECT 1 AS bad FROM (
          SELECT entry_id, content FROM entries
          EXCEPT
          SELECT entry_id, content FROM fts
        ) LIMIT 1`,
      ) || idx.driver.get<{ bad: number }>(
        `SELECT 1 AS bad FROM (
          SELECT entry_id FROM fts
          EXCEPT
          SELECT entry_id FROM entries
        ) LIMIT 1`,
      );
      check(t("doctor.ftsMirror"), ftsCount === indexed.length && !bad, `${ftsCount}/${indexed.length} rows${ftsCount !== indexed.length || bad ? t("doctor.reindexHint") : ""}`);
    }
    const pending = new Transaction(txnLog(root)).pending();
    check(t("doctor.txn"), pending.length === 0, pending.length ? `${pending.length} pending (memcurio repair)` : t("doctor.noPending"));
    idx.close();
  } catch (err) {
    check(t("doctor.index"), false, String(err));
  }
  const socketPath = process.env.MEMCURIO_CODEX_SOCKET ?? defaultSocketPath(root);
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
    if (/unable to open database file/i.test(msg)) {
      console.error(t("init.hint"));
    }
    const isUsage = /unknown option|invalid option|expected a value|missing required|unexpected option|no such option|argument missing/i.test(
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
