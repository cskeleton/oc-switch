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
import { addCustomProvider, removeProvider } from "../src/provider-operations";
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

  test("removeProvider 移除该 Provider 全部精确条目，残留通配给 warning", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow!.push("cpa/*");
    const result = removeProvider(config, "cpa", { force: false });
    const allow = readModelPolicyAllow(config) ?? [];
    expect(allow).toEqual(["other/o1", "cpa/*"]);
    expect(result.warnings.some((w) => w.includes("cpa/*"))).toBe(true);
  });

  test("disableProvider / restoreDisabledProvider 往返同步", () => {
    const config = migratedConfig();
    const disabled = disableProvider(config, "cpa");
    expect(readModelPolicyAllow(config)).toEqual(["other/o1"]);

    restoreDisabledProvider(config, "cpa", disabled.disabledState.allowlistEntries);
    expect(readModelPolicyAllow(config)).toContain("cpa/m1");
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

  test("normalizeConfigForStorage 同步小写化 policy 条目的 Provider 前缀", () => {
    const config = migratedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["CPA/m1", "CPA2/*", "other/o1"];
    normalizeConfigForStorage(config);
    expect(readModelPolicyAllow(config)).toEqual(["cpa/m1", "cpa2/*", "other/o1"]);
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
});
