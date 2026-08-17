import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "../../core/test/fixtures/openclaw.sample.json";
import modelsDevApiFixture from "../../core/test/fixtures/model-metadata/api.json";
import modelsDevModelsFixture from "../../core/test/fixtures/model-metadata/models.json";
import { createApp } from "../src/app";
import type {
  FetchImpl,
  OcSwitchPaths,
  PresetDirs,
  RuntimeDiscoveryProvider,
  RuntimeDiscoveryResult
} from "@oc-switch/core";
import {
  createBackup,
  upsertDisabledProviderState,
  MAX_PROVIDER_MODELS,
  MODELS_DEV_API_URL,
  MODELS_DEV_MODELS_URL
} from "@oc-switch/core";
import { prepareGatewayEnvTarget, expectedGatewayEnvPath } from "../../core/test/gateway-sync-fixture";

const tempDirs: string[] = [];
const TOKEN = "test-secret";
const fixtureBuiltinDir = join(import.meta.dir, "../../core/test/fixtures/presets/builtin");

function authHeaders(token = TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

interface Workspace {
  dir: string;
  homeDir: string;
  paths: OcSwitchPaths;
  presetDirs: PresetDirs;
}

function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-server-"));
  tempDirs.push(dir);
  const homeDir = join(dir, "home");
  mkdirSync(homeDir, { recursive: true });
  prepareGatewayEnvTarget(dir, homeDir);
  const openclawPath = join(dir, "openclaw.json");
  const envPath = join(dir, ".env");
  const stateDir = join(dir, ".oc-switch");
  writeFileSync(openclawPath, `${JSON.stringify(sample, null, 2)}\n`);
  const customDir = join(stateDir, "presets", "custom");
  mkdirSync(customDir, { recursive: true });
  process.env.HOME = homeDir;
  return {
    dir,
    homeDir,
    paths: { openclawPath, envPath, stateDir },
    presetDirs: {
      builtinDir: fixtureBuiltinDir,
      customDir
    }
  };
}

function createTestApp(
  ws: Workspace,
  fetchImpl?: FetchImpl,
  extra?: {
    runtimeDiscoveryProvider?: RuntimeDiscoveryProvider;
    gatewayRouteOptions?: import("../src/routes/gateway").GatewayRouteOptions;
  }
) {
  return createApp({
    token: TOKEN,
    paths: ws.paths,
    presetDirs: ws.presetDirs,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(extra?.runtimeDiscoveryProvider
      ? { runtimeDiscoveryProvider: extra.runtimeDiscoveryProvider }
      : {}),
    ...(extra?.gatewayRouteOptions ? { gatewayRouteOptions: extra.gatewayRouteOptions } : {})
  });
}

async function jsonRequest(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
  const response = await app.request(path, {
    ...init,
    headers: {
      ...authHeaders(),
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
  return {
    response,
    json: await response.json() as Record<string, unknown>
  };
}

function customProviderBody() {
  return {
    providerId: "custom-openai",
    displayName: "Custom OpenAI",
    notes: "Company account",
    websiteUrl: "https://custom.example",
    api: "openai-completions",
    baseUrl: "https://api.custom.example",
    isFullUrl: false,
    apiKeyEnv: "CUSTOM_OPENAI_API_KEY",
    models: [
      { id: "model-a", alias: "a" },
      { id: "vendor/model-b", alias: "b" }
    ],
    enableAllModels: true
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("server app auth", () => {
  test("health endpoint works without secrets", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/status");

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.primaryModel).toBe("minimax-portal/MiniMax-M3");
    expect(JSON.stringify(json)).not.toContain("sk-");
  });

  test("rejects missing token", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const response = await app.request("/api/status");
    expect(response.status).toBe(401);
  });
});

describe("server read endpoints", () => {
  test("GET /api/providers lists providers", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/providers");

    expect(response.status).toBe(200);
    const providers = json.providers as Array<{ id: string }>;
    expect(providers.map((p) => p.id).sort()).toEqual(["DeepSeek", "minimax-portal", "nvidia"]);
    expect(JSON.stringify(json)).not.toContain("sk-");
  });

  test("GET /api/providers includes apiKey env status", async () => {
    const ws = workspace();
    writeFileSync(ws.paths.envPath, "NVIDIA_API_KEY=outside\n");
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/providers");

    expect(response.status).toBe(200);
    const nvidia = (json.providers as Array<{ id: string }>).find((item) => item.id === "nvidia");
    expect(nvidia).toMatchObject({
      apiKeyEnv: "NVIDIA_API_KEY",
      apiKeyEnvManaged: false,
      apiKeyEnvStatus: "unmanaged"
    });
  });

  test("GET /api/models lists allowlist models", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/models");

    expect(response.status).toBe(200);
    const models = json.models as Array<{ ref: string; isPrimary: boolean }>;
    expect(models.some((m) => m.ref === "nvidia/deepseek-ai/deepseek-v4-flash")).toBe(true);
    expect(models.find((m) => m.isPrimary)?.ref).toBe("minimax-portal/MiniMax-M3");
  });

  test("GET /api/presets lists builtin presets", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/presets");

    expect(response.status).toBe(200);
    const presets = json.presets as Array<{ id: string }>;
    expect(presets.some((p) => p.id === "openai-compatible")).toBe(true);
    expect(JSON.stringify(json)).not.toContain("sk-");
  });

  test("GET /api/backups is empty before writes", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/backups");

    expect(response.status).toBe(200);
    expect(json.backups).toEqual([]);
  });
});

