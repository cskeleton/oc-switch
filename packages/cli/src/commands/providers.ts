import {
  addCustomProvider,
  addProviderFromPreset,
  applyModelMetadataSyncPlan,
  batchAddProviderModels,
  batchRemoveProviderModels,
  createConfigAdapter,
  disableProvider,
  discoverProviderModels,
  editProvider,
  mergeProviderCaseDuplicates,
  normalizeModelRefForStorage,
  normalizeProviderId,
  loadPreset,
  isProviderDisabled,
  getDisabledProviderState,
  planProviderModelMetadataSync,
  readModelMetadataQueue,
  recordModelMetadataSyncQueue,
  removeDisabledProviderState,
  removeProvider,
  resolveModelMetadataQueue,
  restoreDisabledProvider,
  summarizeConfigDiff,
  upsertDisabledProviderState,
  writeModelMetadataQueue,
  writeOpenClawTransaction
} from "@oc-switch/core";
import type { ApiType, ModelMetadataQueueResolveAction, ModelMetadataQueueResolveResult } from "@oc-switch/core";
import type { Command } from "commander";
import type { CommandContext } from "../command-context";

function printResolveResult(result: ModelMetadataQueueResolveResult): void {
  for (const item of result.applied) console.log(`已回填 ${item.modelId}: ${Object.keys(item.filled).join(", ")}`);
  if (result.dismissedCount > 0) console.log(`已忽略 ${result.dismissedCount} 项`);
  for (const failure of result.failed) console.log(`失败: ${failure.providerId}/${failure.modelId}: ${failure.error}`);
}

/** 队列解决：有字段变更走写事务（自动备份），否则只更新队列文件 */
async function resolveQueueActions(
  context: CommandContext,
  actions: ModelMetadataQueueResolveAction[]
): Promise<void> {
  const paths = context.activePaths();
  const preview = resolveModelMetadataQueue(context.readConfig(), readModelMetadataQueue(paths.stateDir), actions);
  if (!preview.configChanged) {
    writeModelMetadataQueue(paths.stateDir, preview.queue);
    printResolveResult(preview);
    return;
  }
  let resolved = preview;
  await writeOpenClawTransaction({
    ...paths,
    runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
    reason: "resolve model metadata sync queue",
    mutate(config) {
      resolved = resolveModelMetadataQueue(config, readModelMetadataQueue(paths.stateDir), actions);
      return resolved.config;
    },
    afterWrite() {
      writeModelMetadataQueue(paths.stateDir, resolved.queue);
    }
  });
  printResolveResult(resolved);
}

