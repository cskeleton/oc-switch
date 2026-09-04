import { formatModelRef, normalizeProviderId, parseModelRef } from "./model-ref";
import { getModelPolicyMode, getModelSelectionSource } from "./model-policy";
import { readPrimaryModelRef } from "./primary-model";
import type { ModelSummary, OpenClawConfig, ProviderSummary, StatusSummary } from "./types";

export interface ConfigAdapterOptions {
  /** 由外层 provider-states 提供；adapter 只负责归一化后的可选模型聚合。 */
  disabledProviderIds?: Iterable<string>;
}

export function createConfigAdapter(config: OpenClawConfig, options: ConfigAdapterOptions = {}) {
  const providers = config.models?.providers ?? {};
  const allowlist = config.agents?.defaults?.models ?? {};
  const primaryModel = readPrimaryModelRef(config);
  const modelPolicyMode = getModelPolicyMode(config);
  const disabledProviderIds = new Set(
    [...(options.disabledProviderIds ?? [])].map((providerId) => normalizeProviderId(providerId))
  );

  const providerIdsByNormalized = new Map<string, string[]>();
  for (const providerId of Object.keys(providers)) {
    const normalized = normalizeProviderId(providerId);
    const ids = providerIdsByNormalized.get(normalized) ?? [];
    ids.push(providerId);
    providerIdsByNormalized.set(normalized, ids);
  }

  function uniqueProviderId(providerId: string): string | undefined {
    const ids = providerIdsByNormalized.get(normalizeProviderId(providerId)) ?? [];
    return ids.length === 1 ? ids[0] : undefined;
  }

  function modelIdentity(providerId: string, modelId: string): string {
    const canonicalProviderId = uniqueProviderId(providerId);
    return canonicalProviderId
      ? `normalized:${normalizeProviderId(canonicalProviderId)}/${modelId}`
      : `exact:${providerId}/${modelId}`;
  }

  function providerModelRefs(providerId: string): string[] {
    return (providers[providerId]?.models ?? []).map((model) => formatModelRef(providerId, model.id));
  }

  function selectionSourceFor(providerId: string, modelId: string) {
    const ref = formatModelRef(providerId, modelId);
    if (modelPolicyMode === "legacy" && !uniqueProviderId(providerId)) {
      return Object.prototype.hasOwnProperty.call(allowlist, ref) ? "legacy" : undefined;
    }
    return getModelSelectionSource(config, ref);
  }

  function listProviderSummaries(): ProviderSummary[] {
    return Object.entries(providers).map(([id, provider]) => {
      const refs = providerModelRefs(id);
      const disabled = disabledProviderIds.has(normalizeProviderId(id));
      return {
        id,
        api: provider.api,
        baseUrl: provider.baseUrl,
        modelCount: refs.length,
        enabledModelCount: disabled
          ? 0
          : refs.filter((ref) => {
              const { providerId, modelId } = parseModelRef(ref);
              return selectionSourceFor(providerId, modelId) !== undefined;
            }).length,
        containsPrimary: primaryModel
          ? (() => {
              const { providerId } = parseModelRef(primaryModel);
              return uniqueProviderId(id) ? normalizeProviderId(providerId) === normalizeProviderId(id) : providerId === id;
            })()
          : false,
        disabled
      };
    });
  }

  return {
    listProviders(): ProviderSummary[] {
      return listProviderSummaries();
    },

    listModels(): ModelSummary[] {
      const summaries = new Map<string, ModelSummary>();

      for (const [providerId, provider] of Object.entries(providers)) {
        const canonicalProviderId = uniqueProviderId(providerId) ?? providerId;
        for (const model of provider.models ?? []) {
          const identity = modelIdentity(providerId, model.id);
          const selectionSource = selectionSourceFor(providerId, model.id);
          const summary: ModelSummary = {
            ref: formatModelRef(canonicalProviderId, model.id),
            providerId: canonicalProviderId,
            modelId: model.id,
            name: model.name,
            alias: undefined,
            enabled: selectionSource !== undefined,
            ...(selectionSource ? { selectionSource } : {}),
            isPrimary: primaryModel ? modelIdentity(parseModelRef(primaryModel).providerId, parseModelRef(primaryModel).modelId) === identity : false
          };
          if (model.api !== undefined) summary.api = model.api;
          if (model.reasoning !== undefined) summary.reasoning = model.reasoning;
          if (model.contextWindow !== undefined) summary.contextWindow = model.contextWindow;
          if (model.contextTokens !== undefined) summary.contextTokens = model.contextTokens;
          if (model.maxTokens !== undefined) summary.maxTokens = model.maxTokens;
          if (model.input !== undefined) summary.input = model.input;
          summaries.set(identity, summary);
        }
      }

      for (const [ref, entry] of Object.entries(allowlist)) {
        const { providerId, modelId } = parseModelRef(ref);
        const canonicalProviderId = uniqueProviderId(providerId) ?? providerId;
        const identity = modelIdentity(providerId, modelId);
        const existing = summaries.get(identity);
        if (existing) {
          existing.alias = entry.alias;
          continue;
        }
        const selectionSource = modelPolicyMode === "unrestricted"
          ? undefined
          : getModelSelectionSource(config, ref);
        summaries.set(identity, {
          ref: formatModelRef(canonicalProviderId, modelId),
          providerId: canonicalProviderId,
          modelId,
          name: undefined,
          alias: entry.alias,
          enabled: selectionSource !== undefined,
          ...(selectionSource ? { selectionSource } : {}),
          isPrimary: primaryModel
            ? modelIdentity(parseModelRef(primaryModel).providerId, parseModelRef(primaryModel).modelId) === identity
            : false
        });
      }

      return [...summaries.values()];
    },

    getStatus(): StatusSummary {
      return {
        primaryModel,
        providerCount: Object.keys(providers).length,
        providerModelCount: Object.values(providers).reduce((sum, provider) => sum + (provider.models?.length ?? 0), 0),
        allowlistModelCount: Object.keys(allowlist).length,
        modelPolicyMode,
        effectiveModelCount: listProviderSummaries().reduce((sum, provider) => sum + provider.enabledModelCount, 0)
      };
    }
  };
}
