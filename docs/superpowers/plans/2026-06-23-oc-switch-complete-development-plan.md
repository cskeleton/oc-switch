# oc-switch Complete Development Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish oc-switch from the current Core + CLI MVP into the complete WebGUI + CLI OpenClaw provider/model manager described in `docs/superpowers/specs/2026-06-23-oc-switch-design.md`.

**Architecture:** Keep `packages/core` as the only layer that reads or writes OpenClaw files. Add `packages/server` as a thin Hono REST API over core operations, then add `packages/web` as a React/Vite SPA that calls the REST API and never touches local files directly. Finish with CLI parity, provider sync/import/export, backup restore, security hardening, and acceptance verification against sanitized fixtures plus the local real OpenClaw config in read-only mode.

**Tech Stack:** Bun workspace, TypeScript, Vitest/Bun test, Commander.js, Hono, React, Vite, Tailwind, Playwright for WebGUI smoke tests.

---

## Current State

Implemented:

- `packages/core`: model ref parsing, config summaries, `.env` managed block, backup package creation, transaction writes, diff guard, primary/enable/disable operations, basic preset add/update.
- `packages/cli`: `status`, `providers list`, `models list`, `use`, `model enable`, `model disable`.
- Tests: core and CLI tests pass for the MVP path.

Before starting this plan, commit or otherwise preserve the current review-fix work:

```bash
bun test
bun run typecheck
git status --short
```

Expected:

```text
All tests pass.
Typecheck exits with code 0.
Only intentional source, test, docs, and generated-file cleanup changes are present.
```

## Remaining Work Breakdown

Execute in this order:

1. **Phase 2: Core + CLI Completion**  
   Backup list/restore/diff, Provider CRUD, PresetStore, import/export, provider sync, manifest/orphan env handling, token manager primitives.

2. **Phase 3: REST Server + Security**  
   Hono server package, auth middleware, all REST endpoints, `oc-switch serve`, `oc-switch token rotate`, no-secret response shaping.

3. **Phase 4: WebGUI**  
   React/Vite/Tailwind SPA with dashboard, providers, models, presets, backups, settings; API client; diff preview; confirmation flows; responsive iPad/mobile layout.

4. **Phase 5: Release + Acceptance**  
   End-to-end tests, real-config read-only smoke checks, packaging scripts, README, install/run docs, final acceptance matrix.

---

## Phase 2: Core + CLI Completion

### Task 2.1: Backup Listing, Restore, and Diff Preview

**Files:**

- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/backup-manager.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/diff.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/backup-manager.test.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/diff.test.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/src/index.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/test/cli.test.ts`

- [ ] **Step 1: Write backup manager tests**

Create `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/backup-manager.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup, listBackups, restoreBackup } from "../src/backup-manager";

