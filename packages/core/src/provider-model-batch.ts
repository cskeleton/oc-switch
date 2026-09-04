import { formatModelRef, normalizeProviderId, parseModelRef } from "./model-ref";
import {
  addPolicyAllow,
  assertNoPolicyWildcardForRef,
  assertPolicyExactRefsRemovalAllowed,
  getModelSelectionSource,
  removePolicyAllow
} from "./model-policy";
import { ensureModelName } from "./openclaw-compat";
import { ensureDefaults, matchingAllowlistRefs, resolveProviderId, type OperationResult } from "./operation-common";
import { readFallbackModelRefs, readPrimaryModelRef } from "./primary-model";
import { assertProviderModelCapacity } from "./provider-model-limits";
import type { OpenClawConfig, OpenClawModel } from "./types";

export interface BatchAddProviderModelsInput {
  models: Array<{ id: string; name?: string }>;
  enable?: boolean;
}

export interface BatchAddProviderModelsResult extends OperationResult {
  addedModelIds: string[];
  skippedModelIds: string[];
}

export type BatchRemoveProviderModelsInput =
  | { modelIds: string[]; keepEnabledOnly?: undefined }
  | { keepEnabledOnly: true; modelIds?: undefined };

export interface BatchRemoveProviderModelsResult extends OperationResult {
  removedModelIds: string[];
}

/** 批量添加 provider-local 模型目录项；可选同时写入 allowlist */
export function batchAddProviderModels(
  config: OpenClawConfig,
  providerId: string,
  input: BatchAddProviderModelsInput
): BatchAddProviderModelsResult {
  ensureDefaults(config);
  const resolvedProviderId = resolveProviderId(config, providerId);
  const provider = resolvedProviderId ? config.models!.providers![resolvedProviderId] : undefined;
  if (!provider) throw new Error(`Provider ${providerId} not found`);

  const existingIds = new Set((provider.models ?? []).map((model) => model.id));
  const addedModelIds: string[] = [];
  const skippedModelIds: string[] = [];
  const pending: OpenClawModel[] = [];

  for (const item of input.models) {
    const id = item.id.trim();
    if (!id) throw new Error("model id must be a non-empty string");
    if (existingIds.has(id)) {
      skippedModelIds.push(id);
      continue;
    }
    addedModelIds.push(id);
    existingIds.add(id);
    const model: OpenClawModel = { id, reasoning: true };
    if (item.name !== undefined) {
      const trimmed = item.name.trim();
      if (trimmed) model.name = trimmed;
    }
    pending.push(ensureModelName(model));
  }

  assertProviderModelCapacity(provider, addedModelIds.length);

  provider.models = [...(provider.models ?? []), ...pending];

  const enable = input.enable ?? false;
  if (enable) {
    for (const id of addedModelIds) {
      const ref = formatModelRef(normalizeProviderId(resolvedProviderId!), id);
      const matchingRefs = matchingAllowlistRefs(config, ref);
      const existingRef = matchingRefs[0];
      const existing = existingRef ? config.agents!.defaults!.models![existingRef] : undefined;
      for (const matchingRef of matchingRefs) delete config.agents!.defaults!.models![matchingRef];
      config.agents!.defaults!.models![ref] = existing ?? {};
      addPolicyAllow(config, ref);
    }
  }

  return { config, warnings: [], addedModelIds, skippedModelIds };
}

function assertNotRemovingPrimaryModel(
  config: OpenClawConfig,
  providerId: string,
  modelIds: string[]
): void {
  const primary = readPrimaryModelRef(config);
  if (!primary) return;
  const { providerId: primaryProviderId, modelId: primaryModelId } = parseModelRef(primary);
  if (normalizeProviderId(primaryProviderId) !== normalizeProviderId(providerId)) return;
  if (modelIds.includes(primaryModelId)) {
    throw new Error(`Cannot remove primary model ${primary}`);
  }
}

/** fallback 目录保护（fail closed）：显式批量删除不得移除被 fallbacks 引用的目录项 */
function assertNotRemovingFallbackModel(
  config: OpenClawConfig,
  providerId: string,
  modelIds: string[]
): void {
  const fallbackModelIds = readFallbackModelRefs(config)
    .map((ref) => parseModelRef(ref))
    .filter((parts) => normalizeProviderId(parts.providerId) === normalizeProviderId(providerId))
    .map((parts) => parts.modelId);
  for (const modelId of modelIds) {
    if (fallbackModelIds.includes(modelId)) {
      throw new Error(
        `Model ${formatModelRef(providerId, modelId)} is referenced by agents.defaults.model.fallbacks. Remove it from the OpenClaw fallback list first.`
      );
    }
  }
}

