import { readJsonState, writeJsonState } from "./json-state-store";
import type { AllowlistEntry } from "./types";

export interface DisabledProviderState {
  providerId: string;
  openclawPath: string;
  disabledAt: string;
  allowlistEntries: Record<string, AllowlistEntry>;
}

export interface ProviderStatesFile {
  version: 1;
  disabledProviders: Record<string, DisabledProviderState>;
}

export const PROVIDER_STATES_FILE = "provider-states.json";

function emptyProviderStates(): ProviderStatesFile {
  return { version: 1, disabledProviders: {} };
}

export function readProviderStates(stateDir: string): ProviderStatesFile {
  return readJsonState({
    stateDir,
    filename: PROVIDER_STATES_FILE,
    fallback: emptyProviderStates,
    normalize(value) {
      const parsed = value as Partial<ProviderStatesFile>;
      return {
        version: 1,
        disabledProviders: parsed.disabledProviders ?? {}
      };
    }
  });
}

export function writeProviderStates(stateDir: string, states: ProviderStatesFile): void {
  writeJsonState({
    stateDir,
    filename: PROVIDER_STATES_FILE,
    value: {
      version: 1,
      disabledProviders: states.disabledProviders
    }
  });
}

export function upsertDisabledProviderState(stateDir: string, state: DisabledProviderState): void {
  const states = readProviderStates(stateDir);
  states.disabledProviders[state.providerId] = state;
  writeProviderStates(stateDir, states);
}

export function removeDisabledProviderState(stateDir: string, providerId: string): void {
  const states = readProviderStates(stateDir);
  if (!states.disabledProviders[providerId]) return;
  delete states.disabledProviders[providerId];
  writeProviderStates(stateDir, states);
}

export function isProviderDisabled(stateDir: string, providerId: string): boolean {
  return Boolean(readProviderStates(stateDir).disabledProviders[providerId]);
}
