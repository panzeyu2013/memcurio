import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { atomicWrite } from "./transaction.js";
import { assertWorkspaceRel, deleteWorkspaceText, writeWorkspaceText } from "./workspace.js";
import { resolveWorkspacePath } from "./paths.js";

/** A file snapshot used by the generation protocol. `present` is kept
 * separate from `content` so an empty file and a deleted file cannot be
 * confused during crash recovery. */
export interface GenerationFileSnapshot {
  present: boolean;
  content: string;
}

type GenerationTargetKind = "workspace" | "baseline";

interface GenerationTarget {
  kind: GenerationTargetKind;
  rel: string;
  before: { present: boolean; hash: string; path?: string };
  after: { present: boolean; hash: string; path?: string };
}

export interface GenerationManifest {
  version: 1;
  id: string;
  phase: "prepared" | "committed";
  createdAt: string;
  targets: GenerationTarget[];
}

export type GenerationDirection = "before" | "after";

export interface ApplyGenerationOptions {
  /** Test-only fault injection. The manifest is deliberately left pending so
   * recovery can be exercised as if the process had been killed. */
  failAfter?: number;
}

const GENERATION_DIR = "state/consolidation";
const ORPHAN_STAGING_GRACE_MS = 30_000;

function generationRoot(root: string): string {
  return join(root, GENERATION_DIR);
}

function generationPath(root: string, id: string): string {
  if (!/^[a-z0-9-]{16,80}$/.test(id)) {
    throw new Error(`invalid consolidation generation id: ${JSON.stringify(id)}`);
  }
  return join(generationRoot(root), id);
}

function manifestPath(root: string, id: string): string {
  return join(generationPath(root, id), "manifest.json");
}

function hashSnapshot(value: GenerationFileSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify({ present: value.present, content: value.present ? value.content : "" }))
    .digest("hex");
}

function sortedKeys(...snapshots: Array<Record<string, GenerationFileSnapshot>>): string[] {
  return [...new Set(snapshots.flatMap((snapshot) => Object.keys(snapshot)))].sort((a, b) => a.localeCompare(b));
}

function stagePath(root: string, id: string, side: GenerationDirection, kind: GenerationTargetKind, rel: string): string {
  const safe = assertWorkspaceRel(rel);
  const target = resolve(generationPath(root, id), kind, side, safe);
  const base = resolve(generationPath(root, id));
  if (target !== base && !target.startsWith(`${base}/`)) {
    throw new Error(`generation staging path escapes its directory: ${JSON.stringify(rel)}`);
  }
  return target;
}

function writeStagedSnapshot(root: string, id: string, side: GenerationDirection, kind: GenerationTargetKind, rel: string, snapshot: GenerationFileSnapshot): string | undefined {
  if (!snapshot.present) {
    return undefined;
  }
  const absolute = stagePath(root, id, side, kind, rel);
  atomicWrite(absolute, snapshot.content);
  return relative(generationPath(root, id), absolute);
}

function emptySnapshot(): GenerationFileSnapshot {
  return { present: false, content: "" };
}

function normalizeSnapshot(snapshot: GenerationFileSnapshot | undefined): GenerationFileSnapshot {
  return snapshot?.present ? { present: true, content: snapshot.content } : emptySnapshot();
}

/** Prepare a durable manifest and stage both old and new contents. Until the
 * database generation marker is committed, recovery always rolls back to the
 * `before` side. */
