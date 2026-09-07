#!/usr/bin/env bun
/** E2E 用 API 服务：临时 fixture + 固定 token */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackup } from "../packages/core/src/backup-manager";
import {
  MODELS_DEV_API_URL,
  MODELS_DEV_MODELS_URL,
  type FetchImpl,
  type RuntimeDiscoveryResult
} from "../packages/core/src";
import { createApp } from "../packages/server/src/app";
import apiFixture from "../packages/core/test/fixtures/model-metadata/api.json";
import modelsFixture from "../packages/core/test/fixtures/model-metadata/models.json";
import sample from "../packages/core/test/fixtures/openclaw.sample.json";

const TOKEN = "e2e-test-token";
const PORT = 7420;
const fixtureBuiltinDir = join(import.meta.dir, "../packages/core/test/fixtures/presets/builtin");

const dir = mkdtempSync(join(tmpdir(), "oc-switch-e2e-"));
const openclawPath = join(dir, "openclaw.json");
const envPath = join(dir, ".env");
const stateDir = join(dir, ".oc-switch");
writeFileSync(openclawPath, `${JSON.stringify(sample, null, 2)}\n`);
const customDir = join(stateDir, "presets", "custom");
mkdirSync(customDir, { recursive: true });
createBackup({ openclawPath, envPath, stateDir, reason: "e2e seed", beforeHash: "seed" });

/** E2E 禁止访问真实 Models.dev 或任何外部网络：固定 URL 返回本地 fixture，其余直接失败 */
const offlineFetch: FetchImpl = async (input) => {
  const url = String(input);
  if (url === MODELS_DEV_MODELS_URL) {
    return new Response(JSON.stringify(modelsFixture), { status: 200, headers: { etag: "e2e-models" } });
  }
  if (url === MODELS_DEV_API_URL) {
    return new Response(JSON.stringify(apiFixture), { status: 200, headers: { etag: "e2e-api" } });
  }
  throw new Error(`E2E must not access external network: ${url}`);
};

/** E2E 不做真实运行实例探测：固定返回“未检测到 Gateway”，保证写入快速且确定 */
const e2eDiscovery: RuntimeDiscoveryResult = {
  status: "gateway-not-detected",
  instances: [],
  candidateGroups: [],
  diagnostics: []
};

const app = createApp({
  token: TOKEN,
  paths: { openclawPath, envPath, stateDir },
  presetDirs: {
    builtinDir: fixtureBuiltinDir,
    customDir
  },
  fetchImpl: offlineFetch,
  runtimeDiscoveryProvider: () => e2eDiscovery,
  // E2E 不得 shell-out 到本机真实 openclaw：provider 列表会随开发机装了哪些插件漂移。
  // 注入固定插件目录，同时让 E2E 覆盖插件 provider 的只读展示路径。
  pluginCatalogProvider: () => ({
    providers: [{
      pluginId: "opencode",
      providerId: "opencode",
      origin: "npm-global",
      enabled: true,
      baseUrl: "https://opencode.ai/zen/v1",
      api: "openai-completions",
      models: [{ id: "big-pickle" }, { id: "hy3" }],
      apiKeyEnvVars: ["OPENCODE_API_KEY"]
    }],
    diagnostics: []
  })
});

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch
});

console.log(`E2E API listening on http://127.0.0.1:${PORT} token=${TOKEN}`);
