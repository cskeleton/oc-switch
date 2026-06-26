import type { ModelSummary, ProviderSummary } from "./api";

type ProviderSummaryInput = Partial<ProviderSummary> & Pick<ProviderSummary, "id">;
type ModelSummaryInput = Partial<ModelSummary> & Pick<ModelSummary, "ref">;

function parseModelRef(ref: string): { providerId: string; modelId: string } {
  const slash = ref.indexOf("/");
  if (slash === -1) return { providerId: ref, modelId: "" };
  return {
    providerId: ref.slice(0, slash),
    modelId: ref.slice(slash + 1)
  };
}

export function providerSummary({ id, ...overrides }: ProviderSummaryInput): ProviderSummary {
  return {
    id,
    api: "openai-completions",
    baseUrl: `https://${id}.example/v1`,
    modelCount: 1,
    enabledModelCount: 1,
    containsPrimary: false,
    disabled: false,
    ...overrides
  };
}

export function modelSummary({ ref, ...overrides }: ModelSummaryInput): ModelSummary {
  const parsed = parseModelRef(ref);
  return {
    ref,
    providerId: parsed.providerId,
    modelId: parsed.modelId,
    name: undefined,
    alias: undefined,
    enabled: true,
    isPrimary: false,
    ...overrides
  };
}
