# docs-sync-only — project profile for `@yadimon/llm-clash`

## Documentation files (sources of truth)

- `README.md` — primary user-facing documentation. Quick start, model specs,
  options, library API, troubleshooting, contributor section.
- `docs/config.md` — YAML config reference and final-mode descriptions.
- `AGENTS.md` — Conventional-Commits + package workflow rules for agents.
- `CONTRIBUTING.md` — dev setup, PR expectations.
- `RELEASING.md` — first-publish bootstrap and ongoing-release workflow.
- `SECURITY.md` — vulnerability reporting policy. **Out of scope for routine
  doc-sync.** Touch only on explicit request.
- `examples/task.yaml` — runnable YAML example used in README.
- `examples/smoke/*.yaml` — fixtures for smoke tests; the explicit `finalMode`
  here is intentional and must NOT be touched to "follow the new default".

## Sources of code truth

- CLI surface: `src/cli/run.ts` (subcommands, `--final` default lives at the
  orchestrator layer, not the CLI).
- Spec syntax / shortcuts: `src/cli/modelSpec.ts` — see `BARE_SHORTCUTS` and
  `KNOWN_SPEC_PREFIXES`.
- Auto-selection flow + persisted prefs path: `src/cli/autoSelect.ts`,
  `src/cli/preferences.ts`, `src/cli/detection.ts`.
- Defaults (`finalMode`, `rounds`, weights): `src/core/orchestrator.ts`
  in `normalizeConfig`.

## Recurring drift hotspots

- Default `finalMode` value — keep README, `docs/config.md`, and the
  orchestrator JSDoc aligned. Currently `choose_or_synthesize`.
- README spec table vs `BARE_SHORTCUTS` — when shortcuts change, both must
  update. Same for the `KNOWN_SPEC_PREFIXES` list (used by `looksLikeModelSpec`).
- `examples/task.yaml` model list — README references this file; if you change
  one, eyeball the other.

## Verification commands

- `npm run check` — full quality gate (format, lint, typecheck, tests, build,
  pack dry-run). Run before declaring docs synced.
- `npm run smoke:agents:core` — end-to-end with real local CLIs; **only when
  contributors have those CLIs installed**, not for normal doc work.

## Generated files (never edit)

- `dist/**` — `tsc` build output.
- `coverage/**` — vitest coverage.
- `.runs/**` — runtime artifacts.
- Any `*.tgz` files at repo root.
