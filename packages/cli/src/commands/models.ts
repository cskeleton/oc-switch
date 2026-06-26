import {
  addProviderModel,
  createConfigAdapter,
  disableModel,
  enableModel,
  parseModelRef,
  removeProviderModel,
  setPrimaryModel,
  writeOpenClawTransaction
} from "@oc-switch/core";
import type { Command } from "commander";
import type { CommandContext } from "../command-context";

export function registerModelCommands(program: Command, context: CommandContext): void {
  const models = program.command("models");
  models.command("list").option("--provider <name>").action((options: { provider?: string }) => {
    const rows = createConfigAdapter(context.readConfig()).listModels()
      .filter((row) => !options.provider || row.providerId === options.provider);
    for (const row of rows) {
      const flags = [row.enabled ? "enabled" : "disabled", row.isPrimary ? "primary" : ""].filter(Boolean).join(",");
      console.log(`${row.ref}\t${row.alias ?? ""}\t${flags}`);
    }
  });

  program.command("use")
    .argument("<ref>")
    .action(async (ref: string) => {
      const paths = context.activePaths();
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
      const paths = context.activePaths();
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
      context.assertProviderCanEnable(parseModelRef(ref).providerId);
      const paths = context.activePaths();
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
      const paths = context.activePaths();
      const input: { enabled: boolean; alias?: string } = { enabled: Boolean(options.enable) };
      if (options.alias !== undefined) input.alias = options.alias;
      if (input.enabled) {
        context.assertProviderCanEnable(parseModelRef(ref).providerId);
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
      const paths = context.activePaths();
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
}
