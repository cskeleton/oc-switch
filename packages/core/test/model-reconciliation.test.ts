import { describe, expect, test } from "bun:test";
import {
  isModelReconciliationError,
  materializeRuntimeModel,
  removeModelPolicyExactRef,
  type MaterializeRuntimeModelInput
} from "../src/model-reconciliation";
import type { ModelInventoryEntry } from "../src/model-inventory";
import { buildModelInventory } from "../src/model-inventory";
import type { RuntimeModelSnapshot } from "../src/runtime-model-catalog";
import type { OpenClawConfig } from "../src/types";

/**
 * Task 3：policy exact 引用清理（removeModelPolicyExactRef）与已有 Provider
 * 模型补全（materializeRuntimeModel）的纯函数测试。
 * 全部使用内存 fixture：不读写文件、不 shell-out、不触碰真实 openclaw。
 */

/** 捕获 action 抛出的错误（未抛则返回 undefined），便于断言结构化 code */
function captureError(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** 断言为 ModelReconciliationError 并返回，供进一步检查 code */
function requireReconciliationError(error: unknown) {
  if (!isModelReconciliationError(error)) {
    throw new Error(`expected ModelReconciliationError, got: ${String(error)}`);
  }
  return error;
}

/** restricted policy fixture：cpa/* 通配 + ghost/missing 悬空 exact + other/model 兜底 */
function restrictedConfig(): OpenClawConfig {
  return {
    models: {
      providers: {
        cpa: { models: [{ id: "m1" }] },
        other: { models: [{ id: "model" }] }
      }
    },
    agents: {
      defaults: {
        models: {
          "cpa/m1": { alias: "m-one" },
          "ghost/missing": { alias: "ghost" }
        },
        modelPolicy: { allow: ["cpa/*", "ghost/missing", "other/model"] }
      }
    }
  };
}

describe("removeModelPolicyExactRef", () => {
  test("exact-only 删除：保留其它条目与 legacy metadata（brief Step 1 断言）", () => {
    const config = restrictedConfig();
    const result = removeModelPolicyExactRef(config, "ghost/missing", { removeMetadata: false });

    expect(result.config.agents?.defaults?.modelPolicy?.allow).toEqual(["cpa/*", "other/model"]);
    expect(result.config.agents?.defaults?.models?.["ghost/missing"]).toBeDefined();
    // 纯函数：输入 config 不被修改
    expect(config.agents?.defaults?.modelPolicy?.allow).toEqual(["cpa/*", "ghost/missing", "other/model"]);
    expect(config.agents?.defaults?.models?.["ghost/missing"]).toBeDefined();
  });

  test("removeMetadata=true 同步删除 legacy metadata，其它 Provider 的 metadata 不受影响", () => {
    const config = restrictedConfig();
    const result = removeModelPolicyExactRef(config, "ghost/missing", { removeMetadata: true });

    expect(result.config.agents?.defaults?.modelPolicy?.allow).toEqual(["cpa/*", "other/model"]);
    expect(result.config.agents?.defaults?.models?.["ghost/missing"]).toBeUndefined();
    expect(result.config.agents?.defaults?.models?.["cpa/m1"]).toBeDefined();
  });

  test("省略 options 时默认不删 metadata，并对保留的 legacy 引用给出 warning", () => {
    const config = restrictedConfig();
    const before = structuredClone(config);
    const result = removeModelPolicyExactRef(config, "ghost/missing");

    expect(result.config.agents?.defaults?.models?.["ghost/missing"]).toBeDefined();
    expect(config).toEqual(before);
    expect(result.warnings.some((warning) => warning.includes("ghost/missing"))).toBe(true);
  });

  test("wildcard 输入拒绝且配置不变（spec §11.3 wildcard 本期只读）", () => {
    const config = restrictedConfig();
    const before = structuredClone(config);

    const error = requireReconciliationError(captureError(() => removeModelPolicyExactRef(config, "cpa/*", {})));
    expect(error.code).toBe("wildcard-ref-rejected");
    expect(config).toEqual(before);
  });

  test("policy 中不存在的 exact ref 拒绝（含 legacy / unrestricted 配置）", () => {
    const config = restrictedConfig();
    const before = structuredClone(config);
    const error = requireReconciliationError(captureError(() => removeModelPolicyExactRef(config, "ghost/other", {})));
    expect(error.code).toBe("policy-ref-not-found");
    expect(config).toEqual(before);

    // legacy（无 modelPolicy）没有可删的 policy 条目
    const legacy: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "m1" }] } } },
      agents: { defaults: { models: { "cpa/m1": {} } } }
    };
    expect(requireReconciliationError(captureError(() => removeModelPolicyExactRef(legacy, "cpa/m1", {}))).code).toBe(
      "policy-ref-not-found"
    );

    // unrestricted（allow: []）同样没有 exact 条目
    const unrestricted = restrictedConfig();
    unrestricted.agents!.defaults!.modelPolicy!.allow = [];
    expect(
      requireReconciliationError(captureError(() => removeModelPolicyExactRef(unrestricted, "ghost/missing", {}))).code
    ).toBe("policy-ref-not-found");
  });

  test("删除最后一条 restricted exact 会变 [] unrestricted，fail closed", () => {
    const config = restrictedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["ghost/missing"];
    const before = structuredClone(config);

    expect(() => removeModelPolicyExactRef(config, "ghost/missing", { removeMetadata: true })).toThrow(/unrestricted/);
    expect(config).toEqual(before);
  });

  test("主模型引用的 exact ref 拒绝删除（fail closed，无 force 选项）", () => {
    const config = restrictedConfig();
    config.agents!.defaults!.model = "ghost/missing";
    const before = structuredClone(config);

    const error = requireReconciliationError(captureError(() => removeModelPolicyExactRef(config, "ghost/missing", {})));
    expect(error.code).toBe("primary-model-referenced");
    expect(config).toEqual(before);
  });

  test("fallback 引用的 exact ref 拒绝删除（对象形态主模型，形状不变）", () => {
    const config = restrictedConfig();
    config.agents!.defaults!.model = { primary: "other/model", fallbacks: ["ghost/missing"] };
    const before = structuredClone(config);

    const error = requireReconciliationError(captureError(() => removeModelPolicyExactRef(config, "ghost/missing", {})));
    expect(error.code).toBe("fallback-referenced");
    expect(config).toEqual(before);
  });

  test("被通配覆盖的 exact ref 删除前 fail closed（提示先收窄规则）", () => {
    const config = restrictedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["cpa/*", "cpa/m1", "other/model"];
    const before = structuredClone(config);

    expect(() => removeModelPolicyExactRef(config, "cpa/m1", {})).toThrow(/narrow the policy first/);
    expect(config).toEqual(before);
  });

  test("大小写折叠匹配 exact 条目，非字符串条目原样保留", () => {
    const config = restrictedConfig();
    config.agents!.defaults!.modelPolicy!.allow = ["Ghost/missing", 42, "other/model"];

    const result = removeModelPolicyExactRef(config, "ghost/missing", {});
    expect(result.config.agents?.defaults?.modelPolicy?.allow).toEqual([42, "other/model"]);
  });
});

