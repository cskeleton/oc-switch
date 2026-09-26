import {
  areRuntimeDiscoveryPathsExplicit,
  buildModelInventory,
  defaultPaths,
  defaultPresetDirs,
  discoverOpenClawRuntime,
  discoverPluginCatalogAsync,
  discoverRuntimeModelCatalog,
  discoverRuntimeModelCatalogAsync,
  getActivePaths,
  MODELS_DEV_API_URL,
  MODELS_DEV_MODELS_URL,
  providerEnvVar as coreProviderEnvVar,
  readProviderStates,
  resolveProviderId,
  type FetchImpl,
  type OcSwitchPaths,
  type OpenClawConfig,
  type PluginCatalogResult,
  type PresetDirs,
  type RuntimeDiscoveryProvider,
  type RuntimeDiscoveryResult,
  type RuntimeModelCatalogDependencies,
  type RuntimeModelCommandResult,
  type RuntimeModelSnapshot,
  type ModelInventory
} from "@oc-switch/core";
import JSON5 from "json5";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** monorepo 根目录（自 packages/cli/src 上溯三级） */
export const repoRoot = join(dirname(import.meta.path), "../../..");

function providerEnvVar(config: OpenClawConfig, providerId: string): string | undefined {
  const resolvedProviderId = resolveProviderId(config, providerId);
  return coreProviderEnvVar(resolvedProviderId ? config.models?.providers?.[resolvedProviderId] : undefined);
}

function mockSyncFetch(): FetchImpl | undefined {
  const mock = process.env.OC_SWITCH_MOCK_SYNC;
  if (!mock) return undefined;
  const ids = mock.split(",").map((id) => id.trim()).filter(Boolean);
  return async () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      headers: { "content-type": "application/json" }
    });
}

/** 测试缝：OC_SWITCH_MOCK_METADATA 指向 { models, api } JSON 文件时，models.dev 请求由本地文件应答 */
function mockMetadataFetch(): FetchImpl | undefined {
  const mockPath = process.env.OC_SWITCH_MOCK_METADATA;
  if (!mockPath) return undefined;
  const payload = JSON.parse(readFileSync(mockPath, "utf8")) as { models?: unknown; api?: unknown };
  return async (input) => {
    const url = String(input);
    if (url === MODELS_DEV_MODELS_URL) return new Response(JSON.stringify(payload.models ?? {}), { headers: { "content-type": "application/json" } });
    if (url === MODELS_DEV_API_URL) return new Response(JSON.stringify(payload.api ?? {}), { headers: { "content-type": "application/json" } });
    throw new Error(`unexpected url: ${url}`);
  };
}

/**
 * 测试缝：OC_SWITCH_MOCK_RUNTIME_MODELS 指向 JSON 文件时，四个探测命令改由本地 fixture 应答。
 * fixture 结构直接对应命令输出（{ status, stdout, timedOut }），即假 openclaw 会打印的
 * 原始文本（版本串、models status JSON、models list JSON、models list --all JSON），
 * production parser（discoverRuntimeModelCatalog）照常解析，不读业务 DTO。
 * 命令键：version / status / list / listAll；缺省键按「命令缺失」（status null、非超时）应答。
 */
function mockRuntimeModelCatalogDependencies(): RuntimeModelCatalogDependencies | undefined {
  const mockPath = process.env.OC_SWITCH_MOCK_RUNTIME_MODELS;
  if (!mockPath) return undefined;
  const payload = JSON.parse(readFileSync(mockPath, "utf8")) as Record<string, Partial<RuntimeModelCommandResult> | undefined>;
  return {
    runCommand(_command, args, _options) {
      const joined = args.join(" ");
      const key = joined === "--version"
        ? "version"
        : joined === "models status --json"
          ? "status"
          : joined === "models list --json"
            ? "list"
            : joined === "models list --all --json"
              ? "listAll"
              : undefined;
      const entry = key === undefined ? undefined : payload[key];
      // 未覆盖的命令按「命令缺失」处理（status null 且非超时），与真实 ENOENT 一致
      return {
        status: entry?.status ?? null,
        stdout: entry?.stdout ?? "",
        timedOut: entry?.timedOut ?? false
      };
    }
  };
}

