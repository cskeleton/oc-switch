import { accessSync, constants, existsSync } from "node:fs";
import type { ConfigHealthReport } from "./config-health";
import { inspectConfigHealth } from "./config-health";
import { inspectEnvFile, listProviderEnvRefs } from "./env-inspector";
import { inspectProviderSecretRefMigrations } from "./openclaw-compat";
import { listOrphanEnvKeys, readManifest } from "./manifest-manager";
import { normalizeProviderId, parseModelRef } from "./model-ref";
import {
  getModelPolicyMode,
  getModelSelectionSource,
  isPolicyAllowsRef,
  readModelPolicyAllow,
  readModelPolicyAllowRaw
} from "./model-policy";
import type { OcSwitchPaths } from "./paths";
import { filterPluginProvidersConflictWithConfig, type PluginProvider } from "./plugin-catalog";
import { readProviderStates } from "./provider-states";
import type { LegacyRunningOpenClawInstance } from "./runtime-discovery-types";
import type { ModelPolicyMode, OpenClawConfig } from "./types";

/** 去重后的单条可行动问题 */
export interface ConfigStatusIssue {
  /** 去重 key，格式 `${source}:${kind}:${subject}`，subject 中冒号编码为 %3A */
  id: string;
  severity: "info" | "warning" | "blocking";
  source: "health" | "env" | "paths" | "providers";
  title: string;
  detail?: string;
  /** 建议操作描述（CLI 命令、Settings 入口等），非机器可执行字段 */
  action?: string;
}

/** disabled provider 摘要（不含 allowlist 快照） */
export interface DisabledProviderStatus {
  providerId: string;
  disabledAt: string;
  openclawPath: string;
  /** 禁用时隐藏的 allowlist 条目数 */
  hiddenModelCount: number;
}

/** modelPolicy 的脱敏原始事实；不展开通配条目，也不返回凭据。 */
export interface ConfigStatusModelPolicy {
  mode: ModelPolicyMode;
  policyEntryCount: number;
  effectiveCatalogCount: number;
  unknownProviderRefs: string[];
  policyOnlyExactRefs: string[];
  knownProviderUnknownModelRefs: string[];
}

export interface ConfigStatusReport {
  version: 1;
  /** raw facts：完整 case-duplicate 健康报告 */
  health: ConfigHealthReport;
  /** raw facts：当前禁用的 provider 摘要列表 */
  disabledProviders: DisabledProviderStatus[];
  /** raw facts：manifest 中标记为 orphan 的 env key 名（无值） */
  orphanEnvKeys: string[];
  /** raw facts：inspectEnvFile 产生的警告字符串列表 */
  envWarnings: string[];
  /** raw facts：modelPolicy 的模式、有效目录计数与精确 ref 漂移 */
  modelPolicy: ConfigStatusModelPolicy;
  /** 唯一去重后的行动列表 */
  issues: ConfigStatusIssue[];
  summary: {
    issueCount: number;
    blockingIssueCount: number;
    warningIssueCount: number;
    duplicateGroupCount: number;
    disabledProviderCount: number;
    orphanEnvKeyCount: number;
  };
}

export interface InspectConfigStatusInput {
  /** best-effort 读取到的配置；读取失败时省略 */
  config?: OpenClawConfig;
  /** openclaw.json 存在但解析失败或读取失败时的简短错误文案 */
  configReadError?: string;
  paths: OcSwitchPaths;
  envContent: string;
  runningInstances?: LegacyRunningOpenClawInstance[];
  /** OpenClaw 插件 manifest 提供的 provider 目录；用于避免把插件 ref 误报为 unknown provider */
  pluginProviders?: PluginProvider[];
}

function emptyConfigHealthReport(): ConfigHealthReport {
  return {
    caseDuplicateGroups: [],
    summary: { duplicateGroupCount: 0, affectedProviderCount: 0, affectedAllowlistCount: 0 }
  };
}

function issueId(source: ConfigStatusIssue["source"], kind: string, subject: string): string {
  return `${source}:${kind}:${encodeURIComponent(subject)}`;
}

