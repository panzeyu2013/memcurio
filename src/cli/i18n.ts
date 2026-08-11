export type Lang = "zh" | "en";

export function currentLang(): Lang {
  // `||` (not `??`) so an empty MEMCURIO_LANG falls through to LANG / default.
  const raw = (process.env.MEMCURIO_LANG || process.env.LANG || "").toLowerCase();
  if (!raw) {
    return "zh";
  }
  // Only zh locales map to Chinese; anything else (fr, de, ja…) gets English.
  return raw.startsWith("zh") ? "zh" : "en";
}

type Entry = string | ((...args: string[]) => string);

const zh: Record<string, Entry> = {
  "usage.main": `memcurio — 模型驱动的跨会话记忆系统（codex 式两阶段管线）

用法: memcurio <command> [args]

命令:
  init                初始化 ~/.memcurio 布局
  status              显示管线状态（stage1/notes/审计/pending）
  remember <内容>     写一条 ad-hoc 记忆 note（下次整合生效）[--apply 立即整合]
  forget <文本>       写一条"忘掉"note（整合时移除含该文本的条目）[--apply 立即整合]
  list                列出 MEMORY.md 分组 / rollout 摘要 / pending notes
  search <query>      检索记忆 [--top-k N]
  prune               选择窗口干跑（窗口外的 stage1 将被剪除）[--execute]
  purge               物理清除一个 rollout（--rollout-key KEY --execute，可选 --export FILE）
  curate              Phase 2 整合干跑（预览 diff）[--execute] [--max-steps N]
  baseline [dir]      把记忆上下文注入 AGENTS.md
  reindex             从 stage1 库重新同步 artifacts 并重置基线
  repair              检测/修复事务异常（--execute 触发重同步）
  doctor              自检环境与数据健康
  audit [--limit N]   审计记录
  export [--output F] 导出 stage1 + notes 的 JSONL
  import <file>       导入 JSONL
  retry-extraction    消费本地提取队列（可用 --limit N、--dead 重置死信）
  event [--json]      投递统一事件
  mcp                 启动 MCP server（stdio）
  codex-daemon        启动 codex 适配器 daemon
  codex-plugin [dir]  生成 codex 插件包
  help [cmd]          命令帮助
`,

  "help.init": "memcurio init\n  初始化 ~/.memcurio 布局（可用 MEMCURIO_ROOT 覆盖路径）",
  "help.status": "memcurio status\n  显示管线状态：stage1 计数（pending/selected/deleted）、ad-hoc notes、审计数、pending 事务、提取队列",
  "help.remember": "memcurio remember <内容> [--apply]\n  写一条 ad-hoc remember note（密钥自动脱敏、注入模式记审计）；\n  --apply 立即用规则整合器把 note 并入 MEMORY.md",
  "help.forget": "memcurio forget <文本> [--apply]\n  写一条 ad-hoc forget note；整合时移除 MEMORY.md/memory_summary.md 中包含该文本的行\n  --apply 立即整合",
  "help.list": "memcurio list\n  列出 MEMORY.md 的 Task Group 分组、rollout_summaries 文件、未应用的 notes",
  "help.search": "memcurio search <query> [--top-k N]\n  在工作区 Markdown 中检索（行级子串计分；注入模式命中被过滤；命中计使用次数）",
  "help.prune": "memcurio prune [--execute]\n  选择窗口干跑：窗口外（超过 maxUnusedDays 未使用）的 stage1 将被标记删除并剪除摘要；\n  --execute 执行剪除并运行规则整合清理 MEMORY.md",
  "help.purge": "memcurio purge --rollout-key HOST|SESSION --execute [--export FILE]\n  物理清除本地 stage1、rollout artifact、提取队列/会话和相关 Markdown 支持；只会清理显式指定的 JSONL export，远端/其他备份需另行处理",
  "help.curate": "memcurio curate [--execute] [--max-steps N]\n  Phase 2 整合：选择 stage1 → 同步 artifacts → 对基线 diff → 由整合器改写 MEMORY.md/memory_summary.md；\n  --execute 应用（有 MEMCURIO_LLM_API_KEY 用 LLM 代理，否则规则整合器）",
  "help.baseline": "memcurio baseline [dir]\n  把记忆上下文（memory_summary + 指引）注入 <dir>/AGENTS.md 的 memcurio 区块",
  "help.reindex": "memcurio reindex\n  按当前 stage1 库重新同步 raw_memories.md 与 rollout_summaries/，并重置 .baseline",
  "help.repair": "memcurio repair [--execute]\n  检测事务日志中的孤儿 BEGIN 与损坏行；--execute 重同步 artifacts 并清空日志",
  "help.doctor": "memcurio doctor\n  自检：布局/配置/DB/工作区漂移/pending 事务/codex daemon",
  "help.audit": "memcurio audit [--limit N]\n  最近审计记录",
  "help.export": "memcurio export [--output FILE]\n  导出 stage1 输出与 ad-hoc notes 的 JSONL（默认 stdout）",
  "help.import": "memcurio import <file.jsonl>\n  导入 JSONL 备份（stage1 按 rollout_key 去重；notes 按 id 去重并恢复 note 文件）",
  "help.retry-extraction": "memcurio retry-extraction [--limit N] [--dead]\n  使用当前 HTTP provider 消费 durable extraction queue；--dead 将 dead-letter 重置为 pending 后重试",
  "help.event": "memcurio event [--json '{...}']\n  投递统一事件（stdin 或 --json），记录 sessions/审计",
  "help.mcp": "memcurio mcp\n  启动 MCP server（stdio）：memory_search / memory_remember / memory_forget / memory_status / memory_context",
  "help.codex-daemon": "memcurio codex-daemon\n  启动 codex 适配器 daemon（unix socket + token 鉴权）",
  "help.codex-plugin": "memcurio codex-plugin [dir]\n  生成 codex 插件包（.codex-plugin manifest + hooks + MCP bundle）",
  "help.help": "memcurio help [cmd]\n  命令帮助",

  "init.done": (r: string) => `已初始化 ${r}`,
  "init.autocreated": "memcurio: 数据根目录尚不存在，已自动创建",
  "init.hint": "提示：请先运行 memcurio init 初始化布局",

  "status.root": (r: string) => `root: ${r}`,
  "status.config": (p: string, s: string) => `config: ${p} (${s})`,
  "status.configMissing": "缺失",
  "status.configOk": "正常",
  "status.configBroken": "损坏",
  "status.stage1": (p: string, s: string, d: string) => `stage1: pending=${p} selected=${s} deleted=${d}`,
  "status.notes": (t: string, p: string) => `ad-hoc notes: ${t} (pending=${p})`,
  "status.audit": (n: string) => `audit: ${n}`,
  "status.pending": (n: string) => `pending txns: ${n}`,
  "status.extractions": (n: string) => `提取任务 pending/processing/blocked: ${n}`,

  "remember.missing": "缺少记忆内容（用法: memcurio remember <内容>）",
  "remember.tooLong": (n: string) => `内容过长（上限 ${n} 字符）`,
  "remember.done": (f: string) => `已写入记忆 note: ${f}`,
  "remember.applyNote": "执行整合后写入 MEMORY.md；未整合前可 memcurio curate --execute 手动触发",

  "forget.missing": "缺少要遗忘的文本（用法: memcurio forget <文本>）",
  "forget.done": (f: string) => `已写入 forget note: ${f}`,
  "purge.missingKey": "缺少 --rollout-key（用法: memcurio purge --rollout-key HOST|SESSION --execute）",
  "purge.requiresExecute": "物理清除必须显式使用 --execute；可先检查 rollout-key 和 export 路径",
  "purge.notFound": (k: string) => `未找到 rollout: ${k}`,
  "purge.done": (k: string, f: string, e: string, s: string) => `已物理清除 ${k}（artifact=${f}，清理 export 记录 ${e} 条，移除引用该 rollout 的 skill ${s} 个）；远端/其他备份仍需按保留策略处理`,

  "list.empty": "（暂无记忆）",
  "list.groups": "MEMORY.md task groups:",
  "list.rollouts": "rollout summaries:",
  "list.notes": "pending notes:",

  "search.missing": "缺少检索词（用法: memcurio search <query>）",
  "search.note": "无命中",
  "search.filtered": (n: string) => `${n} 条命中因注入模式被过滤`,

  "prune.none": "没有可剪除的 stage1 输出",
  "prune.applied": (n: string) => `已剪除 ${n} 条 stage1 输出（摘要文件已删除，MEMORY.md 已清理）`,
  "prune.executeHint": "--execute 执行剪除",

  "curate.applied": (m: string) => m,
  "curate.noKeyNote": "未设置 MEMCURIO_LLM_API_KEY，使用规则整合器（确定性；LLM 整合请设置该环境变量）",
  "curate.dryRun": "干跑完成（未写盘）；--execute 应用",

  "baseline.done": (dir: string, bytes: string) => `已注入 AGENTS.md (${dir}, ${bytes} bytes)`,

  "reindex.done": (n: string) => `已同步 ${n} 个文件并重置基线`,

  "repair.none": "事务日志健康，无需修复",
  "repair.pendingHeader": (n: string) => `发现 ${n} 个 pending 事务:`,
  "repair.corrupt": (n: string) => `发现 ${n} 行损坏日志`,
  "repair.generations": (n: string) => `发现 ${n} 个未收敛 generation manifest`,
  "repair.invalidGeneration": "存在损坏的 generation manifest，无法安全自动修复；请人工检查 state/consolidation",
  "repair.truth": "提示: pending 事务表示上次批量写未完成；--execute 会重同步 artifacts 并收敛",
  "repair.fix": "存在待修复问题（运行 --execute 修复）",
  "repair.done": (n: string) => `已修复（重同步 ${n} 个文件，日志已清空）`,

  "doctor.layout": "布局",
  "doctor.config": "配置",
  "doctor.parsable": "可解析",
  "doctor.index": "索引库",
  "doctor.txn": "事务日志",
  "doctor.extraction": "提取队列 pending/processing/blocked",
  "doctor.noPending": "无 pending",
  "doctor.deadLetters": "提取 dead-letter",
  "doctor.noDeadLetters": "无 dead-letter",
  "doctor.generation": "generation manifest",
  "doctor.noGenerations": "无孤立 manifest",
  "doctor.ok": "一切正常",
  "doctor.bad": "发现问题",
  "doctor.daemonIdle": "（未运行）",
  "doctor.pluginLabel": "codex 插件包",
  "doctor.pluginMissing": "（未生成）",
  "doctor.codexSpool": "Codex SessionEnd spool",
  "doctor.memory": "记忆工作区",
  "doctor.stage1": "stage1 输出",
  "doctor.drift": "工作区与基线不一致",
  "doctor.driftHint": "运行 memcurio reindex 或 memcurio curate --execute 收敛",

  "event.tty": "event 需要 stdin 输入或 --json 参数",
  "event.invalid": (e: string) => `事件无效: ${e}`,

  "export.done": (n: string, out: string) => `已导出 ${n} 条记录 -> ${out}`,
  "import.missing": "缺少导入文件（用法: memcurio import <file.jsonl>）",
  "import.empty": (p: string) => `${p} 中没有可导入的记录`,
  "import.tooLarge": (n: string) => `导入文件超过大小上限（${n} 字节）`,
  "import.invalid": (n: string) => `导入已中止：发现 ${n} 条无效或不安全记录（不会写入任何数据）`,
  "import.done": (a: string, s: string) => `导入完成: +${a}，跳过 ${s}`,
  "import.conflict": (k: string) => `跳过（已存在）: ${k}`,
  "extract.retryDone": (n: string, s: string, r: string, d: string, b: string, q: string) => `提取队列处理 ${n} 个：staged=${s} retry=${r} dead=${d} blocked=${b} requeued=${q}`,

  "daemon.listening": (p: string) => `codex daemon 监听 ${p}`,
  "codexPlugin.generated": (d: string) => `已生成插件包: ${d}`,
  "codexPlugin.snippet": "（snippet 为全事件示例，hook 已配置事件子集）",
  "codexPlugin.hint": "按 docs/integration-codex.md 安装",

  "error.prefix": "memcurio: ",
  "help.unknown": (c: string) => `未知命令: ${c}（memcurio help 查看命令列表）`,
  "version": (v: string) => `memcurio ${v}`,

  "note.extraArgs": (cmd: string, max: string) => `注意: ${cmd} 最多接受 ${max} 个位置参数，多余参数被忽略`,
  "note.invalidInt": (name: string, v: string, def: string) => `${name} 不是有效整数（${v}），使用默认值 ${def}`,
  "note.clamped": (name: string, v: string, max: string) => `${name}（${v}）超出上限，使用 ${max}`,
  "note.nonInteger": (name: string, v: string) => `${name}（${v}）不是整数，已取整`,

  "corruptIndex.hint": "index.sqlite 损坏：删除该文件后运行 memcurio reindex 重建（md 真源不受影响）",
};

