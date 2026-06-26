# oc-switch Architecture Optimization Slices 2-6 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the remaining architecture optimization slices from the 2026-06-26 draft in the order Slice 2 -> Slice 3 -> Slice 4 -> Slice 6, while keeping behavior stable.

**Architecture:** Slice 2 splits Core operations by domain with `operations.ts` as a compatibility re-export. Slice 3 splits Server routes behind a shared runtime context while preserving every REST endpoint. Slice 4 splits CLI command registration behind a shared command context while preserving command names, output, and exit behavior. Slice 6 is gated by a dedicated config-status design spec before adding a unified status read endpoint.

**Tech Stack:** Bun, TypeScript, Hono, Commander, React/Vite client types, existing `@oc-switch/core` modules and test suites.

---

## Branch and Workflow

- Continue on branch `codex/architecture-optimization`.
- Do not create a git commit unless the user explicitly asks.
- Do not push.
- Do not include unrelated `docs/` or `.cursor/` files in future commits unless the user explicitly asks.
- Run verification after each slice, not only at the end.
- Default execution is serial: Slice 2, then Slice 3, then Slice 4, then Slice 6. Slice 3 and Slice 4 can be parallelized only if they run in separate worktrees after Slice 2 is complete, because both depend on stable Core exports and both are large import churn diffs.

If the user explicitly asks for commits later, use one commit per independently verified slice:

- Slice 2 Core split
- Slice 3 Server route split
- Slice 4 CLI command split
- Slice 6 config-status spec
- Slice 6 config-status implementation, only after spec acceptance

Do not combine all slices into one big final commit unless the user explicitly asks for a squash-style commit.

## Review Decisions

These decisions resolve the plan review questions from 2026-06-26.

1. `ConfigStatusReport` is the versioned v1 DTO contract for `GET /api/config-status`, but not a new shared package contract. Core owns the type and Web mirrors it in `packages/web/src/api.ts` until a separate contracts package is justified.
2. In `ConfigStatusReport`, source-specific fields are raw facts for drill-down. `issues[]` is the canonical, deduplicated action list. Summary issue counts are derived only from `issues[]`; source-specific counts are derived from their raw source arrays.
3. Issue de-duplication key is `source:kind:subject`. For example, the same missing env key should produce one `env:missing:KEY_NAME` issue even if both provider refs and env inspection see it.
4. Slice 6 first implementation is API-only for Web: add Web API client types and `getConfigStatus()`, but do not wire Dashboard, Providers, Models, or Settings UI in this plan. UI adoption needs a follow-up product/UI spec.
5. `/api/health` is frozen as the legacy case-duplicate health endpoint. Do not add new status categories to `/api/health`; new status sources go to `/api/config-status`. Any later aliasing or deprecation of `/api/health` requires a separate compatibility spec.
6. Slice 3 and Slice 4 default to serial execution. They may be parallelized only after Slice 2, and only with explicit coordination around import/export churn.
7. CLI `status` and `health` do not stay in `packages/cli/src/index.ts`. They move to `packages/cli/src/commands/status.ts`, keeping `index.ts` as program assembly only.
8. `AGENTS.md` **先不更新**；架构优化进度与已确认决策以本 plan「用户确认决策」小节为准，待 Slice 2–6 阶段性完成后由用户决定是否同步。

## Scope

Included:

- Slice 2: split `packages/core/src/operations.ts` into focused operation modules.
- Slice 3: split `packages/server/src/app.ts` into runtime context, error helper, and route modules.
- Slice 4: split `packages/cli/src/index.ts` into command context and command modules.
- Slice 6: write the required config-status product spec first, then add a unified read endpoint if the spec is accepted.

Excluded:

- No behavior change to OpenClaw config semantics.
- No private oc-switch fields in `openclaw.json`.
- No REST path/status/response shape change for existing endpoints.
- No CLI command/output/exit-code change for existing commands.
- No Web UI redesign in this plan.
- No contracts package in this plan.

## Existing Baseline

Before implementing Task 1, run:

```bash
bun run check
```

Expected: PASS. If it fails before any code changes in this plan, stop and report the existing failure.

Current known large files:

- `packages/core/src/operations.ts`
- `packages/server/src/app.ts`
- `packages/cli/src/index.ts`

Current compatibility exports:

- `packages/core/src/index.ts` exports `./operations`.
- Server imports operation functions from `@oc-switch/core`.
- CLI imports operation functions from `@oc-switch/core`.

---

## Target File Structure

### Slice 2 Core

- Create `packages/core/src/operation-common.ts`
  - Owns `OperationResult`, `ensureDefaults`, and `hasProviderModel`.
- Create `packages/core/src/model-operations.ts`
  - Owns model lifecycle operations:
    - `setPrimaryModel`
    - `disableModel`
    - `enableModel`
    - `addProviderModel`
    - `updateProviderModel`
    - `removeProviderModel`
    - `definedRefs`
- Create `packages/core/src/provider-operations.ts`
  - Owns provider CRUD and add/import operations:
    - `deleteProvider`
    - `removeProvider`
    - `editProvider`
    - `addProviderFromPreset`
    - `addCustomProvider`
- Create `packages/core/src/provider-lifecycle.ts`
  - Owns reversible provider disable/restore:
    - `DisableProviderResult`
    - `disableProvider`
    - `restoreDisabledProvider`
- Modify `packages/core/src/operations.ts`
  - Compatibility re-export only:

