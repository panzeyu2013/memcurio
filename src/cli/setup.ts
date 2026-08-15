import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { t } from "./i18n.js";

/** GitHub repo used for `--source github` plugin installs. */
export const GITHUB_SPEC = "github:panzeyu2013/memcurio";

/** npm package that provides the opencode plugin entrypoint. */
export const NPM_PACKAGE = "memcurio";

/** npm-registry MCP launcher. `npx` requires no extra runtime: MCP clients
 *  (Claude Code, Cursor, codex, …) all run in a node environment. */
const NPM_MCP_COMMAND = ["npx", "-y", `${NPM_PACKAGE}@latest`, "mcp"];

/** The MCP server launch command for the chosen source:
 *  - npm: one-line launcher through the registry (npx, no install);
 *  - github: the user's own `memcurio` binary on PATH (npm-installed from
 *    the repo) — command only, never an absolute path;
 *  - local: run the built CLI directly with node (development). */
export function mcpCommandFor(source: SetupSource, opts: SetupOptions): string[] | undefined {
  if (source === "npm") {
    return NPM_MCP_COMMAND;
  }
  if (source === "github") {
    return ["memcurio", "mcp"];
  }
  const dir = opts.projectDir ?? opts.cwd;
  return ["node", join(dir, "dist", "cli", "index.js"), "mcp"];
}

/** Parse a user-provided `--mcp-command` value: a JSON array of strings
 *  (`'["/path/memcurio","mcp"]'`) or a shell-like string split on whitespace. */
export function parseMcpCommand(raw: string): string[] | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
        return parsed;
      }
    } catch {
      // fall through to the whitespace split
    }
  }
  const parts = trimmed.split(/\s+/).filter(Boolean);
  return parts.length ? parts : undefined;
}

export type SetupSource = "npm" | "github" | "local";
export type SetupScope = "global" | "project";

export interface SetupOptions {
  scope: SetupScope;
  source: SetupSource;
  plugin: boolean;
  mcp: boolean;
  apply: boolean;
  cwd: string;
  projectDir?: string;
  configDir?: string;
  mcpCommand?: string[];
}

/** One write operation against one config file. */
export interface SetupItem {
  file: string;
  label: string;
  pluginSpec?: string;
  mcpCommand?: string[];
}

export interface SetupPlan {
  items: SetupItem[];
}

/** opencode config directory: $XDG_CONFIG_HOME/opencode, falling back to
 *  ~/.config/opencode (matches opencode's own path resolution). */
export function opencodeConfigDir(configDir?: string): string {
  if (configDir) {
    return configDir;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg?.trim()) {
    return join(resolve(xdg.trim()), "opencode");
  }
  // $HOME first: os.homedir() caches its value on first call, which makes it
  // non-hermetic in tests.
  return join(process.env.HOME || homedir(), ".config", "opencode");
}

/** The opencode.json file for the given scope. Global config lives in
 *  $XDG_CONFIG_HOME/opencode/opencode.json; project config is
 *  <dir>/opencode.json. */
export function opencodeConfigFile(scope: SetupScope, opts: SetupOptions): string {
  if (scope === "global") {
    return join(opencodeConfigDir(opts.configDir), "opencode.json");
  }
  const dir = opts.projectDir ?? opts.cwd;
  return join(dir, "opencode.json");
}

/** The plugin spec string for the chosen source. `local` requires the current
 *  project to be a built memcurio checkout (bundle + CLI present in dist/). */
export function pluginSpecFor(source: SetupSource, opts: SetupOptions): string | undefined {
  if (source === "npm") {
    return NPM_PACKAGE;
  }
  if (source === "github") {
    return GITHUB_SPEC;
  }
  const dir = opts.projectDir ?? opts.cwd;
  const bundle = join(dir, "dist", "opencode-memcurio-plugin.js");
  const cli = join(dir, "dist", "cli", "index.js");
  if (!existsSync(bundle) || !existsSync(cli)) {
    throw new Error(t("setup.localMissing", join(dir, "dist")));
  }
  return pathToFileURL(dir).href;
}

interface ConfigShape {
  plugin?: unknown;
  mcp?: Record<string, unknown>;
}

function parseConfig(file: string): ConfigShape {
  const src = readFileSync(file, "utf-8");
  if (!src.trim()) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(src);
  } catch {
    throw new Error(t("setup.invalidJson", file));
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as ConfigShape;
  }
  throw new Error(t("setup.invalidJson", file));
}

