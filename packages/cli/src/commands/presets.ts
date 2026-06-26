import { exportProviderPreset, listPresets, saveCustomPreset } from "@oc-switch/core";
import type { Command } from "commander";
import { readFileSync } from "node:fs";
import type { CommandContext } from "../command-context";

export function registerPresetCommands(program: Command, context: CommandContext): void {
  const presets = program.command("presets");
  presets.command("list").action(() => {
    for (const entry of listPresets(context.presetDirs())) {
      const preset = JSON.parse(readFileSync(entry.path, "utf8")) as { models?: unknown[] };
      console.log(`${entry.id}\t${entry.source}\t${preset.models?.length ?? 0}`);
    }
  });

  presets.command("export")
    .argument("<provider-id>")
    .action((providerId: string) => {
      const dirs = context.presetDirs();
      const preset = exportProviderPreset(context.readConfig(), providerId);
      const written = saveCustomPreset(dirs.customDir, preset);
      console.log(`Exported preset to ${written}`);
    });

  program.command("import").action(() => {
    const config = context.readConfig();
    const dirs = context.presetDirs();
    const providerIds = Object.keys(config.models?.providers ?? {});
    for (const providerId of providerIds) {
      const preset = exportProviderPreset(config, providerId);
      saveCustomPreset(dirs.customDir, preset);
      console.log(`Imported preset ${providerId}`);
    }
  });
}
