import { describe, expect, test } from "bun:test";
import { buildModelInventory } from "../src/model-inventory";
import type {
  ModelInventory,
  ModelInventoryEntry,
  ModelPolicyRuleEntry,
  ModelPluginDescriptor,
  ProviderInventoryEntry
} from "../src/model-inventory";
import type { PluginProvider } from "../src/plugin-catalog";
import type { RuntimeModelEntry, RuntimeModelSnapshot } from "../src/runtime-model-catalog";
import type { OpenClawConfig } from "../src/types";

/** 构造完整探测的 runtime snapshot；用例按需覆写。 */
function makeSnapshot(overrides: Partial<RuntimeModelSnapshot> = {}): RuntimeModelSnapshot {
  return {
    fallbackRefs: [],
    allowedRefs: [],
    configuredModels: [],
    allModels: [],
    completeness: { status: true, configuredList: true, allList: true },
    diagnostics: [],
    capturedAt: "2026-09-09T00:00:00.000Z",
    ...overrides
  };
}

function rt(ref: string, extra: Partial<RuntimeModelEntry> = {}): RuntimeModelEntry {
  return { ref, tags: [], ...extra };
}

function pluginProvider(fields: Partial<PluginProvider> = {}): PluginProvider {
  return {
    pluginId: "plug",
    providerId: "plugin",
    origin: "npm",
    enabled: true,
    models: [],
    apiKeyEnvVars: [],
    ...fields
  };
}

function byRef(inventory: ModelInventory): Map<string, ModelInventoryEntry> {
  return new Map(inventory.models.map((model) => [`${model.providerId}/${model.modelId}`, model]));
}

function byProvider(inventory: ModelInventory): Map<string, ProviderInventoryEntry> {
  return new Map(inventory.providers.map((provider) => [provider.providerId, provider]));
}

test("默认选择器使用 Gateway 集合；闲置目录与停用插件不制造待处理", () => {
  const inventory = buildModelInventory({
    config: { agents: { defaults: { models: { "idle/missing": {} }, modelPolicy: { allow: ["active/one"] } } } },
    pluginProviders: [pluginProvider({ pluginId: "anthropic", providerId: "anthropic", enabled: false, models: [{ id: "unused" }] })],
    runtime: makeSnapshot({
      configuredModels: [rt("idle/missing", { missing: true })],
      allModels: [rt("catalog/unused", { available: false })],
      pickerModels: [rt("active/one", { available: true })], pickerSource: "gateway"
    })
  });
  expect(inventory.models.filter((m: any) => m.pickerVisible).map(m => m.ref)).toEqual(["active/one"]);
  expect(inventory.models.filter((m: any) => m.needsAttention).map(m => m.ref)).toEqual([]);
  expect(inventory.models.some(m => m.ref === "anthropic/unused")).toBe(false);
  expect(inventory.models.some(m => m.ref === "catalog/unused")).toBe(false);
  expect(inventory.plugins.find(p => p.id === "anthropic")?.enabled).toBe(false);
});

