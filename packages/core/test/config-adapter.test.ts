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

  test("合并唯一 Provider 的 allowlist 前缀大小写漂移且保持启用状态", () => {
    const config: OpenClawConfig = {
      models: { providers: { CPA: { models: [{ id: "codex-free" }] } } },
      agents: { defaults: { models: { "cpa/codex-free": { alias: "free" } } } }
    };
    const adapter = createConfigAdapter(config);

    expect(adapter.listProviders()[0]).toMatchObject({
      id: "CPA",
      modelCount: 1,
      enabledModelCount: 1
    });
    expect(adapter.listModels()).toEqual([{
      ref: "CPA/codex-free",
      providerId: "CPA",
      modelId: "codex-free",
      name: undefined,
      alias: "free",
      enabled: true,
      selectionSource: "legacy",
      isPrimary: false
    }]);
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
      allowlistModelCount: 4,
      modelPolicyMode: "legacy",
      effectiveModelCount: 4
    });
  });

  test("restricted policy 以 wildcard 选择完整本地目录，metadata alias 不改变选择结果", () => {
    const config: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "m1" }, { id: "m2" }] } } },
      agents: {
        defaults: {
          models: { "cpa/m1": { alias: "first" } },
          modelPolicy: { allow: ["cpa/*"] }
        }
      }
    };
    const adapter = createConfigAdapter(config);

    expect(adapter.listProviders()[0]?.enabledModelCount).toBe(2);
    expect(adapter.listModels().find((model) => model.ref === "cpa/m2")).toMatchObject({
      enabled: true,
      selectionSource: "policy-wildcard"
    });
    expect(adapter.listModels().find((model) => model.ref === "cpa/m1")?.alias).toBe("first");
    expect(adapter.getStatus()).toMatchObject({
      allowlistModelCount: 1,
      modelPolicyMode: "restricted",
      effectiveModelCount: 2
    });
  });

  test("缺失 policy 保持 legacy metadata selection", () => {
    const config: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "m1" }, { id: "m2" }] } } },
      agents: { defaults: { models: { "cpa/m1": {} } } }
    };

    const adapter = createConfigAdapter(config);
    expect(adapter.listModels().find((model) => model.ref === "cpa/m1")).toMatchObject({
      enabled: true,
      selectionSource: "legacy"
    });
    expect(adapter.listModels().find((model) => model.ref === "cpa/m2")).toMatchObject({ enabled: false });
    expect(adapter.getStatus().effectiveModelCount).toBe(1);
  });

  test("metadata-only 行仅在 legacy 或 restricted policy 覆盖时有有效 selection", () => {
    const base: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "catalog" }] } } },
      agents: { defaults: { models: { "cpa/metadata-only": { alias: "metadata" } } } }
    };

    const legacy = createConfigAdapter(base).listModels().find((model) => model.ref === "cpa/metadata-only");
    expect(legacy).toMatchObject({ enabled: true, selectionSource: "legacy", alias: "metadata" });

    const unrestrictedConfig = structuredClone(base);
    unrestrictedConfig.agents!.defaults!.modelPolicy = { allow: [] };
    const unrestricted = createConfigAdapter(unrestrictedConfig).listModels().find((model) => model.ref === "cpa/metadata-only");
    expect(unrestricted).toMatchObject({ enabled: false, alias: "metadata" });
    expect(unrestricted?.selectionSource).toBeUndefined();
    expect(unrestricted && "selectionSource" in unrestricted).toBe(false);

    const restrictedConfig = structuredClone(base);
    restrictedConfig.agents!.defaults!.modelPolicy = { allow: ["cpa/metadata-only"] };
    const restricted = createConfigAdapter(restrictedConfig).listModels().find((model) => model.ref === "cpa/metadata-only");
    expect(restricted).toMatchObject({ enabled: true, selectionSource: "policy-exact", alias: "metadata" });
  });

  test("legacy 保留大小写重复 Provider 的精确 metadata 归属", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          CPA: { models: [{ id: "m1" }] },
          cpa: { models: [{ id: "m1" }] }
        }
      },
      agents: { defaults: { models: { "CPA/m1": {} } } }
    };

    const providers = createConfigAdapter(config).listProviders();
    expect(providers.find((provider) => provider.id === "CPA")?.enabledModelCount).toBe(1);
    expect(providers.find((provider) => provider.id === "cpa")?.enabledModelCount).toBe(0);
  });

  test("显式空 policy 不创建条目并将整个本地目录视为 unrestricted", () => {
    const config: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "m1" }, { id: "m2" }] } } },
      agents: { defaults: { modelPolicy: { allow: [] } } }
    };

    const adapter = createConfigAdapter(config);
    expect(config.agents?.defaults?.modelPolicy?.allow).toEqual([]);
    expect(config.agents?.defaults?.models).toBeUndefined();
    expect(adapter.listModels().every((model) => model.enabled && model.selectionSource === "unrestricted")).toBe(true);
    expect(adapter.getStatus()).toMatchObject({
      allowlistModelCount: 0,
      modelPolicyMode: "unrestricted",
      effectiveModelCount: 2
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
