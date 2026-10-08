import { createConfigAdapter } from "./config-adapter";
import { inspectEnvFile, listProviderEnvRefs } from "./env-inspector";
import type { OcSwitchManifest } from "./manifest-manager";
import { getModelPolicyMode, readModelPolicyAllowRaw } from "./model-policy";
import { buildModelPolicyRevision, canRemoveModelPolicyRule } from "./model-policy-edit";
import { ModelPolicyMatchContext } from "./model-policy-index";
import type { ModelPluginDescriptor, ModelPolicyRuleEntry } from "./model-inventory";
import { normalizeModelRefForStorage, normalizeProviderId } from "./model-ref";
import { providerEnvVar } from "./openclaw-compat";
import type { PluginCatalogResult, PluginProvider } from "./plugin-catalog";
import { readFallbackModelRefs } from "./primary-model";
import type { ModelPolicyMode, ModelSummary, OpenClawConfig, ProviderSummary, StatusSummary } from "./types";

export interface StaticProviderSummary extends ProviderSummary {
  apiKeyEnv: string | null;
  apiKeyEnvManaged: boolean;
  apiKeyEnvStatus: "missing" | "managed" | "unmanaged" | "duplicate" | "complex";
}

export interface StaticModelSummary extends ModelSummary {
  /** 本地目录存在该模型；仅 metadata 引用没有目录编辑能力。 */
  catalogConfigured: boolean;
  /** 仅本地配置操作权限，不声明运行时可用性或选择器状态。 */
  capabilities: {
    canSetPrimary: boolean;
    canTogglePolicy: boolean;
    canEditCatalogEntry: boolean;
    canRemoveCatalogEntry: boolean;
  };
}

/** 静态规则仅投影配置事实，不把尚未读取的运行时计数冒充零。 */
export type StaticModelPolicyRuleEntry = Omit<ModelPolicyRuleEntry, "matchedModelCount" | "unavailableModelCount">;

export interface StaticModelConfigSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  primaryModel?: string;
  policyMode: ModelPolicyMode;
  policyRevision: string;
  providers: StaticProviderSummary[];
  models: StaticModelSummary[];
  policyRules: StaticModelPolicyRuleEntry[];
  /** 仅本地配置计数；不包含插件模型或运行时状态。 */
  status: StatusSummary;
}

export interface PluginExtensionsSnapshot {
  schemaVersion: 1;
  capturedAt: string;
  providers: PluginProvider[];
  plugins: ModelPluginDescriptor[];
  diagnostics: string[];
}

export interface BuildModelConfigSnapshotInput {
  config: OpenClawConfig;
  envContent?: string;
  manifest?: OcSwitchManifest;
  disabledProviderIds?: Iterable<string>;
  capturedAt?: string;
}

