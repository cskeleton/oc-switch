import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "../../core/test/fixtures/openclaw.sample.json";
import { createApp } from "../src/app";
import type { FetchImpl, OcSwitchPaths, PresetDirs } from "@oc-switch/core";

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

function createTestApp(ws: Workspace, fetchImpl?: FetchImpl) {
  return createApp({
    token: TOKEN,
    paths: ws.paths,
    presetDirs: ws.presetDirs,
    repoRoot,
    ...(fetchImpl ? { fetchImpl } : {})
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
});
