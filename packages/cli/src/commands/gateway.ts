import { existsSync, readFileSync } from "node:fs";
import {
  restartGateway,
  syncManagedBlockToGatewayServiceEnv,
  resolveGatewayRuntimeTarget,
  inspectGatewayEnvDrift,
  unavailableGatewayEnvDriftReport,
  isGatewayRuntimeTargetError,
  type GatewayEnvDriftReport,
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
  if (error.code === "ambiguous-match") {
    // automatic 歧义：只列带 serviceEnvPath 的候选，供 --candidate 重试
    const candidates = discovery.candidateGroups.filter((group) => Boolean(group.serviceEnvPath?.trim()));
    if (candidates.length > 0) {
      const ids = candidates.map((group) => group.candidateId).join(", ");
      return new Error(
        `${error.message}. Available candidateId values: ${ids}. Re-run with --candidate <id>.`
      );
    }
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

/** 人类可读输出：目标行 → 非 equal 条目表（无 value 列）→ summary → 下一步提示 */
function printGatewayEnvDriftHuman(report: GatewayEnvDriftReport): void {
  if (report.status === "unavailable") {
    console.log(`Gateway env drift unavailable: ${report.unavailable?.message ?? "unknown reason"}`);
    for (const candidate of report.unavailable?.candidates ?? []) {
      const manager = candidate.serviceManager
        ? ` (${candidate.serviceManager}${candidate.serviceId ? ` ${candidate.serviceId}` : ""})`
        : "";
      const path = candidate.serviceEnvPath ? ` -> ${candidate.serviceEnvPath}` : "";
      console.log(`  candidate: ${candidate.candidateId}${manager}${path}`);
    }
    return;
  }
  if (report.target) {
    console.log(`Target: ${report.target.candidateId} (${report.target.targetKind}) -> ${report.target.serviceEnvPath}`);
  }
  const drifted = report.entries.filter((entry) => entry.state !== "equal");
  if (drifted.length === 0) {
    console.log("No drift detected.");
  } else {
    console.log("ENV VAR | STATE | SEVERITY");
    for (const entry of drifted) {
      const unsyncable = entry.unsyncable ? ` (unsyncable: ${entry.unsyncable})` : "";
      console.log(`${entry.envVar} | ${entry.state} | ${entry.severity}${unsyncable}`);
    }
  }
  const summary = report.summary;
  console.log(
    `Summary: checked=${summary.checked} equal=${summary.equal} `
    + `missing-in-service=${summary.missingInService} different=${summary.different} `
    + `extra-in-service=${summary.extraInService} outside-conflict=${summary.outsideConflict} `
    + `unsyncable=${summary.unsyncable}`
  );
  for (const warning of report.warnings) {
    console.log(`Warning: ${warning}`);
  }
  if (summary.different > 0) {
    console.log(
      "运行中 Gateway 可能仍使用旧值，重启后生效。"
      + "运行 `oc-switch gateway sync-env` 同步快照，或 `oc-switch gateway apply` 同步并重启。"
    );
  } else if (summary.extraInService > 0 || summary.outsideConflict > 0 || summary.unsyncable > 0) {
    console.log(
      "运行 `oc-switch gateway sync-env` 可让托管块与快照一致"
      + "（分叉为文件级比较，运行中进程重启后才加载新值）。"
    );
  }
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

  gateway.command("env-drift")
    .description("Detect drift between the .env managed block and the Gateway service env snapshot (file-level)")
    .option("--candidate <id>", "Target a discovered Gateway runtime candidate")
    .option("--json", "Print the full drift report as JSON")
    .action((cmdOptions: { candidate?: string; json?: boolean }) => {
      try {
        const paths = context.activePaths();
        const discovery = context.runtimeDiscovery();
        let target: GatewayRuntimeTarget;
        try {
          target = resolveGatewayRuntimeTarget({
            activePaths: paths,
            discovery,
            mode: "explicit",
            ...(cmdOptions.candidate ? { candidateId: cmdOptions.candidate } : {})
          });
        } catch (error) {
          throw formatGatewayTargetError(error, discovery);
        }

        const envContent = context.readEnvContent() ?? "";
        const targetPath = target.serviceEnvTarget.targetPath;
        let report: GatewayEnvDriftReport;
        try {
          const serviceEnvContent = existsSync(targetPath) ? readFileSync(targetPath, "utf8") : null;
          report = inspectGatewayEnvDrift({ envContent, target: target.serviceEnvTarget, serviceEnvContent });
        } catch (readError) {
          const detail = readError instanceof Error ? readError.message : String(readError);
          report = unavailableGatewayEnvDriftReport({
            code: "service-env-unreadable",
            message: `Gateway service env file is not readable at ${targetPath}: ${detail}`
          });
        }

        if (cmdOptions.json) {
          console.log(JSON.stringify(report, null, 2));
        } else {
          printGatewayEnvDriftHuman(report);
        }
        if (report.status === "unavailable") {
          // 分叉是数据而非命令失败，成功（含分叉）退出 0；unavailable 退出 1
          throw new Error(report.unavailable?.message ?? "Gateway env drift unavailable");
        }
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
