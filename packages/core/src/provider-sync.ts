import { readEnvValue } from "./env-manager";
import { normalizeProviderId } from "./model-ref";
import { providerEnvVar } from "./openclaw-compat";
import { resolveProviderId } from "./operation-common";
import type { PluginProvider } from "./plugin-catalog";
import type { OpenClawConfig, OpenClawProvider } from "./types";

/** 远端模型条目（发现结果，不写盘） */
export interface RemoteModelInfo {
  id: string;
  name?: string;
}

/** 发现 Provider 远端模型目录的结果（只读，不修改配置） */
export interface ProviderDiscoverResult {
  providerId: string;
  remoteModels: RemoteModelInfo[];
  alreadyAddedIds: string[];
  truncated: boolean;
  truncationReason?: string;
  unsupportedReason?: string;
}

/** 单次 discover 允许返回的远端模型条数上限 */
export const DISCOVER_MAX_MODELS = 5000;

/** 单次 discover 允许拉取的 Anthropic 分页上限 */
export const DISCOVER_MAX_PAGES = 50;

/** Anthropic List Models API 版本头 */
const ANTHROPIC_API_VERSION = "2023-06-01";

/** 归一化 baseUrl，避免重复 /v1 后拼接 OpenAI 兼容的 /models 端点 */
function openaiModelsEndpoint(baseUrl: string, normalizeBaseUrl = true): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const normalized = normalizeBaseUrl
    ? (trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`)
    : trimmed;
  return `${normalized}/models`;
}

/** Anthropic List Models 端点；可选 after_id 分页游标 */
function anthropicModelsEndpoint(baseUrl: string, afterId?: string, normalizeBaseUrl = true): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const normalized = normalizeBaseUrl
    ? (trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`)
    : trimmed;
  const endpoint = `${normalized}/models`;
  if (!afterId) return endpoint;
  return `${endpoint}?after_id=${encodeURIComponent(afterId)}`;
}

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProviderDiscoverOptions {
  fetchImpl?: FetchImpl;
  envContent?: string;
  /** 当前插件目录（server/CLI 注入）；用于 config 无可用 Key 时回退 manifest 声明的 env 变量。 */
  pluginProviders?: PluginProvider[];
}

/** 基于表单凭证的临时 discover 输入（只读，不写盘） */
export interface ProviderDiscoverCredentialsInput {
  providerId?: string;
  api: OpenClawProvider["api"];
  baseUrl: string;
  apiKey: string;
  isFullUrl?: boolean;
  alreadyAddedIds?: string[];
}

function resolveDiscoverOptions(
  input?: FetchImpl | ProviderDiscoverOptions
): Required<Pick<ProviderDiscoverOptions, "fetchImpl">> & Pick<ProviderDiscoverOptions, "envContent" | "pluginProviders"> {
  if (typeof input === "function") {
    return { fetchImpl: input };
  }
  return {
    fetchImpl: input?.fetchImpl ?? fetch,
    ...(input?.envContent !== undefined ? { envContent: input.envContent } : {}),
    ...(input?.pluginProviders !== undefined ? { pluginProviders: input.pluginProviders } : {})
  };
}

function resolveEnvKey(
  providerId: string,
  provider: OpenClawProvider,
  envContent: string | undefined
): string {
  const envVar = providerEnvVar(provider);
  if (!envVar) return "";
  if (envContent === undefined) return "";
  const value = readEnvValue(envContent, envVar);
  if (!value) throw new Error(`Env var ${envVar} for provider ${providerId} not found`);
  return value;
}

function openaiAuthHeaders(
  providerId: string,
  provider: OpenClawProvider,
  envContent: string | undefined
): Record<string, string> {
  const value = resolveEnvKey(providerId, provider, envContent);
  if (!value) return {};
  return provider.apiKey ? { Authorization: `Bearer ${value}` } : { Authorization: value };
}

function anthropicAuthHeaders(
  providerId: string,
  provider: OpenClawProvider,
  envContent: string | undefined
): Record<string, string> {
  const value = resolveEnvKey(providerId, provider, envContent);
  if (!value) return {};
  return {
    "x-api-key": value,
    "anthropic-version": ANTHROPIC_API_VERSION
  };
}

/** 401/403 且本次未携带鉴权头时补充「未配置 Key 或 Key 无效」提示，其余维持原文案。 */
function discoverHttpError(status: number, hasAuth: boolean): Error {
  if (!hasAuth && (status === 401 || status === 403)) {
    return new Error(`Model discover failed: HTTP ${status} (missing or invalid API key)`);
  }
  return new Error(`Model discover failed: HTTP ${status}`);
}

/**
 * 解析 discover 鉴权：config 条目经 providerEnvVar 的变量优先；解析不到变量名、
 * 或 envContent 里取不到值时，回退同名（大小写折叠）插件 Provider 的 apiKeyEnvVars
 * （已按含 API_KEY 优先排序，取首个在 envContent 里有非空值者），返回携带 legacy
 * "${VAR}" ref 的内存 provider 副本——只为复用鉴权头逻辑，绝不写盘。
 * 插件声明了变量但 envContent 里全部缺失/为空时，在发任何请求前抛错。
 */
