export type Lang = "zh" | "en";

export function currentLang(): Lang {
  const raw = (process.env.MEMCORE_LANG ?? process.env.LANG ?? "").toLowerCase();
  if (!raw) {
    return "zh";
  }
  // Only zh locales map to Chinese; anything else (fr, de, ja…) gets English.
  return raw.startsWith("zh") ? "zh" : "en";
}

type Entry = string | ((...args: string[]) => string);

const zh: Record<string, Entry> = {
  "usage.main": `memcore — 跨 harness 记忆与上下文管理系统

用法: memcore <command> [args]

命令:
  init               初始化 ~/.memcore 布局
  status             显示引擎状态（命名空间/后端/审计/pending）
  remember <内容>    写入一条记忆 [--ns X] [--kind MEMORY|USER]
  list               列出记忆 [--ns X] [--kind K] [--all]
  search <query>     检索记忆 [--ns X] [--kind K] [--top-k N]
  forget <id>        删除一条记忆（id 从 memcore list 获取）
  pin <id>           固定条目免于剪枝 [--unset]
  revive <id>        将 stale/archived 条目恢复为 active
  prune              价值感知剪枝（干跑报告；--execute 生效）[--ns X]
  curate             LLM 策展干跑（矛盾/伞合并/重评；--execute 生效）[--ns X] [--min-use N] [--max-checks N]
  export             导出 JSONL [--ns X] [--kind K] [--output FILE]
  import <file>      导入 JSONL [--ns X]
  merge <src> <dst>  命名空间合并（干跑；--execute 生效）
  baseline [dir]     注入 AGENTS.md 记忆区块 [--top-k N]
  index              重新生成全局 INDEX.md
  reindex            从 Markdown 真源重建影子索引（保留使用统计）
  compact <内容>     更新 context 压缩策略（压缩前强制注入；压缩后反思自动写回）[--ns X]
  repair             检测/修复事务异常（--execute 触发重建）
  doctor             自检环境与数据健康
  audit              审计记录 [--limit N]
  event              投递统一事件（--json '{...}'）
  mcp                启动 MCP server（stdio）
  codex-daemon       启动 codex 适配器 daemon
  codex-plugin [dir] 生成 codex 插件包（默认 ~/.memcore/codex-plugin）
  help [cmd]         命令帮助
`,

  "help.init": "memcore init\n  初始化 ~/.memcore 布局（可用 MEMCORE_ROOT 覆盖路径）",
  "help.status": "memcore status\n  显示引擎状态（命名空间/后端/审计/pending）",
  "help.remember": "memcore remember <内容> [--ns X] [--kind MEMORY|USER]\n  写入一条记忆（写入即脱敏密钥、审计注入模式）",
  "help.list": "memcore list [--ns X] [--kind K] [--all]\n  列出记忆（--all 含已归档）",
  "help.search": "memcore search <query> [--ns X] [--kind K] [--top-k N]\n  检索记忆（trigram/like，命中计使用次数）",
  "help.forget": "memcore forget <id>\n  删除一条记忆（id 从 memcore list 获取）",
  "help.pin": "memcore pin <id> [--unset]\n  固定条目免于剪枝 / 取消固定",
  "help.revive": "memcore revive <id>\n  将 stale/archived 条目恢复为 active",
  "help.prune": "memcore prune [--ns X] [--execute]\n  价值感知剪枝（干跑报告；--execute 生效）",
  "help.curate": "memcore curate [--ns X] [--min-use N] [--max-checks N] [--execute]\n  LLM 策展（需 MEMCORE_LLM_API_KEY；矛盾/伞合并/重评）",
  "help.export": "memcore export [--ns X] [--kind K] [--output FILE]\n  导出 JSONL（默认输出到 stdout）",
  "help.import": "memcore import <file.jsonl> [--ns X]\n  导入 JSONL（--ns 覆盖全部条目命名空间）",
  "help.merge": "memcore merge <src-ns> <dst-ns> [--execute]\n  命名空间合并（干跑；--execute 生效）",
  "help.baseline": "memcore baseline [dir] [--top-k N]\n  注入 AGENTS.md 记忆区块（读侧自动注入）",
  "help.index": "memcore index\n  重新生成全局 INDEX.md",
  "help.reindex": "memcore reindex\n  从 Markdown 真源重建影子索引（保留使用统计）",
  "help.compact": "memcore compact <内容> [--ns X]\n  更新 context 压缩策略（压缩前强制注入；压缩后反思自动写回；覆盖旧策略）",
  "help.repair": "memcore repair [--execute]\n  检测/修复事务异常（--execute 触发重建）",
  "help.doctor": "memcore doctor\n  自检环境与数据健康",
  "help.audit": "memcore audit [--limit N]\n  审计记录",
  "help.event": "memcore event --json '{...}' 或从 stdin 读取\n  投递统一事件（session_start/session_end 等）",
  "help.mcp": "memcore mcp\n  启动 MCP server（stdio）",
  "help.codex-daemon": "memcore codex-daemon\n  启动 codex 适配器 daemon",
  "help.codex-plugin": "memcore codex-plugin [dir]\n  生成 codex 插件包（默认 ~/.memcore/codex-plugin）",
  "help.help": "memcore help [cmd]\n  命令帮助",

  "remember.missing": 'remember: missing content (memcore remember "内容")',
  "remember.nsNote": (ns: string, cur: string) =>
    `note: 记忆写入命名空间 '${ns}'；当前目录会话注入使用 '${cur}'，如需注入请加 --ns ${cur} 或设置 config.namespace.default`,
  "search.missing": 'search: missing query (memcore search "关键词")',
  "search.note": (x: string) =>
    `note: 无结果。可检查 --ns 是否匹配（当前: ${x}）、更换关键词，或用 memcore list 确认记忆存在。`,
  "search.filtered": (n: string) => `note: ${n} 条命中因注入风险被过滤，未展示`,
  "forget.missing": "forget: missing entry_id (从 memcore list 获取)",
  "forget.done": (id: string) => `已删除 ${id}`,
  "compact.missing": 'compact: missing content (memcore compact "策略内容")',
  "compact.written": (id: string, ns: string, n: string) => `${id} ${ns}/COMPACT（已替换旧策略 ${n} 条）`,
  "repair.none": "no pending transactions (事务日志健康)",
  "repair.pendingHeader": (n: string) => `${n} 个未完成事务：`,
  "repair.corrupt": (n: string) => `note: ${n} 行事务日志无法解析（torn write），已忽略`,
  "repair.truth": "md 真源为最终真相，索引可重建。",
  "repair.fix": "修复方式：--execute 将从 Markdown 真源重建影子索引（保留使用统计），并清理事务日志。",
  "repair.done": (n: string) => `已修复：从 md 真源重建 ${n} 条，事务日志已清空`,
  "event.tty": "event: stdin 为终端，请用 --json '{...}' 提供信封",
  "curate.noKeyNote": "未配置 MEMCORE_LLM_API_KEY：本次仅做规则扫描，未调用 LLM。设置后 --execute 执行完整策展。",
  "curate.needProvider": "curate --execute 需要 LLM provider：设置 MEMCORE_LLM_API_KEY（可选 MEMCORE_LLM_BASE_URL / MEMCORE_LLM_MODEL）",
  "curate.applied": (r: string, c: string, u: string) =>
    `curate 已应用：${r} 个分数，${c} 条矛盾，${u} 条伞合并`,
  "codexPlugin.snippet": "（config.toml 合并备选）",
  "codexPlugin.hint": "提示：如 codex 未自动加载，将 plugin.json 所在目录复制到 ~/.codex/plugins/memcore/，或将 snippet 合并进 ~/.codex/config.toml",
  "codexPlugin.generated": (d: string) => `codex 插件已生成于 ${d}`,
  "daemon.listening": (p: string) => `memcore codex daemon 监听 ${p}`,
  "unknownCommand": "运行 memcore help 查看全部命令",
  "init.done": (root: string) => `已初始化 ${root}`,
  "init.backend": (b: string) => `索引后端: ${b}`,
  "reindex.done": (n: string, b: string) => `已重建索引 ${n} 条（backend=${b}）`,
  "export.done": (n: string, p: string) => `已导出 ${n} 条 -> ${p}`,
  "import.done": (a: string, e: string, d: string, c: string) =>
    `已导入 ${a} 条（${e} 已存在，${d} 内容重复，${c} 冲突）`,
  "import.conflict": (id: string, ns: string) => `冲突 ${id} 已存在但内容不同（跳过，ns=${ns}）`,
  "merge.done": (n: string, dst: string) => `已合并 ${n} 条到 ${dst}`,
  "prune.none": "没有可剪枝的条目",
  "prune.applied": (n: string) => `已应用 ${n} 条状态转换`,
  "baseline.done": (w: string, c: string, ns: string) => `baseline 已写入: ${w}/AGENTS.md（注入 ${c} 条，ns=${ns}）`,
  "index.done": (p: string) => `索引已重新生成: ${p}/INDEX.md`,
  "status.root": (r: string) => `root      : ${r}`,
  "status.config": (p: string, ok: string) => `config    : ${p} (${ok})`,
  "status.configOk": "ok",
  "status.configMissing": "missing",
  "status.namespaces": "namespaces: (none)",
  "status.index": (b: string) => `index     : sqlite + ${b}`,
  "status.audit": (n: string) => `audit     : ${n} records`,
  "status.pending": (n: string) => `pending   : ${n} txns`,
  "doctor.layout": "布局",
  "doctor.index": "索引",
  "doctor.txn": "事务",
  "doctor.parsable": "可解析",
  "doctor.noPending": "无异常",
  "doctor.daemonIdle": "（未运行，仅 codex 用户需要）",
  "doctor.pluginMissing": "（未生成，仅 codex 用户需要）",
  "doctor.pluginLabel": "· codex 插件包",
  "doctor.ok": "\ndoctor: 全部正常",
  "doctor.bad": "\ndoctor: 发现问题，见上方 ✗ 项",
};

