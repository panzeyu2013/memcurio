# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

## [0.0.1] - 2026-09-11

First release of `@memcurio/dsh-plugin`, a memory and context-management plugin
for the DeepSeek Harness (DSH). Developer preview: the durable memory pipeline
is complete and tested; the memory-workbench UI assembly and its transport
channel are staged behind an S0 spike in a real DSH Web instance.

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
  `docs/RELEASE.md`.

### Added (settings panel)

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

### Added (settings surface)

- **`memcurio` settings namespace** (`@deepseek-ai/dsh-settings`): the plugin
  now hard-injects the DSH `settings` service and registers its namespace via
  `ctx.settings.installSection`, so users configure the plugin from the DSH
  Settings page — `scope`, `injectContext`, `registerTools`,
  `injectBudgetTokens`, `hostBridge`, `provider`, `model`. The profile config
  stays the composition base; the user layer persists to
  `<DSH home>/settings.yaml`. Injection toggle, budget, host bridge and the
  worker route apply live; `scope` applies to new sessions; `registerTools`
  applies at the next plugin apply (restart); `root` is read-only.

### Added

- `scripts/probe-dsh-profile.sh`: installs the packaged plugin into an isolated
  DSH profile and verifies the composed tree (`--dump-config`) carries the
  `memcurio` row; verified green against real DSH 0.1.5-rc.1 (boot still needs
  a Node.js runtime — the web app does not start under bun, with or without
  this plugin).

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
  runtime code was already compatible. The rc.1 spike ledger in
  `docs/design/` was verified against `0.1.2-rc.1` artifacts and must be
  re-checked on the run target.
- Test fixtures that encoded absolute August dates in the 30-day usage
  window were made clock-independent (`daysAgo()` helpers), so the suite no
  longer rots as wall-clock time advances.

### Known limitations (this release)

- The memory **workbench** UI is not yet assembled: the shipped browser half is
  the Settings panel only; the workbench view-model, host bridge and delta
  protocol are the verified pre-work, and its transport channel is still
  unselected. `docs/design/s0-spike-plan.md` covers the real-environment spike.
- Git remote push, node:sqlite-driven test runs and npm publish require an
  environment with credentials / a node >= 22.13 binary (CI covers them).
