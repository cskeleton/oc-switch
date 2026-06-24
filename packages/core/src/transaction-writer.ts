import JSON5 from "json5";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBackup } from "./backup-manager";
import { assertAllowedSemanticChange } from "./diff-guard";
import { updateManagedEnv } from "./env-manager";
import { withFileLock } from "./lock";
import { markProviderEnvOrphan, upsertProviderEnvManifest, type ManifestProviderMetadata } from "./manifest-manager";
import type { OpenClawConfig } from "./types";

export type ManifestUpdate =
  | { type: "upsert-provider-env"; providerId: string; envVar: string; metadata?: ManifestProviderMetadata }
  | { type: "mark-provider-orphan"; providerId: string; envVar: string };

export interface TransactionInput {
  openclawPath: string;
  envPath: string;
  stateDir: string;
  reason: string;
  envUpdates?: Record<string, string>;
  manifestUpdates?: ManifestUpdate[];
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

function applyManifestUpdates(stateDir: string, updates: ManifestUpdate[] | undefined): void {
  for (const update of updates ?? []) {
    if (update.type === "upsert-provider-env") {
      upsertProviderEnvManifest(stateDir, update.providerId, update.envVar, new Date().toISOString(), update.metadata ?? {});
    } else {
      markProviderEnvOrphan(stateDir, update.providerId, update.envVar);
    }
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
      applyManifestUpdates(input.stateDir, input.manifestUpdates);
    } catch (error) {
      restoreFromBackup(backupDir, input.openclawPath, input.envPath);
      rmSync(configTmp, { force: true });
      rmSync(envTmp, { force: true });
      throw error;
    }

    return { backupDir };
  });
}

export interface EnvTransactionInput {
  openclawPath: string;
  envPath: string;
  stateDir: string;
  reason: string;
  pathSources?: { openclawPath?: string; envPath?: string };
  mutateEnv(content: string): string;
  afterWrite?: () => void;
}

export async function writeEnvTransaction(input: EnvTransactionInput): Promise<TransactionResult> {
  return withFileLock(join(input.stateDir, "write.lock"), async () => {
    const beforeRaw = readFileSync(input.openclawPath, "utf8");
    const beforeHash = sha256(beforeRaw);
    const beforeEnv = existsSync(input.envPath) ? readFileSync(input.envPath, "utf8") : "";
    const afterEnv = input.mutateEnv(beforeEnv);

    const backupDir = createBackup({
      stateDir: input.stateDir,
      openclawPath: input.openclawPath,
      envPath: input.envPath,
      reason: input.reason,
      beforeHash,
      ...(input.pathSources ? { pathSources: input.pathSources } : {})
    });

    mkdirSync(dirname(input.envPath), { recursive: true });
    const envTmp = `${input.envPath}.tmp`;
    try {
      writeFileSync(envTmp, afterEnv, { mode: 0o600 });
      renameSync(envTmp, input.envPath);
      input.afterWrite?.();
    } catch (error) {
      restoreFromBackup(backupDir, input.openclawPath, input.envPath);
      rmSync(envTmp, { force: true });
      throw error;
    }

    return { backupDir };
  });
}
