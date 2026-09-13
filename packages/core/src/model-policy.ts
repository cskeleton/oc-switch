import { normalizeProviderId, parseModelRef } from "./model-ref";
import type { ModelPolicyMode, ModelSelectionSource, OpenClawConfig } from "./types";

/**
 * `agents.defaults.modelPolicy.allow` 归一层：OpenClaw 2026.8+ 的覆盖 allowlist。
 *
 * OpenClaw 语义（docs.openclaw.ai/concepts/models）：
 * - 非空时是 /model、session override、--model 的唯一 allowlist，覆盖 agents.defaults.models；
 * - 支持精确 ref 与尾部前缀通配（`provider/*`、`provider/namespace/*`）；
 * - 迁移前缺失 policy 才沿用旧 models；迁移标记/空 policy 对象使 metadata 不再限制选择。
 * - 显式 [] = unrestricted。
 *
 * 常规单模型操作仅在 allow 存在且非空时同步成员变化，不创建或清空；
 * 明确整 Provider/插件停用由 model-suspension.ts 负责可恢复的规则移出。
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
  if (raw === undefined) {
    const policy = readModelPolicyRecord(config);
    // 非数组 allow 仍交由诊断阻断；迁移标记/空 policy 对象不允许旧 metadata 重新限制选择。
    if (policy && Object.hasOwn(policy, "allow")) return "legacy";
    const migrations = (config.meta as { migrations?: { modelPolicyAllowlist?: boolean } } | undefined)?.migrations;
    if (policy || migrations?.modelPolicyAllowlist === true) return "unrestricted";
    return "legacy";
  }
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
    // OpenClaw 2026.9 的 OpenRouter 兼容别名：配置常写 openrouter/free，Gateway 返回 openrouter/openrouter/free。
    const openRouterFree = normalizeProviderId(parsedEntry.providerId) === "openrouter" && normalizeProviderId(parsedRef.providerId) === "openrouter" &&
      ["free", "openrouter/free"].includes(parsedEntry.modelId) && ["free", "openrouter/free"].includes(parsedRef.modelId);
    if (openRouterFree) return true;
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

/** 返回受限 policy 中覆盖指定模型的首个通配条目；无通配或非受限模式时不阻断。 */
export function findPolicyWildcardForRef(config: OpenClawConfig, ref: string): string | undefined {
  if (!policyRestricts(config)) return undefined;
  return (readModelPolicyAllow(config) ?? []).find((entry) => wildcardEntryMatches(entry, ref));
}

/** 返回受限 policy 中覆盖指定模型的首个精确条目（duplicate 检测用）；非 restricted 或无命中返回 undefined。 */
export function findPolicyExactEntryForRef(config: OpenClawConfig, ref: string): string | undefined {
  if (getModelPolicyMode(config) !== "restricted") return undefined;
  return (readModelPolicyAllow(config) ?? []).find((entry) => exactEntryMatches(entry, ref));
}

/** 返回受限 policy 中属于指定 Provider 的首个通配条目。 */
export function findPolicyWildcardForProvider(config: OpenClawConfig, providerId: string): string | undefined {
  if (!policyRestricts(config)) return undefined;
  return (readModelPolicyAllow(config) ?? []).find((entry) => {
    if (!isWildcard(entry)) return false;
    const slashIndex = entry.indexOf("/");
    return slashIndex > 0 && normalizeProviderId(entry.slice(0, slashIndex)) === normalizeProviderId(providerId);
  });
}

/** 通配 policy 无法通过单条 metadata/目录变更准确表达，必须在任何写入前拒绝。 */
export function assertNoPolicyWildcardForRef(config: OpenClawConfig, ref: string, action: string): void {
  const wildcard = findPolicyWildcardForRef(config, ref);
  if (wildcard) {
    throw new Error(
      `Cannot ${action} ${ref} while agents.defaults.modelPolicy.allow contains ${wildcard}; narrow the policy first.`
    );
  }
}