export function prepareGeneration(
  root: string,
  id: string,
  beforeWorkspace: Record<string, GenerationFileSnapshot>,
  afterWorkspace: Record<string, GenerationFileSnapshot>,
  beforeBaseline: Record<string, GenerationFileSnapshot>,
  afterBaseline: Record<string, GenerationFileSnapshot>,
): GenerationManifest {
  // Validate every relative path before creating the generation directory so
  // a rejected target cannot leave an invalid orphan that recovery ignores.
  for (const rel of sortedKeys(beforeWorkspace, afterWorkspace, beforeBaseline, afterBaseline)) {
    assertWorkspaceRel(rel);
  }
  mkdirSync(generationRoot(root), { recursive: true, mode: 0o700 });
  const directory = generationPath(root, id);
  let created = false;
  try {
    mkdirSync(directory, { mode: 0o700 });
    created = true;
    const targets: GenerationTarget[] = [];
    const addTargets = (
      kind: GenerationTargetKind,
      before: Record<string, GenerationFileSnapshot>,
      after: Record<string, GenerationFileSnapshot>,
    ): void => {
      for (const rel of sortedKeys(before, after)) {
        const beforeValue = normalizeSnapshot(before[rel]);
        const afterValue = normalizeSnapshot(after[rel]);
        if (hashSnapshot(beforeValue) === hashSnapshot(afterValue)) {
          continue;
        }
        targets.push({
          kind,
          rel: assertWorkspaceRel(rel),
          before: {
            present: beforeValue.present,
            hash: hashSnapshot(beforeValue),
            path: writeStagedSnapshot(root, id, "before", kind, rel, beforeValue),
          },
          after: {
            present: afterValue.present,
            hash: hashSnapshot(afterValue),
            path: writeStagedSnapshot(root, id, "after", kind, rel, afterValue),
          },
        });
      }
    };
    addTargets("workspace", beforeWorkspace, afterWorkspace);
    addTargets("baseline", beforeBaseline, afterBaseline);
    const manifest: GenerationManifest = {
      version: 1,
      id,
      phase: "prepared",
      createdAt: new Date().toISOString(),
      targets,
    };
    atomicWrite(manifestPath(root, id), `${JSON.stringify(manifest, null, 2)}\n`);
    return manifest;
  } catch (err) {
    if (created) {
      rmSync(directory, { recursive: true, force: true });
    }
    throw err;
  }
}

function readStagedSnapshot(root: string, manifest: GenerationManifest, target: GenerationTarget, direction: GenerationDirection): GenerationFileSnapshot {
  const side = target[direction];
  if (!side.present) {
    return emptySnapshot();
  }
  if (!side.path) {
    throw new Error(`generation ${manifest.id} is missing staged content for ${target.kind}/${target.rel}`);
  }
  const absolute = resolve(generationPath(root, manifest.id), side.path);
  const base = resolve(generationPath(root, manifest.id));
  if (absolute !== base && !absolute.startsWith(`${base}/`)) {
    throw new Error(`generation ${manifest.id} contains an unsafe staged path`);
  }
  const content = readFileSync(absolute, "utf-8");
  const snapshot = { present: true, content };
  if (hashSnapshot(snapshot) !== side.hash) {
    throw new Error(`generation ${manifest.id} staged content hash mismatch for ${target.kind}/${target.rel}`);
  }
  return snapshot;
}

function writeBaselineSnapshot(root: string, rel: string, snapshot: GenerationFileSnapshot): void {
  const target = resolveWorkspacePath(root, `.baseline/${assertWorkspaceRel(rel)}`);
  if (!snapshot.present) {
    try {
      unlinkSync(target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    return;
  }
  atomicWrite(target, snapshot.content);
}

function applyTarget(root: string, manifest: GenerationManifest, target: GenerationTarget, direction: GenerationDirection): void {
  const snapshot = readStagedSnapshot(root, manifest, target, direction);
  if (target.kind === "workspace") {
    if (snapshot.present) {
      writeWorkspaceText(root, target.rel, snapshot.content);
    } else {
      deleteWorkspaceText(root, target.rel);
    }
  } else {
    writeBaselineSnapshot(root, target.rel, snapshot);
  }
}

/** Apply one side of a generation. On an injected or real I/O failure the
 * manifest remains in place; the next startup can deterministically choose
 * either the old or new side using the SQLite generation marker. */
export function applyGeneration(
  root: string,
  manifest: GenerationManifest,
  direction: GenerationDirection,
  opts: ApplyGenerationOptions = {},
): void {
  let applied = 0;
  const targets = [...manifest.targets].sort((a, b) => `${a.kind}/${a.rel}`.localeCompare(`${b.kind}/${b.rel}`));
  for (const target of targets) {
    applyTarget(root, manifest, target, direction);
    applied += 1;
    if (opts.failAfter !== undefined && applied >= opts.failAfter) {
      throw new Error(`injected generation failure after ${applied} target(s)`);
    }
  }
}

export function markGenerationCommitted(root: string, manifest: GenerationManifest): GenerationManifest {
  const committed: GenerationManifest = { ...manifest, phase: "committed" };
  atomicWrite(manifestPath(root, manifest.id), `${JSON.stringify(committed, null, 2)}\n`);
  return committed;
}

export function discardGeneration(root: string, id: string): void {
  rmSync(generationPath(root, id), { recursive: true, force: true });
}

function parseManifest(root: string, id: string): GenerationManifest | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(manifestPath(root, id), "utf-8"));
    if (!value || typeof value !== "object") {
      return undefined;
    }
    const manifest = value as GenerationManifest;
    if (
      manifest.version !== 1 ||
      manifest.id !== id ||
      (manifest.phase !== "prepared" && manifest.phase !== "committed") ||
      !Array.isArray(manifest.targets)
    ) {
      return undefined;
    }
    // Structural validation of every target: a manifest that parses as JSON
    // but has malformed targets would crash applyGeneration deep inside
    // recovery and wedge every subsequent start (recovery has no per-item
    // guard). Treat such manifests as invalid instead — doctor/repair can
    // then report them instead of wedging.
    for (const target of manifest.targets) {
      const t = target as Partial<GenerationTarget>;
      if (
        (t.kind !== "workspace" && t.kind !== "baseline") ||
        typeof t.rel !== "string" ||
        typeof t.before?.present !== "boolean" ||
        typeof t.before?.hash !== "string" ||
        typeof t.after?.present !== "boolean" ||
        typeof t.after?.hash !== "string"
      ) {
        return undefined;
      }
    }
    return manifest;
  } catch {
    return undefined;
  }
}

