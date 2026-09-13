import { spawnSync } from "node:child_process";
import { runCatalogCommand } from "./catalog-command";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelPluginDescriptor, ModelPluginNonModelCapability } from "./model-inventory";
import { normalizeProviderId } from "./model-ref";
import type { ApiType, OpenClawConfig } from "./types";

/**
 * 插件 provider 目录发现（只读）。
 *
 * OpenClaw 2026.4+ 起 provider 可来自插件 manifest 的 modelCatalog（bundled 或 npm global），
 * 不写入 openclaw.json 的 models.providers。本模块通过 `openclaw plugins list --json`
 * 定位含 provider 的插件，再读其 rootDir 下的 openclaw.plugin.json 解析静态模型目录。
 * 任何失败都降级为空结果 + diagnostics，绝不抛错。
 */

export interface PluginProviderModel {
  id: string;
  name?: string;
  api?: ApiType;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
}

export interface PluginProvider {
  pluginId: string;
  providerId: string;
  origin: string;
  /** 插件启用状态（plugins.entries / enabledByDefault）；disabled 的 provider 只读展示，不可 enable。 */
  enabled: boolean;
  baseUrl?: string;
  api?: ApiType;
  models: PluginProviderModel[];
  /** manifest 声明的 API Key 环境变量名（如 OPENCODE_API_KEY），首个为主。 */
  apiKeyEnvVars: string[];
}

export interface PluginCatalogResult {
  providers: PluginProvider[];
  /**
   * 插件级脱敏 descriptor（spec §9.1 范围：已安装且贡献 ≥1 模型 Provider 的插件）。
   * 从 `plugins list` 的 ID/count 数组推导，不读 trust credential 字段、不存整个 entry。
   */
  plugins: ModelPluginDescriptor[];
  diagnostics: string[];
}

export interface PluginCatalogRunResult {
  status: number | null;
  stdout: string;
  timedOut: boolean;
}

export interface PluginCatalogDependencies {
  configPath?: string;
  runCommand?: (command: string, args: string[], options: { timeoutMs: number; maxOutputBytes: number }) => PluginCatalogRunResult;
  readTextFile?: (path: string) => string;
}

const PLUGINS_LIST_PROBE = { timeoutMs: 8_000, maxOutputBytes: 1_048_576 };

/** HTTP 读路径异步执行 CLI，manifest 解析与同步入口共享。 */
export async function discoverPluginCatalogAsync(deps: Pick<PluginCatalogDependencies, "configPath" | "readTextFile"> = {}): Promise<PluginCatalogResult> {
  const result = await runCatalogCommand("openclaw", ["plugins", "list", "--json"], PLUGINS_LIST_PROBE, deps.configPath);
  return discoverPluginCatalog({ ...deps, runCommand: () => result });
}

function defaultRunCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxOutputBytes: number },
  configPath?: string
): PluginCatalogRunResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes,
    ...(configPath ? { env: { ...process.env, OPENCLAW_CONFIG_PATH: configPath } } : {})
  });
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    timedOut: result.status === null && (result.signal === "SIGTERM" || errorCode === "ETIMEDOUT")
  };
}

