import { readJsonState, writeJsonState } from "./json-state-store";
import { normalizeModelRefForStorage, normalizeProviderId } from "./model-ref";
import type { AllowlistEntry } from "./types";

export interface DisabledProviderState {
  providerId: string;
  openclawPath: string;
  disabledAt: string;
  allowlistEntries: Record<string, AllowlistEntry>;
  /** 2026.9 停用时从 OpenClaw 选择器移出的 exact/wildcard 规则。 */
  policyEntries?: string[];
}

export interface ProviderStatesFile {
  version: 1;
  disabledProviders: Record<string, DisabledProviderState>;
}

export const PROVIDER_STATES_FILE = "provider-states.json";

function emptyProviderStates(): ProviderStatesFile {
  return { version: 1, disabledProviders: {} };
}

function normalizeAllowlistEntries(entries: Record<string, AllowlistEntry>): Record<string, AllowlistEntry> {
  const normalized: Record<string, AllowlistEntry> = {};
  for (const [ref, entry] of Object.entries(entries)) {
    let normalizedRef = ref;
    try {
      normalizedRef = normalizeModelRefForStorage(ref);
    } catch {
      // 保留历史畸形快照，恢复时仍由 provider/model 校验拒绝。
    }
    if (Object.prototype.hasOwnProperty.call(normalized, normalizedRef) && JSON.stringify(normalized[normalizedRef]) !== JSON.stringify(entry)) {
      throw new Error(`Disabled provider state refs ${ref} and ${normalizedRef} conflict after lowercase normalization.`);
    }
    normalized[normalizedRef] ??= entry;
  }
  return normalized;
}

function normalizeStates(value: Partial<ProviderStatesFile>): ProviderStatesFile {
  const disabledProviders: Record<string, DisabledProviderState> = {};
  for (const [key, rawState] of Object.entries(value.disabledProviders ?? {})) {
    const state = rawState as DisabledProviderState;
    const providerId = normalizeProviderId(state.providerId || key);
    if (Object.prototype.hasOwnProperty.call(disabledProviders, providerId)) {
      throw new Error(`Disabled provider states ${key} and ${providerId} conflict after lowercase normalization.`);
    }
    disabledProviders[providerId] = {
      ...state,
      providerId,
      allowlistEntries: normalizeAllowlistEntries(state.allowlistEntries ?? {})
    };
  }
  return { version: 1, disabledProviders };
}

export function readProviderStates(stateDir: string): ProviderStatesFile {
  return readJsonState({
    stateDir,
    filename: PROVIDER_STATES_FILE,
    fallback: emptyProviderStates,
    normalize(value) {
      return normalizeStates(value as Partial<ProviderStatesFile>);
    }
  });
}

export function writeProviderStates(stateDir: string, states: ProviderStatesFile): void {
  const normalized = normalizeStates(states);
  writeJsonState({
    stateDir,
    filename: PROVIDER_STATES_FILE,
    value: {
      version: 1,
      disabledProviders: normalized.disabledProviders
    }
  });
}

export function upsertDisabledProviderState(stateDir: string, state: DisabledProviderState): void {
  const states = readProviderStates(stateDir);
  const providerId = normalizeProviderId(state.providerId);
  states.disabledProviders[providerId] = {
    ...state,
    providerId,
    allowlistEntries: normalizeAllowlistEntries(state.allowlistEntries)
  };
  writeProviderStates(stateDir, states);
}

export function removeDisabledProviderState(stateDir: string, providerId: string): void {
  const states = readProviderStates(stateDir);
  const normalizedProviderId = normalizeProviderId(providerId);
  if (!states.disabledProviders[normalizedProviderId]) return;
  delete states.disabledProviders[normalizedProviderId];
  writeProviderStates(stateDir, states);
}

export function getDisabledProviderState(stateDir: string, providerId: string): DisabledProviderState | undefined {
  return readProviderStates(stateDir).disabledProviders[normalizeProviderId(providerId)];
}

export function isProviderDisabled(stateDir: string, providerId: string): boolean {
  return Boolean(readProviderStates(stateDir).disabledProviders[normalizeProviderId(providerId)]);
}
