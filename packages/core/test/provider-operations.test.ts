import { describe, expect, test } from "bun:test";
import sampleJson from "./fixtures/openclaw.sample.json";
import {
  addCustomProvider,
  addProviderFromPreset,
  deleteProvider,
  editProvider,
  removeProvider
} from "../src/provider-operations";
import { MAX_PROVIDER_MODELS } from "../src/provider-model-limits";
import type { OpenClawConfig, ProviderPreset } from "../src/types";

const sample = sampleJson as OpenClawConfig;

function cloneSample() {
  return structuredClone(sample);
}

describe("provider operations", () => {
  test("deletes provider by first path segment only", () => {
    const config = cloneSample();
    const result = deleteProvider(config, "nvidia", { force: true });
    expect(result.config.models?.providers?.nvidia).toBeUndefined();
    expect(Object.keys(result.config.agents?.defaults?.models ?? {})).not.toContain("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(result.config.agents?.defaults?.models?.["DeepSeek/deepseek-chat"]).toEqual({ alias: "ds-chat" });
  });

  test("requires force when deleting provider containing primary", () => {
    const config = cloneSample();
    expect(() => deleteProvider(config, "minimax-portal", { force: false })).toThrow(
      "Provider minimax-portal contains the primary model"
    );
  });
});

describe("addProviderFromPreset", () => {
  test("adds provider, env ref, models, and allowlist", () => {
    const config = cloneSample();
    const preset: ProviderPreset = {
      id: "custom",
      name: "Custom",
      provider: {
        api: "openai-completions",
        baseUrl: "https://custom.example/v1",
        apiKeyEnv: "CUSTOM_API_KEY"
      },
      models: [
        { id: "vendor/model", name: "Vendor Model", alias: "vendor" }
      ]
    };

    const result = addProviderFromPreset(config, preset, ["vendor/model"]);
    expect(result.config.models?.providers?.custom?.apiKey).toBe("${CUSTOM_API_KEY}");
    expect(result.config.models?.providers?.custom?.models?.[0]?.id).toBe("vendor/model");
    expect(result.config.agents?.defaults?.models?.["custom/vendor/model"]).toEqual({ alias: "vendor" });
  });

  test("updates existing provider without dropping unknown fields or unrelated models", () => {
    const config = cloneSample();
    config.models!.providers!.nvidia!.timeoutSeconds = 60;
    config.agents!.defaults!.models!["nvidia/z-ai/glm5.1"] = { alias: "nv-glm", agentRuntime: { id: "codex" } };

    const preset: ProviderPreset = {
      id: "nvidia",
      name: "NVIDIA",
      provider: {
        api: "openai-completions",
        baseUrl: "https://new-nvidia.example/v1",
        apiKeyEnv: "NVIDIA_API_KEY"
      },
      models: [
        { id: "deepseek-ai/deepseek-v4-pro", name: "DeepSeek V4 Pro", alias: "nv-ds-pro" }
      ]
    };

    const result = addProviderFromPreset(config, preset, ["deepseek-ai/deepseek-v4-pro"]);
    const provider = result.config.models?.providers?.nvidia;
    expect(provider?.timeoutSeconds).toBe(60);
    expect(provider?.baseUrl).toBe("https://new-nvidia.example/v1");
    expect(provider?.models?.map((model) => model.id)).toEqual([
      "deepseek-ai/deepseek-v4-flash",
      "z-ai/glm5.1",
      "deepseek-ai/deepseek-v4-pro"
    ]);
    expect(result.config.agents?.defaults?.models?.["nvidia/z-ai/glm5.1"]).toEqual({
      alias: "nv-glm",
      agentRuntime: { id: "codex" }
    });
    expect(result.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-pro"]).toEqual({
      alias: "nv-ds-pro"
    });
  });

  test("rejects preset merge when final catalog exceeds capacity", () => {
    const config = cloneSample();
    config.models!.providers!.nvidia!.models = Array.from({ length: MAX_PROVIDER_MODELS - 1 }, (_, i) => ({
      id: `existing-${i}`,
      name: `Existing ${i}`
    }));

    const preset: ProviderPreset = {
      id: "nvidia",
      name: "NVIDIA",
      provider: {
        api: "openai-completions",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKeyEnv: "NVIDIA_API_KEY"
      },
      models: [
        { id: "new-a", name: "New A" },
        { id: "new-b", name: "New B" }
      ]
    };

    expect(() => addProviderFromPreset(config, preset, [])).toThrow(/limit|capacity/i);
  });

  test("allows preset that only updates existing models when already at capacity", () => {
    const config = cloneSample();
    config.models!.providers!.nvidia!.models = Array.from({ length: MAX_PROVIDER_MODELS }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`
    }));

    const preset: ProviderPreset = {
      id: "nvidia",
      name: "NVIDIA",
      provider: {
        api: "openai-completions",
        baseUrl: "https://updated.example/v1",
        apiKeyEnv: "NVIDIA_API_KEY"
      },
      models: [
        { id: "model-0", name: "Updated Model 0" },
        { id: "model-1", name: "Updated Model 1" }
      ]
    };

    const result = addProviderFromPreset(config, preset, []);
    expect(result.config.models?.providers?.nvidia?.models).toHaveLength(MAX_PROVIDER_MODELS);
    expect(result.config.models?.providers?.nvidia?.models?.[0]?.name).toBe("Updated Model 0");
    expect(result.config.models?.providers?.nvidia?.baseUrl).toBe("https://updated.example/v1");
  });

  test("allows preset that only updates existing models when catalog already over cap", () => {
    const config = cloneSample();
    const overCapCount = MAX_PROVIDER_MODELS + 1;
    config.models!.providers!.nvidia!.models = Array.from({ length: overCapCount }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`
    }));

    const preset: ProviderPreset = {
      id: "nvidia",
      name: "NVIDIA",
      provider: {
        api: "openai-completions",
        baseUrl: "https://updated.example/v1",
        apiKeyEnv: "NVIDIA_API_KEY"
      },
      models: [
        { id: "model-0", name: "Updated Model 0" },
        { id: "model-1", name: "Updated Model 1" }
      ]
    };

    const result = addProviderFromPreset(config, preset, []);
    expect(result.config.models?.providers?.nvidia?.models).toHaveLength(overCapCount);
    expect(result.config.models?.providers?.nvidia?.models?.[0]?.name).toBe("Updated Model 0");
    expect(result.config.models?.providers?.nvidia?.models?.[1]?.name).toBe("Updated Model 1");
  });

  test("removes legacy authHeader env ref when preset rewrites credentials", () => {
    const config = cloneSample();
    config.models!.providers!.custom = {
      baseUrl: "https://old.example/v1",
      apiKey: { source: "env", id: "OLD_KEY" },
      authHeader: { source: "env", id: "OLD_AUTH_KEY" },
      models: [{ id: "old-model", name: "Old Model" }]
    };
    const preset: ProviderPreset = {
      id: "custom",
      name: "Custom",
      provider: {
        api: "openai-completions",
        baseUrl: "https://custom.example/v1",
        apiKeyEnv: "CUSTOM_API_KEY"
      },
      models: [{ id: "vendor/model", name: "Vendor Model" }]
    };

    const result = addProviderFromPreset(config, preset, ["vendor/model"]);
    const provider = result.config.models?.providers?.custom;
    expect(provider?.apiKey).toBe("${CUSTOM_API_KEY}");
    expect(provider?.authHeader).toBeUndefined();
  });
});

