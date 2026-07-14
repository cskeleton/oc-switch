import { join, dirname } from "node:path";
import {
  LaunchAgentMetadataParseError,
  parseLaunchAgentGatewayMetadata
} from "./gateway-launchd-metadata";
import {
  createRuntimeCandidateGroup,
  deduplicateRuntimeCandidateGroups
} from "./runtime-discovery-candidates";
import { canonicalizeRuntimePath } from "./runtime-discovery-paths";
import { isStrictOpenClawGatewayProcess } from "./runtime-discovery-process";
import type {
  GatewayProcess,
  RunningOpenClawInstance,
  RuntimeDiscoveryDependencies,
  RuntimeDiscoveryDiagnosticCode,
  RuntimeDiscoveryResult,
  RuntimePathCandidateGroup
} from "./runtime-discovery-types";

const ENVIRONMENT_KEYS = new Set([
  "HOME",
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_PROFILE",
  "OPENCLAW_SERVICE_MARKER",
  "OPENCLAW_SERVICE_KIND",
  "OPENCLAW_SYSTEMD_UNIT"
]);

function parseWhitelistedEnvironment(content: string): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const entry of content.split(/\0|\r?\n/)) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    const key = entry.slice(0, separator).trim();
    if (ENVIRONMENT_KEYS.has(key)) {
      environment[key] = entry.slice(separator + 1).trim();
    }
  }
  return environment;
}

function parseLaunchdPid(content: string): number | undefined {
  const match = content.match(/(?:^|\n)\s*pid\s*=\s*(\d+)\s*(?:\n|$)/);
  const pid = Number(match?.[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : undefined;
}

function toCandidateGroup(instance: RunningOpenClawInstance): RuntimePathCandidateGroup | null {
  if (!instance.stateDir || !instance.openclawPath || !instance.envPath) return null;
  return createRuntimeCandidateGroup({
    instance,
    stateDir: instance.stateDir,
    openclawPath: instance.openclawPath,
    ...(instance.serviceEnvPath ? { serviceEnvPath: instance.serviceEnvPath } : {})
  });
}

/** 基于 LaunchAgent 与 launchctl runtime PID 探测 macOS Gateway 实例 */
export function discoverMacOSOpenClawRuntime(
  dependencies: RuntimeDiscoveryDependencies
): RuntimeDiscoveryResult {
  const diagnostics = new Set<RuntimeDiscoveryDiagnosticCode>();
  let gatewayProcesses: GatewayProcess[] = [];
  try {
    gatewayProcesses = dependencies.listGatewayProcesses().filter(isStrictOpenClawGatewayProcess);
  } catch {
    diagnostics.add("process-probe-failed");
  }
  const processByPid = new Map(gatewayProcesses.map((process) => [process.pid, process]));
  const instances: RunningOpenClawInstance[] = [];
  const discoveredCandidates: RuntimePathCandidateGroup[] = [];
  const launchAgentsDir = join(dependencies.homeDir, "Library/LaunchAgents");
  let plistNames: string[] = [];
  try {
    plistNames = dependencies.listDirectory(launchAgentsDir)
      .filter((name) => /^ai\.openclaw\..+\.plist$/.test(name))
      .sort();
  } catch {
    diagnostics.add("service-metadata-missing");
  }

  for (const plistName of plistNames) {
    const label = plistName.slice(0, -".plist".length);
    let metadata;
    try {
      metadata = parseLaunchAgentGatewayMetadata(
        dependencies.readTextFile(join(launchAgentsDir, plistName))
      );
    } catch (error) {
      if (error instanceof LaunchAgentMetadataParseError) {
        diagnostics.add("service-args-invalid");
      } else {
        diagnostics.add("service-metadata-missing");
      }
      continue;
    }

    let runtimePid: number | undefined;
    if (dependencies.userId === undefined) {
      diagnostics.add("user-id-unavailable");
      continue;
    }
    try {
      const runtime = dependencies.runCommand(
        "launchctl",
        ["print", `gui/${dependencies.userId}/${label}`],
        { timeoutMs: 1_000, maxOutputBytes: 16_384 }
      );
      if (runtime.status === 0) runtimePid = parseLaunchdPid(runtime.stdout);
    } catch {
      runtimePid = undefined;
    }
    if (!runtimePid) {
      diagnostics.add("service-metadata-missing");
      continue;
    }
    if (!processByPid.has(runtimePid)) {
      diagnostics.add("service-pid-mismatch");
      continue;
    }

    let environment: Record<string, string> = {};
    try {
      environment = parseWhitelistedEnvironment(
        dependencies.readTextFile(metadata.serviceEnvPath)
      );
    } catch {
      diagnostics.add("service-metadata-missing");
    }

    const environmentHome = canonicalizeRuntimePath(
      environment.HOME,
      dependencies.homeDir
    ) ?? dependencies.homeDir;
    const serviceEnvPath = canonicalizeRuntimePath(
      metadata.serviceEnvPath,
      environmentHome
    );
    if (!serviceEnvPath) {
      diagnostics.add("service-args-invalid");
      continue;
    }
    const layoutStateDir = dirname(dirname(serviceEnvPath));
    const explicitStateDir = canonicalizeRuntimePath(
      environment.OPENCLAW_STATE_DIR,
      environmentHome
    );
    const pathEvidenceConflict = explicitStateDir !== undefined &&
      explicitStateDir !== layoutStateDir;
    if (pathEvidenceConflict) diagnostics.add("path-evidence-conflict");
    const stateDir = explicitStateDir || layoutStateDir;
    const explicitConfigPath = canonicalizeRuntimePath(
      environment.OPENCLAW_CONFIG_PATH,
      environmentHome
    );
    const openclawPath = explicitConfigPath || join(stateDir, "openclaw.json");
    const envPath = join(stateDir, ".env");
    const evidence: RunningOpenClawInstance["evidence"] = ["process-cmdline"];
    evidence.push("launchd-plist");
    const instance: RunningOpenClawInstance = {
      instanceId: `launchd:${label}`,
      pid: runtimePid,
      stateDir,
      openclawPath,
      envPath,
      serviceEnvPath,
      serviceManager: "launchd",
      serviceId: label,
      ...(!pathEvidenceConflict ? { confidence: "strong" as const } : {}),
      ...(pathEvidenceConflict ? { conflicted: true } : {}),
      evidence
    };
    instances.push(instance);

    const candidateStateDirs = [...new Set([
      ...(explicitStateDir ? [explicitStateDir] : []),
      layoutStateDir
    ])];
    for (const candidateStateDir of candidateStateDirs) {
      discoveredCandidates.push(createRuntimeCandidateGroup({
        instance,
        stateDir: candidateStateDir,
        openclawPath: explicitConfigPath ||
          join(candidateStateDir, "openclaw.json"),
        serviceEnvPath,
        confidence: pathEvidenceConflict ? undefined : "strong",
        conflicted: pathEvidenceConflict
      }));
    }
  }

  const candidateGroups = deduplicateRuntimeCandidateGroups([
    ...discoveredCandidates,
    ...instances
      .map(toCandidateGroup)
      .filter((candidate): candidate is RuntimePathCandidateGroup => candidate !== null)
  ]);
  const resolved = candidateGroups.some((candidate) => candidate.confidence !== undefined);
  return {
    status: resolved
      ? "resolved"
      : gatewayProcesses.length > 0
        ? "gateway-detected-path-unresolved"
        : diagnostics.has("process-probe-failed")
          ? "probe-failed"
          : "gateway-not-detected",
    instances,
    candidateGroups,
    diagnostics: [...diagnostics]
  };
}
