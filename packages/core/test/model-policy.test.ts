import { describe, expect, test } from "bun:test";
import {
  addPolicyAllow,
  getModelPolicyMode,
  getModelSelectionSource,
  isPolicyAllowsRef,
  policyRestricts,
  readModelPolicyAllow,
  removePolicyAllow
} from "../src/model-policy";
import type { OpenClawConfig } from "../src/types";

function configWithPolicy(allow: unknown): OpenClawConfig {
  return { agents: { defaults: { modelPolicy: { allow } } } } as OpenClawConfig;
}

describe("model-policy 归一层", () => {
  test("有效 selection 模式区分缺失、显式空数组与非空原始数组", () => {
    expect(getModelPolicyMode({})).toBe("legacy");
    expect(getModelPolicyMode(configWithPolicy([]))).toBe("unrestricted");
    expect(getModelPolicyMode(configWithPolicy(["cpa/*"]))).toBe("restricted");
    expect(getModelPolicyMode(configWithPolicy([42]))).toBe("restricted");
  });

  test("restricted selection 优先返回精确命中，否则返回通配命中", () => {
    const restricted = configWithPolicy(["cpa/*", "cpa/m1"]);
    expect(getModelSelectionSource(restricted, "cpa/m1")).toBe("policy-exact");
    expect(getModelSelectionSource(restricted, "cpa/m2")).toBe("policy-wildcard");
    expect(getModelSelectionSource(restricted, "other/m1")).toBeUndefined();
  });

  test("readModelPolicyAllow 区分键不存在与显式空数组", () => {
    expect(readModelPolicyAllow({})).toBeUndefined();
    expect(readModelPolicyAllow(configWithPolicy(undefined))).toBeUndefined();
    expect(readModelPolicyAllow(configWithPolicy([]))).toEqual([]);
    expect(readModelPolicyAllow(configWithPolicy(["a/b"]))).toEqual(["a/b"]);
  });

  test("policyRestricts 仅在 allow 非空时成立", () => {
    expect(policyRestricts({})).toBe(false);
    expect(policyRestricts(configWithPolicy([]))).toBe(false);
    expect(policyRestricts(configWithPolicy(["a/b"]))).toBe(true);
  });

  test("isPolicyAllowsRef：精确匹配 + Provider 前缀大小写折叠", () => {
    const allow = ["cpa/vertex/gemini-3.8-flash"];
    expect(isPolicyAllowsRef(allow, "cpa/vertex/gemini-3.8-flash")).toBe(true);
    expect(isPolicyAllowsRef(allow, "CPA/vertex/gemini-3.8-flash")).toBe(true);
    expect(isPolicyAllowsRef(allow, "cpa/vertex/gemini-3.8-flash-high")).toBe(false);
    expect(isPolicyAllowsRef(allow, "other/vertex/gemini-3.8-flash")).toBe(false);
  });

  test("isPolicyAllowsRef：尾部通配 provider/* 与 provider/namespace/*", () => {
    const allow = ["cpa/*", "or/anthropic/*"];
    expect(isPolicyAllowsRef(allow, "cpa/any-model")).toBe(true);
    expect(isPolicyAllowsRef(allow, "cpa/ns/model")).toBe(true);
    expect(isPolicyAllowsRef(allow, "or/anthropic/claude")).toBe(true);
    expect(isPolicyAllowsRef(allow, "or/openrouter/free")).toBe(false);
    expect(isPolicyAllowsRef(allow, "other/x")).toBe(false);
  });

  test("addPolicyAllow：仅在限制生效时追加，不重复、不创建、不通配时已覆盖", () => {
    const absent: OpenClawConfig = {};
    expect(addPolicyAllow(absent, "a/b")).toBe(false);
    expect(readModelPolicyAllow(absent)).toBeUndefined();

    const open = configWithPolicy([]);
    expect(addPolicyAllow(open, "a/b")).toBe(false);
    expect(readModelPolicyAllow(open)).toEqual([]);

    const cfg = configWithPolicy(["a/b"]);
    expect(addPolicyAllow(cfg, "a/b")).toBe(false);
    expect(addPolicyAllow(cfg, "c/d")).toBe(true);
    expect(readModelPolicyAllow(cfg)).toEqual(["a/b", "c/d"]);

    const wild = configWithPolicy(["cpa/*"]);
    expect(addPolicyAllow(wild, "cpa/x")).toBe(false);
    expect(readModelPolicyAllow(wild)).toEqual(["cpa/*"]);
  });

  test("removePolicyAllow：移除同一逻辑模型的精确条目，通配条目不动，Provider 大小写折叠", () => {
    const cfg = configWithPolicy(["cpa/a", "CPA/a", "cpa/b", "cpa/*", "other/a"]);
    expect(removePolicyAllow(cfg, "cpa/a")).toBe(true);
    expect(readModelPolicyAllow(cfg)).toEqual(["cpa/b", "cpa/*", "other/a"]);

    expect(removePolicyAllow(cfg, "cpa/not-there")).toBe(false);
    expect(readModelPolicyAllow(cfg)).toEqual(["cpa/b", "cpa/*", "other/a"]);

    const open = configWithPolicy([]);
    expect(removePolicyAllow(open, "a/b")).toBe(false);
    expect(readModelPolicyAllow(open)).toEqual([]);

    const absent: OpenClawConfig = {};
    expect(removePolicyAllow(absent, "a/b")).toBe(false);
    expect(readModelPolicyAllow(absent)).toBeUndefined();
  });

  test("非字符串条目在写入时原样保留", () => {
    const cfg = configWithPolicy(["a/b", 42, null]);
    expect(policyRestricts(cfg)).toBe(true);
    expect(addPolicyAllow(cfg, "c/d")).toBe(true);
    expect(removePolicyAllow(cfg, "a/b")).toBe(true);
    const raw = (cfg.agents!.defaults as Record<string, { allow: unknown[] }>).modelPolicy!.allow;
    expect(raw).toEqual([42, null, "c/d"]);
  });
});
