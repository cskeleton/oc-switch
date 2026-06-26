import {
  createConfigAdapter,
  inspectConfigHealth,
  listBackups,
  summarizeConfigDiff
} from "@oc-switch/core";
import type { Hono } from "hono";
import JSON5 from "json5";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawConfig } from "@oc-switch/core";
import { readConfig, type AppRuntime } from "../context";
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
}
