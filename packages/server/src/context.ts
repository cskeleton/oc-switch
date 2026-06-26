import {
  defaultPresetDirs,
  getActivePaths,
  isProviderDisabled,
  readProviderStates,
  type FetchImpl,
  type OcSwitchPaths,
  type OpenClawConfig,
  type PresetDirs,
  type ProviderSummary,
  type RunningOpenClawInstance
} from "@oc-switch/core";
import JSON5 from "json5";
import { existsSync, readFileSync } from "node:fs";

export interface AppOptions {
  token: string;
  paths?: OcSwitchPaths;
  presetDirs?: PresetDirs;
  fetchImpl?: FetchImpl;
  bindAddress?: string;
  port?: number;
  /** 测试注入：覆盖运行实例发现 */
  runningInstances?: RunningOpenClawInstance[];
}

export interface AppRuntime {
  options: AppOptions;
  presetDirs: PresetDirs;
  fetchImpl: FetchImpl;
  currentPaths(): OcSwitchPaths;
  setActivePaths(paths: OcSwitchPaths): void;
}

export function createAppRuntime(options: AppOptions): AppRuntime {
  let activePaths = options.paths ?? getActivePaths();
  const currentPaths = () => activePaths;
  const presetDirs = options.presetDirs ?? defaultPresetDirs(currentPaths().stateDir);
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    options,
    presetDirs,
    fetchImpl,
    currentPaths,
    setActivePaths(paths) {
      activePaths = paths;
    }
  };
}

export function readConfig(paths: OcSwitchPaths): OpenClawConfig {
  if (!existsSync(paths.openclawPath)) {
    throw new Error("openclaw.json not found");
  }
  return JSON5.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
}

export function readEnvContent(paths: OcSwitchPaths): string | undefined {
  return existsSync(paths.envPath) ? readFileSync(paths.envPath, "utf8") : undefined;
}

export function providerEnvVar(config: OpenClawConfig, providerId: string): string | undefined {
  const provider = config.models?.providers?.[providerId];
  return provider?.apiKey?.id ?? provider?.authHeader?.id;
}

function disabledProviderError(providerId: string): Error {
  return new Error(`Provider ${providerId} is disabled. Restore the provider before enabling models.`);
}

export function assertProviderCanEnable(paths: OcSwitchPaths, providerId: string): void {
  if (isProviderDisabled(paths.stateDir, providerId)) {
    throw disabledProviderError(providerId);
  }
}

export function withDisabledStatus(paths: OcSwitchPaths, providers: ProviderSummary[]): ProviderSummary[] {
  const states = readProviderStates(paths.stateDir);
  return providers.map((provider) => ({
    ...provider,
    disabled: Boolean(states.disabledProviders[provider.id])
  }));
}
