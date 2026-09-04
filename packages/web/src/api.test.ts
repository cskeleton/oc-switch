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
