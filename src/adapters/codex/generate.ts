import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "Stop",
  "SessionEnd",
] as const;

/** Keep the generated plugin's version in lockstep with the package. */
function packageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "..", "..", "package.json"), "utf-8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.1.0";
  } catch {
    return "0.1.0";
  }
}

export interface GeneratedPlugin {
  outDir: string;
  daemonPath: string;
  hookPath: string;
  pluginJsonPath: string;
  snippetPath: string;
}

/** POSIX shell single-quote escaping for paths embedded into hook commands
 *  (codex runs `command` hooks through a shell). */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** TOML basic-string escaping (JSON escaping is a compatible subset). */
function tomlQuote(s: string): string {
  return JSON.stringify(s);
}

export async function generateCodexPlugin(outDir: string): Promise<GeneratedPlugin> {
  mkdirSync(outDir, { recursive: true });
  const distDir = join(import.meta.dir, "..", "..", "..", "dist");
  const daemonSrc = join(distDir, "adapters", "codex", "daemon.js");
  const hookSrc = join(distDir, "adapters", "codex", "hook.js");
  const mcpSrc = join(distDir, "mcp", "index.js");
  for (const src of [daemonSrc, hookSrc, mcpSrc]) {
    if (!existsSync(src)) {
      throw new Error(`missing build output ${src}; run 'bun run build' first`);
    }
  }
  const result = await Bun.build({
    entrypoints: [daemonSrc, hookSrc, mcpSrc],
    outdir: outDir,
    target: "bun",
    naming: "[name].js",
  });
  if (!result.success) {
    throw new Error(`bun build failed: ${result.logs.map((l) => String(l)).join("; ")}`);
  }
  const daemonPath = join(outDir, "daemon.js");
  const hookPath = join(outDir, "hook.js");
  const mcpPath = join(outDir, "index.js");
  // Embed the absolute bun binary so codex (which may run with a different
  // PATH, e.g. launched from a GUI) does not need `bun` on its PATH. Quote it:
  // the command runs through a shell, and a path with spaces (macOS app
  // bundles) or env-controlled metacharacters would break or hijack the hook.
  const bunBin = process.env.BUN_BIN ?? process.execPath;
  const hookCommand = `${shellQuote(bunBin)} ${shellQuote(hookPath)}`;

  const hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [{ matcher: "", hooks: [{ type: "command", command: hookCommand }] }];
  }

  const plugin = {
    name: "memcurio-codex",
    version: packageVersion(),
    description: "跨 Harness 记忆与上下文管理（codex 适配器）：会话注入 + 记账 + 复盘",
    hooks,
    mcp_servers: {
      memcurio: { command: bunBin, args: [mcpPath] },
    },
  };
  const pluginJsonPath = join(outDir, "plugin.json");
  writeFileSync(pluginJsonPath, JSON.stringify(plugin, null, 2) + "\n", { mode: 0o600 });

  const eventNames: Array<[string, string]> = [
    ["session_start", "SessionStart"],
    ["user_prompt_submit", "UserPromptSubmit"],
    ["post_tool_use", "PostToolUse"],
    ["pre_compact", "PreCompact"],
    ["post_compact", "PostCompact"],
    ["stop", "Stop"],
    ["session_end", "SessionEnd"],
  ];
  const snippet = [
    "# memcurio-codex hooks 声明（如 plugin.json 未被加载则合并进 ~/.codex/config.toml）",
    "# 注：PreCompact 当前协议无注入通道，仅保留占位。",
    ...eventNames.flatMap(([tomlName, eventName]) => [
      `[hooks.events.${tomlName}]`,
      'matcher = ""',
      `hooks = [{ type = "command", command = ${tomlQuote(hookCommand)} }]  # ${eventName}`,
    ]),
    "",
    "# MCP（模型侧工具面）",
    "[mcp_servers.memcurio]",
    `command = ${tomlQuote(bunBin)}`,
    `args = [${tomlQuote(mcpPath)}]`,
    "",
  ].join("\n");
  const snippetPath = join(outDir, "codex-config.toml.snippet");
  writeFileSync(snippetPath, snippet, { mode: 0o600 });

  return { outDir, daemonPath, hookPath, pluginJsonPath, snippetPath };
}
