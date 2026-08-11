#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { addAdHocNote, listAdHocNotes } from "../core/adhoc.js";
import { loadConfig, pipelineConfig, validateConfig } from "../core/config.js";
import {
  HttpLoopConsolidateProvider,
  RuleConsolidateProvider,
  planConsolidation,
  runConsolidation,
  syncArtifacts,
} from "../core/consolidate.js";
import { Index } from "../core/db.js";
import type { AdHocNoteRow, Stage1OutputRow } from "../core/db.js";
import { makeEnvelope, parseEnvelope, MAX_ENVELOPE_BYTES } from "../core/events.js";
import type { EventEnvelope } from "../core/events.js";
import { injectBaseline } from "../core/inject.js";
import { llmEnv } from "../core/llm.js";
import { configPath, ensureLayout, indexDb, rootDir, txnLog } from "../core/paths.js";
import { redactSecrets, sanitizeForInjection } from "../core/sanitize.js";
import { searchMemory } from "../core/search.js";
import { Transaction, truncateLog } from "../core/transaction.js";
import { hasWorkspaceChanges, readWorkspaceText, rolloutSlugs, saveBaseline, writeAdHocNoteFile } from "../core/workspace.js";
import { generateCodexPlugin } from "../adapters/codex/generate.js";
import { defaultSocketPath, runCodexDaemon } from "../adapters/codex/daemon.js";
import { runServer } from "../mcp/index.js";
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
  const flags = sanitizeForInjection(content);
  const root = rootDir();
  ensureLayout(root);
  const note = await addAdHocNote(root, content, "remember");
  console.log(t("remember.done", note.filename));
  if (!flags.safe) {
    console.error(t("remember.promptware", flags.flags[0] ?? "?"));
  }
  if (values.apply) {
    console.log(await runRuleConsolidation(root));
  } else {
    console.error(t("remember.applyNote"));
  }
  return 0;
}

