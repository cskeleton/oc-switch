import {
  addCustomProvider,
  addProviderFromPreset,
  applyModelMetadataSyncPlan,
  batchAddProviderModels,
  batchRemoveProviderModels,
  createConfigAdapter,
  disableProvider,
  discoverProviderModels,
  discoverProviderModelsFromCredentials,
  editProvider,
  inspectEnvFile,
  inspectGatewayServiceEnvKeyStates,
  inspectProviderSecretRefMigrations,
  listProviderEnvRefs,
  loadPreset,
  mergeProviderCaseDuplicates,
  migrateProviderSecretRefs,
  planProviderModelMetadataSync,
  previewEnvUpdates,
  providerEnvVar,
  readEnvValue,
  readManifest,
  recordModelMetadataSyncQueue,
  resolveGatewayRuntimeTarget,
  getDisabledProviderState,
  removeDisabledProviderState,
  removeProvider,
  restoreDisabledProvider,
  summarizeConfigDiff,
  upsertDisabledProviderState,
  writeOpenClawTransaction,
  type ApiType,
  type EnvVariableSummary,
  type ModelMetadataSyncUpdated,
  type OcSwitchPaths
} from "@oc-switch/core";
import type { Context, Hono } from "hono";
import {
  assertProviderCanEnable,
  providerEnvVar as contextProviderEnvVar,
  readConfig,
  readDisabledProviderIds,
  readEnvContent,
  type AppRuntime
} from "../context";
import { jsonError } from "../errors";
import {
  optionalEnvUpdateOptions,
  requireBatchAddProviderModelsInput,
  requireBatchRemoveProviderModelsInput,
  requireApiType,
  requireBoolean,
  requireCustomProviderInput,
  requireProviderDiscoverPreviewInput,
  requireMergeCaseDuplicateInput,
  requireString,
  requireSyncModelMetadataInput
} from "../schemas";

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

type SecretRefMigrationBlocker =
  | "source-env-missing"
  | "source-env-empty"
  | "source-env-duplicate"
  | "source-env-complex"
  | "gateway-target-unavailable"
  | "gateway-env-drift";

function inspectSecretRefMigrations(runtime: AppRuntime) {
  const paths = runtime.currentPaths();
  const config = readConfig(paths);
  const migrationCandidates = inspectProviderSecretRefMigrations(config);
  const envContent = readEnvContent(paths) ?? "";
  const envInspection = inspectEnvFile({
    content: envContent,
    providerRefs: listProviderEnvRefs(config),
    manifest: readManifest(paths.stateDir)
  });
  const envByName = new Map(envInspection.variables.map((variable) => [variable.envVar, variable]));

  const sourceEntries = Object.fromEntries(migrationCandidates.flatMap((candidate) => {
    const value = readEnvValue(envContent, candidate.envVar);
    return value === undefined ? [] : [[candidate.envVar, value]];
  }));
  let gatewayStates: Record<string, "missing" | "equal" | "different"> | undefined;
  try {
    const target = resolveGatewayRuntimeTarget({
      activePaths: { openclawPath: paths.openclawPath, envPath: paths.envPath },
      discovery: runtime.runtimeDiscoveryProvider(),
      mode: "automatic"
    });
    gatewayStates = inspectGatewayServiceEnvKeyStates({
      target: target.serviceEnvTarget,
      sourceEntries,
      keys: migrationCandidates.map((candidate) => candidate.envVar)
    });
  } catch {
    gatewayStates = undefined;
  }

  const candidates = migrationCandidates.map((candidate) => {
    const source = envByName.get(candidate.envVar);
    const blockers: SecretRefMigrationBlocker[] = [];
    if (!source?.present) blockers.push("source-env-missing");
    if (source?.empty) blockers.push("source-env-empty");
    if (source?.duplicate) blockers.push("source-env-duplicate");
    if (source?.complex) blockers.push("source-env-complex");
    if (!gatewayStates) blockers.push("gateway-target-unavailable");
    else if (gatewayStates[candidate.envVar] === "different") blockers.push("gateway-env-drift");
    return {
      ...candidate,
      status: blockers.length ? "blocked" as const : "ready" as const,
      blockers
    };
  });

  return {
    candidates,
    summary: {
      candidateCount: candidates.length,
      readyCount: candidates.filter((candidate) => candidate.status === "ready").length,
      blockedCount: candidates.filter((candidate) => candidate.status === "blocked").length
    }
  };
}

