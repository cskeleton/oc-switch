import { basename, dirname, join } from "node:path";
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
    const key = entry.slice(0, separator);
    if (ENVIRONMENT_KEYS.has(key)) environment[key] = entry.slice(separator + 1);
  }
  return environment;
}

interface SystemdShowMetadata {
  mainPid?: number;
  fragmentPath?: string;
  environmentFiles: string[];
  environmentFilesReported: boolean;
}

function parsePathTokens(content: string): string[] {
  const paths: string[] = [];
  const normalized = content.replace(/\s+\(ignore_errors=(?:yes|no)\)/g, "");
  const matcher = /"([^"]+)"|'([^']+)'|(\S+)/g;
  for (const match of normalized.matchAll(matcher)) {
    const path = match[1] ?? match[2] ?? match[3];
    if (path?.startsWith("/") || path?.startsWith("~/")) paths.push(path);
  }
  return paths;
}

function parseSystemdShow(content: string): SystemdShowMetadata {
  let mainPid: number | undefined;
  let fragmentPath: string | undefined;
  let environmentFilesReported = false;
  let environmentFiles: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (key === "MainPID") {
      const parsedPid = Number(value);
      if (Number.isInteger(parsedPid) && parsedPid > 0) mainPid = parsedPid;
    } else if (key === "FragmentPath" && value) {
      fragmentPath = value;
    } else if (key === "EnvironmentFiles") {
      environmentFilesReported = true;
      environmentFiles = parsePathTokens(value);
    }
  }
  return {
    ...(mainPid ? { mainPid } : {}),
    ...(fragmentPath ? { fragmentPath } : {}),
    environmentFiles,
    environmentFilesReported
  };
}

function parseEnvironmentFilesFromUnit(content: string): string[] {
  let paths: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    const match = line.trim().match(/^EnvironmentFile\s*=(.*)$/);
    if (!match) continue;
    const value = (match[1] ?? "").trim();
    if (!value) {
      paths = [];
      continue;
    }
    const withoutOptionalPrefix = value.startsWith("-") ? value.slice(1).trim() : value;
    paths.push(...parsePathTokens(withoutOptionalPrefix));
  }
  return paths;
}

function inferredStateDir(serviceEnvPath: string | undefined): string | undefined {
  if (!serviceEnvPath?.endsWith("/gateway.systemd.env")) return undefined;
  return dirname(serviceEnvPath);
}

const MAX_SYSTEMD_UNIT_CANDIDATES = 16;
const SYSTEMD_PROBE_BUDGET_MS = 1_500;

function selectGatewayServiceEnvPaths(
  paths: string[],
  dependencies: RuntimeDiscoveryDependencies
): string[] {
  const marked = paths.filter((path) => {
    try {
      const environment = parseWhitelistedEnvironment(
        dependencies.readTextFile(path)
      );
      return environment.OPENCLAW_SERVICE_MARKER === "openclaw" &&
        environment.OPENCLAW_SERVICE_KIND === "gateway";
    } catch {
      return false;
    }
  });
  if (marked.length > 0) return marked;
  const canonical = paths.filter((path) => basename(path) === "gateway.systemd.env");
  if (canonical.length > 0) return canonical;
  return paths.length === 1 ? paths : [];
}

function candidateGroup(instance: RunningOpenClawInstance): RuntimePathCandidateGroup | null {
  if (!instance.stateDir || !instance.openclawPath || !instance.envPath) return null;
  return createRuntimeCandidateGroup({
    instance,
    stateDir: instance.stateDir,
    openclawPath: instance.openclawPath,
    ...(instance.serviceEnvPath ? { serviceEnvPath: instance.serviceEnvPath } : {})
  });
}