```ts
export * from "./operation-common";
export * from "./model-operations";
export * from "./provider-operations";
export * from "./provider-lifecycle";
```

- Modify `packages/core/src/index.ts`
  - Keep `export * from "./operations";` unchanged for compatibility.
- Split tests:
  - Create `packages/core/test/model-operations.test.ts`
  - Create `packages/core/test/provider-operations.test.ts`
  - Create `packages/core/test/provider-lifecycle.test.ts`
  - Keep `packages/core/test/operations.test.ts` as a small compatibility test.

### Slice 3 Server

- Create `packages/server/src/context.ts`
  - Owns runtime state and shared helpers:
    - `AppOptions`
    - `AppRuntime`
    - `createAppRuntime(options: AppOptions): AppRuntime`
    - `readConfig(paths: OcSwitchPaths): OpenClawConfig`
    - `readEnvContent(paths: OcSwitchPaths): string | undefined`
    - `providerEnvVar(config: OpenClawConfig, providerId: string): string | undefined`
    - `assertProviderCanEnable(paths: OcSwitchPaths, providerId: string): void`
    - `withDisabledStatus(paths: OcSwitchPaths, providers: ProviderSummary[]): ProviderSummary[]`
- Create `packages/server/src/errors.ts`
  - Owns `jsonError`.
- Create route modules:
  - `packages/server/src/routes/health.ts`
  - `packages/server/src/routes/providers.ts`
  - `packages/server/src/routes/models.ts`
  - `packages/server/src/routes/presets.ts`
  - `packages/server/src/routes/backups.ts`
  - `packages/server/src/routes/settings.ts`
  - `packages/server/src/routes/env.ts`
- Modify `packages/server/src/app.ts`
  - Owns Hono app creation, CORS, auth middleware, runtime creation, and route registration only.
- Keep `packages/server/test/app.test.ts` endpoint-focused.

### Slice 4 CLI

- Create `packages/cli/src/command-context.ts`
  - Owns shared CLI helpers:
    - `createCommandContext()`
    - `activePaths()`
    - `readConfig()`
    - `readEnvContent()`
    - `assertProviderCanEnable(providerId: string)`
    - `providerEnvVar(config: OpenClawConfig, providerId: string)`
    - `presetDirs()`
    - `mockSyncFetch()`
    - `defaultEnvName(providerId: string)`
    - `parseModelIds(value: string)`
    - `parseAliasMap(value: string | undefined)`
- Create command modules:
  - `packages/cli/src/commands/status.ts`
  - `packages/cli/src/commands/providers.ts`
  - `packages/cli/src/commands/models.ts`
  - `packages/cli/src/commands/backups.ts`
  - `packages/cli/src/commands/presets.ts`
  - `packages/cli/src/commands/serve.ts`
  - `packages/cli/src/commands/token.ts`
- Modify `packages/cli/src/index.ts`
  - Owns shebang, `Command` creation, metadata, command registration calls, and `program.parse()`.
- Keep `packages/cli/test/cli.test.ts` behavior-focused.

### Slice 6 Config Status

- Create `docs/superpowers/specs/2026-06-26-oc-switch-config-status-design.md`
  - This spec must be accepted before code changes for Slice 6.
- Proposed implementation files after spec acceptance:
  - Create `packages/core/src/config-status.ts`
  - Modify `packages/core/src/index.ts`
  - Add `packages/core/test/config-status.test.ts`
  - Add `GET /api/config-status` in `packages/server/src/routes/health.ts`
  - Add server tests in `packages/server/test/app.test.ts`
- Add Web API type and client method in `packages/web/src/api.ts`
- Add API client test in `packages/web/src/api.test.ts`
- Do not modify Dashboard, Providers, Models, or Settings UI in the first Slice 6 implementation.

---

## Slice 2: Core Operations Split

### Task 1: Add Core Operation Common Module

**Files:**

- Create: `packages/core/src/operation-common.ts`
- Modify: `packages/core/src/operations.ts`
- Test: `packages/core/test/operations.test.ts`

- [ ] **Step 1: Create `operation-common.ts`**

Move `OperationResult`, `ensureDefaults`, and `hasProviderModel` from `operations.ts` into:

```ts
import { parseModelRef } from "./model-ref";
import type { OpenClawConfig } from "./types";

export interface OperationResult {
  config: OpenClawConfig;
  warnings: string[];
}

export function ensureDefaults(config: OpenClawConfig): void {
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.models ??= {};
  config.models ??= {};
  config.models.providers ??= {};
}

export function hasProviderModel(config: OpenClawConfig, ref: string): boolean {
  const { providerId, modelId } = parseModelRef(ref);
  const provider = config.models?.providers?.[providerId];
  return Boolean(provider?.models?.some((model) => model.id === modelId));
}
```

- [ ] **Step 2: Update `operations.ts` imports temporarily**

In `packages/core/src/operations.ts`, import:

```ts
import { ensureDefaults, hasProviderModel, type OperationResult } from "./operation-common";
```

Delete the local `OperationResult`, `ensureDefaults`, and `hasProviderModel` definitions from `operations.ts`.

- [ ] **Step 3: Run focused Core tests**

Run:

```bash
bun test packages/core/test/operations.test.ts
```

Expected: PASS.

### Task 2: Extract Model Operations

**Files:**

- Create: `packages/core/src/model-operations.ts`
- Modify: `packages/core/src/operations.ts`
- Create: `packages/core/test/model-operations.test.ts`
- Modify: `packages/core/test/operations.test.ts`

