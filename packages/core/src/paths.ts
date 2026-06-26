import { accessSync, constants, existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { readJsonState, writeJsonState } from "./json-state-store";

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
  source: PathCandidateSource;
  label: string;
  recommended: boolean;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  parentWritable: boolean;
}

export interface RunningOpenClawInstance {
  pid: number;
  openclawPath?: string;
  envPath?: string;
}

export interface PathCandidateResult {
  active: OcSwitchPaths;
  openclawPaths: PathCandidate[];
  envPaths: PathCandidate[];
}

export interface ActivePathOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  stateDir?: string;
  runningInstances?: RunningOpenClawInstance[];
}

export interface CandidateOptions extends ActivePathOptions {
  runningInstances?: RunningOpenClawInstance[];
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
  const running = options.runningInstances?.find((instance) => instance.openclawPath || instance.envPath);
  const openclawPath = env.OPENCLAW_CONFIG_PATH?.trim()
    ? resolveUserPath(env.OPENCLAW_CONFIG_PATH, env)
    : settings.openclawPath ?? running?.openclawPath ?? defaults.openclawPath;
  return {
    openclawPath,
    envPath: settings.envPath ?? running?.envPath ?? defaults.envPath,
    stateDir
  };
}

function candidate(path: string, source: PathCandidateSource, label: string, recommended: boolean): PathCandidate {
  const exists = existsSync(path);
  return {
    path,
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
  }
}

export function resolveOpenClawPathCandidates(options: CandidateOptions = {}): PathCandidateResult {
  const env = options.env ?? process.env;
  const defaults = defaultPaths(env as NodeJS.ProcessEnv);
  const stateDir = options.stateDir ?? defaults.stateDir;
  const active = getActivePaths({
    env,
    stateDir,
    ...(options.runningInstances ? { runningInstances: options.runningInstances } : {})
  });
  const openclawPaths: PathCandidate[] = [];
  const envPaths: PathCandidate[] = [];

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

  return { active, openclawPaths, envPaths };
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
