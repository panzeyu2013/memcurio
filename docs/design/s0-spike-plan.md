# S0 Spike Plan — Third-party `dsh.client` module assumptions (DSH npm `0.1.2-rc.1`)

> Status: **draft for the S0 run** (spike = plan + verification, no product code). Baseline: `docs/design/plugin-ui-v1.md` (frozen v1.1, commit `6f99047`). Upstream artifacts: DSH npm `0.1.2-rc.1` installs at a `node_modules/@deepseek-ai/*` tree (same version the local dsh instance runs — design §"参考版本声明").
>
> This plan is executable by a future human/agent in a **real DSH environment** (real host process + real browser). Findings tagged `VERIFIED(rc.1)` were confirmed by reading the rc.1 artifacts **now**; `OPEN` needs the live spike; `UNVERIFIABLE-HERE` cannot be decided without a browser/host run.
>
> Companion file: [`docs/design/s0-spike-checklist.md`](s0-spike-checklist.md) — the tick-box run card and the per-upgrade re-verification checklist (§12.5 discipline). This plan links to it per step.

---

## 0. Purpose and scope

Validate, before M0 starts, every third-party client-module assumption the design rests on:

- entry: single title-bar button (design §3.3, §7.7);
- realtime: host → browser push of sanitized deltas (§8, §12 risk 2);
- packaging/build/HMR for a browser bundle outside the deepseek-harness monorepo (§10, §12 risk 4);
- workspace/session context binding (§7.6, §5.1 `store.resolve`).

**Deliverables of the S0 run**: this plan executed end to end, the [checklist](s0-spike-checklist.md) filled in, a short S0 report, and the design-doc updates listed in §8 of this plan. **No `@memcurio/dsh-plugin` source file is modified during S0** — all probes live in a scratch spike package (see P2) or are additive to the *spike profile*, never to the plugin repo.

---

## 1. Spike goals — falsifiable questions

Each goal converts one design §12 open item (or an S0 bullet) into a question that the spike answers YES/NO/partial with artifacts. Q numbering `G1…G6` maps to S0 content items (design §11 S0 内容 1–4).

### G1 — Discovery/serving/registration of a third-party `dsh.client` bundle (S0 内容 1; §12 risk 5–adjacent)
**Question.** When the package `@memcurio/dsh-plugin` (adding `dsh.client: { platform: 'web' }` + a built `lib/client.js` + `exports["./client"]`) is installed into a web profile as an ordinary plugin, does the web shell (a) discover it among the enabled loader entries, (b) serve its bundle under `/plugins`, (c) register its factory in the browser module table, and (d) activate its client half (cordis plugin face) — with no official allowlist step?

**Already VERIFIED(rc.1)** (see ledger L1–L4): the scan is over the live cordis Loader entries of the host composition (`ClientModuleRegistry` injects `loader`; there is no official-package allowlist anywhere in `dsh-client-modules/lib/index.js`). The declaration grammar, the `./client` export requirement, the loud missing-bundle activation failure, the `/plugins` combo route, and the `window.__DSH_BOOT__`/`__ModuleLoader__` boot protocol are all documented in the shipped package.

**Falsifiable.** Pass = with a scratch package added via `dsh plugin --profile <spike-web> add <tarball>`, `dsh web` (dev profile, logs at debug) shows the client row composed and `GET /plugins/??@memcurio-spike/s0-client/client.js&rev=…` (single-resource combo form; see L4) returns 200; the browser console shows no `client-modules:` throw; the placeholder UI mounts. Fail = activation throws (`ClientPackageCompositionError`), 404 on the bundle URL, or a duplicate-source error — each failure mode is distinct and diagnosable (see gate G1 in §5).

### G2 — Which UI surface can a third-party fill (S0 内容 1; §12 risk 1)
**Question.** Which declared slot types exist that fit the design’s entry and workbench: a title-adjacent action (`conversation.session.header.actions`), the settings page list (`settings.section`), and a dedicated full view (`conversation.view`, tabbed)? Can a third-party bundle contribute entries to those kinds (`list`) and/or declare a *new* slot type, or only fill types declared by official packages?

**Already VERIFIED(rc.1)** (ledger L8–L9, L15): ui-conversation declares the conversation slot map in its shipped types, including `conversation.session.header.actions` (`kind: 'list'`, session-scope, "Title-adjacent Session actions in ascending order"), `conversation.session.header.utilities` (`list`), and `conversation.view` (`list`; entries render one at a time behind a tab row when the roster has >1 entries; official registrants today: ui-chat, ui-trajectory). ui-settings declares `settings.section` (`kind: 'list'`, root scope, one page per feature). The SlotMap itself is a TS declaration-merge table (`@deepseek-ai/dsh-client-ui-slots`), and at runtime contributions go through the `ctx.slots` service (`inject`/`register`/`entries`/`subscribe` — ui-goal is the worked example).

**Falsifiable.** Pass = a spike bundle that calls `ctx.slots.inject("conversation.session.header.actions", () => ctx.slots.register({ name, id, order, locale }, Cmp))` renders a button in the real header (and the same for a `conversation.view` tab labeled “Memory”). Partial = the actions slot renders but a full view does not (or vice versa). Fail = runtime slot governance rejects third-party entries, or contributions render in none of the three surfaces.

**Open sub-questions.** Whether registering an unknown (undeclared) slot name throws at runtime vs is silently ignored (the renderers only call `renderSlot` for names they own, so undeclared names are structurally unreachable — confirm by reading the runtime Slots implementation during the spike, P4); what `single`/`chain` slots do with a second registrant; whether entry ordering (`order`) and localization (`label`/`locale`) behave exactly as ui-goal uses them.

### G3 — Browser ↔ host bridge for third parties (S0 内容 2; §12 risk 2)
**Question.** Is the official `inject` api-remote/controller pattern (client `ctx.remote.<ns>`, generated typert controllers, forwarded host events) open to third-party packages — i.e. can a non-`@deepseek-ai` package have its host controller methods reach the browser — and if not, which fallback channel survives rc.1 (session projections? custom webserver routes? polling), matching the design’s §8.1 sentence and §12.2 “评估上游申请 / 轮询次级”.

