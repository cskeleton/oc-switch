import {
  applyEnvOperation,
  inspectEnvFile,
  listProviderEnvRefs,
  previewEnvOperation,
  readManifest
} from "@oc-switch/core";
import type { Hono } from "hono";
import { readConfig, readEnvContent, type AppRuntime } from "../context";
import { jsonError } from "../errors";
import { requireEnvOperation, requireEnvPreviewOperation } from "../schemas";

export function registerEnvRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/env", (c) => {
    try {
      const paths = runtime.currentPaths();
      const config = readConfig(paths);
      const envContent = readEnvContent(paths) ?? "";
      return c.json(inspectEnvFile({
        content: envContent,
        providerRefs: listProviderEnvRefs(config),
        manifest: readManifest(paths.stateDir)
      }));
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/env/preview", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const operation = requireEnvPreviewOperation(body);
      return c.json(previewEnvOperation({
        paths: runtime.currentPaths(),
        operation: operation as never
      }));
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/env", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const operation = requireEnvOperation(body);
      const result = await applyEnvOperation({
        paths: runtime.currentPaths(),
        operation: operation as never
      });
      return c.json(result);
    } catch (error) {
      return jsonError(c, error);
    }
  });
}
