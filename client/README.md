# @memcurio/dsh-plugin — browser client half

This directory carries TWO halves with different maturity:

1. **Shipped: the Settings panel and the memory visibility surfaces** (`entry.ts`,
   `settings/*`, `ui/*`, built to `lib/client.js`) — the `dsh.client` browser half that registers the
   `memcurio` Settings section (which owns the memory ON/OFF switch as its first row, writing
   `injectContext`, and wears the shipped settings vocabulary as COMPACT rows — one line per
   setting (text left, control right, description folded in), the worker route stacked on its own
   full-width control line with an explicit Save button (label + note keep the row's first line), an icon-only status dot in the title row (green ready /
   grey idle / red error, the chamber-mcp convention), 34px inputs, capsule actions,
   status/badge tokens), the injection/write toast host, the "记忆注入 / Memory
   injection" transcript row for injected memory (book mark leading; `ui/context-row.ts`, which shadows the shipped
   `conversation.chat.node` `context` cell at priority -1 and forwards every non-memcurio context
   node back to that shipped renderer), the "记忆指南 / Memory guide" row for the SYSTEM-PROMPT half
   of the injection (`ui/guide-row.ts`: a derived `memcurio-guide-injected` node built from the
   harness's own `system/message` events - section marker scanned, hashed against the nearest
   predecessor Context, so a constant guide yields one row per session and nothing is written into
   the session; anchored immediately above the system-prompt card by mirroring the official
   `requestPromptAnchor` rule, the `dsh-chamber-mcp` registered-tools pattern; the collapsed line
   is mark + title, and the expanded body opens with the measured facts), and
   one keyed `tool.call.toolview` row per native memory tool. The session header carries no memcurio
   entry (v1.7 product instruction): `ui/injection-indicator.ts` is the reserved workbench status
   surface and is deliberately NOT registered. The settings-nav row carries the book
   mark through the `settings.action` probe, an interaction-level watcher and the section mount,
   plus the `[data-memcurio-nav]` stylesheet rules
   (`settings/nav-mark.ts`), because the shell owns every section icon. It requires only the platform-seeded
   `react`; discovery rides `package.json` `dsh.client` + `exports["./client"]`; `pack:check` validates the artifact.
   Controller logic is unit-tested (`tests/client-settings.test.ts`, 23: atomic route-pair writes, atomic resetAll,
   base-aware resets, listener containment, single-subscription relatching, faceHook seat contract) and the
   renderer-facing half is covered by a regression net (`tests/client-panel-render.test.ts`, 8): the SHIPPED
   `lib/client.js` is executed through the official `__ModuleLoader__` contract, its registration is inspected in a
   real cordis context, the `hooks`→`useFace` conversion is asserted with the framework's own
   `standardHookPropName`, and the panel is rendered with real `react-dom` in jsdom (transport-driven repaint,
   override badges, loading/unavailable faces, switch + bulk-reset interactions, atomic route pair, readOnly while
   busy, locale-keyed failures); `tests/ui-render.test.ts` renders the indicator's active and injection-off faces
   against the settings seat (disabled state hides the counts and labels the preview as history), one memory tool
   row, and the injected-memory context row (own title + expansion, delegation to the shipped context row for
   foreign producers, no delegation for memcurio nodes); `tests/client-nav-mark.test.ts` pins the settings-nav marking contract (match, idempotence,
   unmark) and the bundle test renders the shipped probe component against the shell's row shape. Real-browser
   rendering, slot governance and the `settings.yaml` round trip still
   were verified in a real DSH Web on 2026-09-15 (isolated profile: bundle execution, boot-token transport,
   `settings.section` render, verified on the isolated DSH Web on 2026-09-15); the session-header
   entry still needs a live conversation. `client/entry.ts`'s code is exercised through the built bundle rather than
   imported directly, so it does not appear in the coverage table.
2. **Pre-S0 scaffold: the workbench view-model** (`types.ts`, `index.ts`) — the section below documents it.

