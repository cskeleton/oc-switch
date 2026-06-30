#!/usr/bin/env bun
import { Command } from "commander";
import { version } from "@oc-switch/core";
import { createCommandContext } from "./command-context";
import { registerBackupCommands } from "./commands/backups";
import { registerGatewayCommands } from "./commands/gateway";
import { registerModelCommands } from "./commands/models";
import { registerPresetCommands } from "./commands/presets";
import { registerProviderCommands } from "./commands/providers";
import { registerServeCommand } from "./commands/serve";
import { registerStatusCommands } from "./commands/status";
import { registerTokenCommands } from "./commands/token";

const program = new Command();

program
  .name("oc-switch")
  .description("Manage local OpenClaw provider and model configuration")
  .version(version);

const context = createCommandContext();

registerStatusCommands(program, context);
registerProviderCommands(program, context);
registerModelCommands(program, context);
registerBackupCommands(program, context);
registerGatewayCommands(program, context);
registerPresetCommands(program, context);
registerServeCommand(program, context);
registerTokenCommands(program, context);

program.parse();