- [ ] **Step 1: Create `model-operations.ts`**

Move these functions and private helpers from `operations.ts`:

- `assertPrimaryRemovalAllowed`
- `setPrimaryModel`
- `disableModel`
- `enableModel`
- `assertPositiveInteger`
- `assertProviderModelInput`
- `applyProviderModelInput`
- `upsertAllowlistEntry`
- `addProviderModel`
- `updateProviderModel`
- `removeProviderModel`
- `definedRefs`

The top of the new file should start with:

```ts
import { formatModelRef, parseModelRef } from "./model-ref";
import { ensureDefaults, hasProviderModel, type OperationResult } from "./operation-common";
import type { AllowlistEntry, OpenClawConfig, OpenClawModel, ProviderModelInput } from "./types";
```

- [ ] **Step 2: Create model operation tests**

Move these test cases from `packages/core/test/operations.test.ts` into `packages/core/test/model-operations.test.ts`:

- `sets primary model only when provider and model exist`
- `disables and re-enables allowlist entry while preserving provider model`
- `addProviderModel > creates provider model and optional allowlist alias`
- `addProviderModel > adds model to existing provider with slash id`
- `provider model editing > adds structured model fields and allowlist entry`
- `provider model editing > updates model id while preserving unknown fields and migrating allowlist and primary`
- `provider model editing > disables edited model without deleting provider model`
- `provider model editing > rejects duplicate model ids and invalid numeric fields`
- `removeProviderModel > removes provider model and allowlist entry`
- `removeProviderModel > refuses removing primary unless forced or newPrimary supplied`

Import model functions from `../src/model-operations`.

- [ ] **Step 3: Keep compatibility coverage**

In `packages/core/test/operations.test.ts`, add a compatibility assertion that imports from `../src/operations`:

```ts
import { expect, test } from "bun:test";
import { setPrimaryModel } from "../src/operations";

test("operations compatibility exports model operations", () => {
  expect(typeof setPrimaryModel).toBe("function");
});
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
bun test packages/core/test/model-operations.test.ts packages/core/test/operations.test.ts
```

Expected: PASS.

### Task 3: Extract Provider Operations

**Files:**

- Create: `packages/core/src/provider-operations.ts`
- Modify: `packages/core/src/operations.ts`
- Create: `packages/core/test/provider-operations.test.ts`
- Modify: `packages/core/test/operations.test.ts`

- [ ] **Step 1: Create `provider-operations.ts`**

Move these functions and private helpers from `operations.ts`:

- `assertProviderPrimaryRemovalAllowed`
- `deleteProvider`
- `removeProvider`
- `editProvider`
- `addProviderFromPreset`
- `normalizeCustomProviderBaseUrl`
- `assertCustomProviderInput`
- `addCustomProvider`

The top of the new file should start with:

```ts
import { formatModelRef, parseModelRef } from "./model-ref";
import { setPrimaryModel } from "./model-operations";
import { ensureDefaults, type OperationResult } from "./operation-common";
import type { CustomProviderInput, OpenClawConfig, OpenClawModel, ProviderPreset } from "./types";
```

- [ ] **Step 2: Create provider operation tests**

Move these test cases from `packages/core/test/operations.test.ts` into `packages/core/test/provider-operations.test.ts`:

- `deletes provider by first path segment only`
- `requires force when deleting provider containing primary`
- `addProviderFromPreset > adds provider, env ref, models, and allowlist`
- `addProviderFromPreset > updates existing provider without dropping unknown fields or unrelated models`
- `provider add from preset > writes provider and allowlist from preset`
- `editProvider > updates baseUrl and env ref without dropping unknown fields`
- `removeProvider > removes only refs whose first segment matches providerId`
- `removeProvider > sets new primary when deleting provider containing primary`
- `addCustomProvider > adds openai-compatible provider, normalizes baseUrl, models, and allowlist`
- `addCustomProvider > uses authHeader for anthropic provider and can skip allowlist`
- `addCustomProvider > preserves full URL input exactly after trimming surrounding whitespace`
- `addCustomProvider > rejects invalid custom provider input`
- `addCustomProvider > 拒绝 case-insensitive 同名 provider`

Import provider functions from `../src/provider-operations`.

- [ ] **Step 3: Extend compatibility coverage**

In `packages/core/test/operations.test.ts`, add:

```ts
import { addCustomProvider, removeProvider } from "../src/operations";

test("operations compatibility exports provider operations", () => {
  expect(typeof removeProvider).toBe("function");
  expect(typeof addCustomProvider).toBe("function");
});
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
bun test packages/core/test/provider-operations.test.ts packages/core/test/operations.test.ts
```

Expected: PASS.

### Task 4: Extract Provider Lifecycle Operations

**Files:**

- Create: `packages/core/src/provider-lifecycle.ts`
- Modify: `packages/core/src/operations.ts`
- Create: `packages/core/test/provider-lifecycle.test.ts`
- Modify: `packages/core/test/operations.test.ts`

- [ ] **Step 1: Create `provider-lifecycle.ts`**

Move `DisableProviderResult`, `disableProvider`, and `restoreDisabledProvider` from `operations.ts`.

The top of the new file should start with:

```ts
import { parseModelRef } from "./model-ref";
import { ensureDefaults, type OperationResult } from "./operation-common";
import type { AllowlistEntry, OpenClawConfig } from "./types";
```

