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
import { MAX_PROVIDER_MODELS } from "../src/provider-model-limits";
import type { PluginProvider } from "../src/plugin-catalog";
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

  test("canonical Provider ref 操作会复用大小写漂移的 allowlist 条目", () => {
    const config: OpenClawConfig = {
      models: { providers: { CPA: { models: [{ id: "codex-free" }] } } },
      agents: { defaults: { models: { "cpa/codex-free": { alias: "free" } } } }
    };

    const enabled = enableModel(config, "CPA/codex-free", "free-again");
    expect(enabled.config.agents?.defaults?.models?.["CPA/codex-free"]).toBeUndefined();
    expect(enabled.config.agents?.defaults?.models?.["cpa/codex-free"]).toEqual({ alias: "free-again" });

    const disabled = disableModel(enabled.config, "CPA/codex-free");
    expect(disabled.config.agents?.defaults?.models?.["cpa/codex-free"]).toBeUndefined();
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

  test("rejects when provider catalog already at capacity", () => {
    const config = cloneSample();
    config.models!.providers!.nvidia!.models = Array.from({ length: MAX_PROVIDER_MODELS }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`
    }));

    expect(() => addProviderModel(config, "nvidia", {
      id: "one-too-many",
      enabled: false
    })).toThrow(/limit|20/i);
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

  test("defaults reasoning to true when adding a model", () => {
    const config = cloneSample();
    const result = addProviderModel(config, "nvidia", {
      id: "vendor/default-reasoning",
      enabled: false
    });

    expect(result.config.models?.providers?.nvidia?.models?.find(
      (model) => model.id === "vendor/default-reasoning"
    )?.reasoning).toBe(true);
  });

  test("preserves explicit reasoning false when adding a model", () => {
    const config = cloneSample();
    const result = addProviderModel(config, "nvidia", {
      id: "vendor/no-reasoning",
      enabled: false,
      reasoning: false
    });

    expect(result.config.models?.providers?.nvidia?.models?.find(
      (model) => model.id === "vendor/no-reasoning"
    )?.reasoning).toBe(false);
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

  test("编辑大小写漂移模型时迁移原 allowlist 和主模型引用", () => {
    const config: OpenClawConfig = {
      models: { providers: { CPA: { models: [{ id: "codex-free" }] } } },
      agents: { defaults: { model: "cpa/codex-free", models: { "cpa/codex-free": { alias: "free" } } } }
    };

    const result = updateProviderModel(config, "CPA/codex-free", {
      id: "codex-pro",
      enabled: true,
      alias: "pro"
    });

    expect(result.config.agents?.defaults?.models?.["cpa/codex-free"]).toBeUndefined();
    expect(result.config.agents?.defaults?.models?.["cpa/codex-pro"]).toEqual({ alias: "pro" });
    expect(result.config.agents?.defaults?.model).toBe("cpa/codex-pro");
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

describe("contextTokens 运行预算字段", () => {
  test("create 写入 contextWindow/contextTokens/maxTokens", () => {
    const config = cloneSample();
    const result = addProviderModel(config, "nvidia", {
      id: "vendor/budget-model",
      enabled: false,
      contextWindow: 200000,
      contextTokens: 128000,
      maxTokens: 16384
    });
    expect(result.config.models?.providers?.nvidia?.models?.find((m) => m.id === "vendor/budget-model")).toMatchObject({
      contextWindow: 200000,
      contextTokens: 128000,
      maxTokens: 16384
    });
  });

  test("edit 能修改或清空 contextTokens，未知字段不丢失", () => {
    const config = cloneSample();
    Object.assign(config.models!.providers!.nvidia!.models![0]!, {
      contextTokens: 100000,
      futureFlag: { nested: true }
    });

    const modified = updateProviderModel(config, "nvidia/deepseek-ai/deepseek-v4-flash", {
      id: "deepseek-ai/deepseek-v4-flash",
      enabled: true,
      contextTokens: 90000
    });
    expect(modified.config.models?.providers?.nvidia?.models?.[0]?.contextTokens).toBe(90000);
    expect(modified.config.models?.providers?.nvidia?.models?.[0]?.futureFlag).toEqual({ nested: true });

    // 省略 contextTokens 视为清空（与 contextWindow/maxTokens 一致的“显式可编辑 key”语义）
    const cleared = updateProviderModel(modified.config, "nvidia/deepseek-ai/deepseek-v4-flash", {
      id: "deepseek-ai/deepseek-v4-flash",
      enabled: true
    });
    expect(cleared.config.models?.providers?.nvidia?.models?.[0]?.contextTokens).toBeUndefined();
    expect(cleared.config.models?.providers?.nvidia?.models?.[0]?.futureFlag).toEqual({ nested: true });
  });

  test("contextTokens 为 0、负数、非整数时报错", () => {
    expect(() => addProviderModel(cloneSample(), "nvidia", {
      id: "bad-0",
      enabled: false,
      contextTokens: 0
    })).toThrow("contextTokens must be a positive integer");

    expect(() => addProviderModel(cloneSample(), "nvidia", {
      id: "bad-neg",
      enabled: false,
      contextTokens: -5
    })).toThrow("contextTokens must be a positive integer");

    expect(() => addProviderModel(cloneSample(), "nvidia", {
      id: "bad-float",
      enabled: false,
      contextTokens: 1.5
    })).toThrow("contextTokens must be a positive integer");
  });

  test("同时填写时 contextTokens > contextWindow 报错", () => {
    expect(() => addProviderModel(cloneSample(), "nvidia", {
      id: "over-budget",
      enabled: false,
      contextWindow: 100000,
      contextTokens: 200000
    })).toThrow(/contextTokens.*contextWindow|contextWindow.*contextTokens/);
  });

  test("contextWindow 未填写时允许单独设置 contextTokens", () => {
    const config = cloneSample();
    const result = addProviderModel(config, "nvidia", {
      id: "budget-only",
      enabled: false,
      contextTokens: 64000
    });
    const model = result.config.models?.providers?.nvidia?.models?.find((m) => m.id === "budget-only");
    expect(model?.contextTokens).toBe(64000);
    expect(model?.contextWindow).toBeUndefined();
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

describe("model operations 对象形态主模型与 fallback 保护", () => {
  /** 对象形态：primary = minimax-portal/MiniMax-M3，fallback 指向 nvidia 目录模型 */
  function objectPrimarySample() {
    const config = cloneSample();
    config.agents!.defaults!.model = {
      primary: "minimax-portal/MiniMax-M3",
      fallbacks: ["nvidia/deepseek-ai/deepseek-v4-flash"],
      customFlag: true
    } as never;
    return config;
  }

  test("setPrimaryModel 对对象形态保留 fallbacks 与未知键，仅更新 primary", () => {
    const config = objectPrimarySample();
    setPrimaryModel(config, "nvidia/deepseek-ai/deepseek-v4-flash");
    const model = config.agents!.defaults!.model as Record<string, unknown>;
    expect(model.primary).toBe("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(model.fallbacks).toEqual(["nvidia/deepseek-ai/deepseek-v4-flash"]);
    expect(model.customFlag).toBe(true);
  });

  test("对象形态主模型下删除主模型仍被拒绝", () => {
    const config = objectPrimarySample();
    expect(() =>
      removeProviderModel(config, "minimax-portal/MiniMax-M3", { force: false })
    ).toThrow("Model minimax-portal/MiniMax-M3 is the primary model");
  });

  test("带 newPrimary 删除主模型后新主模型保持对象形状", () => {
    const config = objectPrimarySample();
    removeProviderModel(config, "minimax-portal/MiniMax-M3", {
      force: false,
      newPrimary: "nvidia/deepseek-ai/deepseek-v4-flash"
    });
    const model = config.agents!.defaults!.model as Record<string, unknown>;
    expect(model.primary).toBe("nvidia/deepseek-ai/deepseek-v4-flash");
    expect(model.fallbacks).toEqual(["nvidia/deepseek-ai/deepseek-v4-flash"]);
    expect(model.customFlag).toBe(true);
  });

  test("force 删除对象形态主模型产生可读 warning", () => {
    const config = objectPrimarySample();
    const result = removeProviderModel(config, "minimax-portal/MiniMax-M3", { force: true });
    expect(result.warnings).toContain("Primary model minimax-portal/MiniMax-M3 was removed");
    expect(JSON.stringify(result.warnings)).not.toContain("[object Object]");
  });

  test("rename 迁移对象形态主模型且不丢 fallbacks", () => {
    const config = objectPrimarySample();
    updateProviderModel(config, "minimax-portal/MiniMax-M3", {
      id: "MiniMax-M3-renamed",
      enabled: true
    });
    const model = config.agents!.defaults!.model as Record<string, unknown>;
    expect(model.primary).toBe("minimax-portal/MiniMax-M3-renamed");
    expect(model.fallbacks).toEqual(["nvidia/deepseek-ai/deepseek-v4-flash"]);
    expect(model.customFlag).toBe(true);
  });

  test("删除命中 fallback 的模型被拒绝，force 也不可绕过，配置不变", () => {
    for (const force of [false, true]) {
      const config = objectPrimarySample();
      const before = structuredClone(config);
      expect(() => removeProviderModel(config, "nvidia/deepseek-ai/deepseek-v4-flash", { force })).toThrow(
        /agents\.defaults\.model\.fallbacks/
      );
      expect(config).toEqual(before);
    }
  });

  test("rename 命中 fallback 的模型被拒绝，配置不变", () => {
    const config = objectPrimarySample();
    const before = structuredClone(config);
    expect(() =>
      updateProviderModel(config, "nvidia/deepseek-ai/deepseek-v4-flash", {
        id: "deepseek-ai/deepseek-v4-renamed",
        enabled: true
      })
    ).toThrow(/agents\.defaults\.model\.fallbacks/);
    expect(config).toEqual(before);
  });
});

describe("插件 provider 的模型编排", () => {
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

  test("enableModel 接受启用中插件 provider 的 ref", () => {
    const config = cloneSample();
    const result = enableModel(config, "opencode/big-pickle", "oc-bp", [pluginProvider()]);
    expect(result.config.agents?.defaults?.models?.["opencode/big-pickle"]).toEqual({ alias: "oc-bp" });
  });

  test("enableModel 对未注入插件目录的 ref 仍拒绝", () => {
    const config = cloneSample();
    expect(() => enableModel(config, "opencode/big-pickle")).toThrow(/not defined in provider models/);
  });

  test("enableModel 拒绝插件 enabled=false 的 ref，报错指向 plugins.entries，配置不变", () => {
    const config = cloneSample();
    const before = structuredClone(config);
    expect(() => enableModel(config, "opencode/big-pickle", undefined, [pluginProvider({ enabled: false })]))
      .toThrow(/plugins\.entries\.opencode\.enabled=false/);
    expect(config).toEqual(before);
  });

  test("enableModel 拒绝插件目录里不存在的模型 id", () => {
    const config = cloneSample();
    expect(() => enableModel(config, "opencode/ghost", undefined, [pluginProvider()]))
      .toThrow(/not defined in provider models/);
  });

  test("插件 providerId 大小写不一致时照常放行，并按持久化规范折叠前缀", () => {
    const config = cloneSample();
    const result = enableModel(config, "OpenCode/hy3", undefined, [pluginProvider()]);
    expect(result.config.agents?.defaults?.models?.["opencode/hy3"]).toBeDefined();
    expect(result.config.agents?.defaults?.models?.["OpenCode/hy3"]).toBeUndefined();
  });

  test("setPrimaryModel 接受启用中插件 ref，拒绝停用插件 ref", () => {
    const config = cloneSample();
    expect(setPrimaryModel(config, "opencode/hy3", [pluginProvider()]).config.agents?.defaults?.model)
      .toBe("opencode/hy3");

    const other = cloneSample();
    const before = structuredClone(other);
    expect(() => setPrimaryModel(other, "opencode/hy3", [pluginProvider({ enabled: false })]))
      .toThrow(/plugins\.entries\.opencode\.enabled=false/);
    expect(other).toEqual(before);
  });

  test("providerId 与 models.providers 同名时模型目录取并集，停用插件不贡献成员", () => {
    const config = cloneSample();
    config.models!.providers!.opencode = { api: "openai-completions", models: [{ id: "local-only" }] };
    // 本地目录条目照常放行
    expect(enableModel(structuredClone(config), "opencode/local-only", undefined, [pluginProvider()])
      .config.agents?.defaults?.models?.["opencode/local-only"]).toBeDefined();
    // 兼容列表仍可按 config 遮蔽，但写入必须接受启用中的插件模型成员。
    expect(enableModel(structuredClone(config), "opencode/big-pickle", undefined, [pluginProvider()])
      .config.agents?.defaults?.models?.["opencode/big-pickle"]).toBeDefined();
    expect(setPrimaryModel(structuredClone(config), "opencode/big-pickle", [pluginProvider()])
      .config.agents?.defaults?.model).toBe("opencode/big-pickle");
    expect(() => enableModel(config, "opencode/big-pickle", undefined, [pluginProvider({ enabled: false })]))
      .toThrow(/plugins\.entries\.opencode\.enabled=false/);
  });

  test("restricted policy 下 enableModel 同步插件 exact ref", () => {
    const config = cloneSample();
    config.agents!.defaults!.modelPolicy = { allow: ["nvidia/z-ai/glm5.1"] };
    const result = enableModel(config, "opencode/big-pickle", undefined, [pluginProvider()]);
    expect(result.config.agents?.defaults?.modelPolicy?.allow).toContain("opencode/big-pickle");
  });

  test("disableModel 对插件 ref 无需目录校验即可移除 metadata 与 exact policy", () => {
    const config = cloneSample();
    config.agents!.defaults!.models!["opencode/big-pickle"] = { alias: "oc-bp" };
    // 保留另一条 exact，避免撞上「清空 policy 会变 unrestricted」的 fail-closed 断言
    config.agents!.defaults!.modelPolicy = { allow: ["opencode/big-pickle", "nvidia/z-ai/glm5.1"] };
    const result = disableModel(config, "opencode/big-pickle");
    expect(result.config.agents?.defaults?.models?.["opencode/big-pickle"]).toBeUndefined();
    expect(result.config.agents?.defaults?.modelPolicy?.allow).toEqual(["nvidia/z-ai/glm5.1"]);
  });

  test("插件 ref 是 policy 最后一条 exact 时 disableModel fail closed", () => {
    const config = cloneSample();
    config.agents!.defaults!.modelPolicy = { allow: ["opencode/big-pickle"] };
    const before = structuredClone(config);
    expect(() => disableModel(config, "opencode/big-pickle")).toThrow(/unrestricted/);
    expect(config).toEqual(before);
  });

  test("插件 provider 的模型不可经 addProviderModel / updateProviderModel / removeProviderModel 写入", () => {
    for (const mutate of [
      () => addProviderModel(cloneSample(), "opencode/new-model", { enabled: false }),
      () => updateProviderModel(cloneSample(), "opencode/big-pickle", { id: "renamed", enabled: false }),
      () => removeProviderModel(cloneSample(), "opencode/big-pickle", { force: true })
    ]) {
      expect(mutate).toThrow();
    }
  });
});
