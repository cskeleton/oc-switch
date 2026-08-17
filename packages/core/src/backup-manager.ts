import { createHash } from "node:crypto";
import JSON5 from "json5";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  gatewayServiceEnvTargetErrorToSyncResult,
  isGatewayServiceEnvTargetError,
  syncManagedBlockToGatewayServiceEnv,
  type GatewayServiceEnvSyncResult
} from "./gateway-service-env-sync";
import {
  gatewayRuntimeTargetErrorToSyncResult,
  isGatewayRuntimeTargetError,
  resolveGatewayRuntimeTarget,
  type GatewayRuntimeTarget
} from "./gateway-runtime-target";
import { discoverOpenClawRuntime } from "./path-discovery";
import { normalizeConfigForStorage } from "./config-normalization";
import type { RuntimeDiscoveryProvider } from "./runtime-discovery-types";
import type { OpenClawConfig } from "./types";

export const DEFAULT_BACKUP_RETENTION = 20;

export interface BackupPathSources {
  openclawPath?: string;
  envPath?: string;
}

export interface BackupMetadata {
  reason: string;
  openclawPath: string;
  envPath: string;
  beforeHash: string;
  sourceFiles: string[];
  createdAt: string;
  pathSources?: BackupPathSources;
  /** 创建时尽力记录；恢复时不得直接信任 */
  runtimeInstanceId?: string;
  serviceEnvPath?: string;
}

export interface BackupSummary {
  id: string;
  path: string;
  metadata: BackupMetadata;
}

export interface BackupInput {
  stateDir: string;
  openclawPath: string;
  envPath: string;
  reason: string;
  beforeHash: string;
  retentionLimit?: number;
  protectedBackupDirs?: string[];
  pathSources?: BackupPathSources;
  runtimeInstanceId?: string;
  serviceEnvPath?: string;
}

function safeChmod(path: string, mode: number): void {
  try {
    chmodSync(path, mode);
  } catch {
    // 尽力收紧权限
  }
}

export function createBackup(input: BackupInput): string {
  const createdAt = new Date().toISOString();
  const timestamp = `${createdAt.replace(/[:.]/g, "-")}-${process.hrtime.bigint()}`;
  const backupDir = join(input.stateDir, "backups", timestamp);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  safeChmod(join(input.stateDir, "backups"), 0o700);
  safeChmod(backupDir, 0o700);
  copyFileSync(input.openclawPath, join(backupDir, "openclaw.json"));
  safeChmod(join(backupDir, "openclaw.json"), 0o600);
  if (existsSync(input.envPath)) {
    copyFileSync(input.envPath, join(backupDir, ".env"));
    safeChmod(join(backupDir, ".env"), 0o600);
  }
  writeFileSync(join(backupDir, "metadata.json"), `${JSON.stringify({
    reason: input.reason,
    openclawPath: input.openclawPath,
    envPath: input.envPath,
    ...(input.pathSources ? { pathSources: input.pathSources } : {}),
    ...(input.runtimeInstanceId ? { runtimeInstanceId: input.runtimeInstanceId } : {}),
    ...(input.serviceEnvPath ? { serviceEnvPath: input.serviceEnvPath } : {}),
    beforeHash: input.beforeHash,
    sourceFiles: [basename(input.openclawPath), basename(input.envPath)],
    createdAt
  }, null, 2)}\n`, { mode: 0o600 });
  safeChmod(join(backupDir, "metadata.json"), 0o600);
  pruneBackups(input.stateDir, input.retentionLimit ?? DEFAULT_BACKUP_RETENTION, input.protectedBackupDirs);
  return backupDir;
}

export function listBackups(stateDir: string): BackupSummary[] {
  const backupsDir = join(stateDir, "backups");
  if (!existsSync(backupsDir)) return [];

  const summaries: BackupSummary[] = [];
  for (const id of readdirSync(backupsDir)) {
    const path = join(backupsDir, id);
    const metadataPath = join(path, "metadata.json");
    if (!existsSync(metadataPath)) continue;
    try {
      const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as BackupMetadata;
      if (!metadata.createdAt) continue;
      summaries.push({ id, path, metadata });
    } catch {
      // 忽略无效的 metadata.json
    }
  }

  return summaries.sort((a, b) => {
    const timeCmp = b.metadata.createdAt.localeCompare(a.metadata.createdAt);
    return timeCmp !== 0 ? timeCmp : b.id.localeCompare(a.id);
  });
}

/** 读取备份 metadata，不读取备份内 openclaw.json 或 .env 内容 */
export function readBackupMetadata(backupDir: string): BackupMetadata {
  const metadataPath = join(backupDir, "metadata.json");
  if (!existsSync(metadataPath)) {
    throw new Error("backup metadata missing");
  }
  return JSON.parse(readFileSync(metadataPath, "utf8")) as BackupMetadata;
}

export function pruneBackups(
  stateDir: string,
  retentionLimit = DEFAULT_BACKUP_RETENTION,
  protectedBackupDirs: string[] = []
): void {
  if (retentionLimit < 1) return;
  const protectedPaths = new Set(protectedBackupDirs);
  const backups = listBackups(stateDir);
  let remaining = backups.length;
  for (const backup of [...backups].reverse()) {
    if (remaining <= retentionLimit) break;
    if (protectedPaths.has(backup.path)) continue;
    rmSync(backup.path, { recursive: true, force: true });
    remaining -= 1;
  }
}