**Already VERIFIED(rc.1)** (ledger L10–L13): the api-remotes assembly is **closed by construction** — “the capability set is fixed by explicit build-time value imports; the Client does not discover the Host's active Services or Remote definitions at runtime. Additional capabilities require an explicit `/remote` value import and mount in this assembly”, and forwarded host events are allowlisted in one official array. This is the design’s §12 risk-2 “no” branch, confirmed at rc.1. Two open fallback candidates exist in rc.1: (a) `ctx.sessionProjections` — an **open registry** any host plugin can register units into, whose client-visible wire views ride the existing official `session/projection` frames + history tail (no new wire), but whose fold input is **committed session-log events** only (see L12) — and (b) `ctx.webServer.register` — **any plugin may register named exact/prefix/upgrade routes** on the GUI’s HTTP server, which “carries no authentication or origin policy of its own” (default loopback bind), enabling same-origin fetch/SSE between the page and the memcurio host half (see L13).

**Falsifiable.** Pass(full) = one chosen channel proves *host-event → browser* push end-to-end (S0 acceptance). Pass(partial) = projections carry state that derives from the session log (fits usage/timeline deltas) while queue/job deltas must go over the custom-route channel; the two channels compose. Fail = only polling works. The gate G3 (§5) records the chosen transport for M0 and whether “upstream request” (official extension) must be filed.

### G4 — Bundle build contract for a third party (S0 内容 3; §12 risk 4)
**Question.** What must the built client artifact look like (`window.__ModuleLoader__.load({ id, factory })` Lazy-CJS, `factory(require)`, module exports = client plugin face `{ apply, inject }`), which specifiers may the bundle require (8 platform seed words + graph rows declared under `dsh.client.external`), and is there an official dev/build flow usable outside the monorepo?

**Already VERIFIED(rc.1)** (ledger L5–L7, L14): bundle shape = one file whose top-level statement registers the factory; every body side effect is deferred to materialization; requires are resolved seed → memoized → registered factory, anything else throws with a drift diagnostic. The seed table (the shipped form of the repo-doc name `PLATFORM_MODULES`) is exactly `{ react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis, @deepseek-ai/dsh-client-store, @deepseek-ai/dsh-client-ui-slots, @deepseek-ai/dsh-client-ui-primitives }`. Official packages externalize only *non-seed* runtime imports (example: `dsh-api-session-controller` externalizes `@deepseek-ai/dsh-api-gateway/client`); bundles that import nothing outside the seed need no `dsh.client.external` at all (ui-goal is the template: it requires only react/jsx-runtime, react, and primitives, and talks to everything else through `ctx.*` services). Official build tool = `tsdown` with `bundle`/`watch` scripts producing `lib/client.js`; the harness’s `pnpm run dev:web` watcher is a monorepo-internal convenience — the HMR contract is only “some process rewrites the installed package’s `lib/client.js`”.

**Falsifiable.** Pass = the spike repo builds the same shape with a standalone tsdown config + external list mirroring ui-goal, the file parses in the boot graph, and `require()` of anything non-seed throws the documented runtime error before the fix (negative probe). Partial = shape works but only with the monorepo toolchain. Fail = an undocumented build-time transform is required (e.g., the `\0dsh-css:` virtual CSS module convention used by official bundles — see L7) that third-party tooling must replicate blindly.

### G5 — HMR/dev loop for a third-party bundle (S0 内容 3; §12 risk 4)
**Question.** When a watcher rewrites the installed bundle, does the running page swap the plugin in place (component state lost, data layer kept), without a page reload?

**Already VERIFIED(rc.1)** (ledger L14): `dsh-client-hmr` is a row of the shipped web profile; idle until a rebuild watcher writes `lib/client.js`; swap = re-execute bundle + remount plugin with fresh state; session/workspace/connection state survives; failed reloads are reported and retried on next rebuild; the node-side hook is `ctx.clientModules.rebuilt(id)` (content-hash change only).

**Falsifiable.** Pass = edit → watcher → browser shows the change without reload (checklist artifact: two consecutive renders). Fail = swap only works for official packages (e.g., because the watch registers only known rows).

### G6 — Workspace/session context available to the client (design §7.6, §5.1)
**Question.** How does the client learn (a) the current session id + its `cwd`/workspace anchor (memcurio’s store key = (DSH home, workspace), and its existing scope derivation is `session.header.cwd`-driven), (b) the session list for cross-workspace read-only browsing, and (c) its agent identity?

**Already VERIFIED(rc.1)** (ledger L15): `SessionSnapshot.sessionId`; `SessionSummary { id, displayTitle, cwd, blank, … }` via the client sessions store; agent scope tag = session id (`agent id === session id`); `Session.projections.faceOf(key)` per-session projection faces; workspace list arrives through the workspace controller client model (`WorkspaceSnapshot.items`). Whether the *slot standard props* handed to a `conversation.view`/`header.actions` entry expose exactly these (the standard hooks kit: `useSession(s)`, `useSessions(s)`, `useProjection(k)`) is verifiable in the ui-session/slot .d.ts files at spike time.

**Falsifiable.** Pass = the placeholder shows real values: current session id, `cwd`, display title, and the workspace list, no official edits. Fail = identity is only available inside official view components (→ design §7.6 must find another carrier).

---

## 2. Verified findings ledger (rc.1)

Legend: `VERIFIED(rc.1)` — read now in the installed artifacts; `OPEN` — remaining live check; `UNVERIFIABLE-HERE` — needs real host/browser, listed with what the spike must check. Artifact root `N` = `node_modules/@deepseek-ai` of the rc.1 install (paths relative to `N`).

