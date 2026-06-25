import {
  addCustomProvider,
  addProviderFromPreset,
  addProviderModel,
  applyEnvOperation,
  applySyncedModels,
  cleanupOrphanEnvKeys,
  createConfigAdapter,
  DEFAULT_BACKUP_RETENTION,
  defaultPresetDirs,
  discoverRunningOpenClawInstances,
  disableModel,
  editProvider,
  enableModel,
  exportProviderPreset,
  getActivePaths,
  inspectEnvFile,
  inspectConfigHealth,
  mergeProviderCaseDuplicates,
  listBackups,
  listOrphanEnvKeys,
  listPresets,
  listProviderEnvRefs,
  loadPreset,
  previewEnvOperation,
  readBackupMetadata,
  readManifest,
  removeProvider,
  removeProviderModel,
  resolveOpenClawPathCandidates,
  restoreBackupSafely,
  saveCustomPreset,
  setPrimaryModel,
  summarizeConfigDiff,
  syncProviderModels,
  updateProviderModel,
  validateBackupPathMatch,
  validateEnvPathForSwitch,
  validateOpenClawPathForSwitch,
  writeOcSwitchSettings,
  writeOpenClawTransaction,
  type FetchImpl,
  type OcSwitchPaths,
  type OpenClawConfig,
  type PresetDirs,
  type RunningOpenClawInstance
} from "@oc-switch/core";
import { Hono } from "hono";
import JSON5 from "json5";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { optionalRestoreBackupTarget, requireBoolean, requireCustomProviderInput, requireEnvOperation, requireEnvPreviewOperation, requireMergeCaseDuplicateInput, requireProviderModelInput, requireString } from "./schemas";

export interface AppOptions {
  token: string;
  paths?: OcSwitchPaths;
  presetDirs?: PresetDirs;
  repoRoot?: string;
  fetchImpl?: FetchImpl;
  bindAddress?: string;
  port?: number;
  /** 测试注入：覆盖运行实例发现 */
  runningInstances?: RunningOpenClawInstance[];
}

function readConfig(paths: OcSwitchPaths): OpenClawConfig {
  if (!existsSync(paths.openclawPath)) {
    throw new Error("openclaw.json not found");
  }
  return JSON5.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
}

function readEnvContent(paths: OcSwitchPaths): string | undefined {
  return existsSync(paths.envPath) ? readFileSync(paths.envPath, "utf8") : undefined;
}