describe("buildModelInventory：来源并集与状态分离", () => {
  const config: OpenClawConfig = {
    models: {
      providers: {
        cpa: { models: [{ id: "main" }, { id: "other" }] },
        deepseek: { models: [{ id: "deepseek-chat" }] }
      }
    },
    agents: {
      defaults: {
        model: { primary: "cpa/main", fallbacks: ["cpa/fallback"] },
        models: { "legacy/orphan": {} },
        modelPolicy: { allow: ["plugin/*", "cpa/*", "ghost/missing", 42, { token: "SECRET" }] }
      }
    }
  };

  const pluginProviders = [
    pluginProvider({ pluginId: "plug", providerId: "plugin", models: [{ id: "live" }] })
  ];

  const runtime = makeSnapshot({
    defaultModel: "cpa/main",
    fallbackRefs: ["cpa/fallback"],
    allowedRefs: ["cpa/main", "plugin/live", "ghost/missing"],
    configuredModels: [
      rt("cpa/main", { name: "Main", available: true, missing: false }),
      rt("plugin/live", { available: true, missing: false })
    ],
    allModels: [rt("cpa/main", { available: true }), rt("plugin/live", { available: true })]
  });

  test("policy-only exact ref：provider-not-found 不可用 + 可删除精确引用", () => {
    const inventory = buildModelInventory({ config, pluginProviders, runtime });
    const models = byRef(inventory);
    expect(models.get("ghost/missing")).toMatchObject({
      ref: "ghost/missing",
      catalogSources: [],
      referenceSources: ["policy-exact"],
      policyMode: "restricted",
      selectionSource: "policy-exact",
      policyAllowed: true,
      availability: "unavailable",
      availabilityReasons: ["provider-not-found"],
      pluginIds: [],
      capabilities: {
        // 不可用行走「处理」流程（spec §11.2），不提供普通启停开关
        canTogglePolicy: false,
        canSetPrimary: false,
        canEditCatalogEntry: false,
        canMaterializeConfigModel: false,
        canRemovePolicyExactRef: true
      }
    });
  });

  test("plugin + runtime 双来源模型：并集、policy-wildcard 来源与可用", () => {
    const inventory = buildModelInventory({ config, pluginProviders, runtime });
    const models = byRef(inventory);
    expect(models.get("plugin/live")).toMatchObject({
      ref: "plugin/live",
      catalogSources: ["plugin-manifest", "openclaw-runtime"],
      referenceSources: ["policy-wildcard"],
      policyAllowed: true,
      availability: "available",
      availabilityReasons: [],
      pluginIds: ["plug"],
      capabilities: {
        canSetPrimary: true,
        canEditCatalogEntry: false,
        canTogglePolicy: false
      }
    });
  });

  test("config 主模型：primary + wildcard 来源，可用但不可再设为主", () => {
    const inventory = buildModelInventory({ config, pluginProviders, runtime });
    const models = byRef(inventory);
    expect(models.get("cpa/main")).toMatchObject({
      ref: "cpa/main",
      catalogSources: ["config", "openclaw-runtime"],
      referenceSources: ["primary", "policy-wildcard"],
      selectionSource: "policy-wildcard",
      policyAllowed: true,
      availability: "available",
      availabilityReasons: [],
      capabilities: {
        canEditCatalogEntry: true,
        canSetPrimary: false,
        canTogglePolicy: false,
        canMaterializeConfigModel: false,
        canRemovePolicyExactRef: false
      }
    });
  });

  test("config 与插件同名 Provider 的模型行并集、runtime 来源补全 Provider 行", () => {
    const inventory = buildModelInventory({ config, pluginProviders, runtime });
    const models = byRef(inventory);
    expect(models.get("cpa/other")).toMatchObject({
      catalogSources: ["config"],
      referenceSources: ["policy-wildcard"],
      policyAllowed: true,
      availability: "unavailable",
      availabilityReasons: ["model-not-in-catalog"]
    });
    expect(models.get("deepseek/deepseek-chat")).toMatchObject({
      catalogSources: ["config"],
      referenceSources: [],
      policyAllowed: false,
      availability: "unavailable",
      availabilityReasons: ["model-not-in-catalog"]
    });
    expect(models.get("deepseek/deepseek-chat")?.selectionSource).toBeUndefined();
    // cpa Provider 因运行时目录出现 cpa/main 而获得 openclaw-runtime 来源
    expect(byProvider(inventory).get("cpa")).toMatchObject({
      sources: ["config", "openclaw-runtime"]
    });
  });

  test("fallback 引用行与 legacy metadata 悬空行保留为 reference-only", () => {
    const inventory = buildModelInventory({ config, pluginProviders, runtime });
    const models = byRef(inventory);
    expect(models.get("cpa/fallback")).toMatchObject({
      catalogSources: [],
      referenceSources: ["fallback"],
      policyAllowed: false,
      availability: "unavailable",
      availabilityReasons: ["model-not-in-catalog"],
      capabilities: { canRemovePolicyExactRef: false }
    });
    expect(models.get("legacy/orphan")).toMatchObject({
      catalogSources: [],
      referenceSources: ["legacy-metadata"],
      policyAllowed: false,
      availability: "unavailable",
      availabilityReasons: ["provider-not-found"]
    });
    // selectionSource 未定义：行内没有该键（形状守恒）
    expect(models.get("legacy/orphan")?.selectionSource).toBeUndefined();
  });

  test("provider 行：sources/pluginIds/计数，不含仅引用的 provider", () => {
    const inventory = buildModelInventory({ config, pluginProviders, runtime });
    expect(inventory.providers.map((provider) => provider.providerId)).toEqual(["cpa", "deepseek", "plugin"]);
    const providers = byProvider(inventory);
    expect(providers.get("cpa")).toMatchObject({
      sources: ["config", "openclaw-runtime"],
      pluginIds: [],
      pluginEnabled: null,
      disabled: false,
      availability: "available",
      availabilityReasons: [],
      modelCount: 3,
      policyAllowedModelCount: 2,
      availableModelCount: 1,
      unavailableModelCount: 2,
      capabilities: {
        canEditConnection: true,
        canManageModels: true,
        canDisableProvider: true,
        canSetApiKey: true
      }
    });
    expect(providers.get("deepseek")).toMatchObject({
      sources: ["config"],
      modelCount: 1,
      policyAllowedModelCount: 0,
      availableModelCount: 0,
      unavailableModelCount: 1,
      availability: "unavailable"
    });
    expect(byProvider(inventory).get("plugin")).toMatchObject({
      sources: ["plugin-manifest", "openclaw-runtime"],
      pluginIds: ["plug"],
      pluginEnabled: true,
      modelCount: 1,
      policyAllowedModelCount: 1,
      availableModelCount: 1,
      unavailableModelCount: 0,
      availability: "available",
      capabilities: {
        canEditConnection: false,
        canManageModels: false,
        canDisableProvider: false,
        canSetApiKey: false
      }
    });
  });

  test("policyRules 投影：exact 可删、wildcard 只读、非字符串条目不回显值", () => {
    const inventory = buildModelInventory({ config, pluginProviders, runtime });
    const rules = inventory.policyRules;
    const exact = rules.find((rule) => rule.kind === "exact") as ModelPolicyRuleEntry;
    expect(exact).toMatchObject({
      value: "ghost/missing",
      matchedModelCount: 1,
      unavailableModelCount: 1,
      removable: true
    });
    const cpaWildcard = rules.find((rule) => rule.value === "cpa/*") as ModelPolicyRuleEntry;
    expect(cpaWildcard).toMatchObject({ kind: "wildcard", matchedModelCount: 2, unavailableModelCount: 1, removable: false });
    expect(rules.find((rule) => rule.value === "plugin/*")).toMatchObject({
      kind: "wildcard",
      matchedModelCount: 1,
      unavailableModelCount: 0,
      removable: false
    });
    // 两个非字符串条目只以 index + invalid 呈现，值不回显
    const invalids = rules.filter((rule) => rule.kind === "invalid");
    expect(invalids.map((rule) => rule.invalidIndex)).toEqual([3, 4]);
    expect(invalids.every((rule) => rule.value === "" && rule.removable === false && rule.matchedModelCount === 0)).toBe(true);
    // 排序稳定：exact → wildcard（字典序）→ invalid（index 序）
    expect(rules.map((rule) => rule.kind)).toEqual(["exact", "wildcard", "wildcard", "invalid", "invalid"]);
    // secret-free：对象条目的值绝不进入输出
    expect(JSON.stringify(inventory)).not.toContain("SECRET");
  });

  test("policyRules：exact 命中主模型/fallback 时 removable=false（规则行与模型行 fail-closed 对齐）", () => {
    const protectedConfig: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "main" }] } } },
      agents: {
        defaults: {
          model: { primary: "pm/pm-model", fallbacks: ["fb/fb-model"] },
          modelPolicy: { allow: ["pm/pm-model", "fb/fb-model", "cpa/main"] }
        }
      }
    };
    const runtime = makeSnapshot({ configuredModels: [rt("cpa/main", { available: true })] });
    const inventory = buildModelInventory({ config: protectedConfig, runtime });
    const byValue = new Map(inventory.policyRules.map((rule) => [rule.value, rule]));
    expect(byValue.get("pm/pm-model")).toMatchObject({ kind: "exact", removable: false });
    expect(byValue.get("fb/fb-model")).toMatchObject({ kind: "exact", removable: false });
    expect(byValue.get("cpa/main")).toMatchObject({ kind: "exact", removable: true });
  });

  test("summary 计数与 plugins 回显（无 descriptor 输入时从 pluginProviders 派生）", () => {
    const inventory = buildModelInventory({ config, pluginProviders, runtime });
    expect(inventory.summary).toEqual({
      modelCount: 7,
      policyAllowedCount: 4,
      availableCount: 2,
      unavailableCount: 5,
      unknownCount: 0
    });
    expect(inventory.plugins).toEqual([
      { id: "plug", origin: "npm", enabled: true, providerIds: ["plugin"], nonModelCapabilities: [] }
    ]);
    expect(inventory.diagnostics).toEqual([]);
  });

  test("纯函数：不修改任何输入", () => {
    const configCopy = JSON.parse(JSON.stringify(config)) as OpenClawConfig;
    const pluginProvidersCopy = JSON.parse(JSON.stringify(pluginProviders)) as PluginProvider[];
    const runtimeCopy = JSON.parse(JSON.stringify(runtime)) as RuntimeModelSnapshot;
    const pluginsInput: ModelPluginDescriptor[] = [
      { id: "plug", origin: "npm", enabled: true, providerIds: ["plugin"], nonModelCapabilities: [] }
    ];
    const pluginsInputCopy = JSON.parse(JSON.stringify(pluginsInput)) as ModelPluginDescriptor[];
    const diagnosticsInput = [{ command: "list", code: "invalid-json", message: "openclaw models list --json" }] as const;
    const inventory = buildModelInventory({
      config,
      pluginProviders,
      plugins: pluginsInput,
      runtime: { ...runtime, diagnostics: [...diagnosticsInput] }
    });
    expect(config).toEqual(configCopy);
    expect(pluginProviders).toEqual(pluginProvidersCopy);
    expect(pluginsInput).toEqual(pluginsInputCopy);
    expect(runtime).toEqual(runtimeCopy);
    // 输出不与输入共享数组：改输出不污染输入（缓存 snapshot 安全）
    const outputPlugin = inventory.plugins[0]!;
    outputPlugin.providerIds.push("mutated");
    inventory.diagnostics.pop();
    expect(pluginsInputCopy[0]?.providerIds).toEqual(["plugin"]);
    expect(pluginsInput[0]?.providerIds).toEqual(["plugin"]);
    expect(inventory.diagnostics).toHaveLength(0);
  });
});

