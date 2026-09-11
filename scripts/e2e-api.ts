#!/usr/bin/env bun
/** E2E 用 API 服务：临时 fixture + 固定 token + 假 OpenClaw 运行时探测 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";
import { createBackup } from "../packages/core/src/backup-manager";
import {
  MODELS_DEV_API_URL,
  MODELS_DEV_MODELS_URL,
  normalizeModelRefForIdentity,
  readFallbackModelRefs,
  readPrimaryModelRef,
  type FetchImpl,
  type RuntimeDiscoveryResult,
  type RuntimeModelSnapshot
} from "../packages/core/src";
import { isPolicyAllowsRef, readModelPolicyAllow } from "../packages/core/src/model-policy";
import { createApp } from "../packages/server/src/app";
import apiFixture from "../packages/core/test/fixtures/model-metadata/api.json";
import modelsFixture from "../packages/core/test/fixtures/model-metadata/models.json";
import sample from "../packages/core/test/fixtures/openclaw.sample.json";
import type { OpenClawConfig } from "../packages/core/src/types";

const TOKEN = "e2e-test-token";
// 默认隔离端口，避免与用户常驻的 oc-switch serve 7420 冲突。
const PORT = Number(process.env.E2E_API_PORT ?? "17420");
const fixtureBuiltinDir = join(import.meta.dir, "../packages/core/test/fixtures/presets/builtin");

const dir = mkdtempSync(join(tmpdir(), "oc-switch-e2e-"));
const openclawPath = join(dir, "openclaw.json");
const envPath = join(dir, ".env");
const stateDir = join(dir, ".oc-switch");
// 路径候选等旧入口仍会读取进程环境；fixture 必须隔离整个 HOME，而不只是 createApp.paths。
process.env.HOME = dir;
process.env.OPENCLAW_HOME = dir;
process.env.OPENCLAW_STATE_DIR = dir;
process.env.OPENCLAW_CONFIG_PATH = openclawPath;
// restricted policy + 悬空 exact + wildcard + xiaomi 插件双 Provider（Task 9 Step 8 浏览器实测 fixture）。
// 另加 `metadata-e2e` Provider：专供 webgui.e2e 的模型参数 round-trip 用例——
// 该用例要「添加→编辑→删除」模型，而 restricted 模式下被 wildcard 覆盖的
// Provider（nvidia/*）删除会 fail closed（spec 语义），故测试目标必须落在
// 不被任何 wildcard 覆盖的 Provider 上。
const e2eConfig = structuredClone(sample) as OpenClawConfig;
e2eConfig.models!.providers!["metadata-e2e"] = {
  baseUrl: "https://metadata-e2e.example/v1",
  api: "openai-completions",
  models: [{ id: "seed-model" }]
};
e2eConfig.agents!.defaults!.modelPolicy = {
  allow: [
    "nvidia/*",
    "minimax-portal/MiniMax-M3",
    "DeepSeek/deepseek-chat",
    "ghost-provider/policy-only-model",
    "xiaomi/mi-1"
  ]
};
writeFileSync(openclawPath, `${JSON.stringify(e2eConfig, null, 2)}\n`);
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

/**
 * 假 OpenClaw 运行时 snapshot（Task 9 Step 8）：覆盖统一 inventory 的关键场景——
 * policy-only 悬空（unavailable）、runtime-only available、wildcard 展开与 xiaomi
 * 插件模型。status 内嵌假密钥（authToken），core 白名单提取必须丢弃，页面 DOM 不得出现。
 *
 * 目录条目动态合成：真实 OpenClaw 的 `models list` 会展开当前 `openclaw.json`
 * （config ∪ 插件 manifest），因此 fixture 每次探测都从**当前**配置文件合成
 * configuredModels——写入端点（添加/删除模型、插件启停）后 inventory 的
 * 重新探测才能像真机一样反映新状态，否则静态 snapshot 会把新添加的模型
 * 误判为「模型不在目录中」。
 */
