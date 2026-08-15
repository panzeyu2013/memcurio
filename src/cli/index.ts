#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { addAdHocNote, pendingAdHocNotes } from "../core/adhoc.js";
import { LlmExtractProvider } from "../core/extract.js";
import { loadConfig, pipelineConfig, validateConfig } from "../core/config.js";
import {
  LlmLoopConsolidateProvider,
  RuleConsolidateProvider,
  planConsolidation,
  runConsolidation,
  syncArtifacts,
  withWorkspaceWriteLease,
} from "../core/consolidate.js";
import { resolveChannel } from "../core/channel.js";
import { Index } from "../core/db.js";
import type { AdHocNoteRow, Stage1OutputRow } from "../core/db.js";
import { makeEnvelope, parseEnvelope, MAX_ENVELOPE_BYTES } from "../core/events.js";
import type { EventEnvelope } from "../core/events.js";
import { injectBaseline } from "../core/inject.js";
import { configPath, ensureLayout, indexDb, rootDir, txnLog } from "../core/paths.js";
import { redactSecrets, sanitizeForInjection } from "../core/sanitize.js";
import { searchMemory } from "../core/search.js";
import { Transaction, truncateLog } from "../core/transaction.js";
import { generationMarkerFromMeta, inspectGenerationManifests, recoverPendingGenerations } from "../core/generation.js";
import { deleteAdHocNoteFile, hasWorkspaceChanges, NOTE_FILENAME_RE, noteFilePath, readWorkspaceText, rolloutSlugs, writeAdHocNoteFile } from "../core/workspace.js";
import { purgeRollout } from "../core/purge.js";
import { MemcurioAdapter } from "../adapters/shared/engine.js";
import { runServer } from "../mcp/index.js";
import { cmdSetup } from "./setup.js";
import { t } from "./i18n.js";

// exit code convention: 2 = usage errors (unknown command/option, missing
// required argument), 1 = data/runtime errors, 0 = success.
function fail(msg: string): number {
  console.error(`${t("error.prefix")}${msg}`);
  return 1;
}

function failUsage(msg: string): number {
  console.error(`${t("error.prefix")}${msg}`);
  return 2;
}

/** Warn about positional arguments a command does not consume, so a typo
 *  (`memcurio remember a b`) is not silently accepted. */
function warnExtraArgs(cmd: string, positionals: string[], max: number): void {
  if (positionals.length > max) {
    console.warn(t("note.extraArgs", cmd, String(max)));
  }
}

/** Thrown by CLI-level validation so the top-level handler can classify the
 *  exit code without sniffing error-message strings. */
export class UsageError extends Error {}

const MAX_NOTE_CHARS = 20_000;
const MAX_IMPORT_BYTES = 10 * 1024 * 1024;
const MAX_IMPORT_TEXT_CHARS = 200_000;

async function withStore<T>(fn: (idx: Index) => Promise<T>): Promise<T> {
  const root = rootDir();
  const freshRoot = !existsSync(indexDb(root));
  if (freshRoot) {
    console.error(t("init.autocreated"));
  }
  ensureLayout(root);
  const idx = await Index.create(indexDb(root));
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
  if (!Number.isInteger(n)) {
    console.warn(t("note.nonInteger", name ?? "value", value));
  }
  return Math.round(n);
}

async function cmdInit(): Promise<number> {
  const root = rootDir();
  ensureLayout(root);
  loadConfig(root);
  const idx = await Index.create(indexDb(root));
  try {
    idx.audit("init", "-", "memcurio initialized");
  } finally {
    idx.close();
  }
  console.log(t("init.done", root));
  return 0;
}

