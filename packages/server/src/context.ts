import {
  defaultPresetDirs,
  discoverOpenClawRuntime,
  discoverPluginCatalog,
  getActivePaths,
  isProviderDisabled,
  readProviderStates,
  providerEnvVar as coreProviderEnvVar,
  resolveProviderId,
  type FetchImpl,
  type OcSwitchPaths,
  type OpenClawConfig,
  type PluginCatalogResult,
  type PluginProvider,
  type PresetDirs,
  type RuntimeDiscoveryProvider
} from "@oc-switch/core";
import JSON5 from "json5";
import { existsSync, readFileSync } from "node:fs";

import type { GatewayRouteOptions } from "./routes/gateway";

/** 插件 catalog 发现来源（生产 = openclaw plugins list shell-out；测试注入）。 */
export type PluginCatalogProvider = () => PluginCatalogResult;

const PLUGIN_CATALOG_CACHE_TTL_MS = 30_000;

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
  /** 测试注入：插件 provider 目录发现 */
  pluginCatalogProvider?: PluginCatalogProvider;
}

export interface AppRuntime {
  options: AppOptions;
  presetDirs: PresetDirs;
  fetchImpl: FetchImpl;
  runtimeDiscoveryProvider: RuntimeDiscoveryProvider;
  currentPaths(): OcSwitchPaths;
  setActivePaths(paths: OcSwitchPaths): void;
  /** 插件 provider 目录（30s TTL 缓存；失败降级为空列表）。 */
  currentPluginProviders(): PluginProvider[];
}

export function createAppRuntime(options: AppOptions): AppRuntime {
  const runtimeDiscoveryProvider =
    options.runtimeDiscoveryProvider ?? discoverOpenClawRuntime;
  const pluginCatalogProvider = options.pluginCatalogProvider ?? discoverPluginCatalog;
  let pluginCatalogCache: { at: number; providers: PluginProvider[] } | undefined;
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
    },
    currentPluginProviders() {
      const now = Date.now();
      if (pluginCatalogCache && now - pluginCatalogCache.at < PLUGIN_CATALOG_CACHE_TTL_MS) {
        return pluginCatalogCache.providers;
      }
      let providers: PluginProvider[] = [];
      try {
        providers = pluginCatalogProvider().providers;
      } catch {
        // 发现失败降级为空，不阻断主流程
      }
      pluginCatalogCache = { at: now, providers };
      return providers;
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
