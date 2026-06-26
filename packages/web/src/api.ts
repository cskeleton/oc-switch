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
  baseUrl: string | undefined;
  modelCount: number;
  enabledModelCount: number;
  containsPrimary: boolean;
  disabled: boolean;
}

export interface ModelSummary {
  ref: string;
  providerId: string;
  modelId: string;
  name: string | undefined;
  alias: string | undefined;
  enabled: boolean;
  isPrimary: boolean;
  api?: ApiType;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
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
  openclawPath: string;
  envPath: string;
  pathMatchesActive: boolean;
}

export interface ConfigDiffSummary {
  providersAdded: string[];
  providersRemoved: string[];
  providersChanged: string[];
  modelsEnabled: string[];
  modelsDisabled: string[];
  primaryChanged: { before: string | undefined; after: string | undefined } | null;
}

export type CaseDuplicateKind = "provider-duplicate" | "allowlist-drift" | "same-origin-hint" | "primary-split";

export interface CaseDuplicateGroup {
  groupKey: string;
  ids: string[];
  kinds: CaseDuplicateKind[];
  confidence: "high" | "medium" | "low";
  sameOrigin: boolean;
  mergeable: boolean;
  mergeBlockers: string[];
  canonicalId: string;
  duplicateIds: string[];
  reasons: string[];
  details: {
    baseUrls: Record<string, string | undefined>;
    allowlistCounts: Record<string, number>;
    modelCounts: Record<string, number>;
    primaryModel?: string;
    envVars: Record<string, string | undefined>;
  };
}

export interface ConfigHealthReport {
  caseDuplicateGroups: CaseDuplicateGroup[];
  summary: { duplicateGroupCount: number; affectedProviderCount: number; affectedAllowlistCount: number };
}

export interface ConfigStatusIssue {
  id: string;
  severity: "info" | "warning" | "blocking";
  source: "health" | "env" | "paths" | "providers";
  title: string;
  detail?: string;
  action?: string;
}

export interface DisabledProviderStatus {
  providerId: string;
  disabledAt: string;
  openclawPath: string;
  hiddenModelCount: number;
}

export interface ConfigStatusReport {
  version: 1;
  health: ConfigHealthReport;
  disabledProviders: DisabledProviderStatus[];
  orphanEnvKeys: string[];
  envWarnings: string[];
  issues: ConfigStatusIssue[];
  summary: {
    issueCount: number;
    blockingIssueCount: number;
    warningIssueCount: number;
    duplicateGroupCount: number;
    disabledProviderCount: number;
    orphanEnvKeyCount: number;
  };
}

export interface MergeCaseDuplicateInput {
  groupKey: string;
  canonicalId: string;
  removeIds: string[];
  keepModelIds?: string[];
}

export interface SettingsResponse {
  configPath: string;
  envPath?: string;
  bindAddress: string;
  port: number;
  backupRetention: number;
  gatewayRestartCommand: string;
  orphanEnvKeys: string[];
}

export interface PathCandidate {
  path: string;
  source: string;
  label: string;
  recommended: boolean;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  parentWritable: boolean;
}

export interface PathSettingsResponse {
  active: { openclawPath: string; envPath: string; stateDir: string };
  openclawPaths: PathCandidate[];
  envPaths: PathCandidate[];
}

export interface EnvVariableSummary {
  envVar: string;
  present: boolean;
  managed: boolean;
  providerRef: boolean;
  providerIds: string[];
  extraManaged: boolean;
  orphan: boolean;
  missing: boolean;
  duplicate: boolean;
  complex: boolean;
  note?: string;
  updatedAt?: string;
}

export interface EnvIndexResponse {
  variables: EnvVariableSummary[];
  warnings: string[];
}

export type ApiType = "openai-completions" | "anthropic-messages" | "google-generative-ai";

export interface CustomProviderModelInput {
  id: string;
  alias?: string;
}

