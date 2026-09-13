import { describe, expect, test } from "bun:test";
import { mergeProviderCaseDuplicates } from "../src/config-health";
import { normalizeConfigForStorage } from "../src/config-normalization";
import {
  addProviderModel,
  disableModel,
  enableModel,
  removeProviderModel,
  updateProviderModel
} from "../src/model-operations";
import { readModelPolicyAllow } from "../src/model-policy";
import { batchAddProviderModels, batchRemoveProviderModels } from "../src/provider-model-batch";
import { disableProvider, restoreDisabledProvider } from "../src/provider-lifecycle";
import { addCustomProvider, addProviderFromPreset, removeProvider } from "../src/provider-operations";
import type { OpenClawConfig } from "../src/types";

/** 已迁移（含非空 modelPolicy.allow）的基础配置 */
function migratedConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        cpa: {
          models: [{ id: "m1" }, { id: "vertex/gemini-3.8-flash" }, { id: "m2" }]
        },
        CPA2: {
          models: [{ id: "x1" }]
        },
        other: {
          models: [{ id: "o1" }]
        }
      }
    },
    agents: {
      defaults: {
        models: {
          "cpa/m1": { alias: "m-one" },
          "other/o1": {}
        },
        modelPolicy: { allow: ["cpa/m1", "other/o1"] }
      }
    }
  } as OpenClawConfig;
}

