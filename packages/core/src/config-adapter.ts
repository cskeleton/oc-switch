import { formatModelRef, parseModelRef } from "./model-ref";
import type { ModelSummary, OpenClawConfig, ProviderSummary, StatusSummary } from "./types";

export function createConfigAdapter(config: OpenClawConfig) {
  const providers = config.models?.providers ?? {};
  const allowlist = config.agents?.defaults?.models ?? {};
  const primaryModel = config.agents?.defaults?.model;

  const providerModelByRef = new Map(
    Object.entries(providers).flatMap(([providerId, provider]) =>
      (provider.models ?? []).map((model) => [formatModelRef(providerId, model.id), { providerId, model }] as const)
    )
  );

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
          enabledModelCount: Object.keys(allowlist).filter((ref) => parseModelRef(ref).providerId === id).length,
          containsPrimary: primaryModel ? parseModelRef(primaryModel).providerId === id : false,
          disabled: false
        };
      });
    },

    listModels(): ModelSummary[] {
      const refs = [...new Set([...providerModelByRef.keys(), ...Object.keys(allowlist)])];
      return refs.map((ref) => {
        const { providerId, modelId } = parseModelRef(ref);
        const providerModel = providerModelByRef.get(ref);
        const entry = allowlist[ref];
        const summary: ModelSummary = {
          ref,
          providerId,
          modelId,
          name: providerModel?.model.name,
          alias: entry?.alias,
          enabled: Boolean(entry),
          isPrimary: primaryModel === ref
        };
        const model = providerModel?.model;
        if (model?.api !== undefined) summary.api = model.api;
        if (model?.reasoning !== undefined) summary.reasoning = model.reasoning;
        if (model?.contextWindow !== undefined) summary.contextWindow = model.contextWindow;
        if (model?.maxTokens !== undefined) summary.maxTokens = model.maxTokens;
        if (model?.input !== undefined) summary.input = model.input;
        return summary;
      });
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
