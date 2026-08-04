import { describe, expect, test } from "bun:test";
import sampleJson from "./fixtures/openclaw.sample.json";
import { createConfigAdapter } from "../src/config-adapter";
import type { OpenClawConfig } from "../src/types";

const sample = sampleJson as OpenClawConfig;

describe("ConfigAdapter", () => {
  test("lists providers with model and allowlist counts", () => {
    const adapter = createConfigAdapter(sample);
    expect(adapter.listProviders()).toEqual([
      {
        id: "nvidia",
        api: "openai-completions",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        modelCount: 2,
        enabledModelCount: 2,
        containsPrimary: false,
        disabled: false
      },
      {
        id: "DeepSeek",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com/v1",
        modelCount: 1,
        enabledModelCount: 1,
        containsPrimary: false,
        disabled: false
      },
      {
        id: "minimax-portal",
        api: "anthropic-messages",
        baseUrl: "https://api.minimax.io/anthropic",
        modelCount: 1,
        enabledModelCount: 1,
        containsPrimary: true,
        disabled: false
      }
    ]);
  });

  test("lists models while preserving slash model ids", () => {
    const adapter = createConfigAdapter(sample);
    expect(adapter.listModels().map((model) => model.ref)).toContain("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(adapter.listModels().find((model) => model.ref === "nvidia/deepseek-ai/deepseek-v4-flash")).toMatchObject({
      providerId: "nvidia",
      modelId: "deepseek-ai/deepseek-v4-flash",
      enabled: true,
      alias: "nv-ds-flash"
    });
  });

  test("lists allowlist-only models", () => {
    const config = structuredClone(sample);
    config.agents!.defaults!.models!["openai/gpt-5.4"] = { alias: "codex-5.4", agentRuntime: { id: "codex" } };

    const model = createConfigAdapter(config).listModels().find((entry) => entry.ref === "openai/gpt-5.4");
    expect(model).toMatchObject({
      ref: "openai/gpt-5.4",
      providerId: "openai",
      modelId: "gpt-5.4",
      alias: "codex-5.4",
      enabled: true
    });
  });

  test("lists editable provider model fields", () => {
    const config = structuredClone(sample);
    Object.assign(config.models!.providers!.nvidia!.models![0]!, {
      api: "openai-completions",
      reasoning: true,
      contextWindow: 128000,
      maxTokens: 8192,
      input: ["text"]
    });

    const model = createConfigAdapter(config).listModels().find((entry) => entry.ref === "nvidia/deepseek-ai/deepseek-v4-flash");
    expect(model).toMatchObject({
      api: "openai-completions",
      reasoning: true,
      contextWindow: 128000,
      maxTokens: 8192,
      input: ["text"]
    });
  });

  test("summary 透传 contextTokens", () => {
    const config = structuredClone(sample);
    Object.assign(config.models!.providers!.nvidia!.models![0]!, {
      contextWindow: 128000,
      contextTokens: 96000,
      maxTokens: 8192
    });

    const model = createConfigAdapter(config).listModels().find((entry) => entry.ref === "nvidia/deepseek-ai/deepseek-v4-flash");
    expect(model).toMatchObject({
      contextWindow: 128000,
      contextTokens: 96000,
      maxTokens: 8192
    });
  });

  test("reports status", () => {
    const adapter = createConfigAdapter(sample);
    expect(adapter.getStatus()).toEqual({
      primaryModel: "minimax-portal/MiniMax-M3",
      providerCount: 3,
      providerModelCount: 4,
      allowlistModelCount: 4
    });
  });
});

describe("ConfigAdapter 对象形态主模型", () => {
  function withObjectPrimary(primary: unknown): OpenClawConfig {
    const config = structuredClone(sample);
    config.agents!.defaults!.model = {
      primary,
      fallbacks: ["nvidia/deepseek-ai/deepseek-v4-flash"]
    } as never;
    return config;
  }

  test("listProviders 不抛错且 containsPrimary 正确标记主模型所属 provider", () => {
    const providers = createConfigAdapter(withObjectPrimary("minimax-portal/MiniMax-M3")).listProviders();
    expect(providers.find((entry) => entry.id === "minimax-portal")?.containsPrimary).toBe(true);
    expect(providers.filter((entry) => entry.containsPrimary)).toHaveLength(1);
  });

  test("listModels 的 isPrimary 命中主模型 ref", () => {
    const models = createConfigAdapter(withObjectPrimary("minimax-portal/MiniMax-M3")).listModels();
    expect(models.find((entry) => entry.ref === "minimax-portal/MiniMax-M3")?.isPrimary).toBe(true);
    expect(models.filter((entry) => entry.isPrimary)).toHaveLength(1);
  });

  test("getStatus primaryModel 返回归一 ref 字符串", () => {
    const status = createConfigAdapter(withObjectPrimary("minimax-portal/MiniMax-M3")).getStatus();
    expect(status.primaryModel).toBe("minimax-portal/MiniMax-M3");
  });

  test("primary 带首尾空白时 trim 后仍正确命中", () => {
    const adapter = createConfigAdapter(withObjectPrimary("  minimax-portal/MiniMax-M3  "));
    expect(adapter.getStatus().primaryModel).toBe("minimax-portal/MiniMax-M3");
    expect(adapter.listProviders().find((entry) => entry.id === "minimax-portal")?.containsPrimary).toBe(true);
    expect(adapter.listModels().find((entry) => entry.ref === "minimax-portal/MiniMax-M3")?.isPrimary).toBe(true);
  });

  test("对象缺 primary 时视为未设置主模型且不抛错", () => {
    const config = structuredClone(sample);
    config.agents!.defaults!.model = { fallbacks: ["nvidia/deepseek-ai/deepseek-v4-flash"] } as never;
    const adapter = createConfigAdapter(config);
    expect(adapter.getStatus().primaryModel).toBeUndefined();
    expect(adapter.listProviders().every((entry) => entry.containsPrimary === false)).toBe(true);
    expect(adapter.listModels().every((entry) => entry.isPrimary === false)).toBe(true);
  });

  test("非法字符串主模型（空白/无斜杠/空段）不抛错且视为未设置", () => {
    for (const bad of ["   ", "no-slash", "/model-only", "provider/"]) {
      const config = structuredClone(sample);
      config.agents!.defaults!.model = bad;
      const adapter = createConfigAdapter(config);
      expect(adapter.getStatus().primaryModel).toBeUndefined();
      expect(adapter.listProviders()).toHaveLength(3);
    }
  });
});
