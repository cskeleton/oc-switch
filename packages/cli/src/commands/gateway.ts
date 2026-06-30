import {
  restartGateway,
  syncManagedBlockToGatewaySystemdEnv,
  type GatewayRestartExecutor
} from "@oc-switch/core";
import type { Command } from "commander";
import type { CommandContext } from "../command-context";

export interface GatewayCommandOptions {
  restartGateway?: typeof restartGateway;
  syncManagedBlockToGatewaySystemdEnv?: typeof syncManagedBlockToGatewaySystemdEnv;
}

export function registerGatewayCommands(
  program: Command,
  context: CommandContext,
  options: GatewayCommandOptions = {}
): void {
  const syncFn = options.syncManagedBlockToGatewaySystemdEnv ?? syncManagedBlockToGatewaySystemdEnv;
  const restartFn = options.restartGateway ?? restartGateway;
  const gateway = program.command("gateway").description("Sync managed env block to gateway.systemd.env and restart Gateway");

  gateway.command("sync-env")
    .description("Merge oc-switch managed block into gateway.systemd.env")
    .action(() => {
      try {
        const paths = context.activePaths();
        const result = syncFn({ envPath: paths.envPath });
        console.log(JSON.stringify({ ok: true, sync: result }, null, 2));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });

  gateway.command("restart")
    .description("Run openclaw gateway restart")
    .action(async () => {
      const result = await restartFn();
      if (!result.ok) {
        console.error(result.message);
        process.exit(1);
      }
      console.log(result.message);
    });

  gateway.command("apply")
    .description("Sync managed block and restart Gateway")
    .action(async () => {
      try {
        const paths = context.activePaths();
        const sync = syncFn({ envPath: paths.envPath });
        const restart = await restartFn();
        if (!restart.ok) {
          console.error(restart.message);
          process.exit(1);
        }
        console.log(JSON.stringify({ ok: true, sync, restart }, null, 2));
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
    });
}

export type { GatewayRestartExecutor };