const en: Record<string, Entry> = {
  "usage.main": `memcore — cross-harness memory and context management system

Usage: memcore <command> [args]

Commands:
  init               Initialize the ~/.memcore layout
  status             Show engine status (namespaces/backend/audit/pending)
  remember <text>    Save a memory [--ns X] [--kind MEMORY|USER]
  list               List memories [--ns X] [--kind K] [--all]
  search <query>     Search memories [--ns X] [--kind K] [--top-k N]
  forget <id>        Delete a memory (get id from memcore list)
  pin <id>           Pin an entry to skip pruning [--unset]
  revive <id>        Restore a stale/archived entry to active
  prune              Value-aware pruning (dry-run; --execute applies) [--ns X]
  curate             LLM curation dry-run (contradictions/umbrella/re-eval; --execute applies) [--ns X] [--min-use N] [--max-checks N]
  export             Export JSONL [--ns X] [--kind K] [--output FILE]
  import <file>      Import JSONL [--ns X]
  merge <src> <dst>  Merge namespaces (dry-run; --execute applies)
  baseline [dir]     Inject the AGENTS.md memory section [--top-k N]
  index              Regenerate the global INDEX.md
  reindex            Rebuild the shadow index from the Markdown source of truth (keeps usage stats)
  compact <text>     Update the context-compression strategy (force-injected before compaction; reflection written back after) [--ns X]
  repair             Detect/fix transaction anomalies (--execute triggers rebuild)
  doctor             Self-check environment and data health
  audit              Audit records [--limit N]
  event              Send a unified event (--json '{...}')
  mcp                Start the MCP server (stdio)
  codex-daemon       Start the codex adapter daemon
  codex-plugin [dir] Generate the codex plugin package (default ~/.memcore/codex-plugin)
  help [cmd]         Command help
`,

  "help.init": "memcore init\n  Initialize the ~/.memcore layout (override with MEMCORE_ROOT)",
  "help.status": "memcore status\n  Show engine status (namespaces/backend/audit/pending)",
  "help.remember": "memcore remember <text> [--ns X] [--kind MEMORY|USER]\n  Save a memory (secrets redacted on write; injection patterns audited)",
  "help.list": "memcore list [--ns X] [--kind K] [--all]\n  List memories (--all includes archived)",
  "help.search": "memcore search <query> [--ns X] [--kind K] [--top-k N]\n  Search memories (trigram/like; hits count as usage)",
  "help.forget": "memcore forget <id>\n  Delete a memory (get id from memcore list)",
  "help.pin": "memcore pin <id> [--unset]\n  Pin an entry to skip pruning / unpin",
  "help.revive": "memcore revive <id>\n  Restore a stale/archived entry to active",
  "help.prune": "memcore prune [--ns X] [--execute]\n  Value-aware pruning (dry-run; --execute applies)",
  "help.curate": "memcore curate [--ns X] [--min-use N] [--max-checks N] [--execute]\n  LLM curation (needs MEMCORE_LLM_API_KEY; contradictions/umbrella/re-eval)",
  "help.export": "memcore export [--ns X] [--kind K] [--output FILE]\n  Export JSONL (stdout by default)",
  "help.import": "memcore import <file.jsonl> [--ns X]\n  Import JSONL (--ns overrides all entry namespaces)",
  "help.merge": "memcore merge <src-ns> <dst-ns> [--execute]\n  Merge namespaces (dry-run; --execute applies)",
  "help.baseline": "memcore baseline [dir] [--top-k N]\n  Inject the AGENTS.md memory section (auto-injected on read)",
  "help.index": "memcore index\n  Regenerate the global INDEX.md",
  "help.reindex": "memcore reindex\n  Rebuild the shadow index from the Markdown source of truth (keeps usage stats)",
  "help.compact": "memcore compact <text> [--ns X]\n  Update the context-compression strategy (force-injected before compaction; reflection written back after; replaces old strategy in the namespace)",
  "help.repair": "memcore repair [--execute]\n  Detect/fix transaction anomalies (--execute triggers rebuild)",
  "help.doctor": "memcore doctor\n  Self-check environment and data health",
  "help.audit": "memcore audit [--limit N]\n  Audit records",
  "help.event": "memcore event --json '{...}' or read from stdin\n  Send a unified event (session_start/session_end, etc.)",
  "help.mcp": "memcore mcp\n  Start the MCP server (stdio)",
  "help.codex-daemon": "memcore codex-daemon\n  Start the codex adapter daemon",
  "help.codex-plugin": "memcore codex-plugin [dir]\n  Generate the codex plugin package (default ~/.memcore/codex-plugin)",
  "help.help": "memcore help [cmd]\n  Command help",

  "remember.missing": 'remember: missing content (memcore remember "content")',
  "remember.nsNote": (ns: string, cur: string) =>
    `note: memory saved to namespace '${ns}'; current directory sessions inject from '${cur}' — use --ns ${cur} or set config.namespace.default to inject here`,
  "search.missing": 'search: missing query (memcore search "keyword")',
  "search.note": (x: string) =>
    `note: no results. Check that --ns matches (current: ${x}), try different keywords, or run memcore list to confirm memories exist.`,
  "search.filtered": (n: string) => `note: ${n} hits filtered out by the injection scan, not shown`,
  "forget.missing": "forget: missing entry_id (get it from memcore list)",
  "forget.done": (id: string) => `forgot ${id}`,
  "compact.missing": 'compact: missing content (memcore compact "strategy")',
  "compact.written": (id: string, ns: string, n: string) => `${id} ${ns}/COMPACT (replaced ${n} old strategy entries)`,
  "repair.none": "no pending transactions (transaction log healthy)",
  "repair.pendingHeader": (n: string) => `${n} unfinished transactions:`,
  "repair.corrupt": (n: string) => `note: ${n} transaction log lines are unparsable (torn write), ignored`,
  "repair.truth": "Markdown is the source of truth; the index can be rebuilt.",
  "repair.fix": "Fix: --execute rebuilds the shadow index from the Markdown source of truth (keeps usage stats) and clears the transaction log.",
  "repair.done": (n: string) => `repaired: rebuilt ${n} entries from md truth source, transaction log cleared`,
  "event.tty": "event: stdin is a terminal; pass the envelope with --json '{...}'",
  "curate.noKeyNote": "MEMCORE_LLM_API_KEY not set: rule-based scan only, no LLM calls. Set it and run --execute for full curation.",
  "curate.needProvider": "curate --execute requires an LLM provider: set MEMCORE_LLM_API_KEY (optional MEMCORE_LLM_BASE_URL / MEMCORE_LLM_MODEL)",
  "curate.applied": (r: string, c: string, u: string) =>
    `curate applied: ${r} scores, ${c} contradictions, ${u} umbrellas`,
  "codexPlugin.snippet": "(fallback for merging into config.toml)",
  "codexPlugin.hint": "Note: if codex does not auto-load the plugin, copy the plugin.json directory to ~/.codex/plugins/memcore/, or merge the snippet into ~/.codex/config.toml",
  "codexPlugin.generated": (d: string) => `codex plugin generated in ${d}`,
  "daemon.listening": (p: string) => `memcore codex daemon listening on ${p}`,
  "unknownCommand": "Run memcore help to see all commands.",
  "init.done": (root: string) => `initialized ${root}`,
  "init.backend": (b: string) => `index backend: ${b}`,
  "reindex.done": (n: string, b: string) => `reindexed ${n} entries (backend=${b})`,
  "export.done": (n: string, p: string) => `exported ${n} entries -> ${p}`,
  "import.done": (a: string, e: string, d: string, c: string) =>
    `imported ${a} entries (${e} existing, ${d} content-dup, ${c} conflicts)`,
  "import.conflict": (id: string, ns: string) => `conflict ${id} exists with different content (skipped, ns=${ns})`,
  "merge.done": (n: string, dst: string) => `merged ${n} entries into ${dst}`,
  "prune.none": "nothing to prune",
  "prune.applied": (n: string) => `applied ${n} transitions`,
  "baseline.done": (w: string, c: string, ns: string) => `baseline written: ${w}/AGENTS.md (${c} entries injected, ns=${ns})`,
  "index.done": (p: string) => `index regenerated: ${p}/INDEX.md`,
  "status.root": (r: string) => `root      : ${r}`,
  "status.config": (p: string, ok: string) => `config    : ${p} (${ok})`,
  "status.configOk": "ok",
  "status.configMissing": "missing",
  "status.namespaces": "namespaces: (none)",
  "status.index": (b: string) => `index     : sqlite + ${b}`,
  "status.audit": (n: string) => `audit     : ${n} records`,
  "status.pending": (n: string) => `pending   : ${n} txns`,
  "doctor.layout": "layout",
  "doctor.index": "index",
  "doctor.txn": "transactions",
  "doctor.parsable": "parseable",
  "doctor.noPending": "no pending",
  "doctor.daemonIdle": " (not running; codex users only)",
  "doctor.pluginMissing": " (not generated; codex users only)",
  "doctor.pluginLabel": "· codex plugin package",
  "doctor.ok": "\ndoctor: all checks passed",
  "doctor.bad": "\ndoctor: issues found, see the ✗ items above",
};

const dicts: Record<Lang, Record<string, Entry>> = { zh, en };

/** Keys present in a language dictionary (for parity checks). */
export function langKeys(lang: Lang): string[] {
  return Object.keys(dicts[lang]);
}

export function t(key: string, ...args: string[]): string {
  const entry = dicts[currentLang()][key] ?? zh[key] ?? key;
  return typeof entry === "function" ? entry(...args) : entry;
}
