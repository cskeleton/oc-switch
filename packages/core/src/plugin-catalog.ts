import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  diagnostics: string[];
}

export interface PluginCatalogRunResult {
  status: number | null;
  stdout: string;
  timedOut: boolean;
}

export interface PluginCatalogDependencies {
  runCommand?: (command: string, args: string[], options: { timeoutMs: number; maxOutputBytes: number }) => PluginCatalogRunResult;
  readTextFile?: (path: string) => string;
}

const PLUGINS_LIST_PROBE = { timeoutMs: 8_000, maxOutputBytes: 1_048_576 };

function defaultRunCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number; maxOutputBytes: number }
): PluginCatalogRunResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: options.maxOutputBytes
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
  rootDir?: unknown;
  origin?: unknown;
  enabled?: unknown;
  providerIds?: unknown;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
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
): PluginProvider[] {
  const manifest = JSON.parse(manifestText) as Record<string, unknown>;
  const catalogProviders = (manifest.modelCatalog as { providers?: unknown } | undefined)?.providers;
  if (typeof catalogProviders !== "object" || catalogProviders === null) return [];
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
  return providers;
}

/** 发现本机 OpenClaw 插件提供的 provider 目录；任何失败降级为空结果，不抛错。 */
export function discoverPluginCatalog(deps: PluginCatalogDependencies = {}): PluginCatalogResult {
  const runCommand = deps.runCommand ?? defaultRunCommand;
  const readTextFile = deps.readTextFile ?? ((path: string) => readFileSync(path, "utf8"));
  const diagnostics: string[] = [];

  const result = runCommand("openclaw", ["plugins", "list", "--json"], PLUGINS_LIST_PROBE);
  if (result.timedOut) {
    return { providers: [], diagnostics: ["openclaw plugins list timed out"] };
  }
  if (result.status !== 0) {
    return { providers: [], diagnostics: [`openclaw plugins list exited with status ${result.status}`] };
  }

  let entries: PluginsListEntry[];
  try {
    const parsed = JSON.parse(result.stdout) as { plugins?: unknown };
    entries = Array.isArray(parsed.plugins) ? (parsed.plugins as PluginsListEntry[]) : [];
  } catch {
    return { providers: [], diagnostics: ["openclaw plugins list returned invalid JSON"] };
  }

  const providers: PluginProvider[] = [];
  for (const entry of entries) {
    const providerIds = asStringArray(entry.providerIds);
    if (providerIds.length === 0) continue;
    if (typeof entry.id !== "string" || typeof entry.rootDir !== "string") {
      diagnostics.push("plugin entry missing id/rootDir; skipped");
      continue;
    }
    const parsedEntry = {
      pluginId: entry.id,
      origin: typeof entry.origin === "string" ? entry.origin : "unknown",
      enabled: entry.enabled !== false,
      providerIds
    };
    let manifestText: string;
    try {
      manifestText = readTextFile(join(entry.rootDir, "openclaw.plugin.json"));
    } catch {
      diagnostics.push(`plugin ${entry.id}: manifest not readable; skipped`);
      continue;
    }
    try {
      providers.push(...parsePluginManifest(manifestText, parsedEntry));
    } catch {
      diagnostics.push(`plugin ${entry.id}: manifest parse failed; skipped`);
    }
  }
  return { providers, diagnostics };
}

/** 过滤与 models.providers 冲突（大小写折叠）的插件 provider；config 条目优先。 */
export function filterPluginProvidersConflictWithConfig(
  config: OpenClawConfig,
  pluginProviders: PluginProvider[]
): PluginProvider[] {
  const configIds = new Set(Object.keys(config.models?.providers ?? {}).map((id) => normalizeProviderId(id)));
  return pluginProviders.filter((provider) => !configIds.has(normalizeProviderId(provider.providerId)));
}
