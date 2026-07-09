import { describe, expect, test } from "bun:test";
import sample from "./fixtures/openclaw.sample.json";
import {
  DISCOVER_MAX_MODELS,
  DISCOVER_MAX_PAGES,
  discoverProviderModels,
  discoverProviderModelsFromCredentials,
  syncProviderModels,
  type FetchImpl
} from "../src/provider-sync";
import type { OpenClawConfig } from "../src/types";

const sampleConfig = sample as OpenClawConfig;

type MockModel = string | { id: string; name?: string };

function mockFetch(models: MockModel[]): FetchImpl {
  return async (input: RequestInfo | URL) => {
    const url = String(input);
    expect(url).toMatch(/\/models$/);
    return new Response(
      JSON.stringify({
        data: models.map((entry) => (typeof entry === "string" ? { id: entry } : entry))
      }),
      { headers: { "content-type": "application/json" } }
    );
  };
}

describe("discoverProviderModels", () => {
  test("sends bearer token resolved from provider apiKey env", async () => {
    const config = structuredClone(sampleConfig);
    const seen: { authorization?: string | null } = {};
    const fetchImpl: FetchImpl = async (_input, init) => {
      seen.authorization = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ data: [{ id: "remote-model" }] }), {
        headers: { "content-type": "application/json" }
      });
    };

    await discoverProviderModels(config, "nvidia", {
      fetchImpl,
      envContent: "NVIDIA_API_KEY=sync-secret\n"
    });

    expect(seen.authorization).toBe("Bearer sync-secret");
  });

  test("openai-completions normalizes baseUrl with trailing /v1", async () => {
    const config = structuredClone(sampleConfig);
    config.models!.providers!.nvidia!.baseUrl = "https://integrate.api.nvidia.com/v1";

    const result = await discoverProviderModels(
      config,
      "nvidia",
      mockFetch(["deepseek-ai/deepseek-v4-flash", "new-model"])
    );
    expect(result.unsupportedReason).toBeUndefined();
    expect(result.remoteModels.map((m) => m.id)).toEqual([
      "deepseek-ai/deepseek-v4-flash",
      "new-model"
    ]);
    expect(result.alreadyAddedIds).toContain("deepseek-ai/deepseek-v4-flash");
    expect(result.alreadyAddedIds).not.toContain("new-model");
    expect(result.truncated).toBe(false);
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

    const result = await discoverProviderModels(config, "nvidia", fetchImpl);
    expect(fetchCalls[0]).toBe("https://integrate.api.nvidia.com/v1/models");
    expect(result.remoteModels).toEqual([{ id: "another-model" }]);
    expect(result.alreadyAddedIds).toEqual([]);
  });

  test("parses optional name from remote payload", async () => {
    const config = structuredClone(sampleConfig);
    const result = await discoverProviderModels(config, "nvidia", mockFetch([
      { id: "vendor/model-a", name: "Vendor Model A" },
      "vendor/model-b"
    ]));
    expect(result.remoteModels).toEqual([
      { id: "vendor/model-a", name: "Vendor Model A" },
      { id: "vendor/model-b" }
    ]);
  });

  test("does not mutate config", async () => {
    const config = structuredClone(sampleConfig);
    const before = JSON.stringify(config);

    await discoverProviderModels(config, "nvidia", mockFetch([
      "deepseek-ai/deepseek-v4-flash",
      "z-ai/glm5.1",
      "brand-new"
    ]));

    expect(JSON.stringify(config)).toBe(before);
  });

  test("returns alreadyAddedIds as intersection with local provider.models", async () => {
    const config = structuredClone(sampleConfig);
    const result = await discoverProviderModels(config, "nvidia", mockFetch([
      "deepseek-ai/deepseek-v4-flash",
      "z-ai/glm5.1",
      "brand-new"
    ]));
    expect(result.alreadyAddedIds.sort()).toEqual(
      ["deepseek-ai/deepseek-v4-flash", "z-ai/glm5.1"].sort()
    );
    expect(result.remoteModels.map((m) => m.id)).toHaveLength(3);
  });

  test("truncates when remote list exceeds DISCOVER_MAX_MODELS", async () => {
    const config = structuredClone(sampleConfig);
    const ids = Array.from({ length: DISCOVER_MAX_MODELS + 3 }, (_, i) => `model-${i}`);
    const result = await discoverProviderModels(config, "nvidia", mockFetch(ids));

    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toContain(String(DISCOVER_MAX_MODELS));
    expect(result.remoteModels).toHaveLength(DISCOVER_MAX_MODELS);
    expect(result.remoteModels[0]?.id).toBe("model-0");
    expect(result.remoteModels.at(-1)?.id).toBe(`model-${DISCOVER_MAX_MODELS - 1}`);
  });

  test("anthropic-messages paginates with x-api-key and display_name", async () => {
    const config = structuredClone(sampleConfig);
    const fetchCalls: Array<{ url: string; headers: Headers }> = [];
    let page = 0;

    const fetchImpl: FetchImpl = async (input, init) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      fetchCalls.push({ url, headers });
      page += 1;

      if (page === 1) {
        expect(headers.get("x-api-key")).toBe("minimax-secret");
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
        expect(headers.get("authorization")).toBeNull();
        expect(url).toBe("https://api.minimax.io/anthropic/v1/models");
        return new Response(
          JSON.stringify({
            data: [
              { id: "MiniMax-M3", display_name: "MiniMax M3" },
              { id: "MiniMax-M2", display_name: "MiniMax M2" }
            ],
            has_more: true,
            last_id: "MiniMax-M2"
          }),
          { headers: { "content-type": "application/json" } }
        );
      }

      expect(url).toBe("https://api.minimax.io/anthropic/v1/models?after_id=MiniMax-M2");
      return new Response(
        JSON.stringify({
          data: [{ id: "MiniMax-M1", display_name: "MiniMax M1" }],
          has_more: false,
          last_id: "MiniMax-M1"
        }),
        { headers: { "content-type": "application/json" } }
      );
    };

    const result = await discoverProviderModels(config, "minimax-portal", {
      fetchImpl,
      envContent: "MINIMAX_API_KEY=minimax-secret\n"
    });

    expect(page).toBe(2);
    expect(result.unsupportedReason).toBeUndefined();
    expect(result.remoteModels).toEqual([
      { id: "MiniMax-M3", name: "MiniMax M3" },
      { id: "MiniMax-M2", name: "MiniMax M2" },
      { id: "MiniMax-M1", name: "MiniMax M1" }
    ]);
    expect(result.alreadyAddedIds).toEqual(["MiniMax-M3"]);
    expect(result.truncated).toBe(false);
  });

  test("anthropic-messages truncates when page cap exceeded", async () => {
    const config = structuredClone(sampleConfig);
    let page = 0;

    const fetchImpl: FetchImpl = async (input) => {
      page += 1;
      const url = String(input);
      if (page > 1) {
        expect(url).toContain(`after_id=model-${page - 2}`);
      }
      return new Response(
        JSON.stringify({
          data: [{ id: `model-${page - 1}`, display_name: `Model ${page - 1}` }],
          has_more: true,
          last_id: `model-${page - 1}`
        }),
        { headers: { "content-type": "application/json" } }
      );
    };

    const result = await discoverProviderModels(config, "minimax-portal", {
      fetchImpl,
      envContent: "MINIMAX_API_KEY=minimax-secret\n"
    });

    expect(page).toBe(DISCOVER_MAX_PAGES);
    expect(result.truncated).toBe(true);
    expect(result.truncationReason).toContain(String(DISCOVER_MAX_PAGES));
    expect(result.remoteModels).toHaveLength(DISCOVER_MAX_PAGES);
    expect(result.remoteModels[0]?.id).toBe("model-0");
    expect(result.remoteModels.at(-1)?.id).toBe(`model-${DISCOVER_MAX_PAGES - 1}`);
  });

  test("anthropic-messages discovers models without mutating config", async () => {
    const config = structuredClone(sampleConfig);
    const before = JSON.stringify(config);

    const result = await discoverProviderModels(config, "minimax-portal", {
      envContent: "MINIMAX_API_KEY=minimax-secret\n",
      fetchImpl: async (_input, init) => {
        expect(new Headers(init?.headers).get("x-api-key")).toBe("minimax-secret");
        return new Response(
          JSON.stringify({
            data: [{ id: "MiniMax-M3", display_name: "MiniMax M3" }],
            has_more: false,
            last_id: "MiniMax-M3"
          }),
          { headers: { "content-type": "application/json" } }
        );
      }
    });

    expect(result.unsupportedReason).toBeUndefined();
    expect(result.remoteModels).toEqual([{ id: "MiniMax-M3", name: "MiniMax M3" }]);
    expect(result.alreadyAddedIds).toEqual(["MiniMax-M3"]);
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

    const result = await discoverProviderModels(config, "gemini");
    expect(result.unsupportedReason).toContain("google-generative-ai");
    expect(result.remoteModels).toEqual([]);
    expect(JSON.stringify(config)).toBe(before);
  });

  test("discover uses legacy env string for auth headers", async () => {
    const config = structuredClone(sampleConfig);
    config.models!.providers!.nvidia!.apiKey = "${NVIDIA_API_KEY}";
    const result = await discoverProviderModels(config, "nvidia", {
      envContent: "NVIDIA_API_KEY=secret\n",
      fetchImpl: async (_url, init) => {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer secret");
        return Response.json({ data: [] });
      }
    });
    expect(result.remoteModels).toEqual([]);
    expect(result.alreadyAddedIds).toEqual([]);
  });
});