| # | Finding | Evidence (file, locator) | Status |
|---|---|---|---|
| L1 | `dsh.client` declaration grammar: `platform` (string), `inject`, `external` (string arrays), `immediately` (bool); malformed → activation throw | `dsh-client-modules/lib/index.js:139-154` (`parseDshClient`), 90-120, 478-479 | VERIFIED(rc.1) |
| L2 | `exports["./client"]` required (string or `{default}`); a `dsh.client` package without it throws; the bundle path is resolved from the manifest package’s own dir (`lib/client.js` in practice) | `dsh-client-modules/lib/index.js:155-166, 618-648, 635-636, 731-745` | VERIFIED(rc.1) |
| L3 | Discovery = incremental scan of **host Loader entries** (`ctx.loader.entries()`, `internal/plugin` dirty-marking); per (entry, base URL) negative cache; duplicate active sources for one package name = composition error | `dsh-client-modules/lib/index.js:440-488, 755-816` | VERIFIED(rc.1) |
| L4 | Serving: prefix route `/plugins`; combo URLs `/plugins/??<id>/client.js,…&rev=…`; per-row one-resource URLs for HMR; immutable cache; unknown → 404; missing bundle at activation → loud `ClientPackageCompositionError` with “run `pnpm run build` before launch” + package/path | `dsh-client-modules/lib/index.js:90-120, 480-487, 567-610, 838-858` | VERIFIED(rc.1) |
| L5 | Boot protocol: host injects facade + `window.__DSH_BOOT__` (graph: `entries[]` with `id/url/rev/inject/immediately/external`, `batches[]` bootstrap/application); browser parses to `BootManifest`; duplicate/malformed → loud page failure | `dsh-client-modules/lib/types/client/manifest.d.ts:46-118`; `lib/client.js:71-136`; `lib/index.js:387-432` | VERIFIED(rc.1) |
| L6 | Lazy-CJS contract: a bundle’s top-level statement registers `window.__ModuleLoader__.load({ id, factory(require) })`; body side effects run at materialization; `require` resolution = seed word → memoized record → registered factory → throw (miss message names the missed specifier); bundle id must equal the graph row id; double execution without invalidation throws | `dsh-client-modules/lib/client.js:1-3, 184-337` (esp. 229-233, 300-310); `lib/types/client/manifest.d.ts:147-157` | VERIFIED(rc.1) |
| L7 | Client plugin face: module exports `{ apply(ctx), inject: string[] }` (+ component/type re-exports, locale map declaration merge) — ui-goal is the template; CSS arrives as in-bundle string + `data-plugin` style tags claimed per module (HMR bookkeeping) | `dsh-client-ui-goal/lib/client.js:365-445` (exports 439-443); CSS: `lib/client.js:9-33` (claimStyles `dsh-client-modules/lib/client.js:170-176`) | VERIFIED(rc.1) |
| L8 | Conversation slot map (declared by ui-conversation in shipped types): `conversation.session` (single), `conversation.session.header` (single), `conversation.session.header.lineage` (single), **`conversation.session.header.actions` (list, “Title-adjacent Session actions in ascending order”)**, `conversation.session.header.utilities` (list), **`conversation.view` (list; one at a time; `viewRequest/openView` focus protocol)**, `conversation.input.dock` (list; ui-goal’s seat), composer/hero slots | `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts` (SlotMap block ~lines 15-95; `actions`/`utilities` entries; `ConvViewOwnerProps`) | VERIFIED(rc.1) |
| L9 | Header chrome renders `<header>` with breadcrumbs + actions slot div (`renderSlot("conversation.session.header.actions", {})`), utilities slot div, and a tab row **only when the view roster has >1 entries**; views come from the conversationViews ledger derived from `slots.entries("conversation.view")`; official registrants: ui-chat (8082), ui-trajectory (8194) | `dsh-client-ui-conversation/lib/client.js:14544-14660` (header ~14544-14620; tabs), 15968-16025; `dsh-client-ui-chat/lib/client.js:8082-8084`; `dsh-client-ui-trajectory/lib/client.js:8194-8195` | VERIFIED(rc.1) |
| L10 | **`ctx.remote` is a closed official assembly**: “capability set is fixed by explicit build-time value imports; the Client does not discover the Host’s active Services or Remote definitions at runtime. Additional capabilities require an explicit `/remote` value import and mount in this assembly”; forwarded host events = one official allowlist (`ctx.remote.$on` key set) | `dsh-api-remotes/README.md` (Summary + “Known Limitations”), plus package.json `dsh.client.inject` shape; `dsh-client-ui-goal/README.md` (“the inject face … `ctx.remote.goals`”) | VERIFIED(rc.1) |
| L11 | Session projections are an **open registry**: any domain plugin registers a unit (key, state schema, `init`/`apply` fold, optional `wire` client view, `stateVersion`); registry drives units over **committed session events**; carriers = history tail page + `session/projection` push frame; checkpoint/persist machinery exists; `SessionProjectionMap`/`SessionProjectionStateMap` are **merge-extensible interfaces** (third parties can augment from their own .d.ts) | `dsh-session-projection/README.md` (register/read sections); `dsh-session-projection/lib/types/types.d.ts` (interfaces + doc); client read path: `dsh-api-session-controller/lib/types/client/sessions/*`, goal client.js:392-400 | VERIFIED(rc.1) |
| L11a | Fold input = session-log events only (eager drive per committed event; cells advance on cursor); **no verified external/async trigger API** for non-log state (queue/job/audit deltas). Whether official units have a secondary trigger is an OPEN probe | `dsh-session-projection/lib/index.js` + `lib/types/index.d.ts` (register/onChanged/snapshot docs; “Eager drive: pass one committed event through every unit”) | OPEN (needs live probe of a non-log-driven unit; log-driven path is VERIFIED(rc.1)) |
| L12 | Webserver routes are open to any plugin: named `exact`/`prefix`/upgrade registration + disposer; duplicate path throws (composition contract); server “carries no TLS, authentication, or origin policy of its own”; default bind `127.0.0.1`; compression skips SSE; `/api` is a *separate* browser-trust fence owned by the connection row | `dsh-host-webserver/README.md` (“Registering routes”, “Minimal configuration”); `dsh-web-app/cordis.patch.yml` row comments (modules/connection rows); `dsh-web-app/README.md` (token/cookie handoff, trust fence) | VERIFIED(rc.1) — but **route-auth semantics for a custom prefix are UNVERIFIABLE-HERE** (see L12a) |
| L12a | Can the page `fetch()`/SSE a non-`/api` custom prefix with its session cookie, and is that acceptable? (Same-origin fetch carries cookies; whether host route handlers are expected to authenticate is unproven at rc.1; default loopback bind mitigates exposure.) | — | UNVERIFIABLE-HERE — spike P5 probes: fetch status, cookie presence, SSE framing, and whether any Origin/Host gate applies |
| L13 | Browser client identity data: `SessionSnapshot { sessionId, … }`; `SessionSummary { id, displayTitle, cwd, parentId, blank, running, … }`; sessions service root + per-session bindings; agent scope tag `agent id === session id`; per-session projection faces (`faceOf(key)`); workspace list model (`WorkspaceSnapshot.items`) | `dsh-api-session-controller/lib/types/client/contract/snapshot.d.ts:57-81`; `…/sessions/service.d.ts` (SessionSummary ~22-49); `…/client/scope.d.ts` (createScope); `dsh-api-workspace-controller/lib/types/client/model.d.ts` (WorkspaceSnapshot); goal client.js:392-400 | VERIFIED(rc.1) |
| L14 | HMR chain: `dsh-client-hmr` mounted in web profile (row `client-hmr`); idle until a watcher rewrites a bundle; swap = fresh bundle + remount (React state lost, session/workspace/connection state kept); failed reload reported + retried; node hook `ctx.clientModules.rebuilt(id)` re-hashes and recomposes the graph (content-hash change only) | `dsh-client-hmr/README.md`; `dsh-web-app/cordis.patch.yml` (~144-150); `dsh-client-modules/lib/index.js:517-566` | VERIFIED(rc.1) |
| L15 | Seed table (shipped form of the repo-doc `PLATFORM_MODULES` baseline): `{ react, "react/jsx-runtime", "react-dom", "react-dom/client", "@deepseek-ai/cordis", "@deepseek-ai/dsh-client-store", "@deepseek-ai/dsh-client-ui-slots", "@deepseek-ai/dsh-client-ui-primitives" }`; non-seed requires must name a dynamic graph row and be declared under `dsh.client.external` (self/cycle/missing-supplier rejections at composition) | Shell boot code constructing `staticModules` in `dsh-web-frontend/dist/assets/index-*.js` (minified, function building the seed object); contract doc: `dsh-client-modules/README.md` (“Sharing modules”, “Build requirements”); ordering: `lib/index.js:339-371`; runtime miss throw: `lib/client.js:308` | VERIFIED(rc.1) |
| L16 | Web profile mechanics: profile dirs under `$DSH_HOME/profiles/<name>`; `dsh web` = `--profile web` (auto-init from shipped templates); `dsh plugin --profile <name> <pnpm args>` initializes and pnpm-manages the profile, then reconciles `dsh.profile.bundles` — a dependency whose manifest declares `dsh.bundle` (memcurio does) joins the layer stack; layers: bundles in order → profile `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch`; `--dump-default-config`/`--dump-config` print the composed tree without booting; web flags `--port/--host/--trusted-host/--no-open`; home precedence: configured → `$DSH_HOME` → `~/.dsh` | `dsh/README.md` (commands table, Profiles); `dsh/lib/plugin-*.js` (bundled module doc: “thin pnpm forwarder … reconciles the `dsh.profile.bundles` layer list”); `dsh-web-app/README.md`; `dsh-home-paths/README.md` | VERIFIED(rc.1) |
| L17 | Web profile runs the agent plane behind **agent presets**: per-session composition from `agent.cordis.yml`; user presets under `$DSH_HOME/.agent-presets`; the shipped `standard` preset is the default; memcurio’s current patch row (`id: memcurio`, `name: @memcurio/dsh-plugin`, `inject: [tools, llm, sessions]`) is root-plane and may not resolve those services in the web profile (tools/llm moved behind presets there) | `dsh-agent-presets/README.md`; `dsh-web-app/cordis.patch.yml` (agent-plane section ~308+, preset roster ~433-441); memcurio `cordis.patch.yml` | VERIFIED(rc.1) — mounting strategy OPEN (P3) |
| L18 | Settings surface: `ctx.settingsScope`/`ctx.settingsSchema` + declared slots incl. `settings.section` (`kind: 'list'`, root, “one page per feature”; entries carry `id/order/label`), `settings.action` (list, ordered header actions) — “declares slot types … and renders nothing itself”; the shell lives in ui-settings-general | `dsh-client-ui-settings/README.md` (Summary); `lib/types/client/contract/slots.d.ts:40-118` | VERIFIED(rc.1) |
| L19 | Slash commands: `ctx.commands.register({name, description, input, handler})` runs **against the agent** without creating a model message; runs are recorded in the session log and rendered by the adapter; no client-UI-opening command semantics found at rc.1 | `dsh-commands/README.md` (Summary/“Registering a command”) | VERIFIED(rc.1) — the design’s “/memory opens the workbench” fallback has **no verified client-side opener**; OPEN probe in P4/P7 (see §8, outcome table row for §3.3/§7.7) |
| L20 | Jump-to-history capability (design §12 risk 3): official turn-jump loader `loadThrough(seq)` and `open(sessionId)` selection exist; the view focus protocol (`openView(view, focus)` / `viewRequest`) is the only addressing seam found; whether a third-party node can make the chat view open a session at an exact message is unproven | `dsh-api-session-controller/README.md` (SessionEventStream/loadThrough); `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts` (`ConvViewOwnerProps`); header lineage `open(summary.id)` | Partial: mechanisms VERIFIED(rc.1), cross-package focus addressing UNVERIFIABLE-HERE (P4 probe) |
| L21 | Tooling pins for the spike environment: repo CI pins bun `1.3.14`; `engines.node >= 22.13`; dsh launcher runs on node (launcher bin inside `@deepseek-ai/dsh`) | memcurio `.github/workflows/ci.yml`, `package.json`; `dsh/package.json` (`bin: dsh → lib/bin.js`) | VERIFIED(rc.1) |

