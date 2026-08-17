import { providerEnvVar } from "./openclaw-compat";
import { normalizeModelRefForIdentity, normalizeProviderId, parseModelRef } from "./model-ref";
import { readPrimaryModelRef } from "./primary-model";
import type { OpenClawConfig } from "./types";

const MANAGED_START = "# oc-switch:start";
const MANAGED_END = "# oc-switch:end";

export interface CredentialDiffItem {
  envVar: string;
  providerId?: string;
  change: "added" | "removed" | "changed";
}

export interface ProviderStateChangeItem {
  providerId: string;
  change: "disable" | "enable";
}

export interface ProviderFieldChangeItem {
  providerId: string;
  parameterName: string;
  oldValue: string;
  newValue: string;
}

export interface ConfigDiffSummary {
  providersAdded: string[];
  providersRemoved: string[];
  providersChanged: string[];
  modelsEnabled: string[];
  modelsDisabled: string[];
  primaryChanged: { before: string | undefined; after: string | undefined } | null;
  credentialsChanged: CredentialDiffItem[];
  providerStateChanges: ProviderStateChangeItem[];
  providerFieldChanges: ProviderFieldChangeItem[];
}

export interface SummarizeConfigDiffOptions {
  beforeEnv?: string;
  afterEnv?: string;
}

/** 解析托管块内的 env 键值（仅内部比较，不对外暴露 value） */
export function parseManagedEnvVars(content: string): Map<string, string> {
  const lines = content.length ? content.split(/\n/) : [];
  const startIndex = lines.indexOf(MANAGED_START);
  const endIndex = lines.indexOf(MANAGED_END);
  if (startIndex < 0 || endIndex <= startIndex) return new Map();

  const result = new Map<string, string>();
  for (const line of lines.slice(startIndex + 1, endIndex)) {
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (match?.[1]) result.set(match[1], match[2] ?? "");
  }
  return result;
}

/** 从配置反查 env 变量所属 Provider（先后配置合并，便于移除场景） */
export function buildEnvVarProviderMap(...configs: OpenClawConfig[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const config of configs) {
    for (const [id, provider] of Object.entries(config.models?.providers ?? {})) {
      const envVar = providerEnvVar(provider);
      if (envVar && !map.has(envVar)) map.set(envVar, normalizeProviderId(id));
    }
  }
  return map;
}

/** 对比托管块内密钥存在性与值相等性，不返回明文 value */
export function summarizeCredentialsDiff(
  beforeEnv: string,
  afterEnv: string,
  ...configs: OpenClawConfig[]
): CredentialDiffItem[] {
  const beforeVars = parseManagedEnvVars(beforeEnv);
  const afterVars = parseManagedEnvVars(afterEnv);
  const envToProvider = buildEnvVarProviderMap(...configs);
  const items: CredentialDiffItem[] = [];

  const allKeys = new Set([...beforeVars.keys(), ...afterVars.keys()]);
  for (const envVar of [...allKeys].sort()) {
    const inBefore = beforeVars.has(envVar);
    const inAfter = afterVars.has(envVar);
    let change: CredentialDiffItem["change"] | null = null;
    if (!inBefore && inAfter) change = "added";
    else if (inBefore && !inAfter) change = "removed";
    else if (inBefore && inAfter && beforeVars.get(envVar) !== afterVars.get(envVar)) change = "changed";

    if (!change) continue;
    const providerId = envToProvider.get(envVar);
    items.push({
      envVar,
      change,
      ...(providerId ? { providerId } : {})
    });
  }
  return items;
}