interface PluginsListEntry {
  id?: unknown;
  name?: unknown;
  rootDir?: unknown;
  origin?: unknown;
  enabled?: unknown;
  providerIds?: unknown;
  /** 以下均为 OpenClaw `plugins list` 已公开的 ID 数组 / 计数字段（只读，不涉 trust） */
  channelIds?: unknown;
  toolIds?: unknown;
  toolNames?: unknown;
  hookIds?: unknown;
  hookNames?: unknown;
  hookCount?: unknown;
  commandIds?: unknown;
  cliBackendIds?: unknown;
  serviceIds?: unknown;
  gatewayDiscoveryServiceIds?: unknown;
  speechProviderIds?: unknown;
  realtimeIds?: unknown;
  realtimeTranscriptionProviderIds?: unknown;
  realtimeVoiceProviderIds?: unknown;
  mediaIds?: unknown;
  mediaUnderstandingProviderIds?: unknown;
  transcriptSourceProviderIds?: unknown;
  imageGenerationProviderIds?: unknown;
  videoGenerationProviderIds?: unknown;
  musicGenerationProviderIds?: unknown;
  searchIds?: unknown;
  webFetchProviderIds?: unknown;
  webSearchProviderIds?: unknown;
  embeddingProviderIds?: unknown;
  migrationProviderIds?: unknown;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/**
 * 从 plugins list 条目推导插件级非模型能力（spec §9.3「插件同时贡献工具、频道或 hooks」提示）。
 *
 * 只读取已公开的 ID/count 数组：数组存在且非空才计为该能力存在；未知键一律忽略。
 * manifest 侧的 contracts 契约（如 acp）由调用方在 descriptor 聚合时合并为
 * `other-contracts`（见 collectNonModelContracts），本函数只看 entry 侧公开字段。
 */
function parseNonModelCapabilities(entry: PluginsListEntry): ModelPluginNonModelCapability[] {
  const capabilities: ModelPluginNonModelCapability[] = [];
  const hasEntries = (...values: unknown[]) => values.some(value => asStringArray(value).length > 0);
  if (asStringArray(entry.channelIds).length > 0) capabilities.push("channels");
  // 当前 OpenClaw 用 Names/count 与 *ProviderIds，保留旧版 Ids 别名但不依赖它们。
  if (hasEntries(entry.toolNames, entry.toolIds)) capabilities.push("tools");
  if (hasEntries(entry.hookNames, entry.hookIds) || (typeof entry.hookCount === "number" && entry.hookCount > 0)) capabilities.push("hooks");
  if (hasEntries(entry.commandIds, entry.cliBackendIds)) capabilities.push("commands");
  if (hasEntries(entry.serviceIds, entry.gatewayDiscoveryServiceIds)) capabilities.push("services");
  if (asStringArray(entry.speechProviderIds).length > 0) capabilities.push("speech");
  if (hasEntries(entry.realtimeIds, entry.realtimeTranscriptionProviderIds, entry.realtimeVoiceProviderIds)) capabilities.push("realtime");
  if (hasEntries(entry.mediaIds, entry.mediaUnderstandingProviderIds, entry.transcriptSourceProviderIds, entry.imageGenerationProviderIds, entry.videoGenerationProviderIds, entry.musicGenerationProviderIds)) capabilities.push("media");
  if (hasEntries(entry.searchIds, entry.webSearchProviderIds, entry.webFetchProviderIds)) capabilities.push("search");
  if (hasEntries(entry.embeddingProviderIds, entry.migrationProviderIds)) capabilities.push("other-contracts");
  return capabilities;
}

/** 固定枚举优先级（与 ModelPluginNonModelCapability 声明序一致）+ 字典序去重排序。 */
const NON_MODEL_CAPABILITY_ORDER: Record<ModelPluginNonModelCapability, number> = {
  channels: 0,
  tools: 1,
  hooks: 2,
  commands: 3,
  services: 4,
  speech: 5,
  realtime: 6,
  media: 7,
  search: 8,
  "other-contracts": 9
};

/**
 * manifest 侧契约探测：`contracts` 键（OpenClaw 插件公开的契约声明，如 acp）存在时
 * 记为 `other-contracts`。不读契约内容、不执行其中命令（spec §12 不可信数据纪律）。
 */
function collectNonModelContracts(manifest: Record<string, unknown>): ModelPluginNonModelCapability[] {
  const contracts = manifest.contracts;
  return typeof contracts === "object" && contracts !== null && Object.keys(contracts).length > 0
    ? ["other-contracts"]
    : [];
}

function parseManifestModels(value: unknown): PluginProviderModel[] {
  if (!Array.isArray(value)) return [];
  const models: PluginProviderModel[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.id !== "string" || !raw.id) continue;
    const model: PluginProviderModel = { id: raw.id };
    if (typeof raw.name === "string") model.name = raw.name;
    if (typeof raw.api === "string") model.api = raw.api as ApiType;
    if (typeof raw.contextWindow === "number") model.contextWindow = raw.contextWindow;
    if (typeof raw.maxTokens === "number") model.maxTokens = raw.maxTokens;
    if (typeof raw.reasoning === "boolean") model.reasoning = raw.reasoning;
    if (Array.isArray(raw.input)) model.input = raw.input.filter((item): item is string => typeof item === "string");
    models.push(model);
  }
  return models;
}

