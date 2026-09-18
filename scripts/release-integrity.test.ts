import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parsePackedPaths } from "./pack-output.js";

const repoRoot = join(import.meta.dir, "..");
const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// bun pm pack dry-run parsing (pack-check allowlist gate)
// ---------------------------------------------------------------------------

describe("packed-path parsing", () => {
  test("reads one path per packed line", () => {
    const output = "bun pm pack v1.3.14\npacked 12345 package.json\npacked 67 dist/plugin/index.js\n";
    expect(parsePackedPaths(output)).toEqual(["package.json", "dist/plugin/index.js"]);
  });

  test("fails closed when the dry-run format no longer matches", () => {
    expect(() => parsePackedPaths("bun pm pack v1.3.14\nsome future listing format\n")).toThrow(
      /refusing to pass the package allowlist gate/,
    );
  });

  test("fails closed on empty output", () => {
    expect(() => parsePackedPaths("\n")).toThrow(/empty file list/);
  });
});

// ---------------------------------------------------------------------------
// Release notes composition (scripts/release-notes.mjs)
// ---------------------------------------------------------------------------

const releaseNotesScript = join(repoRoot, "scripts", "release-notes.mjs");

const MIXED_CHANGELOG = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "### Added",
  "",
  "- unreleased change",
  "",
  "## [1.2.3] - 2026-01-02",
  "",
  "### Fixed",
  "",
  "- dated fix",
  "",
].join("\n");

function writeChangelog(text: string): string {
  const path = join(tempDir("memcurio-changelog-"), "CHANGELOG.md");
  writeFileSync(path, text, "utf8");
  return path;
}

function runReleaseNotes(version: string, changelogPath: string): { status: number | null; stderr: string; notes: string } {
  const out = join(tempDir("memcurio-notes-"), "notes.md");
  const result = spawnSync(
    process.execPath,
    [releaseNotesScript, version, "--out", out, "--changelog", changelogPath],
    { encoding: "utf8" },
  );
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    notes: result.status === 0 ? readFileSync(out, "utf8") : "",
  };
}