describe("buildModelInventory：大小写折叠与多来源合并", () => {
  test("disabledProviderIds 与 apiKeyEnvVars 查找两侧都做大小写折叠", () => {
    // config Provider 大写 CPA；禁用列表与插件 apiKeyEnvVars 用小写/大写混合大小写
    const config: OpenClawConfig = {
      models: { providers: { CPA: { models: [{ id: "main" }] } } },
      agents: { defaults: { modelPolicy: { allow: ["cpa/main"] } } }
    };
    const pluginProviders = [
      pluginProvider({
        pluginId: "plug",
        providerId: "CPA",
        enabled: true,
        apiKeyEnvVars: ["CPA_API_KEY"],
        models: []
      })
    ];
    const runtime = makeSnapshot({ configuredModels: [rt("cpa/main", { available: true })] });
    const inventory = buildModelInventory({ config, pluginProviders, disabledProviderIds: ["cpa"], runtime });
    // disabledProviderIds（小写）命中大写 config Provider：两侧折叠后比较
    expect(byProvider(inventory).get("CPA")).toMatchObject({ disabled: true });
    // 插件 providerId（大写）的 apiKeyEnvVars 非空 → 该 Provider 可设 Key
    expect(byProvider(inventory).get("CPA")?.capabilities.canSetApiKey).toBe(true);
  });

  test("config CPA 与插件 cpa 同名 Provider 做并集而非遮蔽", () => {
    const config: OpenClawConfig = {
      models: { providers: { CPA: { models: [{ id: "main" }, { id: "cfg-only" }] } } },
      agents: { defaults: { modelPolicy: { allow: ["cpa/main"] } } }
    };
    const pluginProviders = [
      pluginProvider({ pluginId: "plug", providerId: "cpa", models: [{ id: "main" }, { id: "plugin-only" }] })
    ];
    const runtime = makeSnapshot({
      allowedRefs: ["cpa/main"],
      configuredModels: [rt("cpa/main", { available: true })]
    });
    const inventory = buildModelInventory({ config, pluginProviders, runtime });
    const models = byRef(inventory);

    // config 与插件同名模型合并为一行，来源并集（含运行时目录），config 大小写优先展示
    expect(models.get("cpa/main")).toMatchObject({
      ref: "CPA/main",
      catalogSources: ["config", "plugin-manifest", "openclaw-runtime"],
      referenceSources: ["policy-exact"],
      availability: "available"
    });
    // config-only / plugin-only 模型各自保留，互不遮蔽
    expect(models.get("cpa/cfg-only")).toMatchObject({ catalogSources: ["config"] });
    expect(models.get("cpa/plugin-only")).toMatchObject({ catalogSources: ["plugin-manifest"], pluginIds: ["plug"] });

    const providers = byProvider(inventory);
    expect(providers.get("CPA")).toMatchObject({
      sources: ["config", "plugin-manifest", "openclaw-runtime"],
      pluginIds: ["plug"],
      pluginEnabled: true,
      modelCount: 3
    });
  });

  test("三目录来源与四引用来源的固定枚举优先级排序", () => {
    const config: OpenClawConfig = {
      models: { providers: { mix: { models: [{ id: "m" }] } } },
      agents: {
        defaults: {
          model: { primary: "mix/m", fallbacks: ["mix/m"] },
          models: { "mix/m": {} },
          modelPolicy: { allow: ["mix/m"] }
        }
      }
    };
    const pluginProviders = [pluginProvider({ providerId: "mix", models: [{ id: "m" }] })];
    const runtime = makeSnapshot({
      configuredModels: [rt("mix/m", { available: true })],
      allModels: [rt("mix/m")]
    });
    const inventory = buildModelInventory({ config, pluginProviders, runtime });
    const model = byRef(inventory).get("mix/m") as ModelInventoryEntry;
    expect(model.catalogSources).toEqual(["config", "plugin-manifest", "openclaw-runtime"]);
    expect(model.referenceSources).toEqual(["primary", "fallback", "legacy-metadata", "policy-exact"]);
    expect(model.availability).toBe("available");
    // primary + exact：canSetPrimary false，canRemovePolicyExactRef false（fail closed）
    expect(model.capabilities).toMatchObject({ canSetPrimary: false, canRemovePolicyExactRef: false });
  });
});

