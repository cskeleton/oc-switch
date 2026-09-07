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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawConfig } from "@oc-switch/core";
import { readConfig, readDisabledProviderIds, readEnvContent, type AppRuntime } from "../context";
import { jsonError } from "../errors";

export function registerHealthRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/status", (c) => {
    const paths = runtime.currentPaths();
    // 注入插件目录：providerCount / providerModelCount 仍是 config-only，
    // 但 effectiveModelCount 必须与 /api/config-status 的 effectiveCatalogCount 一致。
    const adapter = createConfigAdapter(readConfig(paths), {
      disabledProviderIds: readDisabledProviderIds(paths),
      pluginProviders: runtime.currentPluginProviders()
    });
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
      pluginProviders: runtime.currentPluginProviders()
    }));
  });

  app.get("/api/diff", (c) => {
    try {
      const paths = runtime.currentPaths();
      const [latest] = listBackups(paths.stateDir);
      if (!latest) throw new Error("No backups found");
      const before = JSON5.parse(readFileSync(join(latest.path, "openclaw.json"), "utf8")) as OpenClawConfig;
      const after = readConfig(paths);
      const backupEnvPath = join(latest.path, ".env");
      const beforeEnv = existsSync(backupEnvPath) ? readFileSync(backupEnvPath, "utf8") : "";
      const afterEnv = readEnvContent(paths) ?? "";
      return c.json(summarizeConfigDiff(before, after, { beforeEnv, afterEnv }));
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
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
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
