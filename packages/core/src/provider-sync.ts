import { readEnvValue } from "./env-manager";
import { providerEnvVar } from "./openclaw-compat";
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
function openaiModelsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const normalized = trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
  return `${normalized}/models`;
}

/** Anthropic List Models 端点；可选 after_id 分页游标 */
function anthropicModelsEndpoint(baseUrl: string, afterId?: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const normalized = trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
  const endpoint = `${normalized}/models`;
  if (!afterId) return endpoint;
  return `${endpoint}?after_id=${encodeURIComponent(afterId)}`;
}

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProviderDiscoverOptions {
  fetchImpl?: FetchImpl;
  envContent?: string;
}

function resolveDiscoverOptions(
  input?: FetchImpl | ProviderDiscoverOptions
): Required<Pick<ProviderDiscoverOptions, "fetchImpl">> & Pick<ProviderDiscoverOptions, "envContent"> {
  if (typeof input === "function") {
    return { fetchImpl: input };
  }
  return {
    fetchImpl: input?.fetchImpl ?? fetch,
    ...(input?.envContent !== undefined ? { envContent: input.envContent } : {})
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
  envContent: string | undefined
): Promise<ProviderDiscoverResult> {
  if (!provider.baseUrl) throw new Error(`Provider ${providerId} has no baseUrl`);

  const response = await fetchImpl(openaiModelsEndpoint(provider.baseUrl), {
    headers: { accept: "application/json", ...openaiAuthHeaders(providerId, provider, envContent) }
  });
  if (!response.ok) {
    throw new Error(`Model discover failed: HTTP ${response.status}`);
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
  envContent: string | undefined
): Promise<ProviderDiscoverResult> {
  if (!provider.baseUrl) throw new Error(`Provider ${providerId} has no baseUrl`);

  const remoteModels: RemoteModelInfo[] = [];
  let truncated = false;
  let truncationReason: string | undefined;
  let afterId: string | undefined;
  let pageCount = 0;

  while (true) {
    pageCount += 1;
    const response = await fetchImpl(anthropicModelsEndpoint(provider.baseUrl, afterId), {
      headers: {
        accept: "application/json",
        ...anthropicAuthHeaders(providerId, provider, envContent)
      }
    });
    if (!response.ok) {
      throw new Error(`Model discover failed: HTTP ${response.status}`);
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
  const { fetchImpl, envContent } = resolveDiscoverOptions(options);
  const provider = config.models?.providers?.[providerId];
  if (!provider) throw new Error(`Provider ${providerId} not found`);

  const api = provider.api ?? "openai-completions";
  if (api === "google-generative-ai") {
    return {
      providerId,
      remoteModels: [],
      alreadyAddedIds: [],
      truncated: false,
      unsupportedReason: `Provider API ${api} does not support model discover`
    };
  }

  if (api === "anthropic-messages") {
    return discoverAnthropicModels(providerId, provider, fetchImpl, envContent);
  }

  return discoverOpenAiModels(providerId, provider, fetchImpl, envContent);
}

/** @deprecated 使用 discoverProviderModels；发现语义，不再全量写入配置 */
export const syncProviderModels = discoverProviderModels;

/** @deprecated 使用 ProviderDiscoverOptions */
export type ProviderSyncOptions = ProviderDiscoverOptions;