function assertPrimaryCatalogPresentForKeepEnabledOnly(
  config: OpenClawConfig,
  providerId: string,
  providerModels: OpenClawModel[]
): void {
  const primary = readPrimaryModelRef(config);
  if (!primary) return;
  const { providerId: primaryProviderId, modelId: primaryModelId } = parseModelRef(primary);
  if (normalizeProviderId(primaryProviderId) !== normalizeProviderId(providerId)) return;
  const inCatalog = providerModels.some((model) => model.id === primaryModelId);
  if (!inCatalog) {
    throw new Error(
      `Primary model ${primary} is not in provider ${providerId} catalog. Add it to the catalog or switch primary before keep-enabled-only cleanup.`
    );
  }
}

function collectEffectivelyEnabledModelIds(config: OpenClawConfig, providerId: string): Set<string> {
  const ids = new Set<string>();
  const resolvedProviderId = resolveProviderId(config, providerId) ?? providerId;
  for (const model of config.models?.providers?.[resolvedProviderId]?.models ?? []) {
    const ref = formatModelRef(resolvedProviderId, model.id);
    if (getModelSelectionSource(config, ref) !== undefined) ids.add(model.id);
  }
  return ids;
}

/** 批量删除 provider-local 模型；或 keepEnabledOnly 仅保留已启用（及主模型目录项） */
export function batchRemoveProviderModels(
  config: OpenClawConfig,
  providerId: string,
  input: BatchRemoveProviderModelsInput
): BatchRemoveProviderModelsResult {
  const resolvedProviderId = resolveProviderId(config, providerId);
  const provider = resolvedProviderId ? config.models!.providers![resolvedProviderId] : undefined;
  if (!provider) throw new Error(`Provider ${providerId} not found`);

  const models = provider.models ?? [];

  if ("keepEnabledOnly" in input && input.keepEnabledOnly) {
    assertPrimaryCatalogPresentForKeepEnabledOnly(config, providerId, models);

    const keepIds = collectEffectivelyEnabledModelIds(config, providerId);
    const primary = readPrimaryModelRef(config);
    if (primary) {
      const { providerId: primaryProviderId, modelId: primaryModelId } = parseModelRef(primary);
      if (normalizeProviderId(primaryProviderId) === normalizeProviderId(providerId)) keepIds.add(primaryModelId);
    }

    const removedModelIds = models.filter((model) => !keepIds.has(model.id)).map((model) => model.id);
    // fallback 依赖保护（fail closed）：将要移除的目录项命中 fallbacks 引用时整单拒绝，
    // 不做静默保留例外；检查先于任何 mutation
    assertNotRemovingFallbackModel(config, providerId, removedModelIds);
    for (const id of removedModelIds) {
      assertNoPolicyWildcardForRef(config, formatModelRef(resolvedProviderId!, id), "remove");
    }
    assertPolicyExactRefsRemovalAllowed(
      config,
      removedModelIds.map((id) => formatModelRef(resolvedProviderId!, id)),
      "remove",
      `models from provider ${resolvedProviderId}`
    );

    ensureDefaults(config);

    provider.models = models.filter((model) => keepIds.has(model.id));

    for (const id of removedModelIds) {
      const ref = formatModelRef(resolvedProviderId!, id);
      for (const allowlistRef of matchingAllowlistRefs(config, ref)) {
        delete config.agents!.defaults!.models![allowlistRef];
      }
      removePolicyAllow(config, ref);
    }

    return { config, warnings: [], removedModelIds };
  }

  const modelIds = input.modelIds ?? [];
  if (modelIds.length === 0) {
    throw new Error("modelIds must not be empty");
  }

  assertNotRemovingPrimaryModel(config, providerId, modelIds);
  // fallback 依赖保护：先于任何 mutation
  assertNotRemovingFallbackModel(config, providerId, modelIds);

  for (const id of modelIds) {
    assertNoPolicyWildcardForRef(config, formatModelRef(resolvedProviderId!, id), "remove");
  }
  assertPolicyExactRefsRemovalAllowed(
    config,
    modelIds.map((id) => formatModelRef(resolvedProviderId!, id)),
    "remove",
    `models from provider ${resolvedProviderId}`
  );

  ensureDefaults(config);

  const removeSet = new Set(modelIds);
  const removedModelIds = models.filter((model) => removeSet.has(model.id)).map((model) => model.id);
  provider.models = models.filter((model) => !removeSet.has(model.id));

  for (const id of modelIds) {
    const ref = formatModelRef(resolvedProviderId!, id);
    for (const allowlistRef of matchingAllowlistRefs(config, ref)) {
      delete config.agents!.defaults!.models![allowlistRef];
    }
    removePolicyAllow(config, ref);
  }

  return { config, warnings: [], removedModelIds };
}
