import { describe, expect, test } from "bun:test";
import sampleJson from "./fixtures/openclaw.sample.json";
import { createConfigAdapter } from "../src/config-adapter";
import type { PluginProvider } from "../src/plugin-catalog";
import type { OpenClawConfig } from "../src/types";

const sample = sampleJson as OpenClawConfig;

function pluginProvider(overrides: Partial<PluginProvider> = {}): PluginProvider {
  return {
    pluginId: "opencode",
    providerId: "opencode",
    origin: "npm-global",
    enabled: true,
    baseUrl: "https://opencode.ai/zen/v1",
    api: "openai-completions",
    models: [{ id: "big-pickle" }, { id: "hy3" }],
    apiKeyEnvVars: ["OPENCODE_API_KEY"],
    ...overrides
  };
}

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
        disabled: false,
        source: "config"
      },
      {
        id: "DeepSeek",
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com/v1",
        modelCount: 1,
        enabledModelCount: 1,
        containsPrimary: false,
        disabled: false,
        source: "config"
      },
      {
        id: "minimax-portal",
        api: "anthropic-messages",
        baseUrl: "https://api.minimax.io/anthropic",
        modelCount: 1,
        enabledModelCount: 1,
        containsPrimary: true,
        disabled: false,
        source: "config"
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

  test("disabled Provider 从所有策略模式的有效可选聚合中排除", () => {
    const scenarios: Array<{ name: string; config: OpenClawConfig; cpaRef: string; cpaSelectionSource: string }> = [
      {
        name: "legacy",
        config: {
          models: { providers: { cpa: { models: [{ id: "m1" }, { id: "m2" }] }, other: { models: [{ id: "m1" }] } } },
          agents: { defaults: { models: { "cpa/m1": {}, "cpa/m2": {}, "other/m1": {} } } }
        },
        cpaRef: "cpa/m2",
        cpaSelectionSource: "legacy"
      },
      {
        name: "unrestricted",
        config: {
          models: { providers: { cpa: { models: [{ id: "m1" }, { id: "m2" }] }, other: { models: [{ id: "m1" }] } } },
          agents: { defaults: { modelPolicy: { allow: [] } } }
        },
        cpaRef: "cpa/m2",
        cpaSelectionSource: "unrestricted"
      },
      {
        name: "restricted",
        config: {
          models: { providers: { cpa: { models: [{ id: "m1" }, { id: "m2" }] }, other: { models: [{ id: "m1" }] } } },
          agents: { defaults: { modelPolicy: { allow: ["cpa/*", "other/m1"] } } }
        },
        cpaRef: "cpa/m2",
        cpaSelectionSource: "policy-wildcard"
      },
      {
        name: "restricted exact",
        config: {
          models: { providers: { cpa: { models: [{ id: "m1" }, { id: "m2" }] }, other: { models: [{ id: "m1" }] } } },
          agents: { defaults: { modelPolicy: { allow: ["cpa/m1", "other/m1"] } } }
        },
        cpaRef: "cpa/m1",
        cpaSelectionSource: "policy-exact"
      }
    ];

    for (const scenario of scenarios) {
      const adapter = createConfigAdapter(scenario.config, { disabledProviderIds: ["CPA"] });
      expect(adapter.listProviders().find((provider) => provider.id === "cpa")).toMatchObject({
        disabled: true,
        enabledModelCount: 0
      });
      expect(adapter.getStatus().effectiveModelCount).toBe(1);
      expect(adapter.listModels().find((model) => model.ref === scenario.cpaRef)).toMatchObject({
        enabled: false,
        selectionSource: scenario.cpaSelectionSource
      });
    }
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

describe("ConfigAdapter 插件 provider 合并", () => {
  test("插件 provider 追加在 config 条目之后并标记 source=plugin", () => {
    const adapter = createConfigAdapter(sample, { pluginProviders: [pluginProvider()] });
    const rows = adapter.listProviders();
    expect(rows.map((row) => row.id)).toEqual(["nvidia", "DeepSeek", "minimax-portal", "opencode"]);
    expect(rows.slice(0, 3).every((row) => row.source === "config")).toBe(true);
    expect(rows[3]).toEqual({
      id: "opencode",
      api: "openai-completions",
      baseUrl: "https://opencode.ai/zen/v1",
      modelCount: 2,
      // legacy 模式下无 agents.defaults.models 条目 ⇒ 无有效 selection
      enabledModelCount: 0,
      containsPrimary: false,
      disabled: false,
      source: "plugin"
    });
  });

  test("插件 enabled=false 时标记 disabled 且有效可选数归零", () => {
    const config = structuredClone(sample);
    config.agents!.defaults!.models!["opencode/big-pickle"] = { alias: "oc-bp" };
    const rows = createConfigAdapter(config, {
      pluginProviders: [pluginProvider({ enabled: false })]
    }).listProviders();
    expect(rows.find((row) => row.id === "opencode")).toMatchObject({ disabled: true, enabledModelCount: 0 });
    expect(
      createConfigAdapter(config, { pluginProviders: [pluginProvider()] })
        .listProviders()
        .find((row) => row.id === "opencode")
    ).toMatchObject({ disabled: false, enabledModelCount: 1 });
  });

  test("providerId 与 models.providers 冲突时 config 优先，插件条目不重复列出", () => {
    const config = structuredClone(sample);
    const rows = createConfigAdapter(config, {
      pluginProviders: [pluginProvider({ providerId: "NVIDIA" })]
    }).listProviders();
    expect(rows.filter((row) => row.id.toLowerCase() === "nvidia")).toHaveLength(1);
    expect(rows.find((row) => row.id === "nvidia")?.source).toBe("config");
  });

  test("多个插件声明同名 providerId 时先到先得", () => {
    const rows = createConfigAdapter(sample, {
      pluginProviders: [
        pluginProvider({ pluginId: "first", baseUrl: "https://first.example/v1" }),
        pluginProvider({ pluginId: "second", providerId: "OpenCode", baseUrl: "https://second.example/v1" })
      ]
    }).listProviders();
    const merged = rows.filter((row) => row.id.toLowerCase() === "opencode");
    expect(merged).toHaveLength(1);
    expect(merged[0]?.baseUrl).toBe("https://first.example/v1");
  });

  test("插件模型进入 listModels，并透传 manifest 参数", () => {
    const adapter = createConfigAdapter(sample, {
      pluginProviders: [pluginProvider({
        models: [{ id: "big-pickle", name: "Big Pickle", contextWindow: 200_000, maxTokens: 8192, reasoning: true, input: ["text"] }]
      })]
    });
    expect(adapter.listModels().find((model) => model.ref === "opencode/big-pickle")).toEqual({
      ref: "opencode/big-pickle",
      providerId: "opencode",
      modelId: "big-pickle",
      name: "Big Pickle",
      alias: undefined,
      enabled: false,
      isPrimary: false,
      api: "openai-completions",
      reasoning: true,
      contextWindow: 200_000,
      maxTokens: 8192,
      input: ["text"]
    });
  });

  test("插件模型的 legacy metadata 别名会挂到同一行，不产生重复行", () => {
    const config = structuredClone(sample);
    config.agents!.defaults!.models!["opencode/hy3"] = { alias: "oc-hy3" };
    const rows = createConfigAdapter(config, { pluginProviders: [pluginProvider()] }).listModels();
    const matched = rows.filter((row) => row.ref === "opencode/hy3");
    expect(matched).toHaveLength(1);
    expect(matched[0]).toMatchObject({ alias: "oc-hy3", enabled: true, selectionSource: "legacy" });
  });

  test("主模型指向插件 ref 时 isPrimary / containsPrimary 生效", () => {
    const config = structuredClone(sample);
    config.agents!.defaults!.model = "opencode/big-pickle";
    const adapter = createConfigAdapter(config, { pluginProviders: [pluginProvider()] });
    expect(adapter.listProviders().find((row) => row.id === "opencode")?.containsPrimary).toBe(true);
    expect(adapter.listModels().find((row) => row.ref === "opencode/big-pickle")?.isPrimary).toBe(true);
  });

  test("restricted policy 的通配条目对插件 ref 照常生效", () => {
    const config = structuredClone(sample);
    config.agents!.defaults!.modelPolicy = { allow: ["opencode/*"] };
    const adapter = createConfigAdapter(config, { pluginProviders: [pluginProvider()] });
    expect(adapter.listProviders().find((row) => row.id === "opencode")?.enabledModelCount).toBe(2);
    expect(adapter.listModels().find((row) => row.ref === "opencode/hy3")).toMatchObject({
      enabled: true,
      selectionSource: "policy-wildcard"
    });
  });

  test("getStatus 的 provider/目录计数保持 config-only，effectiveModelCount 计入插件", () => {
    const config = structuredClone(sample);
    config.agents!.defaults!.models!["opencode/big-pickle"] = { alias: "oc-bp" };
    const withoutPlugin = createConfigAdapter(config).getStatus();
    const withPlugin = createConfigAdapter(config, { pluginProviders: [pluginProvider()] }).getStatus();
    expect(withPlugin.providerCount).toBe(withoutPlugin.providerCount);
    expect(withPlugin.providerModelCount).toBe(withoutPlugin.providerModelCount);
    expect(withPlugin.effectiveModelCount).toBe(withoutPlugin.effectiveModelCount + 1);
  });
});

/**
 * 兼容层形状回归（runtime spec §14 / Task 9 Step 4）：
 * `GET /api/models` 的旧 consumers（Web 编辑对话框、E2E、Dashboard 计数）依赖
 * ModelSummary 的精确字段集合。2026-09-09 的统一 inventory（buildModelInventory）
 * 上线后，本层仍是这些 consumers 的数据源；任何字段增删/改名都会静默破坏旧
 * 消费方，故用 toEqual 锁死完整形状（含「selectionSource 缺省时键不存在」）。
 */
describe("ConfigAdapter 兼容层形状回归（/api/models 旧 consumers）", () => {
  test("ModelSummary 完整形状锁死：字段集合、缺省键省略、alias/isPrimary/enabled 语义", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          cpa: { models: [{ id: "m1" }, { id: "plain" }] }
        }
      },
      agents: {
        defaults: {
          model: "cpa/m1",
          models: { "cpa/m1": { alias: "first" } },
          modelPolicy: { allow: ["cpa/m1"] }
        }
      }
    };
    const adapter = createConfigAdapter(config);
    const models = adapter.listModels();

    // policy-exact 命中 + primary + alias：全字段形状（无目录参数字段时不出现键）
    expect(models.find((model) => model.ref === "cpa/m1")).toEqual({
      ref: "cpa/m1",
      providerId: "cpa",
      modelId: "m1",
      name: undefined,
      alias: "first",
      enabled: true,
      selectionSource: "policy-exact",
      isPrimary: true
    });
    // 未被 policy 覆盖的目录模型：enabled=false 且 selectionSource 键必须不存在
    const plain = models.find((model) => model.ref === "cpa/plain") as unknown as Record<string, unknown>;
    expect(plain).toEqual({
      ref: "cpa/plain",
      providerId: "cpa",
      modelId: "plain",
      name: undefined,
      alias: undefined,
      enabled: false,
      isPrimary: false
    });
    expect("selectionSource" in plain).toBe(false);
  });

  test("ProviderSummary 完整形状锁死：source 恒为字符串、disabled/count 语义不变", () => {
    const adapter = createConfigAdapter(sample);
    const providers = adapter.listProviders();
    expect(providers.map((provider) => provider.id)).toEqual(["nvidia", "DeepSeek", "minimax-portal"]);
    // 完整字段集合（toEqual 锁死；旧 consumers 的表格列依赖这些键）
    expect(providers[0]).toEqual({
      id: "nvidia",
      api: "openai-completions",
      baseUrl: "https://integrate.api.nvidia.com/v1",
      modelCount: 2,
      enabledModelCount: 2,
      containsPrimary: false,
      disabled: false,
      source: "config"
    });
    // StatusSummary 兼容形状（Dashboard 计数消费）
    expect(adapter.getStatus()).toEqual({
      primaryModel: "minimax-portal/MiniMax-M3",
      providerCount: 3,
      providerModelCount: 4,
      allowlistModelCount: 4,
      modelPolicyMode: "legacy",
      effectiveModelCount: 4
    });
  });

  test("config 同名遮蔽语义保持（兼容层 v1 简化）：同名插件 provider 不重复列出", () => {
    // 兼容层的既定行为（spec 2026-09-07 §3）：config 优先遮蔽同名插件条目。
    // 注意：这是兼容层的简化，统一 inventory（buildModelInventory）已改为并集——
    // 本测试只锁定旧 consumers 看到的形状，不作为新代码的语义依据。
    const config = structuredClone(sample);
    const adapter = createConfigAdapter(config, {
      pluginProviders: [pluginProvider({ providerId: "nvidia", models: [{ id: "plugin-only-model" }] })]
    });
    const nvidiaProviders = adapter.listProviders().filter((provider) => provider.id === "nvidia");
    expect(nvidiaProviders).toHaveLength(1);
    expect(nvidiaProviders[0]).toMatchObject({ source: "config", modelCount: 2 });
    // 插件同名 provider 的模型不进 listModels（config 接管成员资格）
    expect(adapter.listModels().find((model) => model.ref === "nvidia/plugin-only-model")).toBeUndefined();
  });
});
