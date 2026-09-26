import {
  buildModelInventory,
  defaultPresetDirs,
  discoverOpenClawRuntime,
  discoverOpenClawRuntimeAsync,
  discoverPluginCatalogAsync,
  discoverRuntimeModelCatalogAsync,
  getActivePaths,
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
  type RuntimeDiscoveryResult,
  type RuntimeModelSnapshot
} from "@oc-switch/core";
import JSON5 from "json5";
import { existsSync, readFileSync, statSync } from "node:fs";

import type { GatewayRouteOptions } from "./routes/gateway";

/** 插件 catalog 发现来源（生产 = openclaw plugins list shell-out；测试注入）。 */
export type PluginCatalogProvider = (paths: OcSwitchPaths) => PluginCatalogResult | Promise<PluginCatalogResult>;

/** 运行时模型 snapshot 探测来源（生产 = openclaw models 白名单探测；测试注入）。 */
export type RuntimeModelCatalogProvider = (paths: OcSwitchPaths) => RuntimeModelSnapshot | Promise<RuntimeModelSnapshot>;

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
  /** 测试注入：覆盖异步运行实例发现。未注入时回包同步 provider（若有）,否则才真正异步进程 runner */
  asyncRuntimeDiscoveryProvider?: () => Promise<RuntimeDiscoveryResult>;
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
  /**
   * 异步运行实例发现（Server 读路径用）：每次调用都取得新证据，
   * 同 scope 并发只共享一次在途 Promise，完成后即清除（无跨请求 TTL）。
   */
  currentDiscovery(): Promise<RuntimeDiscoveryResult>;
  /** 插件 provider 目录（30s TTL 缓存；失败降级为空列表）。 */
  currentPluginCatalog(options?: { refresh?: boolean; paths?: OcSwitchPaths }): Promise<PluginCatalogResult>;
  currentPluginProviders(options?: { paths?: OcSwitchPaths }): Promise<PluginProvider[]>;
  /** 插件级 descriptor（与 providers 共用同一份 plugin catalog 缓存）。 */
  currentPluginDescriptors(options?: { paths?: OcSwitchPaths }): Promise<ModelPluginDescriptor[]>;
  /**
   * 当前运行时模型 snapshot（30s TTL 缓存）。
   * `refresh: true` 不复用刷新前已完成的值；同代次并发 refresh 共享一次新探测；
   * provider 抛错时降级为 incomplete snapshot，绝不抛。
   */
  currentRuntimeModelSnapshot(options?: { refresh?: boolean; paths?: OcSwitchPaths }): Promise<RuntimeModelSnapshot>;
  /**
   * 统一失效入口：推进代次并清空已完成缓存与在途引用。
   * 写成功、路径/文件版本变化（含事务重做预检触发的版本变化）都必须经此入口，
   * 旧代次完成后不得覆盖当前缓存。
   */
  invalidateCatalogCaches(): void;
  /**
   * 组装统一 model inventory：读当前 config + disabled Provider + 插件 catalog + 运行时 snapshot。
   * `refresh: true` 强制两个 catalog 重新探测（先读不可复用刷新前已完成的值）。
   */
  buildCurrentInventory(options?: { refresh?: boolean; config?: OpenClawConfig; paths?: OcSwitchPaths }): Promise<ModelInventory>;
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
  // 注入同步 provider 时必须同样驱动异步读路径，否则测试注入被旁路、真实探测会落到宿主机；
  // 未注入时才是默认的真正异步有界 runner（不得用 Promise.resolve(sync) 伪装该默认）。
  const asyncRuntimeDiscoveryProvider =
    options.asyncRuntimeDiscoveryProvider ??
    (options.runtimeDiscoveryProvider
      ? () => Promise.resolve().then(() => runtimeDiscoveryProvider())
      : () => discoverOpenClawRuntimeAsync());
  const pluginCatalogProvider = options.pluginCatalogProvider ?? ((paths: OcSwitchPaths) => discoverPluginCatalogAsync({ configPath: paths.openclawPath }));
  const runtimeModelCatalogProvider =
    options.runtimeModelCatalogProvider ?? ((paths: OcSwitchPaths) => discoverRuntimeModelCatalogAsync({ configPath: paths.openclawPath }));
  let activePaths = options.paths ?? getActivePaths({
    runtimeDiscovery: runtimeDiscoveryProvider()
  });
  const currentPaths = () => activePaths;
  const presetDirs = options.presetDirs ?? defaultPresetDirs(currentPaths().stateDir);
  const fetchImpl = options.fetchImpl ?? fetch;
  let catalogScope: string | undefined;
  /**
   * 代次缓存槽：已完成值（TTL 按采集开始时间计算）与当前在途探测分开存；
   * 失效统一走 invalidateCatalogCaches（推进代次），旧代次完成后不得覆盖当前缓存。
   */
  interface CatalogSlot<T> {
    completed: { value: T; at: number; generation: number } | undefined;
    inflight: { promise: Promise<T>; at: number; generation: number } | undefined;
  }
  const pluginSlot: CatalogSlot<PluginCatalogResult> = { completed: undefined, inflight: undefined };
  const runtimeModelSlot: CatalogSlot<RuntimeModelSnapshot> = { completed: undefined, inflight: undefined };
  let catalogGeneration = 0;
  const invalidateCatalogCaches = (): void => {
    catalogGeneration += 1;
    pluginSlot.completed = undefined;
    pluginSlot.inflight = undefined;
    runtimeModelSlot.completed = undefined;
    runtimeModelSlot.inflight = undefined;
  };
  /**
   * 读取缓存槽：普通读在 TTL 内复用同代次已完成值（TTL 自采集开始时刻计算）；
   * refresh 不复用刷新前已完成的值；同代次并发（含并发 refresh）共享一次在途探测。
   */
  const readSlot = <T>(
    slot: CatalogSlot<T>,
    ttlMs: number,
    refresh: boolean,
    probe: () => Promise<T>
  ): Promise<T> => {
    const generation = catalogGeneration;
    const now = Date.now();
    if (!refresh) {
      const completed = slot.completed;
      if (completed && completed.generation === generation && now - completed.at < ttlMs) {
        return Promise.resolve(completed.value);
      }
    }
    if (slot.inflight?.generation === generation) {
      return slot.inflight.promise;
    }
    const probeGeneration = catalogGeneration;
    const at = Date.now();
    const promise = probe().then((value) => {
      // 探测期间发生写成功/路径或文件版本变化（统一失效入口已推进代次）时不得落缓存
      if (probeGeneration === catalogGeneration) {
        slot.completed = { value, at, generation: probeGeneration };
      }
      if (slot.inflight?.promise === promise) slot.inflight = undefined;
      return value;
    });
    slot.inflight = { promise, at, generation: probeGeneration };
    return promise;
  };
  // 同 scope 并发的只读 discovery 共享一次在途 Promise；完成后即清除，无跨请求 TTL
  let discoveryInFlight: { scope: string; promise: Promise<RuntimeDiscoveryResult> } | undefined;
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
    currentDiscovery() {
      const scope = [activePaths.stateDir, activePaths.openclawPath, activePaths.envPath].join("\0");
      const existing = discoveryInFlight;
      if (existing && existing.scope === scope) {
        return existing.promise;
      }
      // 每次调用都取得新证据；不缓存已完成结果
      const promise = Promise.resolve().then(() => asyncRuntimeDiscoveryProvider());
      const entry = { scope, promise };
      discoveryInFlight = entry;
      void promise
        .finally(() => {
          if (discoveryInFlight === entry) discoveryInFlight = undefined;
        })
        .catch(() => {});
      return promise;
    },
    currentPluginCatalog(options2 = {}) {
      const paths = options2.paths ?? activePaths;
      ensureCatalogScope(paths);
      return readSlot(pluginSlot, PLUGIN_CATALOG_CACHE_TTL_MS, options2.refresh === true, () =>
        Promise.resolve().then(() => pluginCatalogProvider(paths)).catch(() => ({
          providers: [], plugins: [], diagnostics: ["plugin catalog discovery failed"]
        })));
    },
    async currentPluginProviders(options2 = {}) {
      return (await this.currentPluginCatalog(options2)).providers;
    },
    async currentPluginDescriptors(options2 = {}) {
      return (await this.currentPluginCatalog(options2)).plugins;
    },
    currentRuntimeModelSnapshot(options2 = {}) {
      const paths = options2.paths ?? activePaths;
      ensureCatalogScope(paths);
      return readSlot(runtimeModelSlot, RUNTIME_MODEL_CACHE_TTL_MS, options2.refresh === true, () =>
        Promise.resolve().then(() => runtimeModelCatalogProvider(paths)).catch(incompleteSnapshotFromError));
    },
    invalidateCatalogCaches,
    async buildCurrentInventory(options2 = {}) {
      const paths = options2.paths ?? activePaths;
      const config = options2.config ?? readConfig(paths);
      const refresh = options2.refresh === true;
      const [catalog, snapshot] = await Promise.all([
        this.currentPluginCatalog({ paths, refresh }),
        this.currentRuntimeModelSnapshot({ paths, refresh })
      ]);
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
  if (resolveProviderId(readConfig(paths), providerId) && readDisabledProviderIds(paths).some(id => id.toLowerCase() === providerId.toLowerCase())) {
    throw disabledProviderError(providerId);
  }
}

/** 统一读取供 adapter 聚合的 disabled Provider ID，避免 status/providers 各自计算。 */
export function readDisabledProviderIds(paths: OcSwitchPaths): string[] {
  return Object.values(readProviderStates(paths.stateDir).disabledProviders).filter(state => state.openclawPath === paths.openclawPath).map(state => state.providerId);
}
