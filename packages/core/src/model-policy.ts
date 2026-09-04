import { normalizeProviderId, parseModelRef } from "./model-ref";
import type { ModelPolicyMode, ModelSelectionSource, OpenClawConfig } from "./types";

/**
 * `agents.defaults.modelPolicy.allow` 归一层：OpenClaw 2026.8+ 的覆盖 allowlist。
 *
 * OpenClaw 语义（docs.openclaw.ai/concepts/models）：
 * - 非空时是 /model、session override、--model 的唯一 allowlist，覆盖 agents.defaults.models；
 * - 支持精确 ref 与尾部前缀通配（`provider/*`、`provider/namespace/*`）；
 * - 省略该键 = legacy，沿用 agents.defaults.models；设为 [] = unrestricted，放开本地目录模型。
 *
 * oc-switch 纪律：仅在 allow 存在且非空时同步成员变化；绝不创建该键、绝不清空，
 * 避免给未迁移或已显式放开的配置凭空加限制。读取永不抛错。
 */

function readModelPolicyRecord(config: OpenClawConfig): Record<string, unknown> | undefined {
  const defaults = config.agents?.defaults as Record<string, unknown> | undefined;
  const policy = defaults?.modelPolicy;
  return typeof policy === "object" && policy !== null && !Array.isArray(policy)
    ? (policy as Record<string, unknown>)
    : undefined;
}

/** 读取 allow 原始数组；键不存在或非数组时返回 undefined（与显式 [] 区分）。 */
export function readModelPolicyAllowRaw(config: OpenClawConfig): unknown[] | undefined {
  const allow = readModelPolicyRecord(config)?.allow;
  return Array.isArray(allow) ? allow : undefined;
}

/** 读取 allow 中的字符串条目；键不存在时返回 undefined。 */
export function readModelPolicyAllow(config: OpenClawConfig): string[] | undefined {
  const raw = readModelPolicyAllowRaw(config);
  return raw?.filter((entry): entry is string => typeof entry === "string");
}

/** allow 存在且非空 = OpenClaw 实际限制可选模型。 */
export function policyRestricts(config: OpenClawConfig): boolean {
  const raw = readModelPolicyAllowRaw(config);
  return raw !== undefined && raw.length > 0;
}

/** 根据原始 allow 数组区分 legacy、显式开放与受限 selection 模式。 */
export function getModelPolicyMode(config: OpenClawConfig): ModelPolicyMode {
  const raw = readModelPolicyAllowRaw(config);
  if (raw === undefined) return "legacy";
  return raw.length === 0 ? "unrestricted" : "restricted";
}

function isWildcard(entry: string): boolean {
  return entry.endsWith("/*");
}

/** 同一逻辑模型的精确匹配：Provider 前缀大小写折叠、model ID 保持敏感。解析失败的条目/引用永不匹配。 */
function exactEntryMatches(entry: string, ref: string): boolean {
  if (isWildcard(entry)) return false;
  if (entry === ref) return true;
  try {
    const parsedEntry = parseModelRef(entry);
    const parsedRef = parseModelRef(ref);
    return (
      normalizeProviderId(parsedEntry.providerId) === normalizeProviderId(parsedRef.providerId) &&
      parsedEntry.modelId === parsedRef.modelId
    );
  } catch {
    return false;
  }
}

/** 通配匹配：去掉 `*` 后做前缀比较；Provider 段大小写折叠（折叠后重试一次）。 */
function wildcardEntryMatches(entry: string, ref: string): boolean {
  if (!isWildcard(entry)) return false;
  const prefix = entry.slice(0, -1);
  if (ref.startsWith(prefix)) return true;
  try {
    const { providerId, modelId } = parseModelRef(ref);
    const foldedRef = `${normalizeProviderId(providerId)}/${modelId}`;
    if (foldedRef.startsWith(prefix)) return true;
    const slashIndex = prefix.indexOf("/");
    if (slashIndex > 0) {
      const foldedPrefix = `${normalizeProviderId(prefix.slice(0, slashIndex))}${prefix.slice(slashIndex)}`;
      return foldedRef.startsWith(foldedPrefix);
    }
  } catch {
    return false;
  }
  return false;
}

/** allow 列表（精确 + 通配）是否覆盖 ref。 */
export function isPolicyAllowsRef(allow: string[], ref: string): boolean {
  return allow.some((entry) => exactEntryMatches(entry, ref) || wildcardEntryMatches(entry, ref));
}

/** 返回 ref 的有效 selection 来源；无有效 selection 时返回 undefined。 */
export function getModelSelectionSource(
  config: OpenClawConfig,
  ref: string
): ModelSelectionSource | undefined {
  const mode = getModelPolicyMode(config);
  if (mode === "unrestricted") return "unrestricted";
  if (mode === "legacy") {
    return Object.keys(config.agents?.defaults?.models ?? {}).some((entry) => exactEntryMatches(entry, ref))
      ? "legacy"
      : undefined;
  }

  const allow = readModelPolicyAllow(config) ?? [];
  if (allow.some((entry) => exactEntryMatches(entry, ref))) return "policy-exact";
  return allow.some((entry) => wildcardEntryMatches(entry, ref)) ? "policy-wildcard" : undefined;
}