function defaultEnvName(providerId: string): string {
  return `${providerId.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()}_API_KEY`;
}

function parseModelIds(value: string): string[] {
  return value.split(",").map((id) => id.trim()).filter(Boolean);
}

function parseAliasMap(value: string | undefined): Map<string, string> {
  const aliases = new Map<string, string>();
  if (!value) return aliases;
  for (const pair of value.split(",")) {
    const [id, alias] = pair.split(":").map((part) => part.trim());
    if (!id || !alias) throw new Error(`Invalid alias mapping ${pair}`);
    aliases.set(id, alias);
  }
  return aliases;
}

export interface CommandContext {
  activePaths(): OcSwitchPaths;
  /**
   * 只解析 oc-switch stateDir 的短路径（不触发运行实例 discovery），
   * 供 backup list / token rotate / lifecycle 等纯 state 命令使用。
   */
  stateOnlyPaths(): Pick<OcSwitchPaths, "stateDir">;
  readConfig(paths?: OcSwitchPaths): OpenClawConfig;
  readEnvContent(): string | undefined;
  assertProviderCanEnable(providerId: string, paths?: OcSwitchPaths): void;
  /** 同一命令进程内复用一次探测快照（读路径用） */
  runtimeDiscovery(): RuntimeDiscoveryResult;
  /** 未缓存 provider；写入事务须注入以便写后重新 discovery */
  runtimeDiscoveryProvider: RuntimeDiscoveryProvider;
  /**
   * OpenClaw 运行时模型 snapshot（同一命令进程内按代次复用；
   * 并发读取共享在途 Promise，写成功/路径版本变化推进代次）。
   * 生产走 `discoverRuntimeModelCatalog`；`OC_SWITCH_MOCK_RUNTIME_MODELS` 测试缝注入假 runCommand。
   */
  runtimeModelSnapshot(paths?: OcSwitchPaths): Promise<RuntimeModelSnapshot>;
  /**
   * 插件 catalog（providers + plugins descriptor；同一命令进程内按代次复用）。
   * 生产 shell-out `openclaw plugins list --json`；测试经 runCli 的 PATH 前置假 openclaw。
   */
  pluginCatalog(paths?: OcSwitchPaths): Promise<PluginCatalogResult>;
  /** 用当前 config + disabled providers + 插件 catalog + 运行时 snapshot 组装统一 inventory */
  buildInventory(options?: { refresh?: boolean; config?: OpenClawConfig; paths?: OcSwitchPaths }): Promise<ModelInventory>;
  /** 统一失效入口：推进代次；旧代次完成后不得覆盖当前缓存 */
  invalidateCatalogCaches(): void;
  providerEnvVar: typeof providerEnvVar;
  presetDirs(): PresetDirs;
  mockSyncFetch: typeof mockSyncFetch;
  mockMetadataFetch: typeof mockMetadataFetch;
  defaultEnvName: typeof defaultEnvName;
  parseModelIds: typeof parseModelIds;
  parseAliasMap: typeof parseAliasMap;
}

export interface CreateCommandContextOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>;
  stateDir?: string;
  runtimeDiscoveryProvider?: RuntimeDiscoveryProvider;
  /** 测试注入：插件 catalog 发现（默认真实 discoverPluginCatalog） */
  pluginCatalogProvider?: (paths: OcSwitchPaths) => PluginCatalogResult | Promise<PluginCatalogResult>;
  /** 测试注入：运行时模型 snapshot 探测（默认真实 discoverRuntimeModelCatalog） */
  runtimeModelCatalogProvider?: (paths: OcSwitchPaths) => RuntimeModelSnapshot | Promise<RuntimeModelSnapshot>;
}