function resolveDiscoverAuth(
  providerId: string,
  provider: OpenClawProvider,
  envContent: string | undefined,
  pluginProviders: PluginProvider[] | undefined
): { provider: OpenClawProvider; hasAuth: boolean } {
  const configEnvVar = providerEnvVar(provider);
  if (configEnvVar && envContent !== undefined && readEnvValue(envContent, configEnvVar)) {
    return { provider, hasAuth: true };
  }
  const plugin = (pluginProviders ?? []).find(
    (candidate) => normalizeProviderId(candidate.providerId) === normalizeProviderId(providerId)
  );
  if (!plugin || plugin.apiKeyEnvVars.length === 0 || envContent === undefined) {
    // 无插件信息时维持现状（含 config 有变量名但缺值时由 resolveEnvKey 抛错）
    return { provider, hasAuth: false };
  }
  const fallbackVar = plugin.apiKeyEnvVars.find((name) => {
    const value = readEnvValue(envContent, name);
    return value !== undefined && value.length > 0;
  });
  if (!fallbackVar) {
    throw new Error(
      `Provider ${providerId} has no API key configured; set one of ${plugin.apiKeyEnvVars.join(", ")} in .env or use the Providers page to set a key.`
    );
  }
  return { provider: { ...provider, apiKey: `\${${fallbackVar}}` }, hasAuth: true };
}

interface AnthropicModelsPayload {
  data?: Array<{ id?: string; display_name?: string }>;
  has_more?: boolean;
  last_id?: string;
}

function parseAnthropicModels(payload: AnthropicModelsPayload): RemoteModelInfo[] {
  const remoteModels: RemoteModelInfo[] = [];
  if (!Array.isArray(payload.data)) {
    throw new Error("Model discover failed: invalid Anthropic models response");
  }
  for (const entry of payload.data) {
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    const info: RemoteModelInfo = { id: entry.id };
    if (typeof entry.display_name === "string" && entry.display_name.length > 0) {
      info.name = entry.display_name;
    }
    remoteModels.push(info);
  }
  return remoteModels;
}

function buildDiscoverResult(
  providerId: string,
  provider: OpenClawProvider,
  remoteModels: RemoteModelInfo[],
  truncated: boolean,
  truncationReason?: string
): ProviderDiscoverResult {
  const existingIds = new Set((provider.models ?? []).map((model) => model.id));
  let resultModels = remoteModels;
  let resultTruncated = truncated;
  let resultReason = truncationReason;

  if (remoteModels.length > DISCOVER_MAX_MODELS) {
    resultTruncated = true;
    resultReason = `远端模型数量超过安全上限 ${DISCOVER_MAX_MODELS}`;
    resultModels = remoteModels.slice(0, DISCOVER_MAX_MODELS);
  }

  const alreadyAddedIds = resultModels
    .map((model) => model.id)
    .filter((id) => existingIds.has(id));

  return {
    providerId,
    remoteModels: resultModels,
    alreadyAddedIds,
    truncated: resultTruncated,
    ...(resultReason !== undefined ? { truncationReason: resultReason } : {})
  };
}

async function discoverOpenAiModels(
  providerId: string,
  provider: OpenClawProvider,
  fetchImpl: FetchImpl,
  envContent: string | undefined,
  normalizeBaseUrl = true,
  hasAuth = false
): Promise<ProviderDiscoverResult> {
  if (!provider.baseUrl) throw new Error(`Provider ${providerId} has no baseUrl`);

  const response = await fetchImpl(openaiModelsEndpoint(provider.baseUrl, normalizeBaseUrl), {
    headers: { accept: "application/json", ...openaiAuthHeaders(providerId, provider, envContent) }
  });
  if (!response.ok) {
    throw discoverHttpError(response.status, hasAuth);
  }

  const payload = (await response.json()) as { data?: Array<{ id?: string; name?: string }> };
  const remoteModels: RemoteModelInfo[] = [];
  for (const entry of payload.data ?? []) {
    if (typeof entry.id !== "string" || entry.id.length === 0) continue;
    const info: RemoteModelInfo = { id: entry.id };
    if (typeof entry.name === "string" && entry.name.length > 0) {
      info.name = entry.name;
    }
    remoteModels.push(info);
  }

  return buildDiscoverResult(providerId, provider, remoteModels, false);
}

