import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "./helpers.js";
import {
  GITHUB_SPEC,
  NPM_PACKAGE,
  mcpCommandFor,
  opencodeConfigDir,
  parseMcpCommand,
  pluginSpecFor,
} from "../src/cli/setup.js";

let dir: string;
let home: string;
let prevXdg: string | undefined;
let prevHome: string | undefined;
let prevLang: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "setup-"));
  home = mkdtempSync(join(tmpdir(), "setup-home-"));
  prevXdg = process.env.XDG_CONFIG_HOME;
  prevHome = process.env.HOME;
  prevLang = process.env.MEMCURIO_LANG;
  process.env.XDG_CONFIG_HOME = join(dir, "xdg");
  process.env.HOME = home;
  process.env.MEMCURIO_LANG = "en";
});

afterEach(() => {
  if (prevXdg === undefined) {
    delete process.env.XDG_CONFIG_HOME;
  } else {
    process.env.XDG_CONFIG_HOME = prevXdg;
  }
  if (prevHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = prevHome;
  }
  if (prevLang === undefined) {
    delete process.env.MEMCURIO_LANG;
  } else {
    process.env.MEMCURIO_LANG = prevLang;
  }
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

const globalConfig = (): string => join(opencodeConfigDir(), "opencode.json");
const projectConfig = (p: string): string => join(p, "opencode.json");

describe("setup paths", () => {
  test("opencodeConfigDir honors XDG_CONFIG_HOME and falls back to ~/.config", () => {
    expect(opencodeConfigDir()).toBe(join(dir, "xdg", "opencode"));
    delete process.env.XDG_CONFIG_HOME;
    expect(opencodeConfigDir()).toBe(join(home, ".config", "opencode"));
  });

  test("pluginSpecFor maps sources to npm / github / local specs", () => {
    expect(pluginSpecFor("npm", { cwd: dir } as never)).toBe(NPM_PACKAGE);
    expect(pluginSpecFor("github", { cwd: dir } as never)).toBe(GITHUB_SPEC);
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "dist", "cli"), { recursive: true });
    writeFileSync(join(repo, "dist", "opencode-memcurio-plugin.js"), "x");
    writeFileSync(join(repo, "dist", "cli", "index.js"), "x");
    expect(pluginSpecFor("local", { cwd: repo } as never)).toBe(`file://${repo}`);
    expect(() => pluginSpecFor("local", { cwd: dir } as never)).toThrow(/built checkout/);
  });

  test("mcpCommandFor picks the launcher per source", () => {
    expect(mcpCommandFor("npm", { cwd: dir } as never)).toEqual(["npx", "-y", "memcurio@latest", "mcp"]);
    expect(mcpCommandFor("github", { cwd: dir } as never)).toEqual(["memcurio", "mcp"]);
    expect(mcpCommandFor("local", { cwd: dir } as never)).toEqual(["node", join(dir, "dist", "cli", "index.js"), "mcp"]);
  });

  test("parseMcpCommand accepts JSON arrays and whitespace strings", () => {
    expect(parseMcpCommand('["/opt/memcurio","mcp"]')).toEqual(["/opt/memcurio", "mcp"]);
    expect(parseMcpCommand("memcurio mcp")).toEqual(["memcurio", "mcp"]);
    expect(parseMcpCommand("  ")).toBeUndefined();
    // not a valid string array -> whitespace split (no spaces here, so one token)
    expect(parseMcpCommand('[1,"mcp"]')).toEqual(['[1,"mcp"]']);
  });
});