/** 创建命令级上下文，并在同一命令内复用一次运行实例探测快照 */
export function createCommandContext(
  options: CreateCommandContextOptions = {}
): CommandContext {
  const discoveryProvider =
    options.runtimeDiscoveryProvider ?? discoverOpenClawRuntime;
  let cachedDiscovery: RuntimeDiscoveryResult | undefined;
  const runtimeDiscovery = (): RuntimeDiscoveryResult => {
    cachedDiscovery ??= discoveryProvider();
    return cachedDiscovery;
  };
  const pathOptions = {
    ...(options.env ? { env: options.env } : {}),
    ...(options.stateDir ? { stateDir: options.stateDir } : {})
  };
  const activePaths = (): OcSwitchPaths => {
    // config 与 env 两路径均已显式确定时跳过 discovery；
    // 仅 config 已指定不得擅自推断 envPath（其仍可能来自运行实例候选）
    if (areRuntimeDiscoveryPathsExplicit(pathOptions)) {
      return getActivePaths(pathOptions);
    }
    return getActivePaths({ ...pathOptions, runtimeDiscovery: runtimeDiscovery() });
  };
  const stateOnlyPaths = (): Pick<OcSwitchPaths, "stateDir"> => {
    const env = (options.env ?? process.env) as NodeJS.ProcessEnv;
    return { stateDir: options.stateDir ?? defaultPaths(env).stateDir };
  };
  const readConfig = (paths = activePaths()): OpenClawConfig => {
    return JSON5.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
  };
  const readEnvContent = (): string | undefined => {
    const paths = activePaths();
    return existsSync(paths.envPath)
      ? readFileSync(paths.envPath, "utf8")
      : undefined;
  };
  const assertProviderCanEnable = (providerId: string, paths = activePaths()): void => {
    if (resolveProviderId(readConfig(paths), providerId) && Object.values(readProviderStates(paths.stateDir).disabledProviders).some(state => state.openclawPath === paths.openclawPath && state.providerId.toLowerCase() === providerId.toLowerCase())) {
      throw new Error(
        `Provider ${providerId} is disabled. Restore the provider before enabling models.`
      );
    }
  };
  const presetDirs = (): PresetDirs => defaultPresetDirs(activePaths().stateDir);

  const runtimeModelCatalogProvider = options.runtimeModelCatalogProvider ?? ((paths: OcSwitchPaths) =>
    process.env.OC_SWITCH_MOCK_RUNTIME_MODELS
      ? discoverRuntimeModelCatalog({ ...mockRuntimeModelCatalogDependencies(), configPath: paths.openclawPath })
      : discoverRuntimeModelCatalogAsync({ configPath: paths.openclawPath }));
  const pluginCatalogProvider = options.pluginCatalogProvider ?? ((paths: OcSwitchPaths) =>
    discoverPluginCatalogAsync({ configPath: paths.openclawPath }));

  /** 代次缓存槽：已完成值与在途探测分开存;失效统一走 invalidateCatalogCaches */
  interface CatalogSlot<T> {
    completed: { value: T; generation: number } | undefined;
    inflight: { promise: Promise<T>; generation: number } | undefined;
  }
  const runtimeModelSlot: CatalogSlot<RuntimeModelSnapshot> = { completed: undefined, inflight: undefined };
  const pluginSlot: CatalogSlot<PluginCatalogResult> = { completed: undefined, inflight: undefined };
  let catalogScope: string | undefined;
  let catalogGeneration = 0;
  /** 统一失效入口：推进代次并清空已完成缓存与在途引用，旧代次完成后不得覆盖当前缓存 */
  const invalidateCatalogCaches = (): void => {
    catalogGeneration += 1;
    runtimeModelSlot.completed = undefined;
    runtimeModelSlot.inflight = undefined;
    pluginSlot.completed = undefined;
    pluginSlot.inflight = undefined;
  };
  /**
   * 读取缓存槽：普通读复用同代次已完成值;refresh 不复用刷新前已完成的值;
   * 同代次并发（含并发 refresh）共享一次在途探测。
   */
  const readSlot = <T>(slot: CatalogSlot<T>, refresh: boolean, probe: () => Promise<T>): Promise<T> => {
    const generation = catalogGeneration;
    if (!refresh && slot.completed?.generation === generation) {
      return Promise.resolve(slot.completed.value);
    }
    if (slot.inflight?.generation === generation) {
      return slot.inflight.promise;
    }
    const probeGeneration = catalogGeneration;
    const promise = probe().then((value) => {
      // 探测期间发生写成功/路径或文件版本变化（统一失效入口已推进代次）时不得落缓存
      if (probeGeneration === catalogGeneration) {
        slot.completed = { value, generation: probeGeneration };
      }
      if (slot.inflight?.promise === promise) slot.inflight = undefined;
      return value;
    });
    slot.inflight = { promise, generation: probeGeneration };
    return promise;
  };
  // 命令内仅复用同一路径/配置版本；探测期间固定本次写事务的路径。
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
  const readRuntimeModel = (paths: OcSwitchPaths, refresh: boolean): Promise<RuntimeModelSnapshot> => {
    ensureCatalogScope(paths);
    return readSlot(runtimeModelSlot, refresh, () =>
      Promise.resolve().then(() => runtimeModelCatalogProvider(paths)).catch(() => ({
        fallbackRefs: [], allowedRefs: [], configuredModels: [], allModels: [],
        completeness: { status: false, configuredList: false, allList: false },
        diagnostics: [{ command: "status", code: "invalid-shape", message: "runtime model catalog provider failed" }],
        capturedAt: new Date().toISOString()
      })));
  };
  const readPlugin = (paths: OcSwitchPaths, refresh: boolean): Promise<PluginCatalogResult> => {
    ensureCatalogScope(paths);
    return readSlot(pluginSlot, refresh, () =>
      Promise.resolve().then(() => pluginCatalogProvider(paths)).catch(() => ({ providers: [], plugins: [], diagnostics: ["plugin catalog discovery failed"] })));
  };
  const runtimeModelSnapshot = (paths = activePaths()): Promise<RuntimeModelSnapshot> =>
    readRuntimeModel(paths, false);
  const pluginCatalog = (paths = activePaths()): Promise<PluginCatalogResult> =>
    readPlugin(paths, false);
  const buildInventory = async (settings: { refresh?: boolean; config?: OpenClawConfig; paths?: OcSwitchPaths } = {}): Promise<ModelInventory> => {
    const paths = settings.paths ?? activePaths();
    const config = settings.config ?? context.readConfig(paths);
    const refresh = settings.refresh === true;
    const [catalog, runtime] = await Promise.all([readPlugin(paths, refresh), readRuntimeModel(paths, refresh)]);
    return buildModelInventory({
      config,
      disabledProviderIds: Object.values(readProviderStates(paths.stateDir).disabledProviders).filter(state => state.openclawPath === paths.openclawPath).map(state => state.providerId),
      pluginProviders: catalog.providers,
      plugins: catalog.plugins,
      pluginDiagnostics: catalog.diagnostics,
      runtime
    });
  };

  const context: CommandContext = {
    activePaths,
    stateOnlyPaths,
    readConfig,
    readEnvContent,
    assertProviderCanEnable,
    runtimeDiscovery,
    runtimeDiscoveryProvider: discoveryProvider,
    runtimeModelSnapshot,
    pluginCatalog,
    buildInventory,
    invalidateCatalogCaches,
    providerEnvVar,
    presetDirs,
    mockSyncFetch,
    mockMetadataFetch,
    defaultEnvName,
    parseModelIds,
    parseAliasMap
  };
  return context;
}
