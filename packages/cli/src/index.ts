#!/usr/bin/env bun
import { Command } from "commander";
import JSON5 from "json5";
import { readFileSync } from "node:fs";
import {
  createConfigAdapter,
  defaultPaths,
  disableModel,
  enableModel,
  setPrimaryModel,
  version,
  writeOpenClawTransaction
} from "@oc-switch/core";
import type { OpenClawConfig } from "@oc-switch/core";

function readConfig(): OpenClawConfig {
  const paths = defaultPaths();
  return JSON5.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
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

program.parse();
