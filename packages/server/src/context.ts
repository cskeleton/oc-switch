import {
  buildModelInventory,
  defaultPresetDirs,
  discoverOpenClawRuntime,
  discoverPluginCatalog,
  discoverRuntimeModelCatalog,
  getActivePaths,
  isProviderDisabled,
  readProviderStates,
  providerEnvVar as coreProviderEnvVar,
  resolveProviderId,
  type FetchImpl,
  type ModelInventory,
  type ModelPluginDescriptor,
  type OcSwitchPaths,
  type OpenClawConfig,
  type PluginCatalogResult,
  type PluginProvider,
  type PresetDirs,
  type RuntimeDiscoveryProvider,
  type RuntimeModelSnapshot
} from "@oc-switch/core";
import JSON5 from "json5";
import { existsSync, readFileSync, statSync } from "node:fs";

import type { GatewayRouteOptions } from "./routes/gateway";

/** 插件 catalog 发现来源（生产 = openclaw plugins list shell-out；测试注入）。 */
export type PluginCatalogProvider = (paths: OcSwitchPaths) => PluginCatalogResult;

/** 运行时模型 snapshot 探测来源（生产 = openclaw models 白名单探测；测试注入）。 */
export type RuntimeModelCatalogProvider = (paths: OcSwitchPaths) => RuntimeModelSnapshot;

const PLUGIN_CATALOG_CACHE_TTL_MS = 30_000;
/** 运行时 snapshot 缓存 TTL（与插件 catalog 一致，避免两边证据新鲜度差过大）。 */
const RUNTIME_MODEL_CACHE_TTL_MS = 30_000;

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
  /** 测试注入：OpenClaw 运行时模型 snapshot 探测 */
  runtimeModelCatalogProvider?: RuntimeModelCatalogProvider;
}

export interface AppRuntime {
  options: AppOptions;
  presetDirs: PresetDirs;
  fetchImpl: FetchImpl;
  runtimeDiscoveryProvider: RuntimeDiscoveryProvider;
  currentPaths(): OcSwitchPaths;
  setActivePaths(paths: OcSwitchPaths): void;
  /** 插件 provider 目录（30s TTL 缓存；失败降级为空列表）。 */
  currentPluginCatalog(options?: { paths?: OcSwitchPaths }): PluginCatalogResult;
  currentPluginProviders(options?: { paths?: OcSwitchPaths }): PluginProvider[];
  /** 插件级 descriptor（与 providers 共用同一份 plugin catalog 缓存）。 */
  currentPluginDescriptors(options?: { paths?: OcSwitchPaths }): ModelPluginDescriptor[];
  /**
   * 当前运行时模型 snapshot（30s TTL 缓存）。
   * `refresh: true` 强制重新探测；provider 抛错时降级为 incomplete snapshot，绝不抛。
   */
  currentRuntimeModelSnapshot(options?: { refresh?: boolean; paths?: OcSwitchPaths }): RuntimeModelSnapshot;
  /**
   * 同时失效两个 catalog 缓存（插件目录 + 运行时 snapshot）。
   * 写入端点成功落盘后调用，避免「新插件状态 + 旧模型目录」混用。
   */
  invalidateCatalogCaches(): void;
  /**
   * 组装统一 model inventory：读当前 config + disabled Provider + 插件 catalog + 运行时 snapshot。
   * `refresh: true` 时先强制刷新两个缓存。
   */
  buildCurrentInventory(options?: { refresh?: boolean; config?: OpenClawConfig; paths?: OcSwitchPaths }): ModelInventory;
}

/** 无运行时证据的 incomplete snapshot，不能当作可清理的空目录。 */
function emptyRuntimeSnapshot(): RuntimeModelSnapshot {
  return {
    fallbackRefs: [],
    allowedRefs: [],
    configuredModels: [],
    allModels: [],
    completeness: { status: false, configuredList: false, allList: false },
    diagnostics: [],
    capturedAt: new Date().toISOString()
  };
}

/** 探测来源抛错时只返回固定诊断，绝不透传原始异常或命令输出。 */
function incompleteSnapshotFromError(): RuntimeModelSnapshot {
  return {
    ...emptyRuntimeSnapshot(),
    diagnostics: [{
      command: "status",
      code: "invalid-shape",
      message: "runtime model catalog provider failed"
    }]
  };
}

