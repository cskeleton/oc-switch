import { describe, expect, test } from "bun:test";
import {
  addModelPolicyRule,
  assertModelPolicyRevision,
  buildModelPolicyRevision,
  canRemoveModelPolicyRules,
  isModelPolicyEditError,
  removeModelPolicyRule,
  removeModelPolicyRules,
  removeModelPolicyWildcard,
  replaceModelPolicyRule,
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

describe("buildModelPolicyRevision", () => {
  test("同 policy 同 hash（v1: 前缀的 64 位 hex），独立克隆相等", () => {
    const a = restrictedConfig();
    const b = structuredClone(a);

    const revision = buildModelPolicyRevision(a);
    expect(revision).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(buildModelPolicyRevision(b)).toBe(revision);
  });

  test("顺序 / 大小写 / 重复次数变化导致不同 hash", () => {
    const base = buildModelPolicyRevision(restrictedConfig(["cpa/*", "other/model"]));

    expect(buildModelPolicyRevision(restrictedConfig(["other/model", "cpa/*"]))).not.toBe(base);
    expect(buildModelPolicyRevision(restrictedConfig(["CPA/*", "other/model"]))).not.toBe(base);
    expect(buildModelPolicyRevision(restrictedConfig(["cpa/*", "cpa/*", "other/model"]))).not.toBe(base);
  });

  test("模式变化导致不同 hash（restricted / unrestricted / legacy）", () => {
    const restrictedHash = buildModelPolicyRevision(restrictedConfig(["cpa/*"]));
    const unrestrictedHash = buildModelPolicyRevision(restrictedConfig([]));
    const legacy = restrictedConfig(["cpa/*"]);
    delete legacy.agents!.defaults!.modelPolicy;

    expect(unrestrictedHash).not.toBe(restrictedHash);
    expect(buildModelPolicyRevision(legacy)).not.toBe(restrictedHash);
  });

  test("与 policy 无关的配置变化不影响 hash（providers / metadata / primary / env 无关字段）", () => {
    const config = restrictedConfig();
    const revision = buildModelPolicyRevision(config);

    const changed = structuredClone(config);
    changed.models!.providers!.extra = { models: [{ id: "x" }] };
    changed.agents!.defaults!.models = { "cpa/m1": { name: "alias" } };
    changed.agents!.defaults!.model = "cpa/m1";

    expect(buildModelPolicyRevision(changed)).toBe(revision);
  });

  test("非字符串项计入 hash 但原始值不出现在输出中", () => {
    const secretMarker = "sk-super-secret-value";
    const withNumber = buildModelPolicyRevision(restrictedConfig(["cpa/*", 42]));
    const withString = buildModelPolicyRevision(restrictedConfig(["cpa/*", secretMarker]));

    // 非字符串项参与指纹（类型标记不同 → hash 不同；字符串项按原值计入）
    expect(withNumber).not.toBe(withString);
    // 输出仅 v1:<hex>，原始非法值永不回显
    expect(withNumber).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(withString).not.toContain(secretMarker);

    // 非字符串项的位置变化同样改变 hash
    expect(buildModelPolicyRevision(restrictedConfig([42, "cpa/*"]))).not.toBe(withNumber);
  });
});

describe("assertModelPolicyRevision", () => {
  test("与当前 revision 一致时通过；不一致抛 policy-revision-conflict", () => {
    const config = restrictedConfig();

    expect(() => assertModelPolicyRevision(config, buildModelPolicyRevision(config))).not.toThrow();

    const error = requirePolicyEditError(captureError(() => assertModelPolicyRevision(config, "v1:" + "0".repeat(64))));
    expect(error.code).toBe("policy-revision-conflict");

    // policy 变化后旧 revision 失效；无关配置变化不失效
    const changed = structuredClone(config);
    changed.agents!.defaults!.modelPolicy!.allow = ["cpa/*"];
    expect(requirePolicyEditError(captureError(() => assertModelPolicyRevision(changed, buildModelPolicyRevision(config)))).code).toBe(
      "policy-revision-conflict"
    );
    const unrelated = structuredClone(config);
    unrelated.agents!.defaults!.model = "cpa/m1";
    expect(() => assertModelPolicyRevision(unrelated, buildModelPolicyRevision(config))).not.toThrow();
  });
});

describe("replaceModelPolicyRule", () => {
  test("sole wildcard 替换为覆盖 primary 的 exact 成功（spec §6 关键用例）", () => {
    const config = restrictedConfig(["cpa/*"]);
    config.agents!.defaults!.model = "cpa/m1";
    const before = structuredClone(config);

    const result = replaceModelPolicyRule(config, "cpa/*", "cpa/m1");

    expect(result.config.agents!.defaults!.modelPolicy!.allow).toEqual(["cpa/m1"]);
    expect(result.replacedCount).toBe(1);
    expect(result.kind).toBe("exact");
    expect(result.rule).toBe("cpa/m1");
    // 纯函数：输入 config 不被修改，无空数组中间态
    expect(config).toEqual(before);
  });

  test("替换为不覆盖 primary 的规则拒绝（输入不变）", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);
    config.agents!.defaults!.model = "cpa/m1";
    const before = structuredClone(config);

    const error = requirePolicyEditError(captureError(() => replaceModelPolicyRule(config, "cpa/*", "cpa/g/*")));
    expect(error.code).toBe("primary-model-referenced");
    expect(config).toEqual(before);
  });

  test("fallback 编辑前被覆盖、编辑后不再覆盖时拒绝（Provider 折叠匹配）", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);
    config.agents!.defaults!.model = { primary: "other/model", fallbacks: ["CPA/m2"] };
    const before = structuredClone(config);

    const error = requirePolicyEditError(captureError(() => replaceModelPolicyRule(config, "cpa/*", "new/*")));
    expect(error.code).toBe("fallback-referenced");
    expect(config).toEqual(before);
  });

  test("primary / fallback 在新规则或其他规则中仍被覆盖时允许替换", () => {
    // 新规则本身覆盖 primary
    const byNewRule = restrictedConfig(["cpa/*", "other/model"]);
    byNewRule.agents!.defaults!.model = "cpa/m1";
    expect(allowOf(replaceModelPolicyRule(byNewRule, "cpa/*", "cpa/m1").config)).toEqual(["cpa/m1", "other/model"]);

    // 其他规则继续覆盖 primary
    const byOtherRule = restrictedConfig(["cpa/*", "cpa/m1", "other/model"]);
    byOtherRule.agents!.defaults!.model = "cpa/m1";
    const result = replaceModelPolicyRule(byOtherRule, "cpa/*", "new/*");
    expect(allowOf(result.config)).toEqual(["new/*", "cpa/m1", "other/model"]);
  });

  test("重复旧值多副本：每个匹配位置写入同一新规则，数量与原位置保留", () => {
    const config = restrictedConfig(["other/model", "cpa/*", "CPA/*", "cpa/*"]);
    const before = structuredClone(config);

    const result = replaceModelPolicyRule(config, "cpa/*", "cpa/g/*");

    expect(result.replacedCount).toBe(2);
    expect(allowOf(result.config)).toEqual(["other/model", "cpa/g/*", "CPA/*", "cpa/g/*"]);
    expect(result.warnings.some((warning) => warning.includes("2"))).toBe(true);
    expect(config).toEqual(before);
  });

  test("大小写变体不混淆：CPA/* 与 cpa/* 是不同规则，不互相匹配", () => {
    const config = restrictedConfig(["CPA/*", "cpa/*", "other/model"]);

    // 旧值按原字符串完全相同匹配：CPA/* 不命中 cpa/* 的位置
    const result = replaceModelPolicyRule(config, "cpa/*", "new/*");
    expect(result.replacedCount).toBe(1);
    expect(allowOf(result.config)).toEqual(["CPA/*", "new/*", "other/model"]);

    // 反向：旧值不存在（只有大小写变体）→ not-found
    const missing = restrictedConfig(["cpa/*", "other/model"]);
    expect(requirePolicyEditError(captureError(() => replaceModelPolicyRule(missing, "CPA/*", "new/*"))).code).toBe(
      "policy-rule-not-found"
    );
  });

  test("新值归一后与旧值相同返回 unchanged-rule（trim 与 Provider 折叠后相同也算）", () => {
    const config = restrictedConfig(["cpa/*", "cpa/m1", "other/model"]);
    const before = structuredClone(config);

    expect(requirePolicyEditError(captureError(() => replaceModelPolicyRule(config, "cpa/*", "  cpa/*  "))).code).toBe(
      "unchanged-rule"
    );
    expect(requirePolicyEditError(captureError(() => replaceModelPolicyRule(config, "cpa/m1", "CPA/m1"))).code).toBe(
      "unchanged-rule"
    );
    expect(config).toEqual(before);
  });

  test("旧值不存在返回 policy-rule-not-found", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);
    const before = structuredClone(config);

    expect(requirePolicyEditError(captureError(() => replaceModelPolicyRule(config, "ghost/*", "new/*"))).code).toBe(
      "policy-rule-not-found"
    );
    expect(config).toEqual(before);
  });

  test("exact 语义重复拒绝（排除旧值副本后仍被既有 exact 覆盖，含 OpenRouter 别名）", () => {
    // Provider 折叠重复
    const folded = restrictedConfig(["CPA/m1", "other/model"]);
    expect(requirePolicyEditError(captureError(() => replaceModelPolicyRule(folded, "other/model", "cpa/m1"))).code).toBe(
      "duplicate-rule"
    );

    // OpenRouter 兼容别名重复（openrouter/free ≡ openrouter/openrouter/free）
    const alias = restrictedConfig(["openrouter/openrouter/free", "zzz/a"]);
    expect(requirePolicyEditError(captureError(() => replaceModelPolicyRule(alias, "zzz/a", "openrouter/free"))).code).toBe(
      "duplicate-rule"
    );
  });

  test("duplicate 检查排除本次全部旧值副本：exact 大小写归一替换允许", () => {
    const config = restrictedConfig(["CPA/m1", "other/model"]);
    config.agents!.defaults!.model = "cpa/m1";

    const result = replaceModelPolicyRule(config, "CPA/m1", "cpa/m1");

    expect(result.rule).toBe("cpa/m1");
    expect(allowOf(result.config)).toEqual(["cpa/m1", "other/model"]);
  });

  test("wildcard 完全相同重复拒绝；仅被其他 wildcard 覆盖允许并给冗余 warning", () => {
    // 新 wildcard 与剩余条目完全相同 → duplicate
    const duplicate = restrictedConfig(["cpa/*", "cpa/g/*", "other/model"]);
    expect(requirePolicyEditError(captureError(() => replaceModelPolicyRule(duplicate, "cpa/g/*", "cpa/*"))).code).toBe(
      "duplicate-rule"
    );

    // 新 wildcard 仅被更宽 wildcard 覆盖 → 允许 + 冗余 warning
    const redundant = restrictedConfig(["cpa/*", "cpa/g/*", "other/model"]);
    const result = replaceModelPolicyRule(redundant, "other/model", "cpa/g/x/*");
    expect(result.kind).toBe("wildcard");
    expect(result.warnings.some((warning) => warning.includes("cpa/*") && warning.includes("redundant"))).toBe(true);

    // 新 exact 仅被剩余 wildcard 覆盖 → 允许 + 冗余 warning
    const exactRedundant = restrictedConfig(["cpa/*", "other/model"]);
    const exactResult = replaceModelPolicyRule(exactRedundant, "other/model", "cpa/m1");
    expect(exactResult.warnings.some((warning) => warning.includes("cpa/*") && warning.includes("redundant"))).toBe(true);
  });

  test("非法项（非字符串）原样保留且不计入匹配", () => {
    const config = restrictedConfig([42, "cpa/*", "other/model"]);

    const result = replaceModelPolicyRule(config, "cpa/*", "new/*");

    expect(allowOf(result.config)).toEqual([42, "new/*", "other/model"]);
  });

  test("unknown Provider / 零目录命中不阻断；knownProviderIds 未命中只 warning", () => {
    const config = restrictedConfig(["ghost/missing", "other/model"]);

    // 未知 Provider 不提供 knownProviderIds → 无 warning 直接成功
    const plain = replaceModelPolicyRule(config, "ghost/missing", "unknown-provider/x");
    expect(plain.warnings).toEqual([]);

    // 提供 knownProviderIds 未命中 → warning 但不阻断
    const warned = replaceModelPolicyRule(config, "ghost/missing", "unknown-provider/x", {
      knownProviderIds: ["cpa", "other"]
    });
    expect(warned.replacedCount).toBe(1);
    expect(warned.warnings.some((warning) => warning.includes("unknown-provider"))).toBe(true);
  });

  test("OpenRouter 别名 primary 覆盖保护使用同一匹配器", () => {
    const config = restrictedConfig(["openrouter/free", "other/model"]);
    config.agents!.defaults!.model = "openrouter/openrouter/free";
    const before = structuredClone(config);

    // 旧 exact 是 primary（别名形态）的唯一覆盖 → 替换为不覆盖的规则拒绝
    expect(
      requirePolicyEditError(captureError(() => replaceModelPolicyRule(config, "openrouter/free", "new/x"))).code
    ).toBe("primary-model-referenced");
    expect(config).toEqual(before);
  });

  test("新规则非法格式 / legacy / unrestricted 拒绝", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);
    for (const invalid of ["", "abc/*x", "*/x", "no-slash"]) {
      expect(requirePolicyEditError(captureError(() => replaceModelPolicyRule(config, "cpa/*", invalid))).code).toBe(
        "invalid-rule-format"
      );
    }

    const legacy: OpenClawConfig = { agents: { defaults: {} } };
    expect(requirePolicyEditError(captureError(() => replaceModelPolicyRule(legacy, "cpa/*", "new/*"))).code).toBe(
      "policy-not-restricted"
    );
    const unrestricted = restrictedConfig([]);
    expect(requirePolicyEditError(captureError(() => replaceModelPolicyRule(unrestricted, "cpa/*", "new/*"))).code).toBe(
      "policy-not-restricted"
    );
  });

  test("inventory 提供时追加「失去策略放行」warning（替换后不再覆盖的模型）", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);
    const inventory = buildModelInventory({ config, runtime: completeRuntime() });

    const result = replaceModelPolicyRule(config, "cpa/*", "cpa/m1", { inventory });

    expect(result.warnings.some((warning) => warning.includes("1 model(s)") && warning.includes("cpa/m2"))).toBe(true);
  });
});

