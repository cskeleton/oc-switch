/** API 响应类型（与 server 端点对齐，不含密钥值） */

export interface StatusResponse {
  ok: boolean;
  primaryModel?: string;
  providerCount: number;
  providerModelCount: number;
  allowlistModelCount: number;
}

export interface EnvPreview {
  affectedKeys: string[];
  requiresConfirmation: boolean;
  requiresMigration: boolean;
  requiresComplex: boolean;
  warnings: string[];
  backupWillIncludeSecrets: boolean;
}

export interface EnvWriteVerificationEntry {
  envVar: string;
  verified: boolean;
  managed: boolean;
  maskedValue?: string | undefined;
  reason?: "missing-managed-value" | "value-mismatch" | undefined;
}

export interface EnvWriteVerification {
  verified: boolean;
  entries: EnvWriteVerificationEntry[];
}

export interface GatewayEnvSyncResult {
  ok: boolean;
  targetKind?: "systemd" | "launchd";
  targetPath?: string;
  syncedKeys: string[];
  removedKeys: string[];
  warnings: string[];
  candidateId?: string;
}

export interface GatewayRestartResult {
  ok: boolean;
  exitCode: number | null;
  message: string;
}

export type ApiKeyEnvStatus = "managed" | "unmanaged" | "missing" | "complex" | "duplicate";

