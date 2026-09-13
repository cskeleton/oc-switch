import { describe, expect, test } from "bun:test";
import {
  addModelPolicyRule,
  isModelPolicyEditError,
  removeModelPolicyWildcard,
  ModelPolicyEditError
} from "../src/model-policy-edit";
import { buildModelInventory } from "../src/model-inventory";
import type { RuntimeModelSnapshot } from "../src/runtime-model-catalog";
import type { OpenClawConfig } from "../src/types";

/**
 * policy 规则编辑 operation（spec §3 Core 契约 / §8 core 矩阵）的纯函数测试。
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

/** 断言为 ModelPolicyEditError 并返回，供进一步检查 code */
function requirePolicyEditError(error: unknown): ModelPolicyEditError {
  if (!isModelPolicyEditError(error)) {
    throw new Error(`expected ModelPolicyEditError, got: ${String(error)}`);
  }
  return error;
}

/** restricted policy fixture：cpa 两模型 + other 兜底 exact + ghost 悬空 exact */
function restrictedConfig(allow: unknown[] = ["cpa/*", "other/model", "ghost/missing"]): OpenClawConfig {
  return {
    models: {
      providers: {
        cpa: { models: [{ id: "m1" }, { id: "m2" }] },
        other: { models: [{ id: "model" }] }
      }
    },
    agents: {
      defaults: {
        models: {},
        modelPolicy: { allow }
      }
    }
  };
}

function allowOf(config: OpenClawConfig): unknown[] | undefined {
  return config.agents?.defaults?.modelPolicy?.allow;
}