describe("setup command", () => {
  test("dry run prints the plan without writing", async () => {
    const r = await runCli("setup");
    expect(r.code).toBe(0);
    expect(r.out).toContain("dry run");
    expect(r.out).toContain(NPM_PACKAGE);
    expect(existsSync(globalConfig())).toBe(false);
  });

  test("apply writes the plugin entry into the global config", async () => {
    const r = await runCli("setup", "--apply");
    expect(r.code).toBe(0);
    expect(r.out).toContain("wrote");
    const config = JSON.parse(readFileSync(globalConfig(), "utf-8")) as { plugin: unknown };
    expect(config.plugin).toEqual(["memcurio"]);
  });

  test("--mcp also registers the MCP server", async () => {
    await runCli("setup", "--apply", "--mcp");
    const config = JSON.parse(readFileSync(globalConfig(), "utf-8")) as {
      plugin: unknown;
      mcp: Record<string, unknown>;
    };
    expect(config.plugin).toEqual(["memcurio"]);
    expect(config.mcp[NPM_PACKAGE]).toEqual({ type: "local", command: mcpCommandFor("npm", { cwd: dir } as never) });
  });

  test("existing config keys and other plugins/servers are preserved", async () => {
    mkdirSync(opencodeConfigDir(), { recursive: true });
    writeFileSync(
      globalConfig(),
      JSON.stringify({ theme: "dark", plugin: ["other-plugin"], mcp: { other: { type: "local", command: ["x"] } } }),
    );
    await runCli("setup", "--apply", "--mcp");
    const config = JSON.parse(readFileSync(globalConfig(), "utf-8")) as Record<string, unknown>;
    expect(config.theme).toBe("dark");
    expect((config.plugin as unknown[]).length).toBe(2);
    expect((config.mcp as Record<string, unknown>).other).toEqual({ type: "local", command: ["x"] });
  });

  test("re-running is a no-op and the file is untouched", async () => {
    await runCli("setup", "--apply", "--mcp");
    const before = readFileSync(globalConfig(), "utf-8");
    const r = await runCli("setup", "--apply", "--mcp");
    expect(r.out).toContain("no change");
    expect(readFileSync(globalConfig(), "utf-8")).toBe(before);
  });

  test("the original file is backed up before the first write", async () => {
    mkdirSync(opencodeConfigDir(), { recursive: true });
    writeFileSync(globalConfig(), '{"theme":"dark"}');
    await runCli("setup", "--apply");
    expect(readFileSync(`${globalConfig()}.memcurio.bak`, "utf-8")).toBe('{"theme":"dark"}');
  });

  test("--project targets ./opencode.json", async () => {
    const project = join(dir, "proj");
    mkdirSync(project, { recursive: true });
    const prevCwd = process.cwd();
    process.chdir(project);
    try {
      const r = await runCli("setup", "--apply", "--project");
      expect(r.code).toBe(0);
      expect(r.out).toContain(join("proj", "opencode.json"));
      expect(existsSync(projectConfig(project))).toBe(true);
      const config = JSON.parse(readFileSync(projectConfig(project), "utf-8")) as { plugin: unknown };
      expect(config.plugin).toEqual(["memcurio"]);
    } finally {
      process.chdir(prevCwd);
    }
  });

  test("--no-plugin --mcp writes only the MCP server", async () => {
    await runCli("setup", "--apply", "--no-plugin", "--mcp");
    const config = JSON.parse(readFileSync(globalConfig(), "utf-8")) as Record<string, unknown>;
    expect(config.plugin).toBeUndefined();
    expect((config.mcp as Record<string, unknown>)[NPM_PACKAGE]).toEqual({ type: "local", command: mcpCommandFor("npm", { cwd: dir } as never) });
  });

  test("--source github writes the GitHub spec", async () => {
    await runCli("setup", "--apply", "--source=github");
    const config = JSON.parse(readFileSync(globalConfig(), "utf-8")) as { plugin: unknown };
    expect(config.plugin).toEqual(["github:panzeyu2013/memcurio"]);
  });

  test("a pinned spec counts as already configured; lookalikes do not", async () => {
    mkdirSync(opencodeConfigDir(), { recursive: true });
    writeFileSync(globalConfig(), JSON.stringify({ plugin: ["memcurio@0.1.0"] }));
    let r = await runCli("setup", "--apply");
    expect(r.out).toContain("no change");
    expect(JSON.parse(readFileSync(globalConfig(), "utf-8"))).toEqual({ plugin: ["memcurio@0.1.0"] });

    writeFileSync(globalConfig(), JSON.stringify({ plugin: ["github:panzeyu2013/memcurio#v0.1.0"] }));
    r = await runCli("setup", "--apply", "--source=github");
    expect(r.out).toContain("no change");

    // A fork whose name merely contains "memcurio" must NOT suppress the real
    // plugin install.
    writeFileSync(globalConfig(), JSON.stringify({ plugin: ["github:someone/memcurio-fork"] }));
    r = await runCli("setup", "--apply");
    const config = JSON.parse(readFileSync(globalConfig(), "utf-8")) as { plugin: string[] };
    expect(config.plugin).toEqual(["github:someone/memcurio-fork", "memcurio"]);
  });

  test("backups rotate instead of clobbering the only rollback point", async () => {
    mkdirSync(opencodeConfigDir(), { recursive: true });
    writeFileSync(globalConfig(), '{"theme":"a"}');
    await runCli("setup", "--apply", "--no-plugin", "--mcp");
    writeFileSync(globalConfig(), '{"theme":"b"}');
    await runCli("setup", "--apply", "--no-plugin", "--mcp");
    expect(readFileSync(`${globalConfig()}.memcurio.bak`, "utf-8")).toBe('{"theme":"b"}');
    expect(readFileSync(`${globalConfig()}.memcurio.bak.1`, "utf-8")).toBe('{"theme":"a"}');
  });

  test("dry run reports a broken config instead of showing a normal plan", async () => {
    mkdirSync(opencodeConfigDir(), { recursive: true });
    writeFileSync(globalConfig(), "{ broken");
    const r = await runCli("setup");
    expect(r.code).toBe(1);
    expect(r.err).toContain("not valid JSON");
  });

  test("--source local requires a built checkout", async () => {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    const prevCwd = process.cwd();
    process.chdir(repo);
    try {
      const r = await runCli("setup", "--apply", "--source=local");
      expect(r.code).toBe(1);
      expect(r.err).toContain("built checkout");
    } finally {
      process.chdir(prevCwd);
    }
    mkdirSync(join(repo, "dist", "cli"), { recursive: true });
    writeFileSync(join(repo, "dist", "opencode-memcurio-plugin.js"), "x");
    writeFileSync(join(repo, "dist", "cli", "index.js"), "x");
    process.chdir(repo);
    try {
      const r = await runCli("setup", "--apply", "--source=local");
      expect(r.code).toBe(0);
      const config = JSON.parse(readFileSync(globalConfig(), "utf-8")) as { plugin: unknown };
      expect(config.plugin).toEqual([`file://${repo}`]);
    } finally {
      process.chdir(prevCwd);
    }
  });

  test("invalid --source and unknown flags are usage errors", async () => {
    const bad = await runCli("setup", "--source=foo");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("invalid --source");
    const unknown = await runCli("setup", "--nope");
    expect(unknown.code).toBe(2);
    const empty = await runCli("setup", "--no-plugin");
    expect(empty.code).toBe(2);
  });

  test("an existing broken config aborts with exit 1", async () => {
    mkdirSync(opencodeConfigDir(), { recursive: true });
    writeFileSync(globalConfig(), "{ broken");
    const r = await runCli("setup", "--apply");
    expect(r.code).toBe(1);
    expect(r.err).toContain("not valid JSON");
  });

  test("mcp entries are updated in place when the command changes", async () => {
    mkdirSync(opencodeConfigDir(), { recursive: true });
    writeFileSync(globalConfig(), JSON.stringify({ mcp: { [NPM_PACKAGE]: { type: "local", command: ["memcurio", "mcp"] } } }));
    const r = await runCli("setup", "--apply", "--no-plugin", "--mcp");
    expect(r.code).toBe(0);
    const config = JSON.parse(readFileSync(globalConfig(), "utf-8")) as { mcp: Record<string, unknown> };
    expect(config.mcp[NPM_PACKAGE]).toEqual({ type: "local", command: mcpCommandFor("npm", { cwd: dir } as never) });
  });

  test("--source github with --mcp writes the PATH command and hints", async () => {
    const r = await runCli("setup", "--apply", "--source=github", "--mcp");
    expect(r.code).toBe(0);
    const config = JSON.parse(readFileSync(globalConfig(), "utf-8")) as { plugin: unknown; mcp: Record<string, unknown> };
    expect(config.plugin).toEqual([GITHUB_SPEC]);
    expect(config.mcp[NPM_PACKAGE]).toEqual({ type: "local", command: ["memcurio", "mcp"] });
    expect(r.out).toContain("npm install -g");
  });

  test("--mcp-command overrides the MCP launcher", async () => {
    const r = await runCli("setup", "--apply", "--no-plugin", '--mcp-command=["/opt/memcurio","mcp"]');
    expect(r.code).toBe(0);
    const config = JSON.parse(readFileSync(globalConfig(), "utf-8")) as { mcp: Record<string, unknown> };
    expect(config.mcp[NPM_PACKAGE]).toEqual({ type: "local", command: ["/opt/memcurio", "mcp"] });
  });

  test("invalid --mcp-command is a usage error", async () => {
    const r = await runCli("setup", "--mcp-command=");
    expect(r.code).toBe(2);
    expect(r.err).toContain("invalid --mcp-command");
  });

  test("--source local with --mcp runs the built CLI with node", async () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, "dist", "cli"), { recursive: true });
    writeFileSync(join(repo, "dist", "opencode-memcurio-plugin.js"), "x");
    writeFileSync(join(repo, "dist", "cli", "index.js"), "x");
    const prevCwd = process.cwd();
    process.chdir(repo);
    try {
      await runCli("setup", "--apply", "--source=local", "--mcp");
      const config = JSON.parse(readFileSync(globalConfig(), "utf-8")) as { mcp: Record<string, unknown> };
      expect(config.mcp[NPM_PACKAGE]).toEqual({
        type: "local",
        command: ["node", join(repo, "dist", "cli", "index.js"), "mcp"],
      });
    } finally {
      process.chdir(prevCwd);
    }
  });
});