const tempDirs: string[] = [];

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-backup-"));
  tempDirs.push(dir);
  const openclawPath = join(dir, "openclaw.json");
  const envPath = join(dir, ".env");
  const stateDir = join(dir, ".oc-switch");
  writeFileSync(openclawPath, "{\"before\":true}\n");
  writeFileSync(envPath, "KEY=before\n");
  return { dir, openclawPath, envPath, stateDir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("backup manager", () => {
  test("lists backup packages newest first", () => {
    const ws = workspace();
    const first = createBackup({ ...ws, reason: "first", beforeHash: "hash-1" });
    const second = createBackup({ ...ws, reason: "second", beforeHash: "hash-2" });

    const backups = listBackups(ws.stateDir);
    expect(backups.map((backup) => backup.path)).toEqual([second, first]);
    expect(backups[0]?.metadata.reason).toBe("second");
  });

  test("restores openclaw and env from backup package", () => {
    const ws = workspace();
    const backupDir = createBackup({ ...ws, reason: "restore", beforeHash: "hash" });
    writeFileSync(ws.openclawPath, "{\"after\":true}\n");
    writeFileSync(ws.envPath, "KEY=after\n");

    restoreBackup({ backupDir, openclawPath: ws.openclawPath, envPath: ws.envPath });

    expect(readFileSync(ws.openclawPath, "utf8")).toBe("{\"before\":true}\n");
    expect(readFileSync(ws.envPath, "utf8")).toBe("KEY=before\n");
    expect(existsSync(join(backupDir, "metadata.json"))).toBe(true);
  });
});
```

- [ ] **Step 2: Write diff tests**

Create `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/diff.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { summarizeConfigDiff } from "../src/diff";
import type { OpenClawConfig } from "../src/types";

describe("summarizeConfigDiff", () => {
  test("summarizes provider, allowlist, and primary changes only", () => {
    const before: OpenClawConfig = {
      models: { providers: { old: { models: [{ id: "a" }] } } },
      agents: { defaults: { model: "old/a", models: { "old/a": { alias: "a" } } } }
    };
    const after: OpenClawConfig = {
      models: { providers: { old: { models: [{ id: "a" }] }, next: { models: [{ id: "b" }] } } },
      agents: { defaults: { model: "next/b", models: { "old/a": { alias: "a" }, "next/b": { alias: "b" } } } }
    };

    expect(summarizeConfigDiff(before, after)).toEqual({
      providersAdded: ["next"],
      providersRemoved: [],
      providersChanged: [],
      modelsEnabled: ["next/b"],
      modelsDisabled: [],
      primaryChanged: { before: "old/a", after: "next/b" }
    });
  });
});
```

- [ ] **Step 3: Verify red**

Run:

```bash
bun test packages/core/test/backup-manager.test.ts packages/core/test/diff.test.ts
```

Expected:

```text
FAIL because listBackups, restoreBackup, and summarizeConfigDiff are not exported yet.
```

- [ ] **Step 4: Implement backup and diff APIs**

Add these exports in `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/backup-manager.ts`:

```ts
export interface BackupMetadata {
  reason: string;
  openclawPath: string;
  envPath: string;
  beforeHash: string;
  sourceFiles: string[];
  createdAt: string;
}

export interface BackupSummary {
  id: string;
  path: string;
  metadata: BackupMetadata;
}
```

Implementation requirements:

- `listBackups(stateDir)` reads `stateDir/backups/*/metadata.json`.
- It ignores directories without valid `metadata.json`.
- It returns `BackupSummary[]` sorted by `metadata.createdAt` descending.
- `id` is the backup directory basename.
- `restoreBackup(input)` copies `backupDir/openclaw.json` to `input.openclawPath`.
- If `backupDir/.env` exists, restore it to `input.envPath`; if it does not exist, remove `input.envPath`.

Create `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/diff.ts`:

```ts
import type { OpenClawConfig } from "./types";

export interface ConfigDiffSummary {
  providersAdded: string[];
  providersRemoved: string[];
  providersChanged: string[];
  modelsEnabled: string[];
  modelsDisabled: string[];
  primaryChanged: { before: string | undefined; after: string | undefined } | null;
}
```

Implementation requirements:

- `providersAdded` is provider ids present in `after.models.providers` but absent in `before.models.providers`.
- `providersRemoved` is provider ids absent after but present before.
- `providersChanged` is provider ids present in both where `JSON.stringify(provider)` differs.
- `modelsEnabled` is allowlist refs present after but absent before.
- `modelsDisabled` is allowlist refs absent after but present before.
- `primaryChanged` is `null` when unchanged, otherwise `{ before, after }`.

Update `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`:

```ts
export * from "./backup-manager";
export * from "./diff";
```

- [ ] **Step 5: Add CLI commands**

Add to `/Users/gc/Dev/MyProject/oc-switch/packages/cli/src/index.ts`:

```ts
const backup = program.command("backup");
backup.command("list").action(() => {
  const paths = defaultPaths();
  for (const backup of listBackups(paths.stateDir)) {
    console.log(`${backup.id}\t${backup.metadata.createdAt}\t${backup.metadata.reason}`);
  }
});

backup.command("restore")
  .argument("<id>")
  .action(async (id: string) => {
    const paths = defaultPaths();
    restoreBackup({ backupDir: join(paths.stateDir, "backups", id), openclawPath: paths.openclawPath, envPath: paths.envPath });
    console.log(`Restored backup ${id}`);
  });

program.command("diff").action(() => {
  const paths = defaultPaths();
  const [latest] = listBackups(paths.stateDir);
  if (!latest) throw new Error("No backups found");
  const before = JSON5.parse(readFileSync(join(latest.path, "openclaw.json"), "utf8")) as OpenClawConfig;
  const after = readConfig();
  console.log(JSON.stringify(summarizeConfigDiff(before, after), null, 2));
});
```

- [ ] **Step 6: Verify green**

Run:

```bash
bun test packages/core/test/backup-manager.test.ts packages/core/test/diff.test.ts packages/cli/test/cli.test.ts
bun run typecheck
```

Expected:

```text
All targeted tests pass.
Typecheck exits with code 0.
```

- [ ] **Step 7: Commit**

```bash
git add packages/core/src packages/core/test packages/cli/src/index.ts packages/cli/test/cli.test.ts
git commit -m "feat(core): add backup restore and diff"
```

### Task 2.2: PresetStore, Import, and Export

**Files:**

- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/preset-store.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/preset-store.test.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/src/index.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/test/cli.test.ts`

- [ ] **Step 1: Write PresetStore tests**

Create `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/preset-store.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "./fixtures/openclaw.sample.json";
import { exportProviderPreset, listPresets, loadPreset, saveCustomPreset } from "../src/preset-store";
import type { OpenClawConfig, ProviderPreset } from "../src/types";

const tempDirs: string[] = [];

function dirs() {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-preset-"));
  tempDirs.push(dir);
  return {
    builtinDir: join(dir, "builtin"),
    customDir: join(dir, "custom")
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PresetStore", () => {
  test("lists builtin and custom presets", () => {
    const d = dirs();
    const preset: ProviderPreset = {
      id: "custom",
      name: "Custom",
      provider: { api: "openai-completions", baseUrl: "https://example.com/v1", apiKeyEnv: "CUSTOM_API_KEY" },
      models: [{ id: "model", alias: "model" }]
    };
    saveCustomPreset(d.customDir, preset);
    writeFileSync(join(d.builtinDir, "builtin.json"), JSON.stringify({ ...preset, id: "builtin", name: "Builtin" }));

    expect(listPresets(d).map((entry) => entry.id).sort()).toEqual(["builtin", "custom"]);
  });

  test("loads preset by id", () => {
    const d = dirs();
    saveCustomPreset(d.customDir, {
      id: "custom",
      name: "Custom",
      provider: { api: "openai-completions", baseUrl: "https://example.com/v1", apiKeyEnv: "CUSTOM_API_KEY" },
      models: [{ id: "model" }]
    });

    expect(loadPreset(d, "custom").name).toBe("Custom");
  });

  test("exports provider preset from current config without secret values", () => {
    const preset = exportProviderPreset(sample as OpenClawConfig, "nvidia");
    expect(preset.id).toBe("nvidia");
    expect(preset.provider.apiKeyEnv).toBe("NVIDIA_API_KEY");
    expect(JSON.stringify(preset)).not.toContain("sk-");
  });
});
```

- [ ] **Step 2: Verify red**

Run:

```bash
bun test packages/core/test/preset-store.test.ts
```

Expected:

```text
FAIL because preset-store.ts does not exist.
```

- [ ] **Step 3: Implement PresetStore**

Create `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/preset-store.ts` with these exported functions:

```ts
export interface PresetDirs {
  builtinDir: string;
  customDir: string;
}

export interface PresetListEntry {
  id: string;
  name: string;
  source: "builtin" | "custom";
  path: string;
  tags: string[];
}
```

Implementation requirements:

- `listPresets(dirs)` reads `*.json` from `builtinDir` and `customDir`, validates each as `ProviderPreset`, and returns entries sorted by source then id.
- `loadPreset(dirs, id)` returns the custom preset when both custom and builtin have the same id.
- `saveCustomPreset(customDir, preset)` creates `customDir`, writes pretty JSON to `<preset.id>.json`, and returns the written path.
- `exportProviderPreset(config, providerId)` reads `models.providers[providerId]`, copies all model fields, copies allowlist aliases into `models[].alias`, and uses the env var id from `apiKey` or `authHeader`.

Update exports:

```ts
export * from "./preset-store";
```

- [ ] **Step 4: Add CLI commands**

Add CLI commands:

```bash
oc-switch presets list
oc-switch presets export <provider-id>
oc-switch import
```

Required behavior:

- `presets list` prints id, source, and model count.
- `presets export <provider-id>` writes `~/.oc-switch/presets/custom/<provider-id>.json`.
- `import` exports all current providers into custom presets.

- [ ] **Step 5: Verify**

Run:

```bash
bun test packages/core/test/preset-store.test.ts packages/cli/test/cli.test.ts
bun run typecheck
```

Expected:

```text
All targeted tests pass.
No API key values appear in test output.
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src packages/core/test packages/cli/src/index.ts packages/cli/test/cli.test.ts
git commit -m "feat(core): add preset store and import export"
```

### Task 2.3: Complete Provider and Model CLI CRUD

**Files:**

- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/operations.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/operations.test.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/src/index.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/test/cli.test.ts`

- [ ] **Step 1: Add operation tests**

Add tests for:

```ts
provider add from preset writes provider and allowlist;
provider edit updates baseUrl and env ref without dropping unknown fields;
provider delete removes only refs whose first segment matches providerId;
model add creates provider model and optional allowlist alias;
model remove removes provider model and allowlist entry but refuses if primary unless forced;
```

Concrete refs to use in tests:

```text
nvidia/deepseek-ai/deepseek-v4-flash
custom/vendor/model
```

- [ ] **Step 2: Verify red**

Run:

```bash
bun test packages/core/test/operations.test.ts
```

Expected:

```text
FAIL for missing provider edit/delete helpers and model add/remove helpers.
```

- [ ] **Step 3: Implement core operations**

Add these exports from `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/operations.ts`:

```ts
export function editProvider(config: OpenClawConfig, providerId: string, changes: { baseUrl?: string; apiKeyEnv?: string }): OperationResult;
export function removeProvider(config: OpenClawConfig, providerId: string, options: { force: boolean; newPrimary?: string }): OperationResult;
export function addProviderModel(config: OpenClawConfig, ref: string, input: { name?: string; alias?: string; enabled: boolean }): OperationResult;
export function removeProviderModel(config: OpenClawConfig, ref: string, options: { force: boolean; newPrimary?: string }): OperationResult;
```

Behavior:

- Preserve unknown provider/model/allowlist fields.
- Use `parseModelRef` for every ref.
- Never normalize provider casing.
- Refuse deleting/removing primary unless `force` or `newPrimary` is supplied.

- [ ] **Step 4: Add CLI commands**

Implement:

```bash
oc-switch provider add <preset-id> --key <api-key> [--models model1,model2]
oc-switch provider edit <name> [--base-url <url>] [--key <api-key>]
oc-switch provider delete <name> [--force] [--new-primary <ref>]
oc-switch model add <provider>/<model-id...> [--alias <alias>] [--enable]
oc-switch model remove <provider>/<model-id...> [--force] [--new-primary <ref>]
```

- [ ] **Step 5: Verify**

Run:

```bash
bun test packages/core/test/operations.test.ts packages/cli/test/cli.test.ts
bun run typecheck
```

Expected:

```text
All tests pass.
CLI write tests verify resulting file content, not only stdout.
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/operations.ts packages/core/test/operations.test.ts packages/cli/src/index.ts packages/cli/test/cli.test.ts
git commit -m "feat(cli): complete provider and model crud"
```

### Task 2.4: Provider Sync Adapter

**Files:**

- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/provider-sync.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/provider-sync.test.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/src/index.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/test/cli.test.ts`

- [ ] **Step 1: Write sync tests**

Create tests covering:

```ts
OpenAI-compatible sync normalizes baseUrl with or without trailing /v1;
sync only adds missing models and never deletes existing models;
anthropic-messages returns unsupported result without mutating config;
google-generative-ai returns unsupported result without mutating config;
```

- [ ] **Step 2: Verify red**

Run:

```bash
bun test packages/core/test/provider-sync.test.ts
```

Expected:

```text
FAIL because provider-sync.ts does not exist.
```

- [ ] **Step 3: Implement sync**

Export:

```ts
export interface ProviderSyncResult {
  providerId: string;
  addedModelIds: string[];
  skippedModelIds: string[];
  unsupportedReason?: string;
}

export async function syncProviderModels(config: OpenClawConfig, providerId: string, fetchImpl?: typeof fetch): Promise<ProviderSyncResult>;
```

Rules:

- `openai-completions`: fetch normalized models endpoint and merge `data[].id`.
- `anthropic-messages`: return unsupported result.
- `google-generative-ai`: return unsupported result.
- Do not remove models.
- Do not enable new models by default.

- [ ] **Step 4: Add CLI command**

Implement:

```bash
oc-switch provider sync <name>
```

The command writes through `writeOpenClawTransaction` only when models were added.

- [ ] **Step 5: Verify**

Run:

```bash
bun test packages/core/test/provider-sync.test.ts packages/cli/test/cli.test.ts
bun run typecheck
```

Expected:

```text
OpenAI-compatible sync test passes with mocked fetch.
Unsupported provider tests pass without network.
```

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/provider-sync.ts packages/core/test/provider-sync.test.ts packages/cli/src/index.ts packages/cli/test/cli.test.ts
git commit -m "feat(core): add provider model sync"
```

---

## Phase 3: REST Server + Security

### Task 3.1: Server Package and App Factory

**Files:**

- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/server/package.json`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/server/tsconfig.json`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/server/src/app.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/server/src/index.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/server/test/app.test.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/package.json`

- [ ] **Step 1: Add package skeleton**

`/Users/gc/Dev/MyProject/oc-switch/packages/server/package.json`:

```json
{
  "name": "@oc-switch/server",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "bun test test",
    "typecheck": "bunx tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@oc-switch/core": "workspace:*",
    "hono": "^4.0.0"
  }
}
```

`/Users/gc/Dev/MyProject/oc-switch/packages/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

Update root scripts:

```json
{
  "scripts": {
    "typecheck": "bunx tsc -b packages/core packages/cli packages/server"
  }
}
```

- [ ] **Step 2: Write app test**

`/Users/gc/Dev/MyProject/oc-switch/packages/server/test/app.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";

describe("server app", () => {
  test("health endpoint works without secrets", async () => {
    const app = createApp({ token: "secret" });
    const response = await app.request("/api/status", {
      headers: { Authorization: "Bearer secret" }
    });

    expect(response.status).toBe(200);
    const json = await response.json();
    expect(JSON.stringify(json)).not.toContain("sk-");
  });

  test("rejects missing token", async () => {
    const app = createApp({ token: "secret" });
    const response = await app.request("/api/status");
    expect(response.status).toBe(401);
  });
});
```

- [ ] **Step 3: Verify red**

Run:

```bash
bun test packages/server/test/app.test.ts
```

Expected:

```text
FAIL because createApp does not exist.
```

- [ ] **Step 4: Implement app factory**

Create `/Users/gc/Dev/MyProject/oc-switch/packages/server/src/app.ts`:

```ts
import { Hono } from "hono";

export interface AppOptions {
  token: string;
}

export function createApp(options: AppOptions) {
  const app = new Hono();

  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${options.token}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/api/status", (c) => c.json({ ok: true }));

  return app;
}
```

Create `/Users/gc/Dev/MyProject/oc-switch/packages/server/src/index.ts`:

```ts
export * from "./app";
```

- [ ] **Step 5: Verify**

Run:

```bash
bun install
bun test packages/server/test/app.test.ts
bun run typecheck
```

Expected:

```text
Server tests pass.
Typecheck exits with code 0.
```

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock packages/server
git commit -m "feat(server): add authenticated app shell"
```

### Task 3.2: Wire REST Endpoints to Core

**Files:**

- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/server/src/app.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/server/src/schemas.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/server/test/app.test.ts`

- [ ] **Step 1: Add endpoint tests**

Add tests for:

```text
GET /api/providers
GET /api/models
PUT /api/models/primary body { ref }
PATCH /api/models body { ref, enabled }
POST /api/providers from preset
PUT /api/providers/:id
DELETE /api/providers/:id
POST /api/providers/:id/sync
GET /api/presets
POST /api/presets/import
POST /api/presets/export/:id
GET /api/backups
POST /api/backups/:id/restore
GET /api/diff
```

Use temp OpenClaw paths and fixture data. Verify each write endpoint changes fixture files and creates a backup package.

- [ ] **Step 2: Verify red**

Run:

```bash
bun test packages/server/test/app.test.ts
```

Expected:

```text
FAIL for endpoints that are not implemented yet.
```

- [ ] **Step 3: Implement request validation helpers**

Create `/Users/gc/Dev/MyProject/oc-switch/packages/server/src/schemas.ts`:

```ts
export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

export function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}
```

- [ ] **Step 4: Implement endpoint handlers**

Rules:

- Every mutation calls `writeOpenClawTransaction`.
- Every model ref comes from JSON body, not path segment.
- API responses must mask key presence; never return API key values.
- Return 400 for validation errors, 401 for token failures, 500 for unexpected errors.

- [ ] **Step 5: Verify**

Run:

```bash
bun test packages/server/test/app.test.ts
bun test
bun run typecheck
```

Expected:

```text
All server endpoint tests pass.
All workspace tests pass.
```

- [ ] **Step 6: Commit**

```bash
git add packages/server/src packages/server/test
git commit -m "feat(server): expose core rest api"
```

### Task 3.3: Token Manager and CLI Serve

**Files:**

- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/token-manager.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/token-manager.test.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/src/index.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/package.json`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/test/cli.test.ts`

- [ ] **Step 1: Add token tests**

Test behavior:

```text
localhost without token generates ephemeral token;
0.0.0.0 without explicit or persisted token throws;
rotate writes new persisted token under ~/.oc-switch/token.json with 0600 permissions where supported;
token values are not logged except the one-time ephemeral startup line.
```

- [ ] **Step 2: Implement TokenManager**

Exports:

```ts
export function generateToken(): string;
export function readPersistedToken(stateDir: string): string | undefined;
export function writePersistedToken(stateDir: string, token: string): void;
export function resolveServeToken(input: { host: string; token?: string; stateDir: string }): { token: string; ephemeral: boolean };
```

- [ ] **Step 3: Implement CLI**

Commands:

```bash
oc-switch serve [--port 7420] [--host 127.0.0.1] [--token <secret>]
oc-switch token rotate
```

`serve` starts the Hono app through Bun's server runtime.

- [ ] **Step 4: Verify**

Run:

```bash
bun test packages/core/test/token-manager.test.ts packages/cli/test/cli.test.ts
bun run typecheck
```

Expected:

```text
All token tests pass.
serve rejects 0.0.0.0 without token.
```

- [ ] **Step 5: Commit**

```bash
git add packages/core/src packages/core/test packages/cli/src packages/cli/test packages/cli/package.json
git commit -m "feat(cli): add serve and token rotation"
```

---

## Phase 4: WebGUI

### Task 4.1: Web Package Scaffold and API Client

**Files:**

- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/package.json`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/tsconfig.json`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/vite.config.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/index.html`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/api.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/main.tsx`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/App.tsx`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/styles.css`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/api.test.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/package.json`

- [ ] **Step 1: Add package**

`/Users/gc/Dev/MyProject/oc-switch/packages/web/package.json`:

```json
{
  "name": "@oc-switch/web",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "bun test src",
    "typecheck": "bunx tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@vitejs/plugin-react": "^5.0.0",
    "vite": "^7.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "lucide-react": "^0.468.0"
  },
  "devDependencies": {
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0"
  }
}
```

- [ ] **Step 2: Write API client tests**

Create `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/api.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createApiClient } from "./api";

describe("createApiClient", () => {
  test("sends bearer token and parses JSON", async () => {
    const calls: Request[] = [];
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "secret",
      fetchImpl: async (input, init) => {
        calls.push(new Request(input, init));
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      }
    });

    expect(await client.getStatus()).toEqual({ ok: true });
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer secret");
  });
});
```

- [ ] **Step 3: Implement API client**

Create `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/api.ts`:

```ts
export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export function createApiClient(options: ApiClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchImpl(`${options.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${options.token}`,
        ...init.headers
      }
    });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json() as Promise<T>;
  }

  return {
    getStatus: () => request("/api/status"),
    getProviders: () => request("/api/providers"),
    getModels: () => request("/api/models"),
    setPrimary: (ref: string) => request("/api/models/primary", { method: "PUT", body: JSON.stringify({ ref }) }),
    patchModel: (ref: string, enabled: boolean) => request("/api/models", { method: "PATCH", body: JSON.stringify({ ref, enabled }) })
  };
}
```

- [ ] **Step 4: Add minimal app shell**

Create an app shell with:

- left navigation on desktop, top tabs on narrow screens;
- routes held in local state: dashboard, providers, models, presets, backups, settings;
- token input stored in `sessionStorage`, never localStorage;
- no marketing page, app UI is first screen.

- [ ] **Step 5: Verify**

Run:

```bash
bun install
bun test packages/web/src/api.test.ts
bun run typecheck
bun run --cwd packages/web build
```

Expected:

```text
API client test passes.
Typecheck passes.
Vite build succeeds.
```

- [ ] **Step 6: Commit**

```bash
git add package.json bun.lock packages/web
git commit -m "feat(web): scaffold web app and api client"
```

### Task 4.2: Dashboard, Models, and Providers Views

**Files:**

- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/views/Dashboard.tsx`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/views/ModelsView.tsx`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/views/ProvidersView.tsx`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/components/DataTable.tsx`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/components/ConfirmDialog.tsx`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/App.tsx`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/api.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/views.test.tsx`

- [ ] **Step 1: Add view behavior tests**

Test with lightweight React rendering:

```text
Dashboard shows current primary model and counts.
Models view can call setPrimary with a slash-containing ref.
Models view can enable/disable via PATCH body, not URL path.
Providers view shows provider id, api type, enabled/model count, and primary marker.
```

- [ ] **Step 2: Build views**

Design constraints:

- Dense operational UI, no landing page.
- Tables/lists must not overflow on mobile; long model refs wrap inside cells.
- Use icon buttons with accessible labels for refresh, delete, edit, set primary.
- Do not display API key values.

- [ ] **Step 3: Verify**

Run:

```bash
bun test packages/web/src/views.test.tsx
bun run --cwd packages/web build
```

Expected:

```text
View tests pass.
Build succeeds.
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): add dashboard provider and model views"
```

### Task 4.3: Presets, Backups, Settings, and Diff Preview

**Files:**

- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/views/PresetsView.tsx`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/views/BackupsView.tsx`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/views/SettingsView.tsx`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/components/DiffSummary.tsx`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/api.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/web/src/App.tsx`

- [ ] **Step 1: Add tests**

Cover:

```text
Preset add flow sends apiKey only in request body and never renders it after submit.
Backups view lists backup timeline and restore button asks confirmation.
DiffSummary renders providersAdded, providersRemoved, modelsEnabled, modelsDisabled, primaryChanged.
Settings view shows config path, bind address, port, backup retention, gateway restart command as non-secret settings.
```

- [ ] **Step 2: Implement views**

Required flows:

- Add provider from preset: select preset, enter key, choose models, preview diff, confirm.
- Export preset from provider.
- Import current config as presets.
- Restore backup with confirmation.
- Settings view shows current server settings from `/api/status` or `/api/settings` if added.

- [ ] **Step 3: Verify**

Run:

```bash
bun test packages/web/src
bun run --cwd packages/web build
```

Expected:

```text
All web unit tests pass.
Build succeeds.
```

- [ ] **Step 4: Commit**

```bash
git add packages/web/src
git commit -m "feat(web): add presets backups and settings"
```

### Task 4.4: Browser Smoke Tests

**Files:**

- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/web/test/e2e/webgui.spec.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/playwright.config.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/package.json`

- [ ] **Step 1: Add Playwright dependency and scripts**

Root scripts:

```json
{
  "scripts": {
    "test:e2e": "playwright test"
  }
}
```

- [ ] **Step 2: Write smoke tests**

Cover desktop and mobile widths:

```text
dashboard loads and is not blank;
providers table visible;
models page includes nvidia/deepseek-ai/deepseek-v4-flash without layout overflow;
primary model button is reachable;
backup page restore dialog opens and can be cancelled.
```

- [ ] **Step 3: Verify**

Run:

```bash
bun run --cwd packages/web build
bun run test:e2e
```

Expected:

```text
All browser smoke tests pass.
Screenshots show nonblank app at desktop and mobile viewport.
```

- [ ] **Step 4: Commit**

```bash
git add package.json bun.lock playwright.config.ts packages/web/test
git commit -m "test(web): add webgui smoke coverage"
```

---

## Phase 5: Release + Acceptance

### Task 5.1: Built-in Preset Catalog

**Files:**

- Create or modify JSON files under `/Users/gc/Dev/MyProject/oc-switch/presets/builtin/`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/builtin-presets.test.ts`

- [ ] **Step 1: Add preset validation test**

Test every builtin preset:

```text
id matches filename;
provider.api is one of supported ApiType values;
provider.apiKeyEnv is uppercase snake case ending with _API_KEY;
each model has id;
no preset contains actual API key values.
```

- [ ] **Step 2: Add initial catalog**

Create files:

```text
elysiver.json
cherryin.json
juya.json
aitoolscfd.json
nvidia.json
openrouter.json
deepseek.json
minimax-portal.json
cerebras.json
openai-compatible.json
```

- [ ] **Step 3: Verify**

Run:

```bash
bun test packages/core/test/builtin-presets.test.ts
```

Expected:

```text
All builtin preset files validate.
No secret-looking values are present.
```

- [ ] **Step 4: Commit**

```bash
git add presets/builtin packages/core/test/builtin-presets.test.ts
git commit -m "feat(presets): add builtin provider catalog"
```

### Task 5.2: Documentation and Packaging

**Files:**

- Modify: `/Users/gc/Dev/MyProject/oc-switch/README.md`
- Create: `/Users/gc/Dev/MyProject/oc-switch/docs/acceptance-checklist.md`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/package.json`

- [ ] **Step 1: Add docs**

README must include:

```text
install/run commands;
local WebGUI usage;
VPS usage with --host 0.0.0.0 --token;
SSH tunnel recommendation;
CLI command reference;
backup restore warning;
JSON5 formatting caveat;
no API keys in JSON guarantee.
```

Acceptance checklist must map each item from design section 10 to a command or test.

- [ ] **Step 2: Add package scripts**

Root scripts:

```json
{
  "scripts": {
    "build": "bun run --cwd packages/web build",
    "check": "bun test && bun run typecheck && bun run --cwd packages/web build"
  }
}
```

- [ ] **Step 3: Verify docs commands**

Run every command shown in README against temp fixture paths, not the real config, except read-only `status`.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/acceptance-checklist.md package.json
git commit -m "docs: add usage and acceptance guide"
```

### Task 5.3: Final Acceptance

**Files:**

- Create: `/Users/gc/Dev/MyProject/oc-switch/scripts/acceptance-smoke.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/package.json`

- [ ] **Step 1: Write acceptance smoke script**

The script must:

```text
copy packages/core/test/fixtures/openclaw.sample.json to a temp directory;
run CLI status/providers/models;
run CLI use with nvidia/deepseek-ai/deepseek-v4-flash;
verify backup package exists;
verify .env is unchanged when no key is written;
verify no output contains API key-looking strings;
start server on 127.0.0.1 with token;
call /api/status authorized and unauthorized;
shut server down.
```

- [ ] **Step 2: Add script**

Root package:

```json
{
  "scripts": {
    "acceptance": "bun run scripts/acceptance-smoke.ts"
  }
}
```

- [ ] **Step 3: Run final verification**

Run:

```bash
bun run check
bun run acceptance
OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json" bun run packages/cli/src/index.ts status
```

Expected:

```text
check passes.
acceptance passes.
real config status prints 12 providers and 43 allowlist models on this machine.
No command prints API key values.
```

- [ ] **Step 4: Commit**

```bash
git add scripts/acceptance-smoke.ts package.json
git commit -m "test: add final acceptance smoke"
```

---

## Completion Criteria

The full design is complete when these are all true:

- Core and CLI tests pass.
- Server tests pass.
- Web unit tests pass.
- Web browser smoke tests pass at desktop and mobile widths.
- Acceptance smoke script passes.
- `oc-switch serve --host 0.0.0.0` refuses to start without token.
- All API endpoints require `Authorization: Bearer <token>`.
- Model refs containing multiple slashes work through CLI, REST body payloads, and WebGUI actions.
- Writes are limited by diff guard and always create a backup package.
- Backup restore restores `openclaw.json` and `.env` together.
- WebGUI can add a provider and switch primary model in an iPad-sized viewport.
- No test, log, REST response, CLI output, or WebGUI screen leaks API key values.

## Self-Review

Spec coverage:

- Sections 1-3 are covered by Phase 2.
- Sections 4 and 6 are covered by Phases 3 and 4.
- Section 5 is covered by Phase 2 plus Phase 3 serve/token tasks.
- Section 7 is covered by Phase 3 security and Phase 5 acceptance.
- Sections 8-10 are covered by all phases and final acceptance.

Known sequencing constraint:

- Phase 4 depends on Phase 3 endpoint shapes being stable.
- Phase 5 depends on Phase 2 backup/diff and Phase 3 token behavior being complete.

Placeholder scan:

- No intentionally blank implementation steps are left.
- Steps that require code define exact file paths, expected APIs, tests, and verification commands.
