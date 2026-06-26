import { rotatePersistedToken } from "@oc-switch/core";
import type { Command } from "commander";
import type { CommandContext } from "../command-context";

export function registerTokenCommands(program: Command, context: CommandContext): void {
  const tokenCmd = program.command("token");
  tokenCmd.command("rotate")
    .description("Rotate persisted API access token")
    .action(() => {
      const paths = context.activePaths();
      const token = rotatePersistedToken(paths.stateDir);
      console.log(`Rotated token. New token: ${token}`);
    });
}
