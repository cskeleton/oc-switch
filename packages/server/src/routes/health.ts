import {
  createConfigAdapter,
  inspectConfigHealth,
  inspectConfigStatus,
  listBackups,
  repairOpenClawCompatibility,
  summarizeConfigDiff,
  writeOpenClawTransaction
} from "@oc-switch/core";
import type { Hono } from "hono";
import JSON5 from "json5";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawConfig } from "@oc-switch/core";
import { readConfig, readEnvContent, type AppRuntime } from "../context";
import { jsonError } from "../errors";

export function registerHealthRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/status", (c) => {
    const adapter = createConfigAdapter(readConfig(runtime.currentPaths()));
    const status = adapter.getStatus();
    return c.json({ ok: true, ...status });
  });

  app.get("/api/health", (c) => {
    return c.json(inspectConfigHealth(readConfig(runtime.currentPaths())));
  });

  app.get("/api/config-status", (c) => {
    const paths = runtime.currentPaths();
    let config: OpenClawConfig | undefined;
    let configReadError: string | undefined;
    try {
      config = readConfig(paths);
    } catch (error) {
      configReadError = error instanceof Error ? error.message : String(error);
    }
    let envContent = "";
    try {
      envContent = readEnvContent(paths) ?? "";
    } catch {
      envContent = "";
    }
    return c.json(inspectConfigStatus({
      ...(config ? { config } : {}),
      ...(configReadError ? { configReadError } : {}),
      paths,
      envContent,
      ...(runtime.options.runningInstances ? { runningInstances: runtime.options.runningInstances } : {})
    }));
  });

  app.get("/api/diff", (c) => {
    try {
      const [latest] = listBackups(runtime.currentPaths().stateDir);
      if (!latest) throw new Error("No backups found");
      const before = JSON5.parse(readFileSync(join(latest.path, "openclaw.json"), "utf8")) as OpenClawConfig;
      const after = readConfig(runtime.currentPaths());
      return c.json(summarizeConfigDiff(before, after));
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/health/repair", async (c) => {
    try {
      const paths = runtime.currentPaths();
      const before = readConfig(paths);
      const repaired = repairOpenClawCompatibility(structuredClone(before));
      if (!repaired.changed) {
        return c.json({ ok: true, changed: false, warnings: repaired.warnings });
      }
      const result = await writeOpenClawTransaction({
        ...paths,
        reason: "repair OpenClaw compatibility",
        mutate() {
          return repaired.config;
        }
      });
      return c.json({
        ok: true,
        changed: true,
        warnings: repaired.warnings,
        backupId: result.backupDir.split("/").pop()
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });
}
