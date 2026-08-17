import { formatModelRef, normalizeProviderId, parseModelRef } from "./model-ref";
import { readPrimaryModelRef } from "./primary-model";
import type { ModelSummary, OpenClawConfig, ProviderSummary, StatusSummary } from "./types";

export function createConfigAdapter(config: OpenClawConfig) {
  const providers = config.models?.providers ?? {};
  const allowlist = config.agents?.defaults?.models ?? {};
  const primaryModel = readPrimaryModelRef(config);

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

  return {
    listProviders(): ProviderSummary[] {
      return Object.entries(providers).map(([id, provider]) => {
        const refs = providerModelRefs(id);
        return {
          id,
          api: provider.api,
          baseUrl: provider.baseUrl,
          modelCount: refs.length,
          enabledModelCount: Object.keys(allowlist).filter((ref) => {
            const { providerId } = parseModelRef(ref);
            return uniqueProviderId(id) ? normalizeProviderId(providerId) === normalizeProviderId(id) : providerId === id;
          }).length,
          containsPrimary: primaryModel
            ? (() => {
                const { providerId } = parseModelRef(primaryModel);
                return uniqueProviderId(id) ? normalizeProviderId(providerId) === normalizeProviderId(id) : providerId === id;
              })()
            : false,
          disabled: false
        };
      });
    },

    listModels(): ModelSummary[] {
      const summaries = new Map<string, ModelSummary>();

      for (const [providerId, provider] of Object.entries(providers)) {
        const canonicalProviderId = uniqueProviderId(providerId) ?? providerId;
        for (const model of provider.models ?? []) {
          const identity = modelIdentity(providerId, model.id);
          const summary: ModelSummary = {
            ref: formatModelRef(canonicalProviderId, model.id),
            providerId: canonicalProviderId,
            modelId: model.id,
            name: model.name,
            alias: undefined,
            enabled: false,
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
          existing.enabled = true;
          existing.alias = entry.alias;
          continue;
        }
        summaries.set(identity, {
          ref: formatModelRef(canonicalProviderId, modelId),
          providerId: canonicalProviderId,
          modelId,
          name: undefined,
          alias: entry.alias,
          enabled: true,
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
        allowlistModelCount: Object.keys(allowlist).length
      };
    }
  };
}