/** Provider 级破坏性操作同样不得遗留仍可覆盖该 Provider 的用户通配。 */
export function assertNoPolicyWildcardForProvider(config: OpenClawConfig, providerId: string, action: string): void {
  const wildcard = findPolicyWildcardForProvider(config, providerId);
  if (wildcard) {
    throw new Error(
      `Cannot ${action} provider ${providerId} while agents.defaults.modelPolicy.allow contains ${wildcard}; narrow the policy first.`
    );
  }
}

function assertPolicyRemovalPreservesRestrictedMode(
  config: OpenClawConfig,
  removes: (entry: unknown) => boolean,
  action: string,
  subject: string
): void {
  const raw = readModelPolicyAllowRaw(config);
  if (!raw || raw.length === 0) return;
  const next = raw.filter((entry) => !removes(entry));
  if (next.length === 0 && next.length !== raw.length) {
    throw new Error(
      `Cannot ${action} ${subject} because removing the last agents.defaults.modelPolicy.allow entry would make [] unrestricted; keep another exact entry or narrow the policy first.`
    );
  }
}

/** 精确模型条目删除不得把 restricted policy 意外清空为 unrestricted。 */
export function assertPolicyExactRefsRemovalAllowed(
  config: OpenClawConfig,
  refs: string[],
  action: string,
  subject: string
): void {
  assertPolicyRemovalPreservesRestrictedMode(
    config,
    (entry) => typeof entry === "string" && !isWildcard(entry) && refs.some((ref) => exactEntryMatches(entry, ref)),
    action,
    subject
  );
}

/** Provider 删除的精确条目同样不得意外把 policy 变成 unrestricted。 */
export function assertPolicyProviderExactRemovalAllowed(
  config: OpenClawConfig,
  providerId: string,
  action: string
): void {
  assertPolicyRemovalPreservesRestrictedMode(
    config,
    (entry) => {
      if (typeof entry !== "string" || isWildcard(entry)) return false;
      try {
        return normalizeProviderId(parseModelRef(entry).providerId) === normalizeProviderId(providerId);
      } catch {
        return false;
      }
    },
    action,
    `provider ${providerId}`
  );
}

/** Provider 删除显式移除其 policy 条目的防清空 guard：exact 与 wildcard 合计移除后不得把受限 policy 清空为 unrestricted。 */
export function assertPolicyProviderWildcardRemovalAllowed(
  config: OpenClawConfig,
  providerId: string,
  action: string
): void {
  assertPolicyRemovalPreservesRestrictedMode(
    config,
    (entry) => {
      if (typeof entry !== "string") return false;
      const slashIndex = entry.indexOf("/");
      return slashIndex > 0 && normalizeProviderId(entry.slice(0, slashIndex)) === normalizeProviderId(providerId);
    },
    action,
    `provider ${providerId}`
  );
}

/**
 * 移除属于指定 Provider 的所有通配条目（仅在用户显式勾选时由调用方触发）。
 * 返回被移除的条目；exact 条目、其他 Provider 的 wildcard 与非字符串条目原样保留，
 * 不改写大小写、顺序与重复次数。调用前必须先过 assertPolicyProviderWildcardRemovalAllowed。
 */
export function removePolicyWildcardForProvider(config: OpenClawConfig, providerId: string): string[] {
  if (!policyRestricts(config)) return [];
  const raw = readModelPolicyAllowRaw(config)!;
  const removed: string[] = [];
  const next = raw.filter((entry) => {
    if (typeof entry !== "string" || !isWildcard(entry)) return true;
    const slashIndex = entry.indexOf("/");
    if (slashIndex > 0 && normalizeProviderId(entry.slice(0, slashIndex)) === normalizeProviderId(providerId)) {
      removed.push(entry);
      return false;
    }
    return true;
  });
  if (removed.length > 0) readModelPolicyRecord(config)!.allow = next;
  return removed;
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
    if (Object.keys(config.agents?.defaults?.models ?? {}).length === 0) return "unrestricted";
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

/** 存储规范化只处理 exact refs；用户 wildcard 的大小写、顺序及重复条目原样保留。 */
export function normalizePolicyAllowRefs(config: OpenClawConfig): boolean {
  const raw = readModelPolicyAllowRaw(config);
  if (!raw) return false;
  let changed = false;
  const seen = new Set<string>();
  const next: unknown[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || isWildcard(entry)) {
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
