import { describe, expect, test } from "bun:test";
import sampleJson from "./fixtures/openclaw.sample.json";
import {
  addProviderFromPreset,
  addProviderModel,
  deleteProvider,
  disableModel,
  editProvider,
  enableModel,
  removeProvider,
  removeProviderModel,
  setPrimaryModel
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
