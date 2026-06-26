import { formatModelRef, parseModelRef } from "./model-ref";
import { setPrimaryModel } from "./model-operations";
import { ensureDefaults, type OperationResult } from "./operation-common";
import type { CustomProviderInput, OpenClawConfig, OpenClawModel, ProviderPreset } from "./types";

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
