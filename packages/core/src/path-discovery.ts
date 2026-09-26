import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseLaunchAgentGatewayMetadata } from "./gateway-launchd-metadata";
import { discoverLinuxOpenClawRuntime } from "./path-discovery-linux";
import { discoverMacOSOpenClawRuntime } from "./path-discovery-macos";
import { defaultPaths, readOcSwitchSettings } from "./paths";
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
  RuntimeCommandResult,
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

/** launchctl print 探测预算（与 path-discovery-macos 内部一致） */
const LAUNCHCTL_PROBE_OPTIONS: ProcessProbeOptions = {
  timeoutMs: 1_000,
  maxOutputBytes: 16_384
};
/** systemctl --user list-units 探测预算（与 path-discovery-linux 内部一致） */
const SYSTEMCTL_LIST_UNITS_ARGS = [
  "--user",
  "list-units",
  "--type=service",
  "--state=running",
  "--no-legend",
  "--plain"
];
const SYSTEMCTL_LIST_UNITS_OPTIONS: ProcessProbeOptions = {
  timeoutMs: 250,
  maxOutputBytes: 65_536
};
/** systemctl --user show 单 unit 探测预算（与 path-discovery-linux 内部一致） */
const SYSTEMCTL_SHOW_OPTIONS: ProcessProbeOptions = {
  timeoutMs: 250,
  maxOutputBytes: 16_384
};
/** openclaw gateway status --json 补充探测预算（与 supplementWithCliStatus 内部一致） */
const CLI_STATUS_ARGS = ["gateway", "status", "--json"];
const CLI_STATUS_PROBE_OPTIONS: ProcessProbeOptions = {
  timeoutMs: 1_500,
  maxOutputBytes: 65_536
};
/** 与 path-discovery-linux 的枚举上限保持一致 */
const SYSTEMD_UNIT_CANDIDATE_LIMIT = 16;

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

function parseGatewayProcessLines(output: string): GatewayProcess[] {
  const processes: GatewayProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match?.[1] || !match[2]) continue;
    processes.push({ pid: Number(match[1]), argv: tokenizeCommand(match[2]) });
  }
  return processes;
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
  return parseGatewayProcessLines(output);
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

/**
 * 判断 active 两个路径是否均已显式确定（OPENCLAW_CONFIG_PATH 环境变量或 oc-switch settings）。
 * 均已显式时调用方可跳过运行实例 discovery：settings/环境变量优先级高于候选组，
 * 解析结果与携带 discovery 完全一致。config 已指定但 envPath 未指定时不得视为显式
 * （envPath 仍可能来自运行实例候选），不得擅自推断。
 */
export function areRuntimeDiscoveryPathsExplicit(
  options: {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
    stateDir?: string;
  } = {}
): boolean {
  const env = (options.env ?? process.env) as NodeJS.ProcessEnv;
  const stateDir = options.stateDir ?? defaultPaths(env).stateDir;
  const settings = readOcSwitchSettings(stateDir);
  const configExplicit =
    Boolean(env.OPENCLAW_CONFIG_PATH?.trim()) || settings.openclawPath !== undefined;
  const envExplicit = settings.envPath !== undefined;
  return configExplicit && envExplicit;
}

/** 异步有界进程 runner：与 runDefaultProcessProbe 相同的结果语义，但基于 spawn，不阻塞事件循环 */
function runDefaultAsyncProcessProbe(
  command: string,
  args: string[],
  options: ProcessProbeOptions
): Promise<RuntimeCommandResult> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      // spawn 同步抛错（如命令不存在于 PATH 的个别平台行为）按命令缺失处理，与 spawnSync status=null 一致
      resolve({ status: null, stdout: "", timedOut: false });
      return;
    }
    let stdout = "";
    let outputBytes = 0;
    let outputTooLarge = false;
    let settled = false;
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
    }, options.timeoutMs);
    const finish = (result: RuntimeCommandResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        // 与 spawnSync ENOBUFS 对齐：截断输出并标记 oversize
        outputTooLarge = true;
        child.kill("SIGTERM");
        return;
      }
      stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", () => {
      // ENOENT 等：status=null 且非超时，同 spawnSync 的 error 语义
      finish({ status: null, stdout, timedOut: false });
    });
    child.on("close", (code, signal) => {
      finish({
        status: code,
        stdout: stdout.slice(0, options.maxOutputBytes),
        // 与同步 probeOutput 一致：status=null 且 SIGTERM 视为超时
        timedOut: code === null && signal === "SIGTERM",
        ...(outputTooLarge ? { outputTooLarge: true } : {})
      });
    });
  });
}