const en: Record<string, Entry> = {
  "usage.main": `memcurio — model-driven cross-session memory (codex-style two-phase pipeline)

Usage: memcurio <command> [args]

Commands:
  init                Initialize the ~/.memcurio layout
  status              Show pipeline status (stage1/notes/audit/pending)
  remember <text>     Write an ad-hoc memory note (applied on next consolidation) [--apply]
  forget <text>       Write a "forget" note (removes lines containing the text) [--apply]
  list                List MEMORY.md groups / rollout summaries / pending notes
  search <query>      Search memories [--top-k N]
  prune               Selection-window dry run [--execute]
  purge               Hard-delete one rollout (--rollout-key KEY --execute, optional --export FILE)
  curate              Phase 2 consolidation dry run (diff preview) [--execute] [--max-steps N]
  baseline [dir]      Inject the memory context into AGENTS.md
  reindex             Re-sync artifacts from the stage-1 store and reset the baseline
  repair              Detect/fix transaction anomalies (--execute re-syncs)
  doctor              Self-check environment and data health
  audit [--limit N]   Audit records
  export [--output F] Export stage-1 outputs + notes as JSONL
  import <file>       Import JSONL
  retry-extraction    Drain the local extraction queue (--limit N, --dead to reset dead-letter jobs)
  event [--json]      Submit a unified event
  mcp                 Start the MCP server (stdio)
  codex-daemon        Start the codex adapter daemon
  codex-plugin [dir]  Generate the codex plugin package
  help [cmd]          Command help
`,

  "help.init": "memcurio init\n  Initialize the ~/.memcurio layout (override with MEMCURIO_ROOT)",
  "help.status": "memcurio status\n  Pipeline status: stage-1 counts (pending/selected/deleted), ad-hoc notes, audit count, pending txns, extraction queue",
  "help.remember": "memcurio remember <text> [--apply]\n  Write an ad-hoc remember note (secrets redacted, injection patterns audited);\n  --apply consolidates immediately with the rule consolidator",
  "help.forget": "memcurio forget <text> [--apply]\n  Write an ad-hoc forget note; consolidation removes lines containing the text from MEMORY.md/memory_summary.md\n  --apply consolidates immediately",
  "help.list": "memcurio list\n  List MEMORY.md Task Groups, rollout summaries, and unapplied notes",
  "help.search": "memcurio search <query> [--top-k N]\n  Line-level substring search over the workspace markdown; injection hits filtered; hits count as usage",
  "help.prune": "memcurio prune [--execute]\n  Selection-window dry run: stage-1 outputs outside the unused-days window get pruned;\n  --execute prunes and runs rule consolidation to clean MEMORY.md",
  "help.purge": "memcurio purge --rollout-key HOST|SESSION --execute [--export FILE]\n  Hard-delete one local rollout, its stage-1/artifact/queue/session data, and Markdown support; only explicitly named JSONL exports are scrubbed; remote/other backups need separate retention handling",
  "help.curate": "memcurio curate [--execute] [--max-steps N]\n  Phase 2 consolidation: select stage-1 -> sync artifacts -> diff vs baseline -> agent rewrites MEMORY.md/memory_summary.md;\n  --execute applies (LLM agent with MEMCURIO_LLM_API_KEY, rule consolidator otherwise)",
  "help.baseline": "memcurio baseline [dir]\n  Inject the memory context (memory_summary + pointers) into <dir>/AGENTS.md",
  "help.reindex": "memcurio reindex\n  Re-sync raw_memories.md and rollout_summaries/ from the stage-1 store and reset .baseline",
  "help.repair": "memcurio repair [--execute]\n  Detect orphan BEGIN records and corrupt lines in the txn log; --execute re-syncs artifacts and clears the log",
  "help.doctor": "memcurio doctor\n  Self-check: layout/config/DB/workspace drift/pending txns/codex daemon",
  "help.audit": "memcurio audit [--limit N]\n  Recent audit records",
  "help.export": "memcurio export [--output FILE]\n  Export stage-1 outputs and ad-hoc notes as JSONL (stdout by default)",
  "help.import": "memcurio import <file.jsonl>\n  Import a JSONL backup (stage-1 deduped by rollout_key; notes deduped by id and files restored)",
  "help.retry-extraction": "memcurio retry-extraction [--limit N] [--dead]\n  Drain durable extraction jobs with the configured HTTP provider; --dead resets dead-letter jobs before retrying",
  "help.event": "memcurio event [--json '{...}']\n  Submit a unified event (stdin or --json), recording sessions/audit",
  "help.mcp": "memcurio mcp\n  Start the MCP server (stdio): memory_search / memory_remember / memory_forget / memory_status / memory_context",
  "help.codex-daemon": "memcurio codex-daemon\n  Start the codex adapter daemon (unix socket + token auth)",
  "help.codex-plugin": "memcurio codex-plugin [dir]\n  Generate the codex plugin package (.codex-plugin manifest + hooks + MCP bundle)",
  "help.help": "memcurio help [cmd]\n  Command help",

  "init.done": (r: string) => `initialized ${r}`,
  "init.autocreated": "memcurio: data root did not exist; created it automatically",
  "init.hint": "hint: run memcurio init first",

  "status.root": (r: string) => `root: ${r}`,
  "status.config": (p: string, s: string) => `config: ${p} (${s})`,
  "status.configMissing": "missing",
  "status.configOk": "ok",
  "status.configBroken": "broken",
  "status.stage1": (p: string, s: string, d: string) => `stage1: pending=${p} selected=${s} deleted=${d}`,
  "status.notes": (t: string, p: string) => `ad-hoc notes: ${t} (pending=${p})`,
  "status.audit": (n: string) => `audit: ${n}`,
  "status.pending": (n: string) => `pending txns: ${n}`,
  "status.extractions": (n: string) => `extraction jobs pending/processing/blocked: ${n}`,

  "remember.missing": "missing memory content (usage: memcurio remember <text>)",
  "remember.tooLong": (n: string) => `content too long (max ${n} chars)`,
  "remember.done": (f: string) => `memory note written: ${f}`,
  "remember.applyNote": "applied to MEMORY.md after consolidation; run memcurio curate --execute to trigger now",

  "forget.missing": "missing forget target (usage: memcurio forget <text>)",
  "forget.done": (f: string) => `forget note written: ${f}`,
  "purge.missingKey": "missing --rollout-key (usage: memcurio purge --rollout-key HOST|SESSION --execute)",
  "purge.requiresExecute": "hard purge requires explicit --execute; inspect the rollout key and export path first",
  "purge.notFound": (k: string) => `rollout not found: ${k}`,
  "purge.done": (k: string, f: string, e: string, s: string) => `hard-purged ${k} (artifact=${f}, scrubbed ${e} export record(s), removed ${s} skill(s) referencing the rollout); remote/other backups still follow their retention policy`,

  "list.empty": "(no memories yet)",
  "list.groups": "MEMORY.md task groups:",
  "list.rollouts": "rollout summaries:",
  "list.notes": "pending notes:",

  "search.missing": "missing query (usage: memcurio search <query>)",
  "search.note": "no hits",
  "search.filtered": (n: string) => `${n} hit(s) filtered for injection patterns`,

  "prune.none": "nothing to prune",
  "prune.applied": (n: string) => `pruned ${n} stage-1 output(s); summaries removed and MEMORY.md cleaned`,
  "prune.executeHint": "--execute to apply",

  "curate.applied": (m: string) => m,
  "curate.noKeyNote": "MEMCURIO_LLM_API_KEY not set; using the rule consolidator (deterministic). Set it for LLM consolidation",
  "curate.dryRun": "dry run complete (nothing written); --execute to apply",

  "baseline.done": (dir: string, bytes: string) => `injected AGENTS.md (${dir}, ${bytes} bytes)`,

  "reindex.done": (n: string) => `synced ${n} file(s) and reset the baseline`,

  "repair.none": "transaction log healthy, nothing to repair",
  "repair.pendingHeader": (n: string) => `${n} pending transaction(s):`,
  "repair.corrupt": (n: string) => `${n} corrupt log line(s)`,
  "repair.generations": (n: string) => `${n} unfinished generation manifest(s)`,
  "repair.invalidGeneration": "a generation manifest is malformed; inspect state/consolidation manually before repair",
  "repair.truth": "pending txns mean an unfinished batch write; --execute re-syncs artifacts and converges",
  "repair.fix": "issues found (run --execute to fix)",
  "repair.done": (n: string) => `repaired (re-synced ${n} file(s), log cleared)`,

  "doctor.layout": "layout",
  "doctor.config": "config",
  "doctor.parsable": "parsable",
  "doctor.index": "index db",
  "doctor.txn": "txn log",
  "doctor.extraction": "extraction queue pending/processing/blocked",
  "doctor.noPending": "no pending",
  "doctor.deadLetters": "extraction dead-letter",
  "doctor.noDeadLetters": "no dead-letter jobs",
  "doctor.generation": "generation manifests",
  "doctor.noGenerations": "no orphaned manifests",
  "doctor.ok": "all good",
  "doctor.bad": "problems found",
  "doctor.daemonIdle": " (idle)",
  "doctor.pluginLabel": "codex plugin package",
  "doctor.pluginMissing": " (not generated)",
  "doctor.codexSpool": "Codex SessionEnd spool",
  "doctor.memory": "memory workspace",
  "doctor.stage1": "stage-1 outputs",
  "doctor.drift": "workspace drifts from the baseline",
  "doctor.driftHint": "run memcurio reindex or memcurio curate --execute",

  "event.tty": "event requires stdin input or --json",
  "event.invalid": (e: string) => `invalid event: ${e}`,

  "export.done": (n: string, out: string) => `exported ${n} record(s) -> ${out}`,
  "import.missing": "missing import file (usage: memcurio import <file.jsonl>)",
  "import.empty": (p: string) => `${p} contains no importable records`,
  "import.tooLarge": (n: string) => `import file exceeds the size limit (${n} bytes)`,
  "import.invalid": (n: string) => `import aborted: ${n} invalid or unsafe record(s); no data was written`,
  "import.done": (a: string, s: string) => `import done: +${a}, skipped ${s}`,
  "import.conflict": (k: string) => `skipped (already exists): ${k}`,
  "extract.retryDone": (n: string, s: string, r: string, d: string, b: string, q: string) => `processed ${n} extraction job(s): staged=${s} retry=${r} dead=${d} blocked=${b} requeued=${q}`,

  "daemon.listening": (p: string) => `codex daemon listening on ${p}`,
  "codexPlugin.generated": (d: string) => `plugin package generated: ${d}`,
  "codexPlugin.snippet": " (snippet is a full-event example; the hook is configured with a subset)",
  "codexPlugin.hint": "install per docs/integration-codex.md",

  "error.prefix": "memcurio: ",
  "help.unknown": (c: string) => `unknown command: ${c} (memcurio help for the command list)`,
  "version": (v: string) => `memcurio ${v}`,

  "note.extraArgs": (cmd: string, max: string) => `note: ${cmd} accepts at most ${max} positional args; extra args ignored`,
  "note.invalidInt": (name: string, v: string, def: string) => `${name} is not a valid integer (${v}); using default ${def}`,
  "note.clamped": (name: string, v: string, max: string) => `${name} (${v}) exceeds the cap; using ${max}`,
  "note.nonInteger": (name: string, v: string) => `${name} (${v}) is not an integer; rounded`,

  "corruptIndex.hint": "index.sqlite is corrupted: delete it and run memcurio reindex (md truth is unaffected)",
};

const dicts: Record<Lang, Record<string, Entry>> = { zh, en };

export function t(key: string, ...args: string[]): string {
  const entry = dicts[currentLang()][key];
  if (typeof entry === "function") {
    return entry(...args);
  }
  if (typeof entry === "string") {
    return entry;
  }
  return key;
}
