import { describe, expect, test } from "bun:test";
import sampleJson from "./fixtures/openclaw.sample.json";
import {
  batchAddProviderModels,
  batchRemoveProviderModels
} from "../src/provider-model-batch";
import { MAX_PROVIDER_MODELS } from "../src/provider-model-limits";
import type { OpenClawConfig } from "../src/types";

const sample = sampleJson as OpenClawConfig;

function cloneSample() {
  return structuredClone(sample);
}

describe("batchAddProviderModels", () => {
  test("添加新模型且默认不写入 allowlist", () => {
    const config = cloneSample();
    const result = batchAddProviderModels(config, "nvidia", {
      models: [
        { id: "deepseek-ai/deepseek-v4-pro", name: "DeepSeek V4 Pro" },
        { id: "vendor/model-x" }
      ]
    });

    const ids = result.config.models?.providers?.nvidia?.models?.map((m) => m.id);
    expect(result.addedModelIds).toEqual(["deepseek-ai/deepseek-v4-pro", "vendor/model-x"]);
    expect(result.skippedModelIds).toEqual([]);
    expect(ids).toContain("deepseek-ai/deepseek-v4-pro");
    expect(ids).toContain("vendor/model-x");
    expect(result.config.models?.providers?.nvidia?.models?.find((m) => m.id === "deepseek-ai/deepseek-v4-pro")?.name)
      .toBe("DeepSeek V4 Pro");
    expect(result.config.models?.providers?.nvidia?.models?.find((m) => m.id === "vendor/model-x")?.name)
      .toBe("Vendor Model X");
    expect(result.config.models?.providers?.nvidia?.models?.find(
      (model) => model.id === "deepseek-ai/deepseek-v4-pro"
    )?.reasoning).toBe(true);
    expect(result.config.models?.providers?.nvidia?.models?.find(
      (model) => model.id === "vendor/model-x"
    )?.reasoning).toBe(true);
    expect(result.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-pro"]).toBeUndefined();
    expect(result.config.agents?.defaults?.models?.["nvidia/vendor/model-x"]).toBeUndefined();
    expect(result.warnings).toEqual([]);
  });

  test("跳过已存在 id 且不覆盖已有 name", () => {
    const config = cloneSample();
    const result = batchAddProviderModels(config, "nvidia", {
      models: [
        { id: "deepseek-ai/deepseek-v4-flash", name: "Should Not Overwrite" },
        { id: "new/model-a", name: "Model A" }
      ]
    });

    expect(result.addedModelIds).toEqual(["new/model-a"]);
    expect(result.skippedModelIds).toEqual(["deepseek-ai/deepseek-v4-flash"]);
    expect(result.config.models?.providers?.nvidia?.models?.find((m) => m.id === "deepseek-ai/deepseek-v4-flash")?.name)
      .toBe("DeepSeek V4 Flash");
  });

  test("enable=true 时写入 allowlist", () => {
    const config = cloneSample();
    const result = batchAddProviderModels(config, "nvidia", {
      models: [{ id: "deepseek-ai/deepseek-v4-pro", name: "DeepSeek V4 Pro" }],
      enable: true
    });

    expect(result.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-pro"]).toEqual({});
  });

  test("新增条数超上限时整单拒绝", () => {
    const config = cloneSample();
    config.models!.providers!.nvidia!.models = Array.from({ length: MAX_PROVIDER_MODELS }, (_, i) => ({
      id: `model-${i}`,
      name: `Model ${i}`
    }));

    expect(() => batchAddProviderModels(config, "nvidia", {
      models: [{ id: "overflow/model" }]
    })).toThrow(/20|limit|上限|capacity/i);
    expect(config.models?.providers?.nvidia?.models).toHaveLength(MAX_PROVIDER_MODELS);
  });

  test("provider 不存在时拒绝", () => {
    expect(() => batchAddProviderModels(cloneSample(), "missing", {
      models: [{ id: "a" }]
    })).toThrow("Provider missing not found");
  });
});

describe("batchRemoveProviderModels", () => {
  test("多选删除 raw model id 并同步移除 allowlist", () => {
    const config = cloneSample();
    const result = batchRemoveProviderModels(config, "nvidia", {
      modelIds: ["deepseek-ai/deepseek-v4-flash", "z-ai/glm5.1"]
    });

    const ids = result.config.models?.providers?.nvidia?.models?.map((m) => m.id) ?? [];
    expect(ids).not.toContain("deepseek-ai/deepseek-v4-flash");
    expect(ids).not.toContain("z-ai/glm5.1");
    expect(result.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeUndefined();
    expect(result.config.agents?.defaults?.models?.["nvidia/z-ai/glm5.1"]).toBeUndefined();
    expect(result.config.agents?.defaults?.model).toBe("minimax-portal/MiniMax-M3");
  });

  test("删除列表含本 Provider 主模型 modelId 时整单拒绝", () => {
    const config = cloneSample();
    expect(() => batchRemoveProviderModels(config, "minimax-portal", {
      modelIds: ["MiniMax-M3"]
    })).toThrow(/primary|主模型/i);
    expect(config.models?.providers?.["minimax-portal"]?.models?.map((m) => m.id)).toContain("MiniMax-M3");
  });

  test("空 modelIds 且非 keepEnabledOnly 时拒绝", () => {
    expect(() => batchRemoveProviderModels(cloneSample(), "nvidia", {
      modelIds: []
    })).toThrow(/empty|modelIds|400/i);
  });

  test("keepEnabledOnly 保留 allowlist 模型并移除未启用目录项", () => {
    const config = cloneSample();
    batchAddProviderModels(config, "nvidia", {
      models: [{ id: "catalog-only/model", name: "Catalog Only" }]
    });

    const result = batchRemoveProviderModels(config, "nvidia", {
      keepEnabledOnly: true
    });

    const ids = result.config.models?.providers?.nvidia?.models?.map((m) => m.id) ?? [];
    expect(ids).toContain("deepseek-ai/deepseek-v4-flash");
    expect(ids).toContain("z-ai/glm5.1");
    expect(ids).not.toContain("catalog-only/model");
    expect(result.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-flash"]).toEqual({
      alias: "nv-ds-flash",
      agentRuntime: { id: "codex" }
    });
    expect(result.config.agents?.defaults?.models?.["nvidia/z-ai/glm5.1"]).toEqual({ alias: "nv-glm" });
    expect(result.config.agents?.defaults?.models?.["nvidia/catalog-only/model"]).toBeUndefined();
  });

  test("keepEnabledOnly 且主模型不在目录时拒绝并提示修复", () => {
    const config = cloneSample();
    config.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";
    config.models!.providers!.nvidia!.models = config.models!.providers!.nvidia!.models!.filter(
      (m) => m.id !== "deepseek-ai/deepseek-v4-flash"
    );

    expect(() => batchRemoveProviderModels(config, "nvidia", {
      keepEnabledOnly: true
    })).toThrow(/primary|主模型|catalog|目录|repair|修复/i);
  });

  test("keepEnabledOnly 时永远保留本 Provider 主模型目录项", () => {
    const config = cloneSample();
    config.agents!.defaults!.model = "minimax-portal/MiniMax-M3";
    delete config.agents!.defaults!.models!["minimax-portal/MiniMax-M3"];

    const result = batchRemoveProviderModels(config, "minimax-portal", {
      keepEnabledOnly: true
    });

    expect(result.config.models?.providers?.["minimax-portal"]?.models?.map((m) => m.id)).toEqual(["MiniMax-M3"]);
    expect(result.config.agents?.defaults?.models?.["minimax-portal/MiniMax-M3"]).toBeUndefined();
  });
});

describe("batch operations 对象形态主模型与 fallback 保护", () => {
  /** 对象形态：primary = minimax-portal/MiniMax-M3；fallback 指向 nvidia 的未启用模型 */
  function objectPrimarySample() {
    const config = cloneSample();
    config.agents!.defaults!.model = {
      primary: "minimax-portal/MiniMax-M3",
      fallbacks: ["nvidia/z-ai/glm5.1"]
    } as never;
    // 移出 allowlist：z-ai/glm5.1 变为未启用目录项，keepEnabledOnly 断言才能证明是 fallback 保护生效
    delete config.agents!.defaults!.models!["nvidia/z-ai/glm5.1"];
    return config;
  }

  test("显式批量删除命中对象形态主模型时整单拒绝", () => {
    const config = objectPrimarySample();
    expect(() =>
      batchRemoveProviderModels(config, "minimax-portal", { modelIds: ["MiniMax-M3"] })
    ).toThrow("Cannot remove primary model minimax-portal/MiniMax-M3");
  });

  test("keepEnabledOnly 永远保留对象形态主模型目录项", () => {
    const config = objectPrimarySample();
    const result = batchRemoveProviderModels(config, "minimax-portal", { keepEnabledOnly: true });
    expect(result.config.models?.providers?.["minimax-portal"]?.models?.map((m) => m.id)).toEqual(["MiniMax-M3"]);
  });

  test("显式批量删除命中 fallback 目录项时整单拒绝，force 语义不适用，配置不变", () => {
    const config = objectPrimarySample();
    const before = structuredClone(config);
    expect(() =>
      batchRemoveProviderModels(config, "nvidia", { modelIds: ["z-ai/glm5.1", "deepseek-ai/deepseek-v4-flash"] })
    ).toThrow(/agents\.defaults\.model\.fallbacks/);
    expect(config).toEqual(before);
  });

  test("keepEnabledOnly 会移除未启用的 fallback 目录项时整单拒绝，配置不变", () => {
    const config = objectPrimarySample();
    const before = structuredClone(config);
    expect(() => batchRemoveProviderModels(config, "nvidia", { keepEnabledOnly: true })).toThrow(
      /agents\.defaults\.model\.fallbacks/
    );
    expect(config).toEqual(before);
  });

  test("keepEnabledOnly：fallback 目录项已启用时正常清理其余未启用项", () => {
    const config = objectPrimarySample();
    // 把 fallback 模型放回 allowlist（已启用）→ 不在移除集，无需拒绝
    config.agents!.defaults!.models!["nvidia/z-ai/glm5.1"] = {};
    config.models!.providers!.nvidia!.models!.push({ id: "unused-model" });
    const result = batchRemoveProviderModels(config, "nvidia", { keepEnabledOnly: true });
    expect(result.config.models?.providers?.nvidia?.models?.map((m) => m.id)).toEqual([
      "deepseek-ai/deepseek-v4-flash",
      "z-ai/glm5.1"
    ]);
    expect(result.removedModelIds).toEqual(["unused-model"]);
  });

  test("keepEnabledOnly：对象形态主模型不在目录时拒绝并提示修复", () => {
    const config = objectPrimarySample();
    config.models!.providers!["minimax-portal"]!.models = [];
    expect(() => batchRemoveProviderModels(config, "minimax-portal", { keepEnabledOnly: true })).toThrow(
      /not in provider minimax-portal catalog/
    );
  });
});
