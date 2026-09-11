/**
 * Settings-panel dictionaries for the `memcurio` namespace. Both built-in
 * locales ship in one registration (official client pattern); the panel
 * language follows the DSH client locale.
 */
export const NS = "memcurio.settings";

export const en = {
  nav: "Memory",
  title: "Memory (memcurio)",
  intro:
    "Durable cross-session memory for this harness instance. The profile bundle supplies the defaults; values saved here override them.",
  scope: "Storage scope",
  scopeWorkspace: "Per workspace (isolated store)",
  scopeGlobal: "Shared store (global)",
  injectContext: "Inject memory into the agent loop",
  registerTools: "Register the memory tools",
  injectBudgetTokens: "Injection budget (tokens)",
  hostBridge: "Memory workbench host bridge",
  provider: "Worker provider",
  model: "Worker model",
  overridden: "overridden",
  reset: "Reset to default",
  resetAll: "Reset all overrides",
  ready: "Ready",
  saving: "Saving…",
  saved: "Saved",
  errRoutePair: "provider and model must be set together",
  errBudgetRange: "The injection budget must be an integer of at least 128 tokens",
  errNotLanded: "The host refused the change (nothing was saved)",
  errResetNotLanded: "The host refused the reset (the override is still active)",
  errPartialReset: "Some overrides could not be cleared; retry per field",
  errHostRejected: "The settings transport rejected the write",
  readOnly: "This client is read-only for settings (process-local settings mode).",
  unavailable: "The memcurio settings namespace is not exposed by this host.",
  loading: "Loading settings…",
  restartTools: "Tool registration changes take effect after a restart.",
  scopeNote: "Scope changes apply to new sessions; existing stores keep their root.",
  rootNote: "The data root stays deployment-level (profile config / MEMCURIO_ROOT) and is read-only here.",
  routeNote: "Provider and model must be set together; leave both empty to follow the session route.",
} as const;

export const zh = {
  nav: "记忆",
  title: "记忆（memcurio）",
  intro:
    "为该 harness 实例提供跨会话持久记忆。profile 配置提供默认值，此处保存的值将覆盖默认。",
  scope: "存储作用域",
  scopeWorkspace: "按工作区隔离",
  scopeGlobal: "共享 store（全局）",
  injectContext: "向 agent loop 注入记忆",
  registerTools: "注册记忆工具",
  injectBudgetTokens: "注入预算（token）",
  hostBridge: "记忆工作台 host 桥",
  provider: "Worker provider",
  model: "Worker model",
  overridden: "已覆盖",
  reset: "恢复默认",
  resetAll: "清除全部覆盖",
  ready: "就绪",
  saving: "保存中…",
  saved: "已保存",
  errRoutePair: "provider 与 model 必须同时设置",
  errBudgetRange: "注入预算必须是 >= 128 的整数",
  errNotLanded: "宿主拒绝了该修改（未保存）",
  errResetNotLanded: "宿主拒绝了恢复默认（覆盖仍然生效）",
  errPartialReset: "部分覆盖未能清除，请逐字段重试",
  errHostRejected: "设置传输拒绝了本次写入",
  readOnly: "当前客户端为只读设置模式（进程内设置）。",
  unavailable: "该宿主未暴露 memcurio 设置命名空间。",
  loading: "正在加载设置…",
  restartTools: "记忆工具注册变更将在重启后生效。",
  scopeNote: "作用域变更对新会话生效；既有 store 保持原数据根。",
  rootNote: "数据根属部署级（profile 配置 / MEMCURIO_ROOT），此处只读。",
  routeNote: "provider 与 model 必须同时设置；两者留空则跟随会话路由。",
} as const;

export type SettingsKey = keyof typeof en;
