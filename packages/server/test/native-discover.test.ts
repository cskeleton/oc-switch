import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test("原生openai发现接入运行时目录，无API Key和外部HTTP请求", async () => {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-native-discover-")); dirs.push(dir);
  const openclawPath = join(dir, "openclaw.json");
  writeFileSync(openclawPath, JSON.stringify({ models: { providers: { openai: { models: [] } } } }));
  let probes = 0;
  const app = createApp({ token: "fixture-token", paths: { openclawPath, envPath: join(dir, ".env"), stateDir: join(dir, "state") },
    runtimeDiscoveryProvider: () => ({ status: "gateway-not-detected", instances: [], candidateGroups: [], diagnostics: [] }),
    pluginCatalogProvider: () => ({ providers: [], plugins: [], diagnostics: [] }),
    fetchImpl: async () => { throw new Error("must not send HTTP request or OAuth token"); },
    runtimeModelCatalogProvider: () => { probes += 1; return { configuredModels: [], allModels: [{ ref: "openai/fixture-model", tags: [] }], fallbackRefs: [], allowedRefs: [], capturedAt: "fixture", completeness: { status: false, configuredList: false, allList: true }, diagnostics: [] }; }
  });
  const response = await app.request("/api/providers/openai/discover", { method: "POST", headers: { Authorization: "Bearer fixture-token" } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true, providerId: "openai", remoteModels: [{ id: "fixture-model" }], alreadyAddedIds: [], truncated: false, catalogSource: "openclaw-runtime" });
  expect(probes).toBe(1);
});