async function cmdStatus(): Promise<number> {
  const root = rootDir();
  return withStore(async (idx) => {
    console.log(t("status.root", root));
    let configState: string;
    if (!existsSync(configPath(root))) {
      configState = t("status.configMissing");
    } else {
      try {
        validateConfig(root);
        configState = t("status.configOk");
      } catch {
        configState = t("status.configBroken");
      }
    }
    console.log(t("status.config", configPath(root), configState));
    const stages = idx.stageList();
    const pending = stages.filter((s) => s.status === "pending").length;
    const selected = stages.filter((s) => s.status === "selected").length;
    const deleted = stages.filter((s) => s.status === "deleted").length;
    console.log(t("status.stage1", String(pending), String(selected), String(deleted)));
    const notes = idx.noteList();
    console.log(t("status.notes", String(notes.length), String(notes.filter((n) => !n.applied).length)));
    console.log(t("status.audit", String(idx.auditCount())));
    const txn = new Transaction(txnLog(root));
    console.log(t("status.pending", String(txn.pending().length)));
    console.log(t("status.extractions", String(idx.extractionPendingCount())));
    return 0;
  });
}

async function runRuleConsolidation(root: string): Promise<string> {
  const run = await runConsolidation(root, new RuleConsolidateProvider(), { execute: true, config: pipelineConfig(root) });
  return run.message;
}

async function cmdRemember(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { apply: { type: "boolean" } },
  });
  const content = positionals[0];
  if (!content) {
    return failUsage(t("remember.missing"));
  }
  warnExtraArgs("remember", positionals, 1);
  if (content.length > MAX_NOTE_CHARS) {
    return failUsage(t("remember.tooLong", String(MAX_NOTE_CHARS)));
  }
  const root = rootDir();
  ensureLayout(root);
  const note = await addAdHocNote(root, content, "remember");
  console.log(t("remember.done", note.filename));
  if (values.apply) {
    console.log(await runRuleConsolidation(root));
  } else {
    console.error(t("remember.applyNote"));
  }
  return 0;
}

async function cmdList(rest: string[]): Promise<number> {
  warnExtraArgs("list", rest, 0);
  const root = rootDir();
  ensureLayout(root);
  const memory = readWorkspaceText(root, "MEMORY.md");
  const groups = [...memory.matchAll(/^# Task Group: (.+)$/gm)].map((m) => m[1] ?? "").filter(Boolean);
  const rollouts = rolloutSlugs(root);
  const notes = (await pendingAdHocNotes(root)).filter((n) => !n.applied);
  if (!groups.length && !rollouts.length && !notes.length) {
    console.log(t("list.empty"));
    return 0;
  }
  if (groups.length) {
    console.log(t("list.groups"));
    for (const g of groups) {
      console.log(`  # Task Group: ${g}`);
    }
  }
  if (rollouts.length) {
    console.log(t("list.rollouts"));
    for (const r of rollouts) {
      console.log(`  rollout_summaries/${r}`);
    }
  }
  if (notes.length) {
    console.log(t("list.notes"));
    for (const n of notes) {
      console.log(`  [${n.kind}] ${n.filename}`);
    }
  }
  return 0;
}

async function cmdSearch(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { "top-k": { type: "string" } },
  });
  const query = positionals[0];
  if (!query) {
    return failUsage(t("search.missing"));
  }
  warnExtraArgs("search", positionals, 1);
  const topK = positiveInt(values["top-k"], 10, 1000, "top-k");
  const root = rootDir();
  const result = await searchMemory(root, query, topK);
  return withStore(async (idx) => {
    for (const h of result.hits) {
      console.log(`${String(h.score).padStart(3)} ${h.rel}:${h.line} ${h.content.slice(0, 120)}`);
    }
    idx.audit("search", "-", `${JSON.stringify(redactSecrets(query).text)} -> ${result.hits.length} hits${result.blocked > 0 ? ` (${result.blocked} filtered)` : ""}`);
    if (!result.hits.length && !result.blocked) {
      console.error(t("search.note"));
    } else if (result.blocked > 0) {
      console.error(t("search.filtered", String(result.blocked)));
    }
    return 0;
  });
}

async function cmdPrune(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { execute: { type: "boolean" } },
  });
  warnExtraArgs("prune", positionals, 0);
  const root = rootDir();
  ensureLayout(root);
  const cfg = pipelineConfig(root);
  const plan = await planConsolidation(root, cfg);
  console.log(plan.preview);
  if (!plan.pruned.length) {
    console.log(t("prune.none"));
  } else if (!values.execute) {
    console.log(t("prune.executeHint"));
  }
  if (!values.execute) {
    return 0;
  }
  const run = await runConsolidation(root, new RuleConsolidateProvider(), { execute: true, config: cfg });
  if (plan.pruned.length) {
    console.log(t("prune.applied", String(plan.pruned.length)));
  }
  console.log(run.message);
  return 0;
}

