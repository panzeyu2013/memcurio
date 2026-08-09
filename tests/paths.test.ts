import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { assertValidNs, ensureLayout, namespaceFor, namespaces, nsDir } from "../src/core/paths.js";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "paths-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("assertValidNs", () => {
  test("accepts valid namespaces", () => {
    expect(assertValidNs("proj-a")).toBe("proj-a");
    expect(assertValidNs("a.b_c-1")).toBe("a.b_c-1");
  });

  test("rejects traversal and illegal names", () => {
    expect(() => assertValidNs("..")).toThrow();
    expect(() => assertValidNs(".")).toThrow();
    expect(() => assertValidNs("a/b")).toThrow();
    expect(() => assertValidNs("a..b")).not.toThrow();
    expect(() => assertValidNs("a b")).toThrow();
    expect(() => assertValidNs("x".repeat(41))).toThrow();
  });
});

describe("namespaceFor", () => {
  test("maps workdir to a slug+hash namespace", () => {
    const ns1 = namespaceFor("/tmp/My Project");
    expect(ns1).toMatch(/^My-Project-[0-9a-f]{12}$/);
    expect(namespaceFor("")).toBe("default");
    expect(namespaceFor("/tmp/.hidden")).toBe("default");
  });

  test("same basename in different parents never collides", () => {
    const a = namespaceFor("/work/a/proj");
    const b = namespaceFor("/work/b/proj");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^proj-[0-9a-f]{12}$/);
    expect(b).toMatch(/^proj-[0-9a-f]{12}$/);
  });

  test("caps slug and hash to 37 chars", () => {
    const ns = namespaceFor(`/tmp/${"a".repeat(50)}`);
    expect(ns.length).toBe(37);
  });
});

describe("layout", () => {
  test("ensureLayout chmods root, memory, state to 0700", () => {
    ensureLayout(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "memory")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "state")).mode & 0o777).toBe(0o700);
  });

  test("nsDir creates a 0700 namespace dir", () => {
    const d = nsDir(dir, "proj-a");
    expect(statSync(d).mode & 0o777).toBe(0o700);
    expect(namespaces(dir)).toEqual(["proj-a"]);
  });
});