export interface RestoreBackupInput {
  backupDir: string;
  openclawPath: string;
  envPath: string;
}

export function restoreBackup(input: RestoreBackupInput): void {
  const backupOpenClawPath = join(input.backupDir, "openclaw.json");
  const rawConfig = readFileSync(backupOpenClawPath, "utf8");
  const config = JSON5.parse(rawConfig) as OpenClawConfig;
  const normalized = normalizeConfigForStorage(config);
  if (normalized.changed) {
    writeFileSync(input.openclawPath, `${JSON.stringify(normalized.config, null, 2)}\n`);
  } else {
    copyFileSync(backupOpenClawPath, input.openclawPath);
  }
  const backupEnv = join(input.backupDir, ".env");
  if (existsSync(backupEnv)) {
    copyFileSync(backupEnv, input.envPath);
  } else {
    rmSync(input.envPath, { force: true });
  }
}

export interface SafeRestoreBackupInput extends RestoreBackupInput {
  stateDir: string;
  allowPathMismatch?: boolean;
  /** 注入 discovery；默认 discoverOpenClawRuntime */
  runtimeDiscoveryProvider?: RuntimeDiscoveryProvider;
}

export interface SafeRestoreBackupResult {
  safetyBackupDir: string;
  gatewayEnvSync?: GatewayServiceEnvSyncResult;
}

export interface BackupPathMismatch {
  backupOpenclawPath: string;
  backupEnvPath: string;
  currentOpenclawPath: string;
  currentEnvPath: string;
}

/** 读取备份 metadata 并校验与当前 active 路径是否一致 */
export function validateBackupPathMatch(input: {
  backupDir: string;
  openclawPath: string;
  envPath: string;
}): BackupPathMismatch | null {
  const metadata = readBackupMetadata(input.backupDir);
  if (metadata.openclawPath === input.openclawPath && metadata.envPath === input.envPath) {
    return null;
  }
  return {
    backupOpenclawPath: metadata.openclawPath,
    backupEnvPath: metadata.envPath,
    currentOpenclawPath: input.openclawPath,
    currentEnvPath: input.envPath
  };
}

export function formatBackupPathMismatchError(mismatch: BackupPathMismatch): string {
  return [
    "备份路径与当前 active 路径不一致，拒绝恢复。",
    `备份 openclaw: ${mismatch.backupOpenclawPath}`,
    `备份 env: ${mismatch.backupEnvPath}`,
    `当前 openclaw: ${mismatch.currentOpenclawPath}`,
    `当前 env: ${mismatch.currentEnvPath}`
  ].join("\n");
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function tryResolveAutomaticTarget(input: {
  openclawPath: string;
  envPath: string;
  discover: RuntimeDiscoveryProvider;
}): GatewayRuntimeTarget | undefined {
  try {
    return resolveGatewayRuntimeTarget({
      activePaths: { openclawPath: input.openclawPath, envPath: input.envPath },
      discovery: input.discover(),
      mode: "automatic"
    });
  } catch {
    return undefined;
  }
}

function syncAfterRestore(input: {
  openclawPath: string;
  envPath: string;
  discover: RuntimeDiscoveryProvider;
}): GatewayServiceEnvSyncResult {
  try {
    // 按当前 discovery 重新匹配；不信任备份 metadata 中的旧 serviceEnvPath
    const target = resolveGatewayRuntimeTarget({
      activePaths: { openclawPath: input.openclawPath, envPath: input.envPath },
      discovery: input.discover(),
      mode: "automatic"
    });
    return syncManagedBlockToGatewayServiceEnv({
      envPath: input.envPath,
      target: target.serviceEnvTarget
    });
  } catch (error) {
    if (isGatewayRuntimeTargetError(error)) {
      // 恢复文件已成功；无法关联时跳过 sync
      return gatewayRuntimeTargetErrorToSyncResult(error);
    }
    if (isGatewayServiceEnvTargetError(error)) {
      // 关联后目标不可写（如 parent 缺失）仍不撤销已恢复的文件
      return gatewayServiceEnvTargetErrorToSyncResult(error);
    }
    throw error;
  }
}

export function restoreBackupSafely(input: SafeRestoreBackupInput): SafeRestoreBackupResult {
  if (!input.allowPathMismatch) {
    const mismatch = validateBackupPathMatch(input);
    if (mismatch) throw new Error(formatBackupPathMismatchError(mismatch));
  }
  const discover = input.runtimeDiscoveryProvider ?? discoverOpenClawRuntime;
  const targetId = basename(input.backupDir);
  const currentAssociation = tryResolveAutomaticTarget({
    openclawPath: input.openclawPath,
    envPath: input.envPath,
    discover
  });
  const safetyBackupDir = createBackup({
    stateDir: input.stateDir,
    openclawPath: input.openclawPath,
    envPath: input.envPath,
    reason: `before restore ${targetId}`,
    beforeHash: fileSha256(input.openclawPath),
    protectedBackupDirs: [input.backupDir],
    ...(currentAssociation
      ? {
          runtimeInstanceId: currentAssociation.instanceId,
          serviceEnvPath: currentAssociation.serviceEnvTarget.targetPath
        }
      : {})
  });
  restoreBackup(input);
  const gatewayEnvSync = syncAfterRestore({
    openclawPath: input.openclawPath,
    envPath: input.envPath,
    discover
  });
  return { safetyBackupDir, gatewayEnvSync };
}