### 2.1 Known rc.1 composition hazards the spike must not trip over (all VERIFIED(rc.1))

- **H1** — Any loader row whose package declares `dsh.client` with a missing `lib/client.js` **fails web activation loudly** (grouped error). The memcurio client declaration must only land together with a built bundle in the installed package (`files` + dist discipline, design §10).
- **H2** — Duplicate active Loader sources for one package name throw; distinct rows must never mount the same package name twice (relevant to the root-plane vs preset-plane question L17).
- **H3** — Browser bundle content is **snapshotted at activation**; edits reach the graph only through `rebuilt()` (HMR) — restart after rebuild is the HMR-less fallback.
- **H4** — `dsh.client.immediately` marks stage-one prefetch (parser-batch preloads); non-immediate rows load lazily on first import — the workbench must therefore be reachable by *activation* of its client row (via cordis entry composition) rather than by module import order (design §10 “客户端模块惰性语义” is satisfied only for script arrival; the plugin row itself activates at boot like any cordis row).
- **H5** — Combo URL generation truncates nothing silently: a single bundle exceeding the 3 KiB single-resource limit is allowed (per-row combos), but an over-long *initial batch* partitions; no action needed, diagnostic only.
- **H6** — Web profile rows for client packages carry `inject: [webRuntime]`-style edges only where needed; adding a third-party row must not collide with ids/names in the browser roster (`id` collisions throw).

---

## 3. Spike steps (commands where knowable)

