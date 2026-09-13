import { describe, expect, test } from "bun:test";
import { createApiClient } from "./api";
import type { ModelInventory } from "./api";

describe("createApiClient", () => {
  test("sends bearer token and parses JSON", async () => {
    const calls: Request[] = [];
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "secret",
      fetchImpl: async (input, init) => {
        calls.push(new Request(input, init));
        return new Response(JSON.stringify({
          ok: true,
          providerCount: 0,
          providerModelCount: 0,
          allowlistModelCount: 0,
          modelPolicyMode: "legacy",
          effectiveModelCount: 0
        }), {
          headers: { "content-type": "application/json" }
        });
      }
    });

    expect(await client.getStatus()).toEqual({
      ok: true,
      providerCount: 0,
      providerModelCount: 0,
      allowlistModelCount: 0,
      modelPolicyMode: "legacy",
      effectiveModelCount: 0
    });
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer secret");
  });

  test("model write methods use JSON request bodies", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "token",
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
    });

    await client.createModel("nvidia", { id: "vendor/model", enabled: true, alias: "vm" });
    await client.updateModel("nvidia/vendor/model", { id: "vendor/model-renamed", enabled: true });
    await client.deleteModel("nvidia/vendor/model-renamed", { newPrimary: "minimax-portal/MiniMax-M3" });

    expect(calls[0]?.url).toBe("http://localhost:7420/api/models");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      providerId: "nvidia",
      model: { id: "vendor/model", enabled: true, alias: "vm" }
    });
    expect(calls[1]?.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      ref: "nvidia/vendor/model",
      model: { id: "vendor/model-renamed", enabled: true }
    });
    expect(calls[2]?.init.method).toBe("DELETE");
    expect(JSON.parse(String(calls[2]?.init.body))).toEqual({
      ref: "nvidia/vendor/model-renamed",
      newPrimary: "minimax-portal/MiniMax-M3"
    });
  });

  test("keeps selectionSource from a real models response", async () => {
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "token",
      fetchImpl: async () => new Response(JSON.stringify({
        models: [{
          ref: "cpa/m2",
          providerId: "cpa",
          modelId: "m2",
          enabled: true,
          selectionSource: "policy-wildcard",
          isPrimary: false
        }]
      }), { status: 200 })
    });

    const { models } = await client.getModels();
    expect(models[0]?.selectionSource).toBe("policy-wildcard");
  });

  test("surfaces structured gateway restart failures from non-2xx responses", async () => {
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "token",
      fetchImpl: async () => new Response(JSON.stringify({
        ok: false,
        restart: {
          ok: false,
          exitCode: 1,
          message: "systemd service not found"
        }
      }), { status: 400 })
    });

    await expect(client.restartGateway()).rejects.toThrow("systemd service not found");
  });
});

test("health 与合并方法使用正确的方法与 JSON body", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createApiClient({
    baseUrl: "http://localhost:7420",
    token: "token",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ caseDuplicateGroups: [], summary: {} }), { status: 200 });
    }
  });

  await client.getHealth();
  await client.previewMergeCaseDuplicates({ groupKey: "deepseek", canonicalId: "deepseek", removeIds: ["DeepSeek"] });
  await client.mergeCaseDuplicates({ groupKey: "deepseek", canonicalId: "deepseek", removeIds: ["DeepSeek"] });

  expect(calls[0]!.url).toBe("http://localhost:7420/api/health");
  expect(calls[1]!.url).toBe("http://localhost:7420/api/providers/merge-case-duplicates/preview");
  expect(calls[1]!.init.method).toBe("POST");
  expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ groupKey: "deepseek", canonicalId: "deepseek", removeIds: ["DeepSeek"] });
  expect(calls[2]!.url).toBe("http://localhost:7420/api/providers/merge-case-duplicates");
  expect(calls[2]!.init.method).toBe("POST");
});

test("patchProviderState sends enabled flag to provider state route", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createApiClient({
    baseUrl: "http://localhost:7420",
    token: "test",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, providerId: "nvidia", enabled: false }), { status: 200 });
    }
  });

  await client.patchProviderState("nvidia", false);

  expect(calls[0]!.url).toBe("http://localhost:7420/api/providers/nvidia/state");
  expect(calls[0]!.init.method).toBe("PATCH");
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ enabled: false });
});

