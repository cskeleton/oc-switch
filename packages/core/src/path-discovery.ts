import { spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { discoverLinuxOpenClawRuntime } from "./path-discovery-linux";
import { discoverMacOSOpenClawRuntime } from "./path-discovery-macos";
import {
  createRuntimeCandidateGroup,
  deduplicateRuntimeCandidateGroups
} from "./runtime-discovery-candidates";
import { canonicalizeRuntimePath } from "./runtime-discovery-paths";
import { isStrictOpenClawGatewayProcess } from "./runtime-discovery-process";
export { isStrictOpenClawGatewayProcess } from "./runtime-discovery-process";
import type {
  GatewayProcess,
  LegacyRunningOpenClawInstance,
  RunningOpenClawInstance as RuntimeInstance,
  RuntimeDiscoveryDependencies,
  RuntimeDiscoveryDiagnosticCode,
  RuntimeDiscoveryResult,
  RuntimePathCandidateGroup
} from "./runtime-discovery-types";

export interface DiscoverRunningInstancesOptions {
  /** 测试注入：替代 pgrep 探测 */
  probe?: () => string;
}

export interface ProcessProbeOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

export type DiscoverOpenClawRuntimeOptions =
  Partial<RuntimeDiscoveryDependencies> & {
    processProbe?: (
      command: string,
      args: string[],
      options: ProcessProbeOptions
    ) => ReturnType<RuntimeDiscoveryDependencies["runCommand"]>;
  };

const PROCESS_PROBE_OPTIONS: ProcessProbeOptions = {
  timeoutMs: 1_000,
  maxOutputBytes: 65_536
};

function deriveEnvPath(openclawPath: string): string {
  return join(dirname(openclawPath), ".env");
}

function parsePgrepLine(line: string): LegacyRunningOpenClawInstance | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(\d+)\s+(.+)$/);
  if (!match?.[1] || !match[2]) return null;
  const pid = Number(match[1]);
  if (!Number.isFinite(pid)) return null;
  const command = match[2];

  const flagMatch = command.match(/--config[=\s]+(\S+)/);
  const pathMatch = command.match(/(\S+openclaw\.json)/);
  const openclawPath = flagMatch?.[1] ?? pathMatch?.[1];
  if (!openclawPath) return { pid };

  return {
    pid,
    openclawPath,
    envPath: deriveEnvPath(openclawPath)
  };
}

function runDefaultProcessProbe(
  command: string,
  args: string[],
  options: ProcessProbeOptions
): ReturnType<RuntimeDiscoveryDependencies["runCommand"]> {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes
  });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    timedOut: result.status === null && (
      result.signal === "SIGTERM" || errorCode === "ETIMEDOUT"
    ),
    ...(errorCode === "ENOBUFS" ? { outputTooLarge: true } : {})
  };
}

function probeOutput(
  runner: (
    command: string,
    args: string[],
    options: ProcessProbeOptions
  ) => ReturnType<RuntimeDiscoveryDependencies["runCommand"]>,
  platform: NodeJS.Platform
): string {
  const args = platform === "linux" ? ["-af", "openclaw"] : ["-fl", "openclaw"];
  const result = runner("pgrep", args, PROCESS_PROBE_OPTIONS);
  if (
    result.timedOut ||
    result.outputTooLarge ||
    Buffer.byteLength(result.stdout, "utf8") > PROCESS_PROBE_OPTIONS.maxOutputBytes ||
    (result.status !== 0 && result.status !== 1)
  ) {
    throw new Error("OpenClaw process probe failed");
  }
  return result.stdout;
}

function defaultProbe(): string {
  return probeOutput(runDefaultProcessProbe, process.platform);
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;
  for (const character of command.trim()) {
    if (escaping) {
      token += character;
      escaping = false;
    } else if (character === "\\" && quote !== "'") {
      escaping = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === "'" || character === "\"") {
      quote = character;
    } else if (/\s/.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += character;
    }
  }
  if (token) tokens.push(token);
  return tokens;
}

