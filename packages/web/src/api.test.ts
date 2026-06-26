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
        return new Response(JSON.stringify({ ok: true, providerCount: 0, providerModelCount: 0, allowlistModelCount: 0 }), {
          headers: { "content-type": "application/json" }
        });
      }
    });

    expect(await client.getStatus()).toEqual({
      ok: true,
      providerCount: 0,
      providerModelCount: 0,
      allowlistModelCount: 0
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