test("discover 与 batch-add/remove 使用正确路径与 JSON body", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createApiClient({
    baseUrl: "http://localhost:7420",
    token: "token",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
  });

  await client.discoverProvider("nvidia");
  await client.discoverProviderPreview({
    api: "openai-completions",
    baseUrl: "https://preview.example.com",
    apiKey: "preview-secret",
    isFullUrl: false,
    alreadyAddedIds: ["openai/gpt-4o"]
  });
  await client.syncProvider("nvidia");
  await client.batchAddProviderModels("nvidia", {
    models: [{ id: "openai/gpt-4o", name: "GPT-4o" }],
    enable: true
  });
  await client.batchRemoveProviderModels("nvidia", { modelIds: ["openai/gpt-4o"] });
  await client.batchRemoveProviderModels("nvidia", { keepEnabledOnly: true });

  expect(calls[0]!.url).toBe("http://localhost:7420/api/providers/nvidia/discover");
  expect(calls[0]!.init.method).toBe("POST");
  expect(calls[1]!.url).toBe("http://localhost:7420/api/providers/discover-preview");
  expect(calls[1]!.init.method).toBe("POST");
  expect(JSON.parse(String(calls[1]!.init.body))).toEqual({
    api: "openai-completions",
    baseUrl: "https://preview.example.com",
    apiKey: "preview-secret",
    isFullUrl: false,
    alreadyAddedIds: ["openai/gpt-4o"]
  });
  expect(calls[2]!.url).toBe("http://localhost:7420/api/providers/nvidia/discover");
  expect(calls[3]!.url).toBe("http://localhost:7420/api/providers/nvidia/models/batch-add");
  expect(JSON.parse(String(calls[3]!.init.body))).toEqual({
    models: [{ id: "openai/gpt-4o", name: "GPT-4o" }],
    enable: true
  });
  expect(calls[4]!.url).toBe("http://localhost:7420/api/providers/nvidia/models/batch-remove");
  expect(JSON.parse(String(calls[4]!.init.body))).toEqual({ modelIds: ["openai/gpt-4o"] });
  expect(JSON.parse(String(calls[5]!.init.body))).toEqual({ keepEnabledOnly: true });
});

test("getModelMetadataSuggestions 使用 URLSearchParams 编码斜杠/空格/大小写", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createApiClient({
    baseUrl: "http://localhost:7420",
    token: "token",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ suggestions: [], sources: [], warnings: [] }), { status: 200 });
    }
  });

  await client.getModelMetadataSuggestions("OpenRouter", "openai/gpt-5.2");
  await client.getModelMetadataSuggestions("custom proxy", "vendor/Model ID", { refresh: true });

  // 不得手拼 query string：斜杠必须被编码为 %2F
  expect(calls[0]!.url).toContain("modelId=openai%2Fgpt-5.2");
  const first = new URL(calls[0]!.url);
  expect(first.pathname).toBe("/api/model-metadata/suggestions");
  expect(first.searchParams.get("providerId")).toBe("OpenRouter");
  expect(first.searchParams.get("modelId")).toBe("openai/gpt-5.2");
  expect(first.searchParams.has("refresh")).toBe(false);

  const second = new URL(calls[1]!.url);
  expect(second.searchParams.get("providerId")).toBe("custom proxy");
  expect(second.searchParams.get("modelId")).toBe("vendor/Model ID");
  expect(second.searchParams.get("refresh")).toBe("1");
});

test("getConfigStatus 请求 /api/config-status 并携带 Bearer auth", async () => {
  const calls: Request[] = [];
  const client = createApiClient({
    baseUrl: "http://localhost:7420",
    token: "secret",
    fetchImpl: async (input, init) => {
      calls.push(new Request(input, init));
      return new Response(JSON.stringify({
        version: 1,
        health: { caseDuplicateGroups: [], summary: { duplicateGroupCount: 0, affectedProviderCount: 0, affectedAllowlistCount: 0 } },
        disabledProviders: [],
        orphanEnvKeys: [],
        envWarnings: [],
        issues: [],
        summary: { issueCount: 0, blockingIssueCount: 0, warningIssueCount: 0, duplicateGroupCount: 0, disabledProviderCount: 0, orphanEnvKeyCount: 0 }
      }), {
        headers: { "content-type": "application/json" }
      });
    }
  });

  const report = await client.getConfigStatus();
  expect(report.version).toBe(1);
  expect(calls[0]?.url).toBe("http://localhost:7420/api/config-status");
  expect(calls[0]?.headers.get("Authorization")).toBe("Bearer secret");
});