/** 只读发现远端模型目录；不写配置、不建备份 */
async function handleProviderDiscover(c: Context, runtime: AppRuntime) {
  const providerId = requireString(c.req.param("id"), "id");
  const config = readConfig(runtime.currentPaths());
  const envContent = readEnvContent(runtime.currentPaths());
  const discoverResult = await discoverProviderModels(config, providerId, {
    fetchImpl: runtime.fetchImpl,
    ...(envContent !== undefined ? { envContent } : {})
  });
  if (discoverResult.unsupportedReason) {
    return c.json({
      ok: false,
      providerId: discoverResult.providerId,
      remoteModels: [],
      alreadyAddedIds: [],
      truncated: false,
      unsupportedReason: discoverResult.unsupportedReason
    });
  }
  return c.json({
    ok: true,
    providerId: discoverResult.providerId,
    remoteModels: discoverResult.remoteModels,
    alreadyAddedIds: discoverResult.alreadyAddedIds,
    truncated: discoverResult.truncated,
    ...(discoverResult.truncationReason !== undefined
      ? { truncationReason: discoverResult.truncationReason }
      : {})
  });
}

export function registerProviderRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/providers/secret-ref-migrations", (c) => {
    try {
      return c.json(inspectSecretRefMigrations(runtime));
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/providers/secret-ref-migrations", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      if (body.confirm !== true) throw new Error("SecretRef migration requires explicit confirmation");
      if (!Array.isArray(body.providerIds) || body.providerIds.length === 0) {
        throw new Error("providerIds must be a non-empty array");
      }
      const providerIds = body.providerIds.map((value) => requireString(value, "providerId"));
      if (new Set(providerIds).size !== providerIds.length) throw new Error("providerIds must not contain duplicates");

      const preview = inspectSecretRefMigrations(runtime);
      const candidates = new Map(preview.candidates.map((candidate) => [candidate.providerId, candidate]));
      for (const providerId of providerIds) {
        const candidate = candidates.get(providerId);
        if (!candidate) throw new Error(`Provider ${providerId} is not an eligible SecretRef migration candidate`);
        if (candidate.blockers.length) {
          throw new Error(`Provider ${providerId} SecretRef migration blocked: ${candidate.blockers.join(",")}`);
        }
      }

      const result = await writeOpenClawTransaction({
        ...runtime.currentPaths(),
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: `migrate Provider SecretRefs: ${providerIds.join(", ")}`,
        mutate(config) {
          return migrateProviderSecretRefs(config, providerIds).config;
        }
      });
      return c.json({
        ok: true,
        migratedProviderIds: providerIds,
        backupId: result.backupDir.split("/").pop(),
        gatewayRestartRequired: true
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.get("/api/providers", (c) => {
    const paths = runtime.currentPaths();
    const config = readConfig(paths);
    const adapter = createConfigAdapter(config, {
      disabledProviderIds: readDisabledProviderIds(paths)
    });
    const envInspection = inspectEnvFile({
      content: readEnvContent(paths) ?? "",
      providerRefs: listProviderEnvRefs(config),
      manifest: readManifest(paths.stateDir)
    });
    const providers = adapter.listProviders().map((provider) => {
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
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
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
      return c.json({
        ok: true,
        backupId: result.backupDir.split("/").pop(),
        ...(result.envWrite ? { envWrite: result.envWrite } : {}),
        ...(result.gatewayEnvSync ? { gatewayEnvSync: result.gatewayEnvSync } : {})
      });
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
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
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
      return c.json({
        ok: true,
        backupId: result.backupDir.split("/").pop(),
        ...(result.envWrite ? { envWrite: result.envWrite } : {}),
        ...(result.gatewayEnvSync ? { gatewayEnvSync: result.gatewayEnvSync } : {})
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/providers/discover-preview", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const input = requireProviderDiscoverPreviewInput(body);
      const discoverResult = await discoverProviderModelsFromCredentials(input, {
        fetchImpl: runtime.fetchImpl
      });
      if (discoverResult.unsupportedReason) {
        return c.json({
          ok: false,
          providerId: discoverResult.providerId,
          remoteModels: [],
          alreadyAddedIds: [],
          truncated: false,
          unsupportedReason: discoverResult.unsupportedReason
        });
      }
      return c.json({
        ok: true,
        providerId: discoverResult.providerId,
        remoteModels: discoverResult.remoteModels,
        alreadyAddedIds: discoverResult.alreadyAddedIds,
        truncated: discoverResult.truncated,
        ...(discoverResult.truncationReason !== undefined
          ? { truncationReason: discoverResult.truncationReason }
          : {})
      });
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
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: `merge case duplicate ${input.groupKey} -> ${input.canonicalId}`,
        mutate(config) {
          const merged = mergeProviderCaseDuplicates(config, input);
          warnings = merged.warnings;
          return merged.config;
        },
        afterWrite() {
          for (const providerId of [input.canonicalId, ...input.removeIds]) {
            removeDisabledProviderState(runtime.currentPaths().stateDir, providerId);
          }
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
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
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

      const snapshot = getDisabledProviderState(paths.stateDir, providerId);
      if (!snapshot) throw new Error(`Provider ${providerId} has no disabled state snapshot`);
      if (snapshot.openclawPath !== paths.openclawPath) {
        throw new Error(`Provider ${providerId} disabled snapshot belongs to another OpenClaw config`);
      }
      const result = await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
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
      const changes: { baseUrl?: string; api?: ApiType } = {};
      if (body.baseUrl !== undefined) changes.baseUrl = requireString(body.baseUrl, "baseUrl");
      if (body.api !== undefined) changes.api = requireApiType(body.api, "api");
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
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
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
          const changes: { baseUrl?: string; api?: ApiType } = {};
          if (body.baseUrl !== undefined) changes.baseUrl = requireString(body.baseUrl, "baseUrl");
          if (body.api !== undefined) changes.api = requireApiType(body.api, "api");
          return editProvider(config, providerId, changes).config;
        }
      });
      return c.json({
        ok: true,
        backupId: result.backupDir.split("/").pop(),
        ...(result.envWrite ? { envWrite: result.envWrite } : {}),
        ...(result.gatewayEnvSync ? { gatewayEnvSync: result.gatewayEnvSync } : {})
      });
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
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
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

  app.post("/api/providers/:id/discover", async (c) => {
    try {
      return await handleProviderDiscover(c, runtime);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/providers/:id/sync", async (c) => {
    try {
      return await handleProviderDiscover(c, runtime);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/providers/:id/models/batch-add", async (c) => {
    try {
      const providerId = c.req.param("id");
      const body = await c.req.json() as Record<string, unknown>;
      const input = requireBatchAddProviderModelsInput(body);
      const paths = runtime.currentPaths();
      // disable 状态下整单拒绝，即使 enable 为 false
      assertProviderCanEnable(paths, providerId);
      let addedModelIds: string[] = [];
      let skippedModelIds: string[] = [];
      const result = await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: `batch-add models for provider ${providerId}`,
        mutate(config) {
          const batch = batchAddProviderModels(config, providerId, input);
          addedModelIds = batch.addedModelIds;
          skippedModelIds = batch.skippedModelIds;
          return batch.config;
        }
      });
      return c.json({
        ok: true,
        addedModelIds,
        skippedModelIds,
        enabled: input.enable,
        backupId: result.backupDir.split("/").pop()
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/providers/:id/models/batch-remove", async (c) => {
    try {
      const providerId = c.req.param("id");
      const body = await c.req.json() as Record<string, unknown>;
      const input = requireBatchRemoveProviderModelsInput(body);
      let removedModelIds: string[] = [];
      const result = await writeOpenClawTransaction({
        ...runtime.currentPaths(),
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: `batch-remove models for provider ${providerId}`,
        mutate(config) {
          const batch = batchRemoveProviderModels(config, providerId, input);
          removedModelIds = batch.removedModelIds;
          return batch.config;
        }
      });
      return c.json({
        ok: true,
        removedModelIds,
        backupId: result.backupDir.split("/").pop()
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/providers/:id/models/sync-metadata", async (c) => {
    try {
      const providerId = c.req.param("id");
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const input = requireSyncModelMetadataInput(body);
      const paths = runtime.currentPaths();
      // 纯元数据回填：已禁用 Provider 也允许（不触碰启用态，与批量删除同理）
      const plan = await planProviderModelMetadataSync(
        readConfig(paths),
        { providerId, ...(input.modelIds !== undefined ? { modelIds: input.modelIds } : {}) },
        { stateDir: paths.stateDir, fetchImpl: runtime.fetchImpl }
      );
      let updated: ModelMetadataSyncUpdated[] = [];
      let backupId: string | undefined;
      if (plan.applies.length > 0) {
        const result = await writeOpenClawTransaction({
          ...paths,
          runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
          reason: `sync model metadata for provider ${providerId}`,
          mutate(config) {
            const applied = applyModelMetadataSyncPlan(config, plan);
            updated = applied.updated;
            return applied.config;
          },
          afterWrite() {
            recordModelMetadataSyncQueue(paths.stateDir, plan);
          }
        });
        backupId = result.backupDir.split("/").pop();
      } else {
        recordModelMetadataSyncQueue(paths.stateDir, plan);
      }
      return c.json({
        ok: true,
        providerId: plan.providerId,
        updated,
        queued: plan.queued.map((item) => ({ modelId: item.modelId, candidateCount: item.candidates.length })),
        unmatched: plan.unmatched,
        skipped: plan.skipped,
        sources: plan.sources,
        warnings: plan.warnings,
        ...(backupId !== undefined ? { backupId } : {})
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });
}