describe("buildModelInventory：availability 证据规则（独立用例）", () => {
  test("plugin-disabled：插件停用使其贡献模型不可用", () => {
    const config: OpenClawConfig = {
      models: { providers: {} },
      agents: { defaults: { modelPolicy: { allow: ["plugin/*"] } } }
    };
    const pluginProviders = [
      pluginProvider({ pluginId: "plug", providerId: "plugin", enabled: false, models: [{ id: "off" }] })
    ];
    const runtime = makeSnapshot();
    const inventory = buildModelInventory({ config, pluginProviders, runtime });
    expect(byRef(inventory).has("plugin/off")).toBe(false);
    expect(inventory.plugins[0]?.enabled).toBe(false);
  });

  test("provider-not-found：policy 引用了不存在的 Provider", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { modelPolicy: { allow: ["ghost/missing"] } } }
    };
    const inventory = buildModelInventory({ config, runtime: makeSnapshot() });
    expect(byRef(inventory).get("ghost/missing")).toMatchObject({
      availability: "unavailable",
      availabilityReasons: ["provider-not-found"],
      catalogSources: []
    });
  });

  test("model-not-in-catalog：Provider 存在但精确 ref 不在任何目录", () => {
    const config: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "main" }] } } },
      agents: { defaults: { modelPolicy: { allow: ["cpa/gone"] } } }
    };
    const runtime = makeSnapshot({ configuredModels: [rt("cpa/main", { available: true })] });
    const inventory = buildModelInventory({ config, runtime });
    expect(byRef(inventory).get("cpa/gone")).toMatchObject({
      availability: "unavailable",
      availabilityReasons: ["model-not-in-catalog"],
      // 最后一条 exact 不能删成 unrestricted。
      capabilities: { canRemovePolicyExactRef: false, canTogglePolicy: false }
    });
  });

  test("probe-failed：目录探测不完整时一律 unknown，不开放任何写能力", () => {
    const config: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "main" }, { id: "other" }] } } },
      agents: { defaults: { modelPolicy: { allow: ["cpa/*", "cpa/other"] } } }
    };
    const runtime = makeSnapshot({
      completeness: { status: true, configuredList: false, allList: false }
    });
    const inventory = buildModelInventory({ config, runtime });
    const models = byRef(inventory);
    for (const ref of ["cpa/main", "cpa/other"]) {
      expect(models.get(ref)).toMatchObject({
        availability: "unknown",
        availabilityReasons: ["probe-failed"],
        capabilities: {
          canTogglePolicy: false,
          canSetPrimary: false,
          canEditCatalogEntry: false,
          canMaterializeConfigModel: false,
          canRemovePolicyExactRef: false
        }
      });
    }
    expect(inventory.summary.unknownCount).toBe(2);
    expect(inventory.summary.availableCount).toBe(0);
    expect(inventory.summary.unavailableCount).toBe(0);
  });

  test("Provider 聚合：目录不完整时否定标记不能开放清理", () => {
    const config: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "main" }, { id: "other" }] } } },
      agents: { defaults: { modelPolicy: { allow: ["cpa/*", "cpa/pending"] } } }
    };
    // cpa/main 在 configured 列表明确 available=false（unavailable）；
    // cpa/pending 只有 policy 引用、无任何目录证据，且 allList 探测失败（unknown）
    const runtime = makeSnapshot({
      configuredModels: [rt("cpa/main", { available: false })],
      completeness: { status: true, configuredList: true, allList: false }
    });
    const inventory = buildModelInventory({ config, runtime });
    expect(byRef(inventory).get("cpa/main")).toMatchObject({ availability: "unknown", availabilityReasons: ["probe-failed"] });
    expect(byRef(inventory).get("cpa/pending")).toMatchObject({ availability: "unknown", availabilityReasons: ["probe-failed"] });
    expect(byProvider(inventory).get("cpa")).toMatchObject({
      availability: "unknown",
      availabilityReasons: ["probe-failed"],
      availableModelCount: 0,
      unavailableModelCount: 0
    });
  });

  test("runtime configured list 可用优先于 allList 失败（可用判断只需当前列表）", () => {
    const config: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "main" }] } } },
      agents: { defaults: { modelPolicy: { allow: ["cpa/other"] } } }
    };
    const runtime = makeSnapshot({
      configuredModels: [rt("cpa/main", { available: true })],
      completeness: { status: true, configuredList: true, allList: false }
    });
    const inventory = buildModelInventory({ config, runtime });
    expect(byRef(inventory).get("cpa/main")).toMatchObject({ availability: "available", availabilityReasons: [] });
    // 有 policy 引用但无目录证据、allList 探测失败 → unknown 而非 unavailable
    expect(byRef(inventory).get("cpa/other")).toMatchObject({
      availability: "unknown",
      availabilityReasons: ["probe-failed"]
    });
  });

  test("--all 目录条目的明确标记决定可用性（configured 缺失时）", () => {
    const config: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "main" }] } } },
      agents: { defaults: { modelPolicy: { allow: ["cpa/all-ok", "cpa/all-off"] } } }
    };
    // all-ok 只出现在 --all 且 available=true；all-off 在 --all 标记 available=false
    const runtime = makeSnapshot({
      configuredModels: [rt("cpa/main", { available: true })],
      allModels: [rt("cpa/main"), rt("cpa/all-ok", { available: true }), rt("cpa/all-off", { available: false })]
    });
    const inventory = buildModelInventory({ config, runtime });
    const models = byRef(inventory);
    // OpenClaw 的明确 available 事实优先于 configured 列表缺席（spec §7.2 第 1 条）
    expect(models.get("cpa/all-ok")).toMatchObject({
      catalogSources: ["openclaw-runtime"],
      referenceSources: ["policy-exact"],
      availability: "available",
      availabilityReasons: []
    });
    // --all 条目 available=false → 明确不可用
    expect(models.get("cpa/all-off")).toMatchObject({
      availability: "unavailable",
      availabilityReasons: []
    });
  });

  test("--all 条目 missing=true → unavailable/model-not-in-catalog", () => {
    const config: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "main" }] } } },
      agents: { defaults: { modelPolicy: { allow: ["cpa/all-missing"] } } }
    };
    const runtime = makeSnapshot({
      configuredModels: [rt("cpa/main", { available: true })],
      allModels: [rt("cpa/main"), rt("cpa/all-missing", { missing: true })]
    });
    const inventory = buildModelInventory({ config, runtime });
    expect(byRef(inventory).get("cpa/all-missing")).toMatchObject({
      availability: "unavailable",
      availabilityReasons: ["model-not-in-catalog"]
    });
  });

  test("runtime-only Provider 的模型在 --all 标记 available 时不误报 provider-not-found", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { modelPolicy: { allow: ["rt/*"] } } }
    };
    const runtime = makeSnapshot({
      configuredModels: [rt("rt/only", { available: true })],
      allModels: [rt("rt/only", { available: true }), rt("rt/extra", { available: true })]
    });
    const inventory = buildModelInventory({ config, runtime });
    const models = byRef(inventory);
    // Provider 行因 --all 的明确 available 证据成立；其模型行可用而非 provider-not-found
    expect(models.get("rt/extra")).toMatchObject({
      catalogSources: ["openclaw-runtime"],
      referenceSources: ["policy-wildcard"],
      availability: "available",
      availabilityReasons: [],
      capabilities: { canSetPrimary: true }
    });
    expect(byProvider(inventory).get("rt")).toMatchObject({
      sources: ["openclaw-runtime"],
      pluginEnabled: null,
      availability: "available"
    });
  });

  test("runtime 条目 missing=true / available=false 的映射", () => {
    const config: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "gone" }, { id: "rejected" }] } } }
    };
    const runtime = makeSnapshot({
      configuredModels: [rt("cpa/gone", { available: true, missing: true }), rt("cpa/rejected", { available: false })]
    });
    const inventory = buildModelInventory({ config, runtime });
    const models = byRef(inventory);
    expect(models.get("cpa/gone")).toMatchObject({ availability: "unavailable", availabilityReasons: ["model-not-in-catalog"] });
    expect(models.get("cpa/rejected")).toMatchObject({ availability: "unavailable", availabilityReasons: [] });
  });
});

