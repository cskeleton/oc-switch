import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

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