function pendingManifests(root: string): GenerationManifest[] {
  const dir = generationRoot(root);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^[a-z0-9-]{16,80}$/.test(name))
    .map((id) => parseManifest(root, id))
    .filter((manifest): manifest is GenerationManifest => Boolean(manifest))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export interface GenerationManifestInfo {
  id: string;
  phase: "prepared" | "committed" | "invalid";
  createdAt?: string;
  targetCount?: number;
}

/** Read-only inspection used by doctor/repair. Unlike recovery, this also
 * reports an orphaned or malformed generation directory instead of silently
 * ignoring it. */
export function inspectGenerationManifests(root: string): GenerationManifestInfo[] {
  const dir = generationRoot(root);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => /^[a-z0-9-]{16,80}$/.test(name))
    .map((id) => {
      const manifest = parseManifest(root, id);
      return manifest
        ? { id, phase: manifest.phase, createdAt: manifest.createdAt, targetCount: manifest.targets.length }
        : { id, phase: "invalid" as const };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** Recover every leftover generation. `committedGeneration` must come from
 * SQLite in the same workspace: a matching marker means the DB commit won
 * and files are completed forward; any other generation is rolled back. */
export function recoverPendingGenerations(root: string, committedGeneration?: string): string[] {
  const recovered: string[] = [];
  // A kill during staging can leave a directory before manifest.json is
  // atomically published. No workspace/baseline target can have been applied
  // at that point, so this specific orphan class is safe to discard. A present
  // but malformed manifest remains untouched for doctor/manual inspection.
  let names: string[] = [];
  try {
    names = readdirSync(generationRoot(root));
  } catch {
    names = [];
  }
  for (const id of names.filter((name) => /^[a-z0-9-]{16,80}$/.test(name))) {
    let oldEnough = false;
    try {
      oldEnough = Date.now() - statSync(generationPath(root, id)).mtimeMs > ORPHAN_STAGING_GRACE_MS;
    } catch {
      // A concurrent cleanup won the race.
    }
    if (oldEnough && !existsSync(manifestPath(root, id))) {
      discardGeneration(root, id);
      recovered.push(`${id}:discard-orphan`);
    }
  }
  for (const manifest of pendingManifests(root)) {
    const forward = committedGeneration === manifest.id || manifest.phase === "committed";
    try {
      applyGeneration(root, manifest, forward ? "after" : "before");
      discardGeneration(root, manifest.id);
      recovered.push(`${manifest.id}:${forward ? "forward" : "rollback"}`);
    } catch (err) {
      // One broken manifest must not wedge the remaining generations (nor
      // every future startup); skip it and let doctor/repair surface it.
      recovered.push(`${manifest.id}:skip-failed:${String(err)}`);
    }
  }
  return recovered;
}

/** Read the committed marker without making the generation module depend on
 *  the SQLite implementation. */
export function generationMarkerFromMeta(value: string | undefined): string | undefined {
  return value && /^[a-z0-9-]{16,80}$/.test(value) ? value : undefined;
}
