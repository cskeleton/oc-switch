# oc-switch Core CLI MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first working oc-switch slice: a tested Core Engine plus CLI that can read OpenClaw config, parse slash-containing model refs, list providers/models, switch primary model, manage allowlist entries, write `.env` safely, and create transaction backups.

**Architecture:** Start with a Bun TypeScript workspace and make `packages/core` the single owner of OpenClaw parsing, mutation, backup, `.env`, and diff guard behavior. `packages/cli` is a thin Commander wrapper around core APIs; Server and WebGUI come in separate plans after core write semantics are stable.

**Tech Stack:** Bun workspace, TypeScript, Vitest, Commander.js, JSON5, Node filesystem APIs.

---

## Scope

This plan implements Phase 1 only:

- Core Engine primitives from the design spec.
- CLI commands needed to validate the real OpenClaw workflow.
- Sanitized fixtures that capture the local slash-model and allowlist shapes.
- Transactional writes with backup packages covering `openclaw.json` and `.env`.

Separate implementation plans should cover:

- REST API and token middleware.
- React WebGUI and iPad Safari testing.
- Packaging, installation, and single-file compile workflow.

## File Structure

Create this structure:

```text
oc-switch/
├── package.json
├── tsconfig.base.json
├── .gitignore
├── packages/
│   ├── core/
│   │   ├── package.json
│   │   ├── src/
│   │   │   ├── index.ts
│   │   │   ├── types.ts
│   │   │   ├── model-ref.ts
│   │   │   ├── paths.ts
│   │   │   ├── config-adapter.ts
│   │   │   ├── env-manager.ts
│   │   │   ├── backup-manager.ts
│   │   │   ├── diff-guard.ts
│   │   │   ├── lock.ts
│   │   │   ├── transaction-writer.ts
│   │   │   └── operations.ts
│   │   └── test/
│   │       ├── fixtures/
│   │       │   ├── openclaw.sample.json
│   │       │   └── env.sample
│   │       ├── model-ref.test.ts
│   │       ├── config-adapter.test.ts
│   │       ├── env-manager.test.ts
│   │       ├── transaction-writer.test.ts
│   │       └── operations.test.ts
│   └── cli/
│       ├── package.json
│       ├── src/
│       │   └── index.ts
│       └── test/
│           └── cli.test.ts
└── presets/
    └── builtin/
        └── openai-compatible.json
```

Responsibilities:

- `types.ts`: shared OpenClaw, preset, allowlist, and operation result types.
- `model-ref.ts`: only place that parses or formats `provider/model` refs.
- `config-adapter.ts`: read, summarize, and mutate OpenClaw JSON data in memory.
- `env-manager.ts`: manage oc-switch `.env` block and manifest-friendly metadata.
- `backup-manager.ts`: create and restore backup packages.
- `diff-guard.ts`: verify semantic changes stay inside allowed JSON paths.
- `lock.ts`: serialize writes with `~/.oc-switch/write.lock`.
- `transaction-writer.ts`: orchestrate read, backup, temp writes, rename, rollback.
- `operations.ts`: use model, enable/disable model, delete provider, add provider from preset.
- `packages/cli/src/index.ts`: CLI argument parsing and user-facing output only.

---

### Task 1: Bootstrap Bun Workspace

**Files:**
- Create: `/Users/gc/Dev/MyProject/oc-switch/package.json`
- Create: `/Users/gc/Dev/MyProject/oc-switch/tsconfig.base.json`
- Create: `/Users/gc/Dev/MyProject/oc-switch/.gitignore`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/package.json`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/package.json`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/src/index.ts`

- [ ] **Step 1: Create root workspace files**

`/Users/gc/Dev/MyProject/oc-switch/package.json`:

```json
{
  "name": "oc-switch",
  "private": true,
  "type": "module",
  "workspaces": [
    "packages/*"
  ],
  "scripts": {
    "test": "bun test",
    "typecheck": "bunx tsc -b packages/core packages/cli",
    "cli": "bun run packages/cli/src/index.ts"
  },
  "devDependencies": {
    "@types/bun": "^1.2.0",
    "typescript": "^5.8.0"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "json5": "^2.2.3"
  }
}
```

`/Users/gc/Dev/MyProject/oc-switch/tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "types": ["bun-types"]
  }
}
```

`/Users/gc/Dev/MyProject/oc-switch/.gitignore`:

```gitignore
node_modules/
dist/
.DS_Store
.env
.env.*
!.env.example
coverage/
```

- [ ] **Step 2: Create package manifests**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/package.json`:

```json
{
  "name": "@oc-switch/core",
  "type": "module",
  "main": "src/index.ts",
  "types": "src/index.ts",
  "scripts": {
    "test": "bun test test",
    "typecheck": "bunx tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "json5": "^2.2.3"
  }
}
```

`/Users/gc/Dev/MyProject/oc-switch/packages/cli/package.json`:

```json
{
  "name": "oc-switch",
  "type": "module",
  "bin": {
    "oc-switch": "src/index.ts"
  },
  "scripts": {
    "test": "bun test test",
    "typecheck": "bunx tsc --noEmit -p tsconfig.json"
  },
  "dependencies": {
    "@oc-switch/core": "workspace:*",
    "commander": "^12.1.0"
  }
}
```

- [ ] **Step 3: Create package TypeScript configs**

Create `packages/core/tsconfig.json` and `packages/cli/tsconfig.json` with this content, changing only package-specific `include` paths:

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

- [ ] **Step 4: Add temporary entry points**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`:

```ts
export const version = "0.1.0";
```

`/Users/gc/Dev/MyProject/oc-switch/packages/cli/src/index.ts`:

```ts
#!/usr/bin/env bun
import { Command } from "commander";
import { version } from "@oc-switch/core";

const program = new Command();

program
  .name("oc-switch")
  .description("Manage local OpenClaw provider and model configuration")
  .version(version);