function defaultListGatewayProcesses(
  platform: NodeJS.Platform,
  runner: (
    command: string,
    args: string[],
    options: ProcessProbeOptions
  ) => ReturnType<RuntimeDiscoveryDependencies["runCommand"]> = runDefaultProcessProbe
): GatewayProcess[] {
  const output = probeOutput(runner, platform);
  const processes: GatewayProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match?.[1] || !match[2]) continue;
    processes.push({ pid: Number(match[1]), argv: tokenizeCommand(match[2]) });
  }
  return processes;
}

function defaultRunCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxOutputBytes: number }
): ReturnType<RuntimeDiscoveryDependencies["runCommand"]> {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes
  });
  return {
    status: result.status,
    stdout: (result.stdout ?? "").slice(0, options.maxOutputBytes),
    timedOut: result.status === null && (
      result.signal === "SIGTERM" ||
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"
    ),
    ...((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS"
      ? { outputTooLarge: true }
      : {})
  };
}

function resolveDependencies(
  options: DiscoverOpenClawRuntimeOptions
): RuntimeDiscoveryDependencies {
  return {
    platform: options.platform ?? process.platform,
    homeDir: options.homeDir ?? homedir(),
    userId: Object.hasOwn(options, "userId")
      ? options.userId
      : typeof process.getuid === "function"
        ? process.getuid()
        : undefined,
    listGatewayProcesses: options.listGatewayProcesses ??
      (options.processProbe
        ? () => defaultListGatewayProcesses(
            options.platform ?? process.platform,
            options.processProbe!
          )
        : () => defaultListGatewayProcesses(options.platform ?? process.platform)),
    readTextFile: options.readTextFile ?? ((path) => readFileSync(path, "utf8")),
    listDirectory: options.listDirectory ?? ((path) => readdirSync(path)),
    runCommand: options.runCommand ?? defaultRunCommand,
    pathExists: options.pathExists ?? ((path) => {
      try {
        accessSync(path, constants.R_OK);
        return true;
      } catch {
        return false;
      }
    })
  };
}

function defaultCandidate(instance: RuntimeInstance): RuntimePathCandidateGroup | null {
  if (!instance.stateDir || !instance.openclawPath || !instance.envPath) return null;
  return createRuntimeCandidateGroup({
    instance,
    stateDir: instance.stateDir,
    openclawPath: instance.openclawPath,
    ...(instance.serviceEnvPath ? { serviceEnvPath: instance.serviceEnvPath } : {})
  });
}

