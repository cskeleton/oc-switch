import { formatModelRef, normalizeProviderId, parseModelRef } from "./model-ref";
import {
  addPolicyAllow,
  assertNoPolicyWildcardForRef,
  assertPolicyExactRefsRemovalAllowed,
  assertPolicyProviderExactRemovalAllowed,
  assertPolicyProviderWildcardRemovalAllowed,
  findPolicyWildcardForProvider,
  removePolicyAllow,
  removePolicyAllowForProvider,
  removePolicyWildcardForProvider
} from "./model-policy";
import { setPrimaryModel } from "./model-operations";
import { formatEnvRefForOpenClaw, ensureModelName } from "./openclaw-compat";
import { ensureDefaults, matchingAllowlistRefs, resolveProviderId, type OperationResult } from "./operation-common";
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
  if (fallbackRefs.some((ref) => normalizeProviderId(parseModelRef(ref).providerId) === normalizeProviderId(providerId))) {
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
  if (!primary || normalizeProviderId(parseModelRef(primary).providerId) !== normalizeProviderId(providerId)) return;
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
  options: { force: boolean; newPrimary?: string; removePolicyWildcard?: boolean }
): OperationResult {
  // 显式拒绝不存在的 provider（含插件 provider），避免静默 no-op 假成功
  const resolvedProviderId = resolveProviderId(config, providerId);
  if (!resolvedProviderId) throw new Error(`Provider ${providerId} not found`);
  const primary = readPrimaryModelRef(config);
  // fallback 依赖保护必须发生在任何 mutation 之前（force 也不可绕过）
  assertProviderFallbackRemovalAllowed(config, resolvedProviderId);
  assertPolicyProviderExactRemovalAllowed(config, resolvedProviderId, "remove");
  // 残留 wildcard 不再阻断删除（降级为提示）；仅显式 removePolicyWildcard 时才移除该 Provider 的通配条目，
  // 且不得把受限 policy 清空为 unrestricted（防清空 guard 先于任何 mutation）
  const leftoverWildcard = findPolicyWildcardForProvider(config, resolvedProviderId);
  if (options.removePolicyWildcard) {
    assertPolicyProviderWildcardRemovalAllowed(config, resolvedProviderId, "remove");
  }
  assertProviderPrimaryRemovalAllowed(config, resolvedProviderId, options);

  ensureDefaults(config);

  delete config.models!.providers![resolvedProviderId];

  for (const ref of Object.keys(config.agents!.defaults!.models!)) {
    if (normalizeProviderId(parseModelRef(ref).providerId) === normalizeProviderId(resolvedProviderId)) {
      delete config.agents!.defaults!.models![ref];
    }
  }
  removePolicyAllowForProvider(config, resolvedProviderId);
  if (options.removePolicyWildcard) {
    removePolicyWildcardForProvider(config, resolvedProviderId);
  }

  const warnings: string[] = [];
  if (!options.removePolicyWildcard && leftoverWildcard) {
    warnings.push(
      `Policy wildcard ${leftoverWildcard} still references provider ${resolvedProviderId}; it is now dangling and can be removed explicitly.`
    );
  }
  if (primary && normalizeProviderId(parseModelRef(primary).providerId) === normalizeProviderId(resolvedProviderId) && options.force) {
    warnings.push(`Primary model ${primary} now points to a deleted provider`);
  }
  return { config, warnings };
}

export function editProvider(
  config: OpenClawConfig,
  providerId: string,
  changes: { baseUrl?: string; api?: ApiType; apiKeyEnv?: string }
): OperationResult {
  ensureDefaults(config);
  const resolvedProviderId = resolveProviderId(config, providerId);
  const provider = resolvedProviderId ? config.models!.providers![resolvedProviderId] : undefined;
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
  const providerId = normalizeProviderId(preset.id);
  const existingProviderId = resolveProviderId(config, providerId);
  const existingProvider = existingProviderId ? config.models!.providers![existingProviderId] : undefined;
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

  // 预设中未勾选的既有模型等价于 disable；通配 policy 不允许借此路径假装关闭。
  const disabledRefs = preset.models
    .filter((model) => !enabledModelIds.includes(model.id))
    .map((model) => formatModelRef(providerId, model.id));
  for (const ref of disabledRefs) {
    assertNoPolicyWildcardForRef(config, ref, "disable");
  }
  assertPolicyExactRefsRemovalAllowed(config, disabledRefs, "disable", `models from provider ${providerId}`);

  ensureDefaults(config);

  config.models!.providers![providerId] = removeLegacyAuthHeaderRef({
    ...existingProvider,
    baseUrl: preset.provider.baseUrl,
    apiKey: formatEnvRefForOpenClaw(preset.provider.apiKeyEnv),
    api: preset.provider.api,
    models: Array.from(modelsById.values()).map((model) => ensureModelName(model))
  });
  if (existingProviderId && existingProviderId !== providerId) {
    delete config.models!.providers![existingProviderId];
  }

  for (const model of preset.models) {
    const ref = formatModelRef(providerId, model.id);
    const matchingRefs = matchingAllowlistRefs(config, ref);
    const existingRef = matchingRefs[0];
    const existingEntry = existingRef ? config.agents!.defaults!.models![existingRef] : undefined;
    for (const matchingRef of matchingRefs) delete config.agents!.defaults!.models![matchingRef];
    if (enabledModelIds.includes(model.id)) {
      config.agents!.defaults!.models![ref] = model.alias
        ? { ...existingEntry, alias: model.alias }
        : existingEntry ?? {};
      addPolicyAllow(config, ref);
    } else {
      delete config.agents!.defaults!.models![ref];
      removePolicyAllow(config, ref);
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
  const lower = normalizeProviderId(input.providerId);
  const caseClash = Object.keys(config.models?.providers ?? {}).find((id) => normalizeProviderId(id) === lower);
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
  const providerId = normalizeProviderId(input.providerId);

  const baseUrl = normalizeCustomProviderBaseUrl(input.api, input.baseUrl, input.isFullUrl);
  const models = input.models.map((model): OpenClawModel =>
    ensureModelName({
      id: model.id,
      reasoning: true,
      ...(model.name !== undefined ? { name: model.name } : {})
    })
  );

  config.models!.providers![providerId] = {
    baseUrl,
    api: input.api,
    apiKey: formatEnvRefForOpenClaw(input.apiKeyEnv),
    models
  };

  if (input.enableAllModels) {
    for (const model of input.models) {
      const ref = formatModelRef(providerId, model.id);
      config.agents!.defaults!.models![ref] = model.alias ? { alias: model.alias } : {};
      addPolicyAllow(config, ref);
    }
  }

  return { config, warnings: [] };
}
