import {
  syncManagedBlockToGatewayServiceEnv,
  type GatewayServiceEnvSyncResult,
  type GatewayServiceEnvTarget
} from "./gateway-service-env-sync";

export type GatewaySystemdEnvSyncResult = GatewayServiceEnvSyncResult;

export {
  readGatewaySystemdEnv,
  readManagedBlockEntries
} from "./gateway-service-env-sync";

/** 将托管块 merge 写入显式 systemd EnvironmentFile 目标（Linux 兼容包装） */
export function syncManagedBlockToGatewaySystemdEnv(input: {
  envPath: string;
  target: GatewayServiceEnvTarget;
  removedKeys?: string[];
}): GatewaySystemdEnvSyncResult {
  if (input.target.targetKind !== "systemd") {
    throw new Error(`syncManagedBlockToGatewaySystemdEnv requires targetKind "systemd", got "${input.target.targetKind}"`);
  }
  return syncManagedBlockToGatewayServiceEnv({
    envPath: input.envPath,
    target: input.target,
    ...(input.removedKeys?.length ? { removedKeys: input.removedKeys } : {})
  });
}
