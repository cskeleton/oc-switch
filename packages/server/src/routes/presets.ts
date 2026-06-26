import {
  exportProviderPreset,
  listPresets,
  saveCustomPreset
} from "@oc-switch/core";
import type { Hono } from "hono";
import { readFileSync } from "node:fs";
import { readConfig, type AppRuntime } from "../context";
import { jsonError } from "../errors";

export function registerPresetRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/presets", (c) => {
    const entries = listPresets(runtime.presetDirs).map((entry) => {
      const preset = JSON.parse(readFileSync(entry.path, "utf8")) as { models?: unknown[] };
      return {
        id: entry.id,
        name: entry.name,
        source: entry.source,
        tags: entry.tags,
        modelCount: preset.models?.length ?? 0
      };
    });
    return c.json({ presets: entries });
  });

  app.post("/api/presets/import", (c) => {
    try {
      const config = readConfig(runtime.currentPaths());
      const providerIds = Object.keys(config.models?.providers ?? {});
      const imported: string[] = [];
      for (const providerId of providerIds) {
        const preset = exportProviderPreset(config, providerId);
        saveCustomPreset(runtime.presetDirs.customDir, preset);
        imported.push(providerId);
      }
      return c.json({ ok: true, imported });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/presets/export/:id", (c) => {
    try {
      const providerId = c.req.param("id");
      const preset = exportProviderPreset(readConfig(runtime.currentPaths()), providerId);
      const written = saveCustomPreset(runtime.presetDirs.customDir, preset);
      return c.json({ ok: true, id: preset.id, path: written });
    } catch (error) {
      return jsonError(c, error);
    }
  });
}