describe("server write endpoints", () => {
  test("PUT /api/models/primary sets primary via body ref", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/models/primary", {
      method: "PUT",
      body: JSON.stringify({ ref: "nvidia/deepseek-ai/deepseek-v4-flash" })
    });

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.backupId).toBeTruthy();

    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.agents.defaults.model).toBe("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(existsSync(join(ws.paths.stateDir, "backups", String(json.backupId)))).toBe(true);
  });

  test("PATCH /api/models disables allowlist entry", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response } = await jsonRequest(app, "/api/models", {
      method: "PATCH",
      body: JSON.stringify({ ref: "nvidia/deepseek-ai/deepseek-v4-flash", enabled: false })
    });

    expect(response.status).toBe(200);
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.agents.defaults.models["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeUndefined();
  });

  test("POST /api/models adds provider model with structured fields", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/models", {
      method: "POST",
      body: JSON.stringify({
        providerId: "nvidia",
        model: {
          id: "deepseek-ai/deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          alias: "ds-pro",
          enabled: true,
          api: "openai-completions",
          contextWindow: 128000,
          maxTokens: 8192,
          input: ["text"]
        }
      })
    });

    expect(response.status).toBe(200);
    expect(json.backupId).toBeTruthy();
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers.nvidia.models.find((model: { id: string }) => model.id === "deepseek-ai/deepseek-v4-pro")).toMatchObject({
      name: "DeepSeek V4 Pro",
      api: "openai-completions",
      reasoning: true,
      contextWindow: 128000,
      maxTokens: 8192,
      input: ["text"]
    });
    expect(config.models.providers.nvidia.models.find(
      (model: { id: string }) => model.id === "deepseek-ai/deepseek-v4-pro"
    ).reasoning).toBe(true);
    expect(config.agents.defaults.models["nvidia/deepseek-ai/deepseek-v4-pro"]).toEqual({ alias: "ds-pro" });
  });

  test("PUT /api/models edits model and migrates slash-containing ref", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response } = await jsonRequest(app, "/api/models", {
      method: "PUT",
      body: JSON.stringify({
        ref: "nvidia/deepseek-ai/deepseek-v4-flash",
        model: {
          id: "deepseek-ai/deepseek-v4-pro",
          name: "DeepSeek V4 Pro",
          alias: "ds-pro",
          enabled: true,
          contextWindow: 128000
        }
      })
    });

    expect(response.status).toBe(200);
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers.nvidia.models.some((model: { id: string }) => model.id === "deepseek-ai/deepseek-v4-flash")).toBe(false);
    expect(config.models.providers.nvidia.models.some((model: { id: string }) => model.id === "deepseek-ai/deepseek-v4-pro")).toBe(true);
    expect(config.agents.defaults.models["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeUndefined();
    expect(config.agents.defaults.models["nvidia/deepseek-ai/deepseek-v4-pro"]).toMatchObject({
      alias: "ds-pro",
      agentRuntime: { id: "codex" }
    });
  });

  test("POST/PUT /api/models round-trip contextTokens into provider models, not allowlist", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response } = await jsonRequest(app, "/api/models", {
      method: "POST",
      body: JSON.stringify({
        providerId: "nvidia",
        model: {
          id: "vendor/budget-model",
          name: "Budget Model",
          alias: "budget",
          enabled: true,
          contextWindow: 200000,
          contextTokens: 128000,
          maxTokens: 16384
        }
      })
    });

    expect(response.status).toBe(200);
    let config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    const written = config.models.providers.nvidia.models.find((model: { id: string }) => model.id === "vendor/budget-model");
    expect(written).toMatchObject({ contextWindow: 200000, contextTokens: 128000, maxTokens: 16384 });
    // contextTokens 只落在 provider.models[]，不进入 allowlist entry
    expect(config.agents.defaults.models["nvidia/vendor/budget-model"]).toEqual({ alias: "budget" });

    // PUT 修改 contextTokens
    const putResponse = await jsonRequest(app, "/api/models", {
      method: "PUT",
      body: JSON.stringify({
        ref: "nvidia/vendor/budget-model",
        model: { id: "vendor/budget-model", enabled: true, contextTokens: 96000 }
      })
    });
    expect(putResponse.response.status).toBe(200);
    config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers.nvidia.models.find((model: { id: string }) => model.id === "vendor/budget-model").contextTokens).toBe(96000);
  });

  test("POST /api/models rejects contextTokens greater than contextWindow", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/models", {
      method: "POST",
      body: JSON.stringify({
        providerId: "nvidia",
        model: {
          id: "vendor/over-budget",
          enabled: false,
          contextWindow: 100000,
          contextTokens: 200000
        }
      })
    });
    expect(response.status).toBe(400);
    expect(String(json.error)).toMatch(/contextTokens|contextWindow/);
  });

  test("DELETE /api/models removes model through JSON body", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response } = await jsonRequest(app, "/api/models", {
      method: "DELETE",
      body: JSON.stringify({ ref: "nvidia/deepseek-ai/deepseek-v4-flash" })
    });

    expect(response.status).toBe(200);
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers.nvidia.models.map((model: { id: string }) => model.id)).not.toContain("deepseek-ai/deepseek-v4-flash");
    expect(config.agents.defaults.models["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeUndefined();
  });

  test("POST /api/providers adds provider from preset without leaking key", async () => {
    const ws = workspace();
    writeFileSync(join(ws.presetDirs.customDir, "testprov.json"), JSON.stringify({
      id: "testprov",
      name: "Test Provider",
      provider: { api: "openai-completions", baseUrl: "https://test.example/v1", apiKeyEnv: "TESTPROV_API_KEY" },
      models: [{ id: "vendor/model", alias: "vm" }]
    }));
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/providers", {
      method: "POST",
      body: JSON.stringify({
        presetId: "testprov",
        apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456",
        models: ["vendor/model"]
      })
    });

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      envWrite: {
        verified: true,
        entries: [
          {
            envVar: "TESTPROV_API_KEY",
            verified: true,
            managed: true,
            maskedValue: "sk-abc********123456"
          }
        ]
      }
    });
    expect(JSON.stringify(json)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers.testprov.baseUrl).toBe("https://test.example/v1");
    expect(config.agents.defaults.models["testprov/vendor/model"]).toEqual({ alias: "vm" });
    const manifest = JSON.parse(readFileSync(join(ws.paths.stateDir, "manifest.json"), "utf8"));
    expect(manifest.providers.testprov).toMatchObject({
      providerId: "testprov",
      envVar: "TESTPROV_API_KEY",
      orphan: false
    });
  });

  test("POST /api/providers/preview returns diff for the pending preset add without writing", async () => {
    const ws = workspace();
    writeFileSync(join(ws.presetDirs.customDir, "previewprov.json"), JSON.stringify({
      id: "previewprov",
      name: "Preview Provider",
      provider: { api: "openai-completions", baseUrl: "https://preview.example/v1", apiKeyEnv: "PREVIEW_API_KEY" },
      models: [{ id: "vendor/model", alias: "vm" }]
    }));
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/providers/preview", {
      method: "POST",
      body: JSON.stringify({ presetId: "previewprov", models: ["vendor/model"] })
    });

    expect(response.status).toBe(200);
    expect(json.providersAdded).toEqual(["previewprov"]);
    expect(json.modelsEnabled).toEqual(["previewprov/vendor/model"]);
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers.previewprov).toBeUndefined();
  });

  test("POST /api/providers/custom/preview returns diff without writing", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/providers/custom/preview", {
      method: "POST",
      body: JSON.stringify(customProviderBody())
    });

    expect(response.status).toBe(200);
    expect(json.providersAdded).toEqual(["custom-openai"]);
    expect(json.modelsEnabled).toEqual(["custom-openai/model-a", "custom-openai/vendor/model-b"]);
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers["custom-openai"]).toBeUndefined();
  });

  test("POST /api/providers/custom writes provider env and manifest without leaking key", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const body = { ...customProviderBody(), apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456" };
    const { response, json } = await jsonRequest(app, "/api/providers/custom", {
      method: "POST",
      body: JSON.stringify(body)
    });

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      envWrite: {
        verified: true,
        entries: [
          {
            envVar: "CUSTOM_OPENAI_API_KEY",
            verified: true,
            managed: true,
            maskedValue: "sk-abc********123456"
          }
        ]
      }
    });
    expect(JSON.stringify(json)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers["custom-openai"]).toMatchObject({
      baseUrl: "https://api.custom.example/v1",
      api: "openai-completions",
      apiKey: "${CUSTOM_OPENAI_API_KEY}"
    });
    expect(config.agents.defaults.models["custom-openai/vendor/model-b"]).toEqual({ alias: "b" });
    expect(readFileSync(ws.paths.envPath, "utf8")).toContain("CUSTOM_OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456");
    const manifest = JSON.parse(readFileSync(join(ws.paths.stateDir, "manifest.json"), "utf8"));
    expect(manifest.providers["custom-openai"]).toMatchObject({
      providerId: "custom-openai",
      envVar: "CUSTOM_OPENAI_API_KEY",
      displayName: "Custom OpenAI",
      notes: "Company account",
      websiteUrl: "https://custom.example",
      isFullUrl: false,
      orphan: false
    });
  });

  test("POST /api/providers/custom 透传 runtimeDiscoveryProvider 并自动 sync service env", async () => {
    const ws = workspace();
    const gatewayPath = expectedGatewayEnvPath(ws.dir);
    writeFileSync(gatewayPath, "HTTP_PROXY=http://proxy\n");
    let discoverCalls = 0;
    const serviceManager = process.platform === "darwin" ? "launchd" as const : "systemd" as const;
    const app = createTestApp(ws, undefined, {
      runtimeDiscoveryProvider: () => {
        discoverCalls += 1;
        return {
          status: "resolved",
          instances: [],
          candidateGroups: [
            {
              candidateId: "test:provider-write:sync",
              instanceId: "test:provider-write",
              stateDir: ws.dir,
              openclawPath: ws.paths.openclawPath,
              envPath: ws.paths.envPath,
              serviceEnvPath: gatewayPath,
              serviceManager,
              serviceId: serviceManager === "launchd" ? "ai.openclaw.gateway" : "openclaw-gateway.service",
              pid: 42,
              confidence: "strong",
              evidence: ["systemd-unit"]
            }
          ],
          diagnostics: []
        };
      }
    });

    const { response, json } = await jsonRequest(app, "/api/providers/custom", {
      method: "POST",
      body: JSON.stringify({ ...customProviderBody(), apiKey: "sk-provider-sync-secret-key-001" })
    });

    expect(response.status).toBe(200);
    expect(discoverCalls).toBeGreaterThanOrEqual(2);
    expect(json.gatewayEnvSync).toMatchObject({
      ok: true,
      syncedKeys: ["CUSTOM_OPENAI_API_KEY"]
    });
    expect(readFileSync(gatewayPath, "utf8")).toContain("CUSTOM_OPENAI_API_KEY");
    expect(JSON.stringify(json)).not.toContain("sk-provider-sync-secret-key-001");
  });

  test("POST /api/providers/custom rejects invalid provider id", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/providers/custom", {
      method: "POST",
      body: JSON.stringify({ ...customProviderBody(), providerId: "bad/id", apiKey: "sk-test-custom-secret" })
    });

    expect(response.status).toBe(400);
    expect(String(json.error)).toContain("Provider ID must not contain /");
  });

  test("PUT /api/providers/:id updates baseUrl and api", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response } = await jsonRequest(app, "/api/providers/nvidia", {
      method: "PUT",
      body: JSON.stringify({
        baseUrl: "https://new-nvidia.example/v1",
        api: "anthropic-messages"
      })
    });

    expect(response.status).toBe(200);
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers.nvidia.baseUrl).toBe("https://new-nvidia.example/v1");
    expect(config.models.providers.nvidia.api).toBe("anthropic-messages");
  });

  test("PUT /api/providers/:id rejects unsupported api", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/providers/nvidia", {
      method: "PUT",
      body: JSON.stringify({ api: "unsupported-api" })
    });

    expect(response.status).toBe(400);
    expect(String(json.error)).toContain("api must be a supported API type");
  });

  test("POST /api/providers/preview includes envPreview for preset key", async () => {
    const ws = workspace();
    writeFileSync(ws.paths.envPath, "TESTPROV_API_KEY=old-secret\n");
    writeFileSync(join(ws.presetDirs.customDir, "testprov.json"), JSON.stringify({
      id: "testprov",
      name: "Test Provider",
      provider: { api: "openai-completions", baseUrl: "https://test.example/v1", apiKeyEnv: "TESTPROV_API_KEY" },
      models: [{ id: "vendor/model" }]
    }));
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/providers/preview", {
      method: "POST",
      body: JSON.stringify({ presetId: "testprov" })
    });

    expect(response.status).toBe(200);
  expect(json.envPreview).toMatchObject({
    affectedKeys: ["TESTPROV_API_KEY"],
    requiresConfirmation: true,
    requiresMigration: true,
    requiresComplex: false
  });
    expect(JSON.stringify(json)).not.toContain("old-secret");
  });

  test("PUT /api/providers/:id migrates unmanaged key only when confirmed", async () => {
    const ws = workspace();
    writeFileSync(ws.paths.envPath, "NVIDIA_API_KEY=old-secret\n");
    const app = createTestApp(ws);

    const rejected = await jsonRequest(app, "/api/providers/nvidia", {
      method: "PUT",
      body: JSON.stringify({ apiKey: "new-secret" })
    });
    expect(rejected.response.status).toBe(400);

    const accepted = await jsonRequest(app, "/api/providers/nvidia", {
      method: "PUT",
      body: JSON.stringify({ apiKey: "new-secret", confirmMigration: true })
    });
    expect(accepted.response.status).toBe(200);
    expect(readFileSync(ws.paths.envPath, "utf8")).toContain("NVIDIA_API_KEY=new-secret");
  });

  test("PUT /api/providers/:id updates env key for ${VAR} apiKey format", async () => {
    const ws = workspace();
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    config.models.providers.nvidia.apiKey = "${NVIDIA_API_KEY}";
    writeFileSync(ws.paths.openclawPath, `${JSON.stringify(config, null, 2)}\n`);
    writeFileSync(ws.paths.envPath, "# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/providers/nvidia", {
      method: "PUT",
      body: JSON.stringify({ apiKey: "sk-abcdefghijklmnopqrstuvwxyz123456" })
    });

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      envWrite: {
        verified: true,
        entries: [
          {
            envVar: "NVIDIA_API_KEY",
            verified: true,
            managed: true,
            maskedValue: "sk-abc********123456"
          }
        ]
      }
    });
    expect(JSON.stringify(json)).not.toContain("sk-abcdefghijklmnopqrstuvwxyz123456");
    expect(readFileSync(ws.paths.envPath, "utf8")).toContain("NVIDIA_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456");
  });

  test("DELETE /api/providers/:id removes provider with newPrimary in body", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response } = await jsonRequest(app, "/api/providers/minimax-portal", {
      method: "DELETE",
      body: JSON.stringify({ newPrimary: "nvidia/deepseek-ai/deepseek-v4-flash" })
    });

    expect(response.status).toBe(200);
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers["minimax-portal"]).toBeUndefined();
    expect(config.agents.defaults.model).toBe("nvidia/deepseek-ai/deepseek-v4-flash");
  });

  test("DELETE /api/providers/:id marks provider env key orphan in manifest", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response } = await jsonRequest(app, "/api/providers/DeepSeek", {
      method: "DELETE"
    });

    expect(response.status).toBe(200);
    const manifest = JSON.parse(readFileSync(join(ws.paths.stateDir, "manifest.json"), "utf8"));
    expect(manifest.providers.deepseek).toMatchObject({
      providerId: "deepseek",
      envVar: "DEEPSEEK_API_KEY",
      orphan: true
    });
  });

  test("POST /api/providers/:id/sync discovers remote models without writing config", async () => {
    const ws = workspace();
    const mockFetch: FetchImpl = async () =>
      new Response(JSON.stringify({ data: [{ id: "remote-model-a" }, { id: "remote-model-b" }] }), {
        headers: { "content-type": "application/json" }
      });
    const app = createTestApp(ws, mockFetch);
    const beforeConfig = readFileSync(ws.paths.openclawPath, "utf8");
    const { response, json } = await jsonRequest(app, "/api/providers/nvidia/sync", { method: "POST" });

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect((json.remoteModels as Array<{ id: string }>).map((m) => m.id)).toEqual([
      "remote-model-a",
      "remote-model-b"
    ]);
    expect(json.alreadyAddedIds).toEqual([]);
    expect(json.truncated).toBe(false);
    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(beforeConfig);

    const { json: backupsJson } = await jsonRequest(app, "/api/backups");
    expect((backupsJson.backups as unknown[]).length).toBe(0);
  });

  test("POST /api/providers/:id/discover matches sync alias and does not write config", async () => {
    const ws = workspace();
    const mockFetch: FetchImpl = async () =>
      new Response(JSON.stringify({ data: [{ id: "remote-model-a", name: "Remote A" }] }), {
        headers: { "content-type": "application/json" }
      });
    const app = createTestApp(ws, mockFetch);
    const beforeConfig = readFileSync(ws.paths.openclawPath, "utf8");
    const { response, json } = await jsonRequest(app, "/api/providers/nvidia/discover", { method: "POST" });

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      ok: true,
      providerId: "nvidia",
      truncated: false
    });
    expect(json.remoteModels).toEqual([{ id: "remote-model-a", name: "Remote A" }]);
    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(beforeConfig);

    const { json: backupsJson } = await jsonRequest(app, "/api/backups");
    expect((backupsJson.backups as unknown[]).length).toBe(0);
  });

  test("POST /api/providers/discover-preview discovers with form credentials without writes", async () => {
    const ws = workspace();
    const calls: Array<{ url: string; headers: Headers }> = [];
    const app = createTestApp(ws, async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(
        JSON.stringify({
          data: [{ id: "remote-preview-a", name: "Remote Preview A" }, { id: "remote-preview-b" }]
        }),
        { headers: { "content-type": "application/json" } }
      );
    });
    const beforeConfig = readFileSync(ws.paths.openclawPath, "utf8");
    const beforeEnv = existsSync(ws.paths.envPath) ? readFileSync(ws.paths.envPath, "utf8") : "";
    const { response, json } = await jsonRequest(app, "/api/providers/discover-preview", {
      method: "POST",
      body: JSON.stringify({
        api: "openai-completions",
        baseUrl: "https://preview.example.com",
        apiKey: "preview-secret",
        alreadyAddedIds: ["remote-preview-b", "remote-preview-c"]
      })
    });
    expect(response.status).toBe(200);
    expect(calls[0]?.url).toBe("https://preview.example.com/v1/models");
    expect(calls[0]?.headers.get("authorization")).toBe("Bearer preview-secret");
    expect(json).toMatchObject({
      ok: true,
      remoteModels: [{ id: "remote-preview-a", name: "Remote Preview A" }, { id: "remote-preview-b" }],
      alreadyAddedIds: ["remote-preview-b"],
      truncated: false
    });
    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(beforeConfig);
    const afterEnv = existsSync(ws.paths.envPath) ? readFileSync(ws.paths.envPath, "utf8") : "";
    expect(afterEnv).toBe(beforeEnv);
    const { json: backupsJson } = await jsonRequest(app, "/api/backups");
    expect((backupsJson.backups as unknown[]).length).toBe(0);
  });

  test("POST /api/providers/discover-preview respects isFullUrl baseUrl semantics", async () => {
    const ws = workspace();
    const calls: string[] = [];
    const app = createTestApp(ws, async (input) => {
      calls.push(String(input));
      return new Response(
        JSON.stringify({
          data: [{ id: "remote-preview-a" }]
        }),
        { headers: { "content-type": "application/json" } }
      );
    });

    const { response } = await jsonRequest(app, "/api/providers/discover-preview", {
      method: "POST",
      body: JSON.stringify({
        api: "openai-completions",
        baseUrl: "https://preview.example.com/custom-prefix",
        apiKey: "preview-secret",
        isFullUrl: true
      })
    });

    expect(response.status).toBe(200);
    expect(calls[0]).toBe("https://preview.example.com/custom-prefix/models");
  });

  test("POST /api/providers/discover-preview rejects missing apiKey", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/providers/discover-preview", {
      method: "POST",
      body: JSON.stringify({
        api: "openai-completions",
        baseUrl: "https://preview.example.com",
        apiKey: ""
      })
    });
    expect(response.status).toBe(400);
    expect(String(json.error)).toContain("apiKey must be a non-empty string");
  });

  test("POST /api/providers/:id/models/batch-add adds models with name and optional allowlist", async () => {
    const ws = workspace();
    const app = createTestApp(ws);

    const withoutEnable = await jsonRequest(app, "/api/providers/nvidia/models/batch-add", {
      method: "POST",
      body: JSON.stringify({
        models: [{ id: "vendor/new-model", name: "New Model" }]
      })
    });
    expect(withoutEnable.response.status).toBe(200);
    expect(withoutEnable.json).toMatchObject({
      ok: true,
      addedModelIds: ["vendor/new-model"],
      skippedModelIds: [],
      enabled: false
    });
    expect(withoutEnable.json.backupId).toBeTruthy();

    let config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers.nvidia.models.find((model: { id: string }) => model.id === "vendor/new-model")).toMatchObject({
      id: "vendor/new-model",
      name: "New Model"
    });
    expect(config.agents.defaults.models["nvidia/vendor/new-model"]).toBeUndefined();

    const withEnable = await jsonRequest(app, "/api/providers/nvidia/models/batch-add", {
      method: "POST",
      body: JSON.stringify({
        models: [{ id: "vendor/enabled-model", name: "Enabled Model" }],
        enable: true
      })
    });
    expect(withEnable.response.status).toBe(200);
    expect(withEnable.json).toMatchObject({
      ok: true,
      addedModelIds: ["vendor/enabled-model"],
      enabled: true
    });

    config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.agents.defaults.models["nvidia/vendor/enabled-model"]).toEqual({});
  });

  test("POST /api/providers/:id/models/batch-add rejects disabled provider even when enable is false", async () => {
    const ws = workspace();
    upsertDisabledProviderState(ws.paths.stateDir, {
      providerId: "nvidia",
      openclawPath: ws.paths.openclawPath,
      disabledAt: "2026-06-25T12:00:00.000Z",
      allowlistEntries: {}
    });
    const app = createTestApp(ws);

    const { response, json } = await jsonRequest(app, "/api/providers/nvidia/models/batch-add", {
      method: "POST",
      body: JSON.stringify({
        models: [{ id: "vendor/blocked-model" }],
        enable: false
      })
    });

    expect(response.status).toBe(400);
    expect(String(json.error)).toContain("Provider nvidia is disabled");
  });

  test("POST /api/providers/:id/models/batch-remove by modelIds and keepEnabledOnly", async () => {
    const ws = workspace();
    const app = createTestApp(ws);

    const added = await jsonRequest(app, "/api/providers/nvidia/models/batch-add", {
      method: "POST",
      body: JSON.stringify({
        models: [
          { id: "vendor/removable-a" },
          { id: "vendor/removable-b", name: "Removable B" }
        ],
        enable: true
      })
    });
    expect(added.response.status).toBe(200);

    const removed = await jsonRequest(app, "/api/providers/nvidia/models/batch-remove", {
      method: "POST",
      body: JSON.stringify({ modelIds: ["vendor/removable-a"] })
    });
    expect(removed.response.status).toBe(200);
    expect(removed.json).toMatchObject({
      ok: true,
      removedModelIds: ["vendor/removable-a"]
    });
    expect(removed.json.backupId).toBeTruthy();

    let config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers.nvidia.models.map((model: { id: string }) => model.id)).not.toContain("vendor/removable-a");
    expect(config.agents.defaults.models["nvidia/vendor/removable-a"]).toBeUndefined();
    expect(config.models.providers.nvidia.models.map((model: { id: string }) => model.id)).toContain("vendor/removable-b");

    await jsonRequest(app, "/api/providers/nvidia/models/batch-add", {
      method: "POST",
      body: JSON.stringify({
        models: [{ id: "vendor/unlisted-catalog" }]
      })
    });

    const keepEnabled = await jsonRequest(app, "/api/providers/nvidia/models/batch-remove", {
      method: "POST",
      body: JSON.stringify({ keepEnabledOnly: true })
    });
    expect(keepEnabled.response.status).toBe(200);
    expect(keepEnabled.json.removedModelIds).toEqual(["vendor/unlisted-catalog"]);

    config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers.nvidia.models.map((model: { id: string }) => model.id).sort()).toEqual(
      ["deepseek-ai/deepseek-v4-flash", "vendor/removable-b", "z-ai/glm5.1"].sort()
    );
    expect(config.agents.defaults.models["nvidia/vendor/removable-b"]).toEqual({});
    expect(config.agents.defaults.models["nvidia/vendor/unlisted-catalog"]).toBeUndefined();
  });

  test("POST /api/providers/:id/models/batch-add rejects capacity over limit", async () => {
    const ws = workspace();
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    config.models.providers.nvidia.models = Array.from({ length: MAX_PROVIDER_MODELS }, (_, index) => ({
      id: `catalog-model-${index}`,
      name: `Catalog ${index}`
    }));
    writeFileSync(ws.paths.openclawPath, `${JSON.stringify(config, null, 2)}\n`);
    const app = createTestApp(ws);

    const { response, json } = await jsonRequest(app, "/api/providers/nvidia/models/batch-add", {
      method: "POST",
      body: JSON.stringify({
        models: [{ id: "vendor/over-cap" }]
      })
    });

    expect(response.status).toBe(400);
    expect(String(json.error)).toMatch(/limit|capacity/i);

    const after = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(after.models.providers.nvidia.models).toHaveLength(MAX_PROVIDER_MODELS);
    expect(after.models.providers.nvidia.models.some((model: { id: string }) => model.id === "vendor/over-cap")).toBe(false);
  });

  test("POST /api/presets/import exports all providers", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/presets/import", { method: "POST" });

    expect(response.status).toBe(200);
    expect((json.imported as string[]).sort()).toEqual(["DeepSeek", "minimax-portal", "nvidia"]);
    expect(existsSync(join(ws.presetDirs.customDir, "nvidia.json"))).toBe(true);
    expect(JSON.stringify(json)).not.toContain("sk-");
  });

  test("POST /api/presets/export/:id writes custom preset", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/presets/export/nvidia", { method: "POST" });

    expect(response.status).toBe(200);
    expect(json.id).toBe("nvidia");
    expect(existsSync(String(json.path))).toBe(true);
    expect(JSON.stringify(json)).not.toContain("sk-");
  });

  test("POST /api/backups/:id/restore rolls back config", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    await jsonRequest(app, "/api/models/primary", {
      method: "PUT",
      body: JSON.stringify({ ref: "nvidia/deepseek-ai/deepseek-v4-flash" })
    });
    const { json: backupsJson } = await jsonRequest(app, "/api/backups");
    const backupId = (backupsJson.backups as Array<{ id: string }>)[0]?.id;
    expect(backupId).toBeTruthy();

    const { response } = await jsonRequest(app, `/api/backups/${backupId}/restore`, { method: "POST" });
    expect(response.status).toBe(200);

    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.agents.defaults.model).toBe("minimax-portal/MiniMax-M3");
    const { json: afterRestoreBackups } = await jsonRequest(app, "/api/backups");
    const safetyBackup = (afterRestoreBackups.backups as Array<{ reason: string }>).find((backup) =>
      backup.reason.includes(`before restore ${backupId}`)
    );
    expect(safetyBackup).toBeTruthy();
  });

  test("POST /api/backups/:id/restore syncs restored env block to gateway.systemd.env", async () => {
    const ws = workspace();
    const gatewayPath = expectedGatewayEnvPath(ws.dir);
    const runtimeDiscoveryProvider: RuntimeDiscoveryProvider = () => ({
      status: "resolved",
      instances: [],
      candidateGroups: [
        {
          candidateId: "systemd:gw:restore-api",
          instanceId: "systemd:gw",
          stateDir: ws.dir,
          openclawPath: ws.paths.openclawPath,
          envPath: ws.paths.envPath,
          serviceEnvPath: gatewayPath,
          serviceManager: "systemd",
          pid: 1,
          evidence: ["systemd-unit"]
        }
      ],
      diagnostics: []
    });
    const app = createTestApp(ws, undefined, { runtimeDiscoveryProvider });
    writeFileSync(ws.paths.envPath, "# oc-switch:start\nRESTORED_KEY=restored-secret\n# oc-switch:end\n");
    const backupDir = createBackup({
      ...ws.paths,
      reason: "restore gateway env",
      beforeHash: "hash"
    });
    const backupId = backupDir.split("/").pop();
    writeFileSync(ws.paths.envPath, "# oc-switch:start\nCURRENT_KEY=current-secret\n# oc-switch:end\n");
    writeFileSync(gatewayPath, [
      "HTTP_PROXY=http://proxy",
      "# oc-switch:start",
      "CURRENT_KEY=current-secret",
      "# oc-switch:end"
    ].join("\n") + "\n");

    const { response, json } = await jsonRequest(app, `/api/backups/${backupId}/restore`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(json.gatewayRestartRequired).toBe(true);
    expect(json.gatewayEnvSync).toMatchObject({
      ok: true,
      syncedKeys: ["RESTORED_KEY"],
      removedKeys: ["CURRENT_KEY"]
    });
    expect(readFileSync(gatewayPath, "utf8")).toContain("RESTORED_KEY");
    expect(readFileSync(gatewayPath, "utf8")).toContain("restored-secret");
    expect(readFileSync(gatewayPath, "utf8")).not.toContain("CURRENT_KEY=current-secret");
    expect(JSON.stringify(json)).not.toContain("restored-secret");
  });

  test("POST /api/backups/:id/restore skips gatewayRestartRequired when sync cannot associate", async () => {
    const ws = workspace();
    const app = createTestApp(ws, undefined, {
      runtimeDiscoveryProvider: () => ({
        status: "gateway-not-detected",
        instances: [],
        candidateGroups: [],
        diagnostics: []
      })
    });
    writeFileSync(ws.paths.envPath, "# oc-switch:start\nRESTORED_KEY=restored-secret\n# oc-switch:end\n");
    const backupDir = createBackup({
      ...ws.paths,
      reason: "restore without association",
      beforeHash: "hash"
    });
    const backupId = backupDir.split("/").pop();
    writeFileSync(ws.paths.envPath, "# oc-switch:start\nCURRENT_KEY=current-secret\n# oc-switch:end\n");

    const { response, json } = await jsonRequest(app, `/api/backups/${backupId}/restore`, { method: "POST" });

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.gatewayEnvSync).toMatchObject({ ok: false });
    expect(json.gatewayRestartRequired).not.toBe(true);
  });

  test("GET /api/backups includes path metadata and active path match", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    await jsonRequest(app, "/api/models/primary", {
      method: "PUT",
      body: JSON.stringify({ ref: "nvidia/deepseek-ai/deepseek-v4-flash" })
    });

    const { response, json } = await jsonRequest(app, "/api/backups");
    expect(response.status).toBe(200);
    const [backup] = json.backups as Array<{
      openclawPath: string;
      envPath: string;
      pathMatchesActive: boolean;
    }>;
    expect(backup).toMatchObject({
      openclawPath: ws.paths.openclawPath,
      envPath: ws.paths.envPath,
      pathMatchesActive: true
    });
    expect(JSON.stringify(json)).not.toContain("sk-");
  });

  test("POST /api/backups/:id/restore can restore a mismatched backup into current active paths when confirmed", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    await jsonRequest(app, "/api/models/primary", {
      method: "PUT",
      body: JSON.stringify({ ref: "nvidia/deepseek-ai/deepseek-v4-flash" })
    });
    const { json: backupsJson } = await jsonRequest(app, "/api/backups");
    const backupId = (backupsJson.backups as Array<{ id: string }>)[0]?.id;
    expect(backupId).toBeTruthy();

    const nextDir = mkdtempSync(join(tmpdir(), "oc-switch-server-restore-current-"));
    tempDirs.push(nextDir);
    const nextOpenclawPath = join(nextDir, "openclaw.json");
    const nextEnvPath = join(nextDir, ".env");
    writeFileSync(nextOpenclawPath, JSON.stringify({
      models: { providers: { switched: { models: [{ id: "model-a" }] } } },
      agents: { defaults: { model: "switched/model-a", models: { "switched/model-a": {} } } }
    }, null, 2));
    writeFileSync(nextEnvPath, "SWITCHED_API_KEY=value\n");
    await jsonRequest(app, "/api/settings/paths", {
      method: "PUT",
      body: JSON.stringify({ openclawPath: nextOpenclawPath, envPath: nextEnvPath })
    });

    const rejected = await jsonRequest(app, `/api/backups/${backupId}/restore`, { method: "POST" });
    expect(rejected.response.status).toBe(409);
    expect(rejected.json).toMatchObject({
      error: "backup path mismatch",
      mismatch: {
        backupOpenclawPath: ws.paths.openclawPath,
        backupEnvPath: ws.paths.envPath,
        currentOpenclawPath: nextOpenclawPath,
        currentEnvPath: nextEnvPath
      }
    });

    const restored = await jsonRequest(app, `/api/backups/${backupId}/restore`, {
      method: "POST",
      body: JSON.stringify({ target: "current" })
    });
    expect(restored.response.status).toBe(200);
    const config = JSON.parse(readFileSync(nextOpenclawPath, "utf8"));
    expect(config.agents.defaults.model).toBe("minimax-portal/MiniMax-M3");
  });

  test("POST /api/backups/:id/restore can restore a mismatched backup to its original paths when confirmed", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    await jsonRequest(app, "/api/models/primary", {
      method: "PUT",
      body: JSON.stringify({ ref: "nvidia/deepseek-ai/deepseek-v4-flash" })
    });
    const { json: backupsJson } = await jsonRequest(app, "/api/backups");
    const backupId = (backupsJson.backups as Array<{ id: string }>)[0]?.id;
    expect(backupId).toBeTruthy();

    const nextDir = mkdtempSync(join(tmpdir(), "oc-switch-server-restore-backup-"));
    tempDirs.push(nextDir);
    const nextOpenclawPath = join(nextDir, "openclaw.json");
    const nextEnvPath = join(nextDir, ".env");
    writeFileSync(nextOpenclawPath, JSON.stringify({
      models: { providers: { switched: { models: [{ id: "model-a" }] } } },
      agents: { defaults: { model: "switched/model-a", models: { "switched/model-a": {} } } }
    }, null, 2));
    writeFileSync(nextEnvPath, "SWITCHED_API_KEY=value\n");
    await jsonRequest(app, "/api/settings/paths", {
      method: "PUT",
      body: JSON.stringify({ openclawPath: nextOpenclawPath, envPath: nextEnvPath })
    });
    writeFileSync(ws.paths.openclawPath, JSON.stringify({
      models: { providers: {} },
      agents: { defaults: { model: "changed/original", models: {} } }
    }, null, 2));

    const restored = await jsonRequest(app, `/api/backups/${backupId}/restore`, {
      method: "POST",
      body: JSON.stringify({ target: "backup" })
    });

    expect(restored.response.status).toBe(200);
    const originalConfig = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    const currentConfig = JSON.parse(readFileSync(nextOpenclawPath, "utf8"));
    expect(originalConfig.agents.defaults.model).toBe("minimax-portal/MiniMax-M3");
    expect(currentConfig.agents.defaults.model).toBe("switched/model-a");
  });

  test("GET /api/diff shows changes since latest backup", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    await jsonRequest(app, "/api/models/primary", {
      method: "PUT",
      body: JSON.stringify({ ref: "nvidia/deepseek-ai/deepseek-v4-flash" })
    });

    const { response, json } = await jsonRequest(app, "/api/diff");
    expect(response.status).toBe(200);
    expect(json.primaryChanged).toEqual({
      before: "minimax-portal/MiniMax-M3",
      after: "nvidia/deepseek-ai/deepseek-v4-flash"
    });
    expect(json.credentialsChanged).toEqual([]);
    expect(JSON.stringify(json)).not.toContain("sk-");
  });

  test("GET /api/diff includes credential changes from managed env block", async () => {
    const ws = workspace();
    writeFileSync(ws.paths.envPath, "# oc-switch:start\nNVIDIA_API_KEY=old-secret\n# oc-switch:end\n");
    const app = createTestApp(ws);
    await jsonRequest(app, "/api/models/primary", {
      method: "PUT",
      body: JSON.stringify({ ref: "nvidia/deepseek-ai/deepseek-v4-flash" })
    });
    writeFileSync(ws.paths.envPath, "# oc-switch:start\nNVIDIA_API_KEY=new-secret\n# oc-switch:end\n");

    const { response, json } = await jsonRequest(app, "/api/diff");
    expect(response.status).toBe(200);
    expect(json.credentialsChanged).toEqual([
      { envVar: "NVIDIA_API_KEY", change: "changed", providerId: "nvidia" }
    ]);
    expect(JSON.stringify(json)).not.toContain("secret");
  });

  test("GET /api/health 返回大小写重复组", async () => {
    const ws = workspace();
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    delete config.models.providers.DeepSeek;
    for (const key of Object.keys(config.agents.defaults.models)) {
      if (key.split("/")[0]?.toLowerCase() === "deepseek") delete config.agents.defaults.models[key];
    }
    config.models.providers.deepseek = { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "DEEPSEEK_API_KEY" }, models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] };
    config.models.providers.DeepSeek = { baseUrl: "https://api.deepseek.com/v1/", apiKey: { source: "env", id: "${DEEPSEEK_API_KEY}" }, models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] };
    config.agents.defaults.models["deepseek/deepseek-chat"] = {};
    config.agents.defaults.models["deepseek/deepseek-reasoner"] = {};
    writeFileSync(ws.paths.openclawPath, JSON.stringify(config));
    const app = createTestApp(ws);

    const { response, json } = await jsonRequest(app, "/api/health", { method: "GET" });
    expect(response.status).toBe(200);
    const health = json as { caseDuplicateGroups: Array<{ groupKey: string; mergeable: boolean; canonicalId: string }> };
    const group = health.caseDuplicateGroups.find((g) => g.groupKey === "deepseek");
    expect(group).toBeTruthy();
    expect(group!.mergeable).toBe(true);
    expect(group!.canonicalId).toBe("deepseek");
  });

  test("GET /api/config-status 返回统一配置状态", async () => {
    const ws = workspace();
    const app = createTestApp(ws);

    const disabled = await jsonRequest(app, "/api/providers/nvidia/state", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false })
    });
    expect(disabled.response.status).toBe(200);

    const { response, json } = await jsonRequest(app, "/api/config-status", { method: "GET" });
    expect(response.status).toBe(200);
    const report = json as {
      version: number;
      summary: { disabledProviderCount: number };
      disabledProviders: Array<{ providerId: string }>;
      issues: Array<{ id: string }>;
    };
    expect(report.version).toBe(1);
    expect(report.summary.disabledProviderCount).toBe(1);
    expect(report.disabledProviders[0]?.providerId).toBe("nvidia");
    const issueIds = report.issues.map((issue) => issue.id);
    expect(new Set(issueIds).size).toBe(issueIds.length);
    expect(JSON.stringify(json)).not.toContain("sk-");
  });

  test("POST /api/health/repair migrates legacy apiKey and fills model names", async () => {
    const ws = workspace();
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    config.models.providers.compat = {
      apiKey: { source: "env", id: "COMPAT_API_KEY" },
      models: [{ id: "vendor/model-a" }]
    };
    writeFileSync(ws.paths.openclawPath, `${JSON.stringify(config, null, 2)}\n`);
    const app = createTestApp(ws);

    const unchanged = await jsonRequest(app, "/api/health/repair", { method: "POST" });
    expect(unchanged.response.status).toBe(200);
    expect(unchanged.json.changed).toBe(true);

    const repaired = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(repaired.models.providers.compat.apiKey).toBe("${COMPAT_API_KEY}");
    expect(repaired.models.providers.compat.models[0].name).toBe("Vendor Model A");

    const again = await jsonRequest(app, "/api/health/repair", { method: "POST" });
    expect(again.response.status).toBe(200);
    expect(again.json.changed).toBe(false);
  });

  test("GET /api/config-status 在 openclaw.json 缺失时仍返回 200 与 path blocking issue", async () => {
    const ws = workspace();
    rmSync(ws.paths.openclawPath);
    const app = createTestApp(ws);

    const { response, json } = await jsonRequest(app, "/api/config-status", { method: "GET" });
    expect(response.status).toBe(200);
    const report = json as {
      health: { caseDuplicateGroups: unknown[] };
      issues: Array<{ id: string; severity: string; source: string }>;
    };
    expect(report.health.caseDuplicateGroups).toEqual([]);
    const openclawIssue = report.issues.find((issue) => issue.source === "paths" && issue.id.includes("openclaw"));
    expect(openclawIssue?.severity).toBe("blocking");
  });

  test("GET /api/config-status 在 .env 不可读时仍返回 200 与 path blocking issue", async () => {
    if (process.platform === "win32") return;
    const ws = workspace();
    writeFileSync(ws.paths.envPath, "TEST=1\n");
    chmodSync(ws.paths.envPath, 0o000);
    const app = createTestApp(ws);

    try {
      const { response, json } = await jsonRequest(app, "/api/config-status", { method: "GET" });
      expect(response.status).toBe(200);
      const report = json as {
        issues: Array<{ id: string; severity: string; source: string }>;
      };
      const envIssue = report.issues.find((issue) => issue.id === "paths:unreadable:env");
      expect(envIssue).toMatchObject({ severity: "blocking", source: "paths" });
    } finally {
      chmodSync(ws.paths.envPath, 0o644);
    }
  });

  test("POST /api/providers/merge-case-duplicates/preview 返回 diff", async () => {
    const ws = workspace();
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    config.models.providers.deepseek = { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "DEEPSEEK_API_KEY" }, models: [{ id: "c" }] };
    config.models.providers.DeepSeek = { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "DEEPSEEK_API_KEY" }, models: [{ id: "r" }] };
    config.agents.defaults.models["DeepSeek/r"] = {};
    writeFileSync(ws.paths.openclawPath, JSON.stringify(config));
    const app = createTestApp(ws);

    const { response, json } = await jsonRequest(app, "/api/providers/merge-case-duplicates/preview", {
      method: "POST",
      body: JSON.stringify({ groupKey: "deepseek", canonicalId: "deepseek", removeIds: ["DeepSeek"] })
    });
    expect(response.status).toBe(200);
    expect(json.providersRemoved).toContain("DeepSeek");
  });

  test("POST /api/providers/merge-case-duplicates 写入并备份", async () => {
    const ws = workspace();
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    config.models.providers.deepseek = { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "DEEPSEEK_API_KEY" }, models: [{ id: "c" }] };
    config.models.providers.DeepSeek = { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "DEEPSEEK_API_KEY" }, models: [{ id: "r" }] };
    config.agents.defaults.models["DeepSeek/r"] = {};
    writeFileSync(ws.paths.openclawPath, JSON.stringify(config));
    const app = createTestApp(ws);

    const { response, json } = await jsonRequest(app, "/api/providers/merge-case-duplicates", {
      method: "POST",
      body: JSON.stringify({ groupKey: "deepseek", canonicalId: "deepseek", removeIds: ["DeepSeek"] })
    });
    expect(response.status).toBe(200);
    expect(json.backupId).toBeTruthy();
    const written = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(written.models.providers.DeepSeek).toBeUndefined();
    expect(written.agents.defaults.models["deepseek/r"]).toEqual({});
  });

  test("merge canonicalId 不在组内 → 400", async () => {
    const ws = workspace();
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    config.models.providers.deepseek = { models: [] };
    config.models.providers.DeepSeek = { models: [] };
    writeFileSync(ws.paths.openclawPath, JSON.stringify(config));
    const app = createTestApp(ws);
    const { response } = await jsonRequest(app, "/api/providers/merge-case-duplicates", {
      method: "POST",
      body: JSON.stringify({ groupKey: "deepseek", canonicalId: "nope", removeIds: ["DeepSeek"] })
    });
    expect(response.status).toBe(400);
  });
});