- [ ] **Step 2: Create provider lifecycle tests**

Move these test cases from `packages/core/test/operations.test.ts` into `packages/core/test/provider-lifecycle.test.ts`:

- `provider disable and restore > disables provider by removing only allowlist entries and keeping provider models`
- `provider disable and restore > refuses to disable provider containing the primary model`
- `provider disable and restore > restores disabled provider entries exactly and rejects mismatched refs`

Import lifecycle functions from `../src/provider-lifecycle`.

- [ ] **Step 3: Replace `operations.ts` with compatibility re-exports**

After Tasks 1-4 compile, replace `packages/core/src/operations.ts` content with:

```ts
export * from "./operation-common";
export * from "./model-operations";
export * from "./provider-operations";
export * from "./provider-lifecycle";
```

- [ ] **Step 4: Extend compatibility coverage**

In `packages/core/test/operations.test.ts`, add:

```ts
import { disableProvider, restoreDisabledProvider } from "../src/operations";

test("operations compatibility exports provider lifecycle operations", () => {
  expect(typeof disableProvider).toBe("function");
  expect(typeof restoreDisabledProvider).toBe("function");
});
```

- [ ] **Step 5: Run all Core tests**

Run:

```bash
bun test packages/core
```

Expected: PASS.

### Slice 2 Sync Audit

- [ ] Check `packages/core/src/index.ts` still exports `./operations`.
- [ ] Check Server and CLI imports from `@oc-switch/core` do not need behavior changes.
- [ ] Run:

```bash
bun run typecheck
```

Expected: PASS.

---

## Slice 3: Server Route Split

### Task 5: Extract Server Runtime Context and Errors

**Files:**

- Create: `packages/server/src/context.ts`
- Create: `packages/server/src/errors.ts`
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/app.test.ts`

- [ ] **Step 1: Create `errors.ts`**

Move `isValidationError` and `jsonError` from `app.ts` into:

```ts
function isValidationError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("must be");
}

export function jsonError(c: { json: (body: unknown, status: number) => Response }, error: unknown): Response {
  if (isValidationError(error)) {
    return c.json({ error: (error as Error).message }, 400);
  }
  if (error instanceof Error) {
    return c.json({ error: error.message }, 400);
  }
  return c.json({ error: "Internal server error" }, 500);
}
```

- [ ] **Step 2: Create `context.ts`**

Move `AppOptions`, `readConfig`, `readEnvContent`, `providerEnvVar`, `disabledProviderError`, `assertProviderCanEnable`, and `withDisabledStatus` from `app.ts`.

Expose runtime state with this shape:

```ts
export interface AppRuntime {
  options: AppOptions;
  presetDirs: PresetDirs;
  fetchImpl: FetchImpl;
  currentPaths(): OcSwitchPaths;
  setActivePaths(paths: OcSwitchPaths): void;
}

export function createAppRuntime(options: AppOptions): AppRuntime {
  let activePaths = options.paths ?? getActivePaths();
  const currentPaths = () => activePaths;
  const presetDirs = options.presetDirs ?? defaultPresetDirs(currentPaths().stateDir, options.repoRoot);
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    options,
    presetDirs,
    fetchImpl,
    currentPaths,
    setActivePaths(paths) {
      activePaths = paths;
    }
  };
}
```

- [ ] **Step 3: Update `app.ts` to use runtime**

In `createApp`, replace local `activePaths`, `currentPaths`, `presetDirs`, and `fetchImpl` with:

```ts
const runtime = createAppRuntime(options);
```

Use `runtime.currentPaths()`, `runtime.presetDirs`, and `runtime.fetchImpl` inside routes until route modules are extracted.

- [ ] **Step 4: Run server tests**

Run:

```bash
bun test packages/server/test/app.test.ts
```

Expected: PASS.

### Task 6: Extract Health, Provider, and Model Routes

**Files:**

- Create: `packages/server/src/routes/health.ts`
- Create: `packages/server/src/routes/providers.ts`
- Create: `packages/server/src/routes/models.ts`
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/app.test.ts`

- [ ] **Step 1: Create `routes/health.ts`**

Move these routes from `app.ts`:

- `GET /api/status`
- `GET /api/health`
- `GET /api/diff`

Expose:

```ts
import type { Hono } from "hono";
import type { AppRuntime } from "../context";

export function registerHealthRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/status", (c) => {
    // Existing status body: { ok: true, ...adapter.getStatus() }
  });

  app.get("/api/health", (c) => {
    // Existing inspectConfigHealth response
  });

  app.get("/api/diff", (c) => {
    // Existing diff response and "No backups found" error behavior
  });
}
```

Use the exact bodies from the existing routes.

- [ ] **Step 2: Create `routes/providers.ts`**

Move these routes from `app.ts`:

- `GET /api/providers`
- `POST /api/providers`
- `POST /api/providers/preview`
- `POST /api/providers/custom/preview`
- `POST /api/providers/custom`
- `POST /api/providers/merge-case-duplicates/preview`
- `POST /api/providers/merge-case-duplicates`
- `PATCH /api/providers/:id/state`
- `PUT /api/providers/:id`
- `DELETE /api/providers/:id`
- `POST /api/providers/:id/sync`

Expose:

```ts
import type { Hono } from "hono";
import type { AppRuntime } from "../context";

export function registerProviderRoutes(app: Hono, runtime: AppRuntime): void {
  // Register provider routes in the same order as app.ts currently registers them.
}
```