/** ---------- materializeRuntimeModel ---------- */

/** 完整 runtime snapshot fixture（探测完整、无 diagnostics） */
function completeRuntime(overrides: Partial<RuntimeModelSnapshot> = {}): RuntimeModelSnapshot {
  return {
    openClawVersion: "2026.9.3",
    fallbackRefs: [],
    allowedRefs: [],
    configuredModels: [
      { ref: "cpa/runtime-model", available: true, tags: ["runtime"] },
      { ref: "cpa/dead-model", available: false, tags: [] }
    ],
    allModels: [{ ref: "cpa/runtime-model", available: true, tags: ["runtime"] }],
    completeness: { status: true, configuredList: true, allList: true },
    diagnostics: [],
    capturedAt: "2026-09-09T00:00:00.000Z",
    ...overrides
  };
}

/** 从 fixture 构建真实 inventory 并取回指定 ref 的 entry（保证 entry 与纯计算层一致） */
function inventoryEntryFor(config: OpenClawConfig, runtime: RuntimeModelSnapshot, ref: string): ModelInventoryEntry {
  const inventory = buildModelInventory({ config, runtime });
  const entry = inventory.models.find((model) => model.ref === ref);
  if (!entry) throw new Error(`fixture missing inventory entry for ${ref}`);
  return entry;
}

/** 有 config Provider（cpa）但运行时出现新模型的 fixture */
function materializeConfig(): OpenClawConfig {
  return {
    models: { providers: { cpa: { models: [{ id: "existing-model" }] } } },
    agents: { defaults: { models: {} } }
  };
}

function materializeInput(overrides: Partial<MaterializeRuntimeModelInput> = {}): MaterializeRuntimeModelInput {
  return { id: "runtime-model", enabled: true, ...overrides };
}

