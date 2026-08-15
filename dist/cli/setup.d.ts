/** GitHub repo used for `--source github` plugin installs. */
export declare const GITHUB_SPEC = "github:panzeyu2013/memcurio";
/** npm package that provides the opencode plugin entrypoint. */
export declare const NPM_PACKAGE = "memcurio";
/** The MCP server launch command for the chosen source:
 *  - npm: one-line launcher through the registry (npx, no install);
 *  - github: the user's own `memcurio` binary on PATH (npm-installed from
 *    the repo) — command only, never an absolute path;
 *  - local: run the built CLI directly with node (development). */
export declare function mcpCommandFor(source: SetupSource, opts: SetupOptions): string[] | undefined;
/** Parse a user-provided `--mcp-command` value: a JSON array of strings
 *  (`'["/path/memcurio","mcp"]'`) or a shell-like string split on whitespace. */
export declare function parseMcpCommand(raw: string): string[] | undefined;
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
export declare function opencodeConfigDir(configDir?: string): string;
/** The opencode.json file for the given scope. Global config lives in
 *  $XDG_CONFIG_HOME/opencode/opencode.json; project config is
 *  <dir>/opencode.json. */
export declare function opencodeConfigFile(scope: SetupScope, opts: SetupOptions): string;
/** The plugin spec string for the chosen source. `local` requires the current
 *  project to be a built memcurio checkout (bundle + CLI present in dist/). */
export declare function pluginSpecFor(source: SetupSource, opts: SetupOptions): string | undefined;
interface ConfigShape {
    plugin?: unknown;
    mcp?: Record<string, unknown>;
}
export type FilePlan = {
    config: ConfigShape;
    actions: Array<"add" | "update" | "noop">;
};
/** Compute the merged config for one file (pure; no IO beyond the optional
 *  reader). Callers reuse it for dry-run and apply so preview == result.
 *  Plugin entries are plain strings (the form opencode's own `plugin add`
 *  writes); the tuple form `[spec, opts]` is only for plugin options, which
 *  memcurio never uses. */
export declare function planForFile(file: string, pluginSpec: string | undefined, mcpCommand: string[] | undefined, read: (f: string) => ConfigShape): FilePlan;
export declare function buildPlan(opts: SetupOptions): SetupPlan;
export declare function applyPlan(plan: SetupPlan): number;
export declare function cmdSetup(rest: string[]): Promise<number>;
export {};