test("Provider SecretRef migration API uses explicit preview and confirmed write endpoints", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = createApiClient({
    baseUrl: "http://localhost:7420",
    token: "secret-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return new Response(JSON.stringify(
        init?.method === "POST"
          ? { ok: true, migratedProviderIds: ["nvidia"], gatewayRestartRequired: true }
          : { candidates: [], summary: { candidateCount: 0, readyCount: 0, blockedCount: 0 } }
      ));
    }
  });

  await client.getProviderSecretRefMigrations();
  await client.migrateProviderSecretRefs(["nvidia"]);

  expect(calls[0]?.url).toBe("http://localhost:7420/api/providers/secret-ref-migrations");
  expect(calls[0]?.init?.method).toBeUndefined();
  expect(calls[1]?.url).toBe("http://localhost:7420/api/providers/secret-ref-migrations");
  expect(calls[1]?.init?.method).toBe("POST");
  expect(calls[1]?.init?.body).toBe(JSON.stringify({ providerIds: ["nvidia"], confirm: true }));
});

test("syncProviderModelMetadata posts modelIds and parses report", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createApiClient({
    baseUrl: "http://localhost:7420",
    token: "test",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({
        ok: true, providerId: "openrouter",
        updated: [{ modelId: "openai/gpt-5.2", filled: { contextWindow: 400000 }, catalogKey: "openrouter/openai/gpt-5.2", matchKind: "provider-exact" }],
        queued: [{ modelId: "glm-4.6-air", candidateCount: 2 }],
        unmatched: [], skipped: [], sources: [], warnings: []
      }), { status: 200 });
    }
  });
  const result = await client.syncProviderModelMetadata("openrouter", { modelIds: ["openai/gpt-5.2"] });
  expect(calls[0]!.url).toBe("http://localhost:7420/api/providers/openrouter/models/sync-metadata");
  expect(calls[0]!.init.method).toBe("POST");
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ modelIds: ["openai/gpt-5.2"] });
  expect(result.updated[0]!.filled.contextWindow).toBe(400000);
});

test("getModelMetadataSyncQueue passes providerId query", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createApiClient({
    baseUrl: "http://localhost:7420",
    token: "test",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    }
  });
  await client.getModelMetadataSyncQueue("openrouter");
  expect(calls[0]!.url).toBe("http://localhost:7420/api/model-metadata/sync-queue?providerId=openrouter");
});

test("resolveModelMetadataSyncQueue posts resolve items", async () => {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const client = createApiClient({
    baseUrl: "http://localhost:7420",
    token: "test",
    fetchImpl: async (url, init = {}) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true, applied: [], dismissedCount: 1, failed: [] }), { status: 200 });
    }
  });
  await client.resolveModelMetadataSyncQueue([{ providerId: "zai", modelId: "glm-4.6-air", action: "dismiss" }]);
  expect(calls[0]!.url).toBe("http://localhost:7420/api/model-metadata/sync-queue/resolve");
  expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ items: [{ providerId: "zai", modelId: "glm-4.6-air", action: "dismiss" }] });
});

describe("插件 provider 字段透传", () => {
  test("getProviders 原样透传 source 字段", async () => {
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "token",
      fetchImpl: async () => new Response(JSON.stringify({
        providers: [
          {
            id: "nvidia",
            api: "openai-completions",
            baseUrl: "https://integrate.api.nvidia.com/v1",
            modelCount: 2,
            enabledModelCount: 2,
            containsPrimary: false,
            disabled: false,
            source: "config",
            apiKeyEnv: "NVIDIA_API_KEY",
            apiKeyEnvManaged: true,
            apiKeyEnvStatus: "managed"
          },
          {
            id: "opencode",
            api: "openai-completions",
            baseUrl: "https://opencode.ai/zen/v1",
            modelCount: 2,
            enabledModelCount: 0,
            containsPrimary: false,
            disabled: false,
            source: "plugin",
            apiKeyEnv: "OPENCODE_API_KEY",
            apiKeyEnvManaged: false,
            apiKeyEnvStatus: "missing"
          }
        ]
      }), { headers: { "content-type": "application/json" } })
    });

    const { providers } = await client.getProviders();
    expect(providers.map((provider) => provider.source)).toEqual(["config", "plugin"]);
  });
});

