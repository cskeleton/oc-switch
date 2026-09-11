import {
  cleanupOrphanEnvKeys,
  DEFAULT_BACKUP_RETENTION,
  listOrphanEnvKeys,
  resolveOpenClawPathCandidates,
  validateRuntimePathSelection,
  writeOcSwitchSettings
} from "@oc-switch/core";
import type { Hono } from "hono";
import { readConfig, type AppRuntime } from "../context";
import { jsonError } from "../errors";
import { requirePathSettingsUpdate } from "../schemas";

export function registerSettingsRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/settings/paths", (c) => {
    const paths = runtime.currentPaths();
    const runtimeDiscovery = runtime.runtimeDiscoveryProvider();
    const candidates = resolveOpenClawPathCandidates({
      stateDir: paths.stateDir,
      runtimeDiscovery,
      manualOpenClawPaths: [paths.openclawPath],
      manualEnvPaths: [paths.envPath]
    });
    // 候选发现可参考进程环境，但 active 必须与本服务实际读写路径一致。
    return c.json({ ...candidates, active: paths });
  });

  app.put("/api/settings/paths", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const parsed = requirePathSettingsUpdate(body);
      const next = {
        openclawPath: parsed.openclawPath,
        envPath: parsed.envPath,
        stateDir: runtime.currentPaths().stateDir
      };
      // 每次 PUT 只探测一次，供候选组校验复用
      const discovery = runtime.runtimeDiscoveryProvider();
      validateRuntimePathSelection({
        openclawPath: next.openclawPath,
        envPath: next.envPath,
        ...(parsed.candidateId ? { candidateId: parsed.candidateId } : {}),
        discovery
      });
      readConfig(next);
      writeOcSwitchSettings(next.stateDir, {
        openclawPath: next.openclawPath,
        envPath: next.envPath
      });
      runtime.setActivePaths(next);
      return c.json({ ok: true, paths: next });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.get("/api/settings", (c) => c.json({
    configPath: runtime.currentPaths().openclawPath,
    envPath: runtime.currentPaths().envPath,
    bindAddress: runtime.options.bindAddress ?? "127.0.0.1",
    port: runtime.options.port ?? 7420,
    backupRetention: DEFAULT_BACKUP_RETENTION,
    gatewayRestartCommand: "openclaw gateway restart",
    orphanEnvKeys: listOrphanEnvKeys(runtime.currentPaths().stateDir)
  }));

  app.post("/api/settings/orphans/cleanup", (c) => {
    try {
      const result = cleanupOrphanEnvKeys(runtime.currentPaths());
      return c.json({
        ok: true,
        removedKeys: result.removedKeys,
        ...(result.backupDir ? { backupId: result.backupDir.split("/").pop() } : {})
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });
}