function summarizeProviderEnabledCounts(config: OpenClawConfig): Map<string, number> {
  const counts = new Map<string, number>();
  for (const ref of Object.keys(config.agents?.defaults?.models ?? {})) {
    const providerId = parseModelRef(ref).providerId;
    const key = normalizeProviderId(providerId);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** 推导 Provider 启用态变化（启用模型数由有到无/由无到有） */
export function summarizeProviderStateChanges(
  before: OpenClawConfig,
  after: OpenClawConfig
): ProviderStateChangeItem[] {
  const beforeCounts = summarizeProviderEnabledCounts(before);
  const afterCounts = summarizeProviderEnabledCounts(after);
  const beforeProviders = before.models?.providers ?? {};
  const afterProviders = after.models?.providers ?? {};
  const beforeIdsByNormalized = new Map(Object.keys(beforeProviders).map((id) => [normalizeProviderId(id), id]));
  const providerIds = Object.keys(afterProviders)
    .filter((id) => beforeIdsByNormalized.has(normalizeProviderId(id)))
    .sort();

  const changes: ProviderStateChangeItem[] = [];
  for (const providerId of providerIds) {
    const normalizedProviderId = normalizeProviderId(providerId);
    const beforeEnabled = beforeCounts.get(normalizedProviderId) ?? 0;
    const afterEnabled = afterCounts.get(normalizedProviderId) ?? 0;
    if (beforeEnabled > 0 && afterEnabled === 0) {
      changes.push({ providerId, change: "disable" });
    } else if (beforeEnabled === 0 && afterEnabled > 0) {
      changes.push({ providerId, change: "enable" });
    }
  }
  return changes;
}

function displayValue(value: unknown): string {
  if (value === undefined) return "(未设置)";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

const PROVIDER_DETAIL_EXCLUDE = new Set(["apiKey", "models"]);

/** 细化 Provider 非密钥字段变更，避免只返回笼统 changed 列表 */
export function summarizeProviderFieldChanges(
  before: OpenClawConfig,
  after: OpenClawConfig
): ProviderFieldChangeItem[] {
  const result: ProviderFieldChangeItem[] = [];
  const beforeProviders = before.models?.providers ?? {};
  const afterProviders = after.models?.providers ?? {};
  const afterIdsByNormalized = new Map(Object.keys(afterProviders).map((id) => [normalizeProviderId(id), id]));
  const sharedProviderIds = Object.keys(beforeProviders)
    .filter((id) => afterIdsByNormalized.has(normalizeProviderId(id)))
    .sort();

  for (const beforeProviderId of sharedProviderIds) {
    const providerId = afterIdsByNormalized.get(normalizeProviderId(beforeProviderId))!;
    const beforeProvider = beforeProviders[beforeProviderId] ?? {};
    const afterProvider = afterProviders[providerId] ?? {};
    const keys = new Set([...Object.keys(beforeProvider), ...Object.keys(afterProvider)]);

    for (const key of [...keys].sort()) {
      if (PROVIDER_DETAIL_EXCLUDE.has(key)) continue;
      const oldRaw = beforeProvider[key];
      const newRaw = afterProvider[key];
      if (JSON.stringify(oldRaw) === JSON.stringify(newRaw)) continue;

      result.push({
        providerId,
        parameterName: key,
        oldValue: displayValue(oldRaw),
        newValue: displayValue(newRaw)
      });
    }
  }

  return result;
}

export function summarizeConfigDiff(
  before: OpenClawConfig,
  after: OpenClawConfig,
  options?: SummarizeConfigDiffOptions
): ConfigDiffSummary {
  const beforeProviders = before.models?.providers ?? {};
  const afterProviders = after.models?.providers ?? {};
  const beforeIdsByNormalized = new Map(Object.keys(beforeProviders).map((id) => [normalizeProviderId(id), id]));
  const afterIdsByNormalized = new Map(Object.keys(afterProviders).map((id) => [normalizeProviderId(id), id]));
  const beforeProviderCounts = new Map<string, number>();
  const afterProviderCounts = new Map<string, number>();
  for (const id of Object.keys(beforeProviders)) {
    const normalizedId = normalizeProviderId(id);
    beforeProviderCounts.set(normalizedId, (beforeProviderCounts.get(normalizedId) ?? 0) + 1);
  }
  for (const id of Object.keys(afterProviders)) {
    const normalizedId = normalizeProviderId(id);
    afterProviderCounts.set(normalizedId, (afterProviderCounts.get(normalizedId) ?? 0) + 1);
  }

  const providersAdded = [...afterIdsByNormalized.entries()]
    .filter(([normalizedId]) => !beforeIdsByNormalized.has(normalizedId))
    .map(([, id]) => id)
    .concat(
      Object.keys(afterProviders)
        .filter((id) => !Object.prototype.hasOwnProperty.call(beforeProviders, id))
        .filter((id) => (afterProviderCounts.get(normalizeProviderId(id)) ?? 0) > (beforeProviderCounts.get(normalizeProviderId(id)) ?? 0))
    )
    .sort()
    .filter((id, index, ids) => index === 0 || id !== ids[index - 1]);
  const providersRemoved = [...beforeIdsByNormalized.entries()]
    .filter(([normalizedId]) => !afterIdsByNormalized.has(normalizedId))
    .map(([, id]) => id)
    .concat(
      Object.keys(beforeProviders)
        .filter((id) => !Object.prototype.hasOwnProperty.call(afterProviders, id))
        .filter((id) => (beforeProviderCounts.get(normalizeProviderId(id)) ?? 0) > (afterProviderCounts.get(normalizeProviderId(id)) ?? 0))
    )
    .sort()
    .filter((id, index, ids) => index === 0 || id !== ids[index - 1]);
  const providersChanged = [...afterIdsByNormalized.entries()]
    .filter(([normalizedId, id]) => {
      const beforeId = beforeIdsByNormalized.get(normalizedId);
      return beforeId !== undefined && JSON.stringify(beforeProviders[beforeId]) !== JSON.stringify(afterProviders[id]);
    })
    .map(([, id]) => id)
    .sort();

  const beforeAllowlist = before.agents?.defaults?.models ?? {};
  const afterAllowlist = after.agents?.defaults?.models ?? {};
  const beforeRefs = new Map([...Object.keys(beforeAllowlist)].map((ref) => [normalizeModelRefForIdentity(ref), ref]));
  const afterRefs = new Map([...Object.keys(afterAllowlist)].map((ref) => [normalizeModelRefForIdentity(ref), ref]));

  const modelsEnabled = [...afterRefs.entries()]
    .filter(([identity]) => !beforeRefs.has(identity))
    .map(([, ref]) => ref)
    .sort();
  const modelsDisabled = [...beforeRefs.entries()]
    .filter(([identity]) => !afterRefs.has(identity))
    .map(([, ref]) => ref)
    .sort();

  // 按归一 primary ref 比较：跨形态 ref 不变不报；仅 fallbacks 变化不报主模型变更
  const beforePrimary = readPrimaryModelRef(before);
  const afterPrimary = readPrimaryModelRef(after);
  const primaryChanged = beforePrimary && afterPrimary && normalizeModelRefForIdentity(beforePrimary) === normalizeModelRefForIdentity(afterPrimary)
    ? null
    : beforePrimary === afterPrimary
    ? null
    : { before: beforePrimary, after: afterPrimary };

  const credentialsChanged = options?.beforeEnv !== undefined && options?.afterEnv !== undefined
    ? summarizeCredentialsDiff(options.beforeEnv, options.afterEnv, before, after)
    : [];
  const providerStateChanges = summarizeProviderStateChanges(before, after);
  const providerFieldChanges = summarizeProviderFieldChanges(before, after);

  return {
    providersAdded,
    providersRemoved,
    providersChanged,
    modelsEnabled,
    modelsDisabled,
    primaryChanged,
    credentialsChanged,
    providerStateChanges,
    providerFieldChanges
  };
}
