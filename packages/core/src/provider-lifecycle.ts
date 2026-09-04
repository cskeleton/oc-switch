import { formatModelRef, normalizeModelRefForStorage, normalizeProviderId, parseModelRef } from "./model-ref";
import {
  addPolicyAllow,
  assertNoPolicyWildcardForProvider,
  readPolicyExactRefsForProvider,
  removePolicyAllowForProvider,
  restorePolicyAllow
} from "./model-policy";
import { ensureDefaults, resolveProviderId, type OperationResult } from "./operation-common";
import { readFallbackModelRefs, readPrimaryModelRef } from "./primary-model";
import type { AllowlistEntry, OpenClawConfig } from "./types";

export interface DisableProviderResult extends OperationResult {
  disabledState: {
    providerId: string;
    allowlistEntries: Record<string, AllowlistEntry>;
    policyExactRefs: string[];
  };
}

export function disableProvider(config: OpenClawConfig, providerId: string): DisableProviderResult {
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

  // 必须先于 ensureDefaults 与 allowlist 删除，保证通配拒绝不触碰配置。
  assertNoPolicyWildcardForProvider(config, resolvedProviderId, "disable");
  const policyExactRefs = readPolicyExactRefsForProvider(config, resolvedProviderId);

  ensureDefaults(config);

  const allowlistEntries: Record<string, AllowlistEntry> = {};
  for (const [ref, entry] of Object.entries(config.agents!.defaults!.models!)) {
    if (normalizeProviderId(parseModelRef(ref).providerId) === normalizeProviderId(resolvedProviderId)) {
      allowlistEntries[normalizeModelRefForStorage(ref)] = structuredClone(entry);
      delete config.agents!.defaults!.models![ref];
    }
  }
  removePolicyAllowForProvider(config, resolvedProviderId);

  return {
    config,
    warnings: [],
    disabledState: { providerId: normalizeProviderId(resolvedProviderId), allowlistEntries, policyExactRefs }
  };
}

export function restoreDisabledProvider(
  config: OpenClawConfig,
  providerId: string,
  allowlistEntries: Record<string, AllowlistEntry>,
  policyExactRefs: string[] = []
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
  for (const ref of policyExactRefs) {
    if (ref.endsWith("/*") || normalizeProviderId(parseModelRef(ref).providerId) !== normalizeProviderId(resolvedProviderId)) {
      throw new Error(`Snapshot policy ref ${ref} does not belong to provider ${providerId}`);
    }
  }

  ensureDefaults(config);

  for (const [ref, entry] of Object.entries(allowlistEntries)) {
    const modelId = parseModelRef(ref).modelId;
    const restoredRef = formatModelRef(normalizeProviderId(resolvedProviderId), modelId);
    config.agents!.defaults!.models![restoredRef] = structuredClone(entry);
    addPolicyAllow(config, restoredRef);
  }

  for (const ref of policyExactRefs) {
    const { modelId } = parseModelRef(ref);
    restorePolicyAllow(config, formatModelRef(normalizeProviderId(resolvedProviderId), modelId));
  }

  return { config, warnings: [] };
}