/** 最小但字段齐全的 ModelInventory fixture（与 core DTO 同名同值） */
function inventoryFixture(): ModelInventory {
  return {
    schemaVersion: 2,
    providers: [{
      providerId: "cpa",
      sources: ["config", "plugin-manifest"],
      pluginIds: ["cpa-plugin"],
      pluginEnabled: true,
      disabled: false,
      availability: "available",
      availabilityReasons: [],
      modelCount: 1,
      policyAllowedModelCount: 1,
      availableModelCount: 1,
      unavailableModelCount: 0,
      capabilities: {
        canEditConnection: true,
        canManageModels: true,
        canDisableProvider: true,
        canSetApiKey: true
      }
    }],
    models: [{
      ref: "cpa/m2", pickerVisible: true, inactive: false, needsAttention: false,
      providerId: "cpa",
      modelId: "m2",
      catalogSources: ["config"],
      referenceSources: ["policy-exact"],
      policyMode: "restricted",
      selectionSource: "policy-exact",
      policyAllowed: true,
      availability: "available",
      availabilityReasons: [],
      pluginIds: [],
      capabilities: {
        canTogglePolicy: true,
        canSetPrimary: true,
        canEditCatalogEntry: true,
        canMaterializeConfigModel: false,
        canRemovePolicyExactRef: true
      }
    }],
    plugins: [{
      id: "cpa-plugin",
      origin: "npm-global",
      enabled: true,
      providerIds: ["cpa"],
      nonModelCapabilities: []
    }],
    policyRules: [{
      value: "cpa/m2",
      kind: "exact",
      matchedModelCount: 1,
      unavailableModelCount: 0,
      removable: true
    }],
    diagnostics: [],
    summary: {
      modelCount: 1,
      policyAllowedCount: 1,
      availableCount: 1,
      unavailableCount: 0,
      unknownCount: 0
    }
  };
}