export function createAppRuntime(options: AppOptions): AppRuntime {
  const runtimeDiscoveryProvider =
    options.runtimeDiscoveryProvider ?? discoverOpenClawRuntime;
  const pluginCatalogProvider = options.pluginCatalogProvider ?? ((paths: OcSwitchPaths) => discoverPluginCatalog({ configPath: paths.openclawPath }));
  const runtimeModelCatalogProvider =
    options.runtimeModelCatalogProvider ?? ((paths: OcSwitchPaths) => discoverRuntimeModelCatalog({ configPath: paths.openclawPath }));
  let pluginCatalogCache: { at: number; catalog: PluginCatalogResult } | undefined;
  let runtimeModelCache: { at: number; snapshot: RuntimeModelSnapshot } | undefined;
  let activePaths = options.paths ?? getActivePaths({
    runtimeDiscovery: runtimeDiscoveryProvider()
  });
  const currentPaths = () => activePaths;
  const presetDirs = options.presetDirs ?? defaultPresetDirs(currentPaths().stateDir);
  const fetchImpl = options.fetchImpl ?? fetch;
  let catalogScope: string | undefined;
  const invalidateCatalogCaches = (): void => {
    pluginCatalogCache = undefined;
    runtimeModelCache = undefined;
  };
  // 缓存只复用同一配置/源 env 版本；只看文件元数据，不读取或缓存密钥值。
  const ensureCatalogScope = (paths: OcSwitchPaths): void => {
    const scope = [paths.stateDir, ...[paths.openclawPath, paths.envPath].map((path) => {
      const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
      return `${path}:${stat ? `${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}` : "missing"}`;
    })].join("\0");
    if (scope !== catalogScope) {
      invalidateCatalogCaches();
      catalogScope = scope;
    }
  };
  return {
    options,
    presetDirs,
    fetchImpl,
    runtimeDiscoveryProvider,
    currentPaths,
    setActivePaths(paths) {
      activePaths = paths;
      this.invalidateCatalogCaches();
    },
    currentPluginCatalog(options2 = {}) {
      const paths = options2.paths ?? activePaths;
      ensureCatalogScope(paths);
      if (pluginCatalogCache && Date.now() - pluginCatalogCache.at < PLUGIN_CATALOG_CACHE_TTL_MS) {
        return pluginCatalogCache.catalog;
      }
      let catalog: PluginCatalogResult;
      try {
        catalog = pluginCatalogProvider(paths);
      } catch {
        catalog = { providers: [], plugins: [], diagnostics: ["plugin catalog discovery failed"] };
      }
      pluginCatalogCache = { at: Date.now(), catalog };
      return catalog;
    },
    currentPluginProviders(options2 = {}) {
      return this.currentPluginCatalog(options2).providers;
    },
    currentPluginDescriptors(options2 = {}) {
      return this.currentPluginCatalog(options2).plugins;
    },
    currentRuntimeModelSnapshot(options2 = {}) {
      const paths = options2.paths ?? activePaths;
      ensureCatalogScope(paths);
      const now = Date.now();
      if (!options2.refresh && runtimeModelCache && now - runtimeModelCache.at < RUNTIME_MODEL_CACHE_TTL_MS) {
        return runtimeModelCache.snapshot;
      }
      let snapshot: RuntimeModelSnapshot;
      try {
        snapshot = runtimeModelCatalogProvider(paths);
      } catch {
        snapshot = incompleteSnapshotFromError();
      }
      runtimeModelCache = { at: Date.now(), snapshot };
      return snapshot;
    },
    invalidateCatalogCaches,
    buildCurrentInventory(options2 = {}) {
      if (options2.refresh) {
        // 先失效再取（currentRuntimeModelSnapshot 内部会强制探测）
        this.invalidateCatalogCaches();
      }
      const paths = options2.paths ?? activePaths;
      const config = options2.config ?? readConfig(paths);
      const catalog = this.currentPluginCatalog({ paths });
      const snapshot = this.currentRuntimeModelSnapshot({ paths });
      return buildModelInventory({
        config,
        disabledProviderIds: readDisabledProviderIds(paths),
        pluginProviders: catalog.providers,
        plugins: catalog.plugins,
        pluginDiagnostics: catalog.diagnostics,
        runtime: snapshot
      });
    }
  };
}

export function readConfig(paths: OcSwitchPaths): OpenClawConfig {
  if (!existsSync(paths.openclawPath)) {
    throw new Error("openclaw.json not found");
  }
  return JSON5.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
}

export { emptyRuntimeSnapshot };

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