describe("server path settings", () => {
  test("initialization probes once only when paths are absent", () => {
    const ws = workspace();
    const discovery: RuntimeDiscoveryResult = {
      status: "gateway-not-detected",
      instances: [],
      candidateGroups: [],
      diagnostics: []
    };
    let calls = 0;
    const runtimeDiscoveryProvider = () => {
      calls += 1;
      return discovery;
    };

    createApp({
      token: TOKEN,
      presetDirs: ws.presetDirs,
      runtimeDiscoveryProvider
    });
    expect(calls).toBe(1);

    createApp({
      token: TOKEN,
      paths: ws.paths,
      presetDirs: ws.presetDirs,
      runtimeDiscoveryProvider
    });
    expect(calls).toBe(1);
  });

  test("PUT /api/settings/paths switches subsequent reads immediately", async () => {
    const ws = workspace();
    const nextDir = mkdtempSync(join(tmpdir(), "oc-switch-server-next-"));
    tempDirs.push(nextDir);
    const nextOpenclawPath = join(nextDir, "openclaw.json");
    const nextEnvPath = join(nextDir, ".env");
    writeFileSync(nextOpenclawPath, JSON.stringify({
      models: { providers: { switched: { models: [{ id: "model-a" }] } } },
      agents: { defaults: { models: {} } }
    }, null, 2));
    writeFileSync(nextEnvPath, "SWITCHED_API_KEY=value\n");
    const app = createTestApp(ws);

    const switched = await jsonRequest(app, "/api/settings/paths", {
      method: "PUT",
      body: JSON.stringify({ openclawPath: nextOpenclawPath, envPath: nextEnvPath })
    });
    expect(switched.response.status).toBe(200);

    const providers = await jsonRequest(app, "/api/providers");
    expect((providers.json.providers as Array<{ id: string }>).map((item) => item.id)).toEqual(["switched"]);
  });

  test("PUT /api/settings/paths rejects invalid env path", async () => {
    const ws = workspace();
    const nextDir = mkdtempSync(join(tmpdir(), "oc-switch-server-bad-env-"));
    tempDirs.push(nextDir);
    const nextOpenclawPath = join(nextDir, "openclaw.json");
    const missingEnvPath = join(nextDir, "missing", ".env");
    writeFileSync(nextOpenclawPath, JSON.stringify({
      models: { providers: {} },
      agents: { defaults: { models: {} } }
    }, null, 2));
    const app = createTestApp(ws);

    const rejected = await jsonRequest(app, "/api/settings/paths", {
      method: "PUT",
      body: JSON.stringify({ openclawPath: nextOpenclawPath, envPath: missingEnvPath })
    });
    expect(rejected.response.status).toBe(400);
    expect(String((rejected.json as { error?: string }).error)).toContain("父目录不可写");
  });

  test("PUT /api/settings/paths rejects symlink openclaw path", async () => {
    const ws = workspace();
    const nextDir = mkdtempSync(join(tmpdir(), "oc-switch-server-bad-openclaw-"));
    tempDirs.push(nextDir);
    const realOpenclawPath = join(nextDir, "real-openclaw.json");
    const symlinkOpenclawPath = join(nextDir, "openclaw-link.json");
    const nextEnvPath = join(nextDir, ".env");
    writeFileSync(realOpenclawPath, JSON.stringify({
      models: { providers: {} },
      agents: { defaults: { models: {} } }
    }, null, 2));
    writeFileSync(nextEnvPath, "KEY=value\n");
    symlinkSync(realOpenclawPath, symlinkOpenclawPath);
    const app = createTestApp(ws);

    const rejected = await jsonRequest(app, "/api/settings/paths", {
      method: "PUT",
      body: JSON.stringify({ openclawPath: symlinkOpenclawPath, envPath: nextEnvPath })
    });
    expect(rejected.response.status).toBe(400);
    expect(String((rejected.json as { error?: string }).error)).toContain("openclaw.json 路径为符号链接");
  });

  test("PUT /api/settings/paths accepts valid env path including non-existent file", async () => {
    const ws = workspace();
    const nextDir = mkdtempSync(join(tmpdir(), "oc-switch-server-good-env-"));
    tempDirs.push(nextDir);
    const nextOpenclawPath = join(nextDir, "openclaw.json");
    const futureEnvPath = join(nextDir, "future.env");
    writeFileSync(nextOpenclawPath, JSON.stringify({
      models: { providers: { ok: { models: [{ id: "m" }] } } },
      agents: { defaults: { models: {} } }
    }, null, 2));
    const app = createTestApp(ws);

    const accepted = await jsonRequest(app, "/api/settings/paths", {
      method: "PUT",
      body: JSON.stringify({ openclawPath: nextOpenclawPath, envPath: futureEnvPath })
    });
    expect(accepted.response.status).toBe(200);
  });

  test("GET /api/settings/paths uses one injected runtime snapshot", async () => {
    const ws = workspace();
    const runningConfig = join(ws.dir, "running-openclaw.json");
    const runningEnv = join(ws.dir, "running.env");
    writeFileSync(runningConfig, "{}");
    writeFileSync(runningEnv, "RUNNING=1\n");
    let calls = 0;
    const app = createTestApp(ws, undefined, {
      runtimeDiscoveryProvider: () => {
        calls += 1;
        return {
          status: "resolved",
          instances: [{
            instanceId: "pid:4242",
            pid: 4242,
            stateDir: ws.dir,
            openclawPath: runningConfig,
            envPath: runningEnv,
            confidence: "strong",
            evidence: ["process-environ"]
          }],
          candidateGroups: [{
            candidateId: "pid:4242:candidate",
            instanceId: "pid:4242",
            stateDir: ws.dir,
            openclawPath: runningConfig,
            envPath: runningEnv,
            pid: 4242,
            confidence: "strong",
            evidence: ["process-environ"]
          }],
          diagnostics: []
        };
      }
    });

    const { response, json } = await jsonRequest(app, "/api/settings/paths");
    expect(response.status).toBe(200);
    expect(calls).toBe(1);
    expect((json.openclawPaths as Array<{ path: string; source: string }>).find((item) => item.path === runningConfig)).toMatchObject({
      source: "running-instance",
      recommended: true,
      candidateId: "pid:4242:candidate"
    });
    expect((json.envPaths as Array<{ path: string; source: string }>).find((item) => item.path === runningEnv)).toMatchObject({
      source: "running-instance",
      recommended: true
    });
  });

  test("GET /api/settings/paths returns runtimeDiscovery/groups without probe secrets", async () => {
    const ws = workspace();
    const runningConfig = join(ws.dir, "running-openclaw.json");
    const runningEnv = join(ws.dir, "running.env");
    const serviceEnv = join(ws.dir, "service-env", "gateway.env");
    writeFileSync(runningConfig, "{}");
    writeFileSync(runningEnv, "RUNNING=1\n");
    mkdirSync(join(ws.dir, "service-env"), { recursive: true });
    writeFileSync(serviceEnv, "SECRET_FROM_SERVICE=should-not-leak\nOPENCLAW_STATE_DIR=/leak\n");
    const discovery: RuntimeDiscoveryResult = {
      status: "resolved",
      instances: [{
        instanceId: "launchd:ai.openclaw.gateway",
        pid: 27561,
        stateDir: ws.dir,
        openclawPath: runningConfig,
        envPath: runningEnv,
        serviceEnvPath: serviceEnv,
        confidence: "strong",
        evidence: ["launchd-plist", "process-environ"]
      }],
      candidateGroups: [{
        candidateId: "launchd:ai.openclaw.gateway:candidate",
        instanceId: "launchd:ai.openclaw.gateway",
        stateDir: ws.dir,
        openclawPath: runningConfig,
        envPath: runningEnv,
        serviceEnvPath: serviceEnv,
        pid: 27561,
        confidence: "strong",
        evidence: ["launchd-plist", "process-environ"]
      }],
      diagnostics: []
    };
    const app = createTestApp(ws, undefined, {
      runtimeDiscoveryProvider: () => discovery
    });

    const { response, json } = await jsonRequest(app, "/api/settings/paths");
    expect(response.status).toBe(200);
    expect(json.runtimeDiscovery).toMatchObject({
      status: "resolved",
      instances: [{ confidence: "strong", instanceId: "launchd:ai.openclaw.gateway" }]
    });
    expect(json.runtimeCandidateGroups).toEqual(discovery.candidateGroups);
    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain("SECRET_FROM_SERVICE");
    expect(serialized).not.toContain("should-not-leak");
    expect(serialized).not.toContain("OPENCLAW_STATE_DIR=/leak");
    expect(serialized).not.toContain("/bin/sh");
    expect(serialized).not.toContain("probe stderr");
    expect((json.envPaths as Array<{ path: string }>).some((item) => item.path === serviceEnv)).toBe(false);
  });

  test("GET /api/settings/paths distinguishes inferred/unresolved/not-detected/probe-failed", async () => {
    const cases: Array<{
      status: RuntimeDiscoveryResult["status"];
      confidence?: "inferred";
      expectConfidence: boolean;
    }> = [
      { status: "resolved", confidence: "inferred", expectConfidence: true },
      { status: "gateway-detected-path-unresolved", expectConfidence: false },
      { status: "gateway-not-detected", expectConfidence: false },
      { status: "probe-failed", expectConfidence: false }
    ];

    for (const item of cases) {
      const ws = workspace();
      const discovery: RuntimeDiscoveryResult = {
        status: item.status,
        instances: item.status === "resolved"
          ? [{
            instanceId: "pid:9",
            pid: 9,
            stateDir: ws.dir,
            openclawPath: ws.paths.openclawPath,
            envPath: ws.paths.envPath,
            ...(item.confidence ? { confidence: item.confidence } : {}),
            evidence: ["default-state-dir"]
          }]
          : item.status === "gateway-detected-path-unresolved"
            ? [{
              instanceId: "pid:9",
              pid: 9,
              conflicted: true,
              evidence: ["process-cmdline"]
            }]
            : [],
        candidateGroups: item.status === "resolved"
          ? [{
            candidateId: "pid:9:candidate",
            instanceId: "pid:9",
            stateDir: ws.dir,
            openclawPath: ws.paths.openclawPath,
            envPath: ws.paths.envPath,
            pid: 9,
            ...(item.confidence ? { confidence: item.confidence } : {}),
            evidence: ["default-state-dir"]
          }]
          : [],
        diagnostics: item.status === "probe-failed" ? ["process-probe-failed"] : []
      };
      const app = createTestApp(ws, undefined, {
        runtimeDiscoveryProvider: () => discovery
      });
      const { response, json } = await jsonRequest(app, "/api/settings/paths");
      expect(response.status).toBe(200);
      expect((json.runtimeDiscovery as { status: string }).status).toBe(item.status);
      const instances = (json.runtimeDiscovery as { instances: Array<{ confidence?: string }> }).instances;
      if (item.expectConfidence) {
        expect(instances[0]?.confidence).toBe("inferred");
      } else if (instances[0]) {
        expect(instances[0].confidence).toBeUndefined();
      }
    }
  });

  test("PUT /api/settings/paths accepts candidateId and rejects stale/mixed/serviceEnv", async () => {
    const ws = workspace();
    const nextDir = mkdtempSync(join(tmpdir(), "oc-switch-server-runtime-put-"));
    tempDirs.push(nextDir);
    const nextOpenclawPath = join(nextDir, "openclaw.json");
    const nextEnvPath = join(nextDir, ".env");
    const otherEnvPath = join(nextDir, "other.env");
    const serviceEnvPath = join(nextDir, "gateway.systemd.env");
    writeFileSync(nextOpenclawPath, JSON.stringify({
      models: { providers: { runtime: { models: [{ id: "m" }] } } },
      agents: { defaults: { models: {} } }
    }, null, 2));
    writeFileSync(nextEnvPath, "RUNTIME=1\n");
    writeFileSync(otherEnvPath, "OTHER=1\n");
    writeFileSync(serviceEnvPath, "SERVICE=1\n");
    const candidateId = "launchd:ai.openclaw.gateway:candidate";
    const discovery: RuntimeDiscoveryResult = {
      status: "resolved",
      instances: [{
        instanceId: "launchd:ai.openclaw.gateway",
        pid: 42,
        stateDir: nextDir,
        openclawPath: nextOpenclawPath,
        envPath: nextEnvPath,
        serviceEnvPath,
        confidence: "confirmed",
        evidence: ["cli-status"]
      }],
      candidateGroups: [{
        candidateId,
        instanceId: "launchd:ai.openclaw.gateway",
        stateDir: nextDir,
        openclawPath: nextOpenclawPath,
        envPath: nextEnvPath,
        serviceEnvPath,
        pid: 42,
        confidence: "confirmed",
        evidence: ["cli-status"]
      }],
      diagnostics: []
    };
    const app = createTestApp(ws, undefined, {
      runtimeDiscoveryProvider: () => discovery
    });

    const accepted = await jsonRequest(app, "/api/settings/paths", {
      method: "PUT",
      body: JSON.stringify({
        openclawPath: nextOpenclawPath,
        envPath: nextEnvPath,
        candidateId
      })
    });
    expect(accepted.response.status).toBe(200);

    const stale = await jsonRequest(app, "/api/settings/paths", {
      method: "PUT",
      body: JSON.stringify({
        openclawPath: nextOpenclawPath,
        envPath: nextEnvPath,
        candidateId: "stale-id"
      })
    });
    expect(stale.response.status).toBe(400);
    expect(String((stale.json as { error?: string }).error)).toContain("candidateId");

    const mixed = await jsonRequest(app, "/api/settings/paths", {
      method: "PUT",
      body: JSON.stringify({
        openclawPath: nextOpenclawPath,
        envPath: otherEnvPath,
        candidateId
      })
    });
    expect(mixed.response.status).toBe(400);
    expect(String((mixed.json as { error?: string }).error)).toContain("配对");

    const serviceEnv = await jsonRequest(app, "/api/settings/paths", {
      method: "PUT",
      body: JSON.stringify({
        openclawPath: nextOpenclawPath,
        envPath: serviceEnvPath
      })
    });
    expect(serviceEnv.response.status).toBe(400);
    expect(String((serviceEnv.json as { error?: string }).error)).toContain("service env");
  });

  test("PUT /api/settings/paths without candidateId stays manual mode", async () => {
    const ws = workspace();
    const nextDir = mkdtempSync(join(tmpdir(), "oc-switch-server-manual-put-"));
    tempDirs.push(nextDir);
    const nextOpenclawPath = join(nextDir, "openclaw.json");
    const nextEnvPath = join(nextDir, ".env");
    writeFileSync(nextOpenclawPath, JSON.stringify({
      models: { providers: { manual: { models: [{ id: "m" }] } } },
      agents: { defaults: { models: {} } }
    }, null, 2));
    writeFileSync(nextEnvPath, "MANUAL=1\n");
    const app = createTestApp(ws, undefined, {
      runtimeDiscoveryProvider: () => ({
        status: "resolved",
        instances: [{
          instanceId: "pid:1",
          pid: 1,
          stateDir: ws.dir,
          openclawPath: ws.paths.openclawPath,
          envPath: ws.paths.envPath,
          confidence: "strong",
          evidence: ["process-environ"]
        }],
        candidateGroups: [{
          candidateId: "pid:1:candidate",
          instanceId: "pid:1",
          stateDir: ws.dir,
          openclawPath: ws.paths.openclawPath,
          envPath: ws.paths.envPath,
          pid: 1,
          confidence: "strong",
          evidence: ["process-environ"]
        }],
        diagnostics: []
      })
    });

    const accepted = await jsonRequest(app, "/api/settings/paths", {
      method: "PUT",
      body: JSON.stringify({ openclawPath: nextOpenclawPath, envPath: nextEnvPath })
    });
    expect(accepted.response.status).toBe(200);
    expect((accepted.json as { paths: { openclawPath: string } }).paths.openclawPath).toBe(nextOpenclawPath);
  });
});