describe("provider add from preset", () => {
  test("writes provider and allowlist from preset", () => {
    const config = cloneSample();
    const preset: ProviderPreset = {
      id: "custom",
      name: "Custom",
      provider: {
        api: "openai-completions",
        baseUrl: "https://custom.example/v1",
        apiKeyEnv: "CUSTOM_API_KEY"
      },
      models: [{ id: "vendor/model", name: "Vendor Model", alias: "vendor" }]
    };

    const result = addProviderFromPreset(config, preset, ["vendor/model"]);
    expect(result.config.models?.providers?.custom).toBeDefined();
    expect(result.config.agents?.defaults?.models?.["custom/vendor/model"]).toEqual({ alias: "vendor" });
  });
});

describe("editProvider", () => {
  test("updates baseUrl, api, and env ref without dropping unknown fields", () => {
    const config = cloneSample();
    config.models!.providers!.nvidia!.timeoutSeconds = 42;

    const result = editProvider(config, "nvidia", {
      baseUrl: "https://updated.example/v1",
      api: "anthropic-messages",
      apiKeyEnv: "NEW_NVIDIA_KEY"
    });

    const provider = result.config.models?.providers?.nvidia;
    expect(provider?.baseUrl).toBe("https://updated.example/v1");
    expect(provider?.api).toBe("anthropic-messages");
    expect(provider?.apiKey).toBe("${NEW_NVIDIA_KEY}");
    expect(provider?.timeoutSeconds).toBe(42);
    expect(provider?.models?.[0]?.id).toBe("deepseek-ai/deepseek-v4-flash");
  });

  test("rejects unsupported api types", () => {
    const config = cloneSample();
    expect(() => editProvider(config, "nvidia", {
      api: "unsupported-api" as never
    })).toThrow("api must be a supported API type");
  });

  test("removes legacy authHeader env ref when editing api key env", () => {
    const config = cloneSample();
    config.models!.providers!.nvidia!.authHeader = { source: "env", id: "OLD_AUTH_KEY" };

    const result = editProvider(config, "nvidia", {
      apiKeyEnv: "NEW_NVIDIA_KEY"
    });

    const provider = result.config.models?.providers?.nvidia;
    expect(provider?.apiKey).toBe("${NEW_NVIDIA_KEY}");
    expect(provider?.authHeader).toBeUndefined();
  });
});

