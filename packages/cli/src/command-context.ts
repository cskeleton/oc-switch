import {
  defaultPresetDirs,
  discoverOpenClawRuntime,
  getActivePaths,
  isProviderDisabled,
  MODELS_DEV_API_URL,
  MODELS_DEV_MODELS_URL,
  providerEnvVar as coreProviderEnvVar,
  resolveProviderId,
  type FetchImpl,
  type OcSwitchPaths,
  type OpenClawConfig,
  type PresetDirs,
  type RuntimeDiscoveryProvider,
  type RuntimeDiscoveryResult
} from "@oc-switch/core";
import JSON5 from "json5";
import { existsSync, readFileSync } from "node:fs";
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
  readConfig(): OpenClawConfig;
  readEnvContent(): string | undefined;
  assertProviderCanEnable(providerId: string): void;
  /** 同一命令进程内复用一次探测快照（读路径用） */
  runtimeDiscovery(): RuntimeDiscoveryResult;
  /** 未缓存 provider；写入事务须注入以便写后重新 discovery */
  runtimeDiscoveryProvider: RuntimeDiscoveryProvider;
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
  const readConfig = (): OpenClawConfig => {
    const paths = activePaths();
    return JSON5.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
  };
  const readEnvContent = (): string | undefined => {
    const paths = activePaths();
    return existsSync(paths.envPath)
      ? readFileSync(paths.envPath, "utf8")
      : undefined;
  };
  const assertProviderCanEnable = (providerId: string): void => {
    const paths = activePaths();
    if (isProviderDisabled(paths.stateDir, providerId)) {
      throw new Error(
        `Provider ${providerId} is disabled. Restore the provider before enabling models.`
      );
    }
  };
  const presetDirs = (): PresetDirs => defaultPresetDirs(activePaths().stateDir);

  return {
    activePaths,
    readConfig,
    readEnvContent,
    assertProviderCanEnable,
    runtimeDiscovery,
    runtimeDiscoveryProvider: discoveryProvider,
    providerEnvVar,
    presetDirs,
    mockSyncFetch,
    mockMetadataFetch,
    defaultEnvName,
    parseModelIds,
    parseAliasMap
  };
}
