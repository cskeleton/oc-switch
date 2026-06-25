#!/usr/bin/env bun
import { Command } from "commander";
import JSON5 from "json5";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  addCustomProvider,
  addProviderModel,
  addProviderFromPreset,
  createConfigAdapter,
  defaultPresetDirs,
  disableModel,
  disableProvider,
  editProvider,
  enableModel,
  exportProviderPreset,
  getActivePaths,
  inspectConfigHealth,
  isProviderDisabled,
  mergeProviderCaseDuplicates,
  listBackups,
  listPresets,
  loadPreset,
  parseModelRef,
  readProviderStates,
  removeDisabledProviderState,
  removeProvider,
  removeProviderModel,
  restoreBackupSafely,
  restoreDisabledProvider,
  saveCustomPreset,
  setPrimaryModel,
  summarizeConfigDiff,
  syncProviderModels,
  applySyncedModels,
  rotatePersistedToken,
  resolveServeToken,
  upsertDisabledProviderState,
  version,
  writeOpenClawTransaction,
  type FetchImpl
} from "@oc-switch/core";
import { createApp } from "@oc-switch/server";
import type { OpenClawConfig } from "@oc-switch/core";

function activePaths() {
  return getActivePaths();
}

function readConfig(): OpenClawConfig {
  const paths = activePaths();
  return JSON5.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
}

function readEnvContent(): string | undefined {
  const paths = activePaths();
  return existsSync(paths.envPath) ? readFileSync(paths.envPath, "utf8") : undefined;
}

function assertProviderCanEnable(providerId: string): void {
  const paths = activePaths();
  if (isProviderDisabled(paths.stateDir, providerId)) {
    throw new Error(`Provider ${providerId} is disabled. Restore the provider before enabling models.`);
  }
}

function providerEnvVar(config: OpenClawConfig, providerId: string): string | undefined {
  const provider = config.models?.providers?.[providerId];
  return provider?.apiKey?.id ?? provider?.authHeader?.id;
}

function presetDirs() {
  const paths = activePaths();
  const repoRoot = join(dirname(import.meta.path), "../../..");
  return defaultPresetDirs(paths.stateDir, repoRoot);
}

function mockSyncFetch(): FetchImpl | undefined {
  const mock = process.env.OC_SWITCH_MOCK_SYNC;
  if (!mock) return undefined;
  const ids = mock.split(",").map((id) => id.trim()).filter(Boolean);
  return async () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      headers: { "content-type": "application/json" }
    });
}

function defaultEnvName(providerId: string): string {
  return `${providerId.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()}_API_KEY`;
}

function parseModelIds(value: string): string[] {
  return value.split(",").map((id) => id.trim()).filter(Boolean);
}

function parseAliasMap(value: string | undefined): Map<string, string> {
  const aliases = new Map<string, string>();
  if (!value) return aliases;
  for (const pair of value.split(",")) {
    const [id, alias] = pair.split(":").map((part) => part.trim());
    if (!id || !alias) throw new Error(`Invalid alias mapping ${pair}`);
    aliases.set(id, alias);
  }
  return aliases;
}

const program = new Command();

program
  .name("oc-switch")
  .description("Manage local OpenClaw provider and model configuration")
  .version(version);

program.command("status").action(() => {
  const status = createConfigAdapter(readConfig()).getStatus();
  console.log(`Primary: ${status.primaryModel ?? "(none)"}`);
  console.log(`Providers: ${status.providerCount}`);
  console.log(`Provider models: ${status.providerModelCount}`);
  console.log(`Allowlist models: ${status.allowlistModelCount}`);
});

program.command("health").action(() => {
  const report = inspectConfigHealth(readConfig());
  if (report.caseDuplicateGroups.length === 0) {
    console.log("未发现 Provider 大小写重复");
    return;
  }
  console.log(`发现 ${report.summary.duplicateGroupCount} 组 Provider 大小写重复：`);
  for (const group of report.caseDuplicateGroups) {
    const flag = group.mergeable ? "可合并" : "需人工核对";
    console.log(`\n[${group.groupKey}] ${group.ids.join(" / ")}  (${group.confidence}, ${flag})`);
    console.log(`  建议保留 ${group.canonicalId}，合并并删除 ${group.duplicateIds.join(", ")}`);
    for (const reason of group.reasons) console.log(`  - ${reason}`);
    if (group.mergeBlockers.length) console.log(`  ⚠ 阻断合并：${group.mergeBlockers.join("；")}`);
    if (group.mergeable) {
      console.log(`  合并命令：oc-switch providers merge-duplicates --group ${group.groupKey} --keep ${group.canonicalId} --remove ${group.duplicateIds.join(",")}`);
    }
  }
});

