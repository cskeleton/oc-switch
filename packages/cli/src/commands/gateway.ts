import {
  restartGateway,
  syncManagedBlockToGatewayServiceEnv,
  resolveGatewayRuntimeTarget,
  isGatewayRuntimeTargetError,
  type GatewayRestartExecutor,
  type GatewayRuntimeTarget,
  type RuntimeDiscoveryResult
} from "@oc-switch/core";
import type { Command } from "commander";
import type { CommandContext } from "../command-context";

export interface GatewayCommandOptions {
  restartGateway?: typeof restartGateway;
  syncManagedBlockToGatewayServiceEnv?: typeof syncManagedBlockToGatewayServiceEnv;
}

/** 多实例歧义时列出 candidateId，不打印任何 env 内容 */
function formatGatewayTargetError(
  error: unknown,
  discovery: RuntimeDiscoveryResult
): Error {
  if (!isGatewayRuntimeTargetError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }
  if (error.code === "missing-candidate-id" && discovery.candidateGroups.length > 1) {
    const ids = discovery.candidateGroups.map((group) => group.candidateId).join(", ");
    return new Error(
      `${error.message}. Available candidateId values: ${ids}. Re-run with --candidate <id>.`
    );
  }
  return error;
}

function resolveExplicitTarget(
  context: CommandContext,
  candidateId: string | undefined
): GatewayRuntimeTarget {
  const paths = context.activePaths();
  const discovery = context.runtimeDiscovery();
  try {
    return resolveGatewayRuntimeTarget({
      activePaths: paths,
      discovery,
      mode: "explicit",
      ...(candidateId ? { candidateId } : {})
    });
  } catch (error) {
    throw formatGatewayTargetError(error, discovery);
  }
}

function reportAndRethrow(error: unknown): never {
  console.error(error instanceof Error ? error.message : String(error));
  throw error instanceof Error ? error : new Error(String(error));
}

export function registerGatewayCommands(
  program: Command,
  context: CommandContext,
  options: GatewayCommandOptions = {}
): void {
  const syncFn = options.syncManagedBlockToGatewayServiceEnv ?? syncManagedBlockToGatewayServiceEnv;
  const restartFn = options.restartGateway ?? restartGateway;
  const gateway = program.command("gateway").description("Sync managed env block to Gateway service env and restart");

  gateway.command("sync-env")
    .description("Merge oc-switch managed block into Gateway service environment file")
    .option("--candidate <id>", "Target a discovered Gateway runtime candidate")
    .action((cmdOptions: { candidate?: string }) => {
      try {
        const paths = context.activePaths();
        const target = resolveExplicitTarget(context, cmdOptions.candidate);
        const result = syncFn({ envPath: paths.envPath, target: target.serviceEnvTarget });
        console.log(JSON.stringify({ ok: true, sync: result }, null, 2));
      } catch (error) {
        reportAndRethrow(error);
      }
    });

  gateway.command("restart")
    .description("Run openclaw gateway restart")
    .option("--candidate <id>", "Target a discovered Gateway runtime candidate")
    .action(async (cmdOptions: { candidate?: string }) => {
      try {
        const target = resolveExplicitTarget(context, cmdOptions.candidate);
        const result = await restartFn({ target });
        if (!result.ok) {
          throw new Error(result.message);
        }
        console.log(result.message);
      } catch (error) {
        reportAndRethrow(error);
      }
    });

  gateway.command("apply")
    .description("Sync managed block and restart Gateway")
    .option("--candidate <id>", "Target a discovered Gateway runtime candidate")
    .action(async (cmdOptions: { candidate?: string }) => {
      try {
        const paths = context.activePaths();
        // apply 只 resolve 一次，sync 与 restart 共用同一 target
        const target = resolveExplicitTarget(context, cmdOptions.candidate);
        const sync = syncFn({ envPath: paths.envPath, target: target.serviceEnvTarget });
        const restart = await restartFn({ target });
        if (!restart.ok) {
          throw new Error(restart.message);
        }
        console.log(JSON.stringify({ ok: true, sync, restart }, null, 2));
      } catch (error) {
        reportAndRethrow(error);
      }
    });
}

export type { GatewayRestartExecutor };