/** 基于 proc 与 systemd user unit 探测 Linux Gateway 实例 */
export function discoverLinuxOpenClawRuntime(
  dependencies: RuntimeDiscoveryDependencies
): RuntimeDiscoveryResult {
  const diagnostics = new Set<RuntimeDiscoveryDiagnosticCode>();
  const instances: RunningOpenClawInstance[] = [];
  const discoveredCandidates: RuntimePathCandidateGroup[] = [];
  const unitPathClaims = new Map<string, string>();
  const claimedUnitByPid = new Map<number, string>();
  const conflictingUnitIds = new Set<string>();
  let enumeratedUnits: Array<{ unitId: string; mainPid?: number }> | undefined;
  const systemdProbeStartedAt = Date.now();
  let processProbeFailed = false;
  let processes: GatewayProcess[] = [];
  try {
    processes = dependencies.listGatewayProcesses().filter(isStrictOpenClawGatewayProcess);
  } catch {
    diagnostics.add("process-probe-failed");
    processProbeFailed = true;
  }

  for (const process of processes) {
    let environment: Record<string, string> = {};
    try {
      environment = parseWhitelistedEnvironment(
        dependencies.readTextFile(`/proc/${process.pid}/environ`)
      );
    } catch {
      diagnostics.add("process-environ-denied");
    }

    const environmentHome = canonicalizeRuntimePath(
      environment.HOME,
      dependencies.homeDir
    ) ?? dependencies.homeDir;
    let unitId = environment.OPENCLAW_SYSTEMD_UNIT;
    if (unitId) claimedUnitByPid.set(process.pid, unitId);
    if (!unitId) {
      if (!enumeratedUnits) {
        const candidateUnits = new Set<string>();
        try {
          const unitDirectory = join(dependencies.homeDir, ".config/systemd/user");
          for (const candidateUnit of dependencies.listDirectory(unitDirectory)) {
            candidateUnits.add(candidateUnit);
          }
        } catch {
          // 用户 unit 目录可能不存在，继续使用 systemctl runtime 列表
        }
        try {
          const loadedUnits = dependencies.runCommand(
            "systemctl",
            ["--user", "list-units", "--type=service", "--state=running", "--no-legend", "--plain"],
            { timeoutMs: 250, maxOutputBytes: 65_536 }
          );
          if (loadedUnits.status === 0) {
            for (const line of loadedUnits.stdout.split(/\r?\n/)) {
              const candidateUnit = line.trim().split(/\s+/, 1)[0];
              if (candidateUnit?.endsWith(".service")) candidateUnits.add(candidateUnit);
            }
          }
        } catch {
          diagnostics.add("service-metadata-missing");
        }
        enumeratedUnits = [];
        try {
          const boundedUnits = [...candidateUnits]
            .filter((candidateUnit) =>
              candidateUnit.endsWith(".service") &&
              /(openclaw|gateway)/i.test(candidateUnit)
            )
            .sort()
            .slice(0, MAX_SYSTEMD_UNIT_CANDIDATES);
          for (const candidateUnit of boundedUnits) {
            const remainingBudget = SYSTEMD_PROBE_BUDGET_MS -
              (Date.now() - systemdProbeStartedAt);
            if (remainingBudget <= 0) break;
            const show = dependencies.runCommand(
              "systemctl",
              [
                "--user",
                "show",
                candidateUnit,
                "--property=MainPID",
                "--property=FragmentPath",
                "--property=EnvironmentFiles"
              ],
              { timeoutMs: Math.min(250, remainingBudget), maxOutputBytes: 16_384 }
            );
            enumeratedUnits.push({
              unitId: candidateUnit,
              ...parseSystemdShow(show.stdout)
            });
          }
        } catch {
          diagnostics.add("service-metadata-missing");
        }
      }
      unitId = enumeratedUnits.find(
        (candidate) => candidate.mainPid === process.pid
      )?.unitId;
    }
    let serviceEnvPaths: string[] = [];
    let serviceMatched = false;
    if (unitId) {
      try {
        const remainingBudget = SYSTEMD_PROBE_BUDGET_MS -
          (Date.now() - systemdProbeStartedAt);
        if (remainingBudget <= 0) throw new Error("Systemd probe budget exhausted");
        const show = dependencies.runCommand(
          "systemctl",
          [
            "--user",
            "show",
            unitId,
            "--property=MainPID",
            "--property=FragmentPath",
            "--property=EnvironmentFiles"
          ],
          { timeoutMs: Math.min(250, remainingBudget), maxOutputBytes: 16_384 }
        );
        const metadata = parseSystemdShow(show.stdout);
        if (show.status !== 0) {
          diagnostics.add("service-metadata-missing");
        } else if (metadata.mainPid !== process.pid) {
          diagnostics.add("service-pid-mismatch");
        } else {
          serviceMatched = true;
          if (metadata.environmentFilesReported) {
            serviceEnvPaths = metadata.environmentFiles;
          } else if (metadata.fragmentPath) {
            const fragmentPath = canonicalizeRuntimePath(
              metadata.fragmentPath,
              environmentHome
            );
            if (!fragmentPath) throw new Error("Invalid systemd fragment path");
            serviceEnvPaths = parseEnvironmentFilesFromUnit(
              dependencies.readTextFile(fragmentPath)
            );
          }
          serviceEnvPaths = selectGatewayServiceEnvPaths(
            [...new Set(serviceEnvPaths
              .map((path) => canonicalizeRuntimePath(path, environmentHome))
              .filter((path): path is string => Boolean(path))
            )].sort(),
            dependencies
          );
          if (serviceEnvPaths.length === 0) diagnostics.add("service-metadata-missing");
        }
      } catch {
        diagnostics.add("service-metadata-missing");
      }
    } else {
      diagnostics.add("service-metadata-missing");
    }

    const serviceStateDirs = [...new Set(
      serviceEnvPaths
        .map(inferredStateDir)
        .filter((stateDir): stateDir is string => Boolean(stateDir))
    )];
    const explicitStateDir = canonicalizeRuntimePath(
      environment.OPENCLAW_STATE_DIR,
      environmentHome
    );
    const pathEvidenceConflict = (
      serviceEnvPaths.length > 1 ||
      (explicitStateDir !== undefined &&
        serviceStateDirs.some((stateDir) => stateDir !== explicitStateDir))
    );
    if (pathEvidenceConflict) diagnostics.add("path-evidence-conflict");
    const stateDir = explicitStateDir ||
      (serviceStateDirs.length === 1 ? serviceStateDirs[0] : undefined);
    const explicitConfigPath = canonicalizeRuntimePath(
      environment.OPENCLAW_CONFIG_PATH,
      environmentHome
    );
    const openclawPath = explicitConfigPath ||
      (stateDir ? join(stateDir, "openclaw.json") : undefined);
    const envPath = stateDir ? join(stateDir, ".env") : undefined;
    if (unitId && (stateDir || openclawPath)) {
      const pathClaim = `${stateDir ?? ""}\0${openclawPath ?? ""}`;
      const previousClaim = unitPathClaims.get(unitId);
      if (previousClaim !== undefined && previousClaim !== pathClaim) {
        diagnostics.add("path-evidence-conflict");
        conflictingUnitIds.add(unitId);
      } else {
        unitPathClaims.set(unitId, pathClaim);
      }
    }
    const explicitProcessPath = Boolean(
      explicitStateDir || explicitConfigPath
    );
    const confidence = serviceMatched && !pathEvidenceConflict && stateDir
      ? explicitProcessPath ? "confirmed" : "strong"
      : undefined;
    const evidence: RunningOpenClawInstance["evidence"] = ["process-cmdline"];
    if (Object.keys(environment).length > 0) evidence.push("process-environ");
    if (serviceMatched) evidence.push("systemd-unit");

    const instance: RunningOpenClawInstance = {
      instanceId: serviceMatched && unitId ? `systemd:${unitId}` : `pid:${process.pid}`,
      pid: process.pid,
      ...(openclawPath ? { openclawPath } : {}),
      ...(envPath ? { envPath } : {}),
      ...(stateDir ? { stateDir } : {}),
      ...(serviceEnvPaths.length === 1 ? { serviceEnvPath: serviceEnvPaths[0]! } : {}),
      ...(serviceMatched ? { serviceManager: "systemd" as const } : {}),
      ...(serviceMatched && unitId ? { serviceId: unitId } : {}),
      ...(confidence ? { confidence } : {}),
      ...(pathEvidenceConflict ? { conflicted: true } : {}),
      evidence
    };
    instances.push(instance);

    const candidateStateDirs = [...new Set([
      ...(explicitStateDir ? [explicitStateDir] : []),
      ...serviceStateDirs
    ])];
    for (const candidateStateDir of candidateStateDirs) {
      const matchingServiceEnvPath = serviceEnvPaths.find(
        (path) => inferredStateDir(path) === candidateStateDir
      );
      discoveredCandidates.push(createRuntimeCandidateGroup({
        instance,
        stateDir: candidateStateDir,
        openclawPath: candidateStateDir === explicitStateDir
          ? explicitConfigPath ?? join(candidateStateDir, "openclaw.json")
          : join(candidateStateDir, "openclaw.json"),
        ...(matchingServiceEnvPath ? { serviceEnvPath: matchingServiceEnvPath } : {}),
        confidence: pathEvidenceConflict ? undefined : confidence,
        conflicted: pathEvidenceConflict
      }));
    }
  }

  const rawCandidateGroups = deduplicateRuntimeCandidateGroups([
    ...discoveredCandidates,
    ...instances
      .map(candidateGroup)
      .filter((candidate): candidate is RuntimePathCandidateGroup => candidate !== null)
  ]);
  const scopedInstances = instances.map((instance) => {
    const claimedUnit = claimedUnitByPid.get(instance.pid);
    if (!claimedUnit || !conflictingUnitIds.has(claimedUnit)) return instance;
    const { confidence: _confidence, ...metadata } = instance;
    return { ...metadata, conflicted: true };
  });
  const candidateGroups = rawCandidateGroups.map((candidate) => {
    const claimedUnit = claimedUnitByPid.get(candidate.pid);
    if (!claimedUnit || !conflictingUnitIds.has(claimedUnit)) return candidate;
    const { confidence: _confidence, ...metadata } = candidate;
    return { ...metadata, conflicted: true };
  });
  const resolved = candidateGroups.some((candidate) => candidate.confidence !== undefined);
  return {
    status: resolved
      ? "resolved"
      : processes.length > 0
        ? "gateway-detected-path-unresolved"
        : processProbeFailed
          ? "probe-failed"
          : "gateway-not-detected",
    instances: scopedInstances,
    candidateGroups,
    diagnostics: [...diagnostics]
  };
}