describe("syncProviderModels alias", () => {
  test("is discoverProviderModels", () => {
    expect(syncProviderModels).toBe(discoverProviderModels);
  });
});

describe("discoverProviderModelsFromCredentials", () => {
  test("uses provided openai credentials and preserves alreadyAddedIds intersection", async () => {
    const seen: { authorization?: string | null; url?: string } = {};
    const fetchImpl: FetchImpl = async (input, init) => {
      seen.url = String(input);
      seen.authorization = new Headers(init?.headers).get("authorization");
      return new Response(
        JSON.stringify({
          data: [{ id: "model-a", name: "Model A" }, { id: "model-b" }]
        }),
        { headers: { "content-type": "application/json" } }
      );
    };

    const result = await discoverProviderModelsFromCredentials(
      {
        providerId: "preview-provider",
        api: "openai-completions",
        baseUrl: "https://preview.example.com",
        apiKey: "preview-secret",
        alreadyAddedIds: ["model-b", "model-c"]
      },
      { fetchImpl }
    );

    expect(seen.url).toBe("https://preview.example.com/v1/models");
    expect(seen.authorization).toBe("Bearer preview-secret");
    expect(result.providerId).toBe("preview-provider");
    expect(result.remoteModels).toEqual([{ id: "model-a", name: "Model A" }, { id: "model-b" }]);
    expect(result.alreadyAddedIds).toEqual(["model-b"]);
    expect(result.truncated).toBe(false);
  });

  test("uses raw baseUrl when isFullUrl is true", async () => {
    const seen: { url?: string } = {};
    const result = await discoverProviderModelsFromCredentials(
      {
        providerId: "preview-provider",
        api: "openai-completions",
        baseUrl: "https://preview.example.com/custom-prefix",
        apiKey: "preview-secret",
        isFullUrl: true
      },
      {
        fetchImpl: async (input) => {
          seen.url = String(input);
          return new Response(
            JSON.stringify({
              data: [{ id: "model-a" }]
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
      }
    );

    expect(seen.url).toBe("https://preview.example.com/custom-prefix/models");
    expect(result.remoteModels).toEqual([{ id: "model-a" }]);
  });

  test("supports anthropic credentials discover with x-api-key header", async () => {
    const seen: { apiKey?: string | null; version?: string | null; auth?: string | null } = {};
    const result = await discoverProviderModelsFromCredentials(
      {
        api: "anthropic-messages",
        baseUrl: "https://anthropic.preview.example",
        apiKey: "anthropic-secret"
      },
      {
        fetchImpl: async (_input, init) => {
          const headers = new Headers(init?.headers);
          seen.apiKey = headers.get("x-api-key");
          seen.version = headers.get("anthropic-version");
          seen.auth = headers.get("authorization");
          return new Response(
            JSON.stringify({
              data: [{ id: "claude-sonnet", display_name: "Claude Sonnet" }],
              has_more: false
            }),
            { headers: { "content-type": "application/json" } }
          );
        }
      }
    );
    expect(seen.apiKey).toBe("anthropic-secret");
    expect(seen.version).toBe("2023-06-01");
    expect(seen.auth).toBeNull();
    expect(result.remoteModels).toEqual([{ id: "claude-sonnet", name: "Claude Sonnet" }]);
  });

  test("returns unsupported for google-generative-ai", async () => {
    const result = await discoverProviderModelsFromCredentials({
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com",
      apiKey: "google-secret"
    });
    expect(result.unsupportedReason).toContain("google-generative-ai");
    expect(result.remoteModels).toEqual([]);
    expect(result.alreadyAddedIds).toEqual([]);
  });
});
