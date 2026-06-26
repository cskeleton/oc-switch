import { parseModelRef } from "./model-ref";
import type { OpenClawConfig } from "./types";

export interface OperationResult {
  config: OpenClawConfig;
  warnings: string[];
}

export function ensureDefaults(config: OpenClawConfig): void {
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.models ??= {};
  config.models ??= {};
  config.models.providers ??= {};
}

export function hasProviderModel(config: OpenClawConfig, ref: string): boolean {
  const { providerId, modelId } = parseModelRef(ref);
  const provider = config.models?.providers?.[providerId];
  return Boolean(provider?.models?.some((model) => model.id === modelId));
}
