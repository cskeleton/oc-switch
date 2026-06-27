import {
  addCustomProvider,
  addProviderFromPreset,
  applySyncedModels,
  createConfigAdapter,
  disableProvider,
  editProvider,
  mergeProviderCaseDuplicates,
  loadPreset,
  readProviderStates,
  removeDisabledProviderState,
  removeProvider,
  restoreDisabledProvider,
  summarizeConfigDiff,
  syncProviderModels,
  upsertDisabledProviderState,
  writeOpenClawTransaction
} from "@oc-switch/core";
import type { Command } from "commander";
import type { CommandContext } from "../command-context";

export function registerProviderCommands(program: Command, context: CommandContext): void {
  const providers = program.command("providers");
  providers.command("list").action(() => {
    const paths = context.activePaths();
    const states = readProviderStates(paths.stateDir);
    const rows = createConfigAdapter(context.readConfig()).listProviders();
    for (const row of rows) {
      const status = states.disabledProviders[row.id] ? "disabled" : "enabled";
      console.log(`${row.id}\t${row.api ?? "unknown"}\t${status}\t${row.enabledModelCount}/${row.modelCount}`);
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
        reason: `merge case duplicate ${input.groupKey} -> ${input.canonicalId}`,
        mutate(config) {
          return mergeProviderCaseDuplicates(config, input).config;
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
    .option("--key <api-key>", "API key value")
    .option("--confirm-migration", "确认将块外同名 env 变量迁入 oc-switch 托管块")
    .option("--confirm-complex", "确认将重复或复杂 env 语法改写成标准 KEY=<new value>")
    .action(async (name: string, options: { baseUrl?: string; key?: string; confirmMigration?: boolean; confirmComplex?: boolean }) => {
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
          const changes: { baseUrl?: string } = {};
          if (options.baseUrl !== undefined) changes.baseUrl = options.baseUrl;
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
        reason: `delete provider ${name}`,
        ...(envVar
          ? { manifestUpdates: [{ type: "mark-provider-orphan" as const, providerId: name, envVar }] }
          : {}),
        mutate(config) {
          return removeProvider(config, name, removeOptions).config;
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
      const snapshot = readProviderStates(paths.stateDir).disabledProviders[name];
      if (!snapshot) throw new Error(`Provider ${name} has no disabled state snapshot`);
      if (snapshot.openclawPath !== paths.openclawPath) {
        throw new Error(`Provider ${name} disabled snapshot belongs to another OpenClaw config`);
      }
      await writeOpenClawTransaction({
        ...paths,
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
    .action(async (name: string) => {
      const paths = context.activePaths();
      const config = context.readConfig();
      const fetchImpl = context.mockSyncFetch();
      const envContent = context.readEnvContent();
      const result = await syncProviderModels(config, name, {
        fetchImpl: fetchImpl ?? fetch,
        ...(envContent !== undefined ? { envContent } : {})
      });
      if (result.unsupportedReason) {
        console.log(result.unsupportedReason);
        return;
      }
      if (result.addedModelIds.length === 0) {
        console.log("No new models to add");
        return;
      }
      await writeOpenClawTransaction({
        ...paths,
        reason: `sync provider ${name}`,
        mutate(current) {
          return applySyncedModels(current, name, result.addedModelIds);
        }
      });
      console.log(`Synced ${result.addedModelIds.length} model(s) for ${name}: ${result.addedModelIds.join(", ")}`);
    });
}