async function cmdPurge(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      "rollout-key": { type: "string" },
      execute: { type: "boolean" },
      export: { type: "string" },
    },
  });
  warnExtraArgs("purge", positionals, 0);
  const rolloutKey = values["rollout-key"];
  if (!rolloutKey) {
    return failUsage(t("purge.missingKey"));
  }
  if (!values.execute) {
    return failUsage(t("purge.requiresExecute"));
  }
  const root = rootDir();
  const result = await purgeRollout(root, rolloutKey, values.export ? [values.export] : []);
  if (!result) {
    console.log(t("purge.notFound", rolloutKey));
    return 1;
  }
  console.log(t("purge.done", result.rolloutKey, result.artifactFilename, String(result.exportRecords), String(result.skillsRemoved)));
  return 0;
}

async function cmdCurate(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { execute: { type: "boolean" }, "max-steps": { type: "string" } },
  });
  warnExtraArgs("curate", positionals, 0);
  const root = rootDir();
  ensureLayout(root);
  const cfg = pipelineConfig(root);
  const plan = await planConsolidation(root, cfg);
  console.log(plan.preview);
  if (!values.execute) {
    console.log(t("curate.dryRun"));
    return 0;
  }
  const channel = resolveChannel();
  const maxSteps = values["max-steps"] ? positiveInt(values["max-steps"], cfg.maxAgentSteps, 1000, "max-steps") : cfg.maxAgentSteps;
  const provider = channel ? new LlmLoopConsolidateProvider(maxSteps, channel) : new RuleConsolidateProvider();
  const run = await runConsolidation(root, provider, { execute: true, config: cfg });
  console.log(t("curate.applied", run.message));
  if (!channel) {
    console.log(t("curate.noKeyNote"));
  }
  return 0;
}

async function cmdBaseline(rest: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true });
  const workdir = positionals[0] ?? process.cwd();
  warnExtraArgs("baseline", positionals, 1);
  const root = rootDir();
  ensureLayout(root);
  loadConfig(root);
  const bytes = await injectBaseline(workdir);
  console.log(t("baseline.done", workdir, String(bytes)));
  return 0;
}

async function cmdReindex(rest: string[] = []): Promise<number> {
  warnExtraArgs("reindex", rest, 0);
  const root = rootDir();
  ensureLayout(root);
  const cfg = pipelineConfig(root);
  return withWorkspaceWriteLease(root, async (idx, renew) => {
    recoverPendingGenerations(root, generationMarkerFromMeta(idx.metaGet("consolidation_generation")));
    const plan = await planConsolidation(root, cfg);
    renew();
    const txn = new Transaction(txnLog(root));
    txn.run("reindex", "-", "sync artifacts from stage1", () => {
      syncArtifacts(root, plan);
      idx.audit("reindex", "-", `synced ${Object.keys(plan.artifacts).length} artifact file(s), pruned ${plan.pruned.length}`);
    });
    console.log(t("reindex.done", String(Object.keys(plan.artifacts).length)));
    return 0;
  });
}

