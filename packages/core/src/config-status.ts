import { accessSync, constants, existsSync } from "node:fs";
import type { ConfigHealthReport } from "./config-health";
import { inspectConfigHealth } from "./config-health";
import { inspectEnvFile, listProviderEnvRefs } from "./env-inspector";
import { listOrphanEnvKeys, readManifest } from "./manifest-manager";
import type { OcSwitchPaths, RunningOpenClawInstance } from "./paths";
import { readProviderStates } from "./provider-states";
import type { OpenClawConfig } from "./types";

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
  runningInstances?: RunningOpenClawInstance[];
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

function isLegacyEnvObject(input: unknown): boolean {
  return isEnvRefObject(input) && (input as { provider?: unknown }).provider === undefined;
}

function buildCompatibilityIssues(config: OpenClawConfig): ConfigStatusIssue[] {
  const issues: ConfigStatusIssue[] = [];

  for (const [providerId, provider] of Object.entries(config.models?.providers ?? {})) {
    if (isLegacyEnvObject(provider.apiKey)) {
      issues.push({
        id: issueId("health", "legacy-env-ref", providerId),
        severity: "blocking",
        source: "health",
        title: `Provider ${providerId} 的 apiKey 使用旧版 EnvRef，与 OpenClaw 2026.6.8 不兼容`,
        detail: "应迁移为 \"${ENV_VAR}\" 字符串格式",
        action: "oc-switch health repair"
      });
    }

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
    issues,
    summary: deriveSummary(issues, health, disabledProviders, orphanEnvKeys)
  };
}
