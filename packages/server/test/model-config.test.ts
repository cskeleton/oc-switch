import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OcSwitchPaths, PluginCatalogResult, RuntimeModelSnapshot } from "@oc-switch/core";
import { createApp } from "../src/app";
import sample from "../../core/test/fixtures/openclaw.sample.json";

const dirs: string[] = [];
const catalog: PluginCatalogResult = {
  providers: [{ pluginId: "test-plugin", providerId: "test-provider", origin: "bundled", enabled: true,
    models: [{ id: "plugin-model", name: "Plugin model" }], apiKeyEnvVars: ["PLUGIN_API_KEY"] }],
  plugins: [{ id: "test-plugin", origin: "bundled", enabled: true, providerIds: ["test-provider"], nonModelCapabilities: ["speech"] }],
  diagnostics: []
};

function pathsFixture(): OcSwitchPaths {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-static-models-"));
  dirs.push(dir);
  const paths = { openclawPath: join(dir, "openclaw.json"), envPath: join(dir, ".env"), stateDir: join(dir, ".oc-switch") };
  writeFileSync(paths.openclawPath, JSON.stringify(sample));
  writeFileSync(paths.envPath, "NVIDIA_API_KEY=fixture-env-value\n");
  return paths;
}

function runtimeFixture(): RuntimeModelSnapshot {
  return { fallbackRefs: [], allowedRefs: [], configuredModels: [], allModels: [],
    completeness: { status: true, configuredList: true, allList: true }, diagnostics: [], capturedAt: new Date().toISOString() };
}

const auth = { Authorization: "Bearer test-token" };

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("separate static config and plugin extension reads", () => {
  test("static config returns before an active plugin probe and never probes runtime/discovery", async () => {
    let pluginCalls = 0;
    let runtimeCalls = 0;
    let release!: (catalog: PluginCatalogResult) => void;
    const pendingPlugin = new Promise<PluginCatalogResult>(resolve => { release = resolve; });
    const app = createApp({ token: "test-token", paths: pathsFixture(),
      pluginCatalogProvider: () => { pluginCalls += 1; return pendingPlugin; },
      runtimeModelCatalogProvider: () => { runtimeCalls += 1; throw new Error("static read must not probe runtime"); },
      runtimeDiscoveryProvider: () => { throw new Error("static read must not discover running instances"); }
    });
    const extensionRequest = app.request("/api/model-extensions", { headers: auth });
    await Promise.resolve();
    const response = await app.request("/api/model-config", { headers: auth });
    const json = await response.json();
    expect(response.status).toBe(200);
    expect(json.providers).toHaveLength(3);
    expect(json.providers.every((provider: { source: string }) => provider.source === "config")).toBe(true);
    expect(json.models.find((model: { isPrimary: boolean }) => model.isPrimary).ref).toBe("minimax-portal/MiniMax-M3");
    expect(json).not.toHaveProperty("plugins");
    expect(JSON.stringify(json)).not.toContain("fixture-env-value");
    expect(runtimeCalls).toBe(0);
    // 本地读没有为已经在途的插件请求增加任何调用，也没有等待它完成。
    expect(pluginCalls).toBe(1);
    release(catalog);
    expect((await extensionRequest).status).toBe(200);
  });

  test("extensions only probe plugins, and share the cache/inflight with complete inventory", async () => {
    let pluginCalls = 0;
    let runtimeCalls = 0;
    let release!: (catalog: PluginCatalogResult) => void;
    const pendingPlugin = new Promise<PluginCatalogResult>(resolve => { release = resolve; });
    const app = createApp({ token: "test-token", paths: pathsFixture(),
      pluginCatalogProvider: () => { pluginCalls += 1; return pendingPlugin; },
      runtimeModelCatalogProvider: () => { runtimeCalls += 1; return runtimeFixture(); },
      runtimeDiscoveryProvider: () => { throw new Error("must not discover running instances"); }
    });
    const extensionRequest = app.request("/api/model-extensions", { headers: auth });
    await Promise.resolve();
    expect(runtimeCalls).toBe(0);
    const inventoryRequest = app.request("/api/model-inventory", { headers: auth });
    await Promise.resolve();
    release(catalog);
    const [extensionResponse, inventoryResponse] = await Promise.all([extensionRequest, inventoryRequest]);
    expect(extensionResponse.status).toBe(200);
    expect(inventoryResponse.status).toBe(200);
    expect((await extensionResponse.json()).providers[0].providerId).toBe("test-provider");
    expect(pluginCalls).toBe(1);
    expect(runtimeCalls).toBe(1);
    await app.request("/api/model-extensions", { headers: auth });
    expect(pluginCalls).toBe(1);
  });

  test("static config initiates no probes and legacy endpoints still include plugin providers/models", async () => {
    let pluginCalls = 0;
    let runtimeCalls = 0;
    const app = createApp({ token: "test-token", paths: pathsFixture(),
      pluginCatalogProvider: () => { pluginCalls += 1; return catalog; },
      runtimeModelCatalogProvider: () => { runtimeCalls += 1; return runtimeFixture(); },
      runtimeDiscoveryProvider: () => { throw new Error("must not discover running instances"); }
    });
    expect((await app.request("/api/model-config", { headers: auth })).status).toBe(200);
    expect(pluginCalls).toBe(0);
    expect(runtimeCalls).toBe(0);
    const providers = await (await app.request("/api/providers", { headers: auth })).json();
    expect(providers.providers.find((provider: { id: string }) => provider.id === "test-provider").source).toBe("plugin");
    const models = await (await app.request("/api/models", { headers: auth })).json();
    expect(models.models.some((model: { ref: string }) => model.ref === "test-provider/plugin-model")).toBe(true);
    expect(pluginCalls).toBe(1);
    expect(runtimeCalls).toBe(0);
    expect((await app.request("/api/model-config")).status).toBe(401);
  });
});