describe("buildModelInventory：capability 从事实推导", () => {
  test("primary/fallback 命中精确 policy 仍 fail closed，不可删除引用", () => {
    const config: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "main" }] } } },
      agents: {
        defaults: {
          model: { primary: "pm/pm-model", fallbacks: ["fb/fb-model"] },
          modelPolicy: { allow: ["pm/pm-model", "fb/fb-model", "fb/other"] }
        }
      }
    };
    const runtime = makeSnapshot({ configuredModels: [rt("cpa/main", { available: true })] });
    const inventory = buildModelInventory({ config, runtime });
    const models = byRef(inventory);
    expect(models.get("pm/pm-model")).toMatchObject({
      referenceSources: ["primary", "policy-exact"],
      availability: "unavailable",
      capabilities: { canSetPrimary: false, canRemovePolicyExactRef: false }
    });
    expect(models.get("fb/fb-model")).toMatchObject({
      referenceSources: ["fallback", "policy-exact"],
      capabilities: { canRemovePolicyExactRef: false }
    });
    // 非主模型/回退的精确条目可安全删除
    expect(models.get("fb/other")).toMatchObject({
      referenceSources: ["policy-exact"],
      capabilities: { canRemovePolicyExactRef: true }
    });
  });

  test("oc-switch 可逆关闭的 Provider：禁用只影响 Provider 行 disabled 状态", () => {
    const config: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "main" }] } } },
      agents: { defaults: { modelPolicy: { allow: ["cpa/main"] } } }
    };
    const runtime = makeSnapshot({ configuredModels: [rt("cpa/main", { available: true })] });
    const inventory = buildModelInventory({ config, disabledProviderIds: ["CPA"], runtime });
    const models = byRef(inventory);
    // 可逆关闭不改变运行时可用性事实（OpenClaw 侧仍可用），只反映在 Provider 行 disabled
    expect(models.get("cpa/main")).toMatchObject({
      availability: "available",
      capabilities: {
        canSetPrimary: false,
        canMaterializeConfigModel: false,
        canEditCatalogEntry: true
      }
    });
    expect(byProvider(inventory).get("cpa")).toMatchObject({ disabled: true });
  });

  test("runtime-only 可用模型可设主模型，但不可补入不存在的 config Provider", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { modelPolicy: { allow: ["rt/*"] } } }
    };
    const runtime = makeSnapshot({ configuredModels: [rt("rt/only", { available: true })] });
    const inventory = buildModelInventory({ config, runtime });
    expect(byRef(inventory).get("rt/only")).toMatchObject({
      catalogSources: ["openclaw-runtime"],
      referenceSources: ["policy-wildcard"],
      availability: "available",
      capabilities: {
        canSetPrimary: true,
        canEditCatalogEntry: false,
        canMaterializeConfigModel: false,
        canTogglePolicy: false
      }
    });
    expect(byProvider(inventory).get("rt")).toMatchObject({
      sources: ["openclaw-runtime"],
      pluginEnabled: null,
      availability: "available"
    });
  });
});