/** 校验异步进程探测输出，映射与同步 probeOutput 相同的失败条件 */
function validateProcessProbeResult(result: RuntimeCommandResult): string {
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

function systemdShowArgs(unitId: string): string[] {
  return [
    "--user",
    "show",
    unitId,
    "--property=MainPID",
    "--property=FragmentPath",
    "--property=EnvironmentFiles"
  ];
}

/** 读取进程 environ 中认领的 systemd unit（与 path-discovery-linux 的 whitelist 解析语义一致） */
function readClaimedSystemdUnit(
  readTextFile: (path: string) => string,
  pid: number
): string | undefined {
  try {
    const content = readTextFile(`/proc/${pid}/environ`);
    for (const entry of content.split(/\0|\r?\n/)) {
      if (entry.startsWith("OPENCLAW_SYSTEMD_UNIT=")) {
        const unitId = entry.slice("OPENCLAW_SYSTEMD_UNIT=".length);
        return unitId || undefined;
      }
    }
  } catch {
    // environ 不可读按未认领处理，诊断由解析阶段给出
  }
  return undefined;
}

export type AsyncProcessProbe = (
  command: string,
  args: string[],
  options: ProcessProbeOptions
) => Promise<RuntimeCommandResult>;

export interface DiscoverOpenClawRuntimeAsyncOptions {
  platform?: NodeJS.Platform;
  homeDir?: string;
  // 与同步 RuntimeDiscoveryDependencies 口径一致：允许显式 undefined
  userId?: number | undefined;
  /** 测试注入：替代默认异步进程 runner（如注入延迟 gate） */
  processProbe?: AsyncProcessProbe;
  /** 测试注入：替代默认异步 pgrep 进程列表探测 */
  listGatewayProcesses?: () => Promise<GatewayProcess[]>;
  /** 测试注入：替代默认异步子进程命令 runner */
  runCommand?: AsyncProcessProbe;
  readTextFile?: (path: string) => string;
  listDirectory?: (path: string) => string[];
  pathExists?: (path: string) => boolean;
}

/**
 * discoverOpenClawRuntime 的真正异步变体：子进程调用先并发起跑（有界超时/输出），
 * 再驱动同一条同步解析流水线（复用现有解析器与候选归并规则）。解析阶段命中预取表，
 * 不阻塞事件循环；未预见到的命令回退同步有界探测保证正确性。
 */
export async function discoverOpenClawRuntimeAsync(
  options: DiscoverOpenClawRuntimeAsyncOptions = {}
): Promise<RuntimeDiscoveryResult> {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const userId = Object.hasOwn(options, "userId")
    ? options.userId
    : typeof process.getuid === "function"
      ? process.getuid()
      : undefined;
  const readTextFile = options.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
  const listDirectory = options.listDirectory ?? ((path: string) => readdirSync(path));
  const pathExists = options.pathExists ?? ((path: string) => {
    try {
      accessSync(path, constants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
  const processProbe = options.processProbe ?? runDefaultAsyncProcessProbe;
  const runCommandAsync = options.runCommand ?? processProbe;

  // 预取表：异步阶段并发起跑同步流水线将发起的子进程调用
  const prefetched = new Map<string, RuntimeCommandResult | Error>();
  const commandKey = (command: string, args: string[]) => JSON.stringify([command, ...args]);
  const prefetch = (
    batch: Promise<unknown>[],
    command: string,
    args: string[],
    probeOptions: ProcessProbeOptions
  ): void => {
    batch.push(
      runCommandAsync(command, args, probeOptions).then(
        (result) => { prefetched.set(commandKey(command, args), result); },
        (error) => {
          prefetched.set(
            commandKey(command, args),
            error instanceof Error ? error : new Error(String(error))
          );
        }
      )
    );
  };

  // 第一段：进程列表探测与平台服务探测无依赖，并行发起
  let gatewayProcesses: GatewayProcess[] | undefined;
  let processProbeError: unknown;
  const stage1: Promise<unknown>[] = [];
  const listProcesses =
    options.listGatewayProcesses ??
    (async () =>
      parseGatewayProcessLines(
        validateProcessProbeResult(
          await processProbe(
            "pgrep",
            platform === "linux" ? ["-af", "openclaw"] : ["-fl", "openclaw"],
            PROCESS_PROBE_OPTIONS
          )
        )
      ));
  stage1.push(
    listProcesses().then(
      (processes) => { gatewayProcesses = processes; },
      (error) => { processProbeError = error; }
    )
  );

  if (platform === "darwin" && userId !== undefined) {
    // macOS：每个可解析的 LaunchAgent 都会发起 launchctl print（与平台模块行为一致）
    const launchAgentsDir = join(homeDir, "Library/LaunchAgents");
    let plistNames: string[] = [];
    try {
      plistNames = listDirectory(launchAgentsDir)
        .filter((name) => /^ai\.openclaw\..+\.plist$/.test(name))
        .sort();
    } catch {
      // 目录缺失由解析阶段诊断
    }
    for (const plistName of plistNames) {
      try {
        parseLaunchAgentGatewayMetadata(readTextFile(join(launchAgentsDir, plistName)));
      } catch {
        // 解析失败（含元数据非法/文件不可读）由同步阶段重新诊断，不预取
        continue;
      }
      const label = plistName.slice(0, -".plist".length);
      prefetch(stage1, "launchctl", ["print", `gui/${userId}/${label}`], LAUNCHCTL_PROBE_OPTIONS);
    }
  }
  await Promise.all(stage1);

  const strictProcesses = (gatewayProcesses ?? []).filter(isStrictOpenClawGatewayProcess);

  // 第二段：依赖进程结果的预取（有进程时才可能用到的命令）
  const stage2: Promise<unknown>[] = [];
  if (gatewayProcesses !== undefined && strictProcesses.length > 0) {
    // 实例不完整或路径证据冲突时的 CLI status 补充
    prefetch(stage2, "openclaw", CLI_STATUS_ARGS, CLI_STATUS_PROBE_OPTIONS);
    if (platform === "linux") {
      const claimedUnits = new Set<string>();
      let anyUnclaimed = false;
      for (const process of strictProcesses) {
        const unitId = readClaimedSystemdUnit(readTextFile, process.pid);
        if (unitId) claimedUnits.add(unitId);
        else anyUnclaimed = true;
      }
      for (const unitId of claimedUnits) {
        prefetch(stage2, "systemctl", systemdShowArgs(unitId), SYSTEMCTL_SHOW_OPTIONS);
      }
      if (anyUnclaimed) {
        // 先取 list-units，再按同一候选规则补 show（与平台模块的枚举逻辑一致）
        const listed = await runCommandAsync(
          "systemctl",
          SYSTEMCTL_LIST_UNITS_ARGS,
          SYSTEMCTL_LIST_UNITS_OPTIONS
        ).then(
          (result) => { prefetched.set(commandKey("systemctl", SYSTEMCTL_LIST_UNITS_ARGS), result); return result; },
          (error) => {
            prefetched.set(
              commandKey("systemctl", SYSTEMCTL_LIST_UNITS_ARGS),
              error instanceof Error ? error : new Error(String(error))
            );
            return undefined;
          }
        );
        const candidateUnits = new Set<string>();
        try {
          for (const name of listDirectory(join(homeDir, ".config/systemd/user"))) {
            candidateUnits.add(name);
          }
        } catch {
          // 用户 unit 目录可能不存在，与平台模块一致忽略
        }
        if (listed && listed.status === 0) {
          for (const line of listed.stdout.split(/\r?\n/)) {
            const unit = line.trim().split(/\s+/, 1)[0];
            if (unit?.endsWith(".service")) candidateUnits.add(unit);
          }
        }
        const bounded = [...candidateUnits]
          .filter((unit) => unit.endsWith(".service") && /(openclaw|gateway)/i.test(unit))
          .sort()
          .slice(0, SYSTEMD_UNIT_CANDIDATE_LIMIT);
        for (const unit of bounded) {
          if (prefetched.has(commandKey("systemctl", systemdShowArgs(unit)))) continue;
          prefetch(stage2, "systemctl", systemdShowArgs(unit), SYSTEMCTL_SHOW_OPTIONS);
        }
      }
    }
  }
  await Promise.all(stage2);

  // 解析阶段：复用现有完整流水线（解析器、候选归并、诊断与同步入口完全一致）
  return discoverOpenClawRuntime({
    platform,
    homeDir,
    userId,
    readTextFile,
    listDirectory,
    pathExists,
    listGatewayProcesses: () => {
      if (processProbeError) throw processProbeError;
      return gatewayProcesses ?? [];
    },
    runCommand: (command, args, probeOptions) => {
      const hit = prefetched.get(commandKey(command, args));
      if (hit instanceof Error) throw hit;
      if (hit) return hit;
      // 未预见到的命令：回退同步有界探测，保证正确性
      return runDefaultProcessProbe(command, args, probeOptions);
    }
  });
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