Each phase lists: steps, artifacts to collect (checklist fields), and its decision gate (→ §5). Phases P0–P2 are environment; P3–P7 are the probes that answer G1–G6. Run everything against the disposable home/profile of §6. `dsh` in commands = the rc.1 CLI (see §6); `<spike-web>` = the spike profile name.

### P0 — Environment bring-up (prereqs §6)
1. Verify toolchain: `node -v` (>= 22.13), `bun -v` (1.3.14 pinned for memcurio dev), `dsh --help` (rc.1: `dsh --version` or `dsh -v` output recorded).
2. Disposable home: `export DSH_HOME=$(mktemp -d)`; record it; keep it for the whole run.
3. First boot + artifact inventory:
   - `dsh --profile web --no-open --port 0` in background (or a fixed high port); capture the `dsh web:` startup URL line and logs to `artifacts/p0-boot.log`.
   - Browser/HTTP smoke: open the printed URL (browser automation or manual); page renders, session list appears, a chat message can be sent **only if a provider key exists — otherwise skip chat, the UI still renders** (record which).
   - `dsh --profile web --dump-config > artifacts/p0-composed-tree.yml` — inventory the composed rows: confirm the browser roster (~50 `dsh-client-*` rows), `client-hmr`, `client-modules`, `agent-presets`.
   - Shut down. Record the auto-created profile dir layout (`$DSH_HOME/profiles/web/…`).
4. **Gate P0** (preconditions): web boots and renders → continue; otherwise stop and fix environment (risk register R1–R3).

### P1 — Baseline discovery check on an *official* client package (G1 control)
1. Boot again and collect:
   - host logs filtered for `client-modules` (activation, composition, any warn) → `artifacts/p1-modules.log` (debug logging: see P0 note — enable per §6 env knob candidates and record which worked);
   - `curl -s -o /dev/null -w '%{http_code}' '<base>/plugins/??@deepseek-ai/dsh-client-ui-goal/client.js&rev=…'` — better: parse one combo URL out of the served HTML `<head>` (`curl -s <base>/ | grep -o '/plugins/??[^"&]*' | head -1` and fetch with its `&rev=` intact); expect 200 + `cache-control: public, max-age=31536000, immutable`;
   - in the browser console: `window.__DSH_BOOT__.entries.length`, `typeof window.__ModuleLoader__`, and after boot `Object.keys(await ...)` is not required — simply confirm no `client-modules:` console errors and that the goal bar renders when a goal exists (control that slot registration works at all in this environment).
2. **Gate P1**: official client rows compose and the /plugins route serves → the control passes; failure here means environment/installation problem, not memcurio (fix before P2).

### P2 — Scratch spike package + install path (G1, G4; S0 内容 3)
Build a **scratch package** (never the plugin repo) that mirrors the memcurio packaging surface:

```
spike-client/
  package.json   # name @memcurio-spike/s0-client; dsh: { client: { platform: "web" } }
                 # exports: { "./client": { default: "./lib/client.js" } }
  src/client/index.ts
  tsdown/… or hand-rolled build → lib/client.js
```
1. **Build contract probe (G4)**: hand-roll the minimal bundle first (no toolchain noise), exactly:
   ```js
   window.__ModuleLoader__.load({ id: "@memcurio-spike/s0-client",
     factory: (require) => { const module = { exports: {} };
       module.exports = { inject: ["slots"], apply(ctx) { …register hello entries… } };
       return module.exports; } });
   ```
   with `apply` registering (a) a `conversation.session.header.actions` entry (button “🧠”), (b) a `settings.section` entry (id `memory-spike`, order/label), (c) a `conversation.view` entry (id `memory-spike`, label “Memory”, component rendering placeholder text + the identity panel of G6). Then replicate with a standalone `tsdown` config externalizing exactly the seed words + nothing else; diff behaviors (negative probe: add `require("@deepseek-ai/dsh-client-locale")` unlisted → expect the runtime miss error text at materialization, then remove and re-verify).
   - Artifacts: `lib/client.js`, bundle build script/config, negative-probe console snippet.
2. **Install**: `bun run pack:check`-equivalent for the spike package (or plain `bun pack`), then
   `dsh plugin --profile <spike-web> add <spike-tarball-or-path>` (this auto-initializes `<spike-web>`; the profile is a copy of the web surface — see P2 note below on how to keep it a *web-like* profile), then `dsh --profile <spike-web> --dump-config | grep -A4 's0-client'` to confirm the row and any bundle-layer reconcile.
   - Note: profiles name their own `dsh.profile.bundles`; the practical spike profile = create `<spike-web>` with `bundles: ["@deepseek-ai/dsh-web-app"]`-equivalent (see P0 dump for the web profile’s manifest) so the surface is the real web GUI. Record the profile manifest diff.
3. **Gate P2** (G1/G4 partial): bundle served (200), page boots with the row active, hello entries render → G1 PASS. Missing-bundle activation error reproduced exactly when `lib/client.js` is absent (H1) → G4 PASS (contract diagnostics usable). Any deviation (duplicate source H2, drift throw H3, seed-miss) → capture message text as the artifact and answer the goal’s falsifiable test with the failure mode.

### P3 — Host-side mount strategy in the web profile (G1 host half; L17)
1. Decide where the real memcurio host row must live in the web surface. Probes:
   - (a) root-plane row: add the real `@memcurio/dsh-plugin` tarball to `<spike-web>` exactly as today (`dsh plugin … add memcurio-tarball`); boot and inspect the row’s fiber state in logs + whether its existing injects (`tools, llm, sessions`) resolve in the web composition (expected trouble per L17 — record the failure text if any).
   - (b) preset-plane row: copy the shipped `standard` preset → `$DSH_HOME/.agent-presets/<spike>/agent.cordis.yml`, add the memcurio row there (see checklist for the row shape), start a session with that preset (the hero preset control), confirm the plugin activates per-session and its tools/event lane work while the root row is disabled for web (disable via the spike profile’s own `cordis.patch.yml` — layer semantics L16).
2. Record which strategy yields: (i) memcurio host services up in the web process, (ii) session events flowing to it for the active browser session, (iii) client row discovered exactly once (no H2).
3. **Gate P3** (G1 full, host half): one mounting strategy works and is repeatable; the alternative strategy’s failure mode is captured. This directly informs §8.1 (event source) and the design’s “host 半侧已订阅全量 session 事件” claim for the web surface.

