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
