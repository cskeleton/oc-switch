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

function assertPrimaryRemovalAllowed(
  config: OpenClawConfig,
  ref: string,
  options: { force: boolean; newPrimary?: string }
): void {
  const primary = config.agents!.defaults!.model;
  if (primary !== ref) return;
  if (options.newPrimary) {
    setPrimaryModel(config, options.newPrimary);
    return;
  }
  if (!options.force) {
    throw new Error(`Model ${ref} is the primary model`);
  }
}

function assertProviderPrimaryRemovalAllowed(
  config: OpenClawConfig,
  providerId: string,
  options: { force: boolean; newPrimary?: string }
): void {
  const primary = config.agents!.defaults!.model;
  if (!primary || parseModelRef(primary).providerId !== providerId) return;
  if (options.newPrimary) {
    setPrimaryModel(config, options.newPrimary);
    return;
  }
  if (!options.force) {
    throw new Error(`Provider ${providerId} contains the primary model`);
  }
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
  return removeProvider(config, providerId, options);
}

export function removeProvider(
  config: OpenClawConfig,
  providerId: string,
  options: { force: boolean; newPrimary?: string }
): OperationResult {
  ensureDefaults(config);
  const primary = config.agents!.defaults!.model;
  assertProviderPrimaryRemovalAllowed(config, providerId, options);

  delete config.models!.providers![providerId];

  for (const ref of Object.keys(config.agents!.defaults!.models!)) {
    if (parseModelRef(ref).providerId === providerId) {
      delete config.agents!.defaults!.models![ref];
    }
  }

  const warnings = primary && parseModelRef(primary).providerId === providerId && options.force
    ? [`Primary model ${primary} now points to a deleted provider`]
    : [];

  return { config, warnings };
}

export function editProvider(
  config: OpenClawConfig,
  providerId: string,
  changes: { baseUrl?: string; apiKeyEnv?: string }
): OperationResult {
  ensureDefaults(config);
  const provider = config.models!.providers![providerId];
  if (!provider) throw new Error(`Provider ${providerId} not found`);

  if (changes.baseUrl !== undefined) provider.baseUrl = changes.baseUrl;
  if (changes.apiKeyEnv !== undefined) {
    if (provider.apiKey) {
      provider.apiKey = { ...provider.apiKey, id: changes.apiKeyEnv };
    } else if (provider.authHeader) {
      provider.authHeader = { ...provider.authHeader, id: changes.apiKeyEnv };
    } else {
      provider.apiKey = { source: "env", id: changes.apiKeyEnv };
    }
  }

  return { config, warnings: [] };
}

export function addProviderModel(
  config: OpenClawConfig,
  ref: string,
  input: { name?: string; alias?: string; enabled: boolean }
): OperationResult {
  ensureDefaults(config);
  const { providerId, modelId } = parseModelRef(ref);
  const provider = config.models!.providers![providerId];
  if (!provider) throw new Error(`Provider ${providerId} not found`);

  const models = provider.models ?? [];
  const existing = models.find((model) => model.id === modelId);
  const nextModel: OpenClawModel = existing
    ? { ...existing, ...(input.name !== undefined ? { name: input.name } : {}) }
    : { id: modelId, ...(input.name !== undefined ? { name: input.name } : {}) };

  if (existing) {
    provider.models = models.map((model) => (model.id === modelId ? nextModel : model));
  } else {
    provider.models = [...models, nextModel];
  }

  if (input.enabled) {
    const entry: AllowlistEntry = input.alias
      ? { ...(config.agents!.defaults!.models![ref] ?? {}), alias: input.alias }
      : (config.agents!.defaults!.models![ref] ?? {});
    config.agents!.defaults!.models![ref] = entry;
  }

  return { config, warnings: [] };
}

export function removeProviderModel(
  config: OpenClawConfig,
  ref: string,
  options: { force: boolean; newPrimary?: string }
): OperationResult {
  ensureDefaults(config);
  const { providerId, modelId } = parseModelRef(ref);
  const provider = config.models!.providers![providerId];
  if (!provider) throw new Error(`Provider ${providerId} not found`);

  assertPrimaryRemovalAllowed(config, ref, options);

  provider.models = (provider.models ?? []).filter((model) => model.id !== modelId);
  delete config.agents!.defaults!.models![ref];

  const warnings: string[] = [];
  const primary = config.agents!.defaults!.model;
  if (primary === ref && options.force) {
    warnings.push(`Primary model ${ref} was removed`);
  }

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