program.parse();
```

- [ ] **Step 5: Install and verify**

Run:

```bash
bun install
bun test
bun run typecheck
```

Expected:

```text
0 pass
0 fail
```

Typecheck should exit with code `0`.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.base.json .gitignore packages/core packages/cli
git commit -m "chore: bootstrap bun workspace"
```

---

### Task 2: Implement ModelRef Parsing

**Files:**
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/model-ref.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/model-ref.test.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`

- [ ] **Step 1: Write failing tests**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/test/model-ref.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { formatModelRef, parseModelRef } from "../src/model-ref";

describe("parseModelRef", () => {
  test("splits only on the first slash", () => {
    expect(parseModelRef("nvidia/deepseek-ai/deepseek-v4-flash")).toEqual({
      providerId: "nvidia",
      modelId: "deepseek-ai/deepseek-v4-flash"
    });
  });

  test("preserves provider casing", () => {
    expect(parseModelRef("DeepSeek/deepseek-chat")).toEqual({
      providerId: "DeepSeek",
      modelId: "deepseek-chat"
    });
  });

  test("rejects invalid refs", () => {
    expect(() => parseModelRef("nvidia")).toThrow("ModelRef must contain a provider and model id");
    expect(() => parseModelRef("/model")).toThrow("ModelRef must contain a provider and model id");
    expect(() => parseModelRef("provider/")).toThrow("ModelRef must contain a provider and model id");
  });
});

describe("formatModelRef", () => {
  test("joins provider and model id without normalizing", () => {
    expect(formatModelRef("OpenRouter", "openrouter/free")).toBe("OpenRouter/openrouter/free");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test packages/core/test/model-ref.test.ts
```

Expected: FAIL because `../src/model-ref` does not exist.

- [ ] **Step 3: Implement parser**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/src/model-ref.ts`:

```ts
export interface ModelRefParts {
  providerId: string;
  modelId: string;
}

export function parseModelRef(ref: string): ModelRefParts {
  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0 || slashIndex === ref.length - 1) {
    throw new Error("ModelRef must contain a provider and model id");
  }

  return {
    providerId: ref.slice(0, slashIndex),
    modelId: ref.slice(slashIndex + 1)
  };
}

export function formatModelRef(providerId: string, modelId: string): string {
  if (!providerId || providerId.includes("/") || !modelId) {
    throw new Error("Invalid provider or model id");
  }
  return `${providerId}/${modelId}`;
}
```

Update `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`:

```ts
export const version = "0.1.0";
export * from "./model-ref";
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
bun test packages/core/test/model-ref.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/model-ref.ts packages/core/src/index.ts packages/core/test/model-ref.test.ts
git commit -m "feat(core): parse slash model refs"
```

---

### Task 3: Add Sanitized OpenClaw Fixture and Config Adapter

**Files:**
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/fixtures/openclaw.sample.json`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/types.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/config-adapter.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/config-adapter.test.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`

- [ ] **Step 1: Add fixture**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/test/fixtures/openclaw.sample.json`:

```json
{
  "models": {
    "mode": "merge",
    "providers": {
      "nvidia": {
        "baseUrl": "https://integrate.api.nvidia.com/v1",
        "apiKey": { "source": "env", "id": "NVIDIA_API_KEY" },
        "api": "openai-completions",
        "models": [
          {
            "id": "deepseek-ai/deepseek-v4-flash",
            "name": "DeepSeek V4 Flash",
            "reasoning": true,
            "contextWindow": 128000,
            "maxTokens": 8192
          },
          {
            "id": "z-ai/glm5.1",
            "name": "GLM 5.1",
            "contextWindow": 128000,
            "maxTokens": 8192
          }
        ]
      },
      "DeepSeek": {
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": { "source": "env", "id": "DEEPSEEK_API_KEY" },
        "api": "openai-completions",
        "models": [
          {
            "id": "deepseek-chat",
            "name": "DeepSeek Chat"
          }
        ]
      },
      "minimax-portal": {
        "baseUrl": "https://api.minimax.io/anthropic",
        "api": "anthropic-messages",
        "authHeader": { "source": "env", "id": "MINIMAX_API_KEY" },
        "models": [
          {
            "id": "MiniMax-M3",
            "name": "MiniMax M3",
            "api": "anthropic-messages"
          }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": "minimax-portal/MiniMax-M3",
      "models": {
        "nvidia/deepseek-ai/deepseek-v4-flash": {
          "alias": "nv-ds-flash",
          "agentRuntime": { "id": "codex" }
        },
        "nvidia/z-ai/glm5.1": {
          "alias": "nv-glm"
        },
        "DeepSeek/deepseek-chat": {
          "alias": "ds-chat"
        },
        "minimax-portal/MiniMax-M3": {
          "alias": "mm3"
        }
      }
    }
  },
  "channels": {
    "preserve": true
  },
  "acp": {
    "preserve": true
  }
}
```

- [ ] **Step 2: Write failing adapter tests**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/test/config-adapter.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import sample from "./fixtures/openclaw.sample.json";
import { createConfigAdapter } from "../src/config-adapter";

