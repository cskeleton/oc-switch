import { parseModelRef } from "./model-ref";
import { ensureDefaults, type OperationResult } from "./operation-common";
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
  if (!config.models!.providers![providerId]) {
    throw new Error(`Provider ${providerId} not found`);
  }

  const primary = readPrimaryModelRef(config);
  if (primary && parseModelRef(primary).providerId === providerId) {
    throw new Error(`Provider ${providerId} contains the primary model. Switch primary model before disabling this provider.`);
  }

  // fallback 依赖保护（fail closed）：回退链引用该 Provider 时不得关闭
  const fallbackRefs = readFallbackModelRefs(config);
  if (fallbackRefs.some((ref) => parseModelRef(ref).providerId === providerId)) {
    throw new Error(
      `Provider ${providerId} is referenced by agents.defaults.model.fallbacks. Remove or migrate fallbacks in the OpenClaw config first.`
    );
  }

  const allowlistEntries: Record<string, AllowlistEntry> = {};
  for (const [ref, entry] of Object.entries(config.agents!.defaults!.models!)) {
    if (parseModelRef(ref).providerId === providerId) {
      allowlistEntries[ref] = structuredClone(entry);
      delete config.agents!.defaults!.models![ref];
    }
  }

  return {
    config,
    warnings: [],
    disabledState: { providerId, allowlistEntries }
  };
}

export function restoreDisabledProvider(
  config: OpenClawConfig,
  providerId: string,
  allowlistEntries: Record<string, AllowlistEntry>
): OperationResult {
  ensureDefaults(config);
  if (!config.models!.providers![providerId]) {
    throw new Error(`Provider ${providerId} not found`);
  }

  for (const [ref, entry] of Object.entries(allowlistEntries)) {
    if (parseModelRef(ref).providerId !== providerId) {
      throw new Error(`Snapshot ref ${ref} does not belong to provider ${providerId}`);
    }
    config.agents!.defaults!.models![ref] = structuredClone(entry);
  }

  return { config, warnings: [] };
}