describe("server env APIs", () => {
  test("GET /api/env indexes variables without secret values", async () => {
    const ws = workspace();
    writeFileSync(ws.paths.envPath, "NVIDIA_API_KEY=sk-test-secret\n");
    const app = createTestApp(ws);

    const { response, json } = await jsonRequest(app, "/api/env");
    expect(response.status).toBe(200);
    expect(JSON.stringify(json)).toContain("NVIDIA_API_KEY");
    expect(JSON.stringify(json)).not.toContain("sk-test-secret");
  });

  test("POST /api/env updates unmanaged var only with confirmation and never echoes value", async () => {
    const ws = workspace();
    writeFileSync(ws.paths.envPath, "SOME_MCP_EPID=old-secret\n");
    const app = createTestApp(ws);

    const rejected = await jsonRequest(app, "/api/env", {
      method: "POST",
      body: JSON.stringify({ type: "upsert", envVar: "SOME_MCP_EPID", value: "new-secret" })
    });
    expect(rejected.response.status).toBe(400);

    const accepted = await jsonRequest(app, "/api/env", {
      method: "POST",
      body: JSON.stringify({
        type: "upsert",
        envVar: "SOME_MCP_EPID",
        value: "new-secret",
        confirmMigration: true
      })
    });
    expect(accepted.response.status).toBe(200);
    expect(JSON.stringify(accepted.json)).not.toContain("new-secret");
    expect(readFileSync(ws.paths.envPath, "utf8")).toContain("SOME_MCP_EPID=new-secret");
  });

  test("POST /api/env/preview accepts upsert without value", async () => {
    const ws = workspace();
    writeFileSync(ws.paths.envPath, "SOME_MCP_EPID=old-secret\n");
    const app = createTestApp(ws);

    const { response, json } = await jsonRequest(app, "/api/env/preview", {
      method: "POST",
      body: JSON.stringify({ type: "upsert", envVar: "SOME_MCP_EPID" })
    });
    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      affectedKeys: ["SOME_MCP_EPID"],
      requiresConfirmation: true,
      requiresMigration: true,
      requiresComplex: false
    });
    expect(JSON.stringify(json)).not.toContain("old-secret");
  });

  test("POST /api/env/preview rejects value in request body", async () => {
    const ws = workspace();
    const app = createTestApp(ws);

    const { response } = await jsonRequest(app, "/api/env/preview", {
      method: "POST",
      body: JSON.stringify({ type: "upsert", envVar: "SOME_KEY", value: "secret" })
    });
    expect(response.status).toBe(400);
  });

  test("PATCH /api/providers/:id/state disables and restores provider with state snapshot", async () => {
    const ws = workspace();
    const app = createTestApp(ws);

    const disabled = await jsonRequest(app, "/api/providers/nvidia/state", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false })
    });
    expect(disabled.response.status).toBe(200);
    expect(disabled.json).toMatchObject({ ok: true, providerId: "nvidia", enabled: false, disabledModelCount: 2 });

    let config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers.nvidia.models.map((model: { id: string }) => model.id)).toContain("deepseek-ai/deepseek-v4-flash");
    expect(config.agents.defaults.models["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeUndefined();
    const states = JSON.parse(readFileSync(join(ws.paths.stateDir, "provider-states.json"), "utf8"));
    expect(states.disabledProviders.nvidia.allowlistEntries["nvidia/deepseek-ai/deepseek-v4-flash"]).toEqual({
      alias: "nv-ds-flash",
      agentRuntime: { id: "codex" }
    });

    const providers = await jsonRequest(app, "/api/providers");
    const nvidia = (providers.json.providers as Array<{ id: string; disabled: boolean }>).find((provider) => provider.id === "nvidia");
    expect(nvidia?.disabled).toBe(true);

    const restored = await jsonRequest(app, "/api/providers/nvidia/state", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true })
    });
    expect(restored.response.status).toBe(200);
    expect(restored.json).toMatchObject({ ok: true, providerId: "nvidia", enabled: true, restoredModelCount: 2 });
    config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.agents.defaults.models["nvidia/deepseek-ai/deepseek-v4-flash"]).toEqual({
      alias: "nv-ds-flash",
      agentRuntime: { id: "codex" }
    });
    const afterStates = JSON.parse(readFileSync(join(ws.paths.stateDir, "provider-states.json"), "utf8"));
    expect(afterStates.disabledProviders.nvidia).toBeUndefined();
  });

  test("PATCH /api/providers/:id/state refuses provider containing primary model", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/providers/minimax-portal/state", {
      method: "PATCH",
      body: JSON.stringify({ enabled: false })
    });

    expect(response.status).toBe(400);
    expect(String(json.error)).toContain("contains the primary model");
  });

  test("PATCH /api/providers/:id/state refuses restore when snapshot path differs", async () => {
    const ws = workspace();
    upsertDisabledProviderState(ws.paths.stateDir, {
      providerId: "nvidia",
      openclawPath: join(ws.dir, "other-openclaw.json"),
      disabledAt: "2026-06-25T12:00:00.000Z",
      allowlistEntries: {
        "nvidia/deepseek-ai/deepseek-v4-flash": { alias: "nv-ds-flash" }
      }
    });
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/providers/nvidia/state", {
      method: "PATCH",
      body: JSON.stringify({ enabled: true })
    });

    expect(response.status).toBe(400);
    expect(String(json.error)).toContain("belongs to another OpenClaw config");
  });

  test("model enable endpoints reject disabled providers", async () => {
    const ws = workspace();
    upsertDisabledProviderState(ws.paths.stateDir, {
      providerId: "nvidia",
      openclawPath: ws.paths.openclawPath,
      disabledAt: "2026-06-25T12:00:00.000Z",
      allowlistEntries: {}
    });
    const app = createTestApp(ws);

    const patch = await jsonRequest(app, "/api/models", {
      method: "PATCH",
      body: JSON.stringify({ ref: "nvidia/deepseek-ai/deepseek-v4-flash", enabled: true })
    });
    expect(patch.response.status).toBe(400);
    expect(String(patch.json.error)).toContain("Provider nvidia is disabled");

    const create = await jsonRequest(app, "/api/models", {
      method: "POST",
      body: JSON.stringify({ providerId: "nvidia", model: { id: "new-model", enabled: true } })
    });
    expect(create.response.status).toBe(400);
    expect(String(create.json.error)).toContain("Provider nvidia is disabled");
  });

  test("DELETE /api/providers/:id cleans disabled provider state", async () => {
    const ws = workspace();
    upsertDisabledProviderState(ws.paths.stateDir, {
      providerId: "DeepSeek",
      openclawPath: ws.paths.openclawPath,
      disabledAt: "2026-06-25T12:00:00.000Z",
      allowlistEntries: { "DeepSeek/deepseek-chat": { alias: "ds-chat" } }
    });
    const app = createTestApp(ws);

    const { response } = await jsonRequest(app, "/api/providers/DeepSeek", { method: "DELETE" });
    expect(response.status).toBe(200);
    const states = JSON.parse(readFileSync(join(ws.paths.stateDir, "provider-states.json"), "utf8"));
    expect(states.disabledProviders.DeepSeek).toBeUndefined();
  });

  function gatewayDiscoveryFor(
    ws: Workspace,
    options: {
      candidateId?: string;
      extraGroups?: RuntimeDiscoveryResult["candidateGroups"];
      serviceEnvPath?: string;
    } = {}
  ): RuntimeDiscoveryResult {
    const serviceEnvPath = options.serviceEnvPath ?? expectedGatewayEnvPath(ws.dir);
    const serviceManager = process.platform === "darwin" ? "launchd" as const : "systemd" as const;
    const candidateId = options.candidateId ?? "test:single:candidate";
    const primary = {
      candidateId,
      instanceId: "test:single",
      stateDir: ws.dir,
      openclawPath: ws.paths.openclawPath,
      envPath: ws.paths.envPath,
      serviceEnvPath,
      serviceManager,
      serviceId: serviceManager === "launchd" ? "ai.openclaw.gateway" : "openclaw-gateway.service",
      pid: 1001,
      confidence: "strong" as const,
      evidence: ["process-environ" as const]
    };
    const groups = [primary, ...(options.extraGroups ?? [])];
    return {
      status: "resolved",
      instances: groups.map((group) => ({
        instanceId: group.instanceId,
        pid: group.pid,
        openclawPath: group.openclawPath,
        envPath: group.envPath,
        stateDir: group.stateDir,
        ...(group.serviceEnvPath ? { serviceEnvPath: group.serviceEnvPath } : {}),
        ...(group.serviceManager ? { serviceManager: group.serviceManager } : {}),
        ...(group.serviceId ? { serviceId: group.serviceId } : {}),
        ...(group.confidence ? { confidence: group.confidence } : {}),
        evidence: group.evidence
      })),
      candidateGroups: groups,
      diagnostics: []
    };
  }

  test("POST /api/gateway/sync-env merges managed block for single active candidate", async () => {
    const ws = workspace();
    writeFileSync(ws.paths.envPath, [
      "# oc-switch:start",
      "NVIDIA_API_KEY=synced-secret",
      "# oc-switch:end"
    ].join("\n") + "\n");
    const gatewayPath = expectedGatewayEnvPath(ws.dir);
    writeFileSync(gatewayPath, "HTTP_PROXY=http://proxy\nNVIDIA_API_KEY=old-secret\n");
    const discovery = gatewayDiscoveryFor(ws);
    const app = createTestApp(ws, undefined, {
      runtimeDiscoveryProvider: () => discovery
    });

    const { response, json } = await jsonRequest(app, "/api/gateway/sync-env", { method: "POST" });

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    const sync = json.sync as { syncedKeys: string[]; candidateId?: string };
    expect(sync.syncedKeys).toContain("NVIDIA_API_KEY");
    expect(sync.candidateId).toBe("test:single:candidate");
    const content = readFileSync(gatewayPath, "utf8");
    expect(content).toContain("HTTP_PROXY=http://proxy");
    expect(content).toContain("NVIDIA_API_KEY");
    expect(content).toContain("synced-secret");
  });

  test("POST /api/gateway/sync-env accepts candidateId and rejects stale/multi without id", async () => {
    const ws = workspace();
    writeFileSync(ws.paths.envPath, "# oc-switch:start\nK=v\n# oc-switch:end\n");
    const serviceEnvPath = expectedGatewayEnvPath(ws.dir);
    writeFileSync(serviceEnvPath, "");
    const extra = {
      candidateId: "test:other:candidate",
      instanceId: "test:other",
      stateDir: join(ws.dir, "other"),
      openclawPath: join(ws.dir, "other", "openclaw.json"),
      envPath: join(ws.dir, "other", ".env"),
      serviceEnvPath: join(ws.dir, "other", "gateway.systemd.env"),
      serviceManager: "systemd" as const,
      serviceId: "openclaw-gateway@other.service",
      pid: 1002,
      confidence: "strong" as const,
      evidence: ["process-environ" as const]
    };
    const discovery = gatewayDiscoveryFor(ws, {
      candidateId: "test:single:candidate",
      extraGroups: [extra]
    });
    let discoverCalls = 0;
    const app = createTestApp(ws, undefined, {
      runtimeDiscoveryProvider: () => {
        discoverCalls += 1;
        return discovery;
      }
    });

    const missing = await jsonRequest(app, "/api/gateway/sync-env", { method: "POST", body: "{}" });
    expect(missing.response.status).toBe(400);
    expect(String((missing.json as { error?: string }).error)).toMatch(/candidateId|Multiple/i);

    const stale = await jsonRequest(app, "/api/gateway/sync-env", {
      method: "POST",
      body: JSON.stringify({ candidateId: "stale-id" })
    });
    expect(stale.response.status).toBe(400);
    expect(String((stale.json as { error?: string }).error)).toContain("stale-id");

    const ok = await jsonRequest(app, "/api/gateway/sync-env", {
      method: "POST",
      body: JSON.stringify({ candidateId: "test:single:candidate" })
    });
    expect(ok.response.status).toBe(200);
    expect((ok.json.sync as { candidateId?: string }).candidateId).toBe("test:single:candidate");
    expect(discoverCalls).toBeGreaterThanOrEqual(3);
  });

  test("POST /api/gateway/sync-env rejects client-supplied serviceEnvPath/command/env", async () => {
    const ws = workspace();
    const discovery = gatewayDiscoveryFor(ws);
    const app = createTestApp(ws, undefined, {
      runtimeDiscoveryProvider: () => discovery
    });

    for (const body of [
      { serviceEnvPath: "/tmp/evil.env" },
      { command: "rm" },
      { env: { OPENCLAW_HOME: "/evil" } }
    ]) {
      const { response, json } = await jsonRequest(app, "/api/gateway/sync-env", {
        method: "POST",
        body: JSON.stringify(body)
      });
      expect(response.status).toBe(400);
      expect(String((json as { error?: string }).error).length).toBeGreaterThan(0);
    }
  });

  test("POST /api/gateway/apply resolves once and skips restart when sync fails", async () => {
    const ws = workspace();
    writeFileSync(ws.paths.envPath, "# oc-switch:start\nTEST_KEY=value\n# oc-switch:end\n");
    const discovery = gatewayDiscoveryFor(ws);
    let discoverCalls = 0;
    let restarted = false;
    let seenCandidateId = "";
    const app = createTestApp(ws, undefined, {
      runtimeDiscoveryProvider: () => {
        discoverCalls += 1;
        return discovery;
      },
      gatewayRouteOptions: {
        restartGateway: async (input) => {
          restarted = true;
          seenCandidateId = input.target.candidateId;
          return { ok: true, exitCode: 0, message: "Gateway restarted" };
        }
      }
    });

    const { response, json } = await jsonRequest(app, "/api/gateway/apply", {
      method: "POST",
      body: JSON.stringify({ candidateId: "test:single:candidate" })
    });

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(restarted).toBe(true);
    expect(seenCandidateId).toBe("test:single:candidate");
    expect(discoverCalls).toBe(1);
    expect(readFileSync(expectedGatewayEnvPath(ws.dir), "utf8")).toContain("TEST_KEY");

    restarted = false;
    discoverCalls = 0;
    const failApp = createTestApp(ws, undefined, {
      runtimeDiscoveryProvider: () => {
        discoverCalls += 1;
        return discovery;
      },
      gatewayRouteOptions: {
        syncManagedBlockToGatewayServiceEnv: () => {
          throw new Error("sync boom");
        },
        restartGateway: async () => {
          restarted = true;
          return { ok: true, exitCode: 0, message: "Gateway restarted" };
        }
      }
    });
    const failed = await jsonRequest(failApp, "/api/gateway/apply", {
      method: "POST",
      body: JSON.stringify({ candidateId: "test:single:candidate" })
    });
    expect(failed.response.status).toBe(400);
    expect(restarted).toBe(false);
    expect(discoverCalls).toBe(1);
  });

  test("POST /api/gateway/restart uses resolved runtime target not placeholder", async () => {
    const ws = workspace();
    writeFileSync(ws.paths.envPath, "# oc-switch:start\nK=v\n# oc-switch:end\n");
    const discovery = gatewayDiscoveryFor(ws);
    let seenTargetPath = "";
    let seenCandidateId = "";
    const app = createTestApp(ws, undefined, {
      runtimeDiscoveryProvider: () => discovery,
      gatewayRouteOptions: {
        restartGateway: async (input) => {
          seenTargetPath = input.target.serviceEnvTarget.targetPath;
          seenCandidateId = input.target.candidateId;
          return { ok: true, exitCode: 0, message: "Gateway restarted" };
        }
      }
    });

    const { response, json } = await jsonRequest(app, "/api/gateway/restart", { method: "POST" });

    expect(response.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(seenCandidateId).toBe("test:single:candidate");
    expect(seenTargetPath).toBe(expectedGatewayEnvPath(ws.dir));
    expect(seenTargetPath).not.toContain("restart-placeholder");
  });
});