describe("ConfigAdapter", () => {
  test("lists providers with model and allowlist counts", () => {
    const adapter = createConfigAdapter(sample);
    expect(adapter.listProviders()).toEqual([
      {
        id: "nvidia",
        api: "openai-completions",
        modelCount: 2,
        enabledModelCount: 2,
        containsPrimary: false
      },
      {
        id: "DeepSeek",
        api: "openai-completions",
        modelCount: 1,
        enabledModelCount: 1,
        containsPrimary: false
      },
      {
        id: "minimax-portal",
        api: "anthropic-messages",
        modelCount: 1,
        enabledModelCount: 1,
        containsPrimary: true
      }
    ]);
  });

  test("lists models while preserving slash model ids", () => {
    const adapter = createConfigAdapter(sample);
    expect(adapter.listModels().map((model) => model.ref)).toContain("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(adapter.listModels().find((model) => model.ref === "nvidia/deepseek-ai/deepseek-v4-flash")).toMatchObject({
      providerId: "nvidia",
      modelId: "deepseek-ai/deepseek-v4-flash",
      enabled: true,
      alias: "nv-ds-flash"
    });
  });

  test("reports status", () => {
    const adapter = createConfigAdapter(sample);
    expect(adapter.getStatus()).toEqual({
      primaryModel: "minimax-portal/MiniMax-M3",
      providerCount: 3,
      providerModelCount: 4,
      allowlistModelCount: 4
    });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
bun test packages/core/test/config-adapter.test.ts
```

Expected: FAIL because `config-adapter.ts` and `types.ts` do not exist.

- [ ] **Step 4: Add types**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/src/types.ts`:

```ts
export type ApiType = "openai-completions" | "anthropic-messages" | "google-generative-ai";

export interface EnvRef {
  source: "env";
  id: string;
}

export interface OpenClawModel {
  id: string;
  name?: string;
  alias?: string;
  api?: ApiType;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  cost?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenClawProvider {
  baseUrl?: string;
  api?: ApiType;
  apiKey?: EnvRef;
  authHeader?: EnvRef;
  models?: OpenClawModel[];
  [key: string]: unknown;
}

export interface AllowlistEntry {
  alias?: string;
  agentRuntime?: { id: string };
  [key: string]: unknown;
}

export interface OpenClawConfig {
  models?: {
    mode?: string;
    providers?: Record<string, OpenClawProvider>;
    [key: string]: unknown;
  };
  agents?: {
    defaults?: {
      model?: string;
      models?: Record<string, AllowlistEntry>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ProviderSummary {
  id: string;
  api: string | undefined;
  modelCount: number;
  enabledModelCount: number;
  containsPrimary: boolean;
}

export interface ModelSummary {
  ref: string;
  providerId: string;
  modelId: string;
  name: string | undefined;
  alias: string | undefined;
  enabled: boolean;
  isPrimary: boolean;
}

export interface StatusSummary {
  primaryModel: string | undefined;
  providerCount: number;
  providerModelCount: number;
  allowlistModelCount: number;
}
```

- [ ] **Step 5: Implement adapter**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/src/config-adapter.ts`:

```ts
import { formatModelRef, parseModelRef } from "./model-ref";
import type { ModelSummary, OpenClawConfig, ProviderSummary, StatusSummary } from "./types";

export function createConfigAdapter(config: OpenClawConfig) {
  const providers = config.models?.providers ?? {};
  const allowlist = config.agents?.defaults?.models ?? {};
  const primaryModel = config.agents?.defaults?.model;

  function providerModelRefs(providerId: string): string[] {
    return (providers[providerId]?.models ?? []).map((model) => formatModelRef(providerId, model.id));
  }

  return {
    listProviders(): ProviderSummary[] {
      return Object.entries(providers).map(([id, provider]) => {
        const refs = providerModelRefs(id);
        return {
          id,
          api: provider.api,
          modelCount: refs.length,
          enabledModelCount: refs.filter((ref) => allowlist[ref]).length,
          containsPrimary: primaryModel ? parseModelRef(primaryModel).providerId === id : false
        };
      });
    },

    listModels(): ModelSummary[] {
      return Object.entries(providers).flatMap(([providerId, provider]) =>
        (provider.models ?? []).map((model) => {
          const ref = formatModelRef(providerId, model.id);
          const entry = allowlist[ref];
          return {
            ref,
            providerId,
            modelId: model.id,
            name: model.name,
            alias: entry?.alias,
            enabled: Boolean(entry),
            isPrimary: primaryModel === ref
          };
        })
      );
    },

    getStatus(): StatusSummary {
      return {
        primaryModel,
        providerCount: Object.keys(providers).length,
        providerModelCount: Object.values(providers).reduce((sum, provider) => sum + (provider.models?.length ?? 0), 0),
        allowlistModelCount: Object.keys(allowlist).length
      };
    }
  };
}
```

Update `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`:

```ts
export const version = "0.1.0";
export * from "./types";
export * from "./model-ref";
export * from "./config-adapter";
```

- [ ] **Step 6: Verify**

Run:

```bash
bun test packages/core/test/config-adapter.test.ts
bun test packages/core/test/model-ref.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src packages/core/test
git commit -m "feat(core): summarize openclaw config"
```

---

### Task 4: Implement `.env` Managed Block

**Files:**
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/fixtures/env.sample`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/env-manager.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/env-manager.test.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`

- [ ] **Step 1: Add env fixture**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/test/fixtures/env.sample`:

```dotenv
USER_DEFINED_API_KEY=keep-me
# oc-switch:start
NVIDIA_API_KEY=old-value
# oc-switch:end
OTHER_SETTING=keep-too
```

- [ ] **Step 2: Write failing env tests**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/test/env-manager.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { updateManagedEnv } from "../src/env-manager";

const fixture = readFileSync(join(import.meta.dir, "fixtures/env.sample"), "utf8");

describe("updateManagedEnv", () => {
  test("updates only oc-switch block", () => {
    const result = updateManagedEnv(fixture, { NVIDIA_API_KEY: "new-value", ELYSIVER_API_KEY: "created" });
    expect(result.content).toContain("USER_DEFINED_API_KEY=keep-me");
    expect(result.content).toContain("NVIDIA_API_KEY=new-value");
    expect(result.content).toContain("ELYSIVER_API_KEY=created");
    expect(result.content).toContain("OTHER_SETTING=keep-too");
    expect(result.changedKeys).toEqual(["NVIDIA_API_KEY", "ELYSIVER_API_KEY"]);
  });

  test("rejects unmanaged key collision by default", () => {
    expect(() => updateManagedEnv(fixture, { USER_DEFINED_API_KEY: "replace" })).toThrow(
      "Refusing to overwrite unmanaged env var USER_DEFINED_API_KEY"
    );
  });

  test("creates managed block when env file has no block", () => {
    const result = updateManagedEnv("PLAIN=value\n", { NEW_API_KEY: "secret" });
    expect(result.content).toBe("PLAIN=value\n# oc-switch:start\nNEW_API_KEY=secret\n# oc-switch:end\n");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
bun test packages/core/test/env-manager.test.ts
```

Expected: FAIL because `env-manager.ts` does not exist.

- [ ] **Step 4: Implement env manager**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/src/env-manager.ts`:

```ts
const START = "# oc-switch:start";
const END = "# oc-switch:end";

export interface EnvUpdateResult {
  content: string;
  changedKeys: string[];
}

export function updateManagedEnv(content: string, updates: Record<string, string>): EnvUpdateResult {
  const lines = content.length ? content.split(/\n/) : [];
  if (lines.at(-1) === "") lines.pop();

  const startIndex = lines.indexOf(START);
  const endIndex = lines.indexOf(END);
  const hasBlock = startIndex >= 0 && endIndex > startIndex;
  const unmanaged = new Set<string>();

  lines.forEach((line, index) => {
    const insideBlock = hasBlock && index > startIndex && index < endIndex;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (match && !insideBlock) unmanaged.add(match[1]);
  });

  for (const key of Object.keys(updates)) {
    if (unmanaged.has(key)) {
      throw new Error(`Refusing to overwrite unmanaged env var ${key}`);
    }
  }

  const blockValues = new Map<string, string>();
  if (hasBlock) {
    for (const line of lines.slice(startIndex + 1, endIndex)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (match) blockValues.set(match[1], match[2]);
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    blockValues.set(key, value);
  }

  const block = [
    START,
    ...Array.from(blockValues.entries()).map(([key, value]) => `${key}=${value}`),
    END
  ];

  const nextLines = hasBlock
    ? [...lines.slice(0, startIndex), ...block, ...lines.slice(endIndex + 1)]
    : [...lines, ...block];

  return {
    content: `${nextLines.join("\n")}\n`,
    changedKeys: Object.keys(updates)
  };
}
```

Update `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`:

```ts
export const version = "0.1.0";
export * from "./types";
export * from "./model-ref";
export * from "./config-adapter";
export * from "./env-manager";
```

- [ ] **Step 5: Verify**

Run:

```bash
bun test packages/core/test/env-manager.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/env-manager.ts packages/core/src/index.ts packages/core/test/env-manager.test.ts packages/core/test/fixtures/env.sample
git commit -m "feat(core): manage env block safely"
```

---

### Task 5: Implement Core Operations In Memory

**Files:**
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/operations.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/operations.test.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`

- [ ] **Step 1: Write failing operation tests**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/test/operations.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import sample from "./fixtures/openclaw.sample.json";
import { deleteProvider, disableModel, enableModel, setPrimaryModel } from "../src/operations";

function cloneSample() {
  return structuredClone(sample);
}

describe("operations", () => {
  test("sets primary model only when provider and model exist", () => {
    const config = cloneSample();
    const result = setPrimaryModel(config, "nvidia/deepseek-ai/deepseek-v4-flash");
    expect(result.config.agents?.defaults?.model).toBe("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(() => setPrimaryModel(config, "nvidia/missing")).toThrow("Model nvidia/missing is not defined in provider models");
  });

  test("disables and re-enables allowlist entry while preserving provider model", () => {
    const config = cloneSample();
    const disabled = disableModel(config, "nvidia/deepseek-ai/deepseek-v4-flash");
    expect(disabled.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeUndefined();
    expect(disabled.config.models?.providers?.nvidia?.models?.[0]?.id).toBe("deepseek-ai/deepseek-v4-flash");

    const enabled = enableModel(disabled.config, "nvidia/deepseek-ai/deepseek-v4-flash", "nv-ds-flash");
    expect(enabled.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-flash"]).toEqual({
      alias: "nv-ds-flash"
    });
  });

  test("deletes provider by first path segment only", () => {
    const config = cloneSample();
    const result = deleteProvider(config, "nvidia", { force: true });
    expect(result.config.models?.providers?.nvidia).toBeUndefined();
    expect(Object.keys(result.config.agents?.defaults?.models ?? {})).not.toContain("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(result.config.agents?.defaults?.models?.["DeepSeek/deepseek-chat"]).toEqual({ alias: "ds-chat" });
  });

  test("requires force when deleting provider containing primary", () => {
    const config = cloneSample();
    expect(() => deleteProvider(config, "minimax-portal", { force: false })).toThrow(
      "Provider minimax-portal contains the primary model"
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test packages/core/test/operations.test.ts
```

Expected: FAIL because `operations.ts` does not exist.

- [ ] **Step 3: Implement operations**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/src/operations.ts`:

```ts
import { formatModelRef, parseModelRef } from "./model-ref";
import type { AllowlistEntry, OpenClawConfig } from "./types";

export interface OperationResult {
  config: OpenClawConfig;
  warnings: string[];
}

function ensureDefaults(config: OpenClawConfig) {
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.models ??= {};
  config.models ??= {};
  config.models.providers ??= {};
}

function hasProviderModel(config: OpenClawConfig, ref: string): boolean {
  const { providerId, modelId } = parseModelRef(ref);
  const provider = config.models?.providers?.[providerId];
  return Boolean(provider?.models?.some((model) => model.id === modelId));
}

export function setPrimaryModel(config: OpenClawConfig, ref: string): OperationResult {
  ensureDefaults(config);
  if (!hasProviderModel(config, ref)) {
    throw new Error(`Model ${ref} is not defined in provider models`);
  }
  config.agents!.defaults!.model = ref;
  return { config, warnings: [] };
}

export function disableModel(config: OpenClawConfig, ref: string): OperationResult {
  ensureDefaults(config);
  delete config.agents!.defaults!.models![ref];
  return { config, warnings: [] };
}

export function enableModel(config: OpenClawConfig, ref: string, alias?: string): OperationResult {
  ensureDefaults(config);
  if (!hasProviderModel(config, ref)) {
    throw new Error(`Model ${ref} is not defined in provider models`);
  }
  const existing = config.agents!.defaults!.models![ref] ?? {};
  const next: AllowlistEntry = alias ? { ...existing, alias } : existing;
  config.agents!.defaults!.models![ref] = next;
  return { config, warnings: [] };
}

export function deleteProvider(config: OpenClawConfig, providerId: string, options: { force: boolean }): OperationResult {
  ensureDefaults(config);
  const primary = config.agents!.defaults!.model;
  if (primary && parseModelRef(primary).providerId === providerId && !options.force) {
    throw new Error(`Provider ${providerId} contains the primary model`);
  }

  delete config.models!.providers![providerId];

  for (const ref of Object.keys(config.agents!.defaults!.models!)) {
    if (parseModelRef(ref).providerId === providerId) {
      delete config.agents!.defaults!.models![ref];
    }
  }

  const warnings = primary && parseModelRef(primary).providerId === providerId
    ? [`Primary model ${primary} now points to a deleted provider`]
    : [];

  return { config, warnings };
}

export function definedRefs(config: OpenClawConfig): string[] {
  const providers = config.models?.providers ?? {};
  return Object.entries(providers).flatMap(([providerId, provider]) =>
    (provider.models ?? []).map((model) => formatModelRef(providerId, model.id))
  );
}
```

Update `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`:

```ts
export const version = "0.1.0";
export * from "./types";
export * from "./model-ref";
export * from "./config-adapter";
export * from "./env-manager";
export * from "./operations";
```

- [ ] **Step 4: Verify**

Run:

```bash
bun test packages/core/test/operations.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/operations.ts packages/core/src/index.ts packages/core/test/operations.test.ts
git commit -m "feat(core): mutate provider and model config"
```

---

### Task 6: Add Backup, Lock, Diff Guard, and Transaction Writer

**Files:**
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/backup-manager.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/diff-guard.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/lock.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/transaction-writer.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/transaction-writer.test.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`

- [ ] **Step 1: Write failing transaction tests**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/test/transaction-writer.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "./fixtures/openclaw.sample.json";
import { writeOpenClawTransaction } from "../src/transaction-writer";

const tempDirs: string[] = [];

function makeWorkspace() {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-test-"));
  tempDirs.push(dir);
  const openclawPath = join(dir, "openclaw.json");
  const envPath = join(dir, ".env");
  const stateDir = join(dir, ".oc-switch");
  writeFileSync(openclawPath, `${JSON.stringify(sample, null, 2)}\n`);
  writeFileSync(envPath, "USER_DEFINED_API_KEY=keep\n");
  return { dir, openclawPath, envPath, stateDir };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("writeOpenClawTransaction", () => {
  test("writes config and env with backup package", async () => {
    const ws = makeWorkspace();
    const result = await writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "test write",
      envUpdates: { NVIDIA_API_KEY: "secret" },
      mutate(config) {
        config.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";
        return config;
      }
    });

    expect(result.backupDir).toContain(".oc-switch/backups/");
    expect(readFileSync(ws.openclawPath, "utf8")).toContain("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(readFileSync(ws.envPath, "utf8")).toContain("NVIDIA_API_KEY=secret");
    expect(readFileSync(join(result.backupDir, "openclaw.json"), "utf8")).toContain("minimax-portal/MiniMax-M3");
    expect(readFileSync(join(result.backupDir, ".env"), "utf8")).toContain("USER_DEFINED_API_KEY=keep");
  });

  test("rejects unmanaged env collisions before writing config", async () => {
    const ws = makeWorkspace();
    await expect(writeOpenClawTransaction({
      openclawPath: ws.openclawPath,
      envPath: ws.envPath,
      stateDir: ws.stateDir,
      reason: "collision",
      envUpdates: { USER_DEFINED_API_KEY: "replace" },
      mutate(config) {
        config.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";
        return config;
      }
    })).rejects.toThrow("Refusing to overwrite unmanaged env var USER_DEFINED_API_KEY");

    expect(readFileSync(ws.openclawPath, "utf8")).toContain("minimax-portal/MiniMax-M3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test packages/core/test/transaction-writer.test.ts
```

Expected: FAIL because transaction modules do not exist.

- [ ] **Step 3: Implement backup manager**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/src/backup-manager.ts`:

```ts
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface BackupInput {
  stateDir: string;
  openclawPath: string;
  envPath: string;
  reason: string;
  beforeHash: string;
}

export function createBackup(input: BackupInput): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = join(input.stateDir, "backups", timestamp);
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(input.openclawPath, join(backupDir, "openclaw.json"));
  if (existsSync(input.envPath)) copyFileSync(input.envPath, join(backupDir, ".env"));
  writeFileSync(join(backupDir, "metadata.json"), `${JSON.stringify({
    reason: input.reason,
    openclawPath: input.openclawPath,
    envPath: input.envPath,
    beforeHash: input.beforeHash,
    sourceFiles: [basename(input.openclawPath), basename(input.envPath)],
    createdAt: new Date().toISOString()
  }, null, 2)}\n`);
  return backupDir;
}
```

- [ ] **Step 4: Implement diff guard**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/src/diff-guard.ts`:

```ts
import type { OpenClawConfig } from "./types";

const allowedTopLevel = new Set(["models", "agents"]);

export function assertAllowedSemanticChange(before: OpenClawConfig, after: OpenClawConfig): void {
  const beforeKeys = Object.keys(before);
  const afterKeys = Object.keys(after);
  for (const key of new Set([...beforeKeys, ...afterKeys])) {
    if (!allowedTopLevel.has(key) && JSON.stringify(before[key]) !== JSON.stringify(after[key])) {
      throw new Error(`Diff guard blocked change to ${key}`);
    }
  }

  if (JSON.stringify(before.models?.mode) !== JSON.stringify(after.models?.mode)) {
    throw new Error("Diff guard blocked change to models.mode");
  }
}
```

- [ ] **Step 5: Implement lock**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/src/lock.ts`:

```ts
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  mkdirSync(dirname(lockPath), { recursive: true });
  let fd: number;
  try {
    fd = openSync(lockPath, "wx");
  } catch {
    throw new Error("Another oc-switch write is already running");
  }

  try {
    writeFileSync(fd, `${process.pid}\n`);
    return await fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}
```

- [ ] **Step 6: Implement transaction writer**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/src/transaction-writer.ts`:

```ts
import JSON5 from "json5";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBackup } from "./backup-manager";
import { assertAllowedSemanticChange } from "./diff-guard";
import { updateManagedEnv } from "./env-manager";
import { withFileLock } from "./lock";
import type { OpenClawConfig } from "./types";

export interface TransactionInput {
  openclawPath: string;
  envPath: string;
  stateDir: string;
  reason: string;
  envUpdates?: Record<string, string>;
  mutate(config: OpenClawConfig): OpenClawConfig;
}

export interface TransactionResult {
  backupDir: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function restoreFromBackup(backupDir: string, openclawPath: string, envPath: string): void {
  copyFileSync(join(backupDir, "openclaw.json"), openclawPath);
  const backupEnv = join(backupDir, ".env");
  if (existsSync(backupEnv)) {
    copyFileSync(backupEnv, envPath);
  } else {
    rmSync(envPath, { force: true });
  }
}

export async function writeOpenClawTransaction(input: TransactionInput): Promise<TransactionResult> {
  return withFileLock(join(input.stateDir, "write.lock"), async () => {
    const beforeRaw = readFileSync(input.openclawPath, "utf8");
    const beforeConfig = JSON5.parse(beforeRaw) as OpenClawConfig;
    const beforeHash = sha256(beforeRaw);
    const beforeEnv = existsSync(input.envPath) ? readFileSync(input.envPath, "utf8") : "";

    const afterConfig = input.mutate(structuredClone(beforeConfig));
    assertAllowedSemanticChange(beforeConfig, afterConfig);
    const afterRaw = `${JSON.stringify(afterConfig, null, 2)}\n`;
    const afterEnv = input.envUpdates && Object.keys(input.envUpdates).length
      ? updateManagedEnv(beforeEnv, input.envUpdates).content
      : beforeEnv;

    const backupDir = createBackup({
      stateDir: input.stateDir,
      openclawPath: input.openclawPath,
      envPath: input.envPath,
      reason: input.reason,
      beforeHash
    });

    mkdirSync(dirname(input.openclawPath), { recursive: true });
    mkdirSync(dirname(input.envPath), { recursive: true });
    const configTmp = `${input.openclawPath}.tmp`;
    const envTmp = `${input.envPath}.tmp`;
    try {
      writeFileSync(configTmp, afterRaw);
      writeFileSync(envTmp, afterEnv);
      renameSync(envTmp, input.envPath);
      renameSync(configTmp, input.openclawPath);
    } catch (error) {
      restoreFromBackup(backupDir, input.openclawPath, input.envPath);
      rmSync(configTmp, { force: true });
      rmSync(envTmp, { force: true });
      throw error;
    }

    return { backupDir };
  });
}
```

Update `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`:

```ts
export const version = "0.1.0";
export * from "./types";
export * from "./model-ref";
export * from "./config-adapter";
export * from "./env-manager";
export * from "./operations";
export * from "./transaction-writer";
```

- [ ] **Step 7: Verify**

Run:

```bash
bun test packages/core/test/transaction-writer.test.ts
```

Expected: all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/core/src packages/core/test/transaction-writer.test.ts
git commit -m "feat(core): write config transactions with backups"
```

---

### Task 7: Implement CLI Read Commands

**Files:**
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/paths.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/src/index.ts`
- Create: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/test/cli.test.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`

- [ ] **Step 1: Add path resolver**

`/Users/gc/Dev/MyProject/oc-switch/packages/core/src/paths.ts`:

```ts
import { homedir } from "node:os";
import { join } from "node:path";

export interface OcSwitchPaths {
  openclawPath: string;
  envPath: string;
  stateDir: string;
}

export function defaultPaths(env: NodeJS.ProcessEnv = process.env): OcSwitchPaths {
  const openclawPath = env.OPENCLAW_CONFIG_PATH ?? join(homedir(), ".openclaw", "openclaw.json");
  return {
    openclawPath,
    envPath: join(homedir(), ".openclaw", ".env"),
    stateDir: join(homedir(), ".oc-switch")
  };
}
```

Update `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/index.ts`:

```ts
export const version = "0.1.0";
export * from "./types";
export * from "./model-ref";
export * from "./config-adapter";
export * from "./env-manager";
export * from "./operations";
export * from "./transaction-writer";
export * from "./paths";
```

- [ ] **Step 2: Write CLI tests for status and list commands**

`/Users/gc/Dev/MyProject/oc-switch/packages/cli/test/cli.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "../../core/test/fixtures/openclaw.sample.json";

async function runCli(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn(["bun", "run", "packages/cli/src/index.ts", ...args], {
    cwd: join(import.meta.dir, "../../.."),
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    code: await proc.exited,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text()
  };
}

describe("cli read commands", () => {
  test("prints status", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["status"], { OPENCLAW_CONFIG_PATH: configPath });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Primary: minimax-portal/MiniMax-M3");
    expect(result.stdout).toContain("Providers: 3");
    expect(result.stdout).toContain("Allowlist models: 4");
  });

  test("prints providers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["providers", "list"], { OPENCLAW_CONFIG_PATH: configPath });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("nvidia");
    expect(result.stdout).toContain("minimax-portal");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:

```bash
bun test packages/cli/test/cli.test.ts
```

Expected: FAIL because CLI has no commands.

- [ ] **Step 4: Implement CLI read commands**

`/Users/gc/Dev/MyProject/oc-switch/packages/cli/src/index.ts`:

```ts
#!/usr/bin/env bun
import { Command } from "commander";
import JSON5 from "json5";
import { readFileSync } from "node:fs";
import { createConfigAdapter, defaultPaths, version } from "@oc-switch/core";
import type { OpenClawConfig } from "@oc-switch/core";

function readConfig(): OpenClawConfig {
  const paths = defaultPaths();
  return JSON5.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
}

const program = new Command();

program
  .name("oc-switch")
  .description("Manage local OpenClaw provider and model configuration")
  .version(version);

program.command("status").action(() => {
  const status = createConfigAdapter(readConfig()).getStatus();
  console.log(`Primary: ${status.primaryModel ?? "(none)"}`);
  console.log(`Providers: ${status.providerCount}`);
  console.log(`Provider models: ${status.providerModelCount}`);
  console.log(`Allowlist models: ${status.allowlistModelCount}`);
});

const providers = program.command("providers");
providers.command("list").action(() => {
  const rows = createConfigAdapter(readConfig()).listProviders();
  for (const row of rows) {
    console.log(`${row.id}\t${row.api ?? "unknown"}\t${row.enabledModelCount}/${row.modelCount}`);
  }
});

const models = program.command("models");
models.command("list").option("--provider <name>").action((options: { provider?: string }) => {
  const rows = createConfigAdapter(readConfig()).listModels()
    .filter((row) => !options.provider || row.providerId === options.provider);
  for (const row of rows) {
    const flags = [row.enabled ? "enabled" : "disabled", row.isPrimary ? "primary" : ""].filter(Boolean).join(",");
    console.log(`${row.ref}\t${row.alias ?? ""}\t${flags}`);
  }
});

program.parse();
```

- [ ] **Step 5: Verify**

Run:

```bash
bun test packages/cli/test/cli.test.ts
bun run packages/cli/src/index.ts status
```

Expected: tests PASS. The manual `status` command should read the real `~/.openclaw/openclaw.json` and print counts without API keys.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/paths.ts packages/core/src/index.ts packages/cli/src/index.ts packages/cli/test/cli.test.ts
git commit -m "feat(cli): add status and list commands"
```

---

### Task 8: Implement CLI Write Commands

**Files:**
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/src/index.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/cli/test/cli.test.ts`

- [ ] **Step 1: Add CLI write tests**

Append to `/Users/gc/Dev/MyProject/oc-switch/packages/cli/test/cli.test.ts`:

```ts
describe("cli write commands", () => {
  test("uses slash-containing model ref", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["use", "nvidia/deepseek-ai/deepseek-v4-flash"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Primary model set to nvidia/deepseek-ai/deepseek-v4-flash");
  });

  test("disables model allowlist entry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-cli-"));
    const configPath = join(dir, "openclaw.json");
    writeFileSync(configPath, `${JSON.stringify(sample, null, 2)}\n`);

    const result = await runCli(["model", "disable", "nvidia/deepseek-ai/deepseek-v4-flash"], {
      OPENCLAW_CONFIG_PATH: configPath,
      HOME: dir
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Disabled nvidia/deepseek-ai/deepseek-v4-flash");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
bun test packages/cli/test/cli.test.ts
```

Expected: FAIL because `use` and `model disable` are not implemented.

- [ ] **Step 3: Implement write commands**

Extend `/Users/gc/Dev/MyProject/oc-switch/packages/cli/src/index.ts` by importing operations and transaction writer:

```ts
import {
  createConfigAdapter,
  defaultPaths,
  disableModel,
  enableModel,
  setPrimaryModel,
  version,
  writeOpenClawTransaction
} from "@oc-switch/core";
```

Add commands before `program.parse()`:

```ts
program.command("use")
  .argument("<ref>")
  .action(async (ref: string) => {
    const paths = defaultPaths();
    await writeOpenClawTransaction({
      ...paths,
      reason: `set primary model ${ref}`,
      mutate(config) {
        return setPrimaryModel(config, ref).config;
      }
    });
    console.log(`Primary model set to ${ref}`);
  });

const model = program.command("model");
model.command("disable")
  .argument("<ref>")
  .action(async (ref: string) => {
    const paths = defaultPaths();
    await writeOpenClawTransaction({
      ...paths,
      reason: `disable model ${ref}`,
      mutate(config) {
        return disableModel(config, ref).config;
      }
    });
    console.log(`Disabled ${ref}`);
  });

model.command("enable")
  .argument("<ref>")
  .option("--alias <alias>")
  .action(async (ref: string, options: { alias?: string }) => {
    const paths = defaultPaths();
    await writeOpenClawTransaction({
      ...paths,
      reason: `enable model ${ref}`,
      mutate(config) {
        return enableModel(config, ref, options.alias).config;
      }
    });
    console.log(`Enabled ${ref}`);
  });
```

If the file already has `const models = program.command("models")`, keep `models list` for read commands and use singular `model` for write commands to match the design spec.

- [ ] **Step 4: Verify**

Run:

```bash
bun test packages/cli/test/cli.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/test/cli.test.ts
git commit -m "feat(cli): add model write commands"
```

---

### Task 9: Add Preset Add MVP

**Files:**
- Create: `/Users/gc/Dev/MyProject/oc-switch/presets/builtin/openai-compatible.json`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/types.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/operations.ts`
- Modify: `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/operations.test.ts`

- [ ] **Step 1: Add generic preset**

`/Users/gc/Dev/MyProject/oc-switch/presets/builtin/openai-compatible.json`:

```json
{
  "id": "openai-compatible",
  "name": "OpenAI Compatible",
  "tags": ["openai-compatible"],
  "provider": {
    "api": "openai-completions",
    "baseUrl": "https://example.com/v1",
    "apiKeyEnv": "OPENAI_COMPATIBLE_API_KEY"
  },
  "models": [
    {
      "id": "model-id",
      "name": "Model",
      "alias": "model"
    }
  ]
}
```

- [ ] **Step 2: Add preset types**

Append to `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/types.ts`:

```ts
export interface ProviderPreset {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  provider: {
    api: ApiType;
    baseUrl: string;
    apiKeyEnv: string;
  };
  models: Array<OpenClawModel & { alias?: string }>;
}
```

- [ ] **Step 3: Add operation test**

Append to `/Users/gc/Dev/MyProject/oc-switch/packages/core/test/operations.test.ts`:

```ts
import type { ProviderPreset } from "../src/types";
import { addProviderFromPreset } from "../src/operations";

describe("addProviderFromPreset", () => {
  test("adds provider, env ref, models, and allowlist", () => {
    const config = cloneSample();
    const preset: ProviderPreset = {
      id: "custom",
      name: "Custom",
      provider: {
        api: "openai-completions",
        baseUrl: "https://custom.example/v1",
        apiKeyEnv: "CUSTOM_API_KEY"
      },
      models: [
        { id: "vendor/model", name: "Vendor Model", alias: "vendor" }
      ]
    };

    const result = addProviderFromPreset(config, preset, ["vendor/model"]);
    expect(result.config.models?.providers?.custom?.apiKey).toEqual({ source: "env", id: "CUSTOM_API_KEY" });
    expect(result.config.models?.providers?.custom?.models?.[0]?.id).toBe("vendor/model");
    expect(result.config.agents?.defaults?.models?.["custom/vendor/model"]).toEqual({ alias: "vendor" });
  });
});
```

- [ ] **Step 4: Implement preset add operation**

Update the existing type import in `/Users/gc/Dev/MyProject/oc-switch/packages/core/src/operations.ts`:

```ts
import type { AllowlistEntry, OpenClawConfig, ProviderPreset } from "./types";
```

Append this function to the same file:

```ts
export function addProviderFromPreset(
  config: OpenClawConfig,
  preset: ProviderPreset,
  enabledModelIds: string[] = preset.models.map((model) => model.id)
): OperationResult {
  ensureDefaults(config);
  config.models!.providers![preset.id] = {
    baseUrl: preset.provider.baseUrl,
    apiKey: { source: "env", id: preset.provider.apiKeyEnv },
    api: preset.provider.api,
    models: preset.models.map(({ alias, ...model }) => model)
  };

  for (const model of preset.models) {
    if (enabledModelIds.includes(model.id)) {
      config.agents!.defaults!.models![formatModelRef(preset.id, model.id)] = model.alias
        ? { alias: model.alias }
        : {};
    }
  }

  return { config, warnings: [] };
}
```

- [ ] **Step 5: Verify**

Run:

```bash
bun test packages/core/test/operations.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add presets/builtin/openai-compatible.json packages/core/src packages/core/test/operations.test.ts
git commit -m "feat(core): add provider from preset"
```

---

### Task 10: Final Verification for Phase 1

**Files:**
- Modify: `/Users/gc/Dev/MyProject/oc-switch/README.md`

- [ ] **Step 1: Create README with supported MVP commands**

`/Users/gc/Dev/MyProject/oc-switch/README.md`:

````markdown
# oc-switch

oc-switch manages local OpenClaw provider and model configuration.

## Phase 1 Commands

```bash
oc-switch status
oc-switch providers list
oc-switch models list
oc-switch models list --provider nvidia
oc-switch use nvidia/deepseek-ai/deepseek-v4-flash
oc-switch model enable nvidia/deepseek-ai/deepseek-v4-flash --alias nv-ds-flash
oc-switch model disable nvidia/deepseek-ai/deepseek-v4-flash
```

`OPENCLAW_CONFIG_PATH` can point to a non-default `openclaw.json` for testing.

The tool writes `.env` keys only inside the `# oc-switch:start` and `# oc-switch:end` managed block. Config writes create backup packages under `~/.oc-switch/backups/`.
````

- [ ] **Step 2: Run full verification**

Run:

```bash
bun test
bun run typecheck
OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json" bun run packages/cli/src/index.ts status
OPENCLAW_CONFIG_PATH="$HOME/.openclaw/openclaw.json" bun run packages/cli/src/index.ts models list --provider nvidia
```

Expected:

```text
All tests pass.
Typecheck exits with code 0.
status prints the real primary model and counts.
models list --provider nvidia includes nvidia/deepseek-ai/deepseek-v4-flash.
No API key values are printed.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document core cli mvp"
```

---

## Self-Review

Spec coverage:

- Slash model refs: Task 2 and fixture tests.
- Case-sensitive providers: Task 3 fixture and adapter tests.
- Allowlist preservation: Task 5 covers enable/disable semantics; add a follow-on core test before REST work that updates alias while preserving `agentRuntime`.
- `.env` managed block and conflict rejection: Task 4.
- Transaction backup for config and `.env`: Task 6.
- CLI status, providers list, models list, use, enable, disable: Tasks 7 and 8.
- Preset add foundation: Task 9.

Known Phase 1 exclusions:

- Hono REST API.
- React WebGUI.
- Token lifecycle.
- Provider sync adapters.
- Full built-in preset catalog.
- Packaging and release workflow.

Placeholder scan:

- No placeholder instructions are present.
- Each task has concrete file paths, commands, expected results, and commit points.

Type consistency:

- `OpenClawConfig`, `ProviderPreset`, `AllowlistEntry`, `parseModelRef`, `formatModelRef`, and `writeOpenClawTransaction` are introduced before use.
- CLI commands call core functions exported from `packages/core/src/index.ts`.
