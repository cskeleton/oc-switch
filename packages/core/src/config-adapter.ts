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
          containsPrimary: primaryModel ? parseModelRef(primaryModel).providerId === id : false
        };
      });
    },

    listModels(): ModelSummary[] {
      const refs = [...new Set([...providerModelByRef.keys(), ...Object.keys(allowlist)])];
      return refs.map((ref) => {
        const { providerId, modelId } = parseModelRef(ref);
        const providerModel = providerModelByRef.get(ref);
        const entry = allowlist[ref];
        return {
          ref,
          providerId,
          modelId,
          name: providerModel?.model.name,
          alias: entry?.alias,
          enabled: Boolean(entry),
          isPrimary: primaryModel === ref
        };
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