Use `runtime.currentPaths()`, `runtime.presetDirs`, and `runtime.fetchImpl`.

- [ ] **Step 3: Create `routes/models.ts`**

Move these routes from `app.ts`:

- `GET /api/models`
- `PUT /api/models/primary`
- `PATCH /api/models`
- `POST /api/models`
- `PUT /api/models`
- `DELETE /api/models`

Expose:

```ts
import type { Hono } from "hono";
import type { AppRuntime } from "../context";

export function registerModelRoutes(app: Hono, runtime: AppRuntime): void {
  // Register model routes in the same order as app.ts currently registers them.
}
```

- [ ] **Step 4: Register routes from `app.ts`**

After auth middleware in `createApp`, call:

```ts
registerHealthRoutes(app, runtime);
registerProviderRoutes(app, runtime);
registerModelRoutes(app, runtime);
```

- [ ] **Step 5: Run server tests**

Run:

```bash
bun test packages/server/test/app.test.ts
```

Expected: PASS.

### Task 7: Extract Preset, Backup, Settings, and Env Routes

**Files:**

- Create: `packages/server/src/routes/presets.ts`
- Create: `packages/server/src/routes/backups.ts`
- Create: `packages/server/src/routes/settings.ts`
- Create: `packages/server/src/routes/env.ts`
- Modify: `packages/server/src/app.ts`
- Test: `packages/server/test/app.test.ts`

- [ ] **Step 1: Create `routes/presets.ts`**

Move these routes from `app.ts`:

- `GET /api/presets`
- `POST /api/presets/import`
- `POST /api/presets/export/:id`

Expose `registerPresetRoutes(app, runtime)`.

- [ ] **Step 2: Create `routes/backups.ts`**

Move these routes from `app.ts`:

- `GET /api/backups`
- `POST /api/backups/:id/restore`

Expose `registerBackupRoutes(app, runtime)`.

- [ ] **Step 3: Create `routes/settings.ts`**

Move these routes from `app.ts`:

- `GET /api/settings/paths`
- `PUT /api/settings/paths`
- `GET /api/settings`
- `POST /api/settings/orphans/cleanup`

When moving `PUT /api/settings/paths`, preserve this exact state update:

```ts
runtime.setActivePaths(next);
```

- [ ] **Step 4: Create `routes/env.ts`**

Move these routes from `app.ts`:

- `GET /api/env`
- `POST /api/env/preview`
- `POST /api/env`

Expose `registerEnvRoutes(app, runtime)`.

- [ ] **Step 5: Register routes from `app.ts`**

Call route registration in this order:

```ts
registerHealthRoutes(app, runtime);
registerProviderRoutes(app, runtime);
registerModelRoutes(app, runtime);
registerPresetRoutes(app, runtime);
registerBackupRoutes(app, runtime);
registerSettingsRoutes(app, runtime);
registerEnvRoutes(app, runtime);
```

- [ ] **Step 6: Confirm `app.ts` owns only app assembly**

After extraction, `packages/server/src/app.ts` should contain:

- imports
- `createApp`
- CORS middleware
- auth middleware
- route registration
- `return app`

It should not contain route body business logic.

- [ ] **Step 7: Run server tests and typecheck**

Run:

```bash
bun test packages/server/test/app.test.ts
bun run typecheck
```

Expected: both PASS.

### Slice 3 Sync Audit

- [ ] Compare route paths in new files against the original list in this plan.
- [ ] Confirm all existing `packages/server/test/app.test.ts` tests pass without response assertion changes.
- [ ] Confirm `packages/server/src/index.ts` remains compatible.

---

## Slice 4: CLI Command Split

### Task 8: Extract CLI Command Context

**Files:**

- Create: `packages/cli/src/command-context.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/cli.test.ts`

- [ ] **Step 1: Create `command-context.ts`**

Move these helpers from `index.ts`:

- `activePaths`
- `readConfig`
- `readEnvContent`
- `assertProviderCanEnable`
- `providerEnvVar`
- `presetDirs`
- `mockSyncFetch`
- `defaultEnvName`
- `parseModelIds`
- `parseAliasMap`

Expose them through:

```ts
export interface CommandContext {
  activePaths: typeof activePaths;
  readConfig: typeof readConfig;
  readEnvContent: typeof readEnvContent;
  assertProviderCanEnable: typeof assertProviderCanEnable;
  providerEnvVar: typeof providerEnvVar;
  presetDirs: typeof presetDirs;
  mockSyncFetch: typeof mockSyncFetch;
  defaultEnvName: typeof defaultEnvName;
  parseModelIds: typeof parseModelIds;
  parseAliasMap: typeof parseAliasMap;
}

export function createCommandContext(): CommandContext {
  return {
    activePaths,
    readConfig,
    readEnvContent,
    assertProviderCanEnable,
    providerEnvVar,
    presetDirs,
    mockSyncFetch,
    defaultEnvName,
    parseModelIds,
    parseAliasMap
  };
}
```

- [ ] **Step 2: Update `index.ts` temporarily**

In `index.ts`, create:

```ts
const context = createCommandContext();
```

Replace helper calls with `context.*` before extracting command modules.

- [ ] **Step 3: Run CLI tests**

Run:

```bash
bun test packages/cli/test/cli.test.ts
```

Expected: PASS.

### Task 9: Extract Status, Provider, and Model Commands

**Files:**

