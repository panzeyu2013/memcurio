import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NoopExtractProvider, processExtractionQueue } from "../src/core/extract.js";
import type { ExtractProvider } from "../src/core/extract.js";
import {
  activityPath,
  hasActivityFailure,
  markActivityFailure,
  readStoreOrigin,
  storeIsDirty,
} from "../src/core/store-meta.js";
import { MemcurioAdapter } from "../src/engine.js";

function fixtures(): { root: string; workdir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "memcurio-lifecycle-"));
  const workdir = mkdtempSync(join(tmpdir(), "memcurio-lifecycle-ws-"));
  return {
    root,
    workdir,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
      rmSync(workdir, { recursive: true, force: true });
    },
  };
}

describe("store lifecycle wiring", () => {
  test("session adoption records the origin before any checkpoint", async () => {
    const { root, workdir, cleanup } = fixtures();
    try {
      const adapter = new MemcurioAdapter({
        root,
        host: "dsh",
        durableQueue: true,
        extract: new NoopExtractProvider(),
      });
      await adapter.sessionCreated("s1", workdir, "dsh");
      const origin = readStoreOrigin(root);
      expect(origin?.workdir).toBe(workdir);
      expect(origin?.realpath).toBe(workdir);
      expect(storeIsDirty(root)).toBe(false);
      adapter.dispose();
    } finally {
      cleanup();
    }
  });

  test("an idle checkpoint publishes a dirty token that a finished drain settles", async () => {
    const { root, workdir, cleanup } = fixtures();
    try {
      const adapter = new MemcurioAdapter({
        root,
        host: "dsh",
        durableQueue: true,
        extract: new NoopExtractProvider(),
      });
      await adapter.sessionCreated("s1", workdir, "dsh");
      await adapter.messageSeen("s1", "p1", {
        kind: "user",
        text: "hello world",
      });
      await adapter.sessionIdle("s1");
      expect(existsSync(activityPath(root))).toBe(true);
      expect(storeIsDirty(root)).toBe(true);

      await adapter.processPendingExtractions(4);
      // The no-op provider completes the job; the empty claim then settles
      // the token keyed on the value observed before the drain.
      expect(storeIsDirty(root)).toBe(false);
      adapter.dispose();
    } finally {
      cleanup();
    }
  });

  test("session end publishes a token even when no idle checkpoint ran", async () => {
    const { root, workdir, cleanup } = fixtures();
    try {
      const adapter = new MemcurioAdapter({
        root,
        host: "dsh",
        durableQueue: true,
        extract: new NoopExtractProvider(),
      });
      await adapter.sessionCreated("s1", workdir, "dsh");
      await adapter.messageSeen("s1", "p1", {
        kind: "user",
        text: "work happened",
      });
      await adapter.sessionEnded("s1");
      expect(storeIsDirty(root)).toBe(true);
      await adapter.processPendingExtractions(4);
      expect(storeIsDirty(root)).toBe(false);
      adapter.dispose();
    } finally {
      cleanup();
    }
  });
});

  test("a failure marker written during a drain survives the settle", async () => {
    const { root, cleanup } = fixtures();
    try {
      const provider: ExtractProvider = {
        name: "stub",
        availability: () => {
          markActivityFailure(root, "during-drain");
          return { configured: false };
        },
        extract: async () => null,
      };
      const result = await processExtractionQueue(root, provider);
      expect(result.status).toBe("empty");
      expect(hasActivityFailure(root)).toBe(true);
      expect(storeIsDirty(root)).toBe(true);
    } finally {
      cleanup();
    }
  });

