# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Citations are a native tool call (v2.0).** The read-path guide now tells the
  model to call `memory_cite` once before the final answer with the memory
  entries and rollout ids the reply used, instead of appending a
  `<memcurio-citation>` text block. The tool validates and bounds its arguments
  (≤100 refs each), registers usage through the same selection window, audits as
  `integration.cite`, and feeds the UI citation node; the client registers the
  seventh keyed `tool.call.toolview` row. There is no text-block fallback: the
  old parser and its `turn/end` harvest are removed, and assistant text is
  never parsed for telemetry.
- **Phase-1 extraction is a native tool turn.** The extraction provider no
  longer asks the model for a JSON object in prose: it sends two tool schemas
  (`save_extraction` with the payload, `skip_extraction` for the no-op gate)
  through the same `agent()` channel and reads the single call. Field formats
  live in the tool schemas, so the system prompt carries only how to make the
  call. The tolerant JSON extractor (`src/core/json.ts`), the `LlmChannel.chat`
  text turn and the plugin's text transport are removed; malformed or missing
  calls fail the durable job instead of being repaired from prose.
- **System-prompt guide trimmed to tool-call rules.** The read-path guide no
  longer restates tool bodies (their schemas already describe them) and carries
  only the decision boundary, quick-pass budget, staleness rules, the
  `memory_cite` call and the write gate. The client's "memory tools" count is
  now the registered set instead of a scan of the section text.

### Changed

- **Context injection is a context-window snapshot (codex parity).** The
  per-turn dynamic recall injection is removed: `agent/pre-step` injects the
  summary once when a window opens — the session's first step, and again after
  `compaction/end` — and steady-state turns inject nothing, so the model
  reaches the store through the memory tools. The summary cap rises to 2,500
  tokens and an over-budget summary is middle-truncated (head and tail
  survive; a head-only cut silently dropped the newest sections). Tool budgets
  follow codex: `memory_search` defaults to and caps at 200 results,
  `memory_list` at 2,000 entries, `memory_read` at 20,000 tokens; the
  pipeline defaults move to `maxUnusedDays` 30 (the unused window) and
  `maxInputs` 256 (new inputs per consolidation batch; the selected backlog
  stays in the batch because memcurio consolidates incrementally).
- **Browser/delta field surface trimmed to what is produced and read.** The
  injection preview's `dynamicText` is gone end to end: per-turn dynamic
  recall was already removed in v2.1, so that field could only ever be empty —
  the client toast now announces the static summary only. The
  `inject-updated` delta no longer carries the unread `workdir`, and the
  snapshot no longer reports the constant
  `realtime: { mode: "polling", degraded: false }` placeholder (connection
  mode is transport state, set by `onMode`). The host write-path filter
  (bridge + snapshot) moved into `src/services/write-path.ts` and is pinned
  to the browser copy by `tests/write-path.test.ts`.
- **Prompts follow Codex's composition; note writing stays explicit-ask.**
  The read-path guide is composed like Codex's `memories/read_path.md`
  (decision boundary, memory layout, quick pass + budget, verification and
  disclosure, citation requirements, updating memories), and the Phase 1/2
  prompts gained Codex's sectioning (safety/hygiene/no-filler rules, no-op
  gate, high-signal buckets, rollout reading order, outcome triage). Two
  adaptations stay deliberate: the layout is path-free (memory is reached
  through the tools) and citations are the native `memory_cite` call rather
  than a text block. `memory_remember` keeps the explicit-user-request gate
  — matching Codex's `ad_hoc_note` — while gaining an optional `kind`
  (remember|forget|update, default remember); forget/update notes are applied
  by the LLM consolidation agent, and the deterministic rule provider keeps
  merging remember notes only. Safety is unchanged: redaction + injection
  scan at the entry point, append-only notes, audit, and consolidation as the
  only writer of `MEMORY.md`.
- The browser store's delta fold compares trimmed static text when the delta
  carries it, so a whitespace-only difference no longer reads as a fresh
  injection (matching the snapshot fold).
- `LlmChannel` gains an optional `agent()` native tool turn; hosts that do
  not implement it lose the LLM consolidation path (rule fallback) rather than
  receiving a text protocol.

