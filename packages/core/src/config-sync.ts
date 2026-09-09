import type { ConfigStatusReport } from "./config-status";
import { listProviderEnvRefs } from "./env-inspector";
import { readEnvValue } from "./env-manager";
import { normalizeProviderId } from "./model-ref";
import { filterPluginProvidersConflictWithConfig, type PluginProvider } from "./plugin-catalog";
import type { AllowlistEntry, OpenClawConfig, OpenClawPrimaryModel, OpenClawProvider } from "./types";

/**
 * 跨机配置同步（spec：docs/superpowers/specs/2026-09-09-oc-switch-config-sync-design.md）。
 *
 * 单向 push + 子树覆盖：models.providers / agents.defaults.models /
 * agents.defaults.modelPolicy.allow / agents.defaults.model 四个子树整体覆盖对端，
 * 对端其余内容原样保留。覆盖语义下 modelPolicy.allow 的 fail-closed 写入规则天然满足，
 * 不存在逐条合并冲突。
 */

/** 同步子树包装：present=false 表示源端缺失（对端删除对应键），与显式空值（[] / {}）严格区分 */
export interface SyncSubtree<T> {
  present: boolean;
  value?: T;
}

/** 经 SSH 传输的同步载荷；JSON 可序列化，不含任何密钥值（apiKey 仅为 SecretRef） */
export interface SyncPayload {
  providers: SyncSubtree<Record<string, OpenClawProvider>>;
  defaultsModels: SyncSubtree<Record<string, AllowlistEntry>>;
  /** 缺失（legacy）与 [] （unrestricted）必须可区分，故用 SyncSubtree 包装 */
  modelPolicyAllow: SyncSubtree<unknown[]>;
  primaryModel: SyncSubtree<OpenClawPrimaryModel>;
}