async function cmdRepair(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { execute: { type: "boolean" } },
  });
  warnExtraArgs("repair", positionals, 0);
  const root = rootDir();
  const txnLogObj = new Transaction(txnLog(root));
  const pending = txnLogObj.pending();
  const corrupt = txnLogObj.corruptLines();
  const generations = inspectGenerationManifests(root);
  if (!pending.length && corrupt === 0 && generations.length === 0) {
    console.log(t("repair.none"));
    return 0;
  }
  if (pending.length) {
    console.log(t("repair.pendingHeader", String(pending.length)));
  }
  if (corrupt > 0) {
    console.log(t("repair.corrupt", String(corrupt)));
  }
  if (generations.length) {
    console.log(t("repair.generations", String(generations.length)));
    for (const generation of generations) {
      console.log(`  generation ${generation.id} phase=${generation.phase}${generation.targetCount === undefined ? "" : ` targets=${generation.targetCount}`}`);
    }
  }
  for (const p of pending) {
    console.log(`  ${p.txn} ${p.action ?? "?"} ns=${p.ns ?? "-"} ${p.detail ?? ""}`);
  }
  if (pending.length) {
    console.log(t("repair.truth"));
  }
  if (!values.execute) {
    console.log(t("repair.fix"));
    return 1;
  }
  if (generations.some((generation) => generation.phase === "invalid")) {
    console.error(t("repair.invalidGeneration"));
    return 1;
  }
  ensureLayout(root);
  const cfg = pipelineConfig(root);
  return withWorkspaceWriteLease(root, async (idx, renew) => {
    const recovered = recoverPendingGenerations(root, generationMarkerFromMeta(idx.metaGet("consolidation_generation")));
    const plan = await planConsolidation(root, cfg);
    renew();
    const txn = new Transaction(txnLog(root));
    let count = 0;
    txn.run("repair", "-", `cleared ${pending.length} pending txns`, () => {
      syncArtifacts(root, plan);
      count = Object.keys(plan.artifacts).length;
      idx.audit("repair", "-", `re-synced ${count} artifact file(s), cleared ${pending.length} pending txns, recovered ${recovered.length} generation(s)`);
    });
    truncateLog(txnLog(root));
    console.log(t("repair.done", String(count)));
    return 0;
  });
}

async function cmdAudit(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { limit: { type: "string" } },
  });
  warnExtraArgs("audit", positionals, 0);
  const limit = positiveInt(values.limit, 20, 1000, "limit");
  return withStore(async (idx) => {
    for (const r of idx.auditRecent(limit)) {
      console.log(`${String(r.ts)} ${String(r.action).padEnd(10)} ${String(r.ns).padEnd(11)} ${String(r.detail)}`);
    }
    return 0;
  });
}

async function cmdEvent(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { json: { type: "string" } },
  });
  warnExtraArgs("event", positionals, 0);
  let env: EventEnvelope;
  try {
    if (values.json) {
      env = parseEnvelope(values.json);
    } else {
      if (process.stdin.isTTY) {
        return fail(t("event.tty"));
      }
      const raw = readFileSync(0, "utf-8");
      if (Buffer.byteLength(raw, "utf-8") > MAX_ENVELOPE_BYTES) {
        return fail(t("event.invalid", "input exceeds the size limit"));
      }
      env = makeEnvelope(JSON.parse(raw));
    }
  } catch (err) {
    return fail(t("event.invalid", String(err)));
  }
  return withStore(async (idx) => {
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

interface ExportRecord {
  type: "stage1" | "note";
  rolloutKey?: string;
  rawMemory?: string;
  rolloutSummary?: string;
  rolloutSlug?: string;
  artifactId?: string;
  artifactFilename?: string;
  sourceUpdatedAt?: string;
  generatedAt?: string;
  lastUsage?: string | null;
  usageCount?: number;
  selectedForPhase2?: boolean;
  status?: string;
  checkpointRank?: number;
  checkpointSourceEvent?: string;
  id?: string;
  filename?: string;
  kind?: string;
  content?: string;
  createdAt?: string;
  applied?: boolean;
}

type ValidatedImportRecord =
  | {
    type: "stage1";
    rolloutKey: string;
    rawMemory: string;
    rolloutSummary: string;
    rolloutSlug: string;
    sourceUpdatedAt: string;
    checkpointRank: number;
    checkpointSourceEvent: string;
    generatedAt: string;
    lastUsage: string | null;
    usageCount: number;
    status: Stage1OutputRow["status"];
  }
  | { type: "note"; id: string; filename: string; kind: "remember" | "forget" | "update"; content: string; createdAt: string; applied: boolean };

function serializeStage1(s: Stage1OutputRow): ExportRecord {
  return {
    type: "stage1",
    rolloutKey: s.rolloutKey,
    rawMemory: s.rawMemory,
    rolloutSummary: s.rolloutSummary,
    rolloutSlug: s.rolloutSlug,
    artifactId: s.artifactId,
    artifactFilename: s.artifactFilename,
    sourceUpdatedAt: s.sourceUpdatedAt,
    generatedAt: s.generatedAt,
    lastUsage: s.lastUsage,
    usageCount: s.usageCount,
    selectedForPhase2: s.selectedForPhase2,
    status: s.status,
    checkpointRank: s.checkpointRank,
    checkpointSourceEvent: s.checkpointSourceEvent,
  };
}

function serializeNote(n: AdHocNoteRow): ExportRecord {
  return {
    type: "note",
    id: n.id,
    filename: n.filename,
    kind: n.kind,
    content: n.content,
    createdAt: n.createdAt,
    applied: n.applied,
  };
}

async function cmdExport(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { output: { type: "string" } },
  });
  warnExtraArgs("export", positionals, 0);
  return withStore(async (idx) => {
    const records: ExportRecord[] = [
      ...idx.stageList().map(serializeStage1),
      ...idx.noteList().map(serializeNote),
    ];
    const text = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
    if (values.output) {
      writeExportFile(values.output, text);
      console.log(t("export.done", String(records.length), values.output));
    } else {
      process.stdout.write(text);
    }
    idx.audit("export", "-", `${records.length} records${values.output ? ` -> ${values.output}` : " -> stdout"}`);
    return 0;
  });
}