/**
 * 追加精确 ref：仅在 policyRestricts 且未被现有条目（含通配）覆盖时写入。
 * 返回是否发生修改；非字符串条目原样保留。
 */
export function addPolicyAllow(config: OpenClawConfig, ref: string): boolean {
  if (!policyRestricts(config)) return false;
  const strings = readModelPolicyAllow(config) ?? [];
  if (isPolicyAllowsRef(strings, ref)) return false;
  readModelPolicyAllowRaw(config)!.push(ref);
  return true;
}

/**
 * 移除同一逻辑模型的所有精确条目；通配条目不动（调用方按需告警）。
 * 返回是否发生修改；非字符串条目原样保留。
 */
export function removePolicyAllow(config: OpenClawConfig, ref: string): boolean {
  if (!policyRestricts(config)) return false;
  const raw = readModelPolicyAllowRaw(config)!;
  const next = raw.filter((entry) => typeof entry !== "string" || !exactEntryMatches(entry, ref));
  if (next.length === raw.length) return false;
  readModelPolicyRecord(config)!.allow = next;
  return true;
}

/** 移除某 Provider 下的所有精确条目；返回仍引用该 Provider 的通配条目（供调用方告警）。 */
export function removePolicyAllowForProvider(config: OpenClawConfig, providerId: string): string[] {
  if (!policyRestricts(config)) return [];
  const raw = readModelPolicyAllowRaw(config)!;
  const leftoverWildcards: string[] = [];
  const next = raw.filter((entry) => {
    if (typeof entry !== "string") return true;
    try {
      const providerPart = entry.slice(0, entry.indexOf("/"));
      if (normalizeProviderId(providerPart) !== normalizeProviderId(providerId)) return true;
      if (isWildcard(entry)) {
        leftoverWildcards.push(entry);
        return true;
      }
      return false;
    } catch {
      return true;
    }
  });
  if (next.length !== raw.length) readModelPolicyRecord(config)!.allow = next;
  return leftoverWildcards;
}

/**
 * 改写 policy 条目的 Provider 前缀（用于 case-merge / 小写规范化）：
 * 精确与通配条目都处理；精确条目可按 modelId 过滤（keepModelIds 场景），通配条目只改写 Provider 段。
 * 返回是否发生修改。
 */
export function rewritePolicyAllowProviderPrefix(
  config: OpenClawConfig,
  fromProviderId: string,
  toProviderId: string,
  options: { keepModelIds?: Set<string> | undefined; dropUncheckedExact?: boolean } = {}
): boolean {
  const raw = readModelPolicyAllowRaw(config);
  if (!raw) return false;
  let changed = false;
  const next: unknown[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      next.push(entry);
      continue;
    }
    const slashIndex = entry.indexOf("/");
    if (slashIndex <= 0) {
      next.push(entry);
      continue;
    }
    const prefix = entry.slice(0, slashIndex);
    const rest = entry.slice(slashIndex + 1);
    if (normalizeProviderId(prefix) !== normalizeProviderId(fromProviderId)) {
      next.push(entry);
      continue;
    }
    if (!isWildcard(entry) && options.keepModelIds && !options.keepModelIds.has(rest)) {
      if (options.dropUncheckedExact) {
        changed = true;
        continue;
      }
      next.push(entry);
      continue;
    }
    const rewritten = `${toProviderId}/${rest}`;
    if (rewritten !== entry) changed = true;
    next.push(rewritten);
  }
  if (changed) {
    // 改写可能产生重复（如 CPA/* 与 cpa/* 并存），去重保序
    const seen = new Set<string>();
    readModelPolicyRecord(config)!.allow = next.filter((entry) => {
      if (typeof entry !== "string") return true;
      if (seen.has(entry)) return false;
      seen.add(entry);
      return true;
    });
  }
  return changed;
}

/** 存储规范化：policy 条目的 Provider 前缀小写化（通配的 `*` 原样保留），去重保序。 */
export function normalizePolicyAllowRefs(config: OpenClawConfig): boolean {
  const raw = readModelPolicyAllowRaw(config);
  if (!raw) return false;
  let changed = false;
  const seen = new Set<string>();
  const next: unknown[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      next.push(entry);
      continue;
    }
    const slashIndex = entry.indexOf("/");
    const normalizedEntry =
      slashIndex > 0 ? `${normalizeProviderId(entry.slice(0, slashIndex))}${entry.slice(slashIndex)}` : entry;
    if (seen.has(normalizedEntry)) {
      changed = true;
      continue;
    }
    seen.add(normalizedEntry);
    changed ||= normalizedEntry !== entry;
    next.push(normalizedEntry);
  }
  if (changed) readModelPolicyRecord(config)!.allow = next;
  return changed;
}
