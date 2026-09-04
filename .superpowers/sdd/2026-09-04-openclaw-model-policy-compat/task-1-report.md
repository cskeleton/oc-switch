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

## Fix round 1 (review findings)

### Changed files

- `docs/superpowers/specs/2026-06-26-oc-switch-config-status-design.md`
  - Fixed the normative `health:model-policy-not-covered:modelPolicy.allow` issue contract: source `health`, severity `warning`, global exact ID, legacy metadata trigger, and required detail/action meaning.
  - Added the fixed additive `ConfigStatusModelPolicy` raw DTO with `mode`, `policyEntryCount`, `effectiveCatalogCount`, and `unknownProviderRefs`.
  - Defined policy-only/unknown-Provider behavior and no-secret constraints.
  - Defined malformed non-array and non-string array-entry behavior with fixed blocking issue IDs and zero-based indexes.
- `AGENTS.md`
  - Added the same model-policy coverage issue and malformed-policy rules for repository-wide consistency.
- `docs/acceptance-checklist.md`
  - Marked older allowlist rows as legacy-mode behavior.
  - Added P7–P9 for coverage issue, raw modelPolicy diagnostics, and malformed policy handling.
- This report was appended with this fix-round section.

### Tests/commands/output

- `git status --short --branch` before changes: clean except the existing committed Task 1 state (`main` ahead by one commit).
- `git diff --check`: passed before the fix commit.
- `bun run check`: passed after the fix-round edits: 640 core/CLI/server tests, 111 Web tests, typecheck, and Web build.

### Self-review

- The four valid mode names remain exactly `legacy`, `unrestricted`, and `restricted`.
- The fixed coverage issue cannot be duplicated per ref and explicitly distinguishes legacy metadata from restricted selection.
- `unknownProviderRefs` contains only string exact refs, excludes wildcard/non-string entries, and is informational raw data only.
- Malformed policy remains fail-visible: non-array is legacy-compatible but blocking; invalid array entries are preserved/ignored and individually blocking.
- Existing no-secret, Provider disabled-state independence, Core-only writer, wildcard immutability, and per-agent scope constraints remain unchanged.

## Fix round 2 (review findings)

### Changed files

- `docs/superpowers/specs/2026-06-26-oc-switch-config-status-design.md`
  - Added `policyOnlyExactRefs` and `knownProviderUnknownModelRefs` to the fixed `ConfigStatusModelPolicy` raw DTO.
  - Defined policy-only as string exact policy refs absent from `agents.defaults.models`; the known-provider/unknown-model list is its explicit subset. Wildcards and non-string entries are excluded.
  - Fixed `policyEntryCount` to `0` for non-array `allow` and retained the malformed-policy issue semantics.
- `AGENTS.md`
  - Mirrored the fixed raw DTO fields and exact-ref diagnostic semantics.
- `docs/acceptance-checklist.md`
  - Expanded P8 to cover both exact-ref diagnostic lists and their exclusion rules.
- This report was appended with this fix-round section.

### Tests/output

- `bun run check`: passed after the fix-round edits: 640 core/CLI/server tests, 111 Web tests, typecheck, and Web build.
- `git diff --check`: passed before commit.

### Self-review

- Existing valid mode names and all prior issue IDs are unchanged.
- `policyOnlyExactRefs` is directly testable for known catalog refs, known-provider/unknown-model refs, and unknown-provider refs; `knownProviderUnknownModelRefs` is explicitly a subset.
- All diagnostic lists are refs-only, ordered by policy occurrence and deduplicated; wildcard and non-string entries are excluded.
- Non-array `allow` now has an explicit safe raw count of `0`, remains legacy-compatible, and still emits the blocking malformed-policy issue.