describe("materializeRuntimeModel", () => {
  test("runtime available 模型补入已有 config Provider，走 ProviderModelInput 白名单", () => {
    const config = materializeConfig();
    const entry = inventoryEntryFor(config, completeRuntime(), "cpa/runtime-model");
    const before = structuredClone(config);

    const result = materializeRuntimeModel(config, entry, materializeInput({
      name: "Runtime Model",
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 8192,
      input: ["text"]
    }));

    const added = result.config.models?.providers?.cpa?.models?.find((model) => model.id === "runtime-model");
    expect(added).toMatchObject({
      id: "runtime-model",
      name: "Runtime Model",
      reasoning: false,
      contextWindow: 128000,
      maxTokens: 8192,
      input: ["text"]
    });
    // enabled=true：addProviderModel 同步 allowlist 与 restricted policy 的写入规则
    expect(result.config.agents?.defaults?.models?.["cpa/runtime-model"]).toBeDefined();
    // 纯函数：输入 config 不被修改
    expect(config).toEqual(before);
  });

  test("runtime tags / catalogSources / availability 等运行时事实绝不写入 openclaw.json", () => {
    const config = materializeConfig();
    config.agents!.defaults!.modelPolicy = { allow: ["cpa/*"] };
    const entry = inventoryEntryFor(config, completeRuntime(), "cpa/runtime-model");

    const result = materializeRuntimeModel(config, entry, materializeInput());

    const serialized = JSON.stringify(result.config);
    expect(serialized).not.toContain("openclaw-runtime");
    expect(serialized).not.toContain("plugin-manifest");
    expect(serialized).not.toContain("catalogSources");
    expect(serialized).not.toContain("availability");
    expect(serialized).not.toContain("tags");
    // 模型目录条目只含 ProviderModelInput 白名单字段
    const added = result.config.models!.providers!.cpa!.models!.find((model) => model.id === "runtime-model")!;
    expect(Object.keys(added).every((key) =>
      ["id", "name", "alias", "api", "reasoning", "contextWindow", "contextTokens", "maxTokens", "input"].includes(key)
    )).toBe(true);
  });

  test("Provider 不存在时返回结构化 blocker provider-config-required，不创建猜测配置", () => {
    const config: OpenClawConfig = {
      models: { providers: { other: { models: [] } } },
      agents: { defaults: { models: {} } }
    };
    const entry = inventoryEntryFor(config, completeRuntime(), "cpa/runtime-model");
    const before = structuredClone(config);

    const error = requireReconciliationError(
      captureError(() => materializeRuntimeModel(config, entry, materializeInput()))
    );
    expect(error.code).toBe("provider-config-required");
    expect(error.message).toContain("cpa");
    expect(config).toEqual(before);
  });

  test("runtime entry 非 available（unavailable / unknown）时拒绝", () => {
    // unavailable：运行时明确标记 available=false
    const config = materializeConfig();
    const deadEntry = inventoryEntryFor(config, completeRuntime(), "cpa/dead-model");
    const before = structuredClone(config);
    const deadError = requireReconciliationError(
      captureError(() => materializeRuntimeModel(config, deadEntry, materializeInput({ id: "dead-model" })))
    );
    expect(deadError.code).toBe("runtime-model-unavailable");
    expect(config).toEqual(before);

    // unknown：探测不完整
    const unknownRuntime = completeRuntime({
      configuredModels: [{ ref: "cpa/pending-model", tags: [] }],
      allModels: [{ ref: "cpa/pending-model", tags: [] }],
      completeness: { status: false, configuredList: true, allList: false }
    });
    const unknownEntry = inventoryEntryFor(config, unknownRuntime, "cpa/pending-model");
    const unknownError = requireReconciliationError(
      captureError(() => materializeRuntimeModel(config, unknownEntry, materializeInput({ id: "pending-model" })))
    );
    expect(unknownError.code).toBe("runtime-model-unavailable");
    expect(config).toEqual(before);
  });

  test("model ID 已存在于 Provider 目录时拒绝（大小写敏感）", () => {
    const config = materializeConfig();
    const runtime = completeRuntime({
      configuredModels: [{ ref: "cpa/existing-model", available: true, tags: [] }],
      allModels: [{ ref: "cpa/existing-model", available: true, tags: [] }]
    });
    const entry = inventoryEntryFor(config, runtime, "cpa/existing-model");
    const before = structuredClone(config);

    const error = requireReconciliationError(
      captureError(() => materializeRuntimeModel(config, entry, materializeInput({ id: "existing-model" })))
    );
    expect(error.code).toBe("model-already-in-catalog");
    expect(config).toEqual(before);
  });

  test("input.id 与 inventory entry 不一致时拒绝（防止张冠李戴写入）", () => {
    const config = materializeConfig();
    const entry = inventoryEntryFor(config, completeRuntime(), "cpa/runtime-model");

    const error = requireReconciliationError(
      captureError(() => materializeRuntimeModel(config, entry, materializeInput({ id: "other-model" })))
    );
    expect(error.code).toBe("model-input-mismatch");
  });

  test("enabled=false 补入目录但不写 selection（沿用 addProviderModel 语义）", () => {
    const config = materializeConfig();
    const entry = inventoryEntryFor(config, completeRuntime(), "cpa/runtime-model");

    const result = materializeRuntimeModel(config, entry, materializeInput({ enabled: false }));

    expect(result.config.models?.providers?.cpa?.models?.some((model) => model.id === "runtime-model")).toBe(true);
    expect(result.config.agents?.defaults?.models?.["cpa/runtime-model"]).toBeUndefined();
  });

  test("Provider 模型目录已满 100 上限时沿用 addProviderModel 的容量拒绝", () => {
    const config = materializeConfig();
    config.models!.providers!.cpa!.models = Array.from({ length: 100 }, (_, i) => ({ id: `m-${i}` }));
    const runtime = completeRuntime({
      configuredModels: [{ ref: "cpa/runtime-model", available: true, tags: [] }],
      allModels: [{ ref: "cpa/runtime-model", available: true, tags: [] }]
    });
    const entry = inventoryEntryFor(config, runtime, "cpa/runtime-model");

    expect(() => materializeRuntimeModel(config, entry, materializeInput())).toThrow(/limit|100/);
  });
});
