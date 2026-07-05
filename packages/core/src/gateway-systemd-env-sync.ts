import {
  readGatewaySystemdEnv,
  readManagedBlockEntries,
  syncManagedBlockToGatewayServiceEnv,
  type GatewayServiceEnvSyncResult
} from "./gateway-service-env-sync";
import { dirname, join } from "node:path";

export type GatewaySystemdEnvSyncResult = GatewayServiceEnvSyncResult;

export { readGatewaySystemdEnv, readManagedBlockEntries };

/** 将托管块 merge 写入 gateway.systemd.env（Linux 兼容包装） */
export function syncManagedBlockToGatewaySystemdEnv(input: {
  envPath: string;
  gatewaySystemdEnvPath?: string;
  removedKeys?: string[];
}): GatewaySystemdEnvSyncResult {
  return syncManagedBlockToGatewayServiceEnv({
    envPath: input.envPath,
    gatewayServiceEnvPath: input.gatewaySystemdEnvPath ?? join(dirname(input.envPath), "gateway.systemd.env"),
    ...(input.removedKeys?.length ? { removedKeys: input.removedKeys } : {}),
    platform: "linux"
  });
}