### P4 — UI surfaces & slot-governance probes (G2; §12 risk 1; also L19/L20)
In the browser against `<spike-web>`:
1. **Title-bar actions**: with an active session, screenshot/DOM-assert the button rendered by the spike’s `conversation.session.header.actions` entry next to the session title (header crumb row); click → the spike view opens.
2. **Full view**: switch to the “Memory” tab — confirm the tab row exists because roster >1 (chat + trajectory + spike) and the `conversation.view` body mounts only for the active tab (`only: active.id`).
3. **Settings page**: open Settings; confirm the `memory-spike` section appears in the nav and renders its page (settings.section is root scope — renders outside a session too).
4. **Governance probes**: register (from the spike bundle or a console-evaluated extra entry) into an *undeclared* slot name and into a `single` slot as a second registrant — capture the runtime behavior (throw text vs silent ignore) → decides the “third parties may fill declared slot types only” statement for §3.3/§7 and the design sentence about declaring new views.
5. **Fallback opener probe (L19)**: register an agent-scoped command `memory` via the host row (`ctx.commands.register`); verify what the user sees (command-input bubble, no UI opening). Verdict feeds the §7.7 / §12-1 design update (likely: keep `/memory` as agent command only if UI-opening is impossible; prefer the header action slot).
6. **Jump probe (L20)**: from the spike UI, attempt to open the current session at a chosen message (openView + chat focus request; consult chat’s focus vocabulary in ui-chat types at spike time). Record success/failure — decides §12 risk 3 wording.
7. **Gate P4** (G2): (1)+(2) and (3) pass → G2 PASS; governance probe results recorded; otherwise record which surface failed with console/host error text and proceed to §5 gate G2.

### P5 — Bridge probes (G3; §12 risk 2; S0 内容 2)
1. **Negative control — official RPC closed**: in the browser, confirm `ctx.remote` has only the official namespaces (console: enumerate `ctx.remote` keys from the plugin context if reachable, else assert via the spike client code: attempting to use an undeclared namespace/method fails). Collect the closest public API evidence: no third-party namespace present.
2. **Projection channel (a)**: host spike row registers `ctx.sessionProjections.register({ key: 'memcurioSpike', …, wire: { viewSchema, view } })`; browser reads the face on the current session (mirror goal client.js:392-400); then commit a real session event (send a chat message) and assert the frame updates the client value; also attempt a *non-log* change (host-side timer mutating state) and record whether it reaches the client → answers L11a.
3. **Custom-route channel (b)**: host spike row registers a prefix route (`ctx.webServer.register({ kind: 'prefix', path: '/memcurio-spike', handler })`):
   - unary: `fetch('/memcurio-spike/ping')` from the page console → status/body (L12a: cookie/auth/Origin behavior);
   - stream: SSE endpoint (`text/event-stream`, `Content-Type` checked, compression skip verified per L12) → one host event per second reaches the page;
   - host event source for the *real* plugin later = existing memcurio cordis events (design §8.1) — validate a trivial mapping now (spike timer → delta JSON).
4. **Polling baseline**: 1s `fetch` loop over the unary route; measure latency/jitter and UI-degraded badge approach (design §8.3).
5. **Gate G3** (§5): choose channel(s) for M0: order = custom-route SSE (+projection where state is log-derived) if (b) passes; projection-only if (a) passes and (b) fails; polling if both fail. Record whether an upstream extension request must be filed (design §8.1 “评估上游申请” branch) and who owns it.

### P6 — HMR loop (G5)
1. Boot with a bundle watcher running: replicate `dev:web`-style by running the spike package’s own `tsdown --watch` (writes its `lib/client.js`) while the page is open (the row’s bundle path is the installed package path — for a `pnpm add <tarball>` install, re-install or link the package so the watcher writes the installed file; a `bun link`/`pnpm link`-style install is acceptable for the spike).
2. Edit text in the spike view → save → observe swap without reload (fresh state, data layer alive). Record timings + console markers; also the failed-reload path (introduce a syntax error) — expect visible error + retry on next rebuild (README).
3. **Gate P6** (G5): PASS = swap observed for the third-party bundle. FAIL = record and answer G5’s falsifiable test; §10/§12-4 keeps the restart fallback (H3).

### P7 — S0 deliverable end-to-end (success criteria §4 of this plan; mirrors §11 S0 验收)
Using the chosen mounting strategy, transport, and surface from P3/P4/P5:
1. The spike **placeholder workbench** (title-bar button → workbench) opens in the real GUI.
2. **One host event reaches the browser** and visibly mutates the in-UI counter (see §4 instrumentation).
3. Degraded-mode verdict: if no push channel passed P5, show the polling path with the “degraded” badge (design §8.3) and record that M0 would ship on polling unless upstream extension lands.
4. Collect the S0 report skeleton: per-goal verdicts G1–G6 (PASS/partial/FAIL + evidence), failure texts verbatim, profile/artifacts archive path, and the §8 design-update deltas proposed.

### P8 — Cleanup & report
1. Kill background jobs; archive `artifacts/` (logs, dumps, console captures, screenshots/DOM snapshots, bundle, negative-probe texts).
2. Fill the [checklist](s0-spike-checklist.md) (run card + per-upgrade re-verification section).
3. Land the design-doc updates per §8 mapping (design §11 S0 产出: “S0 报告 + 更新本文 §3/§8/§12”).

---

## 4. Success criteria & minimal deliverable spec

Acceptance (mirrors design §11 S0 验收; no production plumbing):

1. **S0-A1 (entry)**: in a real DSH Web session of the spike profile, the **title-bar area** shows the single memory button (spike: “🧠 Memory workbench (S0)”) next to the session title; clicking it opens the **placeholder workbench** view containing: session identity panel (G6: session id, `cwd`, display title), three empty tab stubs (注入面/持久面/状态面 naming allowed at spike), and the **instrumentation area** below. If the actions slot failed (G2 partial/FAIL), the fallback entry surface chosen by gate G2 must be demonstrated instead (settings.section page or view tab), and the §7.7 fallback text updated accordingly.
2. **S0-A2 (push)**: with the workbench open, a host-side spike emitter sends one event; the browser shows it as a **counter increment + last-event line**; repeat for ≥ 5 events with < 1 s staleness for the chosen channel (polling fallback ≤ 1–3 s per design §8.3 with the badge).
3. **S0-A3 (conclusions)**: each §12 risk item 1–5 has an explicit verdict line in the report: mechanism verified in live env, or NO with the chosen fallback named (and, for risk 2, the upstream-request owner if needed). §12.6/§12.7 are product risks, untouched by S0.

