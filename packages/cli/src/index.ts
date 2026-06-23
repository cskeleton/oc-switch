#!/usr/bin/env bun
import { Command } from "commander";
import JSON5 from "json5";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  addProviderModel,
  addProviderFromPreset,
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
  removeProviderModel,
  restoreBackup,
  saveCustomPreset,
  setPrimaryModel,
  summarizeConfigDiff,
  syncProviderModels,
  applySyncedModels,
  version,
  writeOpenClawTransaction,
  type FetchImpl
} from "@oc-switch/core";
import type { OpenClawConfig } from "@oc-switch/core";

function readConfig(): OpenClawConfig {
  const paths = defaultPaths();
  return JSON5.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
}

function presetDirs() {
  const paths = defaultPaths();
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

const providers = program.command("providers");
providers.command("list").action(() => {
  const rows = createConfigAdapter(readConfig()).listProviders();
  for (const row of rows) {
    console.log(`${row.id}\t${row.api ?? "unknown"}\t${row.enabledModelCount}/${row.modelCount}`);
  }
});

const provider = program.command("provider");
provider.command("add")
  .argument("<preset-id>")
  .requiredOption("--key <api-key>", "API key value")
  .option("--models <ids>", "Comma-separated model ids to enable", (value: string) => value.split(",").map((id) => id.trim()).filter(Boolean))
  .action(async (presetId: string, options: { key: string; models?: string[] }) => {
    const paths = defaultPaths();
    const preset = loadPreset(presetDirs(), presetId);
    const enabledModels = options.models ?? preset.models.map((model) => model.id);
    await writeOpenClawTransaction({
      ...paths,
      reason: `add provider ${presetId}`,
      envUpdates: { [preset.provider.apiKeyEnv]: options.key },
      mutate(config) {
        return addProviderFromPreset(config, preset, enabledModels).config;
      }
    });
    console.log(`Added provider ${presetId}`);
  });

provider.command("edit")
  .argument("<name>")
  .option("--base-url <url>")
  .option("--key <api-key>", "API key value")
  .action(async (name: string, options: { baseUrl?: string; key?: string }) => {
    const paths = defaultPaths();
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
    const paths = defaultPaths();
    const removeOptions: { force: boolean; newPrimary?: string } = { force: Boolean(options.force) };
    if (options.newPrimary !== undefined) removeOptions.newPrimary = options.newPrimary;
    await writeOpenClawTransaction({
      ...paths,
      reason: `delete provider ${name}`,
      mutate(config) {
        return removeProvider(config, name, removeOptions).config;
      }
    });
    console.log(`Deleted provider ${name}`);
  });

provider.command("sync")
  .argument("<name>")
  .action(async (name: string) => {
    const paths = defaultPaths();
    const config = readConfig();
    const fetchImpl = mockSyncFetch();
    const result = await syncProviderModels(config, name, fetchImpl ?? fetch);
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
    const paths = defaultPaths();
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
    const paths = defaultPaths();
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
    const paths = defaultPaths();
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
    const paths = defaultPaths();
    const input: { enabled: boolean; alias?: string } = { enabled: Boolean(options.enable) };
    if (options.alias !== undefined) input.alias = options.alias;
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
    const paths = defaultPaths();
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
  const paths = defaultPaths();
  for (const entry of listBackups(paths.stateDir)) {
    console.log(`${entry.id}\t${entry.metadata.createdAt}\t${entry.metadata.reason}`);
  }
});

backup.command("restore")
  .argument("<id>")
  .action((id: string) => {
    const paths = defaultPaths();
    restoreBackup({
      backupDir: join(paths.stateDir, "backups", id),
      openclawPath: paths.openclawPath,
      envPath: paths.envPath
    });
    console.log(`Restored backup ${id}`);
  });

program.command("diff").action(() => {
  const paths = defaultPaths();
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

program.parse();
