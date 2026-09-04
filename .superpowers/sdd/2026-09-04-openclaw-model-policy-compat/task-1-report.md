# Task 1 implementation report

## Status

Implemented the contract-only amendment for OpenClaw `modelPolicy.allow` compatibility. No production code, real OpenClaw configuration, secrets, or snapshots were changed.

## Files changed

- `docs/superpowers/specs/2026-06-25-oc-switch-model-editing-design.md`
  - Defined `legacy`, `unrestricted`, and `restricted` policy modes and precedence.
  - Defined effective enabled state and `ModelSelectionSource` semantics.
  - Documented exact, provider-wide, and namespace trailing wildcard behavior.
  - Added fail-closed rules for wildcard-sensitive disable, rename, and cleanup operations.
  - Added `ModelSummary.selectionSource`, `StatusSummary.modelPolicyMode`, `StatusSummary.effectiveModelCount`, and compatibility retention of `allowlistModelCount`.
- `docs/superpowers/specs/2026-06-26-oc-switch-config-status-design.md`
  - Added the same exact DTO/type names and mode precedence.
  - Documented status counting, policy-only refs, wildcard immutability, Provider disabled independence, and out-of-scope per-agent policy.
  - Added config-status acceptance criteria.
- `AGENTS.md`
  - Updated repository-wide model policy, DTO, wildcard mutation, and scope rules.
- `docs/acceptance-checklist.md`
  - Added P1–P6 acceptance rows covering `cpa/*`, `grok2api/*`, policy-only exact refs, empty/absent policy, wildcard rejection, disabled state, rename, and batch cleanup.
- `.superpowers/sdd/2026-09-04-openclaw-model-policy-compat/task-1-report.md`
  - This report.

## Tests and commands

- `git diff --check` — passed.
- `bun run check` — passed: 640 core/CLI/server tests, 111 Web tests, typecheck, and Web build.

## Self-review

- The exact required type names and literal unions are repeated consistently in both specs and `AGENTS.md`.
- Missing `modelPolicy.allow` and explicit `[]` remain distinct.
- Restricted mode explicitly treats `agents.defaults.models` as alias/per-model metadata only.
- Provider disabled state is described as independent and higher priority for effective availability.
- Wildcards are read/matched but never implicitly expanded, deleted, or rewritten; unsafe mutation is fail-closed even with `force`.
- Acceptance guidance is contract-focused and does not require real configuration or secret data.

## Concerns

- This task intentionally changes documentation only. The current implementation and its tests still need the later Core/Server/Web tasks to expose and enforce every newly normative DTO and wildcard mutation rule.
- Existing older acceptance rows still use “allowlist” as shorthand for `agents.defaults.models`; later task updates should distinguish legacy metadata from effective policy counts where they exercise restricted configurations.