### Instrumentation (no production plumbing)
- Host side (spike row): debug `ctx.logger` lines with a fixed prefix `[memcurio-s0]` (activation, event → delta emit, route hits, HMR rebuild notifications); a 2 s heartbeat timer while a session is live.
- Browser side (spike client): `console.debug('[memcurio-s0]', …)` on apply/register/materialize and on each received delta; the counter is plain React state fed only by the transport adapter (the one piece later swapped for the real service adapter); show a “degraded (poll)” badge when the push channel is absent.
- The transport adapter interface (one function pair: `subscribe(onDelta)` / `fetchSnapshot()`) is the *only* skeleton code kept for M0; everything else in the spike package is disposable.

---

## 5. Decision gates (§12 risk mapping)

| Gate | Step | §12 risk / S0 item | Falsifiable answer | If **NO** → fallback chosen (and recorded) |
|---|---|---|---|---|
| G1 | P1/P2/P3 | §12-5-adjacent; S0-1 | Third-party bundle discovered, served, registered, activated | Pause; capture failure class (missing bundle H1 / duplicate source H2 / drift H3 / scan miss); if scan misses non-official entries → upstream request (client-modules allows no allowlist today, so expected fix is on our packaging) |
| G2 | P4 | §12-1 (双入口); S0-1 | Title-bar actions slot exists & takes third-party entries | Design §3.3 fallback activates: `/memory` command **only if** L19 probe shows a client-opener path; otherwise secondary entry = `settings.section` page + `conversation.view` tab; §3.3/§7.7 text updated |
| G3 | P5 | §12-2 (推送架构); S0-2 | One push channel works host→browser | Order: SSE over custom prefix route → session projections (log-derived only) → polling 1–3 s + degraded badge (§8.3); upstream extension request filed for real `ctx.remote` access, design §8.1 reworded to the winning channel |
| G4 | P2 | §12-4 build; S0-3 | `lib/client.js` Lazy-CJS contract reproducible standalone | Build must mirror tsdown conventions from official packages (incl. CSS virtual-module convention) — record exact config diff; §10 packaging bullet gains the standalone recipe |
| G5 | P6 | §12-4 HMR; S0-3 | HMR swap works for third-party bundle | Keep restart-per-rebuild (H3) as the dev loop for M0; §10/§12-4 notes |
| G6 | P4/P7 | §7.6 context | Client can bind session/workspace identity | If identity only reachable through official adapters → §7.6 rewrites the binding contract (e.g., projection face carrying identity) |
| L20 | P4.6 | §12-3 回链 | Message-level jump works | §12-3 stays “文本引用” fallback (design already accepts); timeline nodes render session/message references |
| L19 | P4.5 | §7.7/§12-1 | `/memory` as UI opener | If impossible → replace fallback story in §7.7 with the winning secondary entry; note `/memory` remains a possible agent command, not a UI opener |

---

## 6. Environment prerequisites (runner must prepare)

- **Disposable home**: `DSH_HOME=$(mktemp -d)`; never reuse a real home. Profile data, `.agent-presets`, logs all inside it. (Design stores memcurio data under the same home — the spike keeps memcurio out of the picture entirely except P3/P7.)
- **Toolchain** (repo CI pins, L21): bun `1.3.14` (`oven-sh/setup-bun` pin; local `bun -v` must match), node `>= 22.13`; the dsh launcher (`@deepseek-ai/dsh` rc.1) on PATH (or `node node_modules/@deepseek-ai/dsh/lib/bin.js`). Record versions in the report.
- **dsh package set**: the same rc.1 install tree for *both* the running dsh and the artifacts read (the install root used for this plan’s ledger is one such tree); package the plugin/spike tarballs **from the same rc.1 resolution**.
- **Profile**: `<spike-web>` per P2 (web-app bundle + added rows), plus `web` untouched as control. All boots use `--no-open` + fixed high port unless browser handoff is wanted; capture the startup URL line.
- **Browser**: real browser (or Playwright/Chrome DevTools automation) on the same machine; GUI binds loopback by default — do not bind `0.0.0.0` (risk R2).
- **Network**: pnpm add of the spike package from a local tarball needs **no registry**; do not depend on external registries unless unavoidable (record if used). No model/API keys are required for UI/slot/transport probes (chat-dependent probes are optional); note if the environment supplies none.
- **Logging**: enable debug logging if the harness documents it (probe candidates during P0: `--log-level`, `DSH_*` env, profile logger config — record which worked on this rc.1; the client-modules node half logs through `ctx.logger` so the web profile’s logger level governs visibility).
- **Concurrency**: one dsh process at a time per home (SQLite/lock discipline; profile patchReload `live` may watch files — keep edits outside the live profile dirs to avoid reload churn, or accept and record).

### Spike-run risk register

| R# | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | `dsh web` activation failure after adding the client row (missing bundle etc.) | medium | Boot fails, time lost | Add `dsh.client` only in the *spike package* during S0; real plugin gains it in M0 with the built bundle in `files`; keep `--dump-config` as the no-boot inspector (H1) |
| R2 | Browser handoff/loopback issues (SSH session, headless runner) | medium | Can’t verify UI | `--no-open` + printed URL; port forwarding; fall back to HTTP-level probes (curl) where the probe is transport-only |
| R3 | Version skew: spike run uses an rc.1 other than the one the ledger was read against | low | Verdicts void | Pin the same rc.1 everywhere (report the exact tree path + `dsh --version`); rerun the [checklist](s0-spike-checklist.md) on any upgrade (design §12-5 discipline) |
| R4 | Row-id collisions with the browser roster (H6) / duplicate package sources (H2) | medium | Composition error, confusing logs | Choose distinct ids (`memcurio-*`); check `--dump-config` for name/id collisions before boot |
| R5 | Host-plane vs preset-plane mount confusion (L17) eats spike time | high | Wrong conclusions about §8.1 | P3 is explicitly staged before transport work; record the row state per strategy |
| R6 | Browser console noise from HMR/dev watcher races | low | Misread swap results | HMR probes use dedicated page loads; restart fallback documented (H3) |
| R7 | Timebox overflow | medium | Report incomplete | Gates are checkpoints: record verdicts as reached; partial verdicts are acceptable if the failing mode + text is captured |

---

## 7. Findings → design updates (only after the S0 report lands; M0 never starts on unverified assumptions)