async function discoverAnthropicModels(
  providerId: string,
  provider: OpenClawProvider,
  fetchImpl: FetchImpl,
  envContent: string | undefined,
  normalizeBaseUrl = true,
  hasAuth = false
): Promise<ProviderDiscoverResult> {
  if (!provider.baseUrl) throw new Error(`Provider ${providerId} has no baseUrl`);

  const remoteModels: RemoteModelInfo[] = [];
  let truncated = false;
  let truncationReason: string | undefined;
  let afterId: string | undefined;
  let pageCount = 0;

  while (true) {
    pageCount += 1;
    const response = await fetchImpl(anthropicModelsEndpoint(provider.baseUrl, afterId, normalizeBaseUrl), {
      headers: {
        accept: "application/json",
        ...anthropicAuthHeaders(providerId, provider, envContent)
      }
    });
    if (!response.ok) {
      throw discoverHttpError(response.status, hasAuth);
    }

    const payload = (await response.json()) as AnthropicModelsPayload;
    remoteModels.push(...parseAnthropicModels(payload));

    if (remoteModels.length >= DISCOVER_MAX_MODELS) {
      truncated = true;
      truncationReason = `远端模型数量超过安全上限 ${DISCOVER_MAX_MODELS}`;
      break;
    }

    if (!payload.has_more) break;

    if (pageCount >= DISCOVER_MAX_PAGES) {
      truncated = true;
      truncationReason = `远端模型分页超过安全上限 ${DISCOVER_MAX_PAGES} 页`;
      break;
    }

    if (typeof payload.last_id !== "string" || payload.last_id.length === 0) {
      throw new Error("Model discover failed: Anthropic pagination missing last_id");
    }
    afterId = payload.last_id;
  }

  return buildDiscoverResult(providerId, provider, remoteModels, truncated, truncationReason);
}

/**
 * 从远端拉取 Provider 模型目录（只读发现，永不写入 openclaw.json）。
 * OpenAI 兼容路径：GET {base}/models，解析 data[] 的 id 与可选 name。
 * Anthropic 路径：GET {base}/v1/models，分页拉取 display_name → name。
 */
export async function discoverProviderModels(
  config: OpenClawConfig,
  providerId: string,
  options?: FetchImpl | ProviderDiscoverOptions
): Promise<ProviderDiscoverResult> {
  const { fetchImpl, envContent, pluginProviders } = resolveDiscoverOptions(options);
  const resolvedProviderId = resolveProviderId(config, providerId);
  const provider = resolvedProviderId ? config.models?.providers?.[resolvedProviderId] : undefined;
  if (!provider) throw new Error(`Provider ${providerId} not found`);
  const canonicalProviderId = normalizeProviderId(resolvedProviderId!);

  const api = provider.api ?? "openai-completions";
  if (api === "google-generative-ai") {
    return {
      providerId: canonicalProviderId,
      remoteModels: [],
      alreadyAddedIds: [],
      truncated: false,
      unsupportedReason: `Provider API ${api} does not support model discover`
    };
  }

  const auth = resolveDiscoverAuth(canonicalProviderId, provider, envContent, pluginProviders);

  if (api === "anthropic-messages") {
    return discoverAnthropicModels(canonicalProviderId, auth.provider, fetchImpl, envContent, true, auth.hasAuth);
  }

  return discoverOpenAiModels(canonicalProviderId, auth.provider, fetchImpl, envContent, true, auth.hasAuth);
}

/**
 * 基于表单凭证临时发现远端模型（只读，不依赖本地配置文件）。
 * 该能力用于「添加 Provider」弹窗，凭 api/baseUrl/apiKey 发起一次性 discover。
 */
export async function discoverProviderModelsFromCredentials(
  input: ProviderDiscoverCredentialsInput,
  options?: FetchImpl | ProviderDiscoverOptions
): Promise<ProviderDiscoverResult> {
  const { fetchImpl } = resolveDiscoverOptions(options);
  const providerId = normalizeProviderId(input.providerId ?? "__preview__");
  const api = input.api ?? "openai-completions";
  if (!input.baseUrl || input.baseUrl.trim().length === 0) {
    throw new Error("baseUrl must be a non-empty string");
  }
  if (!input.apiKey || input.apiKey.trim().length === 0) {
    throw new Error("apiKey must be a non-empty string");
  }
  if (api === "google-generative-ai") {
    return {
      providerId,
      remoteModels: [],
      alreadyAddedIds: [],
      truncated: false,
      unsupportedReason: `Provider API ${api} does not support model discover`
    };
  }

  const provider: OpenClawProvider = {
    api,
    baseUrl: input.baseUrl,
    // 仅用于复用鉴权头分支；不参与任何配置写入。
    apiKey: "${EPHEMERAL_PROVIDER_API_KEY}",
    models: []
  };
  const envContent = `EPHEMERAL_PROVIDER_API_KEY=${input.apiKey}\n`;
  const discovered =
    api === "anthropic-messages"
      ? await discoverAnthropicModels(providerId, provider, fetchImpl, envContent, !input.isFullUrl, true)
      : await discoverOpenAiModels(providerId, provider, fetchImpl, envContent, !input.isFullUrl, true);
  const alreadyAddedIds = Array.isArray(input.alreadyAddedIds)
    ? discovered.remoteModels
        .map((model) => model.id)
        .filter((id) => input.alreadyAddedIds?.includes(id))
    : [];
  return {
    ...discovered,
    alreadyAddedIds
  };
}

/** @deprecated 使用 discoverProviderModels；发现语义，不再全量写入配置 */
export const syncProviderModels = discoverProviderModels;

/** @deprecated 使用 ProviderDiscoverOptions */
export type ProviderSyncOptions = ProviderDiscoverOptions;
