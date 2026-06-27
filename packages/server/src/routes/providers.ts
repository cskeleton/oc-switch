import {
  addCustomProvider,
  addProviderFromPreset,
  applySyncedModels,
  createConfigAdapter,
  disableProvider,
  editProvider,
  inspectEnvFile,
  listProviderEnvRefs,
  loadPreset,
  mergeProviderCaseDuplicates,
  previewEnvUpdates,
  providerEnvVar,
  readManifest,
  readProviderStates,
  removeDisabledProviderState,
  removeProvider,
  restoreDisabledProvider,
  summarizeConfigDiff,
  syncProviderModels,
  upsertDisabledProviderState,
  writeOpenClawTransaction,
  type EnvVariableSummary,
  type OcSwitchPaths
} from "@oc-switch/core";
import type { Hono } from "hono";
import { providerEnvVar as contextProviderEnvVar, readConfig, readEnvContent, withDisabledStatus, type AppRuntime } from "../context";
import { jsonError } from "../errors";
import { optionalEnvUpdateOptions, requireBoolean, requireCustomProviderInput, requireMergeCaseDuplicateInput, requireString } from "../schemas";

function envStatus(summary: EnvVariableSummary | undefined) {
  if (!summary?.present) return "missing";
  if (summary.duplicate) return "duplicate";
  if (summary.complex) return "complex";
  return summary.managed ? "managed" : "unmanaged";
}

function providerEnvPreview(paths: OcSwitchPaths, envVar: string) {
  const config = readConfig(paths);
  return previewEnvUpdates({
    content: readEnvContent(paths) ?? "",
    providerRefs: listProviderEnvRefs(config),
    manifest: readManifest(paths.stateDir),
    updates: { [envVar]: "" }
  });
}

