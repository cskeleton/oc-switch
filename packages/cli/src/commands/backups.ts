import { listBackups, restoreBackupSafely, summarizeConfigDiff } from "@oc-switch/core";
import type { Command } from "commander";
import JSON5 from "json5";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpenClawConfig } from "@oc-switch/core";
import type { CommandContext } from "../command-context";

export function registerBackupCommands(program: Command, context: CommandContext): void {
  const backup = program.command("backup");
  backup.command("list").action(() => {
    const paths = context.activePaths();
    for (const entry of listBackups(paths.stateDir)) {
      console.log(`${entry.id}\t${entry.metadata.createdAt}\t${entry.metadata.reason}`);
    }
  });

  backup.command("restore")
    .argument("<id>")
    .action((id: string) => {
      const paths = context.activePaths();
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
    const paths = context.activePaths();
    const [latest] = listBackups(paths.stateDir);
    if (!latest) throw new Error("No backups found");
    const before = JSON5.parse(readFileSync(join(latest.path, "openclaw.json"), "utf8")) as OpenClawConfig;
    const after = context.readConfig();
    console.log(JSON.stringify(summarizeConfigDiff(before, after), null, 2));
  });
}