describe("buildModelInventory：policy 三态既有语义回归", () => {
  test("legacy：metadata ref 为唯一有效 selection 来源，policyRules 为空", () => {
    const config: OpenClawConfig = {
      models: { providers: { lp: { models: [{ id: "one" }] } } },
      agents: { defaults: { models: { "lp/one": {}, "lp/dangling": {} } } }
    };
    const runtime = makeSnapshot({ configuredModels: [rt("lp/one", { available: true })] });
    const inventory = buildModelInventory({ config, runtime });
    const models = byRef(inventory);
    expect(models.get("lp/one")).toMatchObject({
      catalogSources: ["config", "openclaw-runtime"],
      referenceSources: ["legacy-metadata"],
      policyMode: "legacy",
      selectionSource: "legacy",
      policyAllowed: true,
      availability: "available"
    });
    expect(models.get("lp/dangling")).toMatchObject({
      referenceSources: ["legacy-metadata"],
      policyAllowed: true,
      selectionSource: "legacy",
      availability: "unavailable",
      availabilityReasons: ["model-not-in-catalog"]
    });
    expect(inventory.policyRules).toEqual([]);
    expect(inventory.plugins).toEqual([]);
  });

  test("unrestricted：目录模型放开，reference-only 行无 selection", () => {
    const config: OpenClawConfig = {
      models: { providers: { up: { models: [{ id: "one" }] } } },
      agents: { defaults: { models: { "up/dangle": {} }, modelPolicy: { allow: [] } } }
    };
    const runtime = makeSnapshot({ configuredModels: [rt("up/one", { available: true })] });
    const inventory = buildModelInventory({ config, runtime });
    const models = byRef(inventory);
    expect(models.get("up/one")).toMatchObject({
      policyMode: "unrestricted",
      selectionSource: "unrestricted",
      policyAllowed: true,
      availability: "available"
    });
    expect(models.get("up/dangle")).toMatchObject({
      referenceSources: ["legacy-metadata"],
      // unrestricted 只开放目录模型，不凭 metadata 创造目录成员。
      policyAllowed: false,
      availability: "unavailable",
      availabilityReasons: ["model-not-in-catalog"]
    });
    expect(models.get("up/dangle")?.selectionSource).toBeUndefined();
    expect(inventory.policyRules).toEqual([]);
  });
});

