import { formatModelRef, normalizeProviderId, parseModelRef } from "./model-ref";
import { getModelPolicyMode, getModelSelectionSource } from "./model-policy";
import { filterPluginProvidersConflictWithConfig, type PluginProvider } from "./plugin-catalog";
import { readPrimaryModelRef } from "./primary-model";
import type { ModelSummary, OpenClawConfig, ProviderSummary, StatusSummary } from "./types";

export interface ConfigAdapterOptions {
  /** 由外层 provider-states 提供；adapter 只负责归一化后的可选模型聚合。 */
  disabledProviderIds?: Iterable<string>;
  /** OpenClaw 插件 manifest 提供的只读 provider 目录（plugin-catalog.ts）。 */
  pluginProviders?: PluginProvider[];
}

/**
 * 兼容层（2026-09-09 运行时模型协调 spec §14）：本 adapter 聚合 config +
 * 插件 manifest 的旧形状，供既有 `GET /api/models`、`GET /api/providers` 与
 * Dashboard 计数消费。
 *
 * ⚠️ 新代码不得依赖本层的简化语义：
 * - 与 `models.providers` 同名的插件 provider 被 config 优先遮蔽（spec §7.3 的
 *   v1 简化），而运行时实际是并集；
 * - 本层没有 OpenClaw 运行时目录（runtime-only 模型、policy-only 悬空引用、
 *   三态可用性）的事实，`enabled` 只反映 policy 选择，不代表模型可调用。
 *
 * 运行时可用性 / 统一来源判定一律走 `buildModelInventory`
 * （`packages/core/src/model-inventory.ts`，即 `GET /api/model-inventory`）。
 */
export function createConfigAdapter(config: OpenClawConfig, options: ConfigAdapterOptions = {}) {
  const providers = config.models?.providers ?? {};
  const allowlist = config.agents?.defaults?.models ?? {};
  const primaryModel = readPrimaryModelRef(config);
  const modelPolicyMode = getModelPolicyMode(config);
  const disabledProviderIds = new Set(
    [...(options.disabledProviderIds ?? [])].map((providerId) => normalizeProviderId(providerId))
  );
  // config 优先：与 models.providers 冲突的插件 provider 不重复列出；插件间同 id 先到先得
  const pluginProviders: PluginProvider[] = [];
  {
    const seen = new Set<string>();
    for (const provider of filterPluginProvidersConflictWithConfig(config, options.pluginProviders ?? [])) {
      const normalized = normalizeProviderId(provider.providerId);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      pluginProviders.push(provider);
    }
  }

  function isProviderDisabled(providerId: string): boolean {
    return disabledProviderIds.has(normalizeProviderId(providerId));
  }

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
    const summaries: ProviderSummary[] = Object.entries(providers).map(([id, provider]) => {
      const refs = providerModelRefs(id);
      const disabled = isProviderDisabled(id);
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
        disabled,
        source: "config"
      };
    });
    for (const plugin of pluginProviders) {
      summaries.push({
        id: plugin.providerId,
        api: plugin.api,
        baseUrl: plugin.baseUrl,
        modelCount: plugin.models.length,
        enabledModelCount: plugin.enabled
          ? plugin.models.filter((model) => selectionSourceFor(plugin.providerId, model.id) !== undefined).length
          : 0,
        containsPrimary: primaryModel
          ? normalizeProviderId(parseModelRef(primaryModel).providerId) === normalizeProviderId(plugin.providerId)
          : false,
        disabled: !plugin.enabled,
        source: "plugin"
      });
    }
    return summaries;
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
            enabled: !isProviderDisabled(providerId) && selectionSource !== undefined,
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

      for (const plugin of pluginProviders) {
        for (const model of plugin.models) {
          const identity = modelIdentity(plugin.providerId, model.id);
          const selectionSource = selectionSourceFor(plugin.providerId, model.id);
          const summary: ModelSummary = {
            ref: formatModelRef(plugin.providerId, model.id),
            providerId: plugin.providerId,
            modelId: model.id,
            name: model.name,
            alias: undefined,
            enabled: plugin.enabled && selectionSource !== undefined,
            ...(selectionSource ? { selectionSource } : {}),
            isPrimary: primaryModel
              ? modelIdentity(parseModelRef(primaryModel).providerId, parseModelRef(primaryModel).modelId) === identity
              : false
          };
          const modelApi = model.api ?? plugin.api;
          if (modelApi !== undefined) summary.api = modelApi;
          if (model.reasoning !== undefined) summary.reasoning = model.reasoning;
          if (model.contextWindow !== undefined) summary.contextWindow = model.contextWindow;
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
          enabled: !isProviderDisabled(providerId) && selectionSource !== undefined,
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