function writeExportFile(path: string, text: string): void {
  writeFileSync(path, text, { mode: 0o600 });
}

function safeImportScalar(value: unknown, max: number, required = false): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  const hasControl = Array.from(text).some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x1f || code === 0x7f;
  });
  if ((required && !text) || text.length > max || hasControl) {
    return null;
  }
  return text;
}

function safeImportIso(value: unknown, fallback?: string): string | null {
  if (value === undefined && fallback !== undefined) {
    return fallback;
  }
  const text = safeImportScalar(value, 100, true);
  if (!text) {
    return null;
  }
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function importCheckpointRank(sourceEvent: string): number {
  if (sourceEvent === "session_end") {
    return 2;
  }
  if (sourceEvent === "idle" || sourceEvent === "stop" || sourceEvent === "post_compact") {
    return 1;
  }
  return 0;
}

/** Validate and sanitize a JSONL record before opening the destination store.
 * This keeps malformed/untrusted input from causing partial imports or writing
 * arbitrary note paths. */
function validateImportRecord(value: unknown): ValidatedImportRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as ExportRecord;
  if (record.type === "stage1") {
    const rolloutKey = safeImportScalar(record.rolloutKey, 500, true);
    const rawMemoryText = typeof record.rawMemory === "string" ? record.rawMemory : null;
    const rolloutSummaryText = typeof record.rolloutSummary === "string" ? record.rolloutSummary : null;
    if (!rolloutKey || rawMemoryText === null || rolloutSummaryText === null) {
      return null;
    }
    const rawMemory = redactSecrets(rawMemoryText).text.trim();
    const rolloutSummary = redactSecrets(rolloutSummaryText).text.trim();
    if (rawMemory.length > MAX_IMPORT_TEXT_CHARS || rolloutSummary.length > MAX_IMPORT_TEXT_CHARS) {
      return null;
    }
    if ((!rawMemory && !rolloutSummary) || !sanitizeForInjection(`${rawMemoryText}\n${rolloutSummaryText}`).safe) {
      // The injection gate must see the RAW pre-redaction fields: scanning
      // the redacted form would launder payloads like "reveal your token
      // AbCdef…" whose secret value was already replaced by "[REDACTED]".
      return null;
    }
    const suppliedSlug = record.rolloutSlug === undefined ? "rollout" : safeImportScalar(record.rolloutSlug, 80);
    if (!suppliedSlug || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/.test(suppliedSlug)) {
      return null;
    }
    const now = new Date().toISOString();
    const sourceUpdatedAt = safeImportIso(record.sourceUpdatedAt, now);
    if (!sourceUpdatedAt) {
      return null;
    }
    const generatedAt = safeImportIso(record.generatedAt, sourceUpdatedAt);
    const lastUsage = record.lastUsage === null || record.lastUsage === undefined
      ? null
      : safeImportIso(record.lastUsage);
    const usageCount = record.usageCount === undefined ? 0 : record.usageCount;
    const checkpointRank = record.checkpointRank === undefined ? 0 : record.checkpointRank;
    const checkpointSourceEvent = record.checkpointSourceEvent === undefined
      ? ""
      : safeImportScalar(record.checkpointSourceEvent, 80);
    const status = record.status === undefined
      ? (record.selectedForPhase2 === true ? "selected" : "pending")
      : record.status;
    if (
      !generatedAt || (record.lastUsage !== null && record.lastUsage !== undefined && !lastUsage) ||
      !Number.isSafeInteger(usageCount) || usageCount < 0 || usageCount > 1_000_000_000 ||
      !Number.isSafeInteger(checkpointRank) || checkpointRank < 0 || checkpointRank > 2 ||
      checkpointSourceEvent === null ||
      checkpointRank !== importCheckpointRank(checkpointSourceEvent) ||
      (status !== "pending" && status !== "selected" && status !== "deleted")
    ) {
      return null;
    }
    return {
      type: "stage1",
      rolloutKey,
      rawMemory,
      rolloutSummary,
      rolloutSlug: suppliedSlug,
      sourceUpdatedAt,
      checkpointRank,
      checkpointSourceEvent,
      generatedAt,
      lastUsage,
      usageCount,
      status,
    };
  }
  if (record.type === "note") {
    const id = safeImportScalar(record.id, 128, true);
    const filename = safeImportScalar(record.filename, 128, true);
    const contentText = typeof record.content === "string" ? record.content : null;
    const content = contentText === null ? null : redactSecrets(contentText).text.trim();
    const kind = record.kind;
    if (
      !id || !/^[A-Za-z0-9_-]{1,128}$/.test(id) ||
      !filename || !NOTE_FILENAME_RE.test(filename) ||
      content === null || !content || content.length > MAX_NOTE_CHARS ||
      (kind !== "remember" && kind !== "forget" && kind !== "update") ||
      (contentText !== null && !sanitizeForInjection(contentText).safe)
    ) {
      return null;
    }
    const createdAt = safeImportIso(record.createdAt, new Date().toISOString());
    if (!createdAt) {
      return null;
    }
    if (record.applied !== undefined && typeof record.applied !== "boolean") {
      return null;
    }
    return { type: "note", id, filename, kind, content, createdAt, applied: record.applied === true };
  }
  return null;
}

