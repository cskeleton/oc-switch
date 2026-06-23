import { describe, expect, test } from "bun:test";
import sampleJson from "./fixtures/openclaw.sample.json";
import { addProviderFromPreset, deleteProvider, disableModel, enableModel, setPrimaryModel } from "../src/operations";
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
