import { describe, expect, test } from "bun:test";

import { workspaceStoreRoot } from "../src/scope.js";

describe("workspaceStoreRoot", () => {
  test("isolates workspaces deterministically", () => {
    const first = workspaceStoreRoot("/tmp/memcurio", "/work/one", "workspace");
    expect(first).toBe(workspaceStoreRoot("/tmp/memcurio", "/work/one", "workspace"));
    expect(first).not.toBe(workspaceStoreRoot("/tmp/memcurio", "/work/two", "workspace"));
    expect(first.startsWith("/tmp/memcurio/dsh/")).toBe(true);
  });

  test("supports one explicitly global store", () => {
    expect(workspaceStoreRoot("/tmp/memcurio", "/work/one", "global")).toBe("/tmp/memcurio");
  });
});