async function cmdImport(rest: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true });
  const path = positionals[0];
  if (!path) {
    return failUsage(t("import.missing"));
  }
  warnExtraArgs("import", positionals, 1);
  const root = rootDir();
  ensureLayout(root);
  try {
    if (statSync(path).size > MAX_IMPORT_BYTES) {
      return fail(t("import.tooLarge", String(MAX_IMPORT_BYTES)));
    }
  } catch (err) {
    return fail(String(err));
  }
  const raw = readFileSync(path, "utf-8");
  const records: ValidatedImportRecord[] = [];
  let invalid = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = validateImportRecord(JSON.parse(line));
      if (parsed) {
        records.push(parsed);
      } else {
        invalid += 1;
      }
    } catch {
      invalid += 1;
    }
  }
  if (invalid) {
    return fail(t("import.invalid", String(invalid)));
  }
  if (!records.length) {
    return fail(t("import.empty", path));
  }
  return withStore(async (idx) => {
    const stageKeys = new Set(idx.stageList().map((row) => row.rolloutKey));
    const noteIds = new Set(idx.noteList().map((note) => note.id));
    const plannedNoteFiles = new Set<string>();
    const additions: ValidatedImportRecord[] = [];
    let skipped = 0;
    // Resolve conflicts before touching either SQLite or the note files. A
    // same filename with a different id is ambiguous and must not overwrite
    // an existing note (including an orphan left by an interrupted import).
    for (const r of records) {
      if (r.type === "stage1") {
        if (stageKeys.has(r.rolloutKey)) {
          skipped += 1;
        } else {
          stageKeys.add(r.rolloutKey);
          additions.push(r);
        }
        continue;
      }
      if (noteIds.has(r.id)) {
        skipped += 1;
        continue;
      }
      if (plannedNoteFiles.has(r.filename) || existsSync(noteFilePath(root, r.filename))) {
        throw new Error(`import filename collision: ${r.filename}`);
      }
      noteIds.add(r.id);
      plannedNoteFiles.add(r.filename);
      additions.push(r);
    }
    let added = 0;
    const createdNoteFiles: string[] = [];
    try {
      idx.withTransaction(() => {
        for (const r of additions) {
          if (r.type === "stage1") {
            idx.stageRestore(r);
          } else {
            writeAdHocNoteFile(root, r.filename, r.content);
            createdNoteFiles.push(r.filename);
            idx.noteAdd({
              id: r.id,
              filename: r.filename,
              kind: r.kind,
              content: r.content,
              createdAt: r.createdAt,
              applied: r.applied,
            });
          }
          added += 1;
        }
        idx.audit("import", path, `+${added}, skip ${skipped}`);
      });
    } catch (err) {
      // SQLite rolls back automatically; remove only files created by this
      // batch so a failed cross-resource import cannot leave ghost notes.
      for (const filename of createdNoteFiles.reverse()) {
        try {
          deleteAdHocNoteFile(root, filename);
        } catch {
          // Preserve the original import error; doctor can expose any file
          // drift if the filesystem itself is unavailable.
        }
      }
      throw err;
    }
    console.log(t("import.done", String(added), String(skipped)));
    return 0;
  });
}

