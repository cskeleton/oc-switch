import {
  restartGateway,
  syncManagedBlockToGatewaySystemdEnv,
  type GatewayRestartExecutor,
  type GatewayRestartResult,
  type GatewaySystemdEnvSyncResult
} from "@oc-switch/core";
import type { Hono } from "hono";
import { readConfig, type AppRuntime } from "../context";
import { jsonError } from "../errors";

export interface GatewayRouteOptions {
  restartGateway?: typeof restartGateway;
  syncManagedBlockToGatewaySystemdEnv?: typeof syncManagedBlockToGatewaySystemdEnv;
}

export function registerGatewayRoutes(app: Hono, runtime: AppRuntime, options: GatewayRouteOptions = {}): void {
  const syncFn = options.syncManagedBlockToGatewaySystemdEnv ?? syncManagedBlockToGatewaySystemdEnv;
  const restartFn = options.restartGateway ?? restartGateway;

  app.post("/api/gateway/sync-env", (c) => {
    try {
      readConfig(runtime.currentPaths());
      const sync = syncFn({ envPath: runtime.currentPaths().envPath });
      return c.json({ ok: true, sync });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/gateway/restart", async (c) => {
    try {
      readConfig(runtime.currentPaths());
      const restart: GatewayRestartResult = await restartFn();
      if (!restart.ok) {
        return c.json({ ok: false, restart }, 400);
      }
      return c.json({ ok: true, restart });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/gateway/apply", async (c) => {
    try {
      readConfig(runtime.currentPaths());
      const sync: GatewaySystemdEnvSyncResult = syncFn({ envPath: runtime.currentPaths().envPath });
      const restart: GatewayRestartResult = await restartFn();
      if (!restart.ok) {
        return c.json({ ok: false, sync, restart }, 400);
      }
      return c.json({ ok: true, sync, restart });
    } catch (error) {
      return jsonError(c, error);
    }
  });
}

export type { GatewayRestartExecutor };