describe("buildModelInventory：插件 descriptor 与多 Provider 归属", () => {
  test("descriptor.enabled 优先于 pluginProvider.enabled，且 inventory.plugins 原样回显", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { modelPolicy: { allow: ["plugin/*"] } } }
    };
    const pluginProviders = [
      pluginProvider({ pluginId: "plug", providerId: "plugin", enabled: true, models: [{ id: "live" }] })
    ];
    const plugins: ModelPluginDescriptor[] = [
      {
        id: "plug",
        name: "Plugin",
        origin: "npm",
        enabled: false,
        providerIds: ["plugin"],
        nonModelCapabilities: ["speech"]
      }
    ];
    const runtime = makeSnapshot();
    const inventory = buildModelInventory({ config, pluginProviders, plugins, runtime });
    expect(byRef(inventory).has("plugin/live")).toBe(false);
    expect(byProvider(inventory).get("plugin")).toMatchObject({ pluginEnabled: false, pluginIds: ["plug"] });
    expect(inventory.plugins).toEqual(plugins);
  });

  test("一个插件贡献多个 Provider：共享插件 id 与开关", () => {
    const config: OpenClawConfig = {
      agents: { defaults: { modelPolicy: { allow: ["xiaomi/*", "xiaomi-token-plan/*"] } } }
    };
    const pluginProviders = [
      pluginProvider({ pluginId: "xiaomi-plugin", providerId: "xiaomi", models: [{ id: "m1" }, { id: "m2" }] }),
      pluginProvider({ pluginId: "xiaomi-plugin", providerId: "xiaomi-token-plan", models: [{ id: "t1" }, { id: "t2" }] })
    ];
    const plugins: ModelPluginDescriptor[] = [
      {
        id: "xiaomi-plugin",
        origin: "npm",
        enabled: true,
        providerIds: ["xiaomi", "xiaomi-token-plan"],
        nonModelCapabilities: ["speech", "other-contracts"]
      }
    ];
    const runtime = makeSnapshot({
      configuredModels: [
        rt("xiaomi/m1", { available: true }),
        rt("xiaomi-token-plan/t1", { available: true })
      ]
    });
    const inventory = buildModelInventory({ config, pluginProviders, plugins, runtime });
    expect(inventory.providers.map((provider) => provider.providerId)).toEqual(["xiaomi", "xiaomi-token-plan"]);
    for (const provider of inventory.providers) {
      expect(provider).toMatchObject({
        pluginIds: ["xiaomi-plugin"],
        pluginEnabled: true,
        sources: ["plugin-manifest", "openclaw-runtime"]
      });
    }
    expect(byRef(inventory).get("xiaomi/m1")).toMatchObject({ pluginIds: ["xiaomi-plugin"], availability: "available" });
    expect(byRef(inventory).get("xiaomi-token-plan/t2")).toMatchObject({ pluginIds: ["xiaomi-plugin"] });
    expect(inventory.plugins).toEqual(plugins);
  });
});

