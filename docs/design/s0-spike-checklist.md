# S0 Spike — Run card & per-upgrade re-verification checklist

> Companion to [`docs/design/s0-spike-plan.md`](s0-spike-plan.md). Fill one row per step during the S0 run; the bottom section is the §12-5 discipline: **rerun it on every DSH upgrade before trusting the client contract again** (the reference-version rule in the design header).
> Artifact root `N` = the rc.1 install tree used by the run.

## A. Pre-flight (P0)

- [ ] `DSH_HOME` = fresh disposable dir; path recorded: `________`
- [ ] Versions recorded: node `____` (>= 22.13), bun `____` (1.3.14 pin), dsh `____` (must be 0.1.2-rc.1), install tree `____`
- [ ] `dsh --profile web --no-open --port 0` boots; startup URL captured; page renders in the real browser
- [ ] Debug-logging knob for this rc.1 found and recorded (how to see `client-modules` / plugin logs)
- [ ] `--dump-config` inventory saved (`artifacts/p0-composed-tree.yml`); browser roster rows counted `____`

## B. Control & discovery (P1–P2)

- [ ] Control: official `dsh-client-ui-goal` bundle URL fetched 200; no `client-modules:` console errors
- [ ] Scratch spike package `@memcurio-spike/s0-client` built (`lib/client.js` = `window.__ModuleLoader__.load({…})` shape)
- [ ] Negative probe done: unlisted non-seed `require` throws the documented runtime miss text (snippet saved)
- [ ] `dsh plugin --profile <spike-web> add <tarball>` succeeds; `--dump-config` shows the row
- [ ] Activation failure reproduced once with `lib/client.js` absent (missing-bundle error text saved)
- [ ] Hello entries render: header action button ☐ / settings.section page ☐ / conversation.view tab ☐
- [ ] Gate G1: PASS ☐ PARTIAL ☐ FAIL ☐  — failure text (if any): `________`

## C. Host mount strategy (P3)

- [ ] Root-plane probe result (inject resolution, row state): `________`
- [ ] Preset-plane probe result (`.agent-presets` copy, per-session activation): `________`
- [ ] Chosen strategy recorded; duplicate-source (H2) avoided
- [ ] Session events flow from the active browser session to the memcurio host half in the web profile: YES ☐ NO ☐

## D. UI surface & governance (P4)

- [ ] Header actions slot shows the button; click opens the placeholder view
- [ ] View tab row (>1 roster) shows “Memory”; body mounts only for the active tab
- [ ] Settings section `memory-spike` renders
- [ ] Unknown-slot registration behavior captured (throw text / ignore): `________`
- [ ] Second registrant into a `single` slot behavior captured: `________`
- [ ] `/memory`-as-UI-opener probe verdict (L19): `________`
- [ ] Jump-to-message probe verdict (L20): `________`
- [ ] Gate G2: PASS ☐ PARTIAL ☐ FAIL ☐ — failing surface + error: `________`

## E. Bridge (P5)

- [ ] `ctx.remote` third-party namespace: unavailable (expected) — evidence: `________`
- [ ] Projection channel: log-derived event updates client face: YES ☐ NO ☐; non-log state reaches client: YES ☐ NO ☐ (L11a)
- [ ] Custom prefix route: unary fetch status `____`; cookie/Origin behavior: `________`
- [ ] SSE stream from custom route: frames/sec `____`; host event → delta mapping demoed
- [ ] Polling baseline: interval/latency `________`
- [ ] Gate G3 (channel chosen for M0): SSE ☐ projections ☐ polling ☐ — upstream request needed: YES ☐ (owner `____`) NO ☐

## F. HMR (P6)

- [ ] Watcher rewrites installed `lib/client.js` → page swaps without reload: YES ☐ NO ☐
- [ ] Failed-reload path observed (visible error, retry on next rebuild): YES ☐ NO ☐

## G. S0 deliverable (P7)

- [ ] S0-A1: title-bar single button opens the placeholder workbench in the real GUI
- [ ] S0-A2: one host event reaches the browser; counter + last-event line update (≥5 events)
- [ ] S0-A3: verdicts for §12 items 1–5 written into the S0 report
- [ ] Degraded/poll badge verified when push channel absent (if applicable)
- [ ] Artifacts archived; design-doc updates proposed per plan §7; checklist archived with report

## H. Per-upgrade re-verification (§12 risk 5 — run before trusting the client contract on a NEW DSH version)

New version under test: `________` (npm version / commit). Date: `________`.

- [ ] `dsh.client` declaration grammar unchanged: `platform`, `inject`, `external`, `immediately` parse the same (`N/dsh-client-modules/lib/index.js` `parseDshClient`)
- [ ] `exports["./client"]` still required and resolved the same way
- [ ] Discovery still scans live loader entries with **no allowlist** introduced; duplicate-source rule unchanged
- [ ] Missing-bundle activation error message still names package + path + build instruction
- [ ] `/plugins` route + combo/immutable/404 semantics unchanged
- [ ] `__DSH_BOOT__` wire shape (`entries`/`batches`, `id/url/rev/inject/immediately/external`) unchanged — or migration deltas recorded
- [ ] Seed table (staticModules) unchanged or re-enumerated from the shell bundle (8 keys today: react, react/jsx-runtime, react-dom, react-dom/client, @deepseek-ai/cordis, dsh-client-store, dsh-client-ui-slots, dsh-client-ui-primitives)
- [ ] Bundle registration shape (`window.__ModuleLoader__.load({id, factory})`, id == package name) unchanged
- [ ] Conversation slots still declared by ui-conversation: `conversation.session.header.actions` (list), `conversation.view` (list), `settings.section` (list) — names/kinds/scopes unchanged
- [ ] `ctx.remote` assembly still closed to third parties (api-remotes README limitations unchanged) — or the opened path documented and adopted
- [ ] `ctx.sessionProjections` registry still open; frame delivery (`session/projection`) unchanged
- [ ] `ctx.webServer.register` prefix/SSE behavior unchanged (auth/Origin posture)
- [ ] `dsh-client-hmr` still mounted in the web profile; swap contract unchanged
- [ ] Profile/CLI mechanics unchanged: `dsh plugin --profile <name> add`, bundle-layer reconcile, `--dump-config`
- [ ] Web profile still composes the agent plane behind presets (host-plane vs preset-plane decision still valid)
- [ ] Design reference-version note (`plugin-ui-v1.md` header) updated; contract verdicts re-pinned in `s0-spike-plan.md` ledger statuses