describe("modelPolicy.allow 双向同步", () => {
  test("enableModel / disableModel 同步精确条目", () => {
    const config = migratedConfig();
    enableModel(config, "cpa/vertex/gemini-3.8-flash");
    expect(readModelPolicyAllow(config)).toContain("cpa/vertex/gemini-3.8-flash");

    disableModel(config, "cpa/m1");
    expect(readModelPolicyAllow(config)).not.toContain("cpa/m1");
    // disable 不影响其它条目
    expect(readModelPolicyAllow(config)).toEqual(["other/o1", "cpa/vertex/gemini-3.8-flash"]);
  });

  test("addProviderModel enabled 时同步；未启用不同步", () => {
    const config = migratedConfig();
    addProviderModel(config, "cpa", { id: "m3", enabled: true });
    expect(readModelPolicyAllow(config)).toContain("cpa/m3");

    addProviderModel(config, "cpa", { id: "m4", enabled: false });
    expect(readModelPolicyAllow(config)).not.toContain("cpa/m4");
  });

  test("updateProviderModel 改名迁移精确条目；禁用移除", () => {
    const config = migratedConfig();
    updateProviderModel(config, "cpa/m1", { id: "m1-renamed", enabled: true });
    expect(readModelPolicyAllow(config)).not.toContain("cpa/m1");
    expect(readModelPolicyAllow(config)).toContain("cpa/m1-renamed");

    updateProviderModel(config, "other/o1", { id: "o1", enabled: false });
    expect(readModelPolicyAllow(config)).not.toContain("other/o1");
  });

  test("restricted 仅有旧精确条目时，启用改名净替换为新精确条目", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/m1"];

    updateProviderModel(config, "cpa/m1", { id: "m1-renamed", enabled: true });

    expect(readModelPolicyAllow(config)).toEqual(["cpa/m1-renamed"]);
  });

  test("removeProviderModel 同步移除", () => {
    const config = migratedConfig();
    removeProviderModel(config, "cpa/m1", { force: false });
    expect(readModelPolicyAllow(config)).not.toContain("cpa/m1");
  });

  test("batchAdd --enable 同步；batchRemove 与 keepEnabledOnly 同步移除", () => {
    const config = migratedConfig();
    batchAddProviderModels(config, "cpa", { models: [{ id: "b1" }, { id: "b2" }], enable: true });
    expect(readModelPolicyAllow(config)).toEqual(expect.arrayContaining(["cpa/b1", "cpa/b2"]));

    batchRemoveProviderModels(config, "cpa", { modelIds: ["b1"] });
    expect(readModelPolicyAllow(config)).not.toContain("cpa/b1");

    batchRemoveProviderModels(config, "cpa", { keepEnabledOnly: true });
    const allow = readModelPolicyAllow(config) ?? [];
    // m2/vertex 未启用被清出目录；b2 仍在 agents.defaults.models（enabled）故保留
    expect(allow.filter((ref) => ref.startsWith("cpa/"))).toEqual(["cpa/m1", "cpa/b2"]);
  });

  test("removeProvider 遇到 Provider 通配 policy 时删除成功并提示悬空 wildcard", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow!.push("cpa/*");

    const result = removeProvider(config, "cpa", { force: false });

    expect(result.config.models?.providers?.cpa).toBeUndefined();
    // exact 条目同步移除，用户 wildcard 原样保留（大小写/顺序不变）
    expect(readModelPolicyAllow(config)).toEqual(["other/o1", "cpa/*"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("cpa/*");
    expect(result.warnings[0]).toContain("dangling");
  });

  test("disableProvider / restoreDisabledProvider 仅维护独立状态，不改 modelPolicy", () => {
    const config = migratedConfig();
    const policyBefore = structuredClone(config.agents!.defaults!.modelPolicy);
    const disabled = disableProvider(config, "cpa");
    expect(config.agents!.defaults!.modelPolicy).toEqual(policyBefore);

    restoreDisabledProvider(config, "cpa", disabled.disabledState.allowlistEntries);
    expect(config.agents!.defaults!.modelPolicy).toEqual(policyBefore);
  });

  test("Provider 停用和恢复不删除 policy-only 精确条目", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/m1", "cpa/policy-only", "other/o1"];
    const policyBefore = structuredClone(config.agents!.defaults!.modelPolicy);

    const disabled = disableProvider(config, "cpa");
    expect(config.agents!.defaults!.modelPolicy).toEqual(policyBefore);

    restoreDisabledProvider(config, "cpa", disabled.disabledState.allowlistEntries);
    expect(config.agents!.defaults!.modelPolicy).toEqual(policyBefore);
    expect(config.agents!.defaults!.models?.["cpa/policy-only"]).toBeUndefined();
  });

  test("恢复到当前 unrestricted policy 时不写 policy", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = [];

    const disabled = disableProvider(config, "cpa", { visibleRefs: ["cpa/m1", "other/o1"] });
    expect(readModelPolicyAllow(config)).toEqual([]);

    restoreDisabledProvider(config, "cpa", disabled.disabledState.allowlistEntries);
    expect(readModelPolicyAllow(config)).toEqual([]);
  });

  test("addCustomProvider enableAllModels 同步", () => {
    const config = migratedConfig();
    addCustomProvider(config, {
      providerId: "newp",
      displayName: "New Provider",
      api: "openai-completions",
      baseUrl: "https://example.com",
      isFullUrl: true,
      apiKeyEnv: "NEWP_API_KEY",
      models: [{ id: "nm1" }],
      enableAllModels: true
    });
    expect(readModelPolicyAllow(config)).toContain("newp/nm1");
  });

  test("mergeProviderCaseDuplicates 改写精确与通配条目的 Provider 前缀", () => {
    const config = migratedConfig();
    // 构造大小写重复组 cpa / CPA2 不适用（不同模型），改用同组
    config.models!.providers!["CPA"] = { models: [{ id: "m9" }] };
    config.agents!.defaults!.models!["CPA/m9"] = {};
    config.agents!.defaults!.modelPolicy!.allow!.push("CPA/m9", "CPA/*");

    mergeProviderCaseDuplicates(config, { groupKey: "cpa", canonicalId: "cpa", removeIds: ["CPA"] });
    const allow = readModelPolicyAllow(config) ?? [];
    expect(allow).toContain("cpa/m9");
    expect(allow).toContain("cpa/*");
    expect(allow).not.toContain("CPA/m9");
    expect(allow).not.toContain("CPA/*");
  });

  test("normalizeConfigForStorage 只小写化 exact ref，用户 wildcard 保持原样", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["CPA/m1", "CPA2/*", "other/o1"];
    normalizeConfigForStorage(config);
    expect(readModelPolicyAllow(config)).toEqual(["cpa/m1", "CPA2/*", "other/o1"]);
  });

  test("未迁移（无 modelPolicy）与显式 [] 放开的配置全程不被触碰", () => {
    const legacy: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "m1" }] } } },
      agents: { defaults: { models: {} } }
    };
    enableModel(legacy, "cpa/m1");
    expect((legacy.agents!.defaults as Record<string, unknown>).modelPolicy).toBeUndefined();

    const open = migratedConfig();
    open.agents!.defaults!.modelPolicy!.allow = [];
    enableModel(open, "cpa/m2");
    disableModel(open, "cpa/m1");
    removeProviderModel(open, "cpa/m2", { force: false });
    expect(readModelPolicyAllow(open)).toEqual([]);
  });

  test("通配已覆盖时 enable 不产生重复精确条目", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/*", "other/o1"];
    enableModel(config, "cpa/m2");
    expect(readModelPolicyAllow(config)).toEqual(["cpa/*", "other/o1"]);
  });

  test("删除最后一个 restricted 精确条目时 fail closed 且配置字节不变", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/m1"];
    const before = JSON.stringify(config);

    expect(() => disableModel(config, "cpa/m1")).toThrow(/would make \[\] unrestricted/);
    expect(JSON.stringify(config)).toBe(before);
  });

  test("受限通配覆盖的 disable/rename 在任何写入前拒绝；remove 降级为成功 + warning", () => {
    const disableConfig = migratedConfig();
    disableConfig.agents!.defaults!.modelPolicy!.allow = ["cpa/*", "other/o1"];
    const disableBefore = JSON.stringify(disableConfig);
    expect(() => disableModel(disableConfig, "cpa/m2")).toThrow(
      "Cannot disable cpa/m2 while agents.defaults.modelPolicy.allow contains cpa/*; narrow the policy first."
    );
    expect(JSON.stringify(disableConfig)).toBe(disableBefore);

    const renameConfig = migratedConfig();
    renameConfig.agents!.defaults!.modelPolicy!.allow = ["cpa/*", "other/o1"];
    const renameBefore = JSON.stringify(renameConfig);
    expect(() => updateProviderModel(renameConfig, "cpa/m1", { id: "m1-renamed", enabled: true })).toThrow(
      "Cannot rename cpa/m1 while agents.defaults.modelPolicy.allow contains cpa/*; narrow the policy first."
    );
    expect(JSON.stringify(renameConfig)).toBe(renameBefore);

    // remove：目录条目删除后模型自然从 picker 消失，wildcard 原样保留并提示
    const removeConfig = migratedConfig();
    removeConfig.agents!.defaults!.modelPolicy!.allow = ["cpa/*", "other/o1"];
    const removed = removeProviderModel(removeConfig, "cpa/m1", { force: false });
    expect(removed.config.models?.providers?.cpa?.models?.map((model) => model.id)).toEqual([
      "vertex/gemini-3.8-flash",
      "m2"
    ]);
    expect(removed.warnings).toHaveLength(1);
    expect(removed.warnings[0]).toContain("cpa/*");
    expect(readModelPolicyAllow(removeConfig)).toEqual(["cpa/*", "other/o1"]);
  });

  test("rename 后同时禁用时也 preflight 新 ref 的 namespace wildcard", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/m1", "cpa/renamed/*", "other/o1"];
    const before = JSON.stringify(config);

    expect(() => updateProviderModel(config, "cpa/m1", { id: "renamed/m1", enabled: false })).toThrow(
      "Cannot disable cpa/renamed/m1 while agents.defaults.modelPolicy.allow contains cpa/renamed/*; narrow the policy first."
    );
    expect(JSON.stringify(config)).toBe(before);
  });

  test("rename 命中旧 ref 的 namespace wildcard 时拒绝且不写入", () => {
    const config = migratedConfig();
    config.models!.providers!.cpa!.models![0] = { id: "legacy/m1" };
    delete config.agents!.defaults!.models!["cpa/m1"];
    config.agents!.defaults!.models!["cpa/legacy/m1"] = { alias: "m-one" };
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/legacy/*", "other/o1"];
    const before = JSON.stringify(config);

    expect(() => updateProviderModel(config, "cpa/legacy/m1", { id: "m1-renamed", enabled: true })).toThrow(
      "Cannot rename cpa/legacy/m1 while agents.defaults.modelPolicy.allow contains cpa/legacy/*; narrow the policy first."
    );
    expect(JSON.stringify(config)).toBe(before);
  });

  test("受限通配覆盖的批量删除降级为成功 + warning；Provider 停用仍移出规则", () => {
    const batchConfig = migratedConfig();
    batchConfig.agents!.defaults!.modelPolicy!.allow = ["cpa/*", "other/o1"];
    const batch = batchRemoveProviderModels(batchConfig, "cpa", { modelIds: ["m2"] });
    expect(batch.removedModelIds).toEqual(["m2"]);
    expect(batch.warnings).toHaveLength(1);
    expect(batch.warnings[0]).toContain("cpa/*");
    expect(readModelPolicyAllow(batchConfig)).toEqual(["cpa/*", "other/o1"]);

    const disableProviderConfig = migratedConfig();
    disableProviderConfig.agents!.defaults!.modelPolicy!.allow = ["cpa/*", "other/o1"];
    const disableProviderBefore = JSON.stringify(disableProviderConfig);
    const disabled = disableProvider(disableProviderConfig, "cpa");
    expect(readModelPolicyAllow(disabled.config)).toEqual(["other/o1"]);
    expect(JSON.stringify(disableProviderConfig)).toBe(disableProviderBefore);
  });

  test("预设同步不能借由未勾选模型绕过通配 policy 的 disable 拒绝", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/*", "other/o1"];
    const before = JSON.stringify(config);

    expect(() => addProviderFromPreset(config, {
      id: "cpa",
      name: "CPA",
      provider: { api: "openai-completions", baseUrl: "https://example.test/v1", apiKeyEnv: "CPA_API_KEY" },
      models: [{ id: "m1" }]
    }, [])).toThrow(
      "Cannot disable cpa/m1 while agents.defaults.modelPolicy.allow contains cpa/*; narrow the policy first."
    );
    expect(JSON.stringify(config)).toBe(before);
  });

  test("keep-enabled-only 按 restricted effective policy 保留 policy-only exact 与 namespace wildcard 模型", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/m2", "cpa/vertex/*", "other/o1"];

    const result = batchRemoveProviderModels(config, "cpa", { keepEnabledOnly: true });

    expect(result.removedModelIds).toEqual(["m1"]);
    expect(config.models!.providers!.cpa!.models!.map((model) => model.id)).toEqual(["vertex/gemini-3.8-flash", "m2"]);
    expect(readModelPolicyAllow(config)).toEqual(["cpa/m2", "cpa/vertex/*", "other/o1"]);
  });

  test("keep-enabled-only 不得绕过 fallback 保护，失败前配置字节不变", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/m2", "other/o1"];
    config.agents!.defaults!.model = { primary: "other/o1", fallbacks: ["cpa/m1"] };
    const before = JSON.stringify(config);

    expect(() => batchRemoveProviderModels(config, "cpa", { keepEnabledOnly: true })).toThrow(/fallbacks/);
    expect(JSON.stringify(config)).toBe(before);
  });
});

describe("三层删除分级（layers）与 wildcard 提示", () => {
  test("removeProviderModel 缺省 layers 保持三层全删", () => {
    const config = migratedConfig();
    const result = removeProviderModel(config, "cpa/m1", { force: false });
    expect(config.models!.providers!.cpa!.models!.map((model) => model.id)).not.toContain("m1");
    expect(config.agents!.defaults!.models!["cpa/m1"]).toBeUndefined();
    expect(readModelPolicyAllow(config)).not.toContain("cpa/m1");
    expect(result.warnings).toEqual([]);
  });

  test("removeProviderModel layers.metadata=false 保留 metadata", () => {
    const config = migratedConfig();
    removeProviderModel(config, "cpa/m1", { force: false, layers: { metadata: false } });
    expect(config.models!.providers!.cpa!.models!.map((model) => model.id)).not.toContain("m1");
    expect(config.agents!.defaults!.models!["cpa/m1"]).toEqual({ alias: "m-one" });
    expect(readModelPolicyAllow(config)).not.toContain("cpa/m1");
  });

  test("removeProviderModel 缺省 layers 删除最后一条 restricted exact 仍 fail closed", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/m1"];
    const before = JSON.stringify(config);

    expect(() => removeProviderModel(config, "cpa/m1", { force: false })).toThrow(/would make \[\] unrestricted/);
    expect(JSON.stringify(config)).toBe(before);
  });

  test("removeProviderModel layers.policyExact=false 保留 policy exact 且不触发防清空", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/m1"];

    const result = removeProviderModel(config, "cpa/m1", { force: false, layers: { policyExact: false } });

    expect(result.warnings).toEqual([]);
    expect(config.models!.providers!.cpa!.models!.map((model) => model.id)).not.toContain("m1");
    expect(config.agents!.defaults!.models!["cpa/m1"]).toBeUndefined();
    expect(readModelPolicyAllow(config)).toEqual(["cpa/m1"]);
  });

  test("batchRemoveProviderModels modelIds 分支：同一 wildcard 只 warning 一次", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/*", "other/o1"];

    const result = batchRemoveProviderModels(config, "cpa", { modelIds: ["m1", "m2"] });

    expect(result.removedModelIds).toEqual(["m1", "m2"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("cpa/*");
    expect(readModelPolicyAllow(config)).toEqual(["cpa/*", "other/o1"]);
    expect(config.agents!.defaults!.models!["cpa/m1"]).toBeUndefined();
  });

  test("batchRemoveProviderModels modelIds 分支 layers.policyExact=false 跳过防清空并保留 exact", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/m2"];
    const before = JSON.stringify(config);

    // 缺省 layers 仍套用防清空 guard
    expect(() => batchRemoveProviderModels(config, "cpa", { modelIds: ["m2"] })).toThrow(/would make \[\] unrestricted/);
    expect(JSON.stringify(config)).toBe(before);

    const result = batchRemoveProviderModels(config, "cpa", { modelIds: ["m2"], layers: { policyExact: false } });
    expect(result.removedModelIds).toEqual(["m2"]);
    expect(readModelPolicyAllow(config)).toEqual(["cpa/m2"]);
  });

  test("batchRemoveProviderModels keepEnabledOnly 分支 layers.metadata=false 保留被删模型的 metadata", () => {
    const config = migratedConfig();
    // restricted：m2 exact 有效；m1 仅有 metadata（restricted 下不参与选择），vertex 未启用
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/m2", "other/o1"];

    const result = batchRemoveProviderModels(config, "cpa", {
      keepEnabledOnly: true,
      layers: { metadata: false }
    });

    expect([...result.removedModelIds].sort()).toEqual(["m1", "vertex/gemini-3.8-flash"]);
    expect(config.models!.providers!.cpa!.models!.map((model) => model.id)).toEqual(["m2"]);
    expect(config.agents!.defaults!.models!["cpa/m1"]).toEqual({ alias: "m-one" });
    expect(readModelPolicyAllow(config)).toEqual(["cpa/m2", "other/o1"]);
    expect(result.warnings).toEqual([]);
  });

  test("removeProvider 默认只提示悬空 wildcard，removePolicyWildcard:true 才显式移除", () => {
    const warnConfig = migratedConfig();
    warnConfig.agents!.defaults!.modelPolicy!.allow = ["cpa/m1", "cpa/*", "other/o1"];
    const warned = removeProvider(warnConfig, "cpa", { force: false });
    expect(readModelPolicyAllow(warnConfig)).toEqual(["cpa/*", "other/o1"]);
    expect(warned.warnings.some((warning) => warning.includes("cpa/*"))).toBe(true);

    const removeConfig = migratedConfig();
    removeConfig.agents!.defaults!.modelPolicy!.allow = ["cpa/m1", "cpa/*", "other/o1"];
    const removed = removeProvider(removeConfig, "cpa", { force: false, removePolicyWildcard: true });
    expect(readModelPolicyAllow(removeConfig)).toEqual(["other/o1"]);
    expect(removed.warnings).toEqual([]);
    expect(removed.config.models?.providers?.cpa).toBeUndefined();
  });

  test("removeProvider removePolicyWildcard:true 只移除该 Provider 的 wildcard，其他条目大小写/顺序不变", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["CPA/*", "cpa/m1", "other/*", "other/o1"];

    removeProvider(config, "cpa", { force: false, removePolicyWildcard: true });

    expect(readModelPolicyAllow(config)).toEqual(["other/*", "other/o1"]);
  });

  test("removeProvider removePolicyWildcard:true 移除会变空 policy 时 fail closed 且配置不变", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/m1", "cpa/*"];
    const before = JSON.stringify(config);

    expect(() => removeProvider(config, "cpa", { force: false, removePolicyWildcard: true })).toThrow(
      /would make \[\] unrestricted/
    );
    expect(JSON.stringify(config)).toBe(before);
  });
});
