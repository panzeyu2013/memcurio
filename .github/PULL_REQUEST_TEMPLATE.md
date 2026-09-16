## Intent

What this change does and why. One paragraph max; link issues if any.

## Non-goals

What this change deliberately does NOT do (keeps review scope honest).

## Validation

State the exact commands run and their outcomes — never claim runtime
correctness from static checks alone:

```sh
bun install --frozen-lockfile
bun run build && bun run typecheck && bun run lint && bun test
bun run pack:check                     # rebuild + package allowlist + dist reverse check
bun run verify:workflows               # action pins + release structure (when .github/ changes)
bun test tests/<file>.test.ts          # focused suites for the touched area
```

For behavioral/UI changes: point at the jsdom/render tests or the live evidence
added or updated. For release/infra changes: state that a dry run was executed
(`workflow_dispatch` with `dry_run: true`, per `docs/operations.md` →
发布流程 → Manual dispatch / dry run).

## Risks

Anything a reviewer should probe (new store-key/scope edge cases, secret
handling, event races, session lifecycle, packaging surface, migration of an
existing store).
