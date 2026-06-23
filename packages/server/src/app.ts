import {
  addProviderFromPreset,
  applySyncedModels,
  createConfigAdapter,
  defaultPaths,
  defaultPresetDirs,
  disableModel,
  editProvider,
  enableModel,
  exportProviderPreset,
  listBackups,
  listPresets,
  loadPreset,
  removeProvider,
  restoreBackup,
  saveCustomPreset,
  setPrimaryModel,
  summarizeConfigDiff,
  syncProviderModels,
  writeOpenClawTransaction,
  type FetchImpl,
  type OcSwitchPaths,
  type OpenClawConfig,
  type PresetDirs
} from "@oc-switch/core";
import { Hono } from "hono";
import JSON5 from "json5";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { requireBoolean, requireString } from "./schemas";

export interface AppOptions {
  token: string;
  paths?: OcSwitchPaths;
  presetDirs?: PresetDirs;
  repoRoot?: string;
  fetchImpl?: FetchImpl;
}

function readConfig(paths: OcSwitchPaths): OpenClawConfig {
  if (!existsSync(paths.openclawPath)) {
    throw new Error("openclaw.json not found");
  }
  return JSON5.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
}

function isValidationError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("must be");
}

function jsonError(c: { json: (body: unknown, status: number) => Response }, error: unknown): Response {
  if (isValidationError(error)) {
    return c.json({ error: (error as Error).message }, 400);
  }
  if (error instanceof Error) {
    return c.json({ error: error.message }, 400);
  }
  return c.json({ error: "Internal server error" }, 500);
}