export function registerProviderRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/providers", (c) => {
    const paths = runtime.currentPaths();
    const config = readConfig(paths);
    const adapter = createConfigAdapter(config);
    const envInspection = inspectEnvFile({
      content: readEnvContent(paths) ?? "",
      providerRefs: listProviderEnvRefs(config),
      manifest: readManifest(paths.stateDir)
    });
    const providers = withDisabledStatus(paths, adapter.listProviders()).map((provider) => {
      const apiKeyEnv = providerEnvVar(config.models?.providers?.[provider.id]) ?? null;
      const summary = apiKeyEnv
        ? envInspection.variables.find((item) => item.envVar === apiKeyEnv)
        : undefined;
      return {
        ...provider,
        apiKeyEnv,
        apiKeyEnvManaged: Boolean(summary?.managed),
        apiKeyEnvStatus: apiKeyEnv ? envStatus(summary) : "missing"
      };
    });
    return c.json({ providers });
  });

  app.post("/api/providers", async (c) => {
    try {
      const body = await c.req.json();
      const presetId = requireString(body.presetId, "presetId");
      const apiKey = requireString(body.apiKey, "apiKey");
      const models = Array.isArray(body.models)
        ? body.models.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
        : undefined;
      const preset = loadPreset(runtime.presetDirs, presetId);
      const enabledModels = models ?? preset.models.map((model) => model.id);
      const result = await writeOpenClawTransaction({
        ...runtime.currentPaths(),
        reason: `add provider ${presetId}`,
        envUpdates: { [preset.provider.apiKeyEnv]: apiKey },
        envUpdateOptions: optionalEnvUpdateOptions(body as Record<string, unknown>),
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
      const preset = loadPreset(runtime.presetDirs, presetId);
      const before = readConfig(runtime.currentPaths());
      const enabledModels = models ?? preset.models.map((model) => model.id);
      const after = addProviderFromPreset(structuredClone(before), preset, enabledModels).config;
      return c.json({
        ...summarizeConfigDiff(before, after),
        envPreview: providerEnvPreview(runtime.currentPaths(), preset.provider.apiKeyEnv)
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/providers/custom/preview", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const input = requireCustomProviderInput(body);
      const before = readConfig(runtime.currentPaths());
      const after = addCustomProvider(structuredClone(before), input).config;
      return c.json({
        ...summarizeConfigDiff(before, after),
        envPreview: providerEnvPreview(runtime.currentPaths(), input.apiKeyEnv)
      });
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
        ...runtime.currentPaths(),
        reason: `add custom provider ${input.providerId}`,
        envUpdates: { [input.apiKeyEnv]: apiKey },
        envUpdateOptions: optionalEnvUpdateOptions(body),
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
      const before = readConfig(runtime.currentPaths());
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
        ...runtime.currentPaths(),
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

  app.patch("/api/providers/:id/state", async (c) => {
    try {
      const providerId = c.req.param("id");
      const body = await c.req.json() as Record<string, unknown>;
      const enabled = requireBoolean(body.enabled, "enabled");
      const paths = runtime.currentPaths();

      if (!enabled) {
        let disabledState: { providerId: string; allowlistEntries: Record<string, unknown> } | undefined;
        const result = await writeOpenClawTransaction({
          ...paths,
          reason: `disable provider ${providerId}`,
          mutate(config) {
            const disabled = disableProvider(config, providerId);
            disabledState = disabled.disabledState;
            return disabled.config;
          },
          afterWrite() {
            if (!disabledState) throw new Error(`Provider ${providerId} disable state was not produced`);
            upsertDisabledProviderState(paths.stateDir, {
              providerId,
              openclawPath: paths.openclawPath,
              disabledAt: new Date().toISOString(),
              allowlistEntries: disabledState.allowlistEntries as never
            });
          }
        });
        return c.json({
          ok: true,
          providerId,
          enabled: false,
          disabledModelCount: Object.keys(disabledState?.allowlistEntries ?? {}).length,
          backupId: result.backupDir.split("/").pop()
        });
      }

      const states = readProviderStates(paths.stateDir);
      const snapshot = states.disabledProviders[providerId];
      if (!snapshot) throw new Error(`Provider ${providerId} has no disabled state snapshot`);
      if (snapshot.openclawPath !== paths.openclawPath) {
        throw new Error(`Provider ${providerId} disabled snapshot belongs to another OpenClaw config`);
      }
      const result = await writeOpenClawTransaction({
        ...paths,
        reason: `enable provider ${providerId}`,
        mutate(config) {
          return restoreDisabledProvider(config, providerId, snapshot.allowlistEntries).config;
        },
        afterWrite() {
          removeDisabledProviderState(paths.stateDir, providerId);
        }
      });
      return c.json({
        ok: true,
        providerId,
        enabled: true,
        restoredModelCount: Object.keys(snapshot.allowlistEntries).length,
        backupId: result.backupDir.split("/").pop()
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/providers/:id/preview", async (c) => {
    try {
      const providerId = c.req.param("id");
      const body = await c.req.json() as Record<string, unknown>;
      const paths = runtime.currentPaths();
      const config = readConfig(paths);
      const changes: { baseUrl?: string } = {};
      if (body.baseUrl !== undefined) changes.baseUrl = requireString(body.baseUrl, "baseUrl");
      const after = editProvider(structuredClone(config), providerId, changes).config;
      const diff = summarizeConfigDiff(config, after);
      if (body.includeApiKeyEnv === true) {
        const envVar = contextProviderEnvVar(config, providerId);
        if (!envVar) throw new Error(`Provider ${providerId} has no env key reference`);
        return c.json({ ...diff, envPreview: providerEnvPreview(paths, envVar) });
      }
      return c.json(diff);
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
        const config = readConfig(runtime.currentPaths());
        const envId = contextProviderEnvVar(config, providerId);
        if (!envId) throw new Error(`Provider ${providerId} has no env key reference`);
        envUpdates[envId] = requireString(body.apiKey, "apiKey");
      }
      const result = await writeOpenClawTransaction({
        ...runtime.currentPaths(),
        reason: `edit provider ${providerId}`,
        ...(Object.keys(envUpdates).length ? { envUpdates } : {}),
        ...(Object.keys(envUpdates).length
          ? {
              envUpdateOptions: optionalEnvUpdateOptions(body as Record<string, unknown>),
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
      const config = readConfig(runtime.currentPaths());
      const envVar = contextProviderEnvVar(config, providerId);
      const result = await writeOpenClawTransaction({
        ...runtime.currentPaths(),
        reason: `delete provider ${providerId}`,
        ...(envVar
          ? { manifestUpdates: [{ type: "mark-provider-orphan" as const, providerId, envVar }] }
          : {}),
        mutate(config) {
          return removeProvider(config, providerId, removeOptions).config;
        },
        afterWrite() {
          removeDisabledProviderState(runtime.currentPaths().stateDir, providerId);
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
      const config = readConfig(runtime.currentPaths());
      const envContent = readEnvContent(runtime.currentPaths());
      const syncResult = await syncProviderModels(config, providerId, {
        fetchImpl: runtime.fetchImpl,
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
        ...runtime.currentPaths(),
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
}