### Fixed

- **Only user-authored messages become evidence.** Extraction evidence now
  admits DSH's `source.kind === "user"` and assistant turns. A subagent
  settlement, a child's `send_message` report, a goal round, an instruction
  projection and a plugin injection no longer enter evidence as the user's own
  statements — the previous filter excluded only plugin-sourced messages, so a
  child agent's report was extracted as the strongest preference evidence.
- **Audit round: data-integrity and concurrency hardening.** `redactSecrets`
  now returns the raw text with only the matched spans replaced — Cyrillic,
  Greek and fullwidth text is no longer rewritten by the detection fold —
  while homoglyph/zero-width-obfuscated secrets are still redacted;
  stale-lock reclaim snapshots content + inode + mtime and re-verifies them
  after an atomic rename, and a holder releases only its own lock;
  concurrent first-open migrations re-read the schema inside
  `BEGIN IMMEDIATE` and tolerate a duplicate column; `raw_memories.md`
  rotates its byte-capped window and keeps dropped rows pending instead of
  marking them integrated; workspace listings skip symlinks and directories;
  pending notes are read from the file (the source of truth);
  `pipeline.maxInputs` validation matches its clamp.
- **Session lifecycle recovery.** An event-lane failure is surfaced once and
  cleared instead of poisoning every later pre-step, flush and memory tool; a
  dispose racing an extraction drain stops before the next job instead of
  burning an attempt; a policy-repaired extraction audits `extract.repaired`.
- **Memory UI realtime fixes.** Switching sessions rebinds the SSE stream;
  reconnects close the previous stream and drop already-applied frames; a
  stale browse response cannot overwrite a newer store; a browsed store
  disappearing folds back to the current store; snapshots without a valid
  store are dropped instead of throwing; and warning/bookkeeping audit rows no
  longer raise the unread badge or a "memory updated" toast.
- **Preview and presentation parity.** Workbench and `memory_context` previews
  use the live inject budget; the projector duplicate window is really
  LRU; the browser transport hands the route to the next live instance on
  unload; and the guide is omitted when native tools are disabled.
- **Release and packaging gates.** The release workflow treats only a
  confirmed "release not found" as absent (any other `gh` failure fails
  closed); `pack-check` fails loudly when the bun dry-run output cannot be
  parsed; release notes fall back to a non-empty `[Unreleased]`; the package
  pins `packageManager` and declares the missing settings peer as optional.
