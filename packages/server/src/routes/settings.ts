import {
  cleanupOrphanEnvKeys,
  DEFAULT_BACKUP_RETENTION,
  discoverRunningOpenClawInstances,
  listOrphanEnvKeys,
  resolveOpenClawPathCandidates,
  validateEnvPathForSwitch,
  validateOpenClawPathForSwitch,
  writeOcSwitchSettings
} from "@oc-switch/core";
import type { Hono } from "hono";
import { readConfig, type AppRuntime } from "../context";
import { jsonError } from "../errors";
import { requireString } from "../schemas";

export function registerSettingsRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/settings/paths", (c) => {
    const runningInstances = runtime.options.runningInstances ?? discoverRunningOpenClawInstances();
    return c.json(resolveOpenClawPathCandidates({
      stateDir: runtime.currentPaths().stateDir,
      runningInstances,
      manualOpenClawPaths: [runtime.currentPaths().openclawPath],
      manualEnvPaths: [runtime.currentPaths().envPath]
    }));
  });

  app.put("/api/settings/paths", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const next = {
        openclawPath: requireString(body.openclawPath, "openclawPath"),
        envPath: requireString(body.envPath, "envPath"),
        stateDir: runtime.currentPaths().stateDir
      };
      validateOpenClawPathForSwitch(next.openclawPath);
      readConfig(next);
      validateEnvPathForSwitch(next.envPath);
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