export interface ApplySyncPayloadOptions {
  /** 显式允许开启的插件：仅把对端 plugins.entries.<id>.enabled 由 false 改为 true，绝反向、绝不新建条目 */
  enablePluginIds?: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function wrapSubtree<T>(value: T | undefined): SyncSubtree<T> {
  return value === undefined ? { present: false } : { present: true, value: structuredClone(value) };
}

function assertSubtreeValue<T>(subtree: SyncSubtree<T>, name: string): T {
  if (subtree.value === undefined) {
    throw new Error(`Invalid sync payload: ${name} marked present but value is missing`);
  }
  return subtree.value;
}

/** 确保容器键为 record（对端该键为标量等畸形值时替换为空对象，否则无法承载子树） */
function ensureRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = parent[key];
  if (isRecord(current)) return current;
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

/** 从源端 config 提取同步载荷；子树为 structuredClone，之后修改 payload 不影响源 config */
export function buildSyncPayload(config: OpenClawConfig): SyncPayload {
  return {
    providers: wrapSubtree(config.models?.providers),
    defaultsModels: wrapSubtree(config.agents?.defaults?.models),
    modelPolicyAllow: wrapSubtree(config.agents?.defaults?.modelPolicy?.allow),
    primaryModel: wrapSubtree(config.agents?.defaults?.model)
  };
}

/**
 * 将 payload 应用到对端 config（就地修改并返回），供 writeOpenClawTransaction 的 mutate 使用。
 * 缺失的子树在对端删除对应键（不擅自创建父结构之外的任何东西）；
 * 覆盖写只触碰 diff-guard 白名单内的四个子树与 §6.3 的 plugins.entries.<id>.enabled。
 */
export function applySyncPayload(
  config: OpenClawConfig,
  payload: SyncPayload,
  options: ApplySyncPayloadOptions = {}
): OpenClawConfig {
  // models.providers
  if (!payload.providers.present) {
    if (isRecord(config.models)) delete config.models.providers;
  } else {
    const models = ensureRecord(config as Record<string, unknown>, "models");
    models.providers = structuredClone(assertSubtreeValue(payload.providers, "providers"));
  }

  // agents.defaults.models
  if (!payload.defaultsModels.present) {
    const defaults = isRecord(config.agents) ? config.agents.defaults : undefined;
    if (isRecord(defaults)) delete defaults.models;
  } else {
    const agents = ensureRecord(config as Record<string, unknown>, "agents");
    const defaults = ensureRecord(agents, "defaults");
    defaults.models = structuredClone(assertSubtreeValue(payload.defaultsModels, "defaultsModels"));
  }

  // agents.defaults.modelPolicy.allow：只动 allow 键，保留 modelPolicy 上的其他键
  if (!payload.modelPolicyAllow.present) {
    const defaults = isRecord(config.agents) ? config.agents.defaults : undefined;
    const policy = isRecord(defaults) ? defaults.modelPolicy : undefined;
    if (isRecord(policy)) delete policy.allow;
  } else {
    const agents = ensureRecord(config as Record<string, unknown>, "agents");
    const defaults = ensureRecord(agents, "defaults");
    const policy = ensureRecord(defaults, "modelPolicy");
    policy.allow = structuredClone(assertSubtreeValue(payload.modelPolicyAllow, "modelPolicyAllow"));
  }

  // agents.defaults.model：整体替换（含 fallbacks 与未知键），不走 writePrimaryModelRef 的形状守恒
  if (!payload.primaryModel.present) {
    const defaults = isRecord(config.agents) ? config.agents.defaults : undefined;
    if (isRecord(defaults)) delete defaults.model;
  } else {
    const agents = ensureRecord(config as Record<string, unknown>, "agents");
    const defaults = ensureRecord(agents, "defaults");
    defaults.model = structuredClone(assertSubtreeValue(payload.primaryModel, "primaryModel"));
  }

  // §6.3：仅显式列出的插件、仅 false→true；enabledByDefault（无条目）不创建，已 enabled 不动
  const enablePluginIds = new Set(options.enablePluginIds ?? []);
  if (enablePluginIds.size > 0) {
    const plugins = (config as Record<string, unknown>).plugins;
    const entries = isRecord(plugins) ? plugins.entries : undefined;
    if (isRecord(entries)) {
      for (const pluginId of enablePluginIds) {
        const entry = entries[pluginId];
        if (isRecord(entry) && entry.enabled === false) {
          entry.enabled = true;
        }
      }
    }
  }

  return config;
}

/** 构造「应用 payload 后」的对端 config（纯内存，不落盘）；无 payload 时返回对端现状的深拷贝 */
export function projectSyncTarget(config: OpenClawConfig, payload?: SyncPayload): OpenClawConfig {
  const projected = structuredClone(config);
  return payload ? applySyncPayload(projected, payload) : projected;
}

/**
 * 提取 payload 引用的、自身 models.providers 无法提供的 provider id（大小写折叠去重）。
 * 来源：agents.defaults.models 键、modelPolicy.allow 的 exact/wildcard 条目、主模型与 fallbacks。
 * 剩下的这些 ref 需要插件（或对端既有 config）提供，是 §6.1 校验的对象。
 */
export function collectSyncRefs(payload: SyncPayload): string[] {
  const configProviderIds = new Set(
    Object.keys(payload.providers.present ? payload.providers.value ?? {} : {}).map(normalizeProviderId)
  );
  const firstSeen = new Map<string, string>();
  const addRef = (ref: unknown): void => {
    if (typeof ref !== "string") return;
    const slashIndex = ref.indexOf("/");
    if (slashIndex <= 0) return;
    const providerId = ref.slice(0, slashIndex);
    const normalized = normalizeProviderId(providerId);
    if (configProviderIds.has(normalized) || firstSeen.has(normalized)) return;
    firstSeen.set(normalized, providerId);
  };

  if (payload.defaultsModels.present) {
    for (const ref of Object.keys(payload.defaultsModels.value ?? {})) addRef(ref);
  }
  if (payload.modelPolicyAllow.present) {
    // exact 与 wildcard（provider/*）条目的 provider 段取法相同
    for (const entry of payload.modelPolicyAllow.value ?? []) addRef(entry);
  }
  if (payload.primaryModel.present) {
    const value = payload.primaryModel.value;
    if (typeof value === "string") {
      addRef(value);
    } else if (isRecord(value)) {
      addRef(value.primary);
      if (Array.isArray(value.fallbacks)) {
        for (const ref of value.fallbacks) addRef(ref);
      }
    }
  }

  return [...firstSeen.values()].sort((a, b) => a.localeCompare(b));
}

export type SyncProviderRefStatus = "config" | "plugin-enabled" | "plugin-disabled" | "not-installed";

export interface SyncProviderRefReport {
  providerId: string;
  status: SyncProviderRefStatus;
  pluginId?: string;
}

/** 判定每个被引用 provider 在对端的来源；config 优先于插件（沿用冲突规则，大小写折叠） */
export function classifySyncProviderRefs(
  config: OpenClawConfig,
  providerIds: string[],
  pluginProviders: PluginProvider[]
): SyncProviderRefReport[] {
  const configIds = new Set(Object.keys(config.models?.providers ?? {}).map(normalizeProviderId));
  const visiblePlugins = new Map(
    filterPluginProvidersConflictWithConfig(config, pluginProviders).map((plugin) => [
      normalizeProviderId(plugin.providerId),
      plugin
    ])
  );
  return providerIds.map((providerId) => {
    const normalized = normalizeProviderId(providerId);
    if (configIds.has(normalized)) return { providerId, status: "config" };
    const plugin = visiblePlugins.get(normalized);
    if (!plugin) return { providerId, status: "not-installed" };
    return {
      providerId,
      status: plugin.enabled ? "plugin-enabled" : "plugin-disabled",
      pluginId: plugin.pluginId
    };
  });
}

/** 同步专项校验报告；只含变量名与 ref，绝不含密钥值 */
export interface SyncCheckReport {
  refs: SyncProviderRefReport[];
  /** 对端 .env 缺失的变量名（存在性判断，不含值） */
  missingEnvVars: string[];
  configStatus: {
    issueCount: number;
    blockingIssueCount: number;
    warningIssueCount: number;
    unknownProviderRefs: string[];
  };
  pluginDiagnostics: string[];
}

export interface BuildSyncCheckReportInput {
  /** 对端当前 config */
  config: OpenClawConfig;
  /** 有则在「应用 payload 后」的投影上校验；无则校验对端现状 */
  payload?: SyncPayload;
  /** 对端 .env 全文（仅用于存在性判断） */
  envContent: string;
  pluginProviders: PluginProvider[];
  pluginDiagnostics?: string[];
  /** 调用方对 projectSyncTarget(config, payload) 计算出的 config-status 报告 */
  configStatus: ConfigStatusReport;
}

export function buildSyncCheckReport(input: BuildSyncCheckReportInput): SyncCheckReport {
  const payload = input.payload ?? buildSyncPayload(input.config);
  const projected = projectSyncTarget(input.config, input.payload);
  const refs = classifySyncProviderRefs(projected, collectSyncRefs(payload), input.pluginProviders);

  // env 校验：config provider 的 apiKey SecretRef ∪ 被引用插件 manifest 声明的主 API Key 变量
  const envVars = new Set(listProviderEnvRefs(projected).map((ref) => ref.envVar));
  for (const ref of refs) {
    if (ref.status !== "plugin-enabled" && ref.status !== "plugin-disabled") continue;
    const plugin = input.pluginProviders.find(
      (candidate) =>
        candidate.pluginId === ref.pluginId &&
        normalizeProviderId(candidate.providerId) === normalizeProviderId(ref.providerId)
    );
    const primaryEnvVar = plugin?.apiKeyEnvVars[0];
    if (primaryEnvVar) envVars.add(primaryEnvVar);
  }
  const missingEnvVars = [...envVars]
    .filter((envVar) => readEnvValue(input.envContent, envVar) === undefined)
    .sort();

  return {
    refs,
    missingEnvVars,
    configStatus: {
      issueCount: input.configStatus.summary.issueCount,
      blockingIssueCount: input.configStatus.summary.blockingIssueCount,
      warningIssueCount: input.configStatus.summary.warningIssueCount,
      unknownProviderRefs: [...input.configStatus.modelPolicy.unknownProviderRefs]
    },
    pluginDiagnostics: [...(input.pluginDiagnostics ?? [])]
  };
}
