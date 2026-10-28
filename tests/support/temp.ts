/**
 * Temporary workspace roots with a single cleanup hook.
 *
 * Every integration test creates one or more roots and must remove them even
 * when an assertion throws. Centralising the registry keeps that cleanup in
 * one `afterEach` and prevents a forgotten `rmSync` from leaking state into
 * the next test file.
 *
 * Test-only module; never imported by shipped code.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempRoots {
  /** Create and register one root; `cleanup()` removes it later. */
  root(prefix?: string): string;
  /** Remove every root created through this registry. Idempotent. */
  cleanup(): void;
}

export function createTempRoots(): TempRoots {
  const roots = new Set<string>();
  return {
    root(prefix = "memcurio-test-") {
      const dir = mkdtempSync(join(tmpdir(), prefix));
      roots.add(dir);
      return dir;
    },
    cleanup() {
      for (const dir of roots) rmSync(dir, { recursive: true, force: true });
      roots.clear();
    },
  };
}
