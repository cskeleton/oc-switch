# oc-switch Architecture Optimization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the low-risk architecture optimization slices from the 2026-06-26 draft without changing product behavior.

**Architecture:** Keep Core as the only local file write layer. Reuse the existing `json-state-store.ts` for oc-switch state files, and reduce Web test churn with local response fixture builders.

**Tech Stack:** Bun, TypeScript, React/Vite, existing Core state helpers and test suites.

---

## Scope

- Implement Slice 1 for `settings.json`, `manifest.json`, and `token.json`.
- Implement Slice 5 short-term fixture builders for Web tests.
- Do not split Server routes, CLI commands, or Core operations in this pass.
- Do not change REST paths, CLI output, OpenClaw config semantics, or secret handling.

## Files

- Modify: `packages/core/src/json-state-store.ts`
- Modify: `packages/core/src/paths.ts`
- Modify: `packages/core/src/manifest-manager.ts`
- Modify: `packages/core/src/token-manager.ts`
- Modify: `packages/core/test/json-state-store.test.ts`
- Modify: `packages/core/test/paths.test.ts`
- Modify: `packages/core/test/manifest-manager.test.ts`
- Modify: `packages/core/test/token-manager.test.ts`
- Create: `packages/web/src/test-fixtures.ts`
- Modify: `packages/web/src/views.test.tsx`

## Tasks

### Task 1: State Store Policies

- [ ] Add a strict invalid JSON policy to `readJsonState` so callers can keep existing throw behavior.
- [ ] Add tests proving default fallback behavior and strict throw behavior.
- [ ] Keep `writeJsonState` pretty printed, newline terminated, atomic, directory `0700`, and file `0600`.

### Task 2: Migrate Core State Files

- [ ] Change `readOcSwitchSettings` and `writeOcSwitchSettings` to use `readJsonState` and `writeJsonState`; invalid settings still return `{}`.
- [ ] Change `readManifest` and `writeManifest` to use `readJsonState` and `writeJsonState`; invalid manifest JSON still throws.
- [ ] Change `readPersistedToken` and `writePersistedToken` to use `readJsonState` and `writeJsonState`; invalid token JSON still returns `undefined`.
- [ ] Add focused tests for fallback/throw behavior, trailing newline, and private permissions.

### Task 3: Web Fixture Builders

- [ ] Add `providerSummary(overrides)` and `modelSummary(overrides)` builders with defaults for required response fields.
- [ ] Replace repeated full `ProviderSummary` and `ModelSummary` literals in `views.test.tsx` with builders.
- [ ] Keep test intent visible by only overriding fields relevant to each test.

### Task 4: Verification and Sync Audit

- [ ] Run focused Core and Web tests after each slice.
- [ ] Run full `bun run check` before reporting completion.
- [ ] Compare implemented changes against `docs/superpowers/specs/2026-06-26-oc-switch-architecture-optimization-draft.md` and report any intentional deferrals.
