import { formatModelRef, parseModelRef } from "./model-ref";
import { defaultModelName } from "./openclaw-compat";
import { ensureDefaults, hasProviderModel, type OperationResult } from "./operation-common";
import type { AllowlistEntry, OpenClawConfig, OpenClawModel, ProviderModelInput } from "./types";

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

  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (trimmed) {
      next.name = trimmed;
    } else if (!existing?.name?.trim()) {
      next.name = defaultModelName(input.id);
    }
  } else if (!existing?.name?.trim()) {
    next.name = defaultModelName(input.id);
  }

  for (const key of ["api", "reasoning", "contextWindow", "maxTokens", "input"] as const) {
    const value = input[key];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
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
