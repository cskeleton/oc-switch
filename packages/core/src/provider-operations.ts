import { formatModelRef, parseModelRef } from "./model-ref";
import { setPrimaryModel } from "./model-operations";
import { formatEnvRefForOpenClaw, ensureModelName } from "./openclaw-compat";
import { ensureDefaults, type OperationResult } from "./operation-common";
import { readFallbackModelRefs, readPrimaryModelRef } from "./primary-model";
import { assertProviderModelCapacity } from "./provider-model-limits";
import type { ApiType, CustomProviderInput, OpenClawConfig, OpenClawModel, ProviderPreset } from "./types";

const PROVIDER_API_TYPES = new Set<ApiType>([
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai"
]);

function removeLegacyAuthHeaderRef<T extends { authHeader?: unknown }>(provider: T): T {
  if (typeof provider.authHeader === "object" && provider.authHeader !== null) {
    delete provider.authHeader;
  }
  return provider;
}

function assertProviderFallbackRemovalAllowed(config: OpenClawConfig, providerId: string): void {
  const fallbackRefs = readFallbackModelRefs(config);
  if (fallbackRefs.some((ref) => parseModelRef(ref).providerId === providerId)) {
    throw new Error(
      `Provider ${providerId} is referenced by agents.defaults.model.fallbacks. Remove or migrate fallbacks in the OpenClaw config first.`
    );
  }
}

function assertProviderPrimaryRemovalAllowed(
  config: OpenClawConfig,
  providerId: string,
  options: { force: boolean; newPrimary?: string }
): void {
  const primary = readPrimaryModelRef(config);
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
  const primary = readPrimaryModelRef(config);
  // fallback 依赖保护必须发生在任何 mutation 之前（force 也不可绕过）
  assertProviderFallbackRemovalAllowed(config, providerId);
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
  changes: { baseUrl?: string; api?: ApiType; apiKeyEnv?: string }
): OperationResult {
  ensureDefaults(config);
  const provider = config.models!.providers![providerId];
  if (!provider) throw new Error(`Provider ${providerId} not found`);

  if (changes.baseUrl !== undefined) provider.baseUrl = changes.baseUrl;
  if (changes.api !== undefined) {
    if (!PROVIDER_API_TYPES.has(changes.api)) throw new Error("api must be a supported API type");
    provider.api = changes.api;
  }
  if (changes.apiKeyEnv !== undefined) {
    provider.apiKey = formatEnvRefForOpenClaw(changes.apiKeyEnv);
    removeLegacyAuthHeaderRef(provider);
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
  const existingIds = new Set((existingProvider?.models ?? []).map((m) => m.id));
  const modelsById = new Map<string, OpenClawModel>();

  for (const model of existingProvider?.models ?? []) {
    modelsById.set(model.id, model);
  }

  for (const { alias, ...model } of preset.models) {
    const existingModel = modelsById.get(model.id);
    modelsById.set(model.id, existingModel ? { ...existingModel, ...model } : model);
  }

  const netNew = preset.models.filter((m) => !existingIds.has(m.id)).length;
  assertProviderModelCapacity(existingProvider, netNew);

  config.models!.providers![preset.id] = removeLegacyAuthHeaderRef({
    ...existingProvider,
    baseUrl: preset.provider.baseUrl,
    apiKey: formatEnvRefForOpenClaw(preset.provider.apiKeyEnv),
    api: preset.provider.api,
    models: Array.from(modelsById.values()).map((model) => ensureModelName(model))
  });

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

const ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;
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
  if (!PROVIDER_API_TYPES.has(input.api)) throw new Error("api must be a supported API type");
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
  assertProviderModelCapacity(undefined, input.models.length);

  const baseUrl = normalizeCustomProviderBaseUrl(input.api, input.baseUrl, input.isFullUrl);
  const models = input.models.map((model): OpenClawModel =>
    ensureModelName({
      id: model.id,
      ...(model.name !== undefined ? { name: model.name } : {})
    })
  );

  config.models!.providers![input.providerId] = {
    baseUrl,
    api: input.api,
    apiKey: formatEnvRefForOpenClaw(input.apiKeyEnv),
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
