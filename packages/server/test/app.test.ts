import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "../../core/test/fixtures/openclaw.sample.json";
import { createApp } from "../src/app";
import type { FetchImpl, OcSwitchPaths, PresetDirs } from "@oc-switch/core";
import { upsertDisabledProviderState } from "@oc-switch/core";

const tempDirs: string[] = [];
const TOKEN = "test-secret";
const repoRoot = join(import.meta.dir, "../../..");

function authHeaders(token = TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

interface Workspace {
  dir: string;
  paths: OcSwitchPaths;
  presetDirs: PresetDirs;
}

function workspace(): Workspace {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-server-"));
  tempDirs.push(dir);
  const openclawPath = join(dir, "openclaw.json");
  const envPath = join(dir, ".env");
  const stateDir = join(dir, ".oc-switch");
  writeFileSync(openclawPath, `${JSON.stringify(sample, null, 2)}\n`);
  const customDir = join(stateDir, "presets", "custom");
  mkdirSync(customDir, { recursive: true });
  return {
    dir,
    paths: { openclawPath, envPath, stateDir },
    presetDirs: {
      builtinDir: join(repoRoot, "presets", "builtin"),
      customDir
    }
  };
}

function createTestApp(ws: Workspace, fetchImpl?: FetchImpl, extra?: { runningInstances?: Array<{ pid: number; openclawPath?: string; envPath?: string }> }) {
  return createApp({
    token: TOKEN,
    paths: ws.paths,
    presetDirs: ws.presetDirs,
    repoRoot,
    ...(fetchImpl ? { fetchImpl } : {}),
    ...(extra?.runningInstances ? { runningInstances: extra.runningInstances } : {})
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
    expect(presets.some((p) => p.id === "nvidia")).toBe(true);
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
          reasoning: true,
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
        apiKey: "super-secret-key-value",
        models: ["vendor/model"]
      })
    });

    expect(response.status).toBe(200);
    expect(JSON.stringify(json)).not.toContain("super-secret-key-value");
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
    const body = { ...customProviderBody(), apiKey: "sk-test-custom-secret" };
    const { response, json } = await jsonRequest(app, "/api/providers/custom", {
      method: "POST",
      body: JSON.stringify(body)
    });

    expect(response.status).toBe(200);
    expect(JSON.stringify(json)).not.toContain("sk-test-custom-secret");
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers["custom-openai"]).toMatchObject({
      baseUrl: "https://api.custom.example/v1",
      api: "openai-completions",
      apiKey: { source: "env", id: "CUSTOM_OPENAI_API_KEY" }
    });
    expect(config.agents.defaults.models["custom-openai/vendor/model-b"]).toEqual({ alias: "b" });
    expect(readFileSync(ws.paths.envPath, "utf8")).toContain("CUSTOM_OPENAI_API_KEY=sk-test-custom-secret");
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

  test("PUT /api/providers/:id updates baseUrl", async () => {
    const ws = workspace();
    const app = createTestApp(ws);
    const { response } = await jsonRequest(app, "/api/providers/nvidia", {
      method: "PUT",
      body: JSON.stringify({ baseUrl: "https://new-nvidia.example/v1" })
    });

    expect(response.status).toBe(200);
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers.nvidia.baseUrl).toBe("https://new-nvidia.example/v1");
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
    expect(manifest.providers.DeepSeek).toMatchObject({
      providerId: "DeepSeek",
      envVar: "DEEPSEEK_API_KEY",
      orphan: true
    });
  });

  test("POST /api/providers/:id/sync merges remote models", async () => {
    const ws = workspace();
    const mockFetch: FetchImpl = async () =>
      new Response(JSON.stringify({ data: [{ id: "remote-model-a" }, { id: "remote-model-b" }] }), {
        headers: { "content-type": "application/json" }
      });
    const app = createTestApp(ws, mockFetch);
    const { response, json } = await jsonRequest(app, "/api/providers/nvidia/sync", { method: "POST" });

    expect(response.status).toBe(200);
    expect(json.addedModelIds).toEqual(["remote-model-a", "remote-model-b"]);
    const config = JSON.parse(readFileSync(ws.paths.openclawPath, "utf8"));
    expect(config.models.providers.nvidia.models.map((m: { id: string }) => m.id)).toContain("remote-model-a");
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
    expect(JSON.stringify(json)).not.toContain("sk-");
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

  test("GET /api/settings/paths includes running-instance candidates when injected", async () => {
    const ws = workspace();
    const runningConfig = join(ws.dir, "running-openclaw.json");
    const runningEnv = join(ws.dir, "running.env");
    writeFileSync(runningConfig, "{}");
    writeFileSync(runningEnv, "RUNNING=1\n");
    const app = createTestApp(ws, undefined, {
      runningInstances: [{
        pid: 4242,
        openclawPath: runningConfig,
        envPath: runningEnv
      }]
    });

    const { response, json } = await jsonRequest(app, "/api/settings/paths");
    expect(response.status).toBe(200);
    expect((json.openclawPaths as Array<{ path: string; source: string }>).find((item) => item.path === runningConfig)).toMatchObject({
      source: "running-instance",
      recommended: true
    });
    expect((json.envPaths as Array<{ path: string; source: string }>).find((item) => item.path === runningEnv)).toMatchObject({
      source: "running-instance",
      recommended: true
    });
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
      requiresConfirmation: true
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
});