describe("buildModelInventory：真实差异回归 fixture", () => {
  // 本机：deepseek/deepseek-v4-pro policy exact + runtime allowed，oc-switch 静态目录缺失
  const config: OpenClawConfig = {
    models: { providers: { deepseek: { models: [{ id: "deepseek-chat" }] } } },
    agents: { defaults: { modelPolicy: { allow: ["deepseek/deepseek-v4-pro"] } } }
  };

  test("runtime 目录含该 ref → available，可补全到已存在的 config Provider", () => {
    const runtime = makeSnapshot({
      allowedRefs: ["deepseek/deepseek-v4-pro"],
      configuredModels: [
        rt("deepseek/deepseek-chat", { available: true }),
        rt("deepseek/deepseek-v4-pro", { available: true, missing: false })
      ],
      allModels: [rt("deepseek/deepseek-chat"), rt("deepseek/deepseek-v4-pro")]
    });
    const inventory = buildModelInventory({ config, runtime });
    expect(byRef(inventory).get("deepseek/deepseek-v4-pro")).toMatchObject({
      catalogSources: ["openclaw-runtime"],
      referenceSources: ["policy-exact"],
      selectionSource: "policy-exact",
      policyAllowed: true,
      availability: "available",
      availabilityReasons: [],
      capabilities: { canMaterializeConfigModel: true, canSetPrimary: true }
    });
  });

  test("runtime 目录也不含该 ref → unavailable/model-not-in-catalog", () => {
    const runtime = makeSnapshot({
      allowedRefs: ["deepseek/deepseek-v4-pro"],
      configuredModels: [rt("deepseek/deepseek-chat", { available: true })],
      allModels: [rt("deepseek/deepseek-chat")]
    });
    const inventory = buildModelInventory({ config, runtime });
    expect(byRef(inventory).get("deepseek/deepseek-v4-pro")).toMatchObject({
      catalogSources: [],
      referenceSources: ["policy-exact"],
      policyAllowed: true,
      availability: "unavailable",
      availabilityReasons: ["model-not-in-catalog"],
      capabilities: { canMaterializeConfigModel: false, canRemovePolicyExactRef: false }
    });
  });

  // claw：policy exact + runtime allowed，所有 catalog 缺失；不因 auth Profile 字样被误判可用
  test("policy-only unavailable 稳定，auth Profile 提示词不影响判定", () => {
    const clawConfig: OpenClawConfig = {
      agents: { defaults: { modelPolicy: { allow: ["ghost/claude-fable-5"] } } }
    };
    const runtime = makeSnapshot({
      allowedRefs: ["ghost/claude-fable-5"],
      configuredModels: [
        rt("auth/claude-fable-5", { name: "claude-fable-5 (Auth Profile)", available: true })
      ],
      allModels: [rt("auth/claude-fable-5", { name: "claude-fable-5 (Auth Profile)" })]
    });
    const inventory = buildModelInventory({ config: clawConfig, runtime });
    expect(byRef(inventory).get("ghost/claude-fable-5")).toMatchObject({
      catalogSources: [],
      referenceSources: ["policy-exact"],
      policyAllowed: true,
      availability: "unavailable",
      availabilityReasons: ["provider-not-found"],
      capabilities: { canSetPrimary: false, canRemovePolicyExactRef: false }
    });
    // 另一个 Provider 下的同名 auth Profile 条目是独立行，不混淆判定
    expect(byRef(inventory).get("auth/claude-fable-5")).toMatchObject({
      catalogSources: ["openclaw-runtime"],
      availability: "available"
    });
    expect(byProvider(inventory).get("ghost")).toBeUndefined();
  });
});