export function registerProviderCommands(program: Command, context: CommandContext): void {
  const providers = program.command("providers");
  providers.command("list").action(() => {
    const paths = context.activePaths();
    const rows = createConfigAdapter(context.readConfig(), {
      pluginProviders: context.pluginCatalog(paths).providers
    }).listProviders();
    for (const row of rows) {
      const status = row.source === "plugin"
        ? (row.disabled ? "disabled" : "enabled")
        : isProviderDisabled(paths.stateDir, row.id) ? "disabled" : "enabled";
      const marker = row.source === "plugin" ? "\tplugin" : "";
      console.log(`${row.id}\t${row.api ?? "unknown"}\t${status}\t${row.enabledModelCount}/${row.modelCount}${marker}`);
    }
  });

  providers
    .command("merge-duplicates")
    .requiredOption("--group <key>", "case-insensitive 分组 key")
    .requiredOption("--keep <id>", "保留的 canonical Provider ID")
    .requiredOption("--remove <ids>", "逗号分隔的待删除 Provider ID")
    .option("--dry-run", "仅打印 diff，不写入")
    .action(async (options) => {
      const removeIds = context.parseModelIds(options.remove);
      const input = { groupKey: options.group, canonicalId: options.keep, removeIds };
      if (options.dryRun) {
        const before = context.readConfig();
        const after = mergeProviderCaseDuplicates(structuredClone(before), input).config;
        console.log(JSON.stringify(summarizeConfigDiff(before, after), null, 2));
        return;
      }
      const result = await writeOpenClawTransaction({
        ...context.activePaths(),
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: `merge case duplicate ${input.groupKey} -> ${input.canonicalId}`,
        mutate(config) {
          return mergeProviderCaseDuplicates(config, input).config;
        },
        afterWrite() {
          for (const providerId of [input.canonicalId, ...input.removeIds]) {
            removeDisabledProviderState(context.activePaths().stateDir, providerId);
          }
        }
      });
      console.log(`已合并 ${removeIds.join(", ")} → ${options.keep}（备份 ${result.backupDir.split("/").pop()}）`);
    });

  const provider = program.command("provider");
  provider.command("add")
    .argument("<preset-id>")
    .requiredOption("--key <api-key>", "API key value")
    .option("--models <ids>", "Comma-separated model ids to enable", (value: string) => value.split(",").map((id) => id.trim()).filter(Boolean))
    .option("--confirm-migration", "确认将块外同名 env 变量迁入 oc-switch 托管块")
    .option("--confirm-complex", "确认将重复或复杂 env 语法改写成标准 KEY=<new value>")
    .action(async (presetId: string, options: { key: string; models?: string[]; confirmMigration?: boolean; confirmComplex?: boolean }) => {
      const paths = context.activePaths();
      const preset = loadPreset(context.presetDirs(), presetId);
      const enabledModels = options.models ?? preset.models.map((model) => model.id);
      await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: `add provider ${presetId}`,
        envUpdates: { [preset.provider.apiKeyEnv]: options.key },
        envUpdateOptions: {
          ...(options.confirmMigration ? { confirmMigration: true } : {}),
          ...(options.confirmComplex ? { confirmComplex: true } : {})
        },
        manifestUpdates: [
          { type: "upsert-provider-env", providerId: presetId, envVar: preset.provider.apiKeyEnv }
        ],
        mutate(config) {
          return addProviderFromPreset(config, preset, enabledModels).config;
        }
      });
      console.log(`Added provider ${presetId}`);
    });

  provider.command("add-custom")
    .requiredOption("--id <provider-id>")
    .requiredOption("--name <display-name>")
    .requiredOption("--api <api-type>")
    .requiredOption("--base-url <url>")
    .requiredOption("--key <api-key>")
    .requiredOption("--models <ids>", "Comma-separated model ids")
    .option("--aliases <pairs>", "Comma-separated model:alias pairs")
    .option("--env <env-var>")
    .option("--notes <text>")
    .option("--website <url>")
    .option("--full-url")
    .option("--disable-by-default")
    .option("--confirm-migration", "确认将块外同名 env 变量迁入 oc-switch 托管块")
    .option("--confirm-complex", "确认将重复或复杂 env 语法改写成标准 KEY=<new value>")
    .action(async (options: {
      id: string;
      name: string;
      api: "openai-completions" | "anthropic-messages" | "google-generative-ai";
      baseUrl: string;
      key: string;
      models: string;
      aliases?: string;
      env?: string;
      notes?: string;
      website?: string;
      fullUrl?: boolean;
      disableByDefault?: boolean;
      confirmMigration?: boolean;
      confirmComplex?: boolean;
    }) => {
      const paths = context.activePaths();
      const aliasMap = context.parseAliasMap(options.aliases);
      const input = {
        providerId: options.id,
        displayName: options.name,
        ...(options.notes !== undefined ? { notes: options.notes } : {}),
        ...(options.website !== undefined ? { websiteUrl: options.website } : {}),
        api: options.api,
        baseUrl: options.baseUrl,
        isFullUrl: Boolean(options.fullUrl),
        apiKeyEnv: options.env ?? context.defaultEnvName(options.id),
        models: context.parseModelIds(options.models).map((id) => ({
          id,
          ...(aliasMap.get(id) ? { alias: aliasMap.get(id)! } : {})
        })),
        enableAllModels: !options.disableByDefault
      };
      await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: `add custom provider ${input.providerId}`,
        envUpdates: { [input.apiKeyEnv]: options.key },
        envUpdateOptions: {
          ...(options.confirmMigration ? { confirmMigration: true } : {}),
          ...(options.confirmComplex ? { confirmComplex: true } : {})
        },
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
      console.log(`Added custom provider ${input.providerId}`);
    });

  provider.command("edit")
    .argument("<name>")
    .option("--base-url <url>")
    .option("--api <api-type>")
    .option("--key <api-key>", "API key value")
    .option("--confirm-migration", "确认将块外同名 env 变量迁入 oc-switch 托管块")
    .option("--confirm-complex", "确认将重复或复杂 env 语法改写成标准 KEY=<new value>")
    .action(async (name: string, options: { baseUrl?: string; api?: ApiType; key?: string; confirmMigration?: boolean; confirmComplex?: boolean }) => {
      const paths = context.activePaths();
      const envUpdates: Record<string, string> = {};
      if (options.key) {
        const config = context.readConfig();
        const envId = context.providerEnvVar(config, name);
        if (!envId) throw new Error(`Provider ${name} has no env key reference`);
        envUpdates[envId] = options.key;
      }
      await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: `edit provider ${name}`,
        ...(Object.keys(envUpdates).length ? { envUpdates } : {}),
        ...(Object.keys(envUpdates).length
          ? {
              envUpdateOptions: {
                ...(options.confirmMigration ? { confirmMigration: true } : {}),
                ...(options.confirmComplex ? { confirmComplex: true } : {})
              },
              manifestUpdates: Object.keys(envUpdates).map((envVar) => ({
                type: "upsert-provider-env" as const,
                providerId: name,
                envVar
              }))
            }
          : {}),
        mutate(config) {
          const changes: { baseUrl?: string; api?: ApiType } = {};
          if (options.baseUrl !== undefined) changes.baseUrl = options.baseUrl;
          if (options.api !== undefined) changes.api = options.api;
          return editProvider(config, name, changes).config;
        }
      });
      console.log(`Updated provider ${name}`);
    });

  provider.command("delete")
    .argument("<name>")
    .option("--force")
    .option("--new-primary <ref>")
    .action(async (name: string, options: { force?: boolean; newPrimary?: string }) => {
      const paths = context.activePaths();
      const removeOptions: { force: boolean; newPrimary?: string } = { force: Boolean(options.force) };
      if (options.newPrimary !== undefined) removeOptions.newPrimary = options.newPrimary;
      const config = context.readConfig();
      const envVar = context.providerEnvVar(config, name);
      await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: `delete provider ${name}`,
        ...(envVar
          ? { manifestUpdates: [{ type: "mark-provider-orphan" as const, providerId: name, envVar }] }
          : {}),
        mutate(config) {
          return removeProvider(config, name, removeOptions).config;
        },
        afterWrite() {
          removeDisabledProviderState(paths.stateDir, name);
        }
      });
      console.log(`Deleted provider ${name}`);
    });

  provider.command("disable")
    .argument("<name>")
    .action(async (name: string) => {
      const paths = context.activePaths();
      let disabledState: { allowlistEntries: Record<string, unknown> } | undefined;
      await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: `disable provider ${name}`,
        mutate(config) {
          const result = disableProvider(config, name);
          disabledState = result.disabledState;
          return result.config;
        },
        afterWrite() {
          if (!disabledState) throw new Error(`Provider ${name} disable state was not produced`);
          upsertDisabledProviderState(paths.stateDir, {
            providerId: name,
            openclawPath: paths.openclawPath,
            disabledAt: new Date().toISOString(),
            allowlistEntries: disabledState.allowlistEntries as never
          });
        }
      });
      console.log(`Disabled provider ${name} (${Object.keys(disabledState?.allowlistEntries ?? {}).length} model(s) hidden)`);
    });

  provider.command("enable")
    .argument("<name>")
    .action(async (name: string) => {
      const paths = context.activePaths();
      const snapshot = getDisabledProviderState(paths.stateDir, name);
      if (!snapshot) throw new Error(`Provider ${name} has no disabled state snapshot`);
      if (snapshot.openclawPath !== paths.openclawPath) {
        throw new Error(`Provider ${name} disabled snapshot belongs to another OpenClaw config`);
      }
      await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: `enable provider ${name}`,
        mutate(config) {
          return restoreDisabledProvider(config, name, snapshot.allowlistEntries).config;
        },
        afterWrite() {
          removeDisabledProviderState(paths.stateDir, name);
        }
      });
      console.log(`Enabled provider ${name} (${Object.keys(snapshot.allowlistEntries).length} model(s) restored)`);
    });

  provider.command("sync")
    .argument("<name>")
    .description("发现远端模型目录（只读）。Breaking：旧版无参 sync 全量入库已移除；写入请用 --add")
    .option("--add <ids>", "逗号分隔的 raw model id，批量写入目录")
    .option("--enable", "同时将 --add 的模型写入 allowlist", false)
    .action(async (name: string, options: { add?: string; enable?: boolean }) => {
      if (options.add !== undefined) {
        context.assertProviderCanEnable(name);
        const ids = context.parseModelIds(options.add);
        if (ids.length === 0) throw new Error("--add requires at least one model id");
        let addedModelIds: string[] = [];
        await writeOpenClawTransaction({
          ...context.activePaths(),
          runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
          reason: `batch-add models for provider ${name}`,
          mutate(config) {
            const batch = batchAddProviderModels(config, name, {
              models: ids.map((id) => ({ id })),
              enable: Boolean(options.enable)
            });
            addedModelIds = batch.addedModelIds;
            return batch.config;
          }
        });
        console.log(`已添加 ${addedModelIds.length} 个模型: ${addedModelIds.join(", ")}`);
        return;
      }

      const config = context.readConfig();
      const fetchImpl = context.mockSyncFetch();
      const envContent = context.readEnvContent();
      const result = await discoverProviderModels(config, name, {
        fetchImpl: fetchImpl ?? fetch,
        ...(envContent !== undefined ? { envContent } : {})
      });
      if (result.unsupportedReason) {
        console.log(result.unsupportedReason);
        return;
      }
      if (result.truncated && result.truncationReason) {
        console.log(`警告: ${result.truncationReason}`);
      }
      const addedSet = new Set(result.alreadyAddedIds);
      for (const model of result.remoteModels) {
        const label = model.name ? `${model.id} (${model.name})` : model.id;
        console.log(addedSet.has(model.id) ? `${label} [已添加]` : label);
      }
      console.log(
        `发现 ${result.remoteModels.length} 个远端模型，其中 ${result.alreadyAddedIds.length} 个已添加`
      );
    });

  provider.command("sync-metadata")
    .argument("<name>")
    .description("从 models.dev 批量回填本地模型缺失参数（只填空缺；歧义进确认队列）")
    .option("--models <ids>", "逗号分隔的 raw model id，缺省整 provider")
    .option("--refresh", "绕过 24h 缓存强制刷新 models.dev 目录", false)
    .action(async (name: string, options: { models?: string; refresh?: boolean }) => {
      const paths = context.activePaths();
      const modelIds = options.models !== undefined ? context.parseModelIds(options.models) : undefined;
      if (modelIds !== undefined && modelIds.length === 0) throw new Error("--models requires at least one model id");
      const plan = await planProviderModelMetadataSync(
        context.readConfig(),
        { providerId: name, ...(modelIds !== undefined ? { modelIds } : {}) },
        {
          stateDir: paths.stateDir,
          fetchImpl: context.mockMetadataFetch() ?? fetch,
          ...(options.refresh ? { forceRefresh: true } : {})
        }
      );
      let updatedCount = 0;
      if (plan.applies.length > 0) {
        await writeOpenClawTransaction({
          ...paths,
          runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
          reason: `sync model metadata for provider ${name}`,
          mutate(config) {
            const applied = applyModelMetadataSyncPlan(config, plan);
            updatedCount = applied.updated.length;
            return applied.config;
          },
          afterWrite() {
            recordModelMetadataSyncQueue(paths.stateDir, plan);
          }
        });
      } else {
        recordModelMetadataSyncQueue(paths.stateDir, plan);
      }
      console.log(`已回填 ${updatedCount} 个模型，待确认 ${plan.queued.length}，未匹配 ${plan.unmatched.length}，参数齐全跳过 ${plan.skipped.length}`);
      for (const item of plan.queued) console.log(`  待确认: ${item.modelId}（${item.candidates.length} 个候选）`);
      for (const id of plan.unmatched) console.log(`  未匹配: ${id}`);
    });

  const metadataQueue = provider.command("metadata-queue").description("模型参数同步确认队列");

  metadataQueue.command("list")
    .option("--provider <id>", "只看指定 provider")
    .action((options: { provider?: string }) => {
      const queue = readModelMetadataQueue(context.activePaths().stateDir);
      // --provider 过滤大小写折叠：队列项可能存着归一化前的大写 key
      const items = options.provider
        ? queue.items.filter((item) => normalizeProviderId(item.providerId) === normalizeProviderId(options.provider!))
        : queue.items;
      if (items.length === 0) {
        console.log("确认队列为空");
        return;
      }
      for (const item of items) {
        const flag = item.dismissed ? " [已忽略]" : "";
        console.log(`${item.providerId}/${item.modelId}${flag}`);
        for (const candidate of item.candidates) {
          console.log(`  - ${candidate.catalogKey} (score ${candidate.score.toFixed(2)}, ${candidate.reason})`);
        }
      }
    });

  metadataQueue.command("accept")
    .argument("<providerId>")
    .argument("<modelId>")
    .requiredOption("--catalog <catalogKey>", "选中的目录候选 catalogKey")
    .action(async (providerId: string, modelId: string, options: { catalog: string }) => {
      await resolveQueueActions(context, [{ providerId, modelId, action: "accept", catalogKey: options.catalog }]);
    });

  metadataQueue.command("dismiss")
    .argument("<providerId>")
    .argument("<modelId>")
    .action(async (providerId: string, modelId: string) => {
      await resolveQueueActions(context, [{ providerId, modelId, action: "dismiss" }]);
    });

  provider
    .command("models")
    .command("remove")
    .argument("<providerId>")
    .description("批量删除 provider 本地模型目录项")
    .option("--ids <ids>", "逗号分隔的 raw model id")
    .option("--keep-enabled-only", "仅保留 allowlist 中的模型（及主模型目录项）", false)
    .action(async (providerId: string, options: { ids?: string; keepEnabledOnly?: boolean }) => {
      const hasIds = options.ids !== undefined && context.parseModelIds(options.ids).length > 0;
      const hasKeepEnabledOnly = Boolean(options.keepEnabledOnly);
      if (hasIds && hasKeepEnabledOnly) {
        throw new Error("--ids and --keep-enabled-only are mutually exclusive");
      }
      if (!hasIds && !hasKeepEnabledOnly) {
        throw new Error("require one of --ids or --keep-enabled-only");
      }

      const paths = context.activePaths();
      let removedModelIds: string[] = [];
      const input = hasKeepEnabledOnly
        ? ({ keepEnabledOnly: true as const })
        : ({ modelIds: context.parseModelIds(options.ids!) });

      await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: `batch-remove models for provider ${providerId}`,
        mutate(config) {
          const inventory = context.buildInventory({ refresh: true, config, paths });
          const batch = batchRemoveProviderModels(config, providerId, input);
          for (const modelId of batch.removedModelIds) {
            const ref = normalizeModelRefForStorage(`${providerId}/${modelId}`);
            const entry = inventory.models.find(model => normalizeModelRefForStorage(model.ref) === ref);
            if (!entry || entry.availability === "unknown") throw new Error("Runtime model availability is unknown; refresh before cleaning its catalog entry.");
          }
          removedModelIds = batch.removedModelIds;
          return batch.config;
        }
      });
      console.log(`已删除 ${removedModelIds.length} 个模型: ${removedModelIds.join(", ")}`);
    });
}