async function cmdRetryExtraction(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      limit: { type: "string" },
      dead: { type: "boolean" },
      provider: { type: "string" },
    },
  });
  warnExtraArgs("retry-extraction", positionals, 0);
  const limit = positiveInt(values.limit, 8, 100, "limit");
  let requeued = 0;
  if (values.dead) {
    requeued = await withStore(async (idx) => {
      const count = idx.extractionRequeueDead();
      if (count) {
        idx.audit("extract.queue_requeue_dead", "-", String(count));
      }
      return count;
    });
  }
  const providerName = typeof values.provider === "string" ? values.provider.trim() : undefined;
  // Jobs enqueued by the opencode plugin carry provider "opencode"; the CLI
  // has no harness channel, so its default provider name is "http" and would
  // silently never claim plugin jobs. --provider lets the operator drain the
  // plugin queue explicitly (extraction still runs over the HTTP channel).
  const adapter = new MemcurioAdapter({
    durableQueue: true,
    root: rootDir(),
    extract: providerName ? new LlmExtractProvider(undefined, providerName) : undefined,
  });
  const results = await adapter.processPendingExtractions(limit);
  const staged = results.filter((result) => result.staged).length;
  const retried = results.filter((result) => result.status === "retry").length;
  const dead = results.filter((result) => result.status === "dead").length;
  const blocked = results.filter((result) => result.status === "blocked").length;
  console.log(t("extract.retryDone", String(results.length), String(staged), String(retried), String(dead), String(blocked), String(requeued)));
  return 0;
}

async function cmdMcp(): Promise<number> {
  return (await runServer()) ? 0 : 1;
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
    const idx = await Index.create(indexDb(root));
    try {
      const stages = idx.stageList();
      check(t("doctor.index"), true, `${t("doctor.stage1")}: ${stages.length}`);
      check(t("doctor.memory"), hasWorkspaceChanges(root) === false, hasWorkspaceChanges(root) ? `${t("doctor.drift")} — ${t("doctor.driftHint")}` : "");
      const pending = new Transaction(txnLog(root)).pending();
      const corrupt = new Transaction(txnLog(root)).corruptLines();
      check(t("doctor.txn"), pending.length === 0 && corrupt === 0, pending.length || corrupt ? `${pending.length} pending, ${corrupt} corrupt (memcurio repair)` : t("doctor.noPending"));
      const jobs = idx.extractionList();
      const active = jobs.filter((job) => job.status === "pending" || job.status === "processing" || job.status === "blocked");
      const blocked = jobs.filter((job) => job.status === "blocked");
      const dead = jobs.filter((job) => job.status === "dead");
      console.log(`${t("doctor.extraction")}: ${active.length}`);
      check(t("doctor.deadLetters"), dead.length === 0, dead.length ? `${dead.length} dead-letter job(s)` : t("doctor.noDeadLetters"));
      for (const job of dead.slice(0, 10)) {
        console.log(`  dead ${job.jobId} provider=${job.provider} attempts=${job.attempts}: ${(job.lastError ?? "unknown").slice(0, 240)}`);
      }
      for (const job of blocked.slice(0, 10)) {
        console.log(`  blocked ${job.jobId} provider=${job.provider}: ${(job.lastError ?? "configuration required").slice(0, 240)}`);
      }
      const generations = inspectGenerationManifests(root);
      const generationDetail = generations.length
        ? generations.map((generation) => `${generation.id}:${generation.phase}`).join(", ")
        : t("doctor.noGenerations");
      check(t("doctor.generation"), generations.length === 0, generationDetail);
    } finally {
      idx.close();
    }
  } catch (err) {
    check(t("doctor.index"), false, String(err));
  }
  console.log(ok ? t("doctor.ok") : t("doctor.bad"));
  return ok ? 0 : 1;
}