> Workbench status: **STRUCTURAL SCAFFOLD + SPIKE-QUESTION SPEC — not yet wired, not yet loadable in a real DSH Web. (The Settings panel above IS shipped; the workbench below is not.)**
> Created ahead of the S0 spike (design [ui.md](../docs/ui.md) §11-S0). Every claim about the
> DSH client-module machinery is marked UNVERIFIED-until-spike and was grounded in the read-only upstream npm install
> listed in [§d](#7-d-upstream-docs-read-this-scaffold) — the same rc.1 install the design declares as its reference
> version (§13.10). Nothing in the WORKBENCH SCAFFOLD (`types.ts`/`index.ts`) imports `@deepseek-ai/*`, touches React, or runs a UI; the shipped Settings panel (`entry.ts`/`settings/*`) does use React from the platform seed.

Scope of the S0 milestone this scaffold feeds (design §11-S0): prove in a real DSH Web that (1) a third-party
`dsh.client` bundle can reach a UI slot, (2) a host→browser push path exists for memcurio deltas, (3) the client
bundle builds/loads per the `lib/client.js` convention, and (4) a minimal placeholder workbench opens and receives
one pushed event end-to-end.

---

## 1. Files in this scaffold

| File | Role |
|---|---|
| `client/entry.ts`, `client/settings/*`, `tests/client-settings.test.ts` | SHIPPED Settings panel (see the top of this file). |
| `client/types.ts` | Local structural vocabulary: `MemoryClientApi` bridge, delta union (nine kinds, projector-aligned), snapshot payload, `WorkbenchView`, stores/entries/usage/queue/audit/settings shapes, `MemoryUiFactory` seam. Zero external imports. |
| `client/index.ts` | Pure view-model state machine `createWorkbenchModel(api)` — no DOM/framework. `registerFactory()` S0 stub. |
| `client/README.md` | This record: wiring plan (UNVERIFIED), S0 spike checklist, S0 acceptance, upstream docs read. |
| `tests/client-types.test.ts` | Dependency-free `bun:test` suite (FakeApi inline implementing `MemoryClientApi`): initial state, select, setStore, refresh fold + error path, applyDelta per-kind fold / origin-seq dedupe / timeline cap 500, simulate text hand-off, registerFactory seam. |

Constraints honored: no existing file modified, no `bun install`, repo `package.json`/`tsconfig.json` untouched; the
root tsconfig (`rootDir: src`) intentionally does not include `client/`, so typechecking is standalone (see
[§e](#8-e-verification-performed)).

## 2. Model contract (`client/index.ts`)

`createWorkbenchModel(api: MemoryClientApi)` returns:

- **`state: WorkbenchState`** — immutable-by-convention snapshot, rebuilt per operation. Contains: `view`
  (default `"overview"`), `stores`, `currentStore`/`currentStoreId` (session-resolved store), `browsingStoreId`,
  optional `browse` (last per-store payload) / `browseError`, `injection` preview fields, `persistence` entry
  cache (`{entries, stale, loadedAt}`), `queue` counts+jobs, `consolidation` radar, `usage`, `receipts` (recent,
  capped 100), `evidence` window (partId/session-deduped, capped 200), `bookmarks` (pure-UI ⭐ set),
  `settings` read-only summary, `realtime` (`{mode: "push"|"polling", degraded}`), `timeline`
  (append-only, capped 500), `lastSeq`, `lastRefreshAt`, `lastError`.
- **`select(view)`** — tab switch over the six `WorkbenchView` values (design §7.7).
- **`setStore(storeId)`** — read-only cross-workspace browse (design §7.6): validates against `stores`
  (RangeError otherwise), clears store-scoped caches (persistence entries, usage, consolidation radar) so stale
  rows of the previous store are never shown as the new store's; injection stays bound to the current session
  store; timeline/receipts survive; `currentStoreId` (write target) is never changed.
- **`toggleBookmark(entryId)`** — ⭐ pure-UI bookmark (client-side set only; never sent to the host; memory
  deletion stays a conversation flow).
- **`browse(storeId)`** — optional per-store refill via `api.browseSnapshot` — S0/host decision (§7.6): clears
  then folds the per-store payload into the browsing caches; absent bridge method (or the current store) degrades
  to `setStore`'s clear-only behavior; RangeError on unknown id; a rejecting read lands in `state.browseError`,
  never thrown.
- **`refresh()`** — calls `api.snapshot()`, folds the full snapshot (§8.3 semantics); failures are recorded in
  `state.lastError`, never thrown. While `browsingStoreId` names another store, the current-store snapshot does
  NOT overwrite the browsing caches (persistence/usage/consolidation stay cleared until the user switches back,
  or `browse()` refills them when the host bridge provides per-store reads — S0 decision).
- **`applyDelta(delta)`** — folds one projector delta. Dedupe: an **origin `seq`** is dropped as
  `{status: "duplicate"}` when already applied (unordered-channel guard, §8.3); the dedupe window is bounded
  (`ORIGIN_WINDOW = 2048` — older seqs are evicted so the set cannot grow for the tab lifetime); every applied
  delta gets one **locally assigned monotonic seq** and appends one timeline event (capped at 500). Kind folds:
  `snapshot-ready` → full fold (keeps view/timeline/seq); `inject-updated` → injection preview; `usage-tick` →
  **increment** semantics (`count` added onto the last snapshot's absolute stat; self-healing on next snapshot);
  `queue-updated` (per-job jobId/status/attempts) → folds the job onto the snapshot queue state and
  recomputes counts (completed removes the job); `memory-list-updated` (`updateKind: rollout|consolidation|note`) → replaces
  persistence rows when `entries` are carried, else marks the cache `stale`; `receipt` → prepends (capped 100);
  `evidence` → folds into the evidence window (session+partId dedupe, cap 200) + timeline node; `citation` →
  timeline node only; `compaction-prune` → drops this session's shadowed evidence parts + marks persistence
  stale (both suppressed while browsing another store).
- **`simulate(query)`** — trims the query, runs `api.simulate`, and returns the **plain-text rendering of the api
  result** (`formatSimulationResult`): deterministic, DOM-free. *S0 decision point: text hand-off vs structured
  `SimulateResult` for the real workbench.*
- **`registerFactory(factory)` / `registeredFactory()`** — module-local slot only.

> S0: to be connected to the DSH client-module loader contract (factory registration, lazy materialization) after
> spike verification.

## 3. Bridge contract (`client/types.ts`) — derived from design §5.1/§8

`MemoryClientApi` has deliberately **no write method** (design §6.1 iron rule); every text returned to the browser
is assumed server-side redacted/truncated (§5.2/§9.1). Method → design §5.1 service mapping:

| Bridge method | Design service | Result shape |
|---|---|---|
| `snapshot()` | §8.3 full snapshot over §5.1 faces | `SnapshotPayload` |
| `search(query, {topK, storeId})` | `memory.search` | `SearchResult` (hits + blockedCount, truncated) |
| `listStores()` | `store.list` | `StoreBrief[]` |
| `resolveCurrent()` | `store.resolve` | `ResolvedStore` (+ isolation warnings) |
| `simulate(query)` | `inject.simulate` | `SimulateResult` (top-8 hits, blocked, budget) |
| `queue()` | `queue.list` | `QueueState` |
| `consolidation()` | `consolidation.state` | `ConsolidationState` (cooldown radar) |
| `audit(query?)` | `audit.list` | `AuditPage` |
| `usage()` | `usage.list/byKey` | `UsageReport` |
| `intentDraft(kind, ref)` | `intent.draft` (no-persist wording) | `IntentDraft` |
| `browseSnapshot?(storeId)` | per-store read (§7.6; optional — S0/host decision) | `BrowseSnapshot` — absent ⇒ `browse()` degrades to clear-only |

Delta union mirrors the §8.2 rows 1–8 + the §8.3 snapshot-ready marker — nine kinds total:
`snapshot-ready` / `inject-updated` /
`usage-tick` / `queue-updated` (per-job, projector-parity jobId/status) / `memory-list-updated`
(updateKind: rollout|consolidation|note) / `receipt` /
`evidence` / `citation` / `compaction-prune`. Exact payload shapes remain spike-verification material; the review
revision aligned field names (`count` increments, `updateKind`, `itemKind`) with src/services/projector.ts.

### Adapter-mapping scope (S0 transport adapter; acceptance-round record)

The following host→client wire differences are INTENTIONALLY unmapped until the S0 transport adapter exists
(design §8.4 "delta 过滤与快照标记映射留给传输适配器"). Each is a stated decision point, not an accident:

- **inject-updated**: host delta is flat (`sessionId/workdir/staticText?/dynamicText?/budgetTokens?/duplicate`);
  the client folds a full `InjectionState` — the adapter must recompose `staticText↔staticSummary/readGuide`,
  `budgetTokens↔budget{used,max}`, decide a consumer for `duplicate` (or drop it), and merge instead of replace
  so readGuide/budget survive partial deltas.
- **receipt**: host delta is an audit row (`time/action/object?/detail`); client requires `AuditReceipt`
  (`id/at/ok/target/…`) — adapter synthesizes id/ok, renames `time→at`, classifies open engine labels into the
  closed action union (`…|other`). The snapshot face already pre-synthesizes parity fields.
- **snapshot-ready**: host emits a MARKER (client refetches); client types carry the payload inline — the
  adapter either materializes the payload or the model gains a marker→refresh() path.
- **usage key-space**: snapshot `byKey` keys are artifact filenames, citation ticks are rollout keys, tool-hit
  ticks are workspace-relative paths; the client "self-healing fold" only merges after adapter key
  normalization. `UsageReport.recent` is client-required but absent from the snapshot face — the adapter must
  merge or the field becomes optional.
- **consolidation radar naming**: client `lastAt/lastOk/failedAt/cooldownRemainingMs` vs host
  `{last,failed}+candidateRolloutIds`; cooldownRemainingMs needs derivation — adapter renames/synthesis.
- **evidence backfill**: the bridge exposes `evidenceSnapshot(sessionId)` but the snapshot payload has no
  evidence face and the API no evidence read — in polling mode the evidence window is live-delta-fed only; the
  adapter/bridge should emit catch-up or expose a read (S0).

---

## 4. (a) Intended package wiring (UNVERIFIED-until-spike)

SUPERSEDED by round 26 (kept for the S0 record): the shipped shape is
`dsh.client = {platform:"web", inject:["@deepseek-ai/dsh-client-locale","@deepseek-ai/dsh-client-ui-renderer","@deepseek-ai/dsh-client-ui-settings"]}`,
`exports["./client"] = {"default":"./lib/client.js"}`, `files: ["dist","lib","README.md","LICENSE","cordis.patch.yml"]`,
and the bundle is built by `scripts/build-client.ts` (esbuild; externals = the frozen platform seed table; the only runtime
`require` is `react`). The loader parser reads only `.default` — a `types` condition is unnecessary at runtime.

Original pre-spike hypothesis (historical):

```jsonc
// package.json — inside the existing @memcurio/dsh-plugin declaration, UNVERIFIED until S0:
"exports": {
  ".": { /* existing */ },
  "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" }
},
"dsh": {
  "client": {
    "platform": "web",
    // Official packages name their client-module dependencies here (rows the
    // loader must register/materialize before this bundle). Memcurio likely
    // needs NONE until the spike picks UI dependencies (locale, slots…).
    "inject": []
    // "external": [] — only exact non-baseline specifiers, e.g. "<pkg>/client".
    // "immediately": false — lazy materialization is the default.
  }
},
"files": ["dist", "lib/client.js", /* … */]
```

Key observations that drive the spike (each marked with its evidence file above):

1. **`dsh.client.inject` vs `dsh.client.external`**: official packages declare dependencies as **`inject`
   package rows**; only exact *non-baseline* specifiers go to `external`. The dsh-client-modules README's loose
   wording ("under `dsh.client.external`") does not match the installed package census — the parser accepts both
   (`lib/index.js` `parseDshClient`) but the graph-ordering pass only walks `external`; injected rows are
   registered before consumers on the browser side (`lib/client.js`).
2. **The bundle is a Loader-registration artifact, not plain ESM**: published bundles open with
   `window.__ModuleLoader__.load({ id, factory: (require) => … })`; the factory's exports are the module
   (official exports: `apply(ctx)` client plugin + `inject: string[]` + components). `exports["./client"]`
   resolves the artifact; `lib/client.js` is the convention. Our repo currently builds `dist/` with tsc (plain
   ESM) — a bundling step for the client artifact must be added (official tooling: tsdown). This is the
   **biggest build-side unknown** for S0 along with HMR.
3. **`PLATFORM_MODULES`** seeds react (and `react/jsx-runtime`) + Cordis + static UI libs (ui-goal's bundle
   requires `@deepseek-ai/dsh-client-ui-primitives` without declaring it). Exact key set lives in the shell source
   (apps/web), not in the npm install → verify before relying on any non-baseline require.
4. Everything else in a third-party bundle must be `inject`-declared rows that exist in the same composition, or
   composition rejects it ("missing suppliers, self-requests, and synchronous request cycles").
5. Our `ClientFactory`/`MemoryUiFactory` seam (`(api) => {mount(root); dispose()}`, §types.ts) is a **placeholder
   description of the loader expectation**, deliberately generic and documented unverified: the observed official
   contract is a Cordis-style `apply(ctx)` client plugin. The spike must map one onto the other (Q3 below) before
   any DOM work.

---

## 5. (b) S0 spike question checklist

Each item: the open question → my read from the docs above → what to verify in the real DSH Web.

- **Q1 — Which UI slot can a third-party bundle fill for the ONE title-bar entry (design §3.3/§7.7)?**
  Read: no installed doc mentions any title-bar/chrome slot ("title bar" has zero matches across all client
  READMEs/type declarations). The conversation chrome exposes `conversation.session.header` with
  `.lineage/.actions/.utilities` child slots (ui-conversation `contract/slots.d.ts`), and `settings.section` is a
  *settings page* slot — neither is obviously an app-level title-bar overlay. The header-actions slots are the
  best candidate for a per-session "记忆" button. Verify: (a) whether a third-party bundle's `apply(ctx)` runs
  under the official composition at all (the memcurio node plugin is an enabled Loader entry → its `dsh.client`
  row should be composed; confirm), (b) whether `ctx.slots` accepts third-party entries for
  `conversation.session.header.*` (or any real title-bar slot), (c) fallback surface: design v1.2/v1.3 demoted `/memory`-as-UI-opener to an open item (no verified
  client-side command→UI mechanism at rc.1) — verify whether any command→UI path exists at all; else
  `conversation.view` tab or settings deep-link carry the fallback, (d) settings.section registration as the
  *internal* Settings tab if we keep it inside the workbench only.

- **Q2 — Is the host↔browser bridge open to third parties (design §8.1/§12 #2)?**
  Read: mostly **no for memcurio's own namespaces/events** — `ctx.remote.<ns>` capabilities are mounted by the
  *official* `dsh-api-remotes` assembly from build-time imports ("the Client does not discover the Host's active
  Services or Remote definitions at runtime"), and forwarded events are an explicit allowlist that is "the legal
  key set of `ctx.remote.$on`". A memcurio `ctx.remote.memcurio.*` or a forwarded memcurio event therefore needs
  an **upstream change** (design's "评估上游申请"). Verify empirically in S0, then choose: (a) upstream request,
  (b) memcurio host half exposes its own endpoint/SSE (auth + origin questions against the webserver), or
  (c) polling 1–3 s as the accepted secondary path (§8.3) with the degraded badge.

- **Q3 — Exact factory/module export shape and mount lifecycle.**
  Read: registration artifact = `window.__ModuleLoader__.load({id, factory(require)})`, executed bundles only
  register ("module-body side effects … run at materialization"); resolution order platform seed → memoized →
  boot-graph rows → registered factories; `<id>/client` and the bare id resolve to the same exports; official
  client modules export `apply(ctx)` + `inject: string[]` + components and are applied by the client root
  (observed ctx services: `ctx.slots`, `ctx.effect`, `ctx.locale`, `ctx.remote.*`, `ctx.sessions`…). Verify: who
  calls `apply` and with which ctx, whether `dsh.client.immediately` matters for us, and how our
  `MemoryUiFactory` seam should be reconciled (likely: the client plugin's `apply(ctx)` builds the bridge adapter
  and mounts the workbench UI).

- **Q4 — PLATFORM_MODULES baseline: which externals are safe?**
  Read: table includes React, Cordis and static UI libraries; react + `react/jsx-runtime` + at least
  `@deepseek-ai/dsh-client-ui-primitives` demonstrably resolve without an inject row (ui-goal bundle); `cordis` in
  official peerDeps is `@deepseek-ai/cordis ^4.0.2`, react is 18.x in official devDeps. Verify the full frozen key
  list from the shell source; only then decide whether the future workbench may require `react` freely or must
  inject rows for anything else.

- **Q5 — Build expectations.**
  Read: host serves built bundles — `exports["./client"]` must exist and the artifact must be built before launch
  (loud activation failure otherwise); artifacts are served as revisioned combo URLs under `/plugins`; source maps
  are Indexed Source Map v3; HMR replaces one changed row with a revisioned one-resource combo (`dsh-client-hmr`
  drives `invalidate`/`prefetch` on `rebuilt()`). Verify: the memcurio build step that emits the loader-registration
  artifact (`lib/client.js` convention), interplay with the repo's committed-`dist` discipline, and the HMR dev
  loop (design §12 #4).

- **Q6 — What does the memcurio `inject` list need to contain, and do official client packages accept third-party
  consumers?**
  Read: inject rows must exist in the composition and precede their consumer; 47/47 official packages only inject
  other official packages. Verify: whether a third-party package may inject official rows (locale/slots/ui-shell)
  and what happens when a profile enables memcurio without the official web preset.

- **Q7 — Slot typing outside the monorepo.**
  Read: official packages augment `@deepseek-ai/dsh-client-ui-slots` (`declare module` SlotMap merges) for typed
  slot contributions — but that package is **absent from the npm install** (present only as a devDependency of
  official packages). Verify whether third parties can type slot entries at all, or whether runtime string-key
  registration is the only viable path; likewise locale-namespace map augmentation.

- **Q8 — Timeline back-link "jump to session" capability (design §12 #3).**
  Read: nothing in the installed docs promises a third-party session-positioning action. Verify the
  session-controller/workspace-controller client faces for a navigation verb; fallback = textual session/message
  references (already the design's accepted fallback). Related: confirm whether the host projector attaches a
  monotonic origin `seq` to deltas (the model dedupes on it when present; an ordered channel needs nothing).

- **Q9 — Everything else ambiguous.**
  (a) The client-authoring AGENTS.md is not shipped in the npm install — pull from the harness repo at the rc.1
  tag if needed. (b) Real-time polling ownership: UI timers vs model timers, and refresh cadence targets.
  (c) i18n: official packages call `ctx.effect(() => ctx.locale.register(NS, {…}))` inside `apply`; memcurio UI
  copy must follow the DSH client language convention (design §13.9) — decide the copy pipeline only after Q3.
  (d) Confirmed *behavioral* gap: whether composition includes third-party client rows only when the memcurio
  plugin is an enabled Loader entry of the running profile, and how "distinct active Loader sources resolving to
  one package name" conflicts would surface.

## 6. (c) S0 acceptance checklist (from design §11-S0)

1. Title-bar entry question answered with evidence: a third-party slot exists (and memcurio fills it) **or** the
   `/memory` fallback is decided; the chosen entry opens the placeholder workbench inside the real DSH Web.
2. Host↔browser path decision recorded (remotes-equivalent / upstream request / polling); **one host event pushed
   to the browser end-to-end** and folded by `applyDelta` in the placeholder.
3. Client bundle build stands: `exports["./client"]` artifact (`lib/client.js` convention) builds, registers via
   the loader, serves under a revisioned `/plugins` combo; `dsh.client.inject`/`external` lists validated against
   the composition; HMR dev flow (or documented fallback) established.
4. S0 report produced; design §3/§8/§12 updated with verified facts; UNVERIFIED marks in this README and in
   `client/types.ts` resolved; this scaffold's model contract reconciled with the real `apply(ctx)`/bridge shapes.



## 7. (d) Upstream docs read (this scaffold)

All under `$A = <DSH source checkout>/node_modules/@deepseek-ai/` — recorded against DSH npm **0.1.2-rc.1**
(target upgraded to `0.1.5-rc.1`; re-verify at S0)
install (design §13.10 reference version):

1. **`$A/dsh-client-modules/README.md`** (en) — the module system: `dsh.client` declaration (`platform: 'web'`,
   `./client` bundle export, externals), host scans enabled Loader entries → boot graph → bundles served over
   `/plugins`, lazy factory registration, `PLATFORM_MODULES` seed table, `lib/client.js` build convention
   ("the host serves built client bundles, so `pnpm run build` must have produced each `lib/client.js` before
   launch; a missing bundle fails activation loudly"), HMR via `rebuilt()`.
2. **`$A/dsh-client-modules/lib/index.js`** (node half) — `parseDshClient()` reads **both** `dsh.client.inject`
   and `dsh.client.external` plus `dsh.client.immediately`; `clientExportOf()` resolves `exports["./client"]`
   (string or `{default}`); combo URLs `/plugins/??<id>/client.js,…&rev=…`; graph ordering walks `external`
   entries only (`orderByModuleGraph`, "a requested package row must precede its consumers").
3. **`$A/dsh-client-modules/lib/client.js`** (browser half) — resolution order: platform seed table → memoized
   records → boot-graph rows → registered factories; "register each injected package and unresolved dynamic
   request before its consumer"; `apply(ctx)` provides `ctx.modules`.
4. **`$A/dsh-client-ui-goal/package.json`** — the real `dsh.client` shape: `{platform: "web", inject: [7 official
   packages]}`, no `external`; `exports["./client"]` → `lib/types/client/index.d.ts` + `lib/client.js`; `files`
   ships `lib/client.js`; `bundle: tsdown`; react **^18.2.0** devDeps, peer `@deepseek-ai/cordis ^4.0.2`.
5. **`$A/dsh-client-ui-goal/README.md` + `lib/types/client/index.d.ts`** — client plugin contract: exported
   `apply(ctx: ClientContext): void` + `export declare const inject: string[]` ("Required services …");
   mutations ride `ctx.remote.goals.*`; state arrives by projection, not by a store.
6. **`$A/dsh-client-ui-goal/lib/client.js`** — published bundle head: `window.__ModuleLoader__.load({ id, factory:
   (require) => { … return module.exports; } })`; requires `react`, `react/jsx-runtime`, and
   `@deepseek-ai/dsh-client-ui-primitives` — the last is **not** in its `inject` list, i.e. it must be answered by
   the `PLATFORM_MODULES` static seed; exports end with `apply`/`inject`/components.
7. **`$A/dsh-client-ui-settings/README.md`** — canonical settings slot contract: `settings.trigger/header/close`
   (chrome), `settings.action`, **`settings.section`** ("one page per feature"), `settings.plugins.tab`,
   `settings.onboarding`; the base injects the `remote` service with its `settings` namespace.
8. **`$A/dsh-client-ui-settings-general/lib/client.js`** — the settings shell consumes the ledger:
   `ctx.slots.entries("settings.section")`, `ctx.slots.subscribe("settings.section", …)`,
   `ctx.slots.getVersion("settings.section")`, `renderSlot("settings.section", …)`.
9. **`$A/dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts`** — the conversation chrome slot tree:
   `conversation.session.header` with children `conversation.session.header.lineage|actions|utilities`, plus
   `conversation.input.dock`, `conversation.chat.node`, `conversation.hero.*`, `conversation.view` etc. Registration
   pattern (from ui-goal's bundle): `ctx.slots.inject(<slot>, () => ctx.slots.register({name, id/key, order,
   locale, inject: (sessionId) => face}, Component))`.
10. **`$A/dsh-api-remotes/README.md`** — the bridge openness facts: the Client "mounts each contribution through
    `ctx.remote.$mount()`"; "The capability set is fixed by explicit build-time value imports; the Client does not
    discover the Host's active Services or Remote definitions at runtime"; forwarded events are an explicit
    allowlist (`API_REMOTE_FORWARDED_EVENTS`) that is "the legal key set of `ctx.remote.$on`"; "Additional
    capabilities require an explicit `/remote` value import and mount in this assembly."
11. **`$A/dsh-web-frontend/dist`** — grep evidence only: contains `__DSH_BOOT__` and `react/jsx-runtime`
    references (the boot-graph injection surface); the `PLATFORM_MODULES` table itself is not present in any
    installed npm package.
12. Full census: `dsh.client` declarations of all 47 installed client packages — every one uses `platform: "web"`
    + `inject`; only `dsh-api-session-controller`/`dsh-api-workspace-controller` also use `external`
    (`["@deepseek-ai/dsh-api-gateway/client"]`); all export `./client` with the `lib/client.js` default.
13. **Design baseline:** `docs/ui.md` — §1/§3 (architecture, title-bar entry), §5 (host service
    table), §7 (UI), §8 (realtime), §11-S0 (spike scope/acceptance), §12 (open items), §13 (decisions).

Two referenced docs are **not available in the npm install**: the client-authoring rules
`../AGENTS.md#shared-modules-and-the-module-graph` (linked from the dsh-client-modules README) and the client group
map README. They live in the harness repo (shell source); S0 should read them from the matching git tag if the
composed behavior needs confirmation beyond the npm artifacts.

---



## 8. (e) Verification performed

- Workbench-scaffold strict typecheck: `tsconfig.typecheck.json` includes `client/` (and `tests/`), so CI runs this
  directly now — the standalone command below is historical:

  ```bash
  bun x tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2022 \
    --lib es2022,dom --noUnusedLocals --noUnusedParameters --noUncheckedIndexedAccess \
    --skipLibCheck --types bun --typeRoots ./node_modules/@types \
    client/index.ts client/types.ts tests/client-types.test.ts
  # → exit 0
  ```

- `bun test tests/client-types.test.ts` → **30 pass / 0 fail** (1384 expects): initial state, view switching,
  setStore + browse (per-store refill, degradation, error capture), refresh fold + error capture + browsing guard,
  applyDelta per-kind folds (nine delta kinds), queue per-job fold, origin-seq dedupe + window, timeline
  cap 500 + sliding window, evidence-window folds (dedupe/cap/prune), ⭐ bookmark toggles, simulate text +
  trim/reject, registerFactory seam.
- Biome lint (repo rule set, run via `bun ./node_modules/@biomejs/biome/bin/biome lint client
  tests/client-types.test.ts`) → clean, 0 diagnostics.
- The workbench scaffold (`types.ts`/`index.ts`) stays framework-free pending the S0 loader/slot outcome; the
  SHIPPED Settings panel (`entry.ts`/`settings/*`) uses React from the platform seed.