describe("removeProvider", () => {
  test("removes only refs whose first segment matches providerId", () => {
    const config = cloneSample();
    const result = removeProvider(config, "nvidia", { force: true });
    expect(result.config.models?.providers?.nvidia).toBeUndefined();
    expect(result.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeUndefined();
    expect(result.config.agents?.defaults?.models?.["DeepSeek/deepseek-chat"]).toEqual({ alias: "ds-chat" });
  });

  test("sets new primary when deleting provider containing primary", () => {
    const config = cloneSample();
    const result = removeProvider(config, "minimax-portal", {
      force: false,
      newPrimary: "nvidia/deepseek-ai/deepseek-v4-flash"
    });
    expect(result.config.models?.providers?.["minimax-portal"]).toBeUndefined();
    expect(result.config.agents?.defaults?.model).toBe("nvidia/deepseek-ai/deepseek-v4-flash");
  });
});

describe("addCustomProvider", () => {
  test("adds openai-compatible provider, normalizes baseUrl, models, and allowlist", () => {
    const config = cloneSample();
    const result = addCustomProvider(config, {
      providerId: "custom-openai",
      displayName: "Custom OpenAI",
      api: "openai-completions",
      baseUrl: "https://api.custom.example",
      isFullUrl: false,
      apiKeyEnv: "CUSTOM_OPENAI_API_KEY",
      models: [
        { id: "model-a", alias: "a" },
        { id: "vendor/model-b", alias: "b" }
      ],
      enableAllModels: true
    });

    expect(result.config.models?.providers?.["custom-openai"]).toMatchObject({
      baseUrl: "https://api.custom.example/v1",
      api: "openai-completions",
      apiKey: "${CUSTOM_OPENAI_API_KEY}",
      models: [
        { id: "model-a", name: "Model A" },
        { id: "vendor/model-b", name: "Vendor Model B" }
      ]
    });
    expect(result.config.models?.providers?.["custom-openai"]?.authHeader).toBeUndefined();
    expect(result.config.models?.providers?.["custom-openai"]?.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "model-a", reasoning: true }),
        expect.objectContaining({ id: "vendor/model-b", reasoning: true })
      ])
    );
    expect(result.config.agents?.defaults?.models?.["custom-openai/model-a"]).toEqual({ alias: "a" });
    expect(result.config.agents?.defaults?.models?.["custom-openai/vendor/model-b"]).toEqual({ alias: "b" });
  });

  test("writes apiKey for anthropic provider and can skip allowlist", () => {
    const config = cloneSample();
    const result = addCustomProvider(config, {
      providerId: "custom-anthropic",
      displayName: "Custom Anthropic",
      api: "anthropic-messages",
      baseUrl: "https://anthropic.custom.example",
      isFullUrl: false,
      apiKeyEnv: "CUSTOM_ANTHROPIC_API_KEY",
      models: [{ id: "claude-4" }],
      enableAllModels: false
    });

    expect(result.config.models?.providers?.["custom-anthropic"]).toMatchObject({
      baseUrl: "https://anthropic.custom.example",
      api: "anthropic-messages",
      apiKey: "${CUSTOM_ANTHROPIC_API_KEY}",
      models: [{ id: "claude-4", name: "Claude 4" }]
    });
    expect(result.config.models?.providers?.["custom-anthropic"]?.authHeader).toBeUndefined();
    expect(result.config.agents?.defaults?.models?.["custom-anthropic/claude-4"]).toBeUndefined();
  });

  test("preserves full URL input exactly after trimming surrounding whitespace", () => {
    const config = cloneSample();
    const result = addCustomProvider(config, {
      providerId: "custom-full-url",
      displayName: "Custom Full URL",
      api: "openai-completions",
      baseUrl: "  https://api.custom.example/v1/  ",
      isFullUrl: true,
      apiKeyEnv: "CUSTOM_FULL_URL_API_KEY",
      models: [{ id: "model-a" }],
      enableAllModels: true
    });

    expect(result.config.models?.providers?.["custom-full-url"]?.baseUrl).toBe("https://api.custom.example/v1/");
  });

  test("rejects invalid custom provider input", () => {
    const base = {
      providerId: "custom-invalid",
      displayName: "Custom Invalid",
      api: "openai-completions" as const,
      baseUrl: "https://valid.example",
      isFullUrl: true,
      apiKeyEnv: "CUSTOM_INVALID_API_KEY",
      models: [{ id: "model-a" }],
      enableAllModels: true
    };

    expect(() => addCustomProvider(cloneSample(), { ...base, providerId: "bad/id" })).toThrow("Provider ID must not contain /");
    expect(() => addCustomProvider(cloneSample(), { ...base, providerId: "nvidia" })).toThrow("Provider nvidia already exists");
    expect(() => addCustomProvider(cloneSample(), { ...base, api: "bogus-api" as never })).toThrow("api must be a supported API type");
    expect(() => addCustomProvider(cloneSample(), { ...base, apiKeyEnv: "bad-key" })).toThrow("apiKeyEnv must be a valid env var name");
    expect(() => addCustomProvider(cloneSample(), { ...base, baseUrl: "ftp://bad.example" })).toThrow("baseUrl must be an http or https URL");
    expect(() => addCustomProvider(cloneSample(), { ...base, models: [] })).toThrow("models must contain at least one model");
    expect(() => addCustomProvider(cloneSample(), { ...base, models: [{ id: "dup" }, { id: "dup" }] })).toThrow("Duplicate model id dup");
  });

  test("rejects when models.length exceeds capacity", () => {
    const config = cloneSample();
    const models = Array.from({ length: MAX_PROVIDER_MODELS + 1 }, (_, i) => ({ id: `model-${i}` }));

    expect(() => addCustomProvider(config, {
      providerId: "over-cap",
      displayName: "Over Cap",
      api: "openai-completions",
      baseUrl: "https://api.example.com",
      isFullUrl: false,
      apiKeyEnv: "OVER_CAP_API_KEY",
      models,
      enableAllModels: false
    })).toThrow(/limit|20/i);
  });

  test("拒绝 case-insensitive 同名 provider", () => {
    const config = cloneSample();
    delete config.models!.providers!.DeepSeek;
    config.models!.providers!.deepseek = { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "DEEPSEEK_API_KEY" }, models: [] };
    expect(() => addCustomProvider(config, {
      providerId: "DeepSeek",
      displayName: "DeepSeek",
      api: "openai-completions",
      baseUrl: "https://api.deepseek.com",
      isFullUrl: false,
      apiKeyEnv: "DEEPSEEK_API_KEY",
      models: [{ id: "deepseek-chat" }],
      enableAllModels: true
    })).toThrow("already exists (case-insensitive match)");
  });
});