/** 只处理已读取的本地文件内容，不发起插件发现、运行时探测或任何写入。 */
export function buildModelConfigSnapshot(input: BuildModelConfigSnapshotInput): StaticModelConfigSnapshot {
  const { config } = input;
  const adapter = createConfigAdapter(config, input.disabledProviderIds ? { disabledProviderIds: input.disabledProviderIds } : {});
  const policyMode = getModelPolicyMode(config);
  const policyMatch = ModelPolicyMatchContext.fromConfig(config);
  const envByName = new Map(inspectEnvFile({
    content: input.envContent ?? "",
    providerRefs: listProviderEnvRefs(config),
    manifest: input.manifest ?? { providers: {} }
  }).variables.map(variable => [variable.envVar, variable]));
  const providers: StaticProviderSummary[] = adapter.listProviders().map(provider => {
    const apiKeyEnv = providerEnvVar(config.models?.providers?.[provider.id]) ?? null;
    const env = apiKeyEnv ? envByName.get(apiKeyEnv) : undefined;
    const apiKeyEnvStatus: StaticProviderSummary["apiKeyEnvStatus"] = !env?.present || env.empty ? "missing"
      : env.duplicate ? "duplicate"
      : env.complex ? "complex"
      : env.managed ? "managed" : "unmanaged";
    return { ...provider, apiKeyEnv, apiKeyEnvManaged: Boolean(env?.managed), apiKeyEnvStatus };
  });
  const catalogRefs = new Set(Object.entries(config.models?.providers ?? {}).flatMap(([providerId, provider]) =>
    (provider.models ?? []).map(model => normalizeModelRefForStorage(`${providerId}/${model.id}`))));
  const disabledProviders = new Set(providers.filter(provider => provider.disabled).map(provider => normalizeProviderId(provider.id)));
  const fallbackRefs = new Set(readFallbackModelRefs(config).map(normalizeModelRefForStorage));
  const models: StaticModelSummary[] = adapter.listModels().map(model => {
    const identity = normalizeModelRefForStorage(model.ref);
    const catalogConfigured = catalogRefs.has(identity);
    const disabled = disabledProviders.has(normalizeProviderId(model.providerId));
    const protectedReference = model.isPrimary || fallbackRefs.has(identity);
    // 复用一次构建的 policy 索引：只计算本 ref 的 exact 副本，避免逐行克隆配置模拟写入。
    const exactCopies = [...policyMatch.coveringRules(model.ref)]
      .filter(rule => !rule.endsWith("/*"))
      .reduce((sum, rule) => sum + policyMatch.copyCountOf(rule), 0);
    const canDisable = !protectedReference && policyMatch.findWildcardCovering(model.ref) === undefined &&
      (policyMode !== "restricted" || policyMatch.rawLength > exactCopies);
    return {
      ...model,
      catalogConfigured,
      capabilities: {
        canSetPrimary: catalogConfigured && !disabled && model.enabled && !model.isPrimary,
        canTogglePolicy: catalogConfigured && !disabled && policyMode !== "unrestricted" && (!model.enabled || canDisable),
        canEditCatalogEntry: catalogConfigured,
        // 目录临时删除可保留 policy/metadata，最终具体 layers 的保护由写入入口校验。
        canRemoveCatalogEntry: catalogConfigured && !protectedReference
      }
    };
  });
  const policyRules: StaticModelPolicyRuleEntry[] = policyMode === "restricted"
    ? (readModelPolicyAllowRaw(config) ?? []).map((value, index) => typeof value === "string"
      ? {
          value,
          kind: value.endsWith("/*") ? "wildcard" as const : "exact" as const,
          removable: canRemoveModelPolicyRule(config, value, policyMatch),
          editable: true
        }
      : { value: "", kind: "invalid" as const, invalidIndex: index, removable: false, editable: false })
    : [];
  const order = { exact: 0, wildcard: 1, invalid: 2 };
  policyRules.sort((a, b) => order[a.kind] - order[b.kind] || (a.kind === "invalid" && b.kind === "invalid"
    ? (a.invalidIndex ?? 0) - (b.invalidIndex ?? 0)
    : a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
  const status = adapter.getStatus();
  return {
    schemaVersion: 1,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    ...(status.primaryModel ? { primaryModel: status.primaryModel } : {}),
    policyMode,
    policyRevision: buildModelPolicyRevision(config),
    providers,
    models,
    policyRules,
    status
  };
}

/** 用公开字段构建插件 DTO，避免将 provider 注入的原始 CLI entry 透传至浏览器。 */
export function buildPluginExtensionsSnapshot(catalog: PluginCatalogResult): PluginExtensionsSnapshot {
  return {
    schemaVersion: 1,
    capturedAt: new Date().toISOString(),
    providers: catalog.providers.map(provider => ({
      pluginId: provider.pluginId,
      providerId: provider.providerId,
      origin: provider.origin,
      enabled: provider.enabled,
      ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
      ...(provider.api !== undefined ? { api: provider.api } : {}),
      apiKeyEnvVars: [...provider.apiKeyEnvVars],
      models: provider.models.map(model => ({
        id: model.id,
        ...(model.name !== undefined ? { name: model.name } : {}),
        ...(model.api !== undefined ? { api: model.api } : {}),
        ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
        ...(model.maxTokens !== undefined ? { maxTokens: model.maxTokens } : {}),
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        ...(model.input !== undefined ? { input: [...model.input] } : {})
      }))
    })),
    plugins: catalog.plugins.map(plugin => ({
      id: plugin.id,
      ...(plugin.name !== undefined ? { name: plugin.name } : {}),
      origin: plugin.origin,
      enabled: plugin.enabled,
      providerIds: [...plugin.providerIds],
      nonModelCapabilities: [...plugin.nonModelCapabilities]
    })),
    diagnostics: [...catalog.diagnostics]
  };
}