describe("runtime model inventory API client", () => {
  test("旧 inventory 协议不能恢复成逐模型假待办", async () => {
    const client = createApiClient({ baseUrl: "http://fixture", token: "fixture", fetchImpl: async () => new Response(JSON.stringify({ ...inventoryFixture(), schemaVersion: undefined })) });
    await expect(client.getModelInventory()).rejects.toThrow("版本不兼容");
  });
  test("getModelInventory GET /api/model-inventory 并携带 Bearer", async () => {
    const calls: Request[] = [];
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "inventory-token",
      fetchImpl: async (input, init) => {
        calls.push(new Request(input, init));
        return new Response(JSON.stringify(inventoryFixture()), {
          headers: { "content-type": "application/json" }
        });
      }
    });

    const inventory = await client.getModelInventory();

    expect(calls[0]?.url).toBe("http://localhost:7420/api/model-inventory");
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer inventory-token");
    // 响应整体是 inventory 本体（无包裹层），字段原样透传
    expect(inventory.summary.modelCount).toBe(1);
    expect(inventory.models[0]?.ref).toBe("cpa/m2");
    expect(inventory.models[0]?.capabilities.canTogglePolicy).toBe(true);
    expect(inventory.policyRules[0]?.kind).toBe("exact");
    expect(inventory.plugins[0]?.providerIds).toEqual(["cpa"]);
  });

  test("refreshModelInventory POST /api/model-inventory/refresh", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "token",
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify(inventoryFixture()), { status: 200 });
      }
    });

    const inventory = await client.refreshModelInventory();

    expect(calls[0]?.url).toBe("http://localhost:7420/api/model-inventory/refresh");
    expect(calls[0]?.init.method).toBe("POST");
    expect(inventory.summary.policyAllowedCount).toBe(1);
  });

  test("removeModelPolicyExactRef DELETE /api/model-policy/exact-ref 携带 JSON body 与 Bearer", async () => {
    const calls: Request[] = [];
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "policy-token",
      fetchImpl: async (input, init) => {
        calls.push(new Request(input, init));
        return new Response(JSON.stringify({
          ok: true,
          ref: "cpa/m2",
          backupId: "2026-09-09T00-00-00",
          warnings: []
        }), { status: 200 });
      }
    });

    const result = await client.removeModelPolicyExactRef("cpa/m2", true);

    expect(calls[0]?.url).toBe("http://localhost:7420/api/model-policy/exact-ref");
    expect(calls[0]?.method).toBe("DELETE");
    // 写方法与读方法共用 request helper，同样携带 Bearer
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer policy-token");
    expect(JSON.parse(await calls[0]!.clone().text())).toEqual({ ref: "cpa/m2", removeMetadata: true });
    expect(result.ok).toBe(true);
    expect(result.backupId).toBe("2026-09-09T00-00-00");
  });

  test("addModelPolicyRule POST /api/model-policy/rules 携带 rule 与 Bearer", async () => {
    const calls: Request[] = [];
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "policy-token",
      fetchImpl: async (input, init) => {
        calls.push(new Request(input, init));
        return new Response(JSON.stringify({
          ok: true,
          rule: "cpa/m4",
          kind: "exact",
          backupId: "2026-09-13T00-00-00",
          warnings: ["已被通配 cpa/* 覆盖，该精确规则当前冗余"],
          runtimeConfirmed: true,
          diagnostics: [],
          inventory: {}
        }), { status: 200 });
      }
    });

    const result = await client.addModelPolicyRule("cpa/m4");

    expect(calls[0]?.url).toBe("http://localhost:7420/api/model-policy/rules");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("Authorization")).toBe("Bearer policy-token");
    expect(JSON.parse(await calls[0]!.clone().text())).toEqual({ rule: "cpa/m4" });
    expect(result.ok).toBe(true);
    expect(result.kind).toBe("exact");
    expect(result.backupId).toBe("2026-09-13T00-00-00");
    expect(result.warnings).toEqual(["已被通配 cpa/* 覆盖，该精确规则当前冗余"]);
    expect(result.runtimeConfirmed).toBe(true);
  });

  test("removeModelPolicyWildcard DELETE /api/model-policy/wildcard 携带 value", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "token",
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          ok: true,
          value: "cpa/*",
          removedCount: 2,
          backupId: "2026-09-13T00-00-01",
          warnings: ["已移除 2 条相同规则"],
          runtimeConfirmed: false,
          diagnostics: [{ command: "list", code: "timeout", message: "openclaw models list timed out" }],
          inventory: {}
        }), { status: 200 });
      }
    });

    const result = await client.removeModelPolicyWildcard("cpa/*");

    expect(calls[0]!.url).toBe("http://localhost:7420/api/model-policy/wildcard");
    expect(calls[0]!.init.method).toBe("DELETE");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ value: "cpa/*" });
    expect(result.ok).toBe(true);
    expect(result.removedCount).toBe(2);
    // runtimeConfirmed:false 不是 HTTP 失败：200 + ok:true 正常返回
    expect(result.runtimeConfirmed).toBe(false);
    expect(result.diagnostics?.[0]?.code).toBe("timeout");
  });

  test("policy 规则编辑端点的 400 透传 error 信息", async () => {
    const errors = [
      "Rule must be a non-empty string in provider/model or provider/* form (invalid-rule-format).",
      "Removing cpa/* would leave policy empty and switch it to unrestricted (last-rule-removal)."
    ];
    let call = 0;
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: errors[call], code: ["invalid-rule-format", "last-rule-removal"][call++] }), { status: 400 })
    });

    await expect(client.addModelPolicyRule("")).rejects.toThrow(errors[0]);
    await expect(client.removeModelPolicyWildcard("cpa/*")).rejects.toThrow(errors[1]);
  });

  test("materializeRuntimeModel POST /api/models/materialize 携带 ref 与 input", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "token",
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          ok: true,
          ref: "cpa/m3",
          backupId: "2026-09-09T00-00-01",
          warnings: []
        }), { status: 200 });
      }
    });

    const result = await client.materializeRuntimeModel("cpa/m3", { id: "m3", enabled: true });

    expect(calls[0]?.url).toBe("http://localhost:7420/api/models/materialize");
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      ref: "cpa/m3",
      input: { id: "m3", enabled: true }
    });
    expect(result.ok).toBe(true);
    expect(result.backupId).toBe("2026-09-09T00-00-01");
  });

  test("setPluginState PATCH /api/plugins/:pluginId/state 携带 confirm", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "token",
      fetchImpl: async (url, init = {}) => {
        calls.push({ url: String(url), init });
        return new Response(JSON.stringify({
          ok: true,
          pluginId: "xiaomi-miot",
          enabled: false,
          backupId: "2026-09-09T00-00-02",
          affectedProviderIds: ["xiaomi-speech", "xiaomi-contract"],
          warnings: [],
          runtimeConfirmed: true
        }), { status: 200 });
      }
    });

    const result = await client.setPluginState("xiaomi-miot", false);

    expect(calls[0]?.url).toBe("http://localhost:7420/api/plugins/xiaomi-miot/state");
    expect(calls[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ enabled: false, confirm: true });
    expect(result.pluginId).toBe("xiaomi-miot");
    expect(result.affectedProviderIds).toEqual(["xiaomi-speech", "xiaomi-contract"]);
    expect(result.runtimeConfirmed).toBe(true);
  });

  test("插件 ID 作为单个 URL path segment 编码，不把 manifest 内容当作路径", async () => {
    let calledUrl = "";
    const client = createApiClient({
      baseUrl: "http://fixture.invalid", token: "fixture-token",
      fetchImpl: async input => {
        calledUrl = String(input);
        return new Response(JSON.stringify({ ok: true, runtimeConfirmed: false }), { status: 200 });
      }
    });
    await client.setPluginState("scope/plugin ?#", false);
    expect(calledUrl).toBe("http://fixture.invalid/api/plugins/scope%2Fplugin%20%3F%23/state");
  });

  test("runtimeConfirmed:false 不是 HTTP 失败：200 + ok:true 正常返回", async () => {
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "token",
      fetchImpl: async () => new Response(JSON.stringify({
        ok: true,
        pluginId: "xiaomi-miot",
        enabled: false,
        backupId: "backup-id",
        affectedProviderIds: ["xiaomi-speech"],
        warnings: ["plugin runtime probe incomplete"],
        runtimeConfirmed: false,
        diagnostics: [{ command: "list", code: "timeout", message: "openclaw models list timed out after 8000ms" }]
      }), { status: 200 })
    });

    // 写入已成功：client 不得把确认失败当成请求失败抛错
    const result = await client.setPluginState("xiaomi-miot", false);
    expect(result.ok).toBe(true);
    expect(result.runtimeConfirmed).toBe(false);
    expect(result.diagnostics?.[0]?.code).toBe("timeout");
  });

  test("getModelInventory 与 refreshModelInventory 的非 2xx 响应透传 error", async () => {
    // 按调用次序返回不同 error，逐个读方法验证 error propagation
    const errors = [
      "openclaw.json not readable: permission denied",
      "runtime model catalog probe failed: openclaw CLI missing"
    ];
    let call = 0;
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "token",
      fetchImpl: async (url, init = {}) => {
        const error = errors[call++] ?? errors[0];
        return new Response(JSON.stringify({ error }), { status: 500 });
      }
    });

    await expect(client.getModelInventory()).rejects.toThrow(errors[0]);
    await expect(client.refreshModelInventory()).rejects.toThrow(errors[1]);
  });

  test("非 2xx 响应透传 error 信息", async () => {
    // 按调用次序返回不同 error，逐个方法验证 error propagation
    const errors = [
      "Model cpa/missing not found in current inventory; nothing to materialize.",
      "Ref cpa/protected is the current primary model; replace it first.",
      "Plugin ghost-plugin is not installed or does not contribute any model provider; oc-switch only manages installed model plugins."
    ];
    let call = 0;
    const client = createApiClient({
      baseUrl: "http://localhost:7420",
      token: "token",
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: errors[call++] }), { status: call === 2 ? 400 : 404 })
    });

    await expect(client.materializeRuntimeModel("cpa/missing", { id: "missing", enabled: true }))
      .rejects.toThrow(errors[0]);
    await expect(client.removeModelPolicyExactRef("cpa/protected", false))
      .rejects.toThrow(errors[1]);
    await expect(client.setPluginState("ghost-plugin", true))
      .rejects.toThrow(errors[2]);
  });
});