describe("provider operations 对象形态主模型与 fallback 保护", () => {
  /** 对象形态：primary = minimax-portal/MiniMax-M3，fallback 指向 nvidia */
  function objectPrimarySample() {
    const config = cloneSample();
    config.agents!.defaults!.model = {
      primary: "minimax-portal/MiniMax-M3",
      fallbacks: ["nvidia/deepseek-ai/deepseek-v4-flash"],
      customFlag: true
    } as never;
    return config;
  }

  test("removeProvider：对象形态主模型在该 provider 时拒绝删除", () => {
    const config = objectPrimarySample();
    expect(() => removeProvider(config, "minimax-portal", { force: false })).toThrow(
      "Provider minimax-portal contains the primary model"
    );
  });

  test("removeProvider：force 删除时 warning 文案含归一 ref 且无 [object Object]", () => {
    const config = objectPrimarySample();
    const result = removeProvider(config, "minimax-portal", { force: true });
    expect(result.warnings).toContain(
      "Primary model minimax-portal/MiniMax-M3 now points to a deleted provider"
    );
    expect(JSON.stringify(result.warnings)).not.toContain("[object Object]");
  });

  test("removeProvider：newPrimary 迁移后保留对象形状与 fallbacks", () => {
    const config = objectPrimarySample();
    removeProvider(config, "minimax-portal", { force: false, newPrimary: "DeepSeek/deepseek-chat" });
    const model = config.agents!.defaults!.model as Record<string, unknown>;
    expect(model.primary).toBe("DeepSeek/deepseek-chat");
    expect(model.fallbacks).toEqual(["nvidia/deepseek-ai/deepseek-v4-flash"]);
    expect(model.customFlag).toBe(true);
  });

  test("removeProvider：命中 fallback provider 时拒绝，force 也不可绕过，配置不变", () => {
    for (const force of [false, true]) {
      const config = objectPrimarySample();
      const before = structuredClone(config);
      expect(() => removeProvider(config, "nvidia", { force })).toThrow(
        /agents\.defaults\.model\.fallbacks/
      );
      expect(config).toEqual(before);
    }
  });
});
