import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createScope } from "@deepseek-ai/dsh-scope";
import { SessionId } from "@deepseek-ai/dsh-session";

import { workspaceLookupKeys } from "../src/plugin/workspace-policy.js";
import { createTestHost, disposeTestHost } from "./support/host.js";

const plugin = await import("../src/plugin/index.js");

const roots: string[] = [];
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "memcurio-agent-gate-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("agent tool visibility gate", () => {
  test("restrict hides memory tools for a disabled workspace and lifts on enable", async () => {
    const base = temp();
    const workdir = join(base, "workspace");
    mkdirSync(workdir, { recursive: true });
    const key = workspaceLookupKeys(workdir)[0] as string;
    const host = await createTestHost();
    const agentKey = { id: "agent-1" };
    let agentScope: ReturnType<typeof createScope> | undefined;
    await new Promise<void>((resolve) => {
      host.ctx.inject(["tools"], (scoped) => {
        agentScope = createScope(scoped, agentKey);
        resolve();
        return undefined;
      });
    });
    if (agentScope === undefined) throw new Error("scope not created");
    const agent = {
      id: SessionId("agent-1"),
      session: { header: { cwd: workdir } },
      ctx: agentScope.ctx,
    };
    (host.ctx as unknown as { reflect: { provide(name: string, value: unknown): void } }).reflect.provide("agents", {
      list: () => [agent],
      roots: () => [agent],
    });
    const fiber = await host.ctx.plugin(plugin, {
      root: base,
      scope: "workspace",
      workspaceOverrides: { [key]: { enabled: false } },
    } as never);
    try {
      expect(host.ctx.tools.schemas(agentKey).map((schema) => schema.name)).not.toContain("memory_search");
      expect(host.ctx.tools.get("memory_search", agentKey)).toBeUndefined();

      await fiber.update({ root: base, scope: "workspace", workspaceOverrides: {} } as never);
      await fiber.await();
      expect(host.ctx.tools.get("memory_search", agentKey)).toBeDefined();
    } finally {
      await fiber.dispose();
      await agentScope.dispose();
      await disposeTestHost(host.fibers);
    }
  });
});
