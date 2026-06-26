import {
  listBackups,
  readBackupMetadata,
  restoreBackupSafely,
  validateBackupPathMatch
} from "@oc-switch/core";
import type { Hono } from "hono";
import { join } from "node:path";
import type { AppRuntime } from "../context";
import { jsonError } from "../errors";
import { optionalRestoreBackupTarget } from "../schemas";

export function registerBackupRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/backups", (c) => {
    const paths = runtime.currentPaths();
    const backups = listBackups(paths.stateDir).map((entry) => ({
      id: entry.id,
      createdAt: entry.metadata.createdAt,
      reason: entry.metadata.reason,
      openclawPath: entry.metadata.openclawPath,
      envPath: entry.metadata.envPath,
      pathMatchesActive: entry.metadata.openclawPath === paths.openclawPath && entry.metadata.envPath === paths.envPath
    }));
    return c.json({ backups });
  });

  app.post("/api/backups/:id/restore", async (c) => {
    try {
      const id = c.req.param("id");
      const paths = runtime.currentPaths();
      const backupDir = join(paths.stateDir, "backups", id);
      const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
      const target = optionalRestoreBackupTarget(body);
      const mismatch = validateBackupPathMatch({
        backupDir,
        openclawPath: paths.openclawPath,
        envPath: paths.envPath
      });
      if (mismatch && !target) {
        return c.json({ error: "backup path mismatch", mismatch }, 409);
      }
      const restorePaths = target === "backup"
        ? (() => {
            const metadata = readBackupMetadata(backupDir);
            return { openclawPath: metadata.openclawPath, envPath: metadata.envPath };
          })()
        : { openclawPath: paths.openclawPath, envPath: paths.envPath };
      const result = restoreBackupSafely({
        stateDir: paths.stateDir,
        backupDir,
        openclawPath: restorePaths.openclawPath,
        envPath: restorePaths.envPath,
        ...(target === "current" ? { allowPathMismatch: true } : {})
      });
      return c.json({ ok: true, id, safetyBackupId: result.safetyBackupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });
}