function deduplicateInstances(instances: RuntimeInstance[]): RuntimeInstance[] {
  const seen = new Set<string>();
  return instances.filter((instance) => {
    const key = [
      instance.instanceId,
      instance.pid,
      instance.stateDir,
      instance.openclawPath,
      instance.serviceEnvPath
    ].join("\0");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inferDefaultPaths(
  instances: RuntimeInstance[],
  dependencies: RuntimeDiscoveryDependencies
): RuntimeInstance[] {
  const stateDir = join(dependencies.homeDir, ".openclaw");
  const openclawPath = join(stateDir, "openclaw.json");
  if (!dependencies.pathExists(openclawPath)) return instances;
  return instances.map((instance) => {
    if (instance.stateDir || instance.openclawPath) return instance;
    return {
      ...instance,
      stateDir,
      openclawPath,
      envPath: join(stateDir, ".env"),
      confidence: "inferred",
      evidence: [...new Set([...instance.evidence, "default-state-dir" as const])]
    };
  });
}

interface CliRuntimeStatus {
  pid: number;
  configPath: string;
  stateDir?: string;
}

function parseCliRuntimeStatus(
  content: string,
  homeDir: string
): CliRuntimeStatus | null {
  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    const daemon = (parsed as { daemon?: unknown }).daemon;
    if (!daemon || typeof daemon !== "object") return null;
    const pid = (daemon as { pid?: unknown }).pid;
    const configPath = (daemon as { configPath?: unknown }).configPath;
    const stateDir = (daemon as { stateDir?: unknown }).stateDir;
    const canonicalConfigPath = typeof configPath === "string"
      ? canonicalizeRuntimePath(configPath, homeDir)
      : undefined;
    const canonicalStateDir = typeof stateDir === "string"
      ? canonicalizeRuntimePath(stateDir, homeDir)
      : undefined;
    if (!Number.isInteger(pid) || !canonicalConfigPath) {
      return null;
    }
    if (stateDir !== undefined && !canonicalStateDir) {
      return null;
    }
    return {
      pid: pid as number,
      configPath: canonicalConfigPath,
      ...(canonicalStateDir ? { stateDir: canonicalStateDir } : {})
    };
  } catch {
    return null;
  }
}

function supplementWithCliStatus(
  instances: RuntimeInstance[],
  existingCandidates: RuntimePathCandidateGroup[],
  dependencies: RuntimeDiscoveryDependencies,
  diagnostics: Set<RuntimeDiscoveryDiagnosticCode>
): {
  instances: RuntimeInstance[];
  candidateGroups: RuntimePathCandidateGroup[];
} {
  let commandResult;
  try {
    commandResult = dependencies.runCommand(
      "openclaw",
      ["gateway", "status", "--json"],
      { timeoutMs: 1_500, maxOutputBytes: 65_536 }
    );
  } catch {
    diagnostics.add("cli-status-invalid");
    return { instances, candidateGroups: existingCandidates };
  }
  if (
    commandResult.outputTooLarge ||
    Buffer.byteLength(commandResult.stdout, "utf8") > 65_536
  ) {
    diagnostics.add("cli-status-output-too-large");
    return { instances, candidateGroups: existingCandidates };
  }
  if (commandResult.timedOut) {
    diagnostics.add("cli-status-timeout");
    return { instances, candidateGroups: existingCandidates };
  }
  if (commandResult.status !== 0) {
    return { instances, candidateGroups: existingCandidates };
  }
  const status = parseCliRuntimeStatus(commandResult.stdout, dependencies.homeDir);
  if (!status) {
    diagnostics.add("cli-status-invalid");
    return { instances, candidateGroups: existingCandidates };
  }
  const cliCandidates: RuntimePathCandidateGroup[] = [];
  const supplementedInstances = instances.map((instance) => {
    if (instance.pid !== status.pid) return instance;
    const relatedCandidates = existingCandidates.filter(
      (candidate) => candidate.instanceId === instance.instanceId
    );
    const cliConflicts = (
      (instance.openclawPath !== undefined &&
        instance.openclawPath !== status.configPath) ||
      (instance.stateDir !== undefined &&
        status.stateDir !== undefined &&
        instance.stateDir !== status.stateDir) ||
      relatedCandidates.some((candidate) =>
        candidate.openclawPath !== status.configPath ||
        (status.stateDir !== undefined && candidate.stateDir !== status.stateDir)
      )
    );
    if (status.stateDir) {
      cliCandidates.push(createRuntimeCandidateGroup({
        instance,
        stateDir: status.stateDir,
        openclawPath: status.configPath,
        confidence: cliConflicts ? undefined : (
          instance.serviceManager ? "confirmed" : instance.confidence
        ),
        conflicted: cliConflicts,
        evidence: [...new Set([...instance.evidence, "cli-status" as const])]
      }));
    }
    if (cliConflicts) {
      diagnostics.add("path-evidence-conflict");
      const { confidence: _confidence, ...metadata } = instance;
      return {
        ...metadata,
        conflicted: true,
        evidence: [...new Set([...instance.evidence, "cli-status" as const])]
      };
    }
    const stateDir = instance.stateDir ?? status.stateDir;
    const openclawPath = instance.openclawPath ?? status.configPath;
    const confidence = instance.serviceManager && stateDir && openclawPath
      ? "confirmed"
      : instance.confidence;
    return {
      ...instance,
      openclawPath,
      ...(stateDir ? {
        stateDir,
        envPath: join(stateDir, ".env")
      } : {}),
      ...(confidence ? { confidence } : {}),
      evidence: [...new Set([...instance.evidence, "cli-status" as const])]
    };
  });
  return {
    instances: supplementedInstances,
    candidateGroups: deduplicateRuntimeCandidateGroups([
      ...existingCandidates,
      ...cliCandidates
    ])
  };
}

/** 编排平台 probe、默认路径推断与限时 CLI status 补充 */
export function discoverOpenClawRuntime(
  options: DiscoverOpenClawRuntimeOptions = {}
): RuntimeDiscoveryResult {
  const dependencies = resolveDependencies(options);
  let processError: unknown;
  let cachedProcesses: GatewayProcess[] | undefined;
  let strictGatewayDetected = false;
  const platformDependencies: RuntimeDiscoveryDependencies = {
    ...dependencies,
    listGatewayProcesses: () => {
      if (processError) throw processError;
      if (!cachedProcesses) {
        try {
          cachedProcesses = dependencies.listGatewayProcesses()
            .filter(isStrictOpenClawGatewayProcess);
          strictGatewayDetected = cachedProcesses.length > 0;
        } catch (error) {
          processError = error;
          throw error;
        }
      }
      return cachedProcesses;
    }
  };
  const platformResult = dependencies.platform === "darwin"
    ? discoverMacOSOpenClawRuntime(platformDependencies)
    : dependencies.platform === "linux"
      ? discoverLinuxOpenClawRuntime(platformDependencies)
      : {
          status: "gateway-not-detected" as const,
          instances: [],
          candidateGroups: [],
          diagnostics: []
        };
  const diagnostics = new Set(platformResult.diagnostics);
  let instances = deduplicateInstances(platformResult.instances);
  let candidateGroups = [...platformResult.candidateGroups];
  instances = inferDefaultPaths(instances, dependencies);
  candidateGroups = deduplicateRuntimeCandidateGroups([
    ...candidateGroups,
    ...instances
      .map(defaultCandidate)
      .filter((candidate): candidate is RuntimePathCandidateGroup => candidate !== null)
  ]);
  if (
    instances.some((instance) => !instance.openclawPath || !instance.stateDir) ||
    diagnostics.has("path-evidence-conflict")
  ) {
    const supplemented = supplementWithCliStatus(
      instances,
      candidateGroups,
      dependencies,
      diagnostics
    );
    instances = supplemented.instances;
    candidateGroups = supplemented.candidateGroups;
  }
  instances = deduplicateInstances(instances);
  candidateGroups = deduplicateRuntimeCandidateGroups([
    ...candidateGroups,
    ...instances
      .map(defaultCandidate)
      .filter((candidate): candidate is RuntimePathCandidateGroup => candidate !== null)
  ]);
  const resolved = candidateGroups.some(
    (candidate) => candidate.confidence !== undefined
  );
  const platformGatewayDetected = (
    platformResult.status === "resolved" ||
    platformResult.status === "gateway-detected-path-unresolved"
  );
  const gatewayDetected = strictGatewayDetected ||
    platformGatewayDetected ||
    instances.length > 0;
  const status = resolved
    ? "resolved"
    : gatewayDetected
      ? "gateway-detected-path-unresolved"
      : diagnostics.has("process-probe-failed")
        ? "probe-failed"
        : "gateway-not-detected";
  return {
    status,
    instances,
    candidateGroups,
    diagnostics: [...diagnostics]
  };
}

/** 轻量探测运行中的 OpenClaw 实例；失败时返回空数组 */
export function discoverRunningOpenClawInstances(options: DiscoverRunningInstancesOptions = {}): LegacyRunningOpenClawInstance[] {
  try {
    const output = (options.probe ?? defaultProbe)();
    const instances: LegacyRunningOpenClawInstance[] = [];
    const seen = new Set<number>();
    for (const line of output.split(/\n/)) {
      const parsed = parsePgrepLine(line);
      if (!parsed?.openclawPath || seen.has(parsed.pid)) continue;
      seen.add(parsed.pid);
      instances.push(parsed);
    }
    return instances;
  } catch {
    return [];
  }
}