function buildE2eRuntimeSnapshot(): RuntimeModelSnapshot {
  const config = JSON5.parse(readFileSync(openclawPath, "utf8")) as OpenClawConfig;
  // config 目录条目：全部 available（与真机一致：本机 config provider 正常可用）
  const configEntries = Object.entries(config.models?.providers ?? {}).flatMap(([providerId, provider]) =>
    (provider.models ?? []).map((model) => ({
      ref: `${providerId}/${model.id}`,
      available: true,
      tags: []
    }))
  );
  // xiaomi 插件 manifest 条目（插件 catalog 由 plugins list 提供，这里只补运行时侧）
  const xiaomiEnabled = config.plugins?.entries?.xiaomi?.enabled !== false;
  const opencodeEnabled = config.plugins?.entries?.opencode?.enabled !== false;
  const pluginEntries = [
    ...["xiaomi/mi-1", "xiaomi/mi-2", "xiaomi-token-plan/tp-1", "xiaomi-token-plan/tp-2"]
      .map(ref => ({ ref, ...(xiaomiEnabled ? { available: true } : {}), tags: [] })),
    ...["opencode/big-pickle", "opencode/hy3"]
      .map(ref => ({ ref, ...(opencodeEnabled ? { available: true } : {}), tags: [] }))
  ];
  const primary = readPrimaryModelRef(config);
  const fallbacks = readFallbackModelRefs(config);
  const policy = readModelPolicyAllow(config);
  const metadataRefs = Object.keys(config.agents?.defaults?.models ?? {});
  const references = new Set([
    ...(policy ?? []).filter(ref => !ref.endsWith("/*")),
    ...metadataRefs, ...(primary ? [primary] : []), ...fallbacks
  ]);
  const allModels = [
    ...configEntries, ...pluginEntries,
    { ref: "nvidia/vendor/runtime-extra", available: true, tags: [] }
  ];
  const catalogRefs = new Set(allModels.map(entry => normalizeModelRefForIdentity(entry.ref)));
  const configuredModels = [
    ...configEntries,
    ...pluginEntries.filter(entry => entry.available === true),
    // 仅仍被引用的缺失模型才生成占位；删除引用后不能继续回放假目录行。
    ...[...references].filter(ref => !catalogRefs.has(normalizeModelRefForIdentity(ref)))
      .map(ref => ({ ref, available: false, missing: true, tags: ["missing"] }))
  ];
  const allowedRefs = policy === undefined ? metadataRefs
    : policy.length === 0 ? allModels.map(entry => entry.ref)
      : [...policy.filter(ref => !ref.endsWith("/*")), ...allModels.filter(entry => isPolicyAllowsRef(policy, entry.ref)).map(entry => entry.ref)];
  return {
    openClawVersion: "2026.9.3",
    ...(primary ? { defaultModel: primary } : {}),
    fallbackRefs: fallbacks,
    allowedRefs: [...new Set(allowedRefs)],
    configuredModels,
    allModels,
    completeness: { status: true, configuredList: true, allList: true },
    diagnostics: [],
    capturedAt: new Date().toISOString(),
    // 故意塞入假密钥字段：探测归一层必须丢弃，页面不得回显
    ...( { authToken: "e2e-fixture-secret-NEVER-LEAK" } as Record<string, unknown>)
  };
}

const app = createApp({
  token: TOKEN,
  port: PORT,
  paths: { openclawPath, envPath, stateDir },
  presetDirs: {
    builtinDir: fixtureBuiltinDir,
    customDir
  },
  fetchImpl: offlineFetch,
  runtimeDiscoveryProvider: () => e2eDiscovery,
  // E2E 不得 shell-out 到本机真实 openclaw：provider 列表会随开发机装了哪些插件漂移。
  // 注入固定插件目录（xiaomi 一个插件贡献两个 Provider + speech 能力），
  // 同时覆盖插件 provider 的只读展示与插件分组路径。
  pluginCatalogProvider: () => {
    const config = JSON5.parse(readFileSync(openclawPath, "utf8")) as OpenClawConfig;
    const enabled = (pluginId: string) => config.plugins?.entries?.[pluginId]?.enabled !== false;
    return {
    providers: [{
      pluginId: "opencode",
      providerId: "opencode",
      origin: "npm-global",
      enabled: enabled("opencode"),
      baseUrl: "https://opencode.ai/zen/v1",
      api: "openai-completions",
      models: [{ id: "big-pickle" }, { id: "hy3" }],
      apiKeyEnvVars: ["OPENCODE_API_KEY"]
    }, {
      pluginId: "xiaomi",
      providerId: "xiaomi",
      origin: "npm-global",
      enabled: enabled("xiaomi"),
      baseUrl: "https://xiaomi.example/v1",
      api: "openai-completions",
      models: [{ id: "mi-1" }, { id: "mi-2" }],
      apiKeyEnvVars: ["XIAOMI_API_KEY"]
    }, {
      pluginId: "xiaomi",
      providerId: "xiaomi-token-plan",
      origin: "npm-global",
      enabled: enabled("xiaomi"),
      baseUrl: "https://xiaomi.example/plan/v1",
      api: "openai-completions",
      models: [{ id: "tp-1" }, { id: "tp-2" }],
      apiKeyEnvVars: ["XIAOMI_TOKEN_PLAN_API_KEY"]
    }],
    plugins: [{
      id: "opencode",
      origin: "npm-global",
      enabled: enabled("opencode"),
      providerIds: ["opencode"],
      nonModelCapabilities: []
    }, {
      id: "xiaomi",
      origin: "npm-global",
      enabled: enabled("xiaomi"),
      providerIds: ["xiaomi", "xiaomi-token-plan"],
      nonModelCapabilities: ["speech"]
    }],
    diagnostics: []
    };
  },
  // 假 OpenClaw 运行时模型 snapshot（每次探测从当前配置合成，见上），不 shell-out 真实 openclaw
  runtimeModelCatalogProvider: () => buildE2eRuntimeSnapshot()
});

Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  fetch: app.fetch
});

console.log(`E2E API listening on http://127.0.0.1:${PORT} token=${TOKEN}`);
