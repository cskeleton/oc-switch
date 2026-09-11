import { normalizeProviderId, parseModelRef } from "./model-ref";
import type { PluginProvider } from "./plugin-catalog";
import type { OpenClawConfig } from "./types";

export interface OperationResult {
  config: OpenClawConfig;
  warnings: string[];
}

export function ensureDefaults(config: OpenClawConfig): void {
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.models ??= {};
  config.models ??= {};
  config.models.providers ??= {};
}

/** 解析唯一的大小写无关 Provider；真实重复时返回 undefined，避免静默选错。 */
export function resolveProviderId(config: OpenClawConfig, providerId: string): string | undefined {
  const matches = Object.keys(config.models?.providers ?? {}).filter(
    (id) => normalizeProviderId(id) === normalizeProviderId(providerId)
  );
  if (matches.length === 1) return matches[0];
  return config.models?.providers?.[providerId] ? providerId : undefined;
}

/** 找出同一逻辑模型的 allowlist 条目，Provider 前缀大小写折叠、model ID 保持敏感。 */
export function matchingAllowlistRefs(config: OpenClawConfig, ref: string): string[] {
  const { providerId, modelId } = parseModelRef(ref);
  const allowlist = config.agents?.defaults?.models ?? {};
  const providerIds = Object.keys(config.models?.providers ?? {}).filter(
    (id) => normalizeProviderId(id) === normalizeProviderId(providerId)
  );
  if (providerIds.length > 1) return Object.prototype.hasOwnProperty.call(allowlist, ref) ? [ref] : [];
  const resolvedProviderId = providerIds[0] ?? providerId;

  return Object.keys(allowlist).filter((candidate) => {
    try {
      const parsed = parseModelRef(candidate);
      return normalizeProviderId(parsed.providerId) === normalizeProviderId(resolvedProviderId) && parsed.modelId === modelId;
    } catch {
      // 无关的非法 metadata key 原样保留，不阻止处理合法 ref。
      return false;
    }
  });
}

export function hasProviderModel(config: OpenClawConfig, ref: string): boolean {
  const { providerId, modelId } = parseModelRef(ref);
  const resolvedProviderId = resolveProviderId(config, providerId);
  const provider = resolvedProviderId ? config.models?.providers?.[resolvedProviderId] : undefined;
  return Boolean(provider?.models?.some((model) => model.id === modelId));
}

/**
 * 目录存在性校验：本地 models.providers ∪ 启用中的插件 provider catalog。
 *
 * - 插件 provider disabled 时其模型不可用于 enable/use（与 OpenClaw 发现层语义一致）。
 * - 同名 Provider 的模型成员取并集；旧列表的 config 遮蔽规则不用于写入校验。
 */
export function hasKnownModel(
  config: OpenClawConfig,
  ref: string,
  pluginProviders: PluginProvider[] = []
): boolean {
  if (hasProviderModel(config, ref)) return true;
  const { providerId, modelId } = parseModelRef(ref);
  return pluginProviders.some(
    (plugin) =>
      plugin.enabled &&
      normalizeProviderId(plugin.providerId) === normalizeProviderId(providerId) &&
      plugin.models.some((model) => model.id === modelId)
  );
}
