import { formatModelRef, parseModelRef } from "./model-ref";
import type {
  AllowlistEntry,
  CustomProviderInput,
  OpenClawConfig,
  OpenClawModel,
  ProviderModelInput,
  ProviderPreset
} from "./types";

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

const MODEL_API_TYPES = new Set<NonNullable<ProviderModelInput["api"]>>([
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai"
]);

function assertPositiveInteger(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function assertProviderModelInput(input: ProviderModelInput): void {
  if (!input.id.trim()) throw new Error("model id must be a non-empty string");
  if (input.api !== undefined && !MODEL_API_TYPES.has(input.api)) throw new Error("api must be a supported API type");
  assertPositiveInteger(input.contextWindow, "contextWindow");
  assertPositiveInteger(input.maxTokens, "maxTokens");
}

function applyProviderModelInput(existing: OpenClawModel | undefined, input: ProviderModelInput): OpenClawModel {
  const next: OpenClawModel = { ...(existing ?? {}), id: input.id };
  for (const key of ["name", "api", "reasoning", "contextWindow", "maxTokens", "input"] as const) {
    const value = input[key];
    if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
      delete next[key];
    } else {
      next[key] = value as never;
    }
  }
  return next;
}

function upsertAllowlistEntry(config: OpenClawConfig, ref: string, alias: string | undefined): void {
  const existing = config.agents!.defaults!.models![ref] ?? {};
  const next: AllowlistEntry = { ...existing };
  if (alias === undefined || alias === "") {
    delete next.alias;
  } else {
    next.alias = alias;
  }
  config.agents!.defaults!.models![ref] = next;
}

export function addProviderModel(
  config: OpenClawConfig,
  providerIdOrRef: string,
  input: ProviderModelInput | { name?: string; alias?: string; enabled: boolean }
): OperationResult {
  ensureDefaults(config);
  const refInput = "id" in input
    ? { providerId: providerIdOrRef, modelId: input.id, input }
    : (() => {
        const { providerId, modelId } = parseModelRef(providerIdOrRef);
        return { providerId, modelId, input: { ...input, id: modelId } };
      })();
  assertProviderModelInput(refInput.input);
  const provider = config.models!.providers![refInput.providerId];
  if (!provider) throw new Error(`Provider ${refInput.providerId} not found`);

  const ref = formatModelRef(refInput.providerId, refInput.modelId);
  const models = provider.models ?? [];
  if (models.some((model) => model.id === refInput.modelId)) {
    throw new Error(`Model ${ref} already exists`);
  }

  provider.models = [...models, applyProviderModelInput(undefined, refInput.input)];

  if (refInput.input.enabled) {
    upsertAllowlistEntry(config, ref, refInput.input.alias);
  }

  return { config, warnings: [] };
}

export function updateProviderModel(config: OpenClawConfig, ref: string, input: ProviderModelInput): OperationResult {
  ensureDefaults(config);
  assertProviderModelInput(input);
  const { providerId, modelId } = parseModelRef(ref);
  const provider = config.models!.providers![providerId];
  if (!provider) throw new Error(`Provider ${providerId} not found`);

  const models = provider.models ?? [];
  const existingIndex = models.findIndex((model) => model.id === modelId);
  if (existingIndex === -1) throw new Error(`Model ${ref} not found`);

  const nextRef = formatModelRef(providerId, input.id);
  if (input.id !== modelId && models.some((model) => model.id === input.id)) {
    throw new Error(`Model ${nextRef} already exists`);
  }

  const existingModel = models[existingIndex];
  provider.models = models.map((model, index) =>
    index === existingIndex ? applyProviderModelInput(existingModel, input) : model
  );

  const existingAllowlist = config.agents!.defaults!.models![ref];
  if (input.id !== modelId) {
    delete config.agents!.defaults!.models![ref];
    if (config.agents!.defaults!.model === ref) {
      config.agents!.defaults!.model = nextRef;
    }
  }

  if (input.enabled) {
    config.agents!.defaults!.models![nextRef] = existingAllowlist ?? config.agents!.defaults!.models![nextRef] ?? {};
    upsertAllowlistEntry(config, nextRef, input.alias);
  } else {
    delete config.agents!.defaults!.models![nextRef];
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

const ENV_VAR_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const CUSTOM_PROVIDER_API_TYPES = new Set<CustomProviderInput["api"]>([
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai"
]);

function normalizeCustomProviderBaseUrl(api: CustomProviderInput["api"], baseUrl: string, isFullUrl: boolean): string {
  const trimmed = baseUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("baseUrl must be an http or https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("baseUrl must be an http or https URL");
  }
  if (isFullUrl) return trimmed;
  if (api === "openai-completions") {
    const normalized = trimmed.replace(/\/+$/, "");
    return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
  }
  return trimmed;
}

function assertCustomProviderInput(config: OpenClawConfig, input: CustomProviderInput): void {
  if (!input.providerId.trim()) throw new Error("providerId must be a non-empty string");
  if (input.providerId.includes("/")) throw new Error("Provider ID must not contain /");
  if (config.models?.providers?.[input.providerId]) throw new Error(`Provider ${input.providerId} already exists`);
  const lower = input.providerId.toLowerCase();
  const caseClash = Object.keys(config.models?.providers ?? {}).find((id) => id.toLowerCase() === lower);
  if (caseClash) throw new Error(`Provider ${caseClash} already exists (case-insensitive match)`);
  if (!CUSTOM_PROVIDER_API_TYPES.has(input.api)) throw new Error("api must be a supported API type");
  if (!ENV_VAR_PATTERN.test(input.apiKeyEnv)) throw new Error("apiKeyEnv must be a valid env var name");
  if (input.models.length === 0) throw new Error("models must contain at least one model");

  const seen = new Set<string>();
  for (const model of input.models) {
    if (!model.id.trim()) throw new Error("model id must be a non-empty string");
    if (seen.has(model.id)) throw new Error(`Duplicate model id ${model.id}`);
    seen.add(model.id);
  }
}

export function addCustomProvider(config: OpenClawConfig, input: CustomProviderInput): OperationResult {
  ensureDefaults(config);
  assertCustomProviderInput(config, input);

  const baseUrl = normalizeCustomProviderBaseUrl(input.api, input.baseUrl, input.isFullUrl);
  const models = input.models.map((model): OpenClawModel => ({ id: model.id }));
  const envRef = { source: "env" as const, id: input.apiKeyEnv };

  config.models!.providers![input.providerId] = {
    baseUrl,
    api: input.api,
    ...(input.api === "anthropic-messages" ? { authHeader: envRef } : { apiKey: envRef }),
    models
  };

  if (input.enableAllModels) {
    for (const model of input.models) {
      const ref = formatModelRef(input.providerId, model.id);
      config.agents!.defaults!.models![ref] = model.alias ? { alias: model.alias } : {};
    }
  }

  return { config, warnings: [] };
}
