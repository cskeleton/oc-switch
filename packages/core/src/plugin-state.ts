import type { ModelPluginDescriptor } from "./model-inventory";
import { readModelPolicyAllow } from "./model-policy";
import { normalizeProviderId, parseModelRef } from "./model-ref";
import type { OperationResult } from "./operation-common";
import { readFallbackModelRefs, readPrimaryModelRef } from "./primary-model";
import type { OpenClawConfig, OpenClawPluginEntry } from "./types";

/**
 * 插件级安全启停 operation（spec §9）。
 *
 * 范围：只管理「已安装且至少贡献一个模型 Provider」的插件（descriptor 的
 * providerIds 非空）；不安装、卸载、升级插件，不触碰 `enabled` 之外的任何
 * 插件配置键（pinned/config 等），不修改 provider-states.json，不联动删除
 * modelPolicy——停用后 policy 引用成为不可用项是预期行为，重新启用即自然恢复。
 *
 * 纯函数：输入 config 不被修改（入口 structuredClone）；预检失败在
 * 任何 mutation 之前抛结构化 `PluginStateError`（code 由 Server/CLI 映射为
 * 400 / 非零退出）。写入由外层经 `writeOpenClawTransaction`（自动备份 +
 * diff guard）落盘；写入后的生效确认（重新探测）属 Task 5，不在本模块。
 */

/** 结构化 blocker code：Server/CLI 据此映射为可操作的 400 提示 */
export type PluginStateErrorCode =
  | "plugin-without-model-providers"
  | "primary-model-referenced"
  | "fallback-referenced";

export class PluginStateError extends Error {
  readonly code: PluginStateErrorCode;

  constructor(code: PluginStateErrorCode, message: string) {
    super(message);
    this.name = "PluginStateError";
    this.code = code;
  }
}

export function isPluginStateError(error: unknown): error is PluginStateError {
  return error instanceof PluginStateError;
}

/** ref 的 Provider 段小写折叠（与 parseModelRef/normalizeProviderId 语义一致） */
function refProviderId(ref: string): string | undefined {
  try {
    return normalizeProviderId(parseModelRef(ref).providerId);
  } catch {
    return undefined;
  }
}

/**
 * 安全设置一个模型插件的 `plugins.entries.<id>.enabled`。
 *
 * 预检（只在停用 false 时生效，启用只会恢复可用性）：
 * - descriptor.providerIds 为空 → 拒绝（非模型插件不在启停范围，spec §9.1）；
 * - primary ref 命中任一贡献 Provider（大小写折叠）→ 阻止，要求先切换主模型；
 * - 合法 fallback 命中 → 阻止，要求先处理回退链；
 * - policy exact/wildcard 与 legacy metadata 命中 → 只产生 warnings，原样保留。
 *
 * 写入语义（spec §9.2）：
 * - 只改 `enabled` 一个键；entry 其他键（pinned/config 等）逐字保留；
 * - entry 缺失时创建最小 `{ enabled: <目标值> }`（停用覆盖 enabledByDefault；
 *   启用是对默认开启的显式确认，同样允许）；
 * - 只触碰传入 pluginId 的 entry，绝不影响其他插件条目。
 */
export function setModelPluginEnabled(
  config: OpenClawConfig,
  plugin: ModelPluginDescriptor,
  enabled: boolean
): OperationResult {
  // ---------- 预检：全部通过后才复制配置（fail closed，不产生任何部分写入） ----------
  if (plugin.providerIds.length === 0) {
    throw new PluginStateError(
      "plugin-without-model-providers",
      `Plugin ${plugin.id} does not contribute any model provider; oc-switch only manages model plugins.`
    );
  }

  const affectedProviderIds = new Set(plugin.providerIds.map((providerId) => normalizeProviderId(providerId)));

  if (!enabled) {
    const primaryRef = readPrimaryModelRef(config);
    const primaryProvider = primaryRef !== undefined ? refProviderId(primaryRef) : undefined;
    if (primaryProvider !== undefined && affectedProviderIds.has(primaryProvider)) {
      throw new PluginStateError(
        "primary-model-referenced",
        `Primary model ${primaryRef} belongs to provider ${primaryProvider} contributed by plugin ${plugin.id}; switch the primary model before disabling this plugin.`
      );
    }

    const fallbackRefs = readFallbackModelRefs(config);
    const fallbackHit = fallbackRefs.find((ref) => {
      const provider = refProviderId(ref);
      return provider !== undefined && affectedProviderIds.has(provider);
    });
    if (fallbackHit !== undefined) {
      throw new PluginStateError(
        "fallback-referenced",
        `Fallback model ${fallbackHit} belongs to a provider contributed by plugin ${plugin.id}; remove or migrate the fallback in the OpenClaw config first.`
      );
    }
  }

  // ---------- 影响面 warnings：policy / legacy metadata 命中贡献 Provider（默认保留） ----------
  const warnings: string[] = [];
  const policyEntries = readModelPolicyAllow(config) ?? [];
  const hitPolicyEntries = policyEntries.filter((entry) => {
    const provider = refProviderId(entry);
    return provider !== undefined && affectedProviderIds.has(provider);
  });
  if (hitPolicyEntries.length > 0) {
    warnings.push(
      `Policy entries ${hitPolicyEntries.join(", ")} were kept and will resolve to unavailable models while plugin ${plugin.id} is disabled; they become effective again once the plugin is re-enabled.`
    );
  }

  const metadataRefs = Object.keys(config.agents?.defaults?.models ?? {});
  const hitMetadataRefs = metadataRefs.filter((ref) => {
    const provider = refProviderId(ref);
    return provider !== undefined && affectedProviderIds.has(provider);
  });
  if (hitMetadataRefs.length > 0) {
    warnings.push(
      `Legacy metadata ${hitMetadataRefs.join(", ")} was kept; the referenced models stay listed but resolve against plugin ${plugin.id}.`
    );
  }

  if (plugin.nonModelCapabilities.length > 0) {
    warnings.push(
      `Plugin ${plugin.id} also provides non-model capabilities (${plugin.nonModelCapabilities.join(", ")}); disabling it affects those as well, not only model providers (${plugin.providerIds.join(", ")}).`
    );
  }

  // ---------- 最小 mutation：只在用户明确操作时建立 entry，只写 enabled ----------
  const next = structuredClone(config);
  const rawPlugins = next.plugins as { entries?: Record<string, unknown> } | undefined;
  const entries =
    typeof rawPlugins === "object" && rawPlugins !== null && typeof rawPlugins.entries === "object" && rawPlugins.entries !== null
      ? (rawPlugins.entries as Record<string, OpenClawPluginEntry>)
      : undefined;
  const container = entries ?? (((next.plugins ??= {}) as { entries?: Record<string, OpenClawPluginEntry> }).entries ??= {});
  const entry = container[plugin.id];
  if (entry !== undefined && typeof entry === "object") {
    // entry 已存在：保留其他键，只覆盖 enabled（OpenClawPluginEntry 未知键原样穿透）
    (entry as OpenClawPluginEntry).enabled = enabled;
  } else {
    // entry 缺失：创建最小 entry（不猜 pinned/config 等任何其他键）
    container[plugin.id] = { enabled };
  }

  return { config: next, warnings };
}