describe("addModelPolicyRule", () => {
  test("添加 exact 成功：push 到末尾并按 normalizeModelRefForStorage 归一存储", () => {
    const config = restrictedConfig(["other/model"]);
    const before = structuredClone(config);

    const result = addModelPolicyRule(config, "CPA/MyModel");

    expect(result.kind).toBe("exact");
    expect(result.rule).toBe("cpa/MyModel");
    expect(allowOf(result.config)).toEqual(["other/model", "cpa/MyModel"]);
    expect(result.warnings).toEqual([]);
    // 纯函数：输入 config 不被修改
    expect(config).toEqual(before);
  });

  test("添加 wildcard 成功：按用户输入原样存储（仅 trim），不改写大小写", () => {
    const config = restrictedConfig(["other/model"]);

    const result = addModelPolicyRule(config, "  NEW/Namespace/*  ");

    expect(result.kind).toBe("wildcard");
    expect(result.rule).toBe("NEW/Namespace/*");
    expect(allowOf(result.config)).toEqual(["other/model", "NEW/Namespace/*"]);
    expect(result.warnings).toEqual([]);
  });

  test("legacy / unrestricted 模式拒绝且不创建、不改写 policy", () => {
    // legacy：无 modelPolicy
    const legacy: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "m1" }] } } },
      agents: { defaults: { models: { "cpa/m1": {} } } }
    };
    const legacyError = requirePolicyEditError(captureError(() => addModelPolicyRule(legacy, "cpa/m1")));
    expect(legacyError.code).toBe("policy-not-restricted");
    expect(legacyError.message).toContain("legacy");
    expect(legacy.agents?.defaults?.modelPolicy).toBeUndefined();

    // unrestricted：显式 []，不得被 push 改形
    const unrestricted = restrictedConfig([]);
    const before = structuredClone(unrestricted);
    const unrestrictedError = requirePolicyEditError(captureError(() => addModelPolicyRule(unrestricted, "cpa/m1")));
    expect(unrestrictedError.code).toBe("policy-not-restricted");
    expect(unrestrictedError.message).toContain("unrestricted");
    expect(unrestricted).toEqual(before);
  });

  test("模式门禁先于 duplicate 检查，格式校验先于模式门禁", () => {
    const legacy: OpenClawConfig = { agents: { defaults: {} } };
    // legacy + 非法格式 → invalid-rule-format（顺序：格式 → 模式）
    expect(requirePolicyEditError(captureError(() => addModelPolicyRule(legacy, "nonsense"))).code).toBe(
      "invalid-rule-format"
    );
    // legacy + 合法格式 → policy-not-restricted
    expect(requirePolicyEditError(captureError(() => addModelPolicyRule(legacy, "cpa/m1"))).code).toBe(
      "policy-not-restricted"
    );
  });

  test("空串与非法格式拒绝：空 / `abc/*x` / `*/x` / `/*` / 无斜杠 exact / body 含 * / 空首段", () => {
    const config = restrictedConfig();
    const before = structuredClone(config);
    for (const invalid of ["", "   ", "abc/*x", "*/x", "/*", "no-slash", "a/**", "/x/*", "provider/", "/model", "*"]) {
      const error = requirePolicyEditError(captureError(() => addModelPolicyRule(config, invalid)));
      expect(error.code).toBe("invalid-rule-format");
    }
    expect(config).toEqual(before);
  });

  test("exact 语义重复拒绝（Provider 折叠 + model 敏感；model 大小写不同不算重复）", () => {
    const config = restrictedConfig(["CPA/M1", "other/model"]);
    const before = structuredClone(config);

    // Provider 大小写折叠后命中既有 exact
    const error = requirePolicyEditError(captureError(() => addModelPolicyRule(config, "cpa/M1")));
    expect(error.code).toBe("duplicate-rule");
    // model ID 大小写敏感：cpa/m1 与 CPA/M1 是不同模型
    const result = addModelPolicyRule(config, "cpa/m1");
    expect(result.rule).toBe("cpa/m1");
    expect(allowOf(result.config)).toEqual(["CPA/M1", "other/model", "cpa/m1"]);
    expect(config).toEqual(before);
  });

  test("wildcard 完全相同字符串重复拒绝；大小写变体不算完全相同（放行 + 冗余 warning）", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);

    const error = requirePolicyEditError(captureError(() => addModelPolicyRule(config, "cpa/*")));
    expect(error.code).toBe("duplicate-rule");

    // 完全不同字符串 → 允许；但被既有 cpa/* 语义覆盖 → 冗余 warning
    const result = addModelPolicyRule(config, "CPA/*");
    expect(result.rule).toBe("CPA/*");
    expect(result.warnings.some((warning) => warning.includes("cpa/*"))).toBe(true);
  });

  test("exact 仅被 wildcard 覆盖时允许写入并提示冗余", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);

    const result = addModelPolicyRule(config, "cpa/m1");

    expect(result.kind).toBe("exact");
    expect(allowOf(result.config)).toEqual(["cpa/*", "other/model", "cpa/m1"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("cpa/*");
    expect(result.warnings[0]).toContain("redundant");
  });

  test("wildcard 被更宽的现有 wildcard 覆盖时允许写入并提示", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);

    const result = addModelPolicyRule(config, "cpa/namespace/*");

    expect(result.kind).toBe("wildcard");
    expect(allowOf(result.config)).toEqual(["cpa/*", "other/model", "cpa/namespace/*"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("cpa/*");
  });

  test("knownProviderIds 未命中只 warning 不阻断；大小写折叠命中则不提示；不提供则不提示", () => {
    const config = restrictedConfig(["other/model"]);

    const missed = addModelPolicyRule(config, "new/*", { knownProviderIds: ["CPA"] });
    expect(missed.warnings).toHaveLength(1);
    expect(missed.warnings[0]).toContain("new");

    const foldedHit = addModelPolicyRule(config, "CPA/m9", { knownProviderIds: ["cpa"] });
    expect(foldedHit.warnings).toEqual([]);

    const notProvided = addModelPolicyRule(config, "new/*");
    expect(notProvided.warnings).toEqual([]);
  });

  test("写入不动其它条目的大小写、顺序、重复次数与非字符串条目", () => {
    const config = restrictedConfig(["CPA/*", 42, "cpa/*", "cpa/*"]);
    const before = structuredClone(config);

    const result = addModelPolicyRule(config, "x/y");

    expect(allowOf(result.config)).toEqual(["CPA/*", 42, "cpa/*", "cpa/*", "x/y"]);
    expect(config).toEqual(before);
  });
});

