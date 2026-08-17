import { formatModelRef, normalizeModelRefForStorage, normalizeProviderId, parseModelRef } from "./model-ref";
import { ensureDefaults, resolveProviderId, type OperationResult } from "./operation-common";
import { readFallbackModelRefs, readPrimaryModelRef } from "./primary-model";
import type { AllowlistEntry, OpenClawConfig } from "./types";

export interface DisableProviderResult extends OperationResult {
  disabledState: {
    providerId: string;
    allowlistEntries: Record<string, AllowlistEntry>;
  };
}

export function disableProvider(config: OpenClawConfig, providerId: string): DisableProviderResult {
  ensureDefaults(config);
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

  const allowlistEntries: Record<string, AllowlistEntry> = {};
  for (const [ref, entry] of Object.entries(config.agents!.defaults!.models!)) {
    if (normalizeProviderId(parseModelRef(ref).providerId) === normalizeProviderId(resolvedProviderId)) {
      allowlistEntries[normalizeModelRefForStorage(ref)] = structuredClone(entry);
      delete config.agents!.defaults!.models![ref];
    }
  }

  return {
    config,
    warnings: [],
    disabledState: { providerId: normalizeProviderId(resolvedProviderId), allowlistEntries }
  };
}

export function restoreDisabledProvider(
  config: OpenClawConfig,
  providerId: string,
  allowlistEntries: Record<string, AllowlistEntry>
): OperationResult {
  ensureDefaults(config);
  const resolvedProviderId = resolveProviderId(config, providerId);
  if (!resolvedProviderId || !config.models!.providers![resolvedProviderId]) {
    throw new Error(`Provider ${providerId} not found`);
  }

  for (const [ref, entry] of Object.entries(allowlistEntries)) {
    if (normalizeProviderId(parseModelRef(ref).providerId) !== normalizeProviderId(resolvedProviderId)) {
      throw new Error(`Snapshot ref ${ref} does not belong to provider ${providerId}`);
    }
    const modelId = parseModelRef(ref).modelId;
    config.agents!.defaults!.models![formatModelRef(normalizeProviderId(resolvedProviderId), modelId)] = structuredClone(entry);
  }

  return { config, warnings: [] };
}
