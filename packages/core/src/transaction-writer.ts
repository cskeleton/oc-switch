import JSON5 from "json5";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createBackup } from "./backup-manager";
import { assertAllowedSemanticChange } from "./diff-guard";
import { applyEnvUpdates, type EnvUpdateOptions } from "./env-updates";
import { listProviderEnvRefs } from "./env-inspector";
import { readManifest } from "./manifest-manager";
import { withFileLock } from "./lock";
import { markProviderEnvOrphan, upsertProviderEnvManifest, type ManifestProviderMetadata } from "./manifest-manager";
import { verifyEnvWrite, type EnvWriteVerification } from "./env-verification";
import {
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
import type { RuntimeDiscoveryProvider } from "./runtime-discovery-types";
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
  envUpdateOptions?: EnvUpdateOptions;
  /** delete/rename 时从 gateway service env 删除的旧 Key */
  envRemovedKeys?: string[];
  manifestUpdates?: ManifestUpdate[];
  mutate(config: OpenClawConfig): OpenClawConfig;
  /** openclaw.json 写入成功后、写锁释放前的钩子，失败时事务回滚 */
  afterWrite?: () => void;
  /** 注入 discovery；默认 discoverOpenClawRuntime */
  runtimeDiscoveryProvider?: RuntimeDiscoveryProvider;
}

export interface TransactionResult {
  backupDir: string;
  envWrite?: EnvWriteVerification;
  gatewayEnvSync?: GatewayServiceEnvSyncResult;
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

function resolveDiscoveryProvider(
  provider: RuntimeDiscoveryProvider | undefined
): RuntimeDiscoveryProvider {
  return provider ?? discoverOpenClawRuntime;
}

/** 尽力解析 automatic 目标；失败返回 undefined（不抛） */
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

function runGatewayEnvSyncIfNeeded(input: {
  openclawPath: string;
  envPath: string;
  envWrite?: EnvWriteVerification;
  envRemovedKeys?: string[];
  discover: RuntimeDiscoveryProvider;
}): GatewayServiceEnvSyncResult | undefined {
  const shouldSync = Boolean(input.envWrite?.verified) || Boolean(input.envRemovedKeys?.length);
  if (!shouldSync) return undefined;
  try {
    // 写后重新 discovery，避免复用备份前的陈旧候选
    const target = resolveGatewayRuntimeTarget({
      activePaths: { openclawPath: input.openclawPath, envPath: input.envPath },
      discovery: input.discover(),
      mode: "automatic"
    });
    return syncManagedBlockToGatewayServiceEnv({
      envPath: input.envPath,
      target: target.serviceEnvTarget,
      ...(input.envRemovedKeys?.length ? { removedKeys: input.envRemovedKeys } : {})
    });
  } catch (error) {
    if (isGatewayRuntimeTargetError(error)) {
      // 缺/歧义关联：主事务成功，仅返回 warning
      return gatewayRuntimeTargetErrorToSyncResult(error);
    }
    // 已关联后的写入失败仍进入事务回滚
    throw error;
  }
}

export async function writeOpenClawTransaction(input: TransactionInput): Promise<TransactionResult> {
  return withFileLock(join(input.stateDir, "write.lock"), async () => {
    const discover = resolveDiscoveryProvider(input.runtimeDiscoveryProvider);
    const beforeRaw = readFileSync(input.openclawPath, "utf8");
    const beforeConfig = JSON5.parse(beforeRaw) as OpenClawConfig;
    const beforeHash = sha256(beforeRaw);
    const beforeEnv = existsSync(input.envPath) ? readFileSync(input.envPath, "utf8") : "";

    const afterConfig = input.mutate(structuredClone(beforeConfig));
    assertAllowedSemanticChange(beforeConfig, afterConfig);
    const afterRaw = `${JSON.stringify(afterConfig, null, 2)}\n`;
    const hasEnvUpdates = Boolean(input.envUpdates && Object.keys(input.envUpdates).length);
    const afterEnv = hasEnvUpdates
      ? applyEnvUpdates({
          content: beforeEnv,
          providerRefs: listProviderEnvRefs(afterConfig),
          manifest: readManifest(input.stateDir),
          updates: input.envUpdates!,
          ...(input.envUpdateOptions ? { options: input.envUpdateOptions } : {})
        }).content
      : beforeEnv;

    const association = tryResolveAutomaticTarget({
      openclawPath: input.openclawPath,
      envPath: input.envPath,
      discover
    });
    const backupDir = createBackup({
      stateDir: input.stateDir,
      openclawPath: input.openclawPath,
      envPath: input.envPath,
      reason: input.reason,
      beforeHash,
      ...(association
        ? {
            runtimeInstanceId: association.instanceId,
            serviceEnvPath: association.serviceEnvTarget.targetPath
          }
        : {})
    });

    let envWrite: EnvWriteVerification | undefined;
    let gatewayEnvSync: GatewayServiceEnvSyncResult | undefined;

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
      if (hasEnvUpdates) {
        envWrite = verifyEnvWrite(readFileSync(input.envPath, "utf8"), input.envUpdates!);
        if (!envWrite.verified) throw new Error("env write verification failed");
      }
      applyManifestUpdates(input.stateDir, input.manifestUpdates);
      input.afterWrite?.();
      gatewayEnvSync = runGatewayEnvSyncIfNeeded({
        openclawPath: input.openclawPath,
        envPath: input.envPath,
        discover,
        ...(envWrite ? { envWrite } : {}),
        ...(input.envRemovedKeys ? { envRemovedKeys: input.envRemovedKeys } : {})
      });
    } catch (error) {
      restoreFromBackup(backupDir, input.openclawPath, input.envPath);
      rmSync(configTmp, { force: true });
      rmSync(envTmp, { force: true });
      throw error;
    }

    return {
      backupDir,
      ...(envWrite ? { envWrite } : {}),
      ...(gatewayEnvSync ? { gatewayEnvSync } : {})
    };
  });
}

