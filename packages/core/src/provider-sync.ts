import { readEnvValue } from "./env-manager";
import { ensureModelName, providerEnvVar } from "./openclaw-compat";
import type { OpenClawConfig, OpenClawProvider } from "./types";

export interface ProviderSyncResult {
  providerId: string;
  addedModelIds: string[];
  skippedModelIds: string[];
  unsupportedReason?: string;
}

/** 归一化 baseUrl，避免重复 /v1 后拼接 OpenAI 兼容的 /models 端点 */
function modelsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const normalized = trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
  return `${normalized}/models`;
}

/** 将远端拉取到的新模型合并进配置，不删除已有模型，也不写入 allowlist */
export function applySyncedModels(
  config: OpenClawConfig,
  providerId: string,
  modelIds: string[]
): OpenClawConfig {
  const next = structuredClone(config);
  const provider = next.models?.providers?.[providerId];
  if (!provider) throw new Error(`Provider ${providerId} not found`);

  const existing = new Set((provider.models ?? []).map((model) => model.id));
  for (const modelId of modelIds) {
    if (existing.has(modelId)) continue;
    provider.models = [...(provider.models ?? []), ensureModelName({ id: modelId })];
    existing.add(modelId);
  }

  return next;
}

export type FetchImpl = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProviderSyncOptions {
  fetchImpl?: FetchImpl;
  envContent?: string;
}

function resolveSyncOptions(input?: FetchImpl | ProviderSyncOptions): Required<Pick<ProviderSyncOptions, "fetchImpl">> & Pick<ProviderSyncOptions, "envContent"> {
  if (typeof input === "function") {
    return { fetchImpl: input };
  }
  return {
    fetchImpl: input?.fetchImpl ?? fetch,
    ...(input?.envContent !== undefined ? { envContent: input.envContent } : {})
  };
}

function providerAuthHeaders(
  providerId: string,
  provider: OpenClawProvider,
  envContent: string | undefined
): Record<string, string> {
  const envVar = providerEnvVar(provider);
  if (!envVar) return {};
  if (envContent === undefined) return {};
  const value = readEnvValue(envContent, envVar);
  if (!value) throw new Error(`Env var ${envVar} for provider ${providerId} not found`);
  return provider.apiKey ? { Authorization: `Bearer ${value}` } : { Authorization: value };
}

export async function syncProviderModels(
  config: OpenClawConfig,
  providerId: string,
  options?: FetchImpl | ProviderSyncOptions
): Promise<ProviderSyncResult> {
  const { fetchImpl, envContent } = resolveSyncOptions(options);
  const provider = config.models?.providers?.[providerId];
  if (!provider) throw new Error(`Provider ${providerId} not found`);

  const api = provider.api ?? "openai-completions";
  if (api === "anthropic-messages") {
    return {
      providerId,
      addedModelIds: [],
      skippedModelIds: [],
      unsupportedReason: `Provider API ${api} does not support model sync`
    };
  }
  if (api === "google-generative-ai") {
    return {
      providerId,
      addedModelIds: [],
      skippedModelIds: [],
      unsupportedReason: `Provider API ${api} does not support model sync`
    };
  }

  if (!provider.baseUrl) throw new Error(`Provider ${providerId} has no baseUrl`);

  const response = await fetchImpl(modelsEndpoint(provider.baseUrl), {
    headers: { accept: "application/json", ...providerAuthHeaders(providerId, provider, envContent) }
  });
  if (!response.ok) {
    throw new Error(`Model sync failed: HTTP ${response.status}`);
  }

  const payload = await response.json() as { data?: Array<{ id?: string }> };
  const remoteIds = (payload.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

  const existingIds = new Set((provider.models ?? []).map((model) => model.id));
  const addedModelIds: string[] = [];
  const skippedModelIds: string[] = [];

  for (const modelId of remoteIds) {
    if (existingIds.has(modelId)) {
      skippedModelIds.push(modelId);
    } else {
      addedModelIds.push(modelId);
    }
  }

  return { providerId, addedModelIds, skippedModelIds };
}