function providerEnvVar(config: OpenClawConfig, providerId: string): string | undefined {
  const provider = config.models?.providers?.[providerId];
  return provider?.apiKey?.id ?? provider?.authHeader?.id;
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
  let activePaths = options.paths ?? getActivePaths();
  const currentPaths = () => activePaths;
  const presetDirs = options.presetDirs ?? defaultPresetDirs(currentPaths().stateDir, options.repoRoot);
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
    const adapter = createConfigAdapter(readConfig(currentPaths()));
    const status = adapter.getStatus();
    return c.json({ ok: true, ...status });
  });

  app.get("/api/health", (c) => {
    return c.json(inspectConfigHealth(readConfig(currentPaths())));
  });

  app.get("/api/providers", (c) => {
    const adapter = createConfigAdapter(readConfig(currentPaths()));
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
        ...currentPaths(),
        reason: `add provider ${presetId}`,
        envUpdates: { [preset.provider.apiKeyEnv]: apiKey },
        manifestUpdates: [
          { type: "upsert-provider-env", providerId: presetId, envVar: preset.provider.apiKeyEnv }
        ],
        mutate(config) {
          return addProviderFromPreset(config, preset, enabledModels).config;
        }
      });
      return c.json({ ok: true, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/providers/preview", async (c) => {
    try {
      const body = await c.req.json();
      const presetId = requireString(body.presetId, "presetId");
      const models = Array.isArray(body.models)
        ? body.models.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
        : undefined;
      const preset = loadPreset(presetDirs, presetId);
      const before = readConfig(currentPaths());
      const enabledModels = models ?? preset.models.map((model) => model.id);
      const after = addProviderFromPreset(structuredClone(before), preset, enabledModels).config;
      return c.json(summarizeConfigDiff(before, after));
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/providers/custom/preview", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const input = requireCustomProviderInput(body);
      const before = readConfig(currentPaths());
      const after = addCustomProvider(structuredClone(before), input).config;
      return c.json(summarizeConfigDiff(before, after));
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/providers/custom", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const input = requireCustomProviderInput(body);
      const apiKey = requireString(body.apiKey, "apiKey");
      const result = await writeOpenClawTransaction({
        ...currentPaths(),
        reason: `add custom provider ${input.providerId}`,
        envUpdates: { [input.apiKeyEnv]: apiKey },
        manifestUpdates: [
          {
            type: "upsert-provider-env",
            providerId: input.providerId,
            envVar: input.apiKeyEnv,
            metadata: {
              displayName: input.displayName,
              ...(input.notes !== undefined ? { notes: input.notes } : {}),
              ...(input.websiteUrl !== undefined ? { websiteUrl: input.websiteUrl } : {}),
              isFullUrl: input.isFullUrl
            }
          }
        ],
        mutate(config) {
          return addCustomProvider(config, input).config;
        }
      });
      return c.json({ ok: true, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/providers/merge-case-duplicates/preview", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const input = requireMergeCaseDuplicateInput(body);
      const before = readConfig(currentPaths());
      const after = mergeProviderCaseDuplicates(structuredClone(before), input).config;
      return c.json(summarizeConfigDiff(before, after));
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/providers/merge-case-duplicates", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const input = requireMergeCaseDuplicateInput(body);
      let warnings: string[] = [];
      const result = await writeOpenClawTransaction({
        ...currentPaths(),
        reason: `merge case duplicate ${input.groupKey} -> ${input.canonicalId}`,
        mutate(config) {
          const merged = mergeProviderCaseDuplicates(config, input);
          warnings = merged.warnings;
          return merged.config;
        }
      });
      return c.json({ ok: true, warnings, backupId: result.backupDir.split("/").pop() });
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
        const config = readConfig(currentPaths());
        const providerConfig = config.models?.providers?.[providerId];
        const envId = providerConfig?.apiKey?.id ?? providerConfig?.authHeader?.id;
        if (!envId) throw new Error(`Provider ${providerId} has no env key reference`);
        envUpdates[envId] = requireString(body.apiKey, "apiKey");
      }
      const result = await writeOpenClawTransaction({
        ...currentPaths(),
        reason: `edit provider ${providerId}`,
        ...(Object.keys(envUpdates).length ? { envUpdates } : {}),
        ...(Object.keys(envUpdates).length
          ? {
              manifestUpdates: Object.keys(envUpdates).map((envVar) => ({
                type: "upsert-provider-env" as const,
                providerId,
                envVar
              }))
            }
          : {}),
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
      const config = readConfig(currentPaths());
      const envVar = providerEnvVar(config, providerId);
      const result = await writeOpenClawTransaction({
        ...currentPaths(),
        reason: `delete provider ${providerId}`,
        ...(envVar
          ? { manifestUpdates: [{ type: "mark-provider-orphan" as const, providerId, envVar }] }
          : {}),
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
      const config = readConfig(currentPaths());
      const envContent = readEnvContent(currentPaths());
      const syncResult = await syncProviderModels(config, providerId, {
        fetchImpl,
        ...(envContent !== undefined ? { envContent } : {})
      });
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
        ...currentPaths(),
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
    const adapter = createConfigAdapter(readConfig(currentPaths()));
    return c.json({ models: adapter.listModels() });
  });

  app.put("/api/models/primary", async (c) => {
    try {
      const body = await c.req.json();
      const ref = requireString(body.ref, "ref");
      const result = await writeOpenClawTransaction({
        ...currentPaths(),
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
        ...currentPaths(),
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

  app.post("/api/models", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const providerId = requireString(body.providerId, "providerId");
      const model = requireProviderModelInput(body.model);
      const ref = `${providerId}/${model.id}`;
      const result = await writeOpenClawTransaction({
        ...currentPaths(),
        reason: `add model ${ref}`,
        mutate(config) {
          return addProviderModel(config, providerId, model).config;
        }
      });
      return c.json({ ok: true, ref, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.put("/api/models", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const ref = requireString(body.ref, "ref");
      const model = requireProviderModelInput(body.model);
      const result = await writeOpenClawTransaction({
        ...currentPaths(),
        reason: `edit model ${ref}`,
        mutate(config) {
          return updateProviderModel(config, ref, model).config;
        }
      });
      return c.json({ ok: true, ref, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.delete("/api/models", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const ref = requireString(body.ref, "ref");
      const removeOptions: { force: boolean; newPrimary?: string } = {
        force: Boolean(body.force)
      };
      if (body.newPrimary !== undefined) {
        removeOptions.newPrimary = requireString(body.newPrimary, "newPrimary");
      }
      const result = await writeOpenClawTransaction({
        ...currentPaths(),
        reason: `remove model ${ref}`,
        mutate(config) {
          return removeProviderModel(config, ref, removeOptions).config;
        }
      });
      return c.json({ ok: true, ref, backupId: result.backupDir.split("/").pop() });
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
      const config = readConfig(currentPaths());
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
      const preset = exportProviderPreset(readConfig(currentPaths()), providerId);
      const written = saveCustomPreset(presetDirs.customDir, preset);
      return c.json({ ok: true, id: preset.id, path: written });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.get("/api/backups", (c) => {
    const paths = currentPaths();
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
      const paths = currentPaths();
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

  app.get("/api/diff", (c) => {
    try {
      const [latest] = listBackups(currentPaths().stateDir);
      if (!latest) throw new Error("No backups found");
      const before = JSON5.parse(readFileSync(join(latest.path, "openclaw.json"), "utf8")) as OpenClawConfig;
      const after = readConfig(currentPaths());
      return c.json(summarizeConfigDiff(before, after));
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.get("/api/settings/paths", (c) => {
    const runningInstances = options.runningInstances ?? discoverRunningOpenClawInstances();
    return c.json(resolveOpenClawPathCandidates({
      stateDir: currentPaths().stateDir,
      runningInstances,
      manualOpenClawPaths: [currentPaths().openclawPath],
      manualEnvPaths: [currentPaths().envPath]
    }));
  });

  app.put("/api/settings/paths", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const next = {
        openclawPath: requireString(body.openclawPath, "openclawPath"),
        envPath: requireString(body.envPath, "envPath"),
        stateDir: currentPaths().stateDir
      };
      validateOpenClawPathForSwitch(next.openclawPath);
      readConfig(next);
      validateEnvPathForSwitch(next.envPath);
      writeOcSwitchSettings(next.stateDir, {
        openclawPath: next.openclawPath,
        envPath: next.envPath
      });
      activePaths = next;
      return c.json({ ok: true, paths: next });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.get("/api/env", (c) => {
    try {
      const paths = currentPaths();
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
        paths: currentPaths(),
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
        paths: currentPaths(),
        operation: operation as never
      });
      return c.json(result);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.get("/api/settings", (c) => c.json({
    configPath: currentPaths().openclawPath,
    envPath: currentPaths().envPath,
    bindAddress: options.bindAddress ?? "127.0.0.1",
    port: options.port ?? 7420,
    backupRetention: DEFAULT_BACKUP_RETENTION,
    gatewayRestartCommand: "openclaw gateway restart",
    orphanEnvKeys: listOrphanEnvKeys(currentPaths().stateDir)
  }));

  app.post("/api/settings/orphans/cleanup", (c) => {
    try {
      const result = cleanupOrphanEnvKeys(currentPaths());
      return c.json({
        ok: true,
        removedKeys: result.removedKeys,
        ...(result.backupDir ? { backupId: result.backupDir.split("/").pop() } : {})
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  return app;
}