export interface EnvTransactionInput {
  openclawPath: string;
  envPath: string;
  stateDir: string;
  reason: string;
  pathSources?: { openclawPath?: string; envPath?: string };
  /** delete/rename 时从 gateway service env 删除的旧 Key */
  envRemovedKeys?: string[];
  mutateEnv(content: string): string;
  verifyEnvUpdates?: Record<string, string>;
  afterWrite?: () => void;
  /** 注入 discovery；默认 discoverOpenClawRuntime */
  runtimeDiscoveryProvider?: RuntimeDiscoveryProvider;
}

export async function writeEnvTransaction(input: EnvTransactionInput): Promise<TransactionResult> {
  return withFileLock(join(input.stateDir, "write.lock"), async () => {
    const discover = resolveDiscoveryProvider(input.runtimeDiscoveryProvider);
    const beforeRaw = readFileSync(input.openclawPath, "utf8");
    const beforeHash = sha256(beforeRaw);
    const beforeEnv = existsSync(input.envPath) ? readFileSync(input.envPath, "utf8") : "";
    const afterEnv = input.mutateEnv(beforeEnv);

    const association = tryResolveAutomaticTarget({
      openclawPath: input.openclawPath,
      envPath: input.envPath,
      discover
    });
    const backupDir = createBackup({
      stateDir: input.stateDir,
      openclawPath: input.openclawPath,
      envPath: input.envPath,
      reason: input.reason,
      beforeHash,
      ...(input.pathSources ? { pathSources: input.pathSources } : {}),
      ...(association
        ? {
            runtimeInstanceId: association.instanceId,
            serviceEnvPath: association.serviceEnvTarget.targetPath
          }
        : {})
    });

    let envWrite: EnvWriteVerification | undefined;
    let gatewayEnvSync: GatewayServiceEnvSyncResult | undefined;

    mkdirSync(dirname(input.envPath), { recursive: true });
    const envTmp = `${input.envPath}.tmp`;
    try {
      writeFileSync(envTmp, afterEnv, { mode: 0o600 });
      renameSync(envTmp, input.envPath);
      if (input.verifyEnvUpdates) {
        envWrite = verifyEnvWrite(readFileSync(input.envPath, "utf8"), input.verifyEnvUpdates);
        if (!envWrite.verified) throw new Error("env write verification failed");
      }
      input.afterWrite?.();
      gatewayEnvSync = runGatewayEnvSyncIfNeeded({
        openclawPath: input.openclawPath,
        envPath: input.envPath,
        discover,
        ...(envWrite ? { envWrite } : {}),
        ...(input.envRemovedKeys ? { envRemovedKeys: input.envRemovedKeys } : {})
      });
    } catch (error) {
      restoreFromBackup(backupDir, input.openclawPath, input.envPath);
      rmSync(envTmp, { force: true });
      throw error;
    }

    return {
      backupDir,
      ...(envWrite ? { envWrite } : {}),
      ...(gatewayEnvSync ? { gatewayEnvSync } : {})
    };
  });
}
