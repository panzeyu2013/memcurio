/**
 * Settings-panel dictionaries for the `memcurio` namespace. Both built-in
 * locales ship in one registration (official client pattern); the panel
 * language follows the DSH client locale.
 */
export const NS = "memcurio.settings";

export const en = {
  nav: "Memory",
  title: "Memory (memcurio)",
  intro: "Durable cross-session memory for this harness instance.",
  scope: "Storage scope",
  scopeWorkspace: "Per workspace (isolated store)",
  scopeGlobal: "Shared store (global)",
  injectContext: "Memory",
  registerTools: "Register the memory tools",
  registerToolsNote:
    "On: the six memory_* tools are registered for the agent (write / read / curate memory). Off: the model has no such tools; stored memory and automatic injection are unaffected. Changes apply after a restart.",
  injectBudgetTokens: "Injection budget (tokens)",
  routeLabel: "Worker route",
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
  errNotReady: "The settings transport left its ready state, so the write could not be verified",
  errResetNotLanded: "The host refused the reset (the override is still active)",
  errHostRejected: "The settings transport rejected the write",
  readOnly: "This client is read-only for settings (process-local settings mode).",
  unavailable: "The memcurio settings namespace is not exposed by this host.",
  loading: "Loading settings…",
  scopeNote: "Scope applies to new sessions; the data root is deployment-level (read-only here).",
  save: "Save",
  routeNote: "provider / model are saved as one pair; leave both empty to follow the session route.",
} as const;

export const zh = {
  nav: "记忆",
  title: "记忆（memcurio）",
  intro: "为该 harness 实例提供跨会话持久记忆。",
  scope: "存储作用域",
  scopeWorkspace: "按工作区隔离",
  scopeGlobal: "共享 store（全局）",
  injectContext: "记忆",
  registerTools: "注册记忆工具",
  registerToolsNote:
    "开启：把 6 个 memory_* 工具注册给 agent（记忆写入 / 检索 / 整理）。关闭：模型没有这些工具，已存记忆与自动注入不受影响。变更需重启生效。",
  injectBudgetTokens: "注入预算（token）",
  routeLabel: "Worker 路由",
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
  errNotReady: "设置传输已离开就绪态，无法核验本次写入",
  errResetNotLanded: "宿主拒绝了恢复默认（覆盖仍然生效）",
  errHostRejected: "设置传输拒绝了本次写入",
  readOnly: "当前客户端为只读设置模式（进程内设置）。",
  unavailable: "该宿主未暴露 memcurio 设置命名空间。",
  loading: "正在加载设置…",
  scopeNote: "作用域变更对新会话生效；数据根属部署级配置（此处只读）。",
  save: "保存",
  routeNote: "provider / model 成对保存；都留空则跟随会话路由。",
} as const;

export type SettingsKey = keyof typeof en;