interface MetadataFetchSpec {
  status?: number;
  body?: string;
  etag?: string;
}

interface MetadataFetchCall {
  url: string;
  headers: Record<string, string>;
  body?: unknown;
}

function metadataFetch(byUrl: Record<string, MetadataFetchSpec>) {
  const calls: MetadataFetchCall[] = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers, ...(init?.body !== undefined ? { body: init.body } : {}) });
    const spec = byUrl[url];
    if (!spec) throw new Error(`unexpected url: ${url}`);
    const responseHeaders: Record<string, string> = {};
    if (spec.etag) responseHeaders["etag"] = spec.etag;
    return new Response(spec.body ?? "", { status: spec.status ?? 200, headers: responseHeaders });
  };
  return { fetchImpl, calls };
}

function modelsDevSuccessSpecs(): Record<string, MetadataFetchSpec> {
  return {
    [MODELS_DEV_MODELS_URL]: { status: 200, body: JSON.stringify(modelsDevModelsFixture), etag: "etag-models" },
    [MODELS_DEV_API_URL]: { status: 200, body: JSON.stringify(modelsDevApiFixture), etag: "etag-api" }
  };
}

describe("server model-metadata suggestions", () => {
  const SUGGESTIONS_URL = "/api/model-metadata/suggestions";

  test("providerId/modelId 必填；modelId 中斜杠正确 URL decode", async () => {
    const ws = workspace();
    const { fetchImpl } = metadataFetch(modelsDevSuccessSpecs());
    const app = createTestApp(ws, fetchImpl);

    const missingProvider = await jsonRequest(app, `${SUGGESTIONS_URL}?modelId=gpt-5.2`);
    expect(missingProvider.response.status).toBe(400);
    expect(String(missingProvider.json.error)).toContain("providerId");

    const missingModel = await jsonRequest(app, `${SUGGESTIONS_URL}?providerId=nvidia`);
    expect(missingModel.response.status).toBe(400);
    expect(String(missingModel.json.error)).toContain("modelId");

    // 编码后的 %2F 必须被解码为 openai/gpt-5.2 才能命中 model-key-exact
    const { response, json } = await jsonRequest(
      app,
      `${SUGGESTIONS_URL}?providerId=nvidia&modelId=${encodeURIComponent("openai/gpt-5.2")}`
    );
    expect(response.status).toBe(200);
    const suggestions = json.suggestions as Array<{
      matchKind: string;
      confidence: string;
      model: { catalogKey: string };
    }>;
    expect(suggestions[0]).toMatchObject({
      matchKind: "model-key-exact",
      confidence: "high",
      model: { catalogKey: "openai/gpt-5.2" }
    });
  });

  test("Provider 不存在返回 4xx 且不访问 Models.dev", async () => {
    const ws = workspace();
    const { fetchImpl, calls } = metadataFetch(modelsDevSuccessSpecs());
    const app = createTestApp(ws, fetchImpl);

    const { response, json } = await jsonRequest(
      app,
      `${SUGGESTIONS_URL}?providerId=does-not-exist&modelId=gpt-5.2`
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
    expect(String(json.error)).toContain("does-not-exist");
    expect(calls).toHaveLength(0);
  });

  test("成功响应只包含归一化建议、逐源时间/stale 状态与 warnings", async () => {
    const ws = workspace();
    const { fetchImpl } = metadataFetch(modelsDevSuccessSpecs());
    const app = createTestApp(ws, fetchImpl);

    const { response, json } = await jsonRequest(
      app,
      `${SUGGESTIONS_URL}?providerId=nvidia&modelId=${encodeURIComponent("openai/gpt-5.2")}`
    );

    expect(response.status).toBe(200);
    const suggestions = json.suggestions as Array<{
      matchKind: string;
      confidence: string;
      model: Record<string, unknown>;
    }>;
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.matchKind).toBe("model-key-exact");
    expect(suggestions[0]?.model).toMatchObject({
      catalogKey: "openai/gpt-5.2",
      contextWindow: 400000,
      maxTokens: 128000
    });
    // 归一化字段白名单：不泄漏 raw 第三方 schema 字段
    expect(Object.keys(suggestions[0]?.model ?? {}).sort()).toEqual([
      "catalogKey",
      "contextWindow",
      "input",
      "maxTokens",
      "modelId",
      "name",
      "providerId",
      "reasoning",
      "sourceKind",
      "sourceUrl",
      "updatedAt"
    ]);
    expect(JSON.stringify(json)).not.toContain("last_updated");
    expect(JSON.stringify(json)).not.toContain("sk-");

    const sources = json.sources as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect(Object.keys(source).sort()).toEqual(["checkedAt", "fetchedAt", "kind", "stale"]);
      expect(source.stale).toBe(false);
    }
    // fixture 含 broken/* 非法 limit 条目，归一化 warning 允许存在但必须是纯字符串
    expect(Array.isArray(json.warnings)).toBe(true);
    expect((json.warnings as string[]).every((warning) => typeof warning === "string")).toBe(true);
  });

  test("refresh=1 绕过 fresh TTL 但仍使用 ETag", async () => {
    const ws = workspace();
    const url = `${SUGGESTIONS_URL}?providerId=nvidia&modelId=${encodeURIComponent("openai/gpt-5.2")}`;

    // 首次查询：下载并落盘缓存
    const first = metadataFetch(modelsDevSuccessSpecs());
    const app = createTestApp(ws, first.fetchImpl);
    const { response } = await jsonRequest(app, url);
    expect(response.status).toBe(200);
    expect(first.calls).toHaveLength(2);

    // TTL 内不刷新：即使 fetch 会失败也不联网
    const second = metadataFetch({
      [MODELS_DEV_MODELS_URL]: { status: 500 },
      [MODELS_DEV_API_URL]: { status: 500 }
    });
    const cachedApp = createTestApp(ws, second.fetchImpl);
    const cached = await jsonRequest(cachedApp, url);
    expect(cached.response.status).toBe(200);
    expect(second.calls).toHaveLength(0);
    expect((cached.json.suggestions as unknown[]).length).toBeGreaterThan(0);

    // refresh=1：绕过 TTL，带 If-None-Match；304 后数据保留
    const third = metadataFetch({
      [MODELS_DEV_MODELS_URL]: { status: 304 },
      [MODELS_DEV_API_URL]: { status: 304 }
    });
    const refreshApp = createTestApp(ws, third.fetchImpl);
    const refreshed = await jsonRequest(refreshApp, `${url}&refresh=1`);
    expect(refreshed.response.status).toBe(200);
    expect(third.calls).toHaveLength(2);
    expect(third.calls.find((call) => call.url === MODELS_DEV_MODELS_URL)?.headers["If-None-Match"]).toBe(
      "etag-models"
    );
    expect(third.calls.find((call) => call.url === MODELS_DEV_API_URL)?.headers["If-None-Match"]).toBe("etag-api");
    expect((refreshed.json.suggestions as unknown[]).length).toBeGreaterThan(0);
  });

  test("目录错误返回空建议与 warning，不阻止其他模型 API", async () => {
    const ws = workspace();
    const { fetchImpl } = metadataFetch({
      [MODELS_DEV_MODELS_URL]: { status: 500 },
      [MODELS_DEV_API_URL]: { status: 500 }
    });
    const app = createTestApp(ws, fetchImpl);

    const { response, json } = await jsonRequest(
      app,
      `${SUGGESTIONS_URL}?providerId=nvidia&modelId=deepseek-chat`
    );

    expect(response.status).toBe(200);
    expect(json.suggestions).toEqual([]);
    expect((json.warnings as string[]).length).toBeGreaterThan(0);

    const models = await jsonRequest(app, "/api/models");
    expect(models.response.status).toBe(200);
  });

  test("建议查询不修改 openclaw.json/.env，也不创建 backup", async () => {
    const ws = workspace();
    writeFileSync(ws.paths.envPath, "NVIDIA_API_KEY=sk-secret\n");
    const { fetchImpl } = metadataFetch(modelsDevSuccessSpecs());
    const app = createTestApp(ws, fetchImpl);
    const beforeConfig = readFileSync(ws.paths.openclawPath, "utf8");
    const beforeEnv = readFileSync(ws.paths.envPath, "utf8");

    const { response } = await jsonRequest(
      app,
      `${SUGGESTIONS_URL}?providerId=nvidia&modelId=${encodeURIComponent("openai/gpt-5.2")}`
    );
    expect(response.status).toBe(200);

    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(beforeConfig);
    expect(readFileSync(ws.paths.envPath, "utf8")).toBe(beforeEnv);
    const { json: backupsJson } = await jsonRequest(app, "/api/backups");
    expect((backupsJson.backups as unknown[]).length).toBe(0);
  });

  test("外发请求只有固定 allowlist URL，URL/body/header 不含密钥与本地标识", async () => {
    const ws = workspace();
    const { fetchImpl, calls } = metadataFetch(modelsDevSuccessSpecs());
    const app = createTestApp(ws, fetchImpl);

    const { response } = await jsonRequest(
      app,
      `${SUGGESTIONS_URL}?providerId=nvidia&modelId=${encodeURIComponent("openai/gpt-5.2")}`
    );
    expect(response.status).toBe(200);

    const allowlist = new Set([MODELS_DEV_MODELS_URL, MODELS_DEV_API_URL]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(allowlist.has(call.url)).toBe(true);
      expect(call.url).not.toContain("nvidia");
      expect(call.url).not.toContain("gpt-5.2");
      expect(call.url).not.toContain("integrate.api.nvidia.com");
      expect(call.url).not.toContain("sk-");
      expect(call.body).toBeUndefined();
      for (const [header, value] of Object.entries(call.headers)) {
        expect(header.toLowerCase()).toBe("if-none-match");
        expect(String(value)).not.toContain("sk-");
      }
    }
  });

  test("endpoint-exact 使用 config 中当前 Provider 的 baseUrl", async () => {
    const ws = workspace();
    // 追加一个 baseUrl 与 fixture 中 endpoint-provider.api 一致的 Provider
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8")) as Record<string, unknown>;
    const models = config.models as { providers: Record<string, unknown> };
    models.providers["endpoint-user"] = {
      baseUrl: "https://api.endpoint.example/v1",
      apiKey: { source: "env", id: "ENDPOINT_USER_API_KEY" },
      api: "openai-completions",
      models: [{ id: "special-model", name: "Special Model" }]
    };
    writeFileSync(ws.paths.openclawPath, JSON.stringify(config, null, 2));

    const { fetchImpl } = metadataFetch(modelsDevSuccessSpecs());
    const app = createTestApp(ws, fetchImpl);
    const { response, json } = await jsonRequest(
      app,
      `${SUGGESTIONS_URL}?providerId=endpoint-user&modelId=special-model`
    );

    expect(response.status).toBe(200);
    const suggestions = json.suggestions as Array<{
      matchKind: string;
      confidence: string;
      model: { catalogKey: string; contextWindow: number; maxTokens: number };
    }>;
    expect(suggestions[0]).toMatchObject({
      matchKind: "endpoint-exact",
      confidence: "high",
      model: { catalogKey: "endpoint-provider/special-model", contextWindow: 64000, maxTokens: 8192 }
    });
  });
});

