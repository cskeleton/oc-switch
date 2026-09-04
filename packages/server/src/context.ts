import {
  defaultPresetDirs,
  discoverOpenClawRuntime,
  getActivePaths,
  isProviderDisabled,
  readProviderStates,
  providerEnvVar as coreProviderEnvVar,
  resolveProviderId,
  type FetchImpl,
  type OcSwitchPaths,
  type OpenClawConfig,
  type PresetDirs,
  type RuntimeDiscoveryProvider
} from "@oc-switch/core";
import JSON5 from "json5";
import { existsSync, readFileSync } from "node:fs";

import type { GatewayRouteOptions } from "./routes/gateway";

export interface AppOptions {
  token: string;
  paths?: OcSwitchPaths;
  presetDirs?: PresetDirs;
  fetchImpl?: FetchImpl;
  bindAddress?: string;
  port?: number;
  /** 测试注入：覆盖完整运行实例发现 */
  runtimeDiscoveryProvider?: RuntimeDiscoveryProvider;
  /** 测试注入：Gateway sync/restart */
  gatewayRouteOptions?: GatewayRouteOptions;
}

export interface AppRuntime {
  options: AppOptions;
  presetDirs: PresetDirs;
  fetchImpl: FetchImpl;
  runtimeDiscoveryProvider: RuntimeDiscoveryProvider;
  currentPaths(): OcSwitchPaths;
  setActivePaths(paths: OcSwitchPaths): void;
}

export function createAppRuntime(options: AppOptions): AppRuntime {
  const runtimeDiscoveryProvider =
    options.runtimeDiscoveryProvider ?? discoverOpenClawRuntime;
  let activePaths = options.paths ?? getActivePaths({
    runtimeDiscovery: runtimeDiscoveryProvider()
  });
  const currentPaths = () => activePaths;
  const presetDirs = options.presetDirs ?? defaultPresetDirs(currentPaths().stateDir);
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    options,
    presetDirs,
    fetchImpl,
    runtimeDiscoveryProvider,
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
  const resolvedProviderId = resolveProviderId(config, providerId);
  return coreProviderEnvVar(resolvedProviderId ? config.models?.providers?.[resolvedProviderId] : undefined);
}

function disabledProviderError(providerId: string): Error {
  return new Error(`Provider ${providerId} is disabled. Restore the provider before enabling models.`);
}

export function assertProviderCanEnable(paths: OcSwitchPaths, providerId: string): void {
  if (isProviderDisabled(paths.stateDir, providerId)) {
    throw disabledProviderError(providerId);
  }
}

/** 统一读取供 adapter 聚合的 disabled Provider ID，避免 status/providers 各自计算。 */
export function readDisabledProviderIds(paths: OcSwitchPaths): string[] {
  return Object.keys(readProviderStates(paths.stateDir).disabledProviders);
}
