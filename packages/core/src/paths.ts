import { accessSync, constants, existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readJsonState, writeJsonState } from "./json-state-store";
import type {
  LegacyRunningOpenClawInstance,
  RuntimeDiscoveryResult,
  RuntimePathCandidateGroup
} from "./runtime-discovery-types";

export interface OcSwitchPaths {
  openclawPath: string;
  envPath: string;
  stateDir: string;
}

export interface OcSwitchSettings {
  openclawPath?: string;
  envPath?: string;
}

export type PathCandidateSource =
  | "running-instance"
  | "openclaw-default"
  | "openclaw-state-dir"
  | "oc-switch-settings"
  | "manual";

export interface PathCandidate {
  path: string;
  candidateId?: string;
  source: PathCandidateSource;
  label: string;
  recommended: boolean;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  parentWritable: boolean;
}

export interface PathCandidateResult {
  active: OcSwitchPaths;
  openclawPaths: PathCandidate[];
  envPaths: PathCandidate[];
  runtimeDiscovery?: RuntimeDiscoveryResult;
  runtimeCandidateGroups: RuntimePathCandidateGroup[];
}

export interface ActivePathOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  stateDir?: string;
  runtimeDiscovery?: RuntimeDiscoveryResult;
  /** @deprecated 仅供旧调用方兼容；生产调用必须传入 runtimeDiscovery */
  runningInstances?: LegacyRunningOpenClawInstance[];
}

export interface CandidateOptions extends ActivePathOptions {
  manualOpenClawPaths?: string[];
  manualEnvPaths?: string[];
}

const SETTINGS_FILE = "settings.json";

function envHome(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
  return env.OPENCLAW_HOME?.trim() || env.HOME?.trim() || homedir();
}

function resolveUserPath(path: string, env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
  if (path === "~") return envHome(env);
  if (path.startsWith("~/")) return join(envHome(env), path.slice(2));
  return resolve(path);
}

function defaultStateDir(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): string {
  const explicit = env.OPENCLAW_STATE_DIR?.trim();
  return explicit ? resolveUserPath(explicit, env) : join(envHome(env), ".openclaw");
}