function configText(config: ConfigShape): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Compare two plugin specs ignoring version/tag suffixes: `memcurio` and
 *  `memcurio@0.1.0` are the same package; `github:user/repo` and
 *  `github:user/repo#v0.1.0` are the same repo. A fork (`github:user/
 *  memcurio-fork`) or scoped lookalike (`@org/memcurio-tools`) is NOT ours —
 *  substring matching would silently skip installing the real plugin. */
function specIdentity(spec: string): string {
  return spec
    // name@version: the @ must follow a package-name char, so a scoped
    // package (`@org/name`) at the start of the spec is never eaten.
    .replace(/(?<=[A-Za-z0-9._-])@(?:[0-9a-zA-Z]+(?:[.-][0-9a-zA-Z]+)*|[^@\s]+)$/, "")
    .replace(/#.*$/, "")
    .replace(/^npm:/, "");
}

function pluginAlreadyConfigured(plugin: unknown, spec: string): boolean {
  if (!Array.isArray(plugin)) {
    return false;
  }
  const identity = specIdentity(spec);
  return plugin.some((item) => {
    const raw = typeof item === "string" ? item : Array.isArray(item) && typeof item[0] === "string" ? item[0] : "";
    return raw === spec || specIdentity(raw) === identity;
  });
}

export type FilePlan = { config: ConfigShape; actions: Array<"add" | "update" | "noop"> };

/** Compute the merged config for one file (pure; no IO beyond the optional
 *  reader). Callers reuse it for dry-run and apply so preview == result.
 *  Plugin entries are plain strings (the form opencode's own `plugin add`
 *  writes); the tuple form `[spec, opts]` is only for plugin options, which
 *  memcurio never uses. */
export function planForFile(
  file: string,
  pluginSpec: string | undefined,
  mcpCommand: string[] | undefined,
  read: (f: string) => ConfigShape,
): FilePlan {
  const config = existsSync(file) ? read(file) : {};
  const actions: Array<"add" | "update" | "noop"> = [];
  if (pluginSpec) {
    actions.push(pluginAlreadyConfigured(config.plugin, pluginSpec) ? "noop" : "add");
    if (actions[actions.length - 1] !== "noop") {
      if (Array.isArray(config.plugin)) {
        config.plugin.push(pluginSpec);
      } else {
        config.plugin = [pluginSpec];
      }
    }
  }
  if (mcpCommand) {
    const current = JSON.stringify(config.mcp?.[NPM_PACKAGE]);
    const next = JSON.stringify({ type: "local", command: mcpCommand });
    actions.push(current === next ? "noop" : current === undefined ? "add" : "update");
    config.mcp = { ...config.mcp, [NPM_PACKAGE]: { type: "local", command: mcpCommand } };
  }
  return { config, actions };
}

/** Write a config file only when it changes. The original is backed up with
 *  a rotation suffix (.memcurio.bak, then .memcurio.bak.1, …) so repeated
 *  runs never clobber the only rollback point. Backups and the written file
 *  are tightened to 0600: the config may carry MCP commands (which can
 *  contain credentials) and copyFileSync preserves the original's possibly
 *  loose mode. */
function writeConfig(file: string, config: ConfigShape): boolean {
  const next = configText(config);
  if (existsSync(file)) {
    const current = readFileSync(file, "utf-8");
    if (current === next) {
      return false;
    }
    const backup = `${file}.memcurio.bak`;
    if (existsSync(backup)) {
      let n = 1;
      while (existsSync(`${backup}.${n}`)) {
        n += 1;
      }
      copyFileSync(backup, `${backup}.${n}`);
      chmodSync(`${backup}.${n}`, 0o600);
    }
    copyFileSync(file, backup);
    chmodSync(backup, 0o600);
  } else {
    mkdirSync(dirname(file), { recursive: true });
  }
  writeFileSync(file, next, { mode: 0o600 });
  // writeFileSync's mode only applies to NEW files; tighten existing ones.
  chmodSync(file, 0o600);
  return true;
}

export function buildPlan(opts: SetupOptions): SetupPlan {
  const pluginSpec = opts.plugin ? pluginSpecFor(opts.source, opts) : undefined;
  const mcpCommand = opts.mcp ? (opts.mcpCommand ?? mcpCommandFor(opts.source, opts)) : undefined;
  const file = opencodeConfigFile(opts.scope, opts);
  return {
    items: [
      {
        file,
        label: opts.scope === "global" ? t("setup.scopeGlobal") : t("setup.scopeProject"),
        pluginSpec,
        mcpCommand,
      },
    ],
  };
}

export function applyPlan(plan: SetupPlan): number {
  let changed = 0;
  for (const item of plan.items) {
    const { config, actions } = planForFile(item.file, item.pluginSpec, item.mcpCommand, parseConfig);
    if (actions.every((a) => a === "noop")) {
      console.log(`${t("setup.noop")} ${item.file}`);
      continue;
    }
    if (writeConfig(item.file, config)) {
      changed += 1;
    }
    if (item.pluginSpec) {
      console.log(`${t("setup.applied")} ${item.file} — ${t("setup.planPlugin", item.pluginSpec)}`);
    }
    if (item.mcpCommand) {
      console.log(`${t("setup.applied")} ${item.file} — ${t("setup.planMcp", item.mcpCommand.join(" "))}`);
    }
  }
  return changed;
}

export function cmdSetup(rest: string[]): Promise<number> {
  let scope: SetupScope = "global";
  let source: SetupSource = "npm";
  let plugin = true;
  let mcp = false;
  let apply = false;
  let mcpCommand: string[] | undefined;
  for (const arg of rest) {
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--project") {
      scope = "project";
    } else if (arg === "--global") {
      scope = "global";
    } else if (arg === "--no-plugin") {
      plugin = false;
    } else if (arg === "--mcp") {
      mcp = true;
    } else if (arg === "--source") {
      console.error(`${t("error.prefix")}${t("setup.sourceRequiresValue")}`);
      return Promise.resolve(2);
    } else if (arg.startsWith("--source=")) {
      const value = arg.slice("--source=".length);
      if (value !== "npm" && value !== "github" && value !== "local") {
        console.error(`${t("error.prefix")}${t("setup.invalidSource", value)}`);
        return Promise.resolve(2);
      }
      source = value;
    } else if (arg === "--mcp-command") {
      console.error(`${t("error.prefix")}${t("setup.mcpCommandRequiresValue")}`);
      return Promise.resolve(2);
    } else if (arg.startsWith("--mcp-command=")) {
      const parsed = parseMcpCommand(arg.slice("--mcp-command=".length));
      if (!parsed) {
        console.error(`${t("error.prefix")}${t("setup.invalidMcpCommand")}`);
        return Promise.resolve(2);
      }
      mcpCommand = parsed;
      mcp = true;
    } else {
      console.error(`${t("error.prefix")}${t("help.unknown", arg)}`);
      return Promise.resolve(2);
    }
  }
  if (!plugin && !mcp) {
    console.error(`${t("error.prefix")}${t("setup.nothingToDo")}`);
    return Promise.resolve(2);
  }
  const opts: SetupOptions = { scope, source, plugin, mcp, apply, cwd: process.cwd(), mcpCommand };
  let plan: SetupPlan;
  try {
    plan = buildPlan(opts);
  } catch (err) {
    console.error(`${t("error.prefix")}${err instanceof Error ? err.message : String(err)}`);
    return Promise.resolve(1);
  }
  if (!apply) {
    // Pre-check the target config in dry-run too: a broken JSON file must be
    // reported now, not surprise the user on --apply.
    for (const item of plan.items) {
      if (existsSync(item.file)) {
        try {
          parseConfig(item.file);
        } catch (err) {
          console.error(`${t("error.prefix")}${err instanceof Error ? err.message : String(err)}`);
          return Promise.resolve(1);
        }
      }
    }
    console.log(t("setup.dryRunHeader"));
    for (const item of plan.items) {
      if (item.pluginSpec) {
        console.log(`  [${item.label}] ${item.file} — ${t("setup.planPlugin", item.pluginSpec)}`);
      }
      if (item.mcpCommand) {
        console.log(`  [${item.label}] ${item.file} — ${t("setup.planMcp", item.mcpCommand.join(" "))}`);
      }
    }
    console.log(t("setup.dryRunHint"));
    if (source === "github" && mcp) {
      console.log(t("setup.githubMcpHint"));
    }
    return Promise.resolve(0);
  }
  applyPlan(plan);
  if (source === "github" && mcp) {
    console.log(t("setup.githubMcpHint"));
  }
  return Promise.resolve(0);
}
