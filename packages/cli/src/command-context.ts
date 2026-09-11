import {
  buildModelInventory,
  defaultPresetDirs,
  discoverOpenClawRuntime,
  discoverPluginCatalog,
  discoverRuntimeModelCatalog,
  getActivePaths,
  isProviderDisabled,
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
  readConfig(paths?: OcSwitchPaths): OpenClawConfig;
  readEnvContent(): string | undefined;
  assertProviderCanEnable(providerId: string, paths?: OcSwitchPaths): void;
  /** 同一命令进程内复用一次探测快照（读路径用） */
  runtimeDiscovery(): RuntimeDiscoveryResult;
  /** 未缓存 provider；写入事务须注入以便写后重新 discovery */
  runtimeDiscoveryProvider: RuntimeDiscoveryProvider;
  /**
   * OpenClaw 运行时模型 snapshot（同一命令进程内惰性缓存一次）。
   * 生产走 `discoverRuntimeModelCatalog`；`OC_SWITCH_MOCK_RUNTIME_MODELS` 测试缝注入假 runCommand。
   */
  runtimeModelSnapshot(paths?: OcSwitchPaths): RuntimeModelSnapshot;
  /**
   * 插件 catalog（providers + plugins descriptor；同一命令进程内惰性缓存一次）。
   * 生产 shell-out `openclaw plugins list --json`；测试经 runCli 的 PATH 前置假 openclaw。
   */
  pluginCatalog(paths?: OcSwitchPaths): PluginCatalogResult;
  /** 用当前 config + disabled providers + 插件 catalog + 运行时 snapshot 组装统一 inventory */
  buildInventory(options?: { refresh?: boolean; config?: OpenClawConfig; paths?: OcSwitchPaths }): ModelInventory;
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
  pluginCatalogProvider?: (paths: OcSwitchPaths) => PluginCatalogResult;
  /** 测试注入：运行时模型 snapshot 探测（默认真实 discoverRuntimeModelCatalog） */
  runtimeModelCatalogProvider?: (paths: OcSwitchPaths) => RuntimeModelSnapshot;
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
  const activePaths = (): OcSwitchPaths => getActivePaths({
    ...(options.env ? { env: options.env } : {}),
    ...(options.stateDir ? { stateDir: options.stateDir } : {}),
    runtimeDiscovery: runtimeDiscovery()
  });
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
    if (isProviderDisabled(paths.stateDir, providerId)) {
      throw new Error(
        `Provider ${providerId} is disabled. Restore the provider before enabling models.`
      );
    }
  };
  const presetDirs = (): PresetDirs => defaultPresetDirs(activePaths().stateDir);

  const runtimeModelCatalogProvider = options.runtimeModelCatalogProvider ?? ((paths: OcSwitchPaths) =>
    discoverRuntimeModelCatalog({ ...mockRuntimeModelCatalogDependencies(), configPath: paths.openclawPath }));
  const pluginCatalogProvider = options.pluginCatalogProvider ?? ((paths: OcSwitchPaths) =>
    discoverPluginCatalog({ configPath: paths.openclawPath }));
  let cachedRuntimeModelSnapshot: RuntimeModelSnapshot | undefined;
  let cachedPluginCatalog: PluginCatalogResult | undefined;
  let catalogScope: string | undefined;
  const invalidateCatalogCaches = (): void => {
    cachedRuntimeModelSnapshot = undefined;
    cachedPluginCatalog = undefined;
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
  const runtimeModelSnapshot = (paths = activePaths()): RuntimeModelSnapshot => {
    ensureCatalogScope(paths);
    if (!cachedRuntimeModelSnapshot) {
      try {
        cachedRuntimeModelSnapshot = runtimeModelCatalogProvider(paths);
      } catch {
        // 与 Server 一致：原始 provider 异常可能含 auth/命令输出，只返回固定诊断。
        cachedRuntimeModelSnapshot = {
          fallbackRefs: [], allowedRefs: [], configuredModels: [], allModels: [],
          completeness: { status: false, configuredList: false, allList: false },
          diagnostics: [{ command: "status", code: "invalid-shape", message: "runtime model catalog provider failed" }],
          capturedAt: new Date().toISOString()
        };
      }
    }
    return cachedRuntimeModelSnapshot;
  };
  const pluginCatalog = (paths = activePaths()): PluginCatalogResult => {
    ensureCatalogScope(paths);
    if (!cachedPluginCatalog) {
      try {
        cachedPluginCatalog = pluginCatalogProvider(paths);
      } catch {
        cachedPluginCatalog = { providers: [], plugins: [], diagnostics: ["plugin catalog discovery failed"] };
      }
    }
    return cachedPluginCatalog;
  };
  const buildInventory = (settings: { refresh?: boolean; config?: OpenClawConfig; paths?: OcSwitchPaths } = {}): ModelInventory => {
    if (settings.refresh) invalidateCatalogCaches();
    const paths = settings.paths ?? activePaths();
    const config = settings.config ?? context.readConfig(paths);
    const catalog = pluginCatalog(paths);
    const runtime = runtimeModelSnapshot(paths);
    return buildModelInventory({
      config,
      disabledProviderIds: Object.keys(readProviderStates(paths.stateDir).disabledProviders),
      pluginProviders: catalog.providers,
      plugins: catalog.plugins,
      pluginDiagnostics: catalog.diagnostics,
      runtime
    });
  };

  const context: CommandContext = {
    activePaths,
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
