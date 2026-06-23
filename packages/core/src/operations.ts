import { formatModelRef, parseModelRef } from "./model-ref";
import type { AllowlistEntry, OpenClawConfig, OpenClawModel, ProviderPreset } from "./types";

export interface OperationResult {
  config: OpenClawConfig;
  warnings: string[];
}

function ensureDefaults(config: OpenClawConfig) {
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.models ??= {};
  config.models ??= {};
  config.models.providers ??= {};
}

function hasProviderModel(config: OpenClawConfig, ref: string): boolean {
  const { providerId, modelId } = parseModelRef(ref);
  const provider = config.models?.providers?.[providerId];
  return Boolean(provider?.models?.some((model) => model.id === modelId));
}

export function setPrimaryModel(config: OpenClawConfig, ref: string): OperationResult {
  ensureDefaults(config);
  if (!hasProviderModel(config, ref)) {
    throw new Error(`Model ${ref} is not defined in provider models`);
  }
  config.agents!.defaults!.model = ref;
  return { config, warnings: [] };
}

export function disableModel(config: OpenClawConfig, ref: string): OperationResult {
  ensureDefaults(config);
  delete config.agents!.defaults!.models![ref];
  return { config, warnings: [] };
}

export function enableModel(config: OpenClawConfig, ref: string, alias?: string): OperationResult {
  ensureDefaults(config);
  if (!hasProviderModel(config, ref)) {
    throw new Error(`Model ${ref} is not defined in provider models`);
  }
  const existing = config.agents!.defaults!.models![ref] ?? {};
  const next: AllowlistEntry = alias ? { ...existing, alias } : existing;
  config.agents!.defaults!.models![ref] = next;
  return { config, warnings: [] };
}

export function deleteProvider(config: OpenClawConfig, providerId: string, options: { force: boolean }): OperationResult {
  ensureDefaults(config);
  const primary = config.agents!.defaults!.model;
  if (primary && parseModelRef(primary).providerId === providerId && !options.force) {
    throw new Error(`Provider ${providerId} contains the primary model`);
  }

  delete config.models!.providers![providerId];

  for (const ref of Object.keys(config.agents!.defaults!.models!)) {
    if (parseModelRef(ref).providerId === providerId) {
      delete config.agents!.defaults!.models![ref];
    }
  }

  const warnings = primary && parseModelRef(primary).providerId === providerId
    ? [`Primary model ${primary} now points to a deleted provider`]
    : [];

  return { config, warnings };
}

export function definedRefs(config: OpenClawConfig): string[] {
  const providers = config.models?.providers ?? {};
  return Object.entries(providers).flatMap(([providerId, provider]) =>
    (provider.models ?? []).map((model) => formatModelRef(providerId, model.id))
  );
}

export function addProviderFromPreset(
  config: OpenClawConfig,
  preset: ProviderPreset,
  enabledModelIds: string[] = preset.models.map((model) => model.id)
): OperationResult {
  ensureDefaults(config);
  const existingProvider = config.models!.providers![preset.id];
  const modelsById = new Map<string, OpenClawModel>();

  for (const model of existingProvider?.models ?? []) {
    modelsById.set(model.id, model);
  }

  for (const { alias, ...model } of preset.models) {
    const existingModel = modelsById.get(model.id);
    modelsById.set(model.id, existingModel ? { ...existingModel, ...model } : model);
  }

  config.models!.providers![preset.id] = {
    ...existingProvider,
    baseUrl: preset.provider.baseUrl,
    apiKey: { source: "env", id: preset.provider.apiKeyEnv },
    api: preset.provider.api,
    models: Array.from(modelsById.values())
  };

  for (const model of preset.models) {
    const ref = formatModelRef(preset.id, model.id);
    if (enabledModelIds.includes(model.id)) {
      const existingEntry = config.agents!.defaults!.models![ref] ?? {};
      config.agents!.defaults!.models![ref] = model.alias
        ? { ...existingEntry, alias: model.alias }
        : existingEntry;
    } else {
      delete config.agents!.defaults!.models![ref];
    }
  }

  return { config, warnings: [] };
}