function canRead(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function canWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function buildPathIssues(
  paths: OcSwitchPaths,
  configReadError?: string
): ConfigStatusIssue[] {
  const issues: ConfigStatusIssue[] = [];

  const openclawExists = existsSync(paths.openclawPath);
  if (!openclawExists) {
    issues.push({
      id: issueId("paths", "missing", "openclaw"),
      severity: "blocking",
      source: "paths",
      title: "openclaw.json 不存在",
      detail: `活动配置路径不存在：${paths.openclawPath}`,
      action: "在 Settings 中切换或创建 openclaw.json"
    });
  } else {
    const readable = canRead(paths.openclawPath);
    if (!readable) {
      issues.push({
        id: issueId("paths", "unreadable", "openclaw"),
        severity: "blocking",
        source: "paths",
        title: "openclaw.json 不可读",
        detail: `活动配置路径不可读：${paths.openclawPath}`,
        action: "检查文件权限"
      });
    } else if (configReadError) {
      issues.push({
        id: issueId("paths", "invalid", "openclaw"),
        severity: "blocking",
        source: "paths",
        title: "openclaw.json 解析失败",
        detail: configReadError,
        action: "修复 JSON/JSON5 语法或从备份恢复"
      });
    } else if (!canWrite(paths.openclawPath)) {
      issues.push({
        id: issueId("paths", "unwritable", "openclaw"),
        severity: "warning",
        source: "paths",
        title: "openclaw.json 不可写",
        detail: `活动配置路径不可写：${paths.openclawPath}`,
        action: "检查文件权限"
      });
    }
  }

  const envExists = existsSync(paths.envPath);
  if (!envExists) {
    issues.push({
      id: issueId("paths", "missing", "env"),
      severity: "warning",
      source: "paths",
      title: ".env 不存在",
      detail: `活动 env 路径不存在：${paths.envPath}`,
      action: "在 Settings 中切换 env 路径或创建 .env"
    });
  } else {
    if (!canRead(paths.envPath)) {
      issues.push({
        id: issueId("paths", "unreadable", "env"),
        severity: "blocking",
        source: "paths",
        title: ".env 不可读",
        detail: `活动 env 路径不可读：${paths.envPath}`,
        action: "检查文件权限"
      });
    } else if (!canWrite(paths.envPath)) {
      issues.push({
        id: issueId("paths", "unwritable", "env"),
        severity: "warning",
        source: "paths",
        title: ".env 不可写",
        detail: `活动 env 路径不可写：${paths.envPath}`,
        action: "检查文件权限"
      });
    }
  }

  return issues;
}

function buildHealthIssues(health: ConfigHealthReport): ConfigStatusIssue[] {
  return health.caseDuplicateGroups.map((group) => {
    const flag = group.mergeable ? "可合并" : "需人工核对";
    return {
      id: issueId("health", "duplicate", group.groupKey),
      severity: "warning" as const,
      source: "health" as const,
      title: `Provider 大小写重复：${group.ids.join(" / ")}`,
      detail: `${group.confidence} 置信度，${flag}`,
      action: group.mergeable
        ? `oc-switch providers merge-duplicates --group ${group.groupKey} --keep ${group.canonicalId} --remove ${group.duplicateIds.join(",")}`
        : "在 Providers 页人工核对后合并"
    };
  });
}

function isEnvRefObject(input: unknown): boolean {
  return typeof input === "object" && input !== null && (input as { source?: string }).source === "env";
}

function buildCompatibilityIssues(config: OpenClawConfig): ConfigStatusIssue[] {
  const issues: ConfigStatusIssue[] = [];

  for (const candidate of inspectProviderSecretRefMigrations(config)) {
    issues.push({
      id: issueId("health", "secret-ref-migration", candidate.providerId),
      severity: "warning",
      source: "health",
      title: `Provider ${candidate.providerId} 的 apiKey 可迁移为 canonical SecretRef`,
      detail: `${candidate.envVar} 当前使用旧环境变量引用格式`,
      action: "在 Providers 页查看并确认迁移"
    });
  }

  for (const [providerId, provider] of Object.entries(config.models?.providers ?? {})) {
    if (isEnvRefObject(provider.authHeader)) {
      issues.push({
        id: issueId("health", "invalid-auth-header-ref", providerId),
        severity: "blocking",
        source: "health",
        title: `Provider ${providerId} 的 authHeader 错写为密钥引用，与 OpenClaw 2026.6.8 不兼容`,
        detail: "authHeader 应为 boolean；密钥应写在 apiKey",
        action: "oc-switch health repair"
      });
    }

    for (const model of provider.models ?? []) {
      if (!model.name?.trim()) {
        const subject = `${providerId}/${model.id}`;
        issues.push({
          id: issueId("health", "missing-model-name", subject),
          severity: "blocking",
          source: "health",
          title: `模型 ${subject} 缺少 OpenClaw 2026.6.8 必填 name`,
          action: "oc-switch health repair"
        });
      }
    }
  }

  return issues;
}

function buildEnvIssues(
  envInspection: ReturnType<typeof inspectEnvFile>,
  orphanEnvKeys: string[]
): ConfigStatusIssue[] {
  const issues: ConfigStatusIssue[] = [];
  const missingVars = new Set<string>();

  for (const variable of envInspection.variables) {
    if (variable.missing) {
      missingVars.add(variable.envVar);
      issues.push({
        id: issueId("env", "missing", variable.envVar),
        severity: "warning",
        source: "env",
        title: `缺失 env 变量：${variable.envVar}`,
        ...(variable.providerIds.length
          ? { detail: `Provider ${variable.providerIds.join(", ")} 引用但未在 .env 中定义` }
          : {}),
        action: "在 Settings 环境变量页添加密钥"
      });
    }
    if (variable.duplicate) {
      issues.push({
        id: issueId("env", "duplicate", variable.envVar),
        severity: "warning",
        source: "env",
        title: `重复 env 变量：${variable.envVar}`,
        detail: "同一变量在 .env 中出现多次",
        action: "合并重复行后重试"
      });
    }
    if (variable.complex) {
      issues.push({
        id: issueId("env", "complex", variable.envVar),
        severity: "info",
        source: "env",
        title: `复杂 env 值：${variable.envVar}`,
        detail: "值为复杂表达式，迁移前需确认",
        action: "在 Settings 环境变量页确认后操作"
      });
    }
  }

  for (const envVar of orphanEnvKeys) {
    if (missingVars.has(envVar)) continue;
    issues.push({
      id: issueId("env", "orphan", envVar),
      severity: "info",
      source: "env",
      title: `孤立 env 变量：${envVar}`,
      detail: "对应 Provider 已删除，密钥仍保留在 .env",
      action: "在 Settings 清理孤立密钥"
    });
  }

  return issues;
}

function buildDisabledProviderIssues(disabledProviders: DisabledProviderStatus[]): ConfigStatusIssue[] {
  return disabledProviders.map((provider) => ({
    id: issueId("providers", "disabled", provider.providerId),
    severity: "info" as const,
    source: "providers" as const,
    title: `Provider 已禁用：${provider.providerId}`,
    detail: `隐藏 ${provider.hiddenModelCount} 个 allowlist 条目`,
    action: "在 Providers 页恢复 Provider"
  }));
}

function emptyModelPolicyStatus(): ConfigStatusModelPolicy {
  return {
    mode: "legacy",
    policyEntryCount: 0,
    effectiveCatalogCount: 0,
    unknownProviderRefs: [],
    policyOnlyExactRefs: [],
    knownProviderUnknownModelRefs: []
  };
}

/** 仅保留合法的字符串 exact ModelRef，且按 policy 原顺序去重。 */
function listPolicyExactRefs(config: OpenClawConfig): Array<{ ref: string; providerId: string; modelId: string }> {
  const seen = new Set<string>();
  const exactRefs: Array<{ ref: string; providerId: string; modelId: string }> = [];
  for (const entry of readModelPolicyAllow(config) ?? []) {
    if (entry.endsWith("/*") || seen.has(entry)) continue;
    try {
      const { providerId, modelId } = parseModelRef(entry);
      seen.add(entry);
      exactRefs.push({ ref: entry, providerId, modelId });
    } catch {
      // 非法字符串不是 ModelRef，不进入 exact-ref 诊断列表。
    }
  }
  return exactRefs;
}

function buildModelPolicyStatus(
  config: OpenClawConfig,
  disabledProviders: DisabledProviderStatus[],
  pluginProviders: PluginProvider[] = []
): ConfigStatusModelPolicy {
  const rawAllow = readModelPolicyAllowRaw(config);
  const providers = config.models?.providers ?? {};
  const providersByNormalizedId = new Map<string, Array<{ id: string; modelIds: Set<string> }>>();
  for (const [id, provider] of Object.entries(providers)) {
    const normalizedId = normalizeProviderId(id);
    const catalogProviders = providersByNormalizedId.get(normalizedId) ?? [];
    catalogProviders.push({ id, modelIds: new Set((provider.models ?? []).map((model) => model.id)) });
    providersByNormalizedId.set(normalizedId, catalogProviders);
  }
  // 插件 provider（OpenClaw 插件 manifest 目录）同样是合法 ref 来源
  const pluginProvidersByNormalizedId = new Map<string, PluginProvider>();
  for (const plugin of filterPluginProvidersConflictWithConfig(config, pluginProviders)) {
    if (!pluginProvidersByNormalizedId.has(normalizeProviderId(plugin.providerId))) {
      pluginProvidersByNormalizedId.set(normalizeProviderId(plugin.providerId), plugin);
    }
  }

  const disabledProviderIds = new Set(disabledProviders.map((provider) => normalizeProviderId(provider.providerId)));
  let effectiveCatalogCount = Object.entries(providers).reduce(
    (count, [providerId, provider]) => {
      if (disabledProviderIds.has(normalizeProviderId(providerId))) return count;
      return count + (provider.models ?? []).filter((model) =>
        getModelSelectionSource(config, `${providerId}/${model.id}`) !== undefined
      ).length;
    },
    0
  );
  for (const plugin of pluginProvidersByNormalizedId.values()) {
    if (!plugin.enabled) continue;
    effectiveCatalogCount += plugin.models.filter(
      (model) => getModelSelectionSource(config, `${plugin.providerId}/${model.id}`) !== undefined
    ).length;
  }

  const exactRefs = listPolicyExactRefs(config);
  const legacyRefs = Object.keys(config.agents?.defaults?.models ?? {});
  const unknownProviderRefs: string[] = [];
  const policyOnlyExactRefs: string[] = [];
  const knownProviderUnknownModelRefs: string[] = [];
  for (const exact of exactRefs) {
    const catalogProviders = providersByNormalizedId.get(normalizeProviderId(exact.providerId));
    const pluginProvider = pluginProvidersByNormalizedId.get(normalizeProviderId(exact.providerId));
    if (!catalogProviders && !pluginProvider) unknownProviderRefs.push(exact.ref);

    // exact policy 与 metadata 的同一模型判断沿用 Core policy helper 的大小写语义。
    const isPolicyOnly = !legacyRefs.some((legacyRef) => isPolicyAllowsRef([exact.ref], legacyRef));
    if (!isPolicyOnly) continue;
    policyOnlyExactRefs.push(exact.ref);
    if (catalogProviders && !catalogProviders.some((provider) => provider.modelIds.has(exact.modelId))) {
      knownProviderUnknownModelRefs.push(exact.ref);
    } else if (!catalogProviders && pluginProvider && !pluginProvider.models.some((model) => model.id === exact.modelId)) {
      // 插件 provider 存在但模型不在其 manifest catalog 中，同样属于 drift
      knownProviderUnknownModelRefs.push(exact.ref);
    }
  }

  return {
    mode: getModelPolicyMode(config),
    policyEntryCount: rawAllow?.length ?? 0,
    effectiveCatalogCount,
    unknownProviderRefs,
    policyOnlyExactRefs,
    knownProviderUnknownModelRefs
  };
}

/**
 * modelPolicy.allow 分叉检测：OpenClaw 2026.8+ 中非空 modelPolicy.allow 是实际生效的 allowlist；
 * agents.defaults.models 有但 policy 未覆盖（含通配）的 ref 在 OpenClaw 里选不到。
 * 反向（policy 引用 builtin catalog 模型）属合法，不报。
 */
function buildModelPolicyIssues(config: OpenClawConfig): ConfigStatusIssue[] {
  const issues: ConfigStatusIssue[] = [];
  const rawAllow = readModelPolicyAllowRaw(config);
  const policy = config.agents?.defaults?.modelPolicy as { allow?: unknown } | undefined;
  if (policy && Object.prototype.hasOwnProperty.call(policy, "allow") && rawAllow === undefined) {
    issues.push({
      id: issueId("health", "invalid-model-policy-allow", "modelPolicy.allow"),
      severity: "blocking",
      source: "health",
      title: "modelPolicy.allow 不是数组",
      detail: "modelPolicy.allow 不是数组，已按 legacy 解释且未参与 selection",
      action: "将 modelPolicy.allow 修正为数组，或删除该字段以保留 legacy 行为"
    });
  }
  if (rawAllow) {
    rawAllow.forEach((entry, index) => {
      if (typeof entry === "string") return;
      issues.push({
        id: `health:invalid-model-policy-entry:modelPolicy.allow[${index}]`,
        severity: "blocking",
        source: "health",
        title: `modelPolicy.allow[${index}] 不是字符串`,
        detail: `modelPolicy.allow[${index}] 为非字符串，未参与匹配`,
        action: "删除该条目，或改为字符串 exact/wildcard ModelRef"
      });
    });
  }

  if (getModelPolicyMode(config) !== "restricted") return issues;

  const allow = readModelPolicyAllow(config) ?? [];
  const uncovered = Object.keys(config.agents?.defaults?.models ?? {}).filter(
    (ref) => !isPolicyAllowsRef(allow, ref)
  );
  if (uncovered.length === 0) return issues;

  const preview = uncovered.slice(0, 5).join(", ");
  issues.push({
    id: issueId("health", "model-policy-not-covered", "modelPolicy.allow"),
    severity: "warning",
    source: "health",
    title: `${uncovered.length} 个 legacy metadata 模型未被 modelPolicy.allow 覆盖`,
    detail: `restricted mode 下 agents.defaults.models 仅为 metadata，不参与 selection；这些 ref 实际选不到：${preview}${uncovered.length > 5 ? " 等" : ""}`,
    action: "将缺失 ref 加入或调整 agents.defaults.modelPolicy.allow，或从 metadata 移除不再需要的条目"
  });
  return issues;
}

function deriveSummary(issues: ConfigStatusIssue[], health: ConfigHealthReport, disabledProviders: DisabledProviderStatus[], orphanEnvKeys: string[]) {
  return {
    issueCount: issues.length,
    blockingIssueCount: issues.filter((i) => i.severity === "blocking").length,
    warningIssueCount: issues.filter((i) => i.severity === "warning").length,
    duplicateGroupCount: health.summary.duplicateGroupCount,
    disabledProviderCount: disabledProviders.length,
    orphanEnvKeyCount: orphanEnvKeys.length
  };
}

/** 聚合配置状态为统一报告 */
export function inspectConfigStatus(input: InspectConfigStatusInput): ConfigStatusReport {
  const health = input.config ? inspectConfigHealth(input.config) : emptyConfigHealthReport();

  const providerStates = readProviderStates(input.paths.stateDir);
  const disabledProviders: DisabledProviderStatus[] = Object.values(providerStates.disabledProviders).map((state) => ({
    providerId: state.providerId,
    disabledAt: state.disabledAt,
    openclawPath: state.openclawPath,
    hiddenModelCount: Object.keys(state.allowlistEntries).length
  }));
  const modelPolicy = input.config
    ? buildModelPolicyStatus(input.config, disabledProviders, input.pluginProviders)
    : emptyModelPolicyStatus();

  const orphanEnvKeys = listOrphanEnvKeys(input.paths.stateDir);

  const envInspection = inspectEnvFile({
    content: input.envContent,
    providerRefs: input.config ? listProviderEnvRefs(input.config) : [],
    manifest: readManifest(input.paths.stateDir)
  });

  const issueMap = new Map<string, ConfigStatusIssue>();
  for (const issue of [
    ...buildPathIssues(input.paths, input.configReadError),
    ...buildHealthIssues(health),
    ...(input.config ? buildCompatibilityIssues(input.config) : []),
    ...(input.config ? buildModelPolicyIssues(input.config) : []),
    ...buildEnvIssues(envInspection, orphanEnvKeys),
    ...buildDisabledProviderIssues(disabledProviders)
  ]) {
    issueMap.set(issue.id, issue);
  }
  const issues = [...issueMap.values()];

  return {
    version: 1,
    health,
    disabledProviders,
    orphanEnvKeys,
    envWarnings: envInspection.warnings,
    modelPolicy,
    issues,
    summary: deriveSummary(issues, health, disabledProviders, orphanEnvKeys)
  };
}