async function cmdForget(rest: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { apply: { type: "boolean" } },
  });
  const content = positionals[0];
  if (!content) {
    return failUsage(t("forget.missing"));
  }
  warnExtraArgs("forget", positionals, 1);
  if (content.length > MAX_NOTE_CHARS) {
    return failUsage(t("remember.tooLong", String(MAX_NOTE_CHARS)));
  }
  const root = rootDir();
  ensureLayout(root);
  const note = await addAdHocNote(root, content, "forget");
  console.log(t("forget.done", note.filename));
  if (values.apply) {
    console.log(await runRuleConsolidation(root));
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
  const notes = (await listAdHocNotes(root)).filter((n) => !n.applied);
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
  const env = llmEnv();
  const maxSteps = values["max-steps"] ? positiveInt(values["max-steps"], cfg.maxAgentSteps, 1000, "max-steps") : cfg.maxAgentSteps;
  const provider = env.apiKey ? new HttpLoopConsolidateProvider(maxSteps) : new RuleConsolidateProvider();
  const run = await runConsolidation(root, provider, { execute: true, config: cfg });
  console.log(t("curate.applied", run.message));
  if (!env.apiKey) {
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
  const plan = await planConsolidation(root, cfg);
  return withStore(async (idx) => {
    const txn = new Transaction(txnLog(root));
    txn.run("reindex", "-", "sync artifacts from stage1", () => {
      syncArtifacts(root, plan);
      saveBaseline(root);
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
    return 1;
  }
  ensureLayout(root);
  const cfg = pipelineConfig(root);
  const plan = await planConsolidation(root, cfg);
  return withStore(async (idx) => {
    const txn = new Transaction(txnLog(root));
    let count = 0;
    txn.run("repair", "-", `cleared ${pending.length} pending txns`, () => {
      syncArtifacts(root, plan);
      saveBaseline(root);
      count = Object.keys(plan.artifacts).length;
      idx.audit("repair", "-", `re-synced ${count} artifact file(s), cleared ${pending.length} pending txns`);
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
  sourceUpdatedAt?: string;
  generatedAt?: string;
  lastUsage?: string | null;
  usageCount?: number;
  selectedForPhase2?: boolean;
  status?: string;
  id?: string;
  filename?: string;
  kind?: string;
  content?: string;
  createdAt?: string;
  applied?: boolean;
}

function serializeStage1(s: Stage1OutputRow): ExportRecord {
  return {
    type: "stage1",
    rolloutKey: s.rolloutKey,
    rawMemory: s.rawMemory,
    rolloutSummary: s.rolloutSummary,
    rolloutSlug: s.rolloutSlug,
    sourceUpdatedAt: s.sourceUpdatedAt,
    generatedAt: s.generatedAt,
    lastUsage: s.lastUsage,
    usageCount: s.usageCount,
    selectedForPhase2: s.selectedForPhase2,
    status: s.status,
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

async function cmdImport(rest: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true });
  const path = positionals[0];
  if (!path) {
    return failUsage(t("import.missing"));
  }
  warnExtraArgs("import", positionals, 1);
  const root = rootDir();
  ensureLayout(root);
  const raw = readFileSync(path, "utf-8");
  const records: ExportRecord[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as ExportRecord;
      if (parsed.type === "stage1" || parsed.type === "note") {
        records.push(parsed);
      }
    } catch {
      void 0;
    }
  }
  if (!records.length) {
    return fail(t("import.empty", path));
  }
  return withStore(async (idx) => {
    let added = 0;
    let skipped = 0;
    for (const r of records) {
      if (r.type === "stage1" && r.rolloutKey) {
        if (idx.stageGet(r.rolloutKey)) {
          skipped += 1;
          console.log(t("import.conflict", r.rolloutKey));
          continue;
        }
        idx.stageUpsert({
          rolloutKey: r.rolloutKey,
          rawMemory: r.rawMemory ?? "",
          rolloutSummary: r.rolloutSummary ?? "",
          rolloutSlug: r.rolloutSlug ?? "rollout",
          sourceUpdatedAt: r.sourceUpdatedAt ?? new Date().toISOString(),
        });
        added += 1;
      } else if (r.type === "note" && r.id && r.filename) {
        if (idx.noteList().some((n) => n.id === r.id)) {
          skipped += 1;
          continue;
        }
        const kind = r.kind === "remember" || r.kind === "forget" || r.kind === "update" ? r.kind : "remember";
        idx.noteAdd({
          id: r.id,
          filename: r.filename,
          kind,
          content: r.content ?? "",
          createdAt: r.createdAt ?? new Date().toISOString(),
        });
        try {
          writeAdHocNoteFile(root, r.filename, r.content ?? "");
        } catch {
          // invalid/unsafe filename: DB row kept, file skipped (next consolidate
          // reports it as pending but harmless).
        }
        added += 1;
      }
    }
    idx.audit("import", path, `+${added}, skip ${skipped}`);
    console.log(t("import.done", String(added), String(skipped)));
    return 0;
  });
}

async function cmdCodexDaemon(): Promise<number> {
  const root = rootDir();
  ensureLayout(root);
  const socketPath = process.env.MEMCURIO_CODEX_SOCKET
    ? resolve(process.env.MEMCURIO_CODEX_SOCKET)
    : defaultSocketPath(root);
  const daemon = await runCodexDaemon({ socketPath, root });
  console.log(t("daemon.listening", socketPath));
  await daemon.closed;
  return 0;
}

async function cmdCodexPlugin(rest: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true });
  warnExtraArgs("codex-plugin", positionals, 1);
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
      check(t("doctor.txn"), pending.length === 0, pending.length ? `${pending.length} pending (memcurio repair)` : t("doctor.noPending"));
    } finally {
      idx.close();
    }
  } catch (err) {
    check(t("doctor.index"), false, String(err));
  }
  const socketPath = process.env.MEMCURIO_CODEX_SOCKET
    ? resolve(process.env.MEMCURIO_CODEX_SOCKET)
    : defaultSocketPath(root);
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
  "forget",
  "list",
  "search",
  "prune",
  "curate",
  "baseline",
  "reindex",
  "repair",
  "doctor",
  "audit",
  "event",
  "export",
  "import",
  "mcp",
  "codex-daemon",
  "codex-plugin",
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
      case "forget":
        return await cmdForget(rest);
      case "list":
        return await cmdList(rest);
      case "search":
        return await cmdSearch(rest);
      case "prune":
        return await cmdPrune(rest);
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
      case "mcp":
        return await cmdMcp();
      case "codex-daemon":
        return await cmdCodexDaemon();
      case "codex-plugin":
        return await cmdCodexPlugin(rest);
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
    return pathToFileURL(process.argv[1] ?? "").href === import.meta.url;
  } catch {
    return false;
  }
})();
if (isMain) {
  const code = await main(process.argv.slice(2));
  process.exitCode = code;
}