- Create: `packages/cli/src/commands/status.ts`
- Create: `packages/cli/src/commands/providers.ts`
- Create: `packages/cli/src/commands/models.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/cli.test.ts`

- [ ] **Step 1: Create `commands/status.ts`**

Move these command registrations from `index.ts`:

- `status`
- `health`

Expose:

```ts
import { createConfigAdapter, inspectConfigHealth } from "@oc-switch/core";
import type { Command } from "commander";
import type { CommandContext } from "../command-context";

export function registerStatusCommands(program: Command, context: CommandContext): void {
  program.command("status").action(() => {
    const status = createConfigAdapter(context.readConfig()).getStatus();
    console.log(`Primary: ${status.primaryModel ?? "(none)"}`);
    console.log(`Providers: ${status.providerCount}`);
    console.log(`Provider models: ${status.providerModelCount}`);
    console.log(`Allowlist models: ${status.allowlistModelCount}`);
  });

  program.command("health").action(() => {
    const report = inspectConfigHealth(context.readConfig());
    if (report.caseDuplicateGroups.length === 0) {
      console.log("未发现 Provider 大小写重复");
      return;
    }
    console.log(`发现 ${report.summary.duplicateGroupCount} 组 Provider 大小写重复：`);
    for (const group of report.caseDuplicateGroups) {
      const flag = group.mergeable ? "可合并" : "需人工核对";
      console.log(`\n[${group.groupKey}] ${group.ids.join(" / ")}  (${group.confidence}, ${flag})`);
      console.log(`  建议保留 ${group.canonicalId}，合并并删除 ${group.duplicateIds.join(", ")}`);
      for (const reason of group.reasons) console.log(`  - ${reason}`);
      if (group.mergeBlockers.length) console.log(`  ⚠ 阻断合并：${group.mergeBlockers.join("；")}`);
      if (group.mergeable) {
        console.log(`  合并命令：oc-switch providers merge-duplicates --group ${group.groupKey} --keep ${group.canonicalId} --remove ${group.duplicateIds.join(",")}`);
      }
    }
  });
}
```

- [ ] **Step 2: Create `commands/providers.ts`**

Move these command registrations from `index.ts`:

- `providers list`
- `providers merge-duplicates`
- `provider add`
- `provider add-custom`
- `provider edit`
- `provider delete`
- `provider disable`
- `provider enable`
- `provider sync`

Expose:

```ts
import type { Command } from "commander";
import type { CommandContext } from "../command-context";

export function registerProviderCommands(program: Command, context: CommandContext): void {
  const providers = program.command("providers");
  const provider = program.command("provider");
  // Move existing command definitions here unchanged.
}
```

- [ ] **Step 3: Create `commands/models.ts`**

Move these command registrations from `index.ts`:

- `models list`
- `use`
- `model disable`
- `model enable`
- `model add`
- `model remove`

Expose:

```ts
import type { Command } from "commander";
import type { CommandContext } from "../command-context";

export function registerModelCommands(program: Command, context: CommandContext): void {
  const models = program.command("models");
  const model = program.command("model");
  // Move existing command definitions here unchanged.
}
```

- [ ] **Step 4: Register from `index.ts`**

In `index.ts`, call:

```ts
registerStatusCommands(program, context);
registerProviderCommands(program, context);
registerModelCommands(program, context);
```

- [ ] **Step 5: Run CLI tests**

Run:

```bash
bun test packages/cli/test/cli.test.ts
```

Expected: PASS.

### Task 10: Extract Backup, Preset, Serve, and Token Commands

**Files:**

- Create: `packages/cli/src/commands/backups.ts`
- Create: `packages/cli/src/commands/presets.ts`
- Create: `packages/cli/src/commands/serve.ts`
- Create: `packages/cli/src/commands/token.ts`
- Modify: `packages/cli/src/index.ts`
- Test: `packages/cli/test/cli.test.ts`

- [ ] **Step 1: Create `commands/backups.ts`**

Move these command registrations from `index.ts`:

- `backup list`
- `backup restore`
- `diff`

Expose `registerBackupCommands(program, context)`.

- [ ] **Step 2: Create `commands/presets.ts`**

Move these command registrations from `index.ts`:

- `presets list`
- `presets export`
- `import`

Expose `registerPresetCommands(program, context)`.

- [ ] **Step 3: Create `commands/serve.ts`**

Move `serve` command registration from `index.ts`.

Expose `registerServeCommand(program, context)`.

- [ ] **Step 4: Create `commands/token.ts`**

Move `token rotate` command registration from `index.ts`.

Expose `registerTokenCommands(program, context)`.

- [ ] **Step 5: Register from `index.ts`**

After provider/model registration, call:

```ts
registerBackupCommands(program, context);
registerPresetCommands(program, context);
registerServeCommand(program, context);
registerTokenCommands(program, context);
```

- [ ] **Step 6: Confirm `index.ts` owns only program assembly**

After extraction, `packages/cli/src/index.ts` should contain:

- shebang
- imports
- `const program = new Command()`
- `.name()`, `.description()`, `.version()`
- `const context = createCommandContext()`
- `registerStatusCommands(program, context)`
- command registration calls
- `program.parse()`

- [ ] **Step 7: Run CLI tests and typecheck**

Run:

```bash
bun test packages/cli/test/cli.test.ts
bun run typecheck
```

Expected: both PASS.

### Slice 4 Sync Audit

