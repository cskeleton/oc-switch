import JSON5 from "json5";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBackup } from "./backup-manager";
import { assertAllowedSemanticChange } from "./diff-guard";
import { updateManagedEnv } from "./env-manager";
import { withFileLock } from "./lock";
import type { OpenClawConfig } from "./types";

export interface TransactionInput {
  openclawPath: string;
  envPath: string;
  stateDir: string;
  reason: string;
  envUpdates?: Record<string, string>;
  mutate(config: OpenClawConfig): OpenClawConfig;
}

export interface TransactionResult {
  backupDir: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function restoreFromBackup(backupDir: string, openclawPath: string, envPath: string): void {
  copyFileSync(join(backupDir, "openclaw.json"), openclawPath);
  const backupEnv = join(backupDir, ".env");
  if (existsSync(backupEnv)) {
    copyFileSync(backupEnv, envPath);
  } else {
    rmSync(envPath, { force: true });
  }
}

export async function writeOpenClawTransaction(input: TransactionInput): Promise<TransactionResult> {
  return withFileLock(join(input.stateDir, "write.lock"), async () => {
    const beforeRaw = readFileSync(input.openclawPath, "utf8");
    const beforeConfig = JSON5.parse(beforeRaw) as OpenClawConfig;
    const beforeHash = sha256(beforeRaw);
    const beforeEnv = existsSync(input.envPath) ? readFileSync(input.envPath, "utf8") : "";

    const afterConfig = input.mutate(structuredClone(beforeConfig));
    assertAllowedSemanticChange(beforeConfig, afterConfig);
    const afterRaw = `${JSON.stringify(afterConfig, null, 2)}\n`;
    const hasEnvUpdates = Boolean(input.envUpdates && Object.keys(input.envUpdates).length);
    const afterEnv = hasEnvUpdates ? updateManagedEnv(beforeEnv, input.envUpdates!).content : beforeEnv;

    const backupDir = createBackup({
      stateDir: input.stateDir,
      openclawPath: input.openclawPath,
      envPath: input.envPath,
      reason: input.reason,
      beforeHash
    });

    mkdirSync(dirname(input.openclawPath), { recursive: true });
    mkdirSync(dirname(input.envPath), { recursive: true });
    const configTmp = `${input.openclawPath}.tmp`;
    const envTmp = `${input.envPath}.tmp`;
    try {
      writeFileSync(configTmp, afterRaw);
      if (hasEnvUpdates || existsSync(input.envPath)) {
        writeFileSync(envTmp, afterEnv);
        renameSync(envTmp, input.envPath);
      }
      renameSync(configTmp, input.openclawPath);
    } catch (error) {
      restoreFromBackup(backupDir, input.openclawPath, input.envPath);
      rmSync(configTmp, { force: true });
      rmSync(envTmp, { force: true });
      throw error;
    }

    return { backupDir };
  });
}
