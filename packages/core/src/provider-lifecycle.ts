import { formatModelRef, normalizeModelRefForStorage, normalizeProviderId, parseModelRef } from "./model-ref";
import { restoreModelProviderSelection, suspendModelProviders, type ModelSuspensionOptions } from "./model-suspension";
import { ensureDefaults, resolveProviderId, type OperationResult } from "./operation-common";
import { readFallbackModelRefs, readPrimaryModelRef } from "./primary-model";
import type { AllowlistEntry, OpenClawConfig } from "./types";

export interface DisableProviderResult extends OperationResult {
  disabledState: {
    providerId: string;
    allowlistEntries: Record<string, AllowlistEntry>;
    policyEntries: string[];
  };
}

export function disableProvider(config: OpenClawConfig, providerId: string, options: ModelSuspensionOptions = {}): DisableProviderResult {
  const resolvedProviderId = resolveProviderId(config, providerId);
  if (!resolvedProviderId || !config.models!.providers![resolvedProviderId]) {
    throw new Error(`Provider ${providerId} not found`);
  }

  const primary = readPrimaryModelRef(config);
  if (primary && normalizeProviderId(parseModelRef(primary).providerId) === normalizeProviderId(resolvedProviderId)) {
    throw new Error(`Provider ${providerId} contains the primary model. Switch primary model before disabling this provider.`);
  }

  // fallback 依赖保护（fail closed）：回退链引用该 Provider 时不得关闭
  const fallbackRefs = readFallbackModelRefs(config);
  if (fallbackRefs.some((ref) => normalizeProviderId(parseModelRef(ref).providerId) === normalizeProviderId(resolvedProviderId))) {
    throw new Error(
      `Provider ${providerId} is referenced by agents.defaults.model.fallbacks. Remove or migrate fallbacks in the OpenClaw config first.`
    );
  }

  // 先完成引用保护和策略预检，保留 metadata 与可恢复规则。
  const originalMetadata = config.agents?.defaults?.models ?? {};
  const suspended = suspendModelProviders(config, [resolvedProviderId], options);
  config = suspended.config;
  ensureDefaults(config);

  const allowlistEntries: Record<string, AllowlistEntry> = {};
  for (const [ref, entry] of Object.entries(originalMetadata)) {
    if (normalizeProviderId(parseModelRef(ref).providerId) === normalizeProviderId(resolvedProviderId)) {
      allowlistEntries[normalizeModelRefForStorage(ref)] = structuredClone(entry);
      if (options.cleanupMetadata) delete config.agents!.defaults!.models![ref];
    }
  }
  return {
    config,
    warnings: [],
    disabledState: { providerId: normalizeProviderId(resolvedProviderId), allowlistEntries, policyEntries: suspended.policyEntries }
  };
}

export function restoreDisabledProvider(
  config: OpenClawConfig,
  providerId: string,
  allowlistEntries: Record<string, AllowlistEntry>,
  policyEntries?: string[]
): OperationResult {
  const resolvedProviderId = resolveProviderId(config, providerId);
  if (!resolvedProviderId || !config.models!.providers![resolvedProviderId]) {
    throw new Error(`Provider ${providerId} not found`);
  }

  // 先验证完整快照，避免畸形 state 在恢复中途留下部分 metadata 写入。
  for (const ref of Object.keys(allowlistEntries)) {
    if (normalizeProviderId(parseModelRef(ref).providerId) !== normalizeProviderId(resolvedProviderId)) {
      throw new Error(`Snapshot ref ${ref} does not belong to provider ${providerId}`);
    }
  }
  ensureDefaults(config);

  for (const [ref, entry] of Object.entries(allowlistEntries)) {
    const modelId = parseModelRef(ref).modelId;
    const restoredRef = formatModelRef(normalizeProviderId(resolvedProviderId), modelId);
    config.agents!.defaults!.models![restoredRef] ??= structuredClone(entry);
  }

  return { config: restoreModelProviderSelection(config, policyEntries ?? Object.keys(allowlistEntries), { providerIds: [providerId] }), warnings: [] };
}