describe("release notes", () => {
  test("uses the dated section and warns when [Unreleased] is non-empty", () => {
    const { status, stderr, notes } = runReleaseNotes("1.2.3", writeChangelog(MIXED_CHANGELOG));
    expect(status).toBe(0);
    expect(notes).toContain("dated fix");
    expect(notes).not.toContain("unreleased change");
    expect(stderr).toContain("fold it into the dated section");
  });

  test("falls back to a non-empty [Unreleased] when the version section is absent", () => {
    const { status, stderr, notes } = runReleaseNotes("9.9.9", writeChangelog(MIXED_CHANGELOG));
    expect(status).toBe(0);
    expect(notes).toContain("unreleased change");
    expect(notes).toContain("Composed from the CHANGELOG [Unreleased] section");
    expect(stderr).toContain("using the [Unreleased] block");
  });

  test("fails when neither section has content", () => {
    const empty = "# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-01-02\n";
    const { status, stderr } = runReleaseNotes("9.9.9", writeChangelog(empty));
    expect(status).toBe(1);
    expect(stderr).toContain("prepare the release section first");
  });

  test("parses the version when a flag precedes it", () => {
    const changelogPath = writeChangelog(MIXED_CHANGELOG);
    const out = join(tempDir("memcurio-notes-"), "notes.md");
    // The old positional scan took the flag VALUE as the version.
    const result = spawnSync(
      process.execPath,
      [releaseNotesScript, "--changelog", changelogPath, "1.2.3", "--out", out],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("dated fix");
  });

  test("creates a missing output directory (CI trees have no .smoke/)", () => {
    const changelogPath = writeChangelog(MIXED_CHANGELOG);
    const out = join(tempDir("memcurio-notes-"), "nested", "deeper", "notes.md");
    const result = spawnSync(process.execPath, [releaseNotesScript, "1.2.3", "--out", out, "--changelog", changelogPath], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(readFileSync(out, "utf8")).toContain("dated fix");
  });

  test("does not warn when [Unreleased] is empty", () => {
    const dated = "# Changelog\n\n## [Unreleased]\n\n## [1.2.3] - 2026-01-02\n\n### Fixed\n\n- dated fix\n";
    const { status, stderr } = runReleaseNotes("1.2.3", writeChangelog(dated));
    expect(status).toBe(0);
    expect(stderr).not.toContain("Unreleased");
  });
});

// ---------------------------------------------------------------------------
// Release fail-closed guard (the release.yml refuse step)
// ---------------------------------------------------------------------------

const hasBash = spawnSync("bash", ["--version"]).status === 0;
const hasJq = spawnSync("jq", ["--version"]).status === 0;

/** Extract the refuse step's shell block so the test exercises the shipped
 *  script text instead of a drifting copy. */
function refuseStepScript(): string {
  const yml = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  const step = yml.indexOf("- name: Refuse re-publishing an existing release");
  if (step < 0) throw new Error("release.yml: refuse step not found");
  const runAt = yml.indexOf("run: |", step);
  if (runAt < 0) throw new Error("release.yml: refuse step has no run block");
  const lines = yml.slice(runAt + "run: |".length).split("\n").slice(1);
  const body: string[] = [];
  let indent: number | undefined;
  for (const line of lines) {
    if (line.trim() === "") {
      body.push("");
      continue;
    }
    const current = line.length - line.trimStart().length;
    if (indent === undefined) indent = current;
    if (current < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n").replaceAll("$" + "{{ env.PKG_VERSION }}", "9.9.9");
}

const GH_STUB = [
  "#!/usr/bin/env bash",
  'printf "%s\\n" "$*" >> "$STUB_LOG"',
  'case "$STUB_MODE" in',
  "  published) printf '{\"id\":1,\"draft\":false}\\n' ; exit 0 ;;",
  "  draft) printf '{\"id\":1,\"draft\":true}\\n' ; exit 0 ;;",
  '  notfound) echo "release not found" >&2 ; exit 1 ;;',
  '  notfound-http) echo "HTTP 404: Not Found (https://api.github.com/example/releases/tags/v9.9.9)" >&2 ; exit 1 ;;',
  '  rate-limit) echo "HTTP 403: API rate limit exceeded" >&2 ; exit 1 ;;',
  '  network) echo "dial tcp: i/o timeout" >&2 ; exit 1 ;;',
  '  server-error) echo "HTTP 502: Bad Gateway" >&2 ; exit 1 ;;',
  "esac",
  'echo "unexpected STUB_MODE: $STUB_MODE" >&2',
  "exit 2",
].join("\n");

function runRefuseGuard(mode: string): { status: number | null; stdout: string; stderr: string; calls: string } {
  const dir = tempDir("memcurio-gh-");
  const logPath = join(dir, "calls.log");
  writeFileSync(logPath, "");
  const stubPath = join(dir, "gh");
  writeFileSync(stubPath, GH_STUB, "utf8");
  chmodSync(stubPath, 0o755);
  const result = spawnSync("bash", ["-c", refuseStepScript()], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${dir}:${process.env.PATH ?? ""}`,
      STUB_MODE: mode,
      STUB_LOG: logPath,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    calls: readFileSync(logPath, "utf8"),
  };
}

describe("release refuse guard", () => {
  test.skipIf(!hasBash || !hasJq)("deletes a stale draft and proceeds", () => {
    const { status, calls } = runRefuseGuard("draft");
    expect(status).toBe(0);
    expect(calls).toContain("release delete v9.9.9 --yes --cleanup-tag=false");
  });

  test.skipIf(!hasBash || !hasJq)("fails closed on a published release", () => {
    const { status, stdout, stderr, calls } = runRefuseGuard("published");
    expect(status).toBe(1);
    expect(stdout + stderr).toContain("already published");
    expect(calls).not.toContain("release delete");
  });

  test.skipIf(!hasBash || !hasJq)("treats gh not-found as absent", () => {
    const { status, calls } = runRefuseGuard("notfound");
    expect(status).toBe(0);
    expect(calls).not.toContain("release delete");
  });

  test.skipIf(!hasBash || !hasJq)("fails closed on a bare HTTP 404 (proxy / non-gh error)", () => {
    // Only gh's explicit "release not found" proves absence; a bare 404 can
    // come from a proxy and must not authorize a re-release.
    const { status, stdout, stderr, calls } = runRefuseGuard("notfound-http");
    expect(status).toBe(1);
    expect(stdout + stderr).toContain("failing closed");
    expect(calls).not.toContain("release delete");
  });

  for (const mode of ["rate-limit", "network", "server-error"]) {
    test.skipIf(!hasBash || !hasJq)(`fails closed on ${mode}`, () => {
      const { status, stdout, stderr, calls } = runRefuseGuard(mode);
      expect(status).toBe(1);
      expect(stdout + stderr).toContain("failing closed");
      expect(calls).not.toContain("release delete");
    });
  }
});