describe("removeModelPolicyRule", () => {
  test("删除被 wildcard 覆盖的 primary exact 允许（与旧 removeModelPolicyExactRef 的关键区别）", () => {
    const config = restrictedConfig(["cpa/*", "cpa/m1", "other/model"]);
    config.agents!.defaults!.model = "cpa/m1";
    const before = structuredClone(config);

    const result = removeModelPolicyRule(config, "cpa/m1");

    expect(result.removedCount).toBe(1);
    expect(allowOf(result.config)).toEqual(["cpa/*", "other/model"]);
    expect(config).toEqual(before);
  });

  test("删除唯一一条规则拒绝（last-rule-removal）；非字符串项计入防清空", () => {
    const sole = restrictedConfig(["cpa/*"]);
    const before = structuredClone(sole);
    const error = requirePolicyEditError(captureError(() => removeModelPolicyRule(sole, "cpa/*")));
    expect(error.code).toBe("last-rule-removal");
    expect(sole).toEqual(before);

    // 仅剩非法项不算清空
    const withInvalid = restrictedConfig(["cpa/*", 42]);
    const result = removeModelPolicyRule(withInvalid, "cpa/*");
    expect(allowOf(result.config)).toEqual([42]);
  });

  test("删除不被其他规则覆盖的 primary wildcard 拒绝；fallback 同样保护", () => {
    const primary = restrictedConfig(["cpa/*", "other/model"]);
    primary.agents!.defaults!.model = "cpa/m1";
    expect(requirePolicyEditError(captureError(() => removeModelPolicyRule(primary, "cpa/*"))).code).toBe(
      "primary-model-referenced"
    );

    const fallback = restrictedConfig(["cpa/*", "other/model"]);
    fallback.agents!.defaults!.model = { primary: "other/model", fallbacks: ["cpa/m2"] };
    expect(requirePolicyEditError(captureError(() => removeModelPolicyRule(fallback, "cpa/*"))).code).toBe(
      "fallback-referenced"
    );
  });

  test("删除 exact 与 wildcard 都走同一入口；重复副本全删返回 removedCount", () => {
    const exact = restrictedConfig(["cpa/m1", "other/model"]);
    const exactResult = removeModelPolicyRule(exact, "cpa/m1");
    expect(exactResult.removedCount).toBe(1);
    expect(allowOf(exactResult.config)).toEqual(["other/model"]);

    const duplicates = restrictedConfig(["cpa/*", "cpa/*", "other/model"]);
    const dupResult = removeModelPolicyRule(duplicates, "cpa/*");
    expect(dupResult.removedCount).toBe(2);
    expect(allowOf(dupResult.config)).toEqual(["other/model"]);
    expect(dupResult.warnings.some((warning) => warning.includes("Removed 2"))).toBe(true);
  });

  test("大小写变体不混淆；其他条目大小写、顺序、非字符串项原样保留", () => {
    const config = restrictedConfig(["CPA/*", 42, "cpa/*", "other/model"]);
    const before = structuredClone(config);

    const result = removeModelPolicyRule(config, "cpa/*");

    expect(result.removedCount).toBe(1);
    expect(allowOf(result.config)).toEqual(["CPA/*", 42, "other/model"]);
    expect(config).toEqual(before);
  });

  test("旧值不存在返回 policy-rule-not-found；legacy / unrestricted 拒绝", () => {
    const config = restrictedConfig(["cpa/*", "other/model"]);
    expect(requirePolicyEditError(captureError(() => removeModelPolicyRule(config, "CPA/*"))).code).toBe(
      "policy-rule-not-found"
    );

    const legacy: OpenClawConfig = { agents: { defaults: {} } };
    expect(requirePolicyEditError(captureError(() => removeModelPolicyRule(legacy, "cpa/*"))).code).toBe(
      "policy-not-restricted"
    );
    const unrestricted = restrictedConfig([]);
    expect(requirePolicyEditError(captureError(() => removeModelPolicyRule(unrestricted, "cpa/*"))).code).toBe(
      "policy-not-restricted"
    );
  });

  test("unknown / 零命中不阻断；inventory 提供时追加「失去策略放行」warning（exact 同样生效）", () => {
    const ghost = restrictedConfig(["ghost/missing", "other/model"]);
    const plain = removeModelPolicyRule(ghost, "ghost/missing");
    expect(plain.warnings).toEqual([]);

    const config = restrictedConfig(["cpa/*", "cpa/m1", "other/model"]);
    const inventory = buildModelInventory({ config, runtime: completeRuntime() });
    // 删除 exact cpa/m1：它被 cpa/* 覆盖，无模型失去放行 → 无 warning
    const covered = removeModelPolicyRule(config, "cpa/m1", { inventory });
    expect(covered.warnings).toEqual([]);

    // 删除 wildcard cpa/*：cpa/m1 仍被 exact 覆盖，仅 cpa/m2 失去放行
    const losing = removeModelPolicyRule(config, "cpa/*", { inventory });
    expect(losing.warnings.some((warning) => warning.includes("1 model(s)") && warning.includes("cpa/m2"))).toBe(true);
  });
});

