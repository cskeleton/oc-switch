/** API 响应类型（与 server 端点对齐，不含密钥值） */

export interface StatusResponse {
  ok: boolean;
  primaryModel?: string;
  providerCount: number;
  providerModelCount: number;
  allowlistModelCount: number;
}

export interface ProviderSummary {
  id: string;
  api: string | undefined;
  modelCount: number;
  enabledModelCount: number;
  containsPrimary: boolean;
}

export interface ModelSummary {
  ref: string;
  providerId: string;
  modelId: string;
  name: string | undefined;
  alias: string | undefined;
  enabled: boolean;
  isPrimary: boolean;
}

export interface PresetEntry {
  id: string;
  name: string;
  source: "builtin" | "custom";
  tags: string[];
  modelCount: number;
}

export interface BackupEntry {
  id: string;
  createdAt: string;
  reason: string;
}

export interface ConfigDiffSummary {
  providersAdded: string[];
  providersRemoved: string[];
  providersChanged: string[];
  modelsEnabled: string[];
  modelsDisabled: string[];
  primaryChanged: { before: string | undefined; after: string | undefined } | null;
}

export interface SettingsResponse {
  configPath: string;
  bindAddress: string;
  port: number;
  backupRetention: number;
  gatewayRestartCommand: string;
  orphanEnvKeys: string[];
}

export type ApiType = "openai-completions" | "anthropic-messages" | "google-generative-ai";

export interface CustomProviderModelInput {
  id: string;
  alias?: string;
}

export interface CustomProviderInput {
  providerId: string;
  displayName: string;
  notes?: string;
  websiteUrl?: string;
  api: ApiType;
  baseUrl: string;
  isFullUrl: boolean;
  apiKeyEnv: string;
  models: CustomProviderModelInput[];
  enableAllModels: boolean;
}

export type FetchFn = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: FetchFn;
}

/** 创建带 Bearer 认证的 REST API 客户端 */
export function createApiClient(options: ApiClientOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetchImpl(`${options.baseUrl}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${options.token}`,
        ...init.headers
      }
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `Request failed: ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  return {
    getStatus: () => request<StatusResponse>("/api/status"),
    getProviders: () => request<{ providers: ProviderSummary[] }>("/api/providers"),
    getModels: () => request<{ models: ModelSummary[] }>("/api/models"),
    setPrimary: (ref: string) =>
      request<{ ok: boolean; ref: string }>("/api/models/primary", {
        method: "PUT",
        body: JSON.stringify({ ref })
      }),
    patchModel: (ref: string, enabled: boolean) =>
      request<{ ok: boolean; ref: string; enabled: boolean }>("/api/models", {
        method: "PATCH",
        body: JSON.stringify({ ref, enabled })
      }),
    getPresets: () => request<{ presets: PresetEntry[] }>("/api/presets"),
    importPresets: () => request<{ ok: boolean; imported: string[] }>("/api/presets/import", { method: "POST" }),
    exportPreset: (providerId: string) =>
      request<{ ok: boolean; id: string }>(`/api/presets/export/${providerId}`, { method: "POST" }),
    previewAddProvider: (presetId: string, models?: string[]) =>
      request<ConfigDiffSummary>("/api/providers/preview", {
        method: "POST",
        body: JSON.stringify({ presetId, models })
      }),
    addProvider: (presetId: string, apiKey: string, models?: string[]) =>
      request<{ ok: boolean }>("/api/providers", {
        method: "POST",
        body: JSON.stringify({ presetId, apiKey, models })
      }),
    previewCustomProvider: (input: CustomProviderInput) =>
      request<ConfigDiffSummary>("/api/providers/custom/preview", {
        method: "POST",
        body: JSON.stringify(input)
      }),
    addCustomProvider: (input: CustomProviderInput, apiKey: string) =>
      request<{ ok: boolean; backupId?: string }>("/api/providers/custom", {
        method: "POST",
        body: JSON.stringify({ ...input, apiKey })
      }),
    updateProvider: (id: string, changes: { baseUrl?: string; apiKey?: string }) =>
      request<{ ok: boolean }>(`/api/providers/${id}`, {
        method: "PUT",
        body: JSON.stringify(changes)
      }),
    deleteProvider: (id: string, body: { force?: boolean; newPrimary?: string } = {}) =>
      request<{ ok: boolean }>(`/api/providers/${id}`, {
        method: "DELETE",
        body: JSON.stringify(body)
      }),
    syncProvider: (id: string) =>
      request<{ ok: boolean; addedModelIds?: string[]; unsupportedReason?: string }>(
        `/api/providers/${id}/sync`,
        { method: "POST" }
      ),
    getBackups: () => request<{ backups: BackupEntry[] }>("/api/backups"),
    restoreBackup: (id: string) =>
      request<{ ok: boolean; id: string; safetyBackupId?: string }>(`/api/backups/${id}/restore`, { method: "POST" }),
    getDiff: () => request<ConfigDiffSummary>("/api/diff"),
    getSettings: () => request<SettingsResponse>("/api/settings"),
    cleanupOrphanEnvKeys: () =>
      request<{ ok: boolean; removedKeys: string[]; backupId?: string }>("/api/settings/orphans/cleanup", {
        method: "POST"
      })
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