const HELP_CMDS = new Set([
  "init",
  "status",
  "remember",
  "list",
  "search",
  "prune",
  "purge",
  "curate",
  "baseline",
  "reindex",
  "repair",
  "doctor",
  "audit",
  "event",
  "export",
  "import",
  "retry-extraction",
  "mcp",
  "setup",
  "help",
]);

async function cmdHelp(rest: string[]): Promise<number> {
  const cmd = rest[0];
  if (cmd && (cmd === "-h" || cmd === "--help")) {
    console.log(t("usage.main"));
    return 0;
  }
  if (cmd && HELP_CMDS.has(cmd)) {
    console.log(t(`help.${cmd}`));
    return 0;
  }
  if (cmd) {
    console.error(`${t("error.prefix")}${t("help.unknown", cmd)}\n`);
    return 2;
  }
  console.log(t("usage.main"));
  return 0;
}

/** Keep the CLI version in lockstep with the package (resolves for both the
 *  src/ and dist/ layouts). */
const VERSION = (() => {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export async function main(argv: string[]): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    switch (cmd) {
      case undefined:
      case "-h":
      case "--help":
      case "help":
        return await cmdHelp(rest);
      case "-v":
      case "--version":
        console.log(t("version", VERSION));
        return 0;
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
      case "prune":
        return await cmdPrune(rest);
      case "purge":
        return await cmdPurge(rest);
      case "curate":
        return await cmdCurate(rest);
      case "baseline":
        return await cmdBaseline(rest);
      case "reindex":
        return await cmdReindex(rest);
      case "repair":
        return await cmdRepair(rest);
      case "doctor":
        return await cmdDoctor();
      case "audit":
        return await cmdAudit(rest);
      case "event":
        return await cmdEvent(rest);
      case "export":
        return await cmdExport(rest);
      case "import":
        return await cmdImport(rest);
      case "retry-extraction":
        return await cmdRetryExtraction(rest);
      case "mcp":
        return await cmdMcp();
      case "setup":
        return await cmdSetup(rest);
      default:
        console.error(`${t("error.prefix")}${t("help.unknown", cmd)}`);
        return 2;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${t("error.prefix")}${msg}`);
    if (/unable to open database file/i.test(msg)) {
      console.error(t("init.hint"));
    }
    if (/file is not a database|not a database/i.test(msg)) {
      console.error(t("corruptIndex.hint"));
    }
    const code = (err as NodeJS.ErrnoException)?.code;
    const isUsage =
      err instanceof UsageError ||
      code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" ||
      code === "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL" ||
      code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE" ||
      code === "ERR_PARSE_ARGS_MISSING_REQUIRED_ARGUMENT" ||
      code === "ERR_PARSE_ARGS_OPTION_TYPE" ||
      code === "ERR_PARSE_ARGS_MISSING_POSITIONAL";
    return isUsage ? 2 : 1;
  }
}

const isMain = (() => {
  try {
    const argv1 = process.argv[1];
    if (!argv1) {
      return false;
    }
    // npm bin entries are symlinks; node resolves the main module's realpath
    // while argv[1] keeps the link path, so compare realpaths.
    return pathToFileURL(realpathSync(argv1)).href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isMain) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