describe("removeModelPolicyRules（批量纯规则删除，stale cleanup spec §3/§7）", () => {
  test("批量删除多条 exact（含重复副本与大小写变体）：removedCount 为总副本数，其余规则原样保留", () => {
    const config = restrictedConfig(["ghost/missing", "ghost/missing", "Ghost/missing", "other/model", 42]);
    const before = structuredClone(config);

    const result = removeModelPolicyRules(config, ["ghost/missing", "Ghost/missing"]);

    expect(result.removedCount).toBe(3);
    expect(allowOf(result.config)).toEqual(["other/model", 42]);
    // ghost/missing 两个完全相同副本报一条 warning；Ghost/missing 变体单副本不报
    expect(result.warnings.filter((warning) => warning.includes("Removed 2 identical entries of the rule ghost/missing"))).toHaveLength(1);
    expect(config).toEqual(before);
  });

  test("values 内重复字符串按一条计：removedCount 仍是 allow 中的总副本数", () => {
    const config = restrictedConfig(["ghost/missing", "ghost/missing", "other/model"]);
    const result = removeModelPolicyRules(config, ["ghost/missing", "ghost/missing"]);
    expect(result.removedCount).toBe(2);
    expect(allowOf(result.config)).toEqual(["other/model"]);
  });

  test("空数组 no-op 成功：removedCount 0、allow 不变、无 warning、不视为错误", () => {
    const config = restrictedConfig(["ghost/missing", "other/model"]);
    const result = removeModelPolicyRules(config, []);
    expect(result.removedCount).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(allowOf(result.config)).toEqual(["ghost/missing", "other/model"]);
    // legacy 模式下空数组同样 no-op 成功（不触发模式门禁）
    const legacy: OpenClawConfig = { agents: { defaults: {} } };
    expect(removeModelPolicyRules(legacy, []).removedCount).toBe(0);
  });

  test("legacy / unrestricted 模式拒绝（非空 values）", () => {
    const legacy: OpenClawConfig = { agents: { defaults: {} } };
    expect(requirePolicyEditError(captureError(() => removeModelPolicyRules(legacy, ["cpa/*"]))).code).toBe(
      "policy-not-restricted"
    );
    const unrestricted = restrictedConfig([]);
    expect(requirePolicyEditError(captureError(() => removeModelPolicyRules(unrestricted, ["cpa/*"]))).code).toBe(
      "policy-not-restricted"
    );
  });

  test("任一 value 不存在：整体拒绝，policy-rule-not-found 且 refs/消息列出缺失值", () => {
    const config = restrictedConfig(["ghost/missing", "other/model"]);
    const before = structuredClone(config);

    const error = requirePolicyEditError(
      captureError(() => removeModelPolicyRules(config, ["ghost/missing", "nope/x", "also/missing"]))
    );

    expect(error.code).toBe("policy-rule-not-found");
    expect(error.refs).toEqual(["nope/x", "also/missing"]);
    expect(error.message).toContain("nope/x");
    expect(error.message).toContain("also/missing");
    expect(config).toEqual(before);
  });

  test("删后 raw 为空：last-rule-removal 整体拒绝，refs 为全部待删值", () => {
    const config = restrictedConfig(["ghost/missing", "other/missing"]);
    const error = requirePolicyEditError(captureError(() => removeModelPolicyRules(config, ["ghost/missing", "other/missing"])));
    expect(error.code).toBe("last-rule-removal");
    expect(error.refs).toEqual(["ghost/missing", "other/missing"]);
  });

  test("primary 指向未知 Provider 的 ref：仍被 primary-model-referenced 保护（provider 不存在不豁免）", () => {
    const config: OpenClawConfig = {
      ...restrictedConfig(["ghost/missing", "other/model"]),
      agents: { defaults: { models: {}, model: "ghost/missing", modelPolicy: { allow: ["ghost/missing", "other/model"] } } }
    };
    const error = requirePolicyEditError(captureError(() => removeModelPolicyRules(config, ["ghost/missing"])));
    expect(error.code).toBe("primary-model-referenced");
    expect(error.refs).toEqual(["ghost/missing"]);
  });

  test("primary 被其中一条待删规则覆盖、其余规则不覆盖：refs 只列触发覆盖丢失的规则", () => {
    // primary 同时被两条待删 exact 覆盖（Provider 大小写变体各覆盖）→ 两条都列为触发 ref；
    // 保留 other/model 避免先触发 last-rule-removal（exact 匹配 model 大小写敏感，
    // 所以变体只能变 Provider 段）
    const config: OpenClawConfig = {
      models: { providers: { cpa: { models: [{ id: "m1" }] } } },
      agents: { defaults: { models: {}, model: "cpa/m1", modelPolicy: { allow: ["cpa/m1", "CPA/m1", "other/model"] } } }
    };
    const error = requirePolicyEditError(captureError(() => removeModelPolicyRules(config, ["cpa/m1", "CPA/m1"])));
    expect(error.code).toBe("primary-model-referenced");
    expect(error.refs).toEqual(["cpa/m1", "CPA/m1"]);

    // 只删不覆盖 primary 的规则 → 成功
    const ok = removeModelPolicyRules(config, ["other/model"]);
    expect(ok.removedCount).toBe(1);
  });

  test("fallback 失去覆盖：fallback-referenced 且 refs 列触发规则", () => {
    const config: OpenClawConfig = {
      ...restrictedConfig(["ghost/missing", "other/model"]),
      agents: {
        defaults: {
          models: {},
          model: { primary: "other/model", fallbacks: ["ghost/missing"] },
          modelPolicy: { allow: ["ghost/missing", "other/model"] }
        }
      }
    };
    const error = requirePolicyEditError(captureError(() => removeModelPolicyRules(config, ["ghost/missing"])));
    expect(error.code).toBe("fallback-referenced");
    expect(error.refs).toEqual(["ghost/missing"]);
  });

  test("wildcards 与非字符串条目永不进入批量删除：filter 只碰字符串精确匹配", () => {
    const config = restrictedConfig(["ghost/*", "ghost/missing", 42, "other/model"]);
    const result = removeModelPolicyRules(config, ["ghost/missing"]);
    expect(result.removedCount).toBe(1);
    expect(allowOf(result.config)).toEqual(["ghost/*", 42, "other/model"]);
  });

  test("inventory 提供时按每条被删规则追加「失去策略放行」warning", () => {
    const config = restrictedConfig(["cpa/*", "ghost/missing", "other/model"]);
    const inventory = buildModelInventory({ config, runtime: completeRuntime() });
    const result = removeModelPolicyRules(config, ["ghost/missing"], { inventory });
    // ghost/missing 作为 policy-only ref 也是 inventory 模型行：删除后它失去放行
    expect(result.warnings.some((warning) => warning.includes("lose policy allowance") && warning.includes("ghost/missing"))).toBe(true);

    // 被删规则不单独放行任何模型行（仍被 cpa/* 覆盖）→ 无失去放行 warning
    const coveredConfig = restrictedConfig(["cpa/*", "cpa/m1", "other/model"]);
    const covered = removeModelPolicyRules(coveredConfig, ["cpa/m1"], {
      inventory: buildModelInventory({ config: coveredConfig, runtime: completeRuntime() })
    });
    expect(covered.warnings).toEqual([]);

    const losingConfig = restrictedConfig(["cpa/m1", "cpa/m2", "other/model"]);
    const losingInventory = buildModelInventory({ config: losingConfig, runtime: completeRuntime() });
    const losing = removeModelPolicyRules(losingConfig, ["cpa/m1", "cpa/m2"], { inventory: losingInventory });
    expect(losing.warnings.some((warning) => warning.includes("lose policy allowance"))).toBe(true);
  });
});

