import { describe, expect, test } from "bun:test";
import sampleJson from "./fixtures/openclaw.sample.json";
import {
  addProviderModel,
  disableModel,
  enableModel,
  removeProviderModel,
  setPrimaryModel,
  updateProviderModel
} from "../src/model-operations";
import { addProviderFromPreset } from "../src/provider-operations";
import type { OpenClawConfig } from "../src/types";

const sample = sampleJson as OpenClawConfig;

function cloneSample() {
  return structuredClone(sample);
}

describe("model operations", () => {
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

describe("model name fallback", () => {
  test("adds model with default name when name is omitted", () => {
    const config = cloneSample();
    const result = addProviderModel(config, "nvidia", {
      id: "vendor/model-x",
      enabled: true
    });
    expect(result.config.models?.providers?.nvidia?.models?.find((m) => m.id === "vendor/model-x")?.name)
      .toBe("Vendor Model X");
  });

  test("does not delete model name when update omits name", () => {
    const config = cloneSample();
    config.models!.providers!.nvidia!.models![0]!.name = "DeepSeek Flash";
    const result = updateProviderModel(config, "nvidia/deepseek-ai/deepseek-v4-flash", {
      id: "deepseek-ai/deepseek-v4-flash",
      enabled: true
    });
    expect(result.config.models?.providers?.nvidia?.models?.[0]?.name).toBe("DeepSeek Flash");
  });

  test("keeps existing model name when update submits blank name", () => {
    const config = cloneSample();
    config.models!.providers!.nvidia!.models![0]!.name = "DeepSeek Flash";
    const result = updateProviderModel(config, "nvidia/deepseek-ai/deepseek-v4-flash", {
      id: "deepseek-ai/deepseek-v4-flash",
      name: "",
      enabled: true
    });
    expect(result.config.models?.providers?.nvidia?.models?.[0]?.name).toBe("DeepSeek Flash");
  });
});
