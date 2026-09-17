#!/usr/bin/env node
/**
 * Workflow action-pin & structural verification (chamber norm, ported from
 * dsh-chamber-mcp).
 *
 * - Every external action `uses:` must be a full 40-hex commit SHA carrying a
 *   `# vX.Y.Z` comment (a bare SHA hides which release it is). The allowlist
 *   below is empty and exists only as the mechanism for a temporary,
 *   explicitly justified moving-major exception; pins are bumped by hand —
 *   resolve the tag with `git ls-remote <repo> refs/tags/<tag>^{}`, update
 *   BOTH workflows in one commit, and re-run this script.
 * - Structural release invariants (chamber release postmortems): release.yml
 *   serializes publication (`concurrency.group: release-publish` with
 *   `cancel-in-progress: false`), the full gate runs BEFORE any GitHub-Release
 *   mutation, a refuse-published-release guard inspects and fails closed, and
 *   every mutation step is skipped on `workflow_dispatch` dry runs.
 * - ci.yml runs the same chain on push main, tags v*, PRs, and manual dispatch.
 *
 * Run: node scripts/verify-workflow-action-pins.mjs
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflowsDir = join(root, ".github", "workflows");

/** Moving-major exceptions. Deliberately empty: keep the mechanism for a
 *  temporary, explicitly justified exception only. */
const ALLOWED_MAJORS = new Map();

const shaPattern = /^[0-9a-f]{40}$/;

function fail(message) {
  console.error(`verify-workflow-action-pins: ${message}`);
  process.exitCode = 1;
}

const workflowFiles = readdirSync(workflowsDir).filter((file) => file.endsWith(".yml")).sort();
if (workflowFiles.length === 0) fail(`no workflows found in ${workflowsDir}`);

const seenActions = new Map();
let releaseYaml = "";
let ciYaml = "";
for (const file of workflowFiles) {
  const text = readFileSync(join(workflowsDir, file), "utf8");
  if (file === "release.yml") releaseYaml = text;
  if (file === "ci.yml") ciYaml = text;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("uses:") && !line.startsWith("- uses:")) continue;
    const match = /uses:\s*(\S+)/.exec(line);
    if (!match) continue;
    const ref = match[1];
    const [action, version] = ref.split("@");
    if (!action || !version) {
      fail(`${file}: malformed uses ref "${ref}"`);
      continue;
    }
    if (shaPattern.test(version)) {
      if (!/#\s*v?\d+\.\d+\.\d+/.test(rawLine)) {
        fail(`${file}: ${action} is SHA-pinned without a "# vX.Y.Z" comment`);
      }
      const previous = seenActions.get(action);
      if (previous !== undefined && previous !== version) {
        fail(`${file}: action ${action} pinned at multiple SHAs (${previous} vs ${version})`);
      }
      seenActions.set(action, version);
      continue;
    }
    if (ALLOWED_MAJORS.has(ref)) continue;
    fail(`${file}: action "${ref}" is neither a 40-hex SHA nor allowlisted`);
  }
}

/** One step block, from its "- name:" line to the next step. */
function stepBlock(text, name) {
  const start = new RegExp(`- name:\\s*${name}\\b`).exec(text);
  if (start === null) return undefined;
  const rest = text.slice(start.index);
  const next = /\n[ \t]*- name:/.exec(rest.slice(1));
  return next === null ? rest : rest.slice(0, next.index + 1);
}

// ---- release.yml structural invariants ----
if (!/concurrency:\s*\n\s*group:\s*release-publish/.test(releaseYaml)) {
  fail("release.yml: missing concurrency.group: release-publish");
}
if (!/cancel-in-progress:\s*false/.test(releaseYaml)) {
  fail("release.yml: concurrency.cancel-in-progress must be false");
}
if (!/permissions:\s*\n\s*contents:\s*read/.test(releaseYaml)) {
  fail("release.yml: top-level permissions must be contents: read (the job grants contents: write)");
}
if (!/contents:\s*write/.test(releaseYaml)) {
  fail("release.yml: the release job must grant contents: write to create the Release");
}
const mutationStep = /name:\s*Create GitHub Release/.exec(releaseYaml);
const gateStep = /name:\s*Full gate/.exec(releaseYaml);
if (mutationStep === null || gateStep === null) {
  fail("release.yml: expected a \"Full gate\" step and a \"Create GitHub Release\" step (rename detected)");
} else if (mutationStep.index < gateStep.index) {
  fail("release.yml: the GitHub-Release mutation step must come AFTER the full gate");
}
const refuseStep = stepBlock(releaseYaml, "Refuse re-publishing an existing release");
if (refuseStep === undefined) {
  fail("release.yml: missing the \"Refuse re-publishing an existing release\" step (softprops silently updates existing releases)");
} else {
  if (!/gh release view/.test(refuseStep) || !/gh release delete/.test(refuseStep) || !/exit 1/.test(refuseStep)) {
    fail("release.yml: the refuse step no longer inspects the release and fails closed");
  }
  if (!/if:.*inputs\.dry_run/.test(refuseStep)) {
    fail("release.yml: the refuse step must be skipped on dry runs (if: ... inputs.dry_run)");
  }
  if (!/release not found/i.test(refuseStep)) {
    fail(
      "release.yml: the refuse step must accept only gh's explicit not-found signal (any other gh failure must fail closed)",
    );
  }
  if (/2>\s*\/dev\/null/.test(refuseStep)) {
    fail("release.yml: the refuse step must not discard gh's stderr (a non-not-found failure must fail closed)");
  }
}
const createStep = stepBlock(releaseYaml, "Create GitHub Release");
if (createStep === undefined || !/if:.*inputs\.dry_run/.test(createStep)) {
  fail("release.yml: the Create GitHub Release step must be skipped on dry runs");
}
if (!/node scripts\/release-notes\.mjs/.test(releaseYaml)) {
  fail("release.yml: release notes must be composed by scripts/release-notes.mjs");
}
if (!/bun pm pack --destination/.test(releaseYaml)) {
  fail("release.yml: the release must pack the tarball with bun pm pack --destination");
}
if (!/verify-workflow-action-pins\.mjs/.test(releaseYaml)) {
  fail("release.yml: the gate must run this verifier (node scripts/verify-workflow-action-pins.mjs)");
}

// ---- ci.yml structural invariants ----
if (!/push:/.test(ciYaml) || !/tags:\s*\['v\*'\]/.test(ciYaml)) {
  fail("ci.yml: must run on push (including tags v*)");
}
if (!/pull_request:/.test(ciYaml)) fail("ci.yml: must run on pull_request");
if (!/workflow_dispatch:/.test(ciYaml)) fail("ci.yml: must be dispatchable (workflow_dispatch)");
if (!/permissions:\s*\n\s*contents:\s*read/.test(ciYaml)) {
  fail("ci.yml: permissions must be contents: read");
}
if (!/bun install --frozen-lockfile/.test(ciYaml)) fail("ci.yml: installs must use bun install --frozen-lockfile");
if (!/git diff --exit-code -- dist\/ lib\//.test(ciYaml)) fail("ci.yml: missing the committed-artifact drift check");
if (!/verify-workflow-action-pins\.mjs/.test(ciYaml)) {
  fail("ci.yml: must run this verifier (node scripts/verify-workflow-action-pins.mjs)");
}

const pins = [...seenActions.entries()].map(([action, sha]) => `${action}@${sha.slice(0, 7)}`).join(", ");
if (process.exitCode === undefined || process.exitCode === 0) {
  console.log(`verify-workflow-action-pins: ok — ${workflowFiles.length} workflows, pins: ${pins}`);
}