describe("对象形态主模型配置（agents.defaults.model = { primary, fallbacks }）", () => {
  function objectPrimaryWorkspace(): Workspace {
    const ws = workspace();
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8")) as Record<string, unknown>;
    (config.agents as { defaults: Record<string, unknown> }).defaults.model = {
      primary: "minimax-portal/MiniMax-M3",
      fallbacks: ["nvidia/deepseek-ai/deepseek-v4-flash"]
    };
    writeFileSync(ws.paths.openclawPath, `${JSON.stringify(config, null, 2)}\n`);
    return ws;
  }

  test("GET /api/providers 返回 200 且 containsPrimary 正确（对象形态崩溃回归点）", async () => {
    const ws = objectPrimaryWorkspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/providers");

    expect(response.status).toBe(200);
    const providers = json.providers as Array<{ id: string; containsPrimary: boolean }>;
    expect(providers.find((entry) => entry.id === "minimax-portal")?.containsPrimary).toBe(true);
    expect(providers.filter((entry) => entry.containsPrimary)).toHaveLength(1);
  });

  test("GET /api/status 返回归一 primaryModel 字符串", async () => {
    const ws = objectPrimaryWorkspace();
    const app = createTestApp(ws);
    const { response, json } = await jsonRequest(app, "/api/status");

    expect(response.status).toBe(200);
    expect(json.primaryModel).toBe("minimax-portal/MiniMax-M3");
  });

  test("切换主模型保留对象形状与 fallbacks", async () => {
    const ws = objectPrimaryWorkspace();
    const app = createTestApp(ws);
    const { response } = await jsonRequest(app, "/api/models/primary", {
      method: "PUT",
      body: JSON.stringify({ ref: "nvidia/z-ai/glm5.1" })
    });

    expect(response.status).toBe(200);
    const persisted = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8")) as {
      agents: { defaults: { model: Record<string, unknown> } };
    };
    expect(persisted.agents.defaults.model).toEqual({
      primary: "nvidia/z-ai/glm5.1",
      fallbacks: ["nvidia/deepseek-ai/deepseek-v4-flash"]
    });
  });

  test("删除 fallback 模型返回冲突错误且文件不变", async () => {
    const ws = objectPrimaryWorkspace();
    const app = createTestApp(ws);
    const before = readFileSync(ws.paths.openclawPath, "utf8");
    const { response, json } = await jsonRequest(app, "/api/models", {
      method: "DELETE",
      body: JSON.stringify({ ref: "nvidia/deepseek-ai/deepseek-v4-flash", force: true })
    });

    expect(response.status).toBe(400);
    expect(String(json.error)).toContain("agents.defaults.model.fallbacks");
    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
  });

  test("删除 fallback 所属 Provider 返回冲突错误且文件不变", async () => {
    const ws = objectPrimaryWorkspace();
    const app = createTestApp(ws);
    const before = readFileSync(ws.paths.openclawPath, "utf8");
    const { response, json } = await jsonRequest(app, "/api/providers/nvidia", {
      method: "DELETE",
      body: JSON.stringify({ force: true })
    });

    expect(response.status).toBe(400);
    expect(String(json.error)).toContain("agents.defaults.model.fallbacks");
    expect(readFileSync(ws.paths.openclawPath, "utf8")).toBe(before);
  });
});