- [ ] Compare registered commands against this plan's command list.
- [ ] Confirm `packages/cli/test/cli.test.ts` passes without output assertion changes.
- [ ] Confirm `bun run packages/cli/src/index.ts --help` lists the same top-level commands:

```text
status
health
providers
provider
models
use
model
backup
diff
presets
import
serve
token
```

---

## Slice 6: Config Status Entry

Slice 6 is product-facing. Do not write implementation code until Task 11 is complete and reviewed.

### Task 11: Write Config Status Design Spec

**Files:**

- Create: `docs/superpowers/specs/2026-06-26-oc-switch-config-status-design.md`

- [ ] **Step 1: Create the spec**

The spec must define:

- Why `/api/health` remains unchanged.
- Why first implementation adds `GET /api/config-status`.
- Exact response shape.
- `ConfigStatusReport` as a versioned endpoint DTO, not as a shared package contract.
- The split between raw source fields and deduplicated `issues[]`.
- The issue de-duplication key: `source:kind:subject`.
- Best-effort behavior when `openclaw.json` is missing, unreadable, or invalid: `/api/config-status` still returns 200 with a path blocking issue and empty health report.
- Which status sources are included:
  - case duplicate groups from `inspectConfigHealth`
  - orphan env keys from `listOrphanEnvKeys`
  - missing/duplicate env warnings from `inspectEnvFile`
  - disabled providers from `readProviderStates`
  - active path readability/writability from direct checks against `input.paths`
- That first-pass Web work is API client only.
- Dashboard, Providers, Models, and Settings UI consumption is deferred to a follow-up UI/product spec.

Use this proposed response shape in the spec:

```ts
export interface ConfigStatusIssue {
  id: string;
  severity: "info" | "warning" | "blocking";
  source: "health" | "env" | "paths" | "providers";
  title: string;
  detail?: string;
  action?: string;
}

export interface DisabledProviderStatus {
  providerId: string;
  disabledAt: string;
  openclawPath: string;
  hiddenModelCount: number;
}

export interface ConfigStatusReport {
  version: 1;
  health: ConfigHealthReport;
  disabledProviders: DisabledProviderStatus[];
  orphanEnvKeys: string[];
  envWarnings: string[];
  issues: ConfigStatusIssue[];
  summary: {
    issueCount: number;
    blockingIssueCount: number;
    warningIssueCount: number;
    duplicateGroupCount: number;
    disabledProviderCount: number;
    orphanEnvKeyCount: number;
  };
}
```

The spec must state:

- `health`, `disabledProviders`, `orphanEnvKeys`, and `envWarnings` are raw source fields for caller drill-down.
- Path readability/writability problems appear only in `issues[]` with `source: "paths"`.
- `issues[]` is the only normalized action list.
- `summary.issueCount`, `summary.blockingIssueCount`, and `summary.warningIssueCount` count only `issues[]`.
- `summary.duplicateGroupCount`, `summary.disabledProviderCount`, and `summary.orphanEnvKeyCount` count raw source facts.

- [ ] **Step 2: Stop for review**

After writing the spec, stop and report that Slice 6 implementation is gated on accepting the response shape. Do not implement `GET /api/config-status` before acceptance.

### Task 12: Implement Core Config Status After Spec Acceptance

**Files:**

- Create: `packages/core/src/config-status.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/config-status.test.ts`

- [ ] **Step 1: Create `config-status.ts`**

Implement exported types from the accepted spec and:

```ts
export interface InspectConfigStatusInput {
  config?: OpenClawConfig;
  configReadError?: string;
  paths: OcSwitchPaths;
  envContent: string;
  runningInstances?: RunningOpenClawInstance[];
}

export function inspectConfigStatus(input: InspectConfigStatusInput): ConfigStatusReport {
  // Build report using inspectConfigHealth, inspectEnvFile, listProviderEnvRefs,
  // readManifest, listOrphanEnvKeys, readProviderStates, and direct checks against input.paths.
  // Add one deduplicated ConfigStatusIssue per source:kind:subject into issues[].
  // If config is absent, return empty health and skip config-dependent sources.
}
```

- [ ] **Step 2: Export from Core**

In `packages/core/src/index.ts`, add:

```ts
export * from "./config-status";
```

- [ ] **Step 3: Add Core tests**

Create tests covering:

- no issues returns zero counts
- case duplicate group contributes to `duplicateGroupCount`
- disabled provider state contributes to `disabledProviderCount`
- orphan env key contributes to `orphanEnvKeyCount`
- missing provider env key contributes an env warning issue
- missing active config/env path contributes a path issue in `issues[]`
- invalid active config contributes `paths:invalid:openclaw` and still returns a report

- [ ] **Step 4: Run Core tests**

Run:

```bash
bun test packages/core/test/config-status.test.ts packages/core/test/config-health.test.ts packages/core/test/env-inspector.test.ts packages/core/test/provider-states.test.ts
```

Expected: PASS.

### Task 13: Expose Server Config Status Endpoint

**Files:**

- Modify: `packages/server/src/routes/health.ts`
- Modify: `packages/server/test/app.test.ts`

- [ ] **Step 1: Add route**

Add:

```ts
app.get("/api/config-status", (c) => {
  const paths = runtime.currentPaths();
  let config: OpenClawConfig | undefined;
  let configReadError: string | undefined;
  try {
    config = readConfig(paths);
  } catch (error) {
    configReadError = error instanceof Error ? error.message : String(error);
  }
  const envContent = readEnvContent(paths) ?? "";
  return c.json(inspectConfigStatus({
    ...(config ? { config } : {}),
    ...(configReadError ? { configReadError } : {}),
    paths,
    envContent,
    runningInstances: runtime.options.runningInstances
  }));
});
```

