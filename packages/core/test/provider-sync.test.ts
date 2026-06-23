import { describe, expect, test } from "bun:test";
import sample from "./fixtures/openclaw.sample.json";
import { applySyncedModels, syncProviderModels, type FetchImpl } from "../src/provider-sync";
import type { OpenClawConfig } from "../src/types";

const sampleConfig = sample as OpenClawConfig;

function mockFetch(models: string[]): FetchImpl {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    expect(url).toMatch(/\/models$/);
    return new Response(JSON.stringify({ data: models.map((id) => ({ id })) }), {
      headers: { "content-type": "application/json" }
    });
  };
}

describe("syncProviderModels", () => {
  test("sends bearer token resolved from provider apiKey env", async () => {
    const config = structuredClone(sampleConfig);
    const seen: { authorization?: string | null } = {};
    const fetchImpl: FetchImpl = async (_input, init) => {
      seen.authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: [{ id: "remote-model" }] }), {
        headers: { "content-type": "application/json" }
      });
    };

    await syncProviderModels(config, "nvidia", {
      fetchImpl,
      envContent: "NVIDIA_API_KEY=sync-secret\n"
    });

    expect(seen.authorization).toBe("Bearer sync-secret");
  });

  test("openai-completions normalizes baseUrl with trailing /v1", async () => {
    const config = structuredClone(sampleConfig);
    config.models!.providers!.nvidia!.baseUrl = "https://integrate.api.nvidia.com/v1";

    const result = await syncProviderModels(config, "nvidia", mockFetch(["deepseek-ai/deepseek-v4-flash", "new-model"]));
    expect(result.unsupportedReason).toBeUndefined();
    expect(result.addedModelIds).toEqual(["new-model"]);
    expect(result.skippedModelIds).toContain("deepseek-ai/deepseek-v4-flash");
  });

  test("openai-completions normalizes baseUrl without trailing /v1", async () => {
    const config = structuredClone(sampleConfig);
    config.models!.providers!.nvidia!.baseUrl = "https://integrate.api.nvidia.com";

    const fetchCalls: string[] = [];
    const fetchImpl: FetchImpl = async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify({ data: [{ id: "another-model" }] }), {
        headers: { "content-type": "application/json" }
      });
    };

    const result = await syncProviderModels(config, "nvidia", fetchImpl);
    expect(fetchCalls[0]).toBe("https://integrate.api.nvidia.com/v1/models");
    expect(result.addedModelIds).toEqual(["another-model"]);
  });

  test("only adds missing models and never deletes existing models", async () => {
    const config = structuredClone(sampleConfig);
    const beforeIds = config.models!.providers!.nvidia!.models!.map((m) => m.id);

    const result = await syncProviderModels(config, "nvidia", mockFetch([
      "deepseek-ai/deepseek-v4-flash",
      "z-ai/glm5.1",
      "brand-new"
    ]));

    const applied = applySyncedModels(config, "nvidia", result.addedModelIds);
    const afterIds = applied.models!.providers!.nvidia!.models!.map((m) => m.id);
    expect(afterIds).toEqual([...beforeIds, "brand-new"]);
    expect(result.addedModelIds).toEqual(["brand-new"]);
    // sync 只写入 provider.models，不自动加入 allowlist
    expect(applied.agents?.defaults?.models?.["nvidia/brand-new"]).toBeUndefined();
  });

  test("anthropic-messages returns unsupported without mutating config", async () => {
    const config = structuredClone(sampleConfig);
    const before = JSON.stringify(config);

    const result = await syncProviderModels(config, "minimax-portal");
    expect(result.unsupportedReason).toContain("anthropic-messages");
    expect(result.addedModelIds).toEqual([]);
    expect(JSON.stringify(config)).toBe(before);
  });

  test("google-generative-ai returns unsupported without mutating config", async () => {
    const config = structuredClone(sampleConfig);
    config.models!.providers!.gemini = {
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      apiKey: { source: "env", id: "GEMINI_API_KEY" },
      models: [{ id: "gemini-pro" }]
    };
    const before = JSON.stringify(config);

    const result = await syncProviderModels(config, "gemini");
    expect(result.unsupportedReason).toContain("google-generative-ai");
    expect(result.addedModelIds).toEqual([]);
    expect(JSON.stringify(config)).toBe(before);
  });
});