export interface ProviderModelInput {
  id: string;
  name?: string;
  alias?: string;
  enabled: boolean;
  api?: ApiType;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
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
    createModel: (providerId: string, model: ProviderModelInput) =>
      request<{ ok: boolean; ref: string; backupId?: string }>("/api/models", {
        method: "POST",
        body: JSON.stringify({ providerId, model })
      }),
    updateModel: (ref: string, model: ProviderModelInput) =>
      request<{ ok: boolean; ref: string; backupId?: string }>("/api/models", {
        method: "PUT",
        body: JSON.stringify({ ref, model })
      }),
    deleteModel: (ref: string, body: { force?: boolean; newPrimary?: string } = {}) =>
      request<{ ok: boolean; ref: string; backupId?: string }>("/api/models", {
        method: "DELETE",
        body: JSON.stringify({ ref, ...body })
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
    patchProviderState: (id: string, enabled: boolean) =>
      request<{ ok: boolean; providerId: string; enabled: boolean; disabledModelCount?: number; restoredModelCount?: number; backupId?: string }>(
        `/api/providers/${id}/state`,
        {
          method: "PATCH",
          body: JSON.stringify({ enabled })
        }
      ),
    syncProvider: (id: string) =>
      request<{ ok: boolean; addedModelIds?: string[]; unsupportedReason?: string }>(
        `/api/providers/${id}/sync`,
        { method: "POST" }
      ),
    getBackups: () => request<{ backups: BackupEntry[] }>("/api/backups"),
    restoreBackup: (id: string, target?: "backup" | "current") =>
      request<{ ok: boolean; id: string; safetyBackupId?: string }>(`/api/backups/${id}/restore`, {
        method: "POST",
        ...(target ? { body: JSON.stringify({ target }) } : {})
      }),
    getDiff: () => request<ConfigDiffSummary>("/api/diff"),
    getHealth: () => request<ConfigHealthReport>("/api/health"),
    getConfigStatus: () => request<ConfigStatusReport>("/api/config-status"),
    previewMergeCaseDuplicates: (input: MergeCaseDuplicateInput) =>
      request<ConfigDiffSummary>("/api/providers/merge-case-duplicates/preview", {
        method: "POST",
        body: JSON.stringify(input)
      }),
    mergeCaseDuplicates: (input: MergeCaseDuplicateInput) =>
      request<{ ok: boolean; warnings: string[]; backupId?: string }>("/api/providers/merge-case-duplicates", {
        method: "POST",
        body: JSON.stringify(input)
      }),
    getSettings: () => request<SettingsResponse>("/api/settings"),
    getPathSettings: () => request<PathSettingsResponse>("/api/settings/paths"),
    updatePathSettings: (openclawPath: string, envPath: string) =>
      request<{ ok: boolean; paths: { openclawPath: string; envPath: string; stateDir: string } }>("/api/settings/paths", {
        method: "PUT",
        body: JSON.stringify({ openclawPath, envPath })
      }),
    getEnvIndex: () => request<EnvIndexResponse>("/api/env"),
    updateEnvVar: (body: { type: "upsert"; envVar: string; value: string; note?: string; confirmMigration?: boolean; confirmComplex?: boolean }) =>
      request<{ ok: true; affectedKeys: string[]; backupId?: string }>("/api/env", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    deleteEnvVar: (body: { type: "delete"; envVar: string; confirmComplex?: boolean }) =>
      request<{ ok: true; affectedKeys: string[]; backupId?: string }>("/api/env", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    renameEnvVar: (body: { type: "rename"; fromEnvVar: string; toEnvVar: string; note?: string; confirmComplex?: boolean }) =>
      request<{ ok: true; affectedKeys: string[]; backupId?: string }>("/api/env", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    previewEnvVar: (body:
      | { type: "upsert" | "delete"; envVar: string; note?: string }
      | { type: "rename"; fromEnvVar: string; toEnvVar: string; note?: string }
    ) =>
      request<{ affectedKeys: string[]; requiresConfirmation: boolean; warnings: string[]; backupWillIncludeSecrets: boolean }>("/api/env/preview", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    cleanupOrphanEnvKeys: () =>
      request<{ ok: boolean; removedKeys: string[]; backupId?: string }>("/api/settings/orphans/cleanup", {
        method: "POST"
      })
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
