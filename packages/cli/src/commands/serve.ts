import { resolveServeToken } from "@oc-switch/core";
import { createApp } from "@oc-switch/server";
import type { Command } from "commander";
import { dirname, join } from "node:path";
import type { CommandContext } from "../command-context";

export function registerServeCommand(program: Command, context: CommandContext): void {
  program.command("serve")
    .description("Start REST API server for WebGUI")
    .option("--port <port>", "Listen port", "7420")
    .option("--host <host>", "Bind address", "127.0.0.1")
    .option("--token <secret>", "Bearer token for API auth")
    .action((options: { port: string; host: string; token?: string }) => {
      const paths = context.activePaths();
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
}