const providers = program.command("providers");
providers.command("list").action(() => {
  const paths = activePaths();
  const states = readProviderStates(paths.stateDir);
  const rows = createConfigAdapter(readConfig()).listProviders();
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
    const removeIds = parseModelIds(options.remove);
    const input = { groupKey: options.group, canonicalId: options.keep, removeIds };
    if (options.dryRun) {
      const before = readConfig();
      const after = mergeProviderCaseDuplicates(structuredClone(before), input).config;
      console.log(JSON.stringify(summarizeConfigDiff(before, after), null, 2));
      return;
    }
    const result = await writeOpenClawTransaction({
      ...activePaths(),
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
  .action(async (presetId: string, options: { key: string; models?: string[] }) => {
    const paths = activePaths();
    const preset = loadPreset(presetDirs(), presetId);
    const enabledModels = options.models ?? preset.models.map((model) => model.id);
    await writeOpenClawTransaction({
      ...paths,
      reason: `add provider ${presetId}`,
      envUpdates: { [preset.provider.apiKeyEnv]: options.key },
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
  }) => {
    const paths = activePaths();
    const aliasMap = parseAliasMap(options.aliases);
    const input = {
      providerId: options.id,
      displayName: options.name,
      ...(options.notes !== undefined ? { notes: options.notes } : {}),
      ...(options.website !== undefined ? { websiteUrl: options.website } : {}),
      api: options.api,
      baseUrl: options.baseUrl,
      isFullUrl: Boolean(options.fullUrl),
      apiKeyEnv: options.env ?? defaultEnvName(options.id),
      models: parseModelIds(options.models).map((id) => ({
        id,
        ...(aliasMap.get(id) ? { alias: aliasMap.get(id)! } : {})
      })),
      enableAllModels: !options.disableByDefault
    };
    await writeOpenClawTransaction({
      ...paths,
      reason: `add custom provider ${input.providerId}`,
      envUpdates: { [input.apiKeyEnv]: options.key },
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
  .action(async (name: string, options: { baseUrl?: string; key?: string }) => {
    const paths = activePaths();
    const envUpdates: Record<string, string> = {};
    if (options.key) {
      const config = readConfig();
      const providerConfig = config.models?.providers?.[name];
      const envId = providerConfig?.apiKey?.id ?? providerConfig?.authHeader?.id;
      if (!envId) throw new Error(`Provider ${name} has no env key reference`);
      envUpdates[envId] = options.key;
    }
    await writeOpenClawTransaction({
      ...paths,
      reason: `edit provider ${name}`,
      ...(Object.keys(envUpdates).length ? { envUpdates } : {}),
      ...(Object.keys(envUpdates).length
        ? {
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
    const paths = activePaths();
    const removeOptions: { force: boolean; newPrimary?: string } = { force: Boolean(options.force) };
    if (options.newPrimary !== undefined) removeOptions.newPrimary = options.newPrimary;
    const config = readConfig();
    const envVar = providerEnvVar(config, name);
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
    const paths = activePaths();
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
    const paths = activePaths();
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
    const paths = activePaths();
    const config = readConfig();
    const fetchImpl = mockSyncFetch();
    const envContent = readEnvContent();
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

const models = program.command("models");
models.command("list").option("--provider <name>").action((options: { provider?: string }) => {
  const rows = createConfigAdapter(readConfig()).listModels()
    .filter((row) => !options.provider || row.providerId === options.provider);
  for (const row of rows) {
    const flags = [row.enabled ? "enabled" : "disabled", row.isPrimary ? "primary" : ""].filter(Boolean).join(",");
    console.log(`${row.ref}\t${row.alias ?? ""}\t${flags}`);
  }
});

program.command("use")
  .argument("<ref>")
  .action(async (ref: string) => {
    const paths = activePaths();
    await writeOpenClawTransaction({
      ...paths,
      reason: `set primary model ${ref}`,
      mutate(config) {
        return setPrimaryModel(config, ref).config;
      }
    });
    console.log(`Primary model set to ${ref}`);
  });

const model = program.command("model");
model.command("disable")
  .argument("<ref>")
  .action(async (ref: string) => {
    const paths = activePaths();
    await writeOpenClawTransaction({
      ...paths,
      reason: `disable model ${ref}`,
      mutate(config) {
        return disableModel(config, ref).config;
      }
    });
    console.log(`Disabled ${ref}`);
  });

model.command("enable")
  .argument("<ref>")
  .option("--alias <alias>")
  .action(async (ref: string, options: { alias?: string }) => {
    assertProviderCanEnable(parseModelRef(ref).providerId);
    const paths = activePaths();
    await writeOpenClawTransaction({
      ...paths,
      reason: `enable model ${ref}`,
      mutate(config) {
        return enableModel(config, ref, options.alias).config;
      }
    });
    console.log(`Enabled ${ref}`);
  });

model.command("add")
  .argument("<ref>")
  .option("--alias <alias>")
  .option("--enable", "Add model to allowlist")
  .action(async (ref: string, options: { alias?: string; enable?: boolean }) => {
    const paths = activePaths();
    const input: { enabled: boolean; alias?: string } = { enabled: Boolean(options.enable) };
    if (options.alias !== undefined) input.alias = options.alias;
    if (input.enabled) {
      assertProviderCanEnable(parseModelRef(ref).providerId);
    }
    await writeOpenClawTransaction({
      ...paths,
      reason: `add model ${ref}`,
      mutate(config) {
        return addProviderModel(config, ref, input).config;
      }
    });
    console.log(`Added model ${ref}`);
  });

model.command("remove")
  .argument("<ref>")
  .option("--force")
  .option("--new-primary <ref>")
  .action(async (ref: string, options: { force?: boolean; newPrimary?: string }) => {
    const paths = activePaths();
    const removeOptions: { force: boolean; newPrimary?: string } = { force: Boolean(options.force) };
    if (options.newPrimary !== undefined) removeOptions.newPrimary = options.newPrimary;
    await writeOpenClawTransaction({
      ...paths,
      reason: `remove model ${ref}`,
      mutate(config) {
        return removeProviderModel(config, ref, removeOptions).config;
      }
    });
    console.log(`Removed model ${ref}`);
  });

const backup = program.command("backup");
backup.command("list").action(() => {
  const paths = activePaths();
  for (const entry of listBackups(paths.stateDir)) {
    console.log(`${entry.id}\t${entry.metadata.createdAt}\t${entry.metadata.reason}`);
  }
});

backup.command("restore")
  .argument("<id>")
  .action((id: string) => {
    const paths = activePaths();
    try {
      restoreBackupSafely({
        stateDir: paths.stateDir,
        backupDir: join(paths.stateDir, "backups", id),
        openclawPath: paths.openclawPath,
        envPath: paths.envPath
      });
      console.log(`Restored backup ${id}`);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  });

program.command("diff").action(() => {
  const paths = activePaths();
  const [latest] = listBackups(paths.stateDir);
  if (!latest) throw new Error("No backups found");
  const before = JSON5.parse(readFileSync(join(latest.path, "openclaw.json"), "utf8")) as OpenClawConfig;
  const after = readConfig();
  console.log(JSON.stringify(summarizeConfigDiff(before, after), null, 2));
});

const presets = program.command("presets");
presets.command("list").action(() => {
  for (const entry of listPresets(presetDirs())) {
    const preset = JSON.parse(readFileSync(entry.path, "utf8")) as { models?: unknown[] };
    console.log(`${entry.id}\t${entry.source}\t${preset.models?.length ?? 0}`);
  }
});

presets.command("export")
  .argument("<provider-id>")
  .action((providerId: string) => {
    const dirs = presetDirs();
    const preset = exportProviderPreset(readConfig(), providerId);
    const written = saveCustomPreset(dirs.customDir, preset);
    console.log(`Exported preset to ${written}`);
  });

program.command("import").action(() => {
  const config = readConfig();
  const dirs = presetDirs();
  const providerIds = Object.keys(config.models?.providers ?? {});
  for (const providerId of providerIds) {
    const preset = exportProviderPreset(config, providerId);
    saveCustomPreset(dirs.customDir, preset);
    console.log(`Imported preset ${providerId}`);
  }
});

program.command("serve")
  .description("Start REST API server for WebGUI")
  .option("--port <port>", "Listen port", "7420")
  .option("--host <host>", "Bind address", "127.0.0.1")
  .option("--token <secret>", "Bearer token for API auth")
  .action((options: { port: string; host: string; token?: string }) => {
    const paths = activePaths();
    const { token, ephemeral } = resolveServeToken({
      host: options.host,
      ...(options.token !== undefined ? { token: options.token } : {}),
      stateDir: paths.stateDir
    });
    if (ephemeral) {
      console.log(`Ephemeral token (localhost only): ${token}`);
    }
    const repoRoot = join(dirname(import.meta.path), "../../..");
    const port = Number(options.port);
    const app = createApp({ token, paths, repoRoot, bindAddress: options.host, port });
    Bun.serve({
      port,
      hostname: options.host,
      fetch: app.fetch
    });
    console.log(`oc-switch server listening on http://${options.host}:${port}`);
  });

const tokenCmd = program.command("token");
tokenCmd.command("rotate")
  .description("Rotate persisted API access token")
  .action(() => {
    const paths = activePaths();
    const token = rotatePersistedToken(paths.stateDir);
    console.log(`Rotated token. New token: ${token}`);
  });

program.parse();