describe("removeModelPolicyWildcard", () => {
  test("删除 wildcard 成功：其余条目原样保留，removedCount=1，无 warning", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);
    const before = structuredClone(config);

    const result = removeModelPolicyWildcard(config, "cpa/*");

    expect(result.removedCount).toBe(1);
    expect(allowOf(result.config)).toEqual(["other/model"]);
    expect(result.warnings).toEqual([]);
    expect(config).toEqual(before);
  });

  test("重复副本按完全相同字符串全删并报 removedCount（大小写变体保留）", () => {
    const config = restrictedConfig(["CPA/*", "cpa/*", "cpa/*", "other/model"]);

    const result = removeModelPolicyWildcard(config, "cpa/*");

    expect(result.removedCount).toBe(2);
    expect(allowOf(result.config)).toEqual(["CPA/*", "other/model"]);
    expect(result.warnings.some((warning) => warning.includes("Removed 2"))).toBe(true);
  });

  test("value trim 后参与匹配；raw 不存在完全相同字符串时 not-found", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);
    const before = structuredClone(config);

    expect(requirePolicyEditError(captureError(() => removeModelPolicyWildcard(config, "ghost/*"))).code).toBe(
      "policy-rule-not-found"
    );
    // 大小写变体不是完全相同字符串
    expect(requirePolicyEditError(captureError(() => removeModelPolicyWildcard(config, "CPA/*"))).code).toBe(
      "policy-rule-not-found"
    );
    expect(config).toEqual(before);
  });

  test("非 wildcard 输入拒绝并指引走 removeModelPolicyExactRef", () => {
    const config = restrictedConfig();

    const error = requirePolicyEditError(captureError(() => removeModelPolicyWildcard(config, "cpa/m1")));
    expect(error.code).toBe("invalid-rule-format");
    expect(error.message).toContain("removeModelPolicyExactRef");
  });

  test("legacy / unrestricted 模式拒绝（模式门禁先于存在性检查）", () => {
    const legacy: OpenClawConfig = { agents: { defaults: { models: { "cpa/m1": {} } } } };
    expect(requirePolicyEditError(captureError(() => removeModelPolicyWildcard(legacy, "cpa/*"))).code).toBe(
      "policy-not-restricted"
    );

    const unrestricted = restrictedConfig([]);
    expect(requirePolicyEditError(captureError(() => removeModelPolicyWildcard(unrestricted, "cpa/*"))).code).toBe(
      "policy-not-restricted"
    );
  });

  test("防清空：删除后 raw 变 [] 会变 unrestricted，fail closed", () => {
    const config = restrictedConfig(["cpa/*"]);
    const before = structuredClone(config);

    const error = requirePolicyEditError(captureError(() => removeModelPolicyWildcard(config, "cpa/*")));
    expect(error.code).toBe("last-rule-removal");
    expect(error.message).toContain("unrestricted");
    expect(config).toEqual(before);
  });

  test("非字符串条目计入剩余：删除 wildcard 后仅剩非字符串条目不算清空", () => {
    const config = restrictedConfig(["cpa/*", 42]);

    const result = removeModelPolicyWildcard(config, "cpa/*");

    expect(result.removedCount).toBe(1);
    expect(allowOf(result.config)).toEqual([42]);
  });

  test("primary 当前被该 wildcard 覆盖且剩余规则不再覆盖时拒绝", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);
    config.agents!.defaults!.model = "CPA/m1";
    const before = structuredClone(config);

    const error = requirePolicyEditError(captureError(() => removeModelPolicyWildcard(config, "cpa/*")));
    expect(error.code).toBe("primary-model-referenced");
    expect(config).toEqual(before);
  });

  test("primary 仍被剩余 exact / 其他 wildcard 覆盖时允许删除", () => {
    // 剩余 exact 兜底
    const withExact = restrictedConfig(["cpa/*", "cpa/m1", "other/model"]);
    withExact.agents!.defaults!.model = "cpa/m1";
    const exactResult = removeModelPolicyWildcard(withExact, "cpa/*");
    expect(exactResult.removedCount).toBe(1);
    expect(allowOf(exactResult.config)).toEqual(["cpa/m1", "other/model"]);

    // 剩余更宽 wildcard 兜底
    const withWildcard = restrictedConfig(["cpa/ns/*", "cpa/*", "other/model"]);
    withWildcard.agents!.defaults!.model = "cpa/ns/m9";
    const wildcardResult = removeModelPolicyWildcard(withWildcard, "cpa/ns/*");
    expect(allowOf(wildcardResult.config)).toEqual(["cpa/*", "other/model"]);
  });

  test("fallback 当前被该 wildcard 覆盖且剩余规则不再覆盖时拒绝（Provider 折叠匹配）", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);
    config.agents!.defaults!.model = { primary: "other/model", fallbacks: ["CPA/m2"] };
    const before = structuredClone(config);

    const error = requirePolicyEditError(captureError(() => removeModelPolicyWildcard(config, "cpa/*")));
    expect(error.code).toBe("fallback-referenced");
    expect(config).toEqual(before);
  });

  test("删除不动其它规则的大小写、顺序、重复次数与非字符串条目", () => {
    const config = restrictedConfig(["CPA/*", 42, "cpa/*", "cpa/*", "Other/Model"]);

    const result = removeModelPolicyWildcard(config, "cpa/*");

    expect(allowOf(result.config)).toEqual(["CPA/*", 42, "Other/Model"]);
  });

  test("inventory 提供时追加「失去策略放行」warning（最多列 5 个 ref）", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);
    const inventory = buildModelInventory({ config, runtime: completeRuntime() });

    const result = removeModelPolicyWildcard(config, "cpa/*", { inventory });

    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("2 model(s)");
    expect(result.warnings[0]).toContain("cpa/m1");
    expect(result.warnings[0]).toContain("cpa/m2");
    expect(result.warnings[0]).not.toContain("other/model");

    // 超过 5 个时截断为前 5 个 + 省略标记
    const many: OpenClawConfig = {
      models: {
        providers: {
          big: { models: Array.from({ length: 7 }, (_, index) => ({ id: `m${index}` })) }
        }
      },
      agents: { defaults: { modelPolicy: { allow: ["big/*", "other/model"] } } }
    };
    const manyInventory = buildModelInventory({ config: many, runtime: completeRuntime() });
    const manyResult = removeModelPolicyWildcard(many, "big/*", { inventory: manyInventory });
    expect(manyResult.warnings[0]).toContain("7 model(s)");
    expect(manyResult.warnings[0]).toContain("big/m0");
    expect(manyResult.warnings[0]).not.toContain("big/m5");
    expect(manyResult.warnings[0]).toContain("…");
  });

  test("无 inventory 时跳过「失去策略放行」warning", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);

    const result = removeModelPolicyWildcard(config, "cpa/*");

    expect(result.warnings).toEqual([]);
  });
});

/** 完整探测的 runtime snapshot（可用性不影响规则编辑语义，仅让 inventory 确定） */
function completeRuntime(): RuntimeModelSnapshot {
  return {
    fallbackRefs: [],
    allowedRefs: [],
    configuredModels: [],
    allModels: [],
    completeness: { status: true, configuredList: true, allList: true },
    diagnostics: [],
    capturedAt: "2026-09-13T00:00:00.000Z"
  };
}