Update rules: each row lists the trigger outcome and the exact doc sections to revise (`plugin-ui-v1.md` unless noted). After edits, bump the doc’s revision note (§1 header) and record in §13 decision log.

| Outcome (spike verdict) | Doc sections to revise |
|---|---|
| **G1 PASS** (third-party bundle discovered/served/activated) | §10 packaging bullet: state `dsh.client` + `exports["./client"]` + `files` + built-bundle-in-tarball requirement verbatim (H1). §12 risk 5 note. Nothing else changes. |
| **G1 FAIL with duplicate-source or scan-miss** | Freeze M0; §12 risk 5 upgraded to blocker + upstream issue filed; record failure text in §12. |
| **G2 PASS via `conversation.session.header.actions`** | §3.3: replace “标题栏无第三方槽位时回退…” uncertainty with the confirmed slot name + registration idiom (actions list, order). §7.7 keeps `/memory` as secondary only if L19 passed; otherwise §7.7 rewritten to the secondary entry actually proven (view tab/settings section). §11 S0 内容 1 line updated. |
| **G2 FAIL/partial (no header actions)** | §3.3 fallback branch becomes the *primary* plan until upstream; entry = `conversation.view` tab + `settings.section`; §12 risk 1 verdict text; M0 acceptance (§11) reworded to the proven entry. |
| **G3 channel = custom-route SSE/HTTP** | §8.1 rewritten: transport = host `ctx.webServer` prefix routes + browser fetch/SSE (third-party), with sanitization/§9 unchanged; “inject api-remote 模式第三方等价物” claim replaced; snapshot+delta + sequence + degrade wording (§8.3) verified against the chosen channel; §5.1 “服务层” contract note: reads ride the same routes until upstream `ctx.remote` extension; add upstream-request tracker line to §12 risk 2. |
| **G3 channel = projections (log-derived only)** | §8.2 delta table gains per-delta provenance: which deltas are log-derived (usage/citation/evidence/rollout/consolidation/audit if audit writes become log events) vs which need the secondary channel; §8.1 documents fold semantics + `stateVersion`; §5.1 adds projection unit definitions to the service table; §7 UI reads via `useProjection` faces (type augmentation discipline noted in §10). |
| **G3 = polling only** | §8.1: push deferred; M0 acceptance carries the degraded badge; §12 risk 2 = blocker with upstream request owner; §11 M0 content shrinks to polling-based read workbench. |
| **G4 PASS (standalone build contract)** | §10 packaging bullet expanded with the standalone build recipe (entry file shape, external list = 8 seed words, tsdown config, CSS convention, dist/files discipline) — keep as a link to a `docs/dev/client-bundle.md` if length demands. |
| **G5 PASS (third-party HMR)** | §10 dev-flow note: HMR usable outside the monorepo with any watcher rewriting the installed `lib/client.js`; `pollIntervalMs` config documented. |
| **L20 jump PASS/partial** | §7.5 回链 sentence gains the real mechanism (openView+focus / loadThrough); FAIL keeps text-reference fallback, §12 risk 3 closed with fallback wording. |
| **L19 no UI opener** | §7.7/§12 risk 1: replace “/memory 斜杠命令唤起同一界面” with the proven entry; optionally keep `/memory` as an agent-scoped command (no UI opening) if desired for chat discoverability — design must say which. |
| **P3 mount strategy resolved (root vs preset plane)** | §5/§3.1 host-half placement in web: document the row placement + any profile/preset config; §8.1 event-source sentence updated to what actually flows in the web profile; if preset-plane is required, §3.1 “同包，node” host half gains a note that memcurio mounts per agent session in web and cross-instance concurrency guarantees (§1.1) now also cover per-session instances. |
| **Any rc.1 contract drift discovered** | §12 risk 5 discipline: run the [checklist](s0-spike-checklist.md); update the design’s reference-version note before M0. |

---

## 8. Citation appendix (upstream artifact paths)

All paths relative to the rc.1 install root `…/node_modules/@deepseek-ai/`; line numbers approximate the shipped files as installed (`lib/` is compiled from the package `src/` of the same name).

- `dsh-client-modules/README.md` (declaration, sharing/externals, build requirements, lazy model, /plugins serving); `dsh-client-modules/lib/index.js` (scan/registry/route/boot injection; lines cited in L1–L4); `dsh-client-modules/lib/client.js` + `lib/types/client/manifest.d.ts` + `…/system.d.ts` (L5–L6).
- `dsh-client-ui-goal/package.json` (`dsh.client` declaration incl. `inject` list), `README.md` (projection-mode design, slots), `lib/client.js` (plugin face + slots registration idiom), `lib/types/client/*.d.ts`.
- `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts` (conversation slot map), `lib/client.js` (header/view rendering, slots service usage, view ledger), `package.json`.
- `dsh-client-ui-settings/lib/types/client/contract/slots.d.ts`, `README.md` (settings slot contract, L18).
- `dsh-client-ui-chat/lib/client.js`, `dsh-client-ui-trajectory/lib/client.js` (official `conversation.view` registrants).
- `dsh-api-remotes/README.md`, `package.json` (closed assembly, L10).
- `dsh-session-projection/README.md`, `lib/types/index.d.ts`, `lib/types/types.d.ts` (open registry + merge-extensible tables, L11/L11a).
- `dsh-host-webserver/README.md` (route registration, no origin policy, SSE/compression notes, L12).
- `dsh-web-app/cordis.patch.yml` (browser roster rows, client-modules/client-hmr comments, agent-plane/preset section), `dsh-web-app/README.md` (web GUI invocation, token/cookie, trust fence).
- `dsh-api-session-controller/lib/types/client/contract/snapshot.d.ts`, `…/sessions/service.d.ts`, `…/client/scope.d.ts`, `README.md` (identity + loadThrough, L13/L20).
- `dsh-client-hmr/README.md` (L14).
- `dsh-web-frontend/dist/assets/index-*.js` (shell boot: `staticModules` seed construction, L15).
- `dsh/README.md`, `dsh/lib/plugin-*.js`, `dsh-home-paths/README.md`, `dsh-agent-presets/README.md` (L16–L17).
- `dsh-commands/README.md` (L19).
- Design baseline: `docs/design/plugin-ui-v1.md` §3.3 (lines ~120-122), §5.1, §7.5-§7.7, §8, §10, §11 S0 (lines ~334-342), §12 (lines ~365-376).
