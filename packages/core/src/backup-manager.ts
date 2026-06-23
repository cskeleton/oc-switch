import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export interface BackupInput {
  stateDir: string;
  openclawPath: string;
  envPath: string;
  reason: string;
  beforeHash: string;
}

export function createBackup(input: BackupInput): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
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
    createdAt: new Date().toISOString()
  }, null, 2)}\n`);
  return backupDir;
}
