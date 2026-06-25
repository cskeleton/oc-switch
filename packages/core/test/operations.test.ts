import { describe, expect, test } from "bun:test";
import sampleJson from "./fixtures/openclaw.sample.json";
import {
  addCustomProvider,
  addProviderFromPreset,
  addProviderModel,
  deleteProvider,
  disableModel,
  editProvider,
  enableModel,
  removeProvider,
  removeProviderModel,
  setPrimaryModel,
  updateProviderModel
} from "../src/operations";
import type { OpenClawConfig, ProviderPreset } from "../src/types";

const sample = sampleJson as OpenClawConfig;

function cloneSample() {
  return structuredClone(sample);
}

describe("operations", () => {
  test("sets primary model only when provider and model exist", () => {
    const config = cloneSample();
    const result = setPrimaryModel(config, "nvidia/deepseek-ai/deepseek-v4-flash");
    expect(result.config.agents?.defaults?.model).toBe("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(() => setPrimaryModel(config, "nvidia/missing")).toThrow("Model nvidia/missing is not defined in provider models");
  });

  test("disables and re-enables allowlist entry while preserving provider model", () => {
    const config = cloneSample();
    const disabled = disableModel(config, "nvidia/deepseek-ai/deepseek-v4-flash");
    expect(disabled.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeUndefined();
    expect(disabled.config.models?.providers?.nvidia?.models?.[0]?.id).toBe("deepseek-ai/deepseek-v4-flash");

    const enabled = enableModel(disabled.config, "nvidia/deepseek-ai/deepseek-v4-flash", "nv-ds-flash");
    expect(enabled.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-flash"]).toEqual({
      alias: "nv-ds-flash"
    });
  });

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
    expect(result.config.models?.providers?.custom?.apiKey).toEqual({ source: "env", id: "CUSTOM_API_KEY" });
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
  test("updates baseUrl and env ref without dropping unknown fields", () => {
    const config = cloneSample();
    config.models!.providers!.nvidia!.timeoutSeconds = 42;

    const result = editProvider(config, "nvidia", {
      baseUrl: "https://updated.example/v1",
      apiKeyEnv: "NEW_NVIDIA_KEY"
    });

    const provider = result.config.models?.providers?.nvidia;
    expect(provider?.baseUrl).toBe("https://updated.example/v1");
    expect(provider?.apiKey).toEqual({ source: "env", id: "NEW_NVIDIA_KEY" });
    expect(provider?.timeoutSeconds).toBe(42);
    expect(provider?.models?.[0]?.id).toBe("deepseek-ai/deepseek-v4-flash");
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

describe("addProviderModel", () => {
  test("creates provider model and optional allowlist alias", () => {
    const config = cloneSample();
    addProviderFromPreset(config, {
      id: "custom",
      name: "Custom",
      provider: { api: "openai-completions", baseUrl: "https://custom.example/v1", apiKeyEnv: "CUSTOM_API_KEY" },
      models: []
    }, []);

    const result = addProviderModel(config, "custom/vendor/model", {
      name: "Vendor Model",
      alias: "vendor",
      enabled: true
    });

    expect(result.config.models?.providers?.custom?.models?.[0]).toMatchObject({
      id: "vendor/model",
      name: "Vendor Model"
    });
    expect(result.config.agents?.defaults?.models?.["custom/vendor/model"]).toEqual({ alias: "vendor" });
  });

  test("adds model to existing provider with slash id", () => {
    const config = cloneSample();
    const result = addProviderModel(config, "nvidia/deepseek-ai/deepseek-v4-pro", {
      name: "DeepSeek V4 Pro",
      enabled: false
    });
    expect(result.config.models?.providers?.nvidia?.models?.map((m) => m.id)).toContain("deepseek-ai/deepseek-v4-pro");
    expect(result.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-pro"]).toBeUndefined();
  });
});

describe("provider model editing", () => {
  test("adds structured model fields and allowlist entry", () => {
    const config = cloneSample();
    const result = addProviderModel(config, "nvidia", {
      id: "deepseek-ai/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      alias: "ds-pro",
      enabled: true,
      api: "openai-completions",
      reasoning: true,
      contextWindow: 128000,
      maxTokens: 8192,
      input: ["text"]
    });

    expect(result.config.models?.providers?.nvidia?.models?.find((model) => model.id === "deepseek-ai/deepseek-v4-pro")).toMatchObject({
      id: "deepseek-ai/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      api: "openai-completions",
      reasoning: true,
      contextWindow: 128000,
      maxTokens: 8192,
      input: ["text"]
    });
    expect(result.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-pro"]).toEqual({ alias: "ds-pro" });
  });

  test("updates model id while preserving unknown fields and migrating allowlist and primary", () => {
    const config = cloneSample();
    Object.assign(config.models!.providers!.nvidia!.models![0]!, {
      cost: { input: 0.1 },
      vendorFlag: true
    });
    config.agents!.defaults!.models!["nvidia/deepseek-ai/deepseek-v4-flash"] = {
      alias: "old",
      agentRuntime: { id: "codex" },
      extraFlag: true
    };
    config.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";

    const result = updateProviderModel(config, "nvidia/deepseek-ai/deepseek-v4-flash", {
      id: "deepseek-ai/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      alias: "new",
      enabled: true,
      contextWindow: 128000
    });

    const model = result.config.models?.providers?.nvidia?.models?.find((entry) => entry.id === "deepseek-ai/deepseek-v4-pro");
    expect(model).toMatchObject({
      id: "deepseek-ai/deepseek-v4-pro",
      name: "DeepSeek V4 Pro",
      contextWindow: 128000,
      cost: { input: 0.1 },
      vendorFlag: true
    });
    expect(result.config.models?.providers?.nvidia?.models?.some((entry) => entry.id === "deepseek-ai/deepseek-v4-flash")).toBe(false);
    expect(result.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeUndefined();
    expect(result.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-pro"]).toEqual({
      alias: "new",
      agentRuntime: { id: "codex" },
      extraFlag: true
    });
    expect(result.config.agents?.defaults?.model).toBe("nvidia/deepseek-ai/deepseek-v4-pro");
  });

  test("disables edited model without deleting provider model", () => {
    const config = cloneSample();
    const result = updateProviderModel(config, "nvidia/deepseek-ai/deepseek-v4-flash", {
      id: "deepseek-ai/deepseek-v4-flash",
      enabled: false
    });

    expect(result.config.models?.providers?.nvidia?.models?.some((entry) => entry.id === "deepseek-ai/deepseek-v4-flash")).toBe(true);
    expect(result.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeUndefined();
  });

  test("rejects duplicate model ids and invalid numeric fields", () => {
    const config = cloneSample();
    expect(() => addProviderModel(config, "nvidia", {
      id: "deepseek-ai/deepseek-v4-flash",
      enabled: true
    })).toThrow("Model nvidia/deepseek-ai/deepseek-v4-flash already exists");

    expect(() => updateProviderModel(cloneSample(), "nvidia/deepseek-ai/deepseek-v4-flash", {
      id: "z-ai/glm5.1",
      enabled: true
    })).toThrow("Model nvidia/z-ai/glm5.1 already exists");

    expect(() => addProviderModel(cloneSample(), "nvidia", {
      id: "bad-window",
      enabled: true,
      contextWindow: 0
    })).toThrow("contextWindow must be a positive integer");
  });
});

describe("removeProviderModel", () => {
  test("removes provider model and allowlist entry", () => {
    const config = cloneSample();
    const result = removeProviderModel(config, "nvidia/deepseek-ai/deepseek-v4-flash", { force: false });
    expect(result.config.models?.providers?.nvidia?.models?.map((m) => m.id)).not.toContain("deepseek-ai/deepseek-v4-flash");
    expect(result.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeUndefined();
  });

  test("refuses removing primary unless forced or newPrimary supplied", () => {
    const config = cloneSample();
    config.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";
    expect(() => removeProviderModel(config, "nvidia/deepseek-ai/deepseek-v4-flash", { force: false })).toThrow(
      "Model nvidia/deepseek-ai/deepseek-v4-flash is the primary model"
    );

    const withNewPrimary = removeProviderModel(cloneSample(), "minimax-portal/MiniMax-M3", {
      force: false,
      newPrimary: "nvidia/deepseek-ai/deepseek-v4-flash"
    });
    expect(withNewPrimary.config.agents?.defaults?.model).toBe("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(withNewPrimary.config.models?.providers?.["minimax-portal"]?.models?.map((m) => m.id)).not.toContain("MiniMax-M3");
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
      apiKey: { source: "env", id: "CUSTOM_OPENAI_API_KEY" },
      models: [{ id: "model-a" }, { id: "vendor/model-b" }]
    });
    expect(result.config.agents?.defaults?.models?.["custom-openai/model-a"]).toEqual({ alias: "a" });
    expect(result.config.agents?.defaults?.models?.["custom-openai/vendor/model-b"]).toEqual({ alias: "b" });
  });

  test("uses authHeader for anthropic provider and can skip allowlist", () => {
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
      authHeader: { source: "env", id: "CUSTOM_ANTHROPIC_API_KEY" },
      models: [{ id: "claude-4" }]
    });
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
