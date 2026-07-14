import {
  restartGateway,
  syncManagedBlockToGatewayServiceEnv,
  resolveGatewayRuntimeTarget,
  type GatewayRestartExecutor,
  type GatewayRuntimeTarget,
  type GatewayServiceEnvSyncResult
} from "@oc-switch/core";
import type { Hono } from "hono";
import { readConfig, type AppRuntime } from "../context";
import { jsonError } from "../errors";
import { optionalGatewayActionBody } from "../schemas";

export interface GatewayRouteOptions {
  restartGateway?: typeof restartGateway;
  syncManagedBlockToGatewayServiceEnv?: typeof syncManagedBlockToGatewayServiceEnv;
}

/** 解析可选 JSON body；空 body 视为 {} */
async function readJsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("body must be an object");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === "body must be an object") throw error;
    return {};
  }
}

/** 每次请求 discovery 一次，按 explicit 模式解析唯一 runtime 目标 */
function resolveExplicitGatewayTarget(
  runtime: AppRuntime,
  candidateId: string | undefined
): GatewayRuntimeTarget {
  const paths = runtime.currentPaths();
  const discovery = runtime.runtimeDiscoveryProvider();
  return resolveGatewayRuntimeTarget({
    activePaths: paths,
    discovery,
    mode: "explicit",
    ...(candidateId ? { candidateId } : {})
  });
}

export function registerGatewayRoutes(app: Hono, runtime: AppRuntime, options: GatewayRouteOptions = {}): void {
  const syncFn = options.syncManagedBlockToGatewayServiceEnv ?? syncManagedBlockToGatewayServiceEnv;
  const restartFn = options.restartGateway ?? restartGateway;

  app.post("/api/gateway/sync-env", async (c) => {
    try {
      const parsed = optionalGatewayActionBody(await readJsonBody(c));
      const paths = runtime.currentPaths();
      readConfig(paths);
      const target = resolveExplicitGatewayTarget(runtime, parsed.candidateId);
      const sync = syncFn({ envPath: paths.envPath, target: target.serviceEnvTarget });
      return c.json({ ok: true, sync });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/gateway/restart", async (c) => {
    try {
      const parsed = optionalGatewayActionBody(await readJsonBody(c));
      const paths = runtime.currentPaths();
      readConfig(paths);
      const target = resolveExplicitGatewayTarget(runtime, parsed.candidateId);
      const restart = await restartFn({ target });
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
      const parsed = optionalGatewayActionBody(await readJsonBody(c));
      const paths = runtime.currentPaths();
      readConfig(paths);
      // apply 只 resolve 一次，sync 与 restart 共用同一 target
      const target = resolveExplicitGatewayTarget(runtime, parsed.candidateId);
      const sync: GatewayServiceEnvSyncResult = syncFn({
        envPath: paths.envPath,
        target: target.serviceEnvTarget
      });
      const restart = await restartFn({ target });
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
