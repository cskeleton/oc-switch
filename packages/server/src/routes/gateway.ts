import { existsSync, readFileSync } from "node:fs";
import {
  restartGateway,
  syncManagedBlockToGatewayServiceEnv,
  resolveGatewayRuntimeTarget,
  inspectGatewayEnvDrift,
  listAmbiguousGatewayEnvDriftCandidates,
  unavailableGatewayEnvDriftReport,
  isGatewayRuntimeTargetError,
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

  app.get("/api/gateway/env-drift", async (c) => {
    const paths = runtime.currentPaths();
    // 读报告：每次请求现做 discovery、现读文件，不缓存
    const discovery = runtime.runtimeDiscoveryProvider();
    const candidateId = c.req.query("candidateId")?.trim() || undefined;
    let target: GatewayRuntimeTarget;
    try {
      target = resolveGatewayRuntimeTarget({
        activePaths: paths,
        discovery,
        // 无 id 用 automatic、有 id 用 explicit（做路径匹配校验）
        mode: candidateId ? "explicit" : "automatic",
        ...(candidateId ? { candidateId } : {})
      });
    } catch (error) {
      if (!isGatewayRuntimeTargetError(error)) throw error;
      // 「无法唯一关联」是正常状态而非客户端错误：恒 200，由 report.status 承载
      const candidates = error.code === "ambiguous-match"
        ? listAmbiguousGatewayEnvDriftCandidates(paths, discovery)
        : undefined;
      return c.json({
        ok: true,
        report: unavailableGatewayEnvDriftReport({
          code: error.code,
          message: error.message,
          ...(candidates ? { candidates } : {})
        })
      });
    }

    const envContent = existsSync(paths.envPath) ? readFileSync(paths.envPath, "utf8") : "";
    let serviceEnvContent: string | null;
    try {
      serviceEnvContent = existsSync(target.serviceEnvTarget.targetPath)
        ? readFileSync(target.serviceEnvTarget.targetPath, "utf8")
        : null;
    } catch (readError) {
      const detail = readError instanceof Error ? readError.message : String(readError);
      return c.json({
        ok: true,
        report: unavailableGatewayEnvDriftReport({
          code: "service-env-unreadable",
          message: `Gateway service env file is not readable at ${target.serviceEnvTarget.targetPath}: ${detail}`
        })
      });
    }
    const report = inspectGatewayEnvDrift({ envContent, target: target.serviceEnvTarget, serviceEnvContent });
    return c.json({ ok: true, report });
  });

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