/**
 * 提取 API Key 环境变量名。
 *
 * 变量名只在 `setup.providers[].envVars` 里声明——`providerAuthChoices` 只给
 * `optionKey`/`cliFlag`，不含环境变量名（实测 anthropic / openai / opencode manifest）。
 * manifest 的声明顺序未必把 API Key 放在首位（如 anthropic 是
 * ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]），而 oc-switch 的「设置 Key」只写首个，
 * 故把名字里含 API_KEY 的变量提前，避免把 API Key 写进 OAuth token 变量。
 */
function parseManifestEnvVars(manifest: Record<string, unknown>, providerId: string): string[] {
  const envVars: string[] = [];
  const setup = manifest.setup as { providers?: unknown } | undefined;
  for (const entry of Array.isArray(setup?.providers) ? setup.providers : []) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    if (record.id !== undefined && record.id !== providerId) continue;
    envVars.push(...asStringArray(record.envVars));
  }
  const unique = [...new Set(envVars)];
  return [
    ...unique.filter((envVar) => envVar.toUpperCase().includes("API_KEY")),
    ...unique.filter((envVar) => !envVar.toUpperCase().includes("API_KEY"))
  ];
}

function parsePluginManifest(
  manifestText: string,
  entry: { pluginId: string; origin: string; enabled: boolean; providerIds: string[] }
): { providers: PluginProvider[]; capabilities: ModelPluginNonModelCapability[] } {
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  const catalogProviders = (manifest.modelCatalog as { providers?: unknown } | undefined)?.providers;
  if (typeof catalogProviders !== "object" || catalogProviders === null) {
    return { providers: [], capabilities: collectNonModelContracts(manifest) };
  }
  const catalog = catalogProviders as Record<string, Record<string, unknown>>;
  const providers: PluginProvider[] = [];
  for (const providerId of entry.providerIds) {
    const raw = catalog[providerId];
    if (typeof raw !== "object" || raw === null) continue;
    const provider: PluginProvider = {
      pluginId: entry.pluginId,
      providerId,
      origin: entry.origin,
      enabled: entry.enabled,
      models: parseManifestModels(raw.models),
      apiKeyEnvVars: parseManifestEnvVars(manifest, providerId)
    };
    if (typeof raw.baseUrl === "string") provider.baseUrl = raw.baseUrl;
    if (typeof raw.api === "string") provider.api = raw.api as ApiType;
    providers.push(provider);
  }
  return { providers, capabilities: collectNonModelContracts(manifest) };
}

