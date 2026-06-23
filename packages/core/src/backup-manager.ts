import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export const DEFAULT_BACKUP_RETENTION = 20;

export interface BackupMetadata {
  reason: string;
  openclawPath: string;
  envPath: string;
  beforeHash: string;
  sourceFiles: string[];
  createdAt: string;
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
}

export function createBackup(input: BackupInput): string {
  const createdAt = new Date().toISOString();
  const timestamp = `${createdAt.replace(/[:.]/g, "-")}-${process.hrtime.bigint()}`;
  const backupDir = join(input.stateDir, "backups", timestamp);
  mkdirSync(backupDir, { recursive: true });
  copyFileSync(input.openclawPath, join(backupDir, "openclaw.json"));
  if (existsSync(input.envPath)) copyFileSync(input.envPath, join(backupDir, ".env"));
  writeFileSync(join(backupDir, "metadata.json"), `${JSON.stringify({
    reason: input.reason,
    openclawPath: input.openclawPath,
    envPath: input.envPath,
    beforeHash: input.beforeHash,
    sourceFiles: [basename(input.openclawPath), basename(input.envPath)],
    createdAt
  }, null, 2)}\n`);
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
  copyFileSync(join(input.backupDir, "openclaw.json"), input.openclawPath);
  const backupEnv = join(input.backupDir, ".env");
  if (existsSync(backupEnv)) {
    copyFileSync(backupEnv, input.envPath);
  } else {
    rmSync(input.envPath, { force: true });
  }
}

export interface SafeRestoreBackupInput extends RestoreBackupInput {
  stateDir: string;
}

export interface SafeRestoreBackupResult {
  safetyBackupDir: string;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function restoreBackupSafely(input: SafeRestoreBackupInput): SafeRestoreBackupResult {
  const targetId = basename(input.backupDir);
  const safetyBackupDir = createBackup({
    stateDir: input.stateDir,
    openclawPath: input.openclawPath,
    envPath: input.envPath,
    reason: `before restore ${targetId}`,
    beforeHash: fileSha256(input.openclawPath),
    protectedBackupDirs: [input.backupDir]
  });
  restoreBackup(input);
  return { safetyBackupDir };
}