- **Phase 2 is a real tool-calling agent loop.** The consolidation provider no
  longer asks the model to emit a JSON object in prose: the host channel now
  exposes a native tool turn (`agent()` over DSH's `llm.stream` tools field),
  the model calls `list_files` / `read_file` / `write_file` / `finish`
  schemas, and tool results travel back as correlated tool-result messages. A
  channel without native tool calling reports the run as incomplete and the
  deterministic rule provider takes over — the JSON-in-prose protocol and its
  parser are removed. The live instance had never succeeded at the old protocol
  ("no tool call parsed": four failures plus a rule fallback).
- **Thinking-mode tool replay.** With the tool loop live, every follow-up
  request failed with `400 invalid_request_error: The reasoning_content in the
  thinking mode must be passed back to the API` (reproduced against the live
  route): the loop dropped the provider's reasoning when echoing the tool-call
  assistant message. `AgentToolReply`/`AgentTurnMessage` now carry reasoning
  and the DSH channel maps it to a reasoning block that the adapter replays as
  `reasoning_content`.
- **Dead AGENTS.md injection removed.** `renderBaselineSection` /
  `updateAgentsMd` / `injectBaseline` had no callers, wrote absolute store
  paths into a project `AGENTS.md` (contradicting the path-free guide) and
  could follow a symlinked `AGENTS.md` outside the workspace. The whole
  marker-managed baseline surface is gone.
- **Blocked extractions no longer hot-loop.** A route-less provider parked jobs
  as blocked, and `scheduleNextWake()` then replaced the 5-minute probe with a
  ~100 ms retry (live-observed: 7.5 wakeups/s for 17 minutes, 15,052 audit rows
  = 97% of the table). The wake is now suppressed while the provider is blocked.
- **Usage telemetry counts only what the model receives.** `searchMemory`
  registered every matching candidate line as reuse, so one broad query bumped
  11 stage rows while showing 6 files and refreshed their retention window.
  Only the surfaced hits (and the rollout a MEMORY.md citation names) count.
- **Dormant stores drain.** Recovery was bound to the first live session of a
  store, so a workspace whose sessions had all ended kept an expired processing
  lease and pending jobs forever (live: one store with 1 expired-lease
  processing job, 2 pending, 1 blocked, zero extracted rows). A bounded sweep
  now drains every store root once a worker route is known.
- **CJK retrieval.** A Chinese sentence was one un-matchable token for the
  substring scanner; query terms now expand into adjacent two-character grams,
  and the first dynamic query with zero hits is audited
  (`adapter.dynamic_miss`) instead of failing silently.
- **Work-driven consolidation trigger.** A three-row pending batch, a pending
  row older than two hours, or an unapplied note bypasses the 6 h success
  cooldown (the failure backoff still applies); a successful run clears the
  stale `consolidation_auto_failed` marker.
- **Injected messages stop claiming a form they cannot satisfy.**
  `form: "recall"` only renders a platform recall body when the source also
  carries `references` (label/retainedMessages/omittedMessages/truncated); the
  summary block is opaque context and memcurio's own row renders it anyway.
- Removed the reserved-but-inert `pipeline.minUsage` knob (validated,
  persisted and documented, but never read by selection). Config files that
  still carry it keep loading; the key is ignored.
- Dynamic memory hits are derived from the injection budget (≈1 hit per 176
  tokens, clamped to 4–8) instead of a second hard-coded limit.
- Citation usage counts one unique rollout key once per call: naming the same
  memory both as a `rollout_summaries/<file>.md` entry and as its bare
  `host|sessionId` key no longer bumps `usage_count` twice.

### Removed

- **Pre-S0 workbench scaffold.** `client/types.ts`, `client/index.ts` and
  `tests/client-types.test.ts` are gone: they were never part of the built
  bundle (`client/entry.ts` is the only entry) and their client-side delta
  vocabulary had drifted from the shipped `client/ui/wire.ts`. The memory
  workbench (M0) will be built on the shipped store/transport;
  `client/README.md` now documents the shipped half only.

## [0.0.1] - 2026-09-16

First release of `@memcurio/dsh-plugin`, a memory and context-management plugin for the
DeepSeek Harness (DSH): the engine, the Cordis plugin and the browser half ship in one
package (developer preview). The durable memory pipeline (two-phase extraction and
consolidation over Markdown + SQLite, safe read-path injection, usage telemetry, full
audit trail) and the shipped browser half (Settings panel, the memory-injection rows for
both the message half and the system-prompt guide half, write toasts, six memory tool
rows, served over a same-origin snapshot + SSE route) are complete and tested. The full
memory workbench over the store remains the next milestone.

### Added

- **Durable memory pipeline** (per-workspace stores anchored under the DSH
  home): two-phase extraction/consolidation over Markdown + SQLite, safe
  read-path injection, usage telemetry with forgetting-window retention,
  full audit trail, ad-hoc notes, developer-preview dry-run discipline.
- **DSH host plugin**: session lifecycle wiring, six native memory tools,
  worker queue lanes with durable retries, automatic Phase-2 consolidation,
  promptware-injection scan + secret redaction on every write path.
- **Memory-workbench host half**: read services (search/status/usage/queue/
  audit/intent drafts), injection simulator (previews never count usage
  telemetry), delta projector, snapshot assembly, and a host bridge
  (event tags, audit-tail/job diffs, evidence source) gated by
  `config.hostBridge` (off by default).
- **Memory-workbench client half** (framework-free view model): nine-kind
  delta folds, evidence window, star bookmarks, read-only cross-store
  browsing, per-job queue semantics — verified by unit tests only until the
  S0 spike pins the real browser slots/transport.
- **Release mechanics**: committed `dist/` with drift check, `pack:check`
  allowlist, `prepare` artifact verification (no build on consumer
  machines), tag-driven GitHub Release shipping the packed
  `memcurio-dsh-plugin-<version>.tgz` with a `.sha256` sidecar; npm
  publishing is prepared (`publishConfig.access: public`) but disabled in
  the release workflow until a token/provenance decision is made — see
  `docs/operations.md`.

- **Settings panel (browser half)**: the package now declares `dsh.client`
  (`platform: "web"` + official client inject rows) and ships a prebuilt
  `lib/client.js` (esbuild bundle wrapped in the official
  `window.__ModuleLoader__.load({ id, factory })` shape; the only runtime
  require is the platform-seeded `react`). The panel registers the
  `settings.section` slot as "Memory/记忆": scope select, injection/tools/
  bridge toggles, token budget, provider/model route, per-field override
  badges with reset, bulk reset, and post-write verification (a resolved but
  unlanded host write reports failure instead of a silent success).
  `pack:check` now enforces the artifact shape; CI/release drift-check
  `dist/` and `lib/`.

- **`memcurio` settings namespace** (`@deepseek-ai/dsh-settings`): the plugin
  now hard-injects the DSH `settings` service and registers its namespace via
  `ctx.settings.installSection`, so users configure the plugin from the DSH
  Settings page — `scope`, `injectContext`, `registerTools`,
  `injectBudgetTokens`, `hostBridge`, `provider`, `model`. The profile config
  stays the composition base; the user layer persists to
  `<DSH home>/settings.yaml`. Injection toggle, budget, host bridge and the
  worker route apply live; `scope` applies to new sessions; `registerTools`
  applies at the next plugin apply (restart); `root` is read-only.

- `scripts/probe-dsh-profile.sh`: installs the packaged plugin into an isolated
  DSH profile and verifies the composed tree (`--dump-config`) carries the
  `memcurio` row; verified green against real DSH 0.1.5-rc.1 (boot still needs
  a Node.js runtime — the web app does not start under bun, with or without
  this plugin).

- **Guide row refined (v1.9.4)**: the row reads just "记忆指南 / Memory
  guide" and anchors immediately ABOVE the system-prompt card by mirroring the
  official `requestPromptAnchor` rule (turn start for a first step, step start
  otherwise, minus a hair) - the placement `dsh-chamber-mcp` gives its
  registered-tools row. The measured facts (characters, named tools) moved from
  the collapsed line into the expanded body's first line, so the closed row is
  a quiet one-liner.
- **System-prompt guide row (v1.9.2)**: the read-path guide moved into the
  system prompt in v1.9, which left that injection invisible - the transcript
  row only covered the injected `user/message`. A new derived row
  (`memcurio-guide-injected`, `client/ui/guide-row.ts`) now announces it the way
  `dsh-chamber-mcp` announces registered MCP tools: the harness's own
  `system/message` events are scanned for the section marker, the section is
  hashed, and ONE disclosure row is emitted when the hash changes (a constant
  guide yields at most one row per session, and nothing when the prompt carries
  none). It anchors a hair above the system-prompt card, uses the shipped
  disclosure geometry with the book mark leading, and expands into the injected
  guide text. Nothing is written into the session: a foreign private session
  event would make the stored log unopenable on 0.1.5 (no public append path
  can set `ignorable: true`), so the row is derived, never persisted.
- **Memory visibility surfaces (G5/G6)**: the **memory injection row** on
  the session transcript — an injected memory message reads
  "记忆注入 / Memory injection" (the plugin's own row, which shadows the
  shipped chat context cell and forwards every non-memcurio context node back
  to the shipped renderer), transient injection/write toasts, the `memcurio`
  Settings section (memory ON/OFF switch first row), and custom transcript
  rows for the six native memory tools. The main mark is an inline
  book-and-ribbon SVG, which also leads the memory injection row on the
  transcript; injection toasts use the platform context-injection glyph,
  inlined so the bundle still requires only `react`.
- **Authenticated memory transport**: `GET /memcurio/snapshot` (full-state
  read) and `GET /memcurio/events?session=<id>&after=<seq>` (SSE deltas with
  bounded replay) on `ctx.webServer`. The route carries its own guard — a
  required per-process token delivered through the boot payload
  (`globalThis.__MEMCURIO_UI__`), loopback peer, loopback `Host`,
  `Origin === Host`, `Sec-Fetch-Site`, no CORS headers, `no-store` — and
  the client falls back to 1–3 s polling with a degraded badge, or stays
  offline (never 403-looping) when the page has no token.
- **Per-store delta attribution**: every bridge delivery carries its store
  root, SSE streams only receive their own store's batches, frames carry the
  root, and the client re-checks it against its last snapshot.
- **Reconnect replay**: a bounded frame history answers
  `?after=<lastSeq>` on reconnect (replay before subscribe); a cursor older
  than the buffer receives a `snapshot-ready` marker instead of a silent gap.

### Fixed

- **Extraction survives the injection scanner's false positives**: a Phase-1
  reply that trips the scanner is now REPAIRED line-wise (the offending lines
  are dropped, the rollout survives) instead of being rejected into a dead
  letter; a reply that is still unsafe after repair (whole-reply promptware)
  keeps failing. Dead jobs already killed by the old policy gate are requeued
  once at plugin start.
- **Malformed/truncated extraction replies no longer dead-letter**: the JSON
  reader escapes raw control characters inside string literals and closes a
  reply truncated at the output-token cap before giving up.
- **Injection text compacted (v1.9.1)**: the dynamic block lost its per-line
  `[memcurio] ` prefix (one `Memory hits:` header instead), every hit is
  whitespace-collapsed and capped at 220 chars with `…`, and the summary block
  uses a one-line label with `<<<MEMORY_SUMMARY` / `>>>MEMORY_SUMMARY`
  delimiters instead of two `=========` banner lines. The read-path guide was
  cut from 3,387 to 1,554 chars with the same contracts. The engine and the
  workbench simulator share one formatter, so previews cannot drift.
- **The read-path guide is a system-prompt section now (v1.9)**: how-to-use
  instructions no longer ride an injected user message. The plugin registers
  `memcurio-read-path` through `ctx.systemPrompt.section()` (order 2950, next
  to the tool schemas), so the model still learns the decision boundary, the
  quick-pass budget, the citation contract and the write gate — but the
  transcript carries memory **data** only.
- **Injected messages carry memory content only**: with the guide prompt-side,
  `renderStaticContext()` is the sanitized summary block alone, and a store
  without a summary injects nothing at all (no guide, no placeholder). The
  summary latch still tracks content changes, so a summary arriving later is
  injected once.
- **No filesystem paths in model-facing text**: the guide and the
  `memory_context` result name the memory tools (`memory_search`,
  `memory_list`, `memory_read`, `memory_remember`) instead of absolute store
  paths — the store lives outside the session workspace, and the model must
  never be pointed at it. Citation locators are entry ids (they feed usage
  telemetry), not paths.
- **Skilled dynamic retrieval**: the pre-step query is no longer the raw
  message dump — it is built from the newest non-plugin user text with code
  fences, URLs, paths, markup and stop words removed (`src/core/query.ts`).
  Search now scores in two passes with inverse document frequency, adds a
  phrase bonus for multi-word queries, drops duplicated lines, and caps hits
  per entry so one verbose file cannot fill the window.
- **Store bootstrap runs on the first session, not on a startup list**: the
  session list is empty while a plugin applies, so the startup drain (and the
  policy dead-letter requeue) never ran in the live composition. Each store is
  now bootstrapped once, when its first session is adopted.
- **The retire budget reserves room for consolidation**: a slow extraction
  drain used to consume the whole 30 s retire budget, after which the runtime
  abort disposed the adapter before the automatic Phase-2 pass could run —
  consolidation was starved on every event. The drain now stops at a deadline
  leaving a 10 s slice for consolidation.
- **Every session keeps its store binding**: the browser transport resolved a
  session through a last-writer-wins root map, so a subagent (or a second tab)
  in the same workspace evicted the GUI's binding and its snapshot 404ed. The
  bridge now maps every registered session id to its root.
- **A missing worker route no longer parks the queue**: the channel falls back
  to the last route observed anywhere in the process (a session that retires
  during shutdown now keeps a usable route) and the engine re-probes a blocked
  provider every 5 minutes instead of waiting for a host event.
- **Automatic consolidation falls back to the rule provider** when the LLM
  provider fails (no tool call parsed, an edit citing a missing artifact, an
  aborted call): unapplied notes and stage-1 rows still land, audited as
  `consolidate.fallback`, and the next cycle tries the LLM again.
- **Unapplied ad-hoc notes are searchable** before consolidation (marked
  `pending` in the hit shape) instead of being invisible until the next
  Phase-2 run; applied notes are skipped to avoid double-reporting.
- **Settings overrides now clear themselves**: writing a field back to its
  composition base — the memory switch toggled off and on again, the worker
  route typed back to the base pair, the budget returned to its base — now
  clears the user-layer override instead of pinning an equal value, so the
  "overridden" badge and its reset action disappear on their own.
- **The worker route row no longer crams**: its control group (provider input,
  model input, Save button) occupies its own full-width line beneath the label
  and note, instead of squeezing the note into a narrow column beside it.

### Changed

- The workbench snapshot reports the real deployment knobs (`settings.maxInjectTokens`
  from the store config, `settings.consolidationCooldownMs` from the engine's
  automatic-consolidation window) instead of placeholders, and a blocked
  `memory_read` no longer counts as memory reuse (usage is registered only when
  the injection scan lets the content through).
- The browser half gained an automated regression net (`tests/client-panel-render.test.ts`):
  the shipped `lib/client.js` is loaded through the official module-loader
  contract, its `settings.section` registration and `hooks`→`useFace` seat are
  asserted against the framework's own conversion rule, and the panel is
  rendered with real `react-dom` under jsdom (repaint on transport
  notification, atomic route-pair writes, readOnly-while-busy, locale-keyed
  failures).

- **Aligned to DSH `0.1.5-rc.1`** (current npm `latest`; peers now
  `^0.1.5-rc.1`). The only contract delta encountered was
  `assistant/message` events carrying a required `stream` record; plugin
  runtime code was already compatible. The rc.1 spike ledger (removed from
  the tree by the 2026-09-16 docs reorg) was verified against `0.1.2-rc.1`
  artifacts and must be re-checked on the run target.
- Test fixtures that encoded absolute August dates in the 30-day usage
  window were made clock-independent (`daysAgo()` helpers), so the suite no
  longer rots as wall-clock time advances.

- **The memory switch row carries no explainer (v1.9.3)**: the Settings row for
  memory injection is label + switch only. The `injectContextNote` line
  (per-step evaluation / unchanged content is not re-injected) was removed from
  both dictionaries and from the row; the injection semantics are implementation
  detail, not panel copy. The panel assertion follows.
- **Memory tool rows always lead with the book mark**: running, settled, error
  and interrupted states all render memcurio's book; a terminal state only
  colours the mark (error/warning token) instead of swapping it for the shipped
  status dot, so all six native memory tool rows carry one leading glyph.
- **Static injection is guide-first**: every new session receives the read-path
  guide; the `memory_summary.md` block is appended only when the store
  actually has a summary, so an empty store no longer puts the
  `(memcurio memory not consolidated yet)` placeholder into the model's
  context (the preview API reports the summary as an empty string).
- `hostBridge` is now always **on**: the browser transport sink ships with
  the package and the switch was removed from Config, the `memcurio`
  settings namespace and the Settings panel (no supported scenario needs it
  off).
- The session header carries no memcurio surface: the injection indicator is
  kept as the workbench status surface but is deliberately not registered.

### Known limitations (this release)

- The full memory **workbench** over the store is not assembled yet: the shipped browser
  half covers the Settings panel, the memory-injection rows (message half and
  system-prompt guide half), write toasts and the six tool rows; the workbench
  view-model, host bridge and delta protocol are delivered as verified pre-work.
- DSH itself is a developer preview: every DSH upgrade needs a peer-contract re-check
  (currently aligned with `0.1.5-rc.1`).
- Git remote push, node:sqlite-driven test runs and npm publish require an environment
  with credentials / a node >= 22.13 binary (CI covers them).
