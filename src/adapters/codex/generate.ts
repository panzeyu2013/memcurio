import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

export interface GeneratedPlugin {
  outDir: string;
  daemonPath: string;
  hookPath: string;
  pluginJsonPath: string;
  snippetPath: string;
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
  const hookCommand = `bun ${hookPath}`;

  const hooks: Record<string, Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }>> = {};
  for (const event of HOOK_EVENTS) {
    hooks[event] = [{ matcher: "", hooks: [{ type: "command", command: hookCommand }] }];
  }

  const plugin = {
    name: "memcore-codex",
    version: "0.1.0",
    description: "跨 Harness 记忆与上下文管理（codex 适配器）：会话注入 + 记账 + 复盘",
    hooks,
    mcp_servers: {
      memcore: { command: "bun", args: [mcpPath] },
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
    "# memcore-codex hooks 声明（如 plugin.json 未被加载则合并进 ~/.codex/config.toml）",
    "# 注：PreCompact 当前协议无注入通道，仅保留占位。",
    ...eventNames.flatMap(([tomlName, eventName]) => [
      `[hooks.events.${tomlName}]`,
      'matcher = ""',
      `hooks = [{ type = "command", command = "${hookCommand}" }]  # ${eventName}`,
    ]),
    "",
    "# MCP（模型侧工具面）",
    "[mcp_servers.memcore]",
    'command = "bun"',
    `args = ["${mcpPath}"]`,
    "",
  ].join("\n");
  const snippetPath = join(outDir, "codex-config.toml.snippet");
  writeFileSync(snippetPath, snippet, { mode: 0o600 });

  return { outDir, daemonPath, hookPath, pluginJsonPath, snippetPath };
}
