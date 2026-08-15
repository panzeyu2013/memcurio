/** The codex-style superset of read-only file tools (used as the engine
 * default when an adapter does not declare a toolPreset). */
export const DEFAULT_READ_TOOLS = ["read", "grep", "rg", "glance", "list", "search", "view"];
/** Shell tools whose command string is parsed lexically (never executed) for
 * memory-file reads (the codex-style superset). */
export const DEFAULT_SHELL_TOOLS = ["bash", "exec_command", "command", "shell"];