function canRead(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function canWrite(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function parentWritable(path: string): boolean {
  try {
    accessSync(dirname(path), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function defaultPaths(env: NodeJS.ProcessEnv = process.env): OcSwitchPaths {
  const stateDir = join(envHome(env), ".oc-switch");
  const openclawStateDir = defaultStateDir(env);
  const openclawPath = env.OPENCLAW_CONFIG_PATH?.trim()
    ? resolveUserPath(env.OPENCLAW_CONFIG_PATH, env)
    : join(openclawStateDir, "openclaw.json");
  return {
    openclawPath,
    envPath: join(openclawStateDir, ".env"),
    stateDir
  };
}

export function readOcSwitchSettings(stateDir: string): OcSwitchSettings {
  return readJsonState({
    stateDir,
    filename: SETTINGS_FILE,
    fallback: () => ({}),
    normalize(value) {
      if (typeof value !== "object" || value === null) return {};
      const parsed = value as Partial<OcSwitchSettings>;
      return {
        ...(typeof parsed.openclawPath === "string" ? { openclawPath: parsed.openclawPath } : {}),
        ...(typeof parsed.envPath === "string" ? { envPath: parsed.envPath } : {})
      };
    }
  });
}

export function writeOcSwitchSettings(stateDir: string, settings: OcSwitchSettings): void {
  writeJsonState({
    stateDir,
    filename: SETTINGS_FILE,
    value: settings
  });
}

export function getActivePaths(options: ActivePathOptions = {}): OcSwitchPaths {
  const env = options.env ?? process.env;
  const defaults = defaultPaths(env as NodeJS.ProcessEnv);
  const stateDir = options.stateDir ?? defaults.stateDir;
  const settings = readOcSwitchSettings(stateDir);
  const runtimeGroup = uniqueAutomaticRuntimeGroup(options.runtimeDiscovery);
  // 一旦传入完整 discovery，旧 runningInstances 不得绕过置信度/唯一性门禁。
  const legacyRunning = options.runtimeDiscovery
    ? undefined
    : options.runningInstances?.find((instance) => instance.openclawPath || instance.envPath);
  const openclawPath = env.OPENCLAW_CONFIG_PATH?.trim()
    ? resolveUserPath(env.OPENCLAW_CONFIG_PATH, env)
    : settings.openclawPath ??
      runtimeGroup?.openclawPath ??
      legacyRunning?.openclawPath ??
      defaults.openclawPath;
  return {
    openclawPath,
    envPath: settings.envPath ??
      runtimeGroup?.envPath ??
      legacyRunning?.envPath ??
      defaults.envPath,
    stateDir
  };
}

function uniqueAutomaticRuntimeGroup(
  discovery: RuntimeDiscoveryResult | undefined
): RuntimePathCandidateGroup | undefined {
  if (discovery?.status !== "resolved" || discovery.candidateGroups.length !== 1) {
    return undefined;
  }
  const [group] = discovery.candidateGroups;
  if (
    !group ||
    group.conflicted ||
    (group.confidence !== "confirmed" && group.confidence !== "strong") ||
    !group.openclawPath ||
    !group.envPath
  ) {
    return undefined;
  }
  return group;
}

function candidate(
  path: string,
  source: PathCandidateSource,
  label: string,
  recommended: boolean,
  candidateId?: string
): PathCandidate {
  const exists = existsSync(path);
  return {
    path,
    ...(candidateId ? { candidateId } : {}),
    source,
    label,
    recommended,
    exists,
    readable: exists && canRead(path),
    writable: exists ? canWrite(path) : false,
    parentWritable: parentWritable(path)
  };
}

function addCandidate(list: PathCandidate[], next: PathCandidate): void {
  const existing = list.find((item) => item.path === next.path);
  if (!existing) {
    list.push(next);
    return;
  }
  existing.recommended ||= next.recommended;
  if (existing.source !== "running-instance" && next.source === "running-instance") {
    existing.source = next.source;
    existing.label = next.label;
    if (next.candidateId) existing.candidateId = next.candidateId;
  } else if (!existing.candidateId && next.candidateId) {
    existing.candidateId = next.candidateId;
  } else if (
    existing.candidateId &&
    next.candidateId &&
    existing.candidateId !== next.candidateId
  ) {
    // 同路径对应多个候选组时，扁平列表不再挂单一 candidateId；以 runtimeCandidateGroups 为准。
    delete existing.candidateId;
    existing.recommended = false;
  }
}

export function resolveOpenClawPathCandidates(options: CandidateOptions = {}): PathCandidateResult {
  const env = options.env ?? process.env;
  const defaults = defaultPaths(env as NodeJS.ProcessEnv);
  const stateDir = options.stateDir ?? defaults.stateDir;
  const active = getActivePaths({
    env,
    stateDir,
    ...(options.runtimeDiscovery
      ? { runtimeDiscovery: options.runtimeDiscovery }
      : {}),
    ...(options.runningInstances ? { runningInstances: options.runningInstances } : {})
  });
  const openclawPaths: PathCandidate[] = [];
  const envPaths: PathCandidate[] = [];

  for (const group of options.runtimeDiscovery?.candidateGroups ?? []) {
    const recommended = !group.conflicted && group.confidence !== undefined;
    const label = `运行中 OpenClaw 实例 ${group.instanceId}`;
    addCandidate(
      openclawPaths,
      candidate(
        group.openclawPath,
        "running-instance",
        label,
        recommended,
        group.candidateId
      )
    );
    addCandidate(
      envPaths,
      candidate(
        group.envPath,
        "running-instance",
        label,
        recommended,
        group.candidateId
      )
    );
  }

  // 旧轻量结果只保留兼容展示，不参与新的候选组校验。
  for (const instance of options.runningInstances ?? []) {
    if (instance.openclawPath) addCandidate(openclawPaths, candidate(instance.openclawPath, "running-instance", `运行中 OpenClaw 进程 ${instance.pid}`, true));
    if (instance.envPath) addCandidate(envPaths, candidate(instance.envPath, "running-instance", `运行中 OpenClaw 进程 ${instance.pid}`, true));
  }

  addCandidate(openclawPaths, candidate(defaults.openclawPath, "openclaw-default", "OpenClaw 默认配置路径", false));
  addCandidate(envPaths, candidate(defaults.envPath, "openclaw-default", "OpenClaw 默认 env 路径", false));

  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    const openclawStateDir = resolveUserPath(stateOverride, env);
    addCandidate(openclawPaths, candidate(join(openclawStateDir, "openclaw.json"), "openclaw-state-dir", "OPENCLAW_STATE_DIR 推导配置路径", false));
    addCandidate(envPaths, candidate(join(openclawStateDir, ".env"), "openclaw-state-dir", "OPENCLAW_STATE_DIR 推导 env 路径", false));
  }

  const settings = readOcSwitchSettings(stateDir);
  if (settings.openclawPath) addCandidate(openclawPaths, candidate(settings.openclawPath, "oc-switch-settings", "oc-switch 当前配置", false));
  if (settings.envPath) addCandidate(envPaths, candidate(settings.envPath, "oc-switch-settings", "oc-switch 当前配置", false));

  for (const path of options.manualOpenClawPaths ?? []) addCandidate(openclawPaths, candidate(path, "manual", "手动指定", false));
  for (const path of options.manualEnvPaths ?? []) addCandidate(envPaths, candidate(path, "manual", "手动指定", false));

  return {
    active,
    openclawPaths,
    envPaths,
    ...(options.runtimeDiscovery
      ? { runtimeDiscovery: options.runtimeDiscovery }
      : {}),
    runtimeCandidateGroups: options.runtimeDiscovery?.candidateGroups ?? []
  };
}

/** 切换 active openclaw.json 路径前的校验 */
export function validateOpenClawPathForSwitch(openclawPath: string): void {
  if (!existsSync(openclawPath)) {
    throw new Error(`openclaw.json 不存在: ${openclawPath}`);
  }
  const stat = lstatSync(openclawPath);
  if (stat.isSymbolicLink()) {
    throw new Error(`openclaw.json 路径为符号链接，首版不支持切换: ${openclawPath}`);
  }
  if (!stat.isFile()) {
    throw new Error(`openclaw.json 必须是普通文件: ${openclawPath}`);
  }
  if (!canRead(openclawPath)) {
    throw new Error(`openclaw.json 不可读: ${openclawPath}`);
  }
}

/** 切换 active env 路径前的校验；不存在时要求父目录可写 */
export function validateEnvPathForSwitch(envPath: string): void {
  if (existsSync(envPath)) {
    const stat = lstatSync(envPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`.env 路径为符号链接，首版不支持切换: ${envPath}`);
    }
    if (!stat.isFile()) {
      throw new Error(`.env 必须是普通文件: ${envPath}`);
    }
    if (!canRead(envPath)) {
      throw new Error(`.env 不可读: ${envPath}`);
    }
    return;
  }
  if (!parentWritable(envPath)) {
    throw new Error(`.env 不存在且父目录不可写: ${envPath}`);
  }
}

export interface ValidateRuntimePathSelectionInput {
  openclawPath: string;
  envPath: string;
  candidateId?: string;
  discovery: RuntimeDiscoveryResult;
}

/** 校验运行实例候选组关联；无 candidateId 时按明确手动模式处理 */
export function validateRuntimePathSelection(
  input: ValidateRuntimePathSelectionInput
): void {
  const serviceEnvPaths = new Set(
    input.discovery.candidateGroups.flatMap((group) =>
      group.serviceEnvPath ? [group.serviceEnvPath] : []
    )
  );
  if (serviceEnvPaths.has(input.envPath)) {
    throw new Error("不能将 Gateway service env 运行时快照设为 active envPath");
  }

  if (input.candidateId) {
    const group = input.discovery.candidateGroups.find(
      (candidateGroup) => candidateGroup.candidateId === input.candidateId
    );
    if (!group) {
      throw new Error(`candidateId 已过期或不存在: ${input.candidateId}`);
    }
    if (
      group.openclawPath !== input.openclawPath ||
      group.envPath !== input.envPath
    ) {
      throw new Error("运行实例候选的路径配对不匹配");
    }
  }

  validateOpenClawPathForSwitch(input.openclawPath);
  validateEnvPathForSwitch(input.envPath);
}