- [ ] **Step 2: Add server test**

In `packages/server/test/app.test.ts`, add a test that:

- disables a non-primary provider through `PATCH /api/providers/:id/state`
- calls `GET /api/config-status`
- asserts `json.summary.disabledProviderCount === 1`
- asserts `json.disabledProviders[0].providerId` matches the disabled provider
- asserts `json.issues` contains no duplicate `source:kind:subject` pair
- calls `GET /api/config-status` with a missing or invalid `openclaw.json` and asserts the response is still 200 with a `paths:*:openclaw` blocking issue

- [ ] **Step 3: Run server tests**

Run:

```bash
bun test packages/server/test/app.test.ts
```

Expected: PASS.

### Task 14: Add Web API Client Types

**Files:**

- Modify: `packages/web/src/api.ts`
- Modify: `packages/web/src/api.test.ts`

- [ ] **Step 1: Add Web API types**

Add `ConfigStatusIssue`, `DisabledProviderStatus`, and `ConfigStatusReport` interfaces matching the accepted server response shape.

- [ ] **Step 2: Add client method**

In `createApiClient`, add:

```ts
getConfigStatus: () => request<ConfigStatusReport>("/api/config-status"),
```

- [ ] **Step 3: Add API test**

In `packages/web/src/api.test.ts`, assert that `getConfigStatus()` sends `GET /api/config-status` with Bearer auth.

Do not update Dashboard, Providers, Models, or Settings tests in this task.

- [ ] **Step 4: Run Web API tests**

Run:

```bash
bun test --preload ./packages/web/src/test-setup.ts packages/web/src/api.test.ts
```

Expected: PASS.

### Slice 6 Sync Audit

- [ ] Confirm `/api/health` response is unchanged.
- [ ] Confirm `/api/health` still returns only `ConfigHealthReport` case-duplicate health.
- [ ] Confirm `/api/config-status` does not expose secret values.
- [ ] Confirm disabled provider summaries include counts and timestamps, not saved allowlist entry contents.
- [ ] Confirm `issues[]` has unique `source:kind:subject` pairs.
- [ ] Confirm missing or invalid `openclaw.json` still produces `GET /api/config-status` 200 with a path blocking issue.
- [ ] Confirm Web only adds API client support.

---

## Final Verification

After all accepted slices are implemented, run:

```bash
bun run check
```

Expected: PASS.

Then run:

```bash
git diff --check
```

Expected: no output.

## Final Sync Audit

Report against the architecture draft:

- Slice 2 Core split complete or list exact gaps.
- Slice 3 Server route split complete or list exact gaps.
- Slice 4 CLI command split complete or list exact gaps.
- Slice 6 config-status spec accepted and implementation state:
  - spec-only
  - endpoint implemented
  - Web API client implemented
- Behavior compatibility evidence:
  - Core tests
  - Server tests
  - CLI tests
  - full `bun run check`

## Execution Notes

- This plan intentionally avoids git commits.
- Each slice can be stopped after its Sync Audit with a clean, working codebase.
- If Slice 6 spec review changes the response shape, update Tasks 12-14 before writing implementation code.

---

## 已确认决策（2026-06-26）

用户已确认以下决策；后续执行不得偏离。

1. **`ConfigStatusReport` 作为 v1 DTO 契约**：`GET /api/config-status` 的响应类型由 Core 定义、Web 在 `packages/web/src/api.ts` 镜像；**不**新建 shared contracts 包。
2. **`issues[]` 与分项字段分工**：`issues[]` 是唯一去重后的行动列表；`health`、`disabledProviders`、`orphanEnvKeys`、`envWarnings` 等分项字段保留 raw facts 供 drill-down；去重 key 为 `source:kind:subject`（例如同一缺失 env key 只产生一条 `env:missing:KEY_NAME`）。
3. **Slice 6 Web 首版范围**：只接 API client（类型 + `getConfigStatus()`），**不**接 Dashboard、Providers、Models、Settings UI；UI 接入另开后续产品/UI spec。
4. **`/api/health` 长期冻结**：保持为 legacy case-duplicate health endpoint；新状态能力全部走 `/api/config-status`；日后 alias/deprecate `/api/health` 须单独兼容性规格。
5. **Slice 3 与 4 执行顺序**：默认串行；仅当 Slice 2 完成且明确协调 import/export churn 时，才可在独立 worktree 中考虑并行。
6. **CLI 命令拆分**：`status` 与 `health` **不**保留在 `packages/cli/src/index.ts`，迁至 `packages/cli/src/commands/status.ts`；`index.ts` 只做 program assembly（shebang、Command 创建、元数据、register 调用、`program.parse()`）。
7. **Git 提交策略**：默认不 commit；若用户之后明确要求提交，按独立 slice 提交：Slice 2、Slice 3、Slice 4、Slice 6 spec、Slice 6 implementation。
8. **Slice 6 规格门禁**：config-status 规格写完后须等用户 review/接受，再写实现代码（plan 停止点，见 Task 11 Step 2）。
9. **`AGENTS.md` 同步**：**先不更新** `AGENTS.md`；待 Slice 2–6 阶段性完成后，由用户决定是否同步 Learned Workspace Facts。