/** 发现本机 OpenClaw 插件提供的 provider 目录；任何失败降级为空结果，不抛错。 */
export function discoverPluginCatalog(deps: PluginCatalogDependencies = {}): PluginCatalogResult {
  const runCommand = deps.runCommand ?? ((command, args, options) => defaultRunCommand(command, args, options, deps.configPath));
  const readTextFile = deps.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
  const diagnostics: string[] = [];

  let result: PluginCatalogRunResult;
  try { result = runCommand("openclaw", ["plugins", "list", "--json"], PLUGINS_LIST_PROBE); }
  catch { return { providers: [], plugins: [], diagnostics: ["openclaw plugins list failed"] }; }
  if (result.timedOut) {
    return { providers: [], plugins: [], diagnostics: ["openclaw plugins list timed out"] };
  }
  if (result.status !== 0) {
    return { providers: [], plugins: [], diagnostics: [`openclaw plugins list exited with status ${result.status}`] };
  }

  let entries: PluginsListEntry[];
  try {
    const parsed = JSON.parse(result.stdout) as { plugins?: unknown };
    if (!Array.isArray(parsed?.plugins)) return { providers: [], plugins: [], diagnostics: ["openclaw plugins list returned invalid shape"] };
    entries = parsed.plugins as PluginsListEntry[];
  } catch {
    return { providers: [], plugins: [], diagnostics: ["openclaw plugins list returned invalid JSON"] };
  }

  const providers: PluginProvider[] = [];
  const plugins: ModelPluginDescriptor[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      diagnostics.push("invalid plugin entry; skipped");
      continue;
    }
    if (entry.providerIds !== undefined && (!Array.isArray(entry.providerIds) || entry.providerIds.some(id => typeof id !== "string" || !id))) {
      diagnostics.push("plugin entry has invalid providerIds; discovery incomplete");
      continue;
    }
    const providerIds = asStringArray(entry.providerIds);
    if (providerIds.length === 0) continue;
    if (typeof entry.id !== "string" || typeof entry.rootDir !== "string") {
      diagnostics.push("plugin entry missing id/rootDir; skipped");
      continue;
    }
    if (typeof entry.enabled !== "boolean") {
      diagnostics.push(`plugin ${entry.id}: enabled state unavailable; skipped`);
      continue;
    }
    const parsedEntry = {
      pluginId: entry.id,
      origin: typeof entry.origin === "string" ? entry.origin : "unknown",
      enabled: entry.enabled,
      providerIds
    };
    // 插件级 descriptor 只从 plugins list 的公开字段推导（脱敏：不存整个 entry、不读 trust 字段）
    const baseCapabilities = parseNonModelCapabilities(entry);
    let contractCapabilities: ModelPluginNonModelCapability[] = [];
    let manifestText: string;
    try {
      manifestText = readTextFile(join(entry.rootDir, "openclaw.plugin.json"));
    } catch {
      if (entry.enabled) diagnostics.push(`plugin ${entry.id}: manifest not readable; skipped`);
      // manifest 缺失不阻止 descriptor：启停插件只需 plugins list 事实，Provider 目录才是可选增强
      contractCapabilities = [];
      plugins.push(makeDescriptor(entry, parsedEntry, baseCapabilities));
      continue;
    }
    try {
      const { providers: parsedProviders, capabilities } = parsePluginManifest(manifestText, parsedEntry);
      providers.push(...parsedProviders);
      contractCapabilities = capabilities;
    } catch {
      if (entry.enabled) diagnostics.push(`plugin ${entry.id}: manifest parse failed; skipped`);
    }
    plugins.push(makeDescriptor(entry, parsedEntry, [...baseCapabilities, ...contractCapabilities]));
  }
  return { providers, plugins: sortDescriptors(plugins), diagnostics };
}

/** descriptor 逐字段白名单挑选：id/name/origin/enabled/providerIds + 去重排序后的能力列表。 */
function makeDescriptor(
  entry: PluginsListEntry,
  parsed: { pluginId: string; origin: string; enabled: boolean; providerIds: string[] },
  capabilities: ModelPluginNonModelCapability[]
): ModelPluginDescriptor {
  const unique = [...new Set(capabilities)];
  unique.sort(
    (a, b) => NON_MODEL_CAPABILITY_ORDER[a] - NON_MODEL_CAPABILITY_ORDER[b] || (a < b ? -1 : a > b ? 1 : 0)
  );
  const descriptor: ModelPluginDescriptor = {
    id: parsed.pluginId,
    origin: parsed.origin,
    enabled: parsed.enabled,
    providerIds: [...new Set(parsed.providerIds)],
    nonModelCapabilities: unique
  };
  if (typeof entry.name === "string") descriptor.name = entry.name;
  return descriptor;
}

/** 稳定排序：按 id 字典序，同一输入永远得到同一输出。 */
function sortDescriptors(plugins: ModelPluginDescriptor[]): ModelPluginDescriptor[] {
  return [...plugins].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 过滤与 models.providers 冲突（大小写折叠）的插件 provider；config 条目优先。 */
export function filterPluginProvidersConflictWithConfig(
  config: OpenClawConfig,
  pluginProviders: PluginProvider[]
): PluginProvider[] {
  const configIds = new Set(Object.keys(config.models?.providers ?? {}).map((id) => normalizeProviderId(id)));
  return pluginProviders.filter((provider) => !configIds.has(normalizeProviderId(provider.providerId)));
}