/** 创建带 Bearer 认证的 Hono REST 应用 */
export function createApp(options: AppOptions) {
  const paths = options.paths ?? defaultPaths();
  const presetDirs = options.presetDirs ?? defaultPresetDirs(paths.stateDir, options.repoRoot);
  const fetchImpl = options.fetchImpl ?? fetch;

  const app = new Hono();

  // 允许 WebGUI 跨端口访问 REST API
  app.use("/api/*", async (c, next) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
    c.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    if (c.req.method === "OPTIONS") {
      return c.body(null, 204);
    }
    await next();
  });

  app.use("/api/*", async (c, next) => {
    const auth = c.req.header("Authorization");
    if (auth !== `Bearer ${options.token}`) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    await next();
  });

  app.get("/api/status", (c) => {
    const adapter = createConfigAdapter(readConfig(paths));
    const status = adapter.getStatus();
    return c.json({ ok: true, ...status });
  });

  app.get("/api/providers", (c) => {
    const adapter = createConfigAdapter(readConfig(paths));
    return c.json({ providers: adapter.listProviders() });
  });

  app.post("/api/providers", async (c) => {
    try {
      const body = await c.req.json();
      const presetId = requireString(body.presetId, "presetId");
      const apiKey = requireString(body.apiKey, "apiKey");
      const models = Array.isArray(body.models)
        ? body.models.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
        : undefined;
      const preset = loadPreset(presetDirs, presetId);
      const enabledModels = models ?? preset.models.map((model) => model.id);
      const result = await writeOpenClawTransaction({
        ...paths,
        reason: `add provider ${presetId}`,
        envUpdates: { [preset.provider.apiKeyEnv]: apiKey },
        mutate(config) {
          return addProviderFromPreset(config, preset, enabledModels).config;
        }
      });
      return c.json({ ok: true, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.put("/api/providers/:id", async (c) => {
    try {
      const providerId = c.req.param("id");
      const body = await c.req.json();
      const envUpdates: Record<string, string> = {};
      if (body.apiKey !== undefined) {
        const config = readConfig(paths);
        const providerConfig = config.models?.providers?.[providerId];
        const envId = providerConfig?.apiKey?.id ?? providerConfig?.authHeader?.id;
        if (!envId) throw new Error(`Provider ${providerId} has no env key reference`);
        envUpdates[envId] = requireString(body.apiKey, "apiKey");
      }
      const result = await writeOpenClawTransaction({
        ...paths,
        reason: `edit provider ${providerId}`,
        ...(Object.keys(envUpdates).length ? { envUpdates } : {}),
        mutate(config) {
          const changes: { baseUrl?: string } = {};
          if (body.baseUrl !== undefined) changes.baseUrl = requireString(body.baseUrl, "baseUrl");
          return editProvider(config, providerId, changes).config;
        }
      });
      return c.json({ ok: true, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.delete("/api/providers/:id", async (c) => {
    try {
      const providerId = c.req.param("id");
      const body = await c.req.json().catch(() => ({}));
      const removeOptions: { force: boolean; newPrimary?: string } = {
        force: Boolean(body.force)
      };
      if (body.newPrimary !== undefined) {
        removeOptions.newPrimary = requireString(body.newPrimary, "newPrimary");
      }
      const result = await writeOpenClawTransaction({
        ...paths,
        reason: `delete provider ${providerId}`,
        mutate(config) {
          return removeProvider(config, providerId, removeOptions).config;
        }
      });
      return c.json({ ok: true, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/providers/:id/sync", async (c) => {
    try {
      const providerId = c.req.param("id");
      const config = readConfig(paths);
      const syncResult = await syncProviderModels(config, providerId, fetchImpl);
      if (syncResult.unsupportedReason) {
        return c.json({
          ok: false,
          unsupportedReason: syncResult.unsupportedReason,
          addedModelIds: [],
          skippedModelIds: syncResult.skippedModelIds
        });
      }
      if (syncResult.addedModelIds.length === 0) {
        return c.json({
          ok: true,
          addedModelIds: [],
          skippedModelIds: syncResult.skippedModelIds
        });
      }
      const result = await writeOpenClawTransaction({
        ...paths,
        reason: `sync provider ${providerId}`,
        mutate(current) {
          return applySyncedModels(current, providerId, syncResult.addedModelIds);
        }
      });
      return c.json({
        ok: true,
        addedModelIds: syncResult.addedModelIds,
        skippedModelIds: syncResult.skippedModelIds,
        backupId: result.backupDir.split("/").pop()
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.get("/api/models", (c) => {
    const adapter = createConfigAdapter(readConfig(paths));
    return c.json({ models: adapter.listModels() });
  });

  app.put("/api/models/primary", async (c) => {
    try {
      const body = await c.req.json();
      const ref = requireString(body.ref, "ref");
      const result = await writeOpenClawTransaction({
        ...paths,
        reason: `set primary model ${ref}`,
        mutate(config) {
          return setPrimaryModel(config, ref).config;
        }
      });
      return c.json({ ok: true, ref, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.patch("/api/models", async (c) => {
    try {
      const body = await c.req.json();
      const ref = requireString(body.ref, "ref");
      const enabled = requireBoolean(body.enabled, "enabled");
      const result = await writeOpenClawTransaction({
        ...paths,
        reason: enabled ? `enable model ${ref}` : `disable model ${ref}`,
        mutate(config) {
          return enabled ? enableModel(config, ref, body.alias).config : disableModel(config, ref).config;
        }
      });
      return c.json({ ok: true, ref, enabled, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.get("/api/presets", (c) => {
    const entries = listPresets(presetDirs).map((entry) => {
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
      const config = readConfig(paths);
      const providerIds = Object.keys(config.models?.providers ?? {});
      const imported: string[] = [];
      for (const providerId of providerIds) {
        const preset = exportProviderPreset(config, providerId);
        saveCustomPreset(presetDirs.customDir, preset);
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
      const preset = exportProviderPreset(readConfig(paths), providerId);
      const written = saveCustomPreset(presetDirs.customDir, preset);
      return c.json({ ok: true, id: preset.id, path: written });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.get("/api/backups", (c) => {
    const backups = listBackups(paths.stateDir).map((entry) => ({
      id: entry.id,
      createdAt: entry.metadata.createdAt,
      reason: entry.metadata.reason
    }));
    return c.json({ backups });
  });

  app.post("/api/backups/:id/restore", (c) => {
    try {
      const id = c.req.param("id");
      restoreBackup({
        backupDir: join(paths.stateDir, "backups", id),
        openclawPath: paths.openclawPath,
        envPath: paths.envPath
      });
      return c.json({ ok: true, id });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.get("/api/diff", (c) => {
    try {
      const [latest] = listBackups(paths.stateDir);
      if (!latest) throw new Error("No backups found");
      const before = JSON5.parse(readFileSync(join(latest.path, "openclaw.json"), "utf8")) as OpenClawConfig;
      const after = readConfig(paths);
      return c.json(summarizeConfigDiff(before, after));
    } catch (error) {
      return jsonError(c, error);
    }
  });

  return app;
}