export interface ProviderSummary {
  id: string;
  api: string | undefined;
  baseUrl: string | undefined;
  modelCount: number;
  enabledModelCount: number;
  containsPrimary: boolean;
  disabled: boolean;
  apiKeyEnv: string | null;
  apiKeyEnvManaged: boolean;
  apiKeyEnvStatus: ApiKeyEnvStatus;
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
  contextTokens?: number;
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

export interface CredentialDiffItem {
  envVar: string;
  providerId?: string;
  change: "added" | "removed" | "changed";
}

export interface ProviderStateChangeItem {
  providerId: string;
  change: "disable" | "enable";
}

export interface ProviderFieldChangeItem {
  providerId: string;
  parameterName: string;
  oldValue: string;
  newValue: string;
}

export interface ConfigDiffSummary {
  providersAdded: string[];
  providersRemoved: string[];
  providersChanged: string[];
  modelsEnabled: string[];
  modelsDisabled: string[];
  primaryChanged: { before: string | undefined; after: string | undefined } | null;
  credentialsChanged: CredentialDiffItem[];
  providerStateChanges: ProviderStateChangeItem[];
  providerFieldChanges: ProviderFieldChangeItem[];
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
  candidateId?: string;
}

export type RuntimeDiscoveryConfidence = "confirmed" | "strong" | "inferred";
export type RuntimeDiscoveryStatus =
  | "resolved"
  | "gateway-detected-path-unresolved"
  | "gateway-not-detected"
  | "probe-failed";
export type RuntimeDiscoveryEvidence =
  | "process-cmdline"
  | "process-environ"
  | "systemd-unit"
  | "launchd-plist"
  | "cli-status"
  | "default-state-dir";

export interface RuntimeDiscoveryInstanceSummary {
  instanceId: string;
  pid: number;
  openclawPath?: string;
  envPath?: string;
  stateDir?: string;
  serviceEnvPath?: string;
  serviceManager?: "systemd" | "launchd";
  serviceId?: string;
  confidence?: RuntimeDiscoveryConfidence;
  conflicted?: boolean;
  evidence: RuntimeDiscoveryEvidence[];
}

export interface RuntimePathCandidateGroup {
  candidateId: string;
  instanceId: string;
  stateDir: string;
  openclawPath: string;
  envPath: string;
  serviceEnvPath?: string;
  serviceManager?: "systemd" | "launchd";
  serviceId?: string;
  pid: number;
  confidence?: RuntimeDiscoveryConfidence;
  conflicted?: boolean;
  evidence: RuntimeDiscoveryEvidence[];
}

export interface RuntimeDiscoverySummary {
  status: RuntimeDiscoveryStatus;
  instances: RuntimeDiscoveryInstanceSummary[];
  diagnostics: string[];
}

export interface PathSettingsResponse {
  active: { openclawPath: string; envPath: string; stateDir: string };
  openclawPaths: PathCandidate[];
  envPaths: PathCandidate[];
  runtimeDiscovery?: RuntimeDiscoverySummary;
  runtimeCandidateGroups?: RuntimePathCandidateGroup[];
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

/** 远端发现的模型条目（provider-local raw id） */
export interface RemoteModelInfo {
  id: string;
  name?: string;
}

/** POST /api/providers/:id/discover 响应 */
export interface ProviderDiscoverResponse {
  ok: boolean;
  providerId: string;
  remoteModels: RemoteModelInfo[];
  alreadyAddedIds: string[];
  truncated: boolean;
  truncationReason?: string;
  unsupportedReason?: string | null;
}

/** POST /api/providers/discover-preview 请求体（添加前临时发现） */
export interface ProviderDiscoverPreviewInput {
  api: ApiType;
  baseUrl: string;
  apiKey: string;
  isFullUrl?: boolean;
  alreadyAddedIds?: string[];
}

/** POST /api/providers/:id/models/batch-add 请求体 */
export interface BatchAddProviderModelsInput {
  models: Array<{ id: string; name?: string }>;
  enable?: boolean;
}

/** POST /api/providers/:id/models/batch-add 响应 */
export interface BatchAddProviderModelsResponse {
  ok: boolean;
  addedModelIds: string[];
  skippedModelIds: string[];
  enabled: boolean;
  backupId?: string;
}

/** POST /api/providers/:id/models/batch-remove 请求体（二选一） */
export type BatchRemoveProviderModelsInput =
  | { modelIds: string[]; keepEnabledOnly?: undefined }
  | { keepEnabledOnly: true; modelIds?: undefined };

/** POST /api/providers/:id/models/batch-remove 响应 */
export interface BatchRemoveProviderModelsResponse {
  ok: boolean;
  removedModelIds: string[];
  backupId?: string;
}

export interface CustomProviderModelInput {
  id: string;
  name?: string;
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
  contextTokens?: number;
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

/** 建议匹配方式（与 core resolver 对齐） */
export type ModelMetadataMatchKind =
  | "provider-exact"
  | "endpoint-exact"
  | "model-key-exact"
  | "provider-model-exact"
  | "unique-model-id";

export type ModelMetadataConfidence = "high" | "medium" | "low";

export type ModelMetadataSourceKind = "models-dev-model" | "models-dev-provider";

/** 归一化模型元数据条目（与 server 响应对齐，不含密钥） */
export interface ModelMetadataSuggestionModel {
  catalogKey: string;
  providerId?: string;
  modelId: string;
  name?: string;
  contextWindow?: number;
  inputLimit?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  updatedAt?: string;
  sourceKind: ModelMetadataSourceKind;
  sourceUrl: string;
}

export interface ModelMetadataSuggestion {
  matchKind: ModelMetadataMatchKind;
  confidence: ModelMetadataConfidence;
  model: ModelMetadataSuggestionModel;
}

/** 逐源时间/stale 状态 */
export interface ModelMetadataSourceStatus {
  kind: ModelMetadataSourceKind;
  fetchedAt: string;
  checkedAt: string;
  stale: boolean;
}

/** GET /api/model-metadata/suggestions 响应 */
export interface ModelMetadataSuggestionsResponse {
  suggestions: ModelMetadataSuggestion[];
  sources: ModelMetadataSourceStatus[];
  warnings: string[];
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
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        restart?: { message?: string };
      };
      throw new Error(body.error ?? body.restart?.message ?? `Request failed: ${response.status}`);
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
    /** 查询 Models.dev 参考参数建议（只读；Provider/Model 仅在本地匹配） */
    getModelMetadataSuggestions: (
      providerId: string,
      modelId: string,
      options: { refresh?: boolean } = {}
    ) => {
      const params = new URLSearchParams();
      params.set("providerId", providerId);
      params.set("modelId", modelId);
      if (options.refresh) params.set("refresh", "1");
      return request<ModelMetadataSuggestionsResponse>(`/api/model-metadata/suggestions?${params.toString()}`);
    },
    getPresets: () => request<{ presets: PresetEntry[] }>("/api/presets"),
    importPresets: () => request<{ ok: boolean; imported: string[] }>("/api/presets/import", { method: "POST" }),
    exportPreset: (providerId: string) =>
      request<{ ok: boolean; id: string }>(`/api/presets/export/${providerId}`, { method: "POST" }),
    previewAddProvider: (presetId: string, models?: string[]) =>
      request<ConfigDiffSummary & { envPreview?: EnvPreview }>("/api/providers/preview", {
        method: "POST",
        body: JSON.stringify({ presetId, models })
      }),
    addProvider: (
      presetId: string,
      apiKey: string,
      models?: string[],
      flags?: { confirmMigration?: boolean; confirmComplex?: boolean }
    ) =>
      request<{ ok: boolean; backupId?: string; envWrite?: EnvWriteVerification; gatewayEnvSync?: GatewayEnvSyncResult }>("/api/providers", {
        method: "POST",
        body: JSON.stringify({ presetId, apiKey, models, ...flags })
      }),
    previewCustomProvider: (input: CustomProviderInput) =>
      request<ConfigDiffSummary & { envPreview?: EnvPreview }>("/api/providers/custom/preview", {
        method: "POST",
        body: JSON.stringify(input)
      }),
    addCustomProvider: (
      input: CustomProviderInput,
      apiKey: string,
      flags?: { confirmMigration?: boolean; confirmComplex?: boolean }
    ) =>
      request<{ ok: boolean; backupId?: string; envWrite?: EnvWriteVerification; gatewayEnvSync?: GatewayEnvSyncResult }>("/api/providers/custom", {
        method: "POST",
        body: JSON.stringify({ ...input, apiKey, ...flags })
      }),
    previewUpdateProvider: (id: string, changes: { baseUrl?: string; api?: ApiType; includeApiKeyEnv?: boolean }) =>
      request<ConfigDiffSummary & { envPreview?: EnvPreview }>(`/api/providers/${id}/preview`, {
        method: "POST",
        body: JSON.stringify(changes)
      }),
    updateProvider: (id: string, changes: { baseUrl?: string; api?: ApiType; apiKey?: string; confirmMigration?: boolean; confirmComplex?: boolean }) =>
      request<{ ok: boolean; backupId?: string; envWrite?: EnvWriteVerification; gatewayEnvSync?: GatewayEnvSyncResult }>(`/api/providers/${id}`, {
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
    /** 发现远端模型目录（只读，不写盘） */
    discoverProvider: (id: string) =>
      request<ProviderDiscoverResponse>(`/api/providers/${id}/discover`, { method: "POST" }),
    /** 添加 Provider 前按表单凭证临时发现模型（只读，不写盘） */
    discoverProviderPreview: (body: ProviderDiscoverPreviewInput) =>
      request<ProviderDiscoverResponse>("/api/providers/discover-preview", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    /** @deprecated 与 discoverProvider 相同；旧 sync 全量写入语义已移除 */
    syncProvider: (id: string) =>
      request<ProviderDiscoverResponse>(`/api/providers/${id}/discover`, { method: "POST" }),
    batchAddProviderModels: (id: string, body: BatchAddProviderModelsInput) =>
      request<BatchAddProviderModelsResponse>(`/api/providers/${id}/models/batch-add`, {
        method: "POST",
        body: JSON.stringify(body)
      }),
    batchRemoveProviderModels: (id: string, body: BatchRemoveProviderModelsInput) =>
      request<BatchRemoveProviderModelsResponse>(`/api/providers/${id}/models/batch-remove`, {
        method: "POST",
        body: JSON.stringify(body)
      }),
    getBackups: () => request<{ backups: BackupEntry[] }>("/api/backups"),
    restoreBackup: (id: string, target?: "backup" | "current") =>
      request<{ ok: boolean; id: string; safetyBackupId?: string; gatewayEnvSync?: GatewayEnvSyncResult; gatewayRestartRequired?: boolean }>(`/api/backups/${id}/restore`, {
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
    updatePathSettings: (openclawPath: string, envPath: string, candidateId?: string) =>
      request<{ ok: boolean; paths: { openclawPath: string; envPath: string; stateDir: string } }>("/api/settings/paths", {
        method: "PUT",
        body: JSON.stringify({
          openclawPath,
          envPath,
          ...(candidateId ? { candidateId } : {})
        })
      }),
    getEnvIndex: () => request<EnvIndexResponse>("/api/env"),
    updateEnvVar: (body: { type: "upsert"; envVar: string; value: string; note?: string; confirmMigration?: boolean; confirmComplex?: boolean }) =>
      request<{ ok: true; affectedKeys: string[]; backupId?: string; envWrite?: EnvWriteVerification; gatewayEnvSync?: GatewayEnvSyncResult }>("/api/env", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    deleteEnvVar: (body: { type: "delete"; envVar: string; confirmComplex?: boolean }) =>
      request<{ ok: true; affectedKeys: string[]; backupId?: string; gatewayEnvSync?: GatewayEnvSyncResult }>("/api/env", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    renameEnvVar: (body: { type: "rename"; fromEnvVar: string; toEnvVar: string; note?: string; confirmComplex?: boolean }) =>
      request<{ ok: true; affectedKeys: string[]; backupId?: string; gatewayEnvSync?: GatewayEnvSyncResult }>("/api/env", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    previewEnvVar: (body:
      | { type: "upsert" | "delete"; envVar: string; note?: string }
      | { type: "rename"; fromEnvVar: string; toEnvVar: string; note?: string }
    ) =>
      request<EnvPreview>("/api/env/preview", {
        method: "POST",
        body: JSON.stringify(body)
      }),
    cleanupOrphanEnvKeys: () =>
      request<{ ok: boolean; removedKeys: string[]; backupId?: string }>("/api/settings/orphans/cleanup", {
        method: "POST"
      }),
    syncGatewayEnv: (candidateId?: string) =>
      request<{ ok: boolean; sync: GatewayEnvSyncResult }>("/api/gateway/sync-env", {
        method: "POST",
        body: JSON.stringify(candidateId ? { candidateId } : {})
      }),
    restartGateway: (candidateId?: string) =>
      request<{ ok: boolean; restart: GatewayRestartResult }>("/api/gateway/restart", {
        method: "POST",
        body: JSON.stringify(candidateId ? { candidateId } : {})
      }),
    applyGateway: (candidateId?: string) =>
      request<{ ok: boolean; sync: GatewayEnvSyncResult; restart: GatewayRestartResult }>("/api/gateway/apply", {
        method: "POST",
        body: JSON.stringify(candidateId ? { candidateId } : {})
      })
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
