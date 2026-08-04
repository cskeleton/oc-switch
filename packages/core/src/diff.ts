import { providerEnvVar } from "./openclaw-compat";
import { parseModelRef } from "./model-ref";
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
      if (envVar && !map.has(envVar)) map.set(envVar, id);
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
    counts.set(providerId, (counts.get(providerId) ?? 0) + 1);
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
  const providerIds = Object.keys(before.models?.providers ?? {})
    .filter((id) => Boolean(after.models?.providers?.[id]))
    .sort();

  const changes: ProviderStateChangeItem[] = [];
  for (const providerId of providerIds) {
    const beforeEnabled = beforeCounts.get(providerId) ?? 0;
    const afterEnabled = afterCounts.get(providerId) ?? 0;
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
  const sharedProviderIds = Object.keys(beforeProviders).filter((id) => id in afterProviders).sort();

  for (const providerId of sharedProviderIds) {
    const beforeProvider = beforeProviders[providerId] ?? {};
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
  const beforeIds = new Set(Object.keys(beforeProviders));
  const afterIds = new Set(Object.keys(afterProviders));

  const providersAdded = [...afterIds].filter((id) => !beforeIds.has(id)).sort();
  const providersRemoved = [...beforeIds].filter((id) => !afterIds.has(id)).sort();
  const providersChanged = [...beforeIds]
    .filter((id) => afterIds.has(id) && JSON.stringify(beforeProviders[id]) !== JSON.stringify(afterProviders[id]))
    .sort();

  const beforeAllowlist = before.agents?.defaults?.models ?? {};
  const afterAllowlist = after.agents?.defaults?.models ?? {};
  const beforeRefs = new Set(Object.keys(beforeAllowlist));
  const afterRefs = new Set(Object.keys(afterAllowlist));

  const modelsEnabled = [...afterRefs].filter((ref) => !beforeRefs.has(ref)).sort();
  const modelsDisabled = [...beforeRefs].filter((ref) => !afterRefs.has(ref)).sort();

  // 按归一 primary ref 比较：跨形态 ref 不变不报；仅 fallbacks 变化不报主模型变更
  const beforePrimary = readPrimaryModelRef(before);
  const afterPrimary = readPrimaryModelRef(after);
  const primaryChanged = beforePrimary === afterPrimary
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
