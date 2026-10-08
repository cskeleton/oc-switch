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
    source: "config",
    apiKeyEnv: null,
    apiKeyEnvManaged: false,
    apiKeyEnvStatus: "missing",
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

/** 完整静态 DTO fixture；能力由用例显式覆盖，不作在线可用性推断。 */
export function staticSnapshot(overrides: Partial<import("./api").StaticModelConfigSnapshot> = {}): import("./api").StaticModelConfigSnapshot {
  return {
    schemaVersion: 1, capturedAt: "2026-10-08T00:00:00Z", policyMode: "restricted", policyRevision: "v1:fixture",
    providers: [], models: [], policyRules: [],
    status: { providerCount: 0, providerModelCount: 0, allowlistModelCount: 0, modelPolicyMode: "restricted", effectiveModelCount: 0 },
    ...overrides
  };
}
export function staticModel(input: ModelSummaryInput, overrides: Partial<import("./api").StaticModelSummary> = {}): import("./api").StaticModelSummary {
  return { ...modelSummary(input), catalogConfigured: true, capabilities: { canSetPrimary: true, canTogglePolicy: true, canEditCatalogEntry: true, canRemoveCatalogEntry: true }, ...overrides };
}
export function emptyExtensions(): import("./api").PluginExtensionsSnapshot {
  return { schemaVersion: 1, capturedAt: "2026-10-08T00:00:00Z", providers: [], plugins: [], diagnostics: [] };
}