describe("canRemoveModelPolicyRules（批量可删性投影）", () => {
  test("与批量成败严格一致：可删 true；不存在 / 防清空 / primary / fallback / 非 restricted 均 false", () => {
    expect(canRemoveModelPolicyRules(restrictedConfig(), ["ghost/missing"])).toBe(true);
    expect(canRemoveModelPolicyRules(restrictedConfig(), ["ghost/missing", "nope/x"])).toBe(false);
    expect(canRemoveModelPolicyRules(restrictedConfig(["ghost/missing"]), ["ghost/missing"])).toBe(false);

    const primaryConfig: OpenClawConfig = {
      ...restrictedConfig(["ghost/missing", "other/model"]),
      agents: { defaults: { models: {}, model: "ghost/missing", modelPolicy: { allow: ["ghost/missing", "other/model"] } } }
    };
    expect(canRemoveModelPolicyRules(primaryConfig, ["ghost/missing"])).toBe(false);
    expect(canRemoveModelPolicyRules(primaryConfig, ["other/model"])).toBe(true);

    const legacy: OpenClawConfig = { agents: { defaults: {} } };
    expect(canRemoveModelPolicyRules(legacy, ["cpa/*"])).toBe(false);
  });

  test("空数组投影为 true（no-op 可删）；输入 config 不被修改", () => {
    const config = restrictedConfig();
    const before = structuredClone(config);
    expect(canRemoveModelPolicyRules(config, [])).toBe(true);
    expect(canRemoveModelPolicyRules(config, ["ghost/missing", "ghost/missing"])).toBe(true);
    expect(config).toEqual(before);
  });
});
