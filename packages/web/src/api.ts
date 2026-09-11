/** API 响应类型（与 server 端点对齐，不含密钥值） */

export type ModelPolicyMode = "legacy" | "unrestricted" | "restricted";

export type ModelSelectionSource = "legacy" | "unrestricted" | "policy-exact" | "policy-wildcard";

export interface StatusResponse {
  ok: boolean;
  primaryModel?: string;
  providerCount: number;
  providerModelCount: number;
  allowlistModelCount: number;
  modelPolicyMode: ModelPolicyMode;
  effectiveModelCount: number;
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
  /** config = openclaw.json 的 models.providers；plugin = OpenClaw 插件 manifest 提供的只读目录。 */
  source: "config" | "plugin";
  apiKeyEnv: string | null;
  apiKeyEnvManaged: boolean;
  apiKeyEnvStatus: ApiKeyEnvStatus;
}

export type ProviderSecretRefMigrationBlocker =
  | "source-env-missing"
  | "source-env-empty"
  | "source-env-duplicate"
  | "source-env-complex"
  | "gateway-target-unavailable"
  | "gateway-env-drift";

export interface ProviderSecretRefMigrationCandidate {
  providerId: string;
  envVar: string;
  currentFormat: "env-shorthand" | "legacy-env-ref";
  status: "ready" | "blocked";
  blockers: ProviderSecretRefMigrationBlocker[];
}

export interface ProviderSecretRefMigrationPreview {
  candidates: ProviderSecretRefMigrationCandidate[];
  summary: {
    candidateCount: number;
    readyCount: number;
    blockedCount: number;
  };
}

export interface ModelSummary {
  ref: string;
  providerId: string;
  modelId: string;
  name: string | undefined;
  alias: string | undefined;
  enabled: boolean;
  /** undefined 表示该行没有有效 selection 来源。 */
  selectionSource?: ModelSelectionSource;
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
  | "unique-model-id"
  | "core-model-id";

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
  output?: string[];
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

/** POST /api/providers/:id/models/sync-metadata 响应 */
export interface ModelMetadataSyncUpdatedItem {
  modelId: string;
  filled: { name?: string; reasoning?: boolean; contextWindow?: number; maxTokens?: number; input?: string[] };
  catalogKey: string;
  matchKind: string;
}

export interface SyncModelMetadataResponse {
  ok: boolean;
  providerId: string;
  updated: ModelMetadataSyncUpdatedItem[];
  queued: Array<{ modelId: string; candidateCount: number }>;
  unmatched: string[];
  skipped: string[];
  warnings: string[];
  backupId?: string;
}

/** 确认队列候选（metadata 快照字段与 ModelMetadataSuggestion["model"] 同形） */
export interface ModelMetadataQueueCandidate {
  catalogKey: string;
  score: number;
  reason: string;
  metadata: ModelMetadataSuggestion["model"];
}

export interface ModelMetadataQueueItem {
  providerId: string;
  modelId: string;
  candidates: ModelMetadataQueueCandidate[];
  lastSeenAt: string;
  dismissed: boolean;
}

export interface ModelMetadataSyncQueueResponse {
  items: ModelMetadataQueueItem[];
}

export type ModelMetadataQueueResolveItem =
  | { providerId: string; modelId: string; action: "accept"; catalogKey: string }
  | { providerId: string; modelId: string; action: "dismiss" };

export interface ModelMetadataQueueResolveResponse {
  ok: boolean;
  applied: ModelMetadataSyncUpdatedItem[];
  dismissedCount: number;
  failed: Array<{ providerId: string; modelId: string; error: string }>;
  backupId?: string;
}

// ---------- 统一模型/Provider inventory DTO（与 packages/core/src/model-inventory.ts 同名同值） ----------

/** 模型目录来源（config / 插件 manifest / OpenClaw 运行时）。 */
export type ModelCatalogSource = "config" | "plugin-manifest" | "openclaw-runtime";

/** 引用来源（主模型 / fallback / legacy metadata / policy 精确 / policy 通配）。 */
export type ModelReferenceSource = "primary" | "fallback" | "legacy-metadata" | "policy-exact" | "policy-wildcard";

/** 运行可用性三态（探测证据不足时 unknown，绝不误判 unavailable）。 */
export type ModelAvailability = "available" | "unavailable" | "unknown";

/** 不可用/未知原因（含探测失败）。 */
export type ModelAvailabilityReason =
  | "plugin-disabled"
  | "provider-not-found"
  | "model-not-in-catalog"
  | "missing-auth"
  | "route-incompatible"
  | "provider-rejected"
  | "probe-failed";

/** 模型行能力开关（从事实推导，不由 UI 猜）。 */
export interface ModelInventoryCapabilities {
  canTogglePolicy: boolean;
  canSetPrimary: boolean;
  canEditCatalogEntry: boolean;
  canMaterializeConfigModel: boolean;
  canRemovePolicyExactRef: boolean;
}

/** 统一模型行。 */
export interface ModelInventoryEntry {
  ref: string;
  providerId: string;
  modelId: string;
  catalogSources: ModelCatalogSource[];
  referenceSources: ModelReferenceSource[];
  policyMode: ModelPolicyMode;
  selectionSource?: ModelSelectionSource;
  policyAllowed: boolean;
  availability: ModelAvailability;
  availabilityReasons: ModelAvailabilityReason[];
  pluginIds: string[];
  capabilities: ModelInventoryCapabilities;
}

/** Provider 能力开关（写权限按来源限制）。 */
export interface ProviderInventoryCapabilities {
  canEditConnection: boolean;
  canManageModels: boolean;
  canDisableProvider: boolean;
  canSetApiKey: boolean;
}

/** 统一 Provider 行。 */
export interface ProviderInventoryEntry {
  providerId: string;
  sources: ModelCatalogSource[];
  pluginIds: string[];
  /** true | false | null：null 表示非插件或无法确认。 */
  pluginEnabled: boolean | null;
  /** oc-switch 可逆关闭状态（provider-states.json），与插件 enabled 无关。 */
  disabled: boolean;
  availability: ModelAvailability;
  availabilityReasons: ModelAvailabilityReason[];
  modelCount: number;
  policyAllowedModelCount: number;
  availableModelCount: number;
  unavailableModelCount: number;
  capabilities: ProviderInventoryCapabilities;
}

/** policy.allow 原始规则投影：wildcard 不是模型行，只作为规则展示。 */
export interface ModelPolicyRuleEntry {
  value: string;
  kind: "exact" | "wildcard" | "invalid";
  /** 该规则在 allow 数组中的原始下标（invalid 条目只回显 index，不回显值）。 */
  invalidIndex?: number;
  matchedModelCount: number;
  unavailableModelCount: number;
  removable: boolean;
}

/** 插件级 descriptor 的非模型能力（用于启停确认框的影响面提示）。 */
export type ModelPluginNonModelCapability =
  | "channels"
  | "tools"
  | "hooks"
  | "commands"
  | "services"
  | "speech"
  | "realtime"
  | "media"
  | "search"
  | "other-contracts";

export interface ModelPluginDescriptor {
  id: string;
  name?: string;
  origin: string;
  enabled: boolean;
  providerIds: string[];
  nonModelCapabilities: ModelPluginNonModelCapability[];
}

/** 运行时目录探测诊断（探测失败不等于写入失败）。 */
export interface RuntimeModelDiagnostic {
  command: "version" | "status" | "list" | "list-all";
  code: "missing" | "timeout" | "non-zero-exit" | "invalid-json" | "invalid-shape";
  message: string;
}

/** GET /api/model-inventory 与 POST /api/model-inventory/refresh 的响应（inventory 本体，无包裹层）。 */
export type ModelInventoryResponse = ModelInventory;

export interface ModelInventory {
  providers: ProviderInventoryEntry[];
  models: ModelInventoryEntry[];
  plugins: ModelPluginDescriptor[];
  policyRules: ModelPolicyRuleEntry[];
  diagnostics: RuntimeModelDiagnostic[];
  summary: {
    modelCount: number;
    policyAllowedCount: number;
    availableCount: number;
    unavailableCount: number;
    unknownCount: number;
  };
}

/** 写入类端点的统一确认结果：ok:true 表示写入已成功（含备份）。 */
export interface MutationResult {
  ok: true;
  backupId: string;
  diagnostics?: RuntimeModelDiagnostic[];
}

/** PATCH /api/plugins/:pluginId/state 的响应：写入成功但运行时确认失败时 runtimeConfirmed=false（非 HTTP 失败）。 */
export interface PluginStateMutationResult extends MutationResult {
  pluginId: string;
  enabled: boolean;
  affectedProviderIds: string[];
  warnings: string[];
  runtimeConfirmed: boolean;
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
    getProviderSecretRefMigrations: () =>
      request<ProviderSecretRefMigrationPreview>("/api/providers/secret-ref-migrations"),
    migrateProviderSecretRefs: (providerIds: string[]) =>
      request<{ ok: boolean; migratedProviderIds: string[]; backupId?: string; gatewayRestartRequired: boolean }>(
        "/api/providers/secret-ref-migrations",
        {
          method: "POST",
          body: JSON.stringify({ providerIds, confirm: true })
        }
      ),
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
    syncProviderModelMetadata: (id: string, body: { modelIds?: string[] }) =>
      request<SyncModelMetadataResponse>(`/api/providers/${id}/models/sync-metadata`, {
        method: "POST",
        body: JSON.stringify(body)
      }),
    getModelMetadataSyncQueue: (providerId?: string) => {
      const params = new URLSearchParams();
      if (providerId) params.set("providerId", providerId);
      const suffix = params.toString();
      return request<ModelMetadataSyncQueueResponse>(`/api/model-metadata/sync-queue${suffix ? `?${suffix}` : ""}`);
    },
    resolveModelMetadataSyncQueue: (items: ModelMetadataQueueResolveItem[]) =>
      request<ModelMetadataQueueResolveResponse>("/api/model-metadata/sync-queue/resolve", {
        method: "POST",
        body: JSON.stringify({ items })
      }),
    /** GET /api/model-inventory：读取统一模型/Provider inventory（只读，无写盘） */
    getModelInventory: () => request<ModelInventoryResponse>("/api/model-inventory"),
    /** POST /api/model-inventory/refresh：强制重探测，返回刷新后的完整 inventory */
    refreshModelInventory: () => request<ModelInventoryResponse>("/api/model-inventory/refresh", {
      method: "POST"
    }),
    /** DELETE /api/model-policy/exact-ref：移除 policy 精确引用（removeMetadata 决定是否连带 legacy metadata） */
    removeModelPolicyExactRef: (ref: string, removeMetadata: boolean) =>
      request<MutationResult>("/api/model-policy/exact-ref", {
        method: "DELETE",
        body: JSON.stringify({ ref, removeMetadata })
      }),
    /** POST /api/models/materialize：把运行时可用模型补全为 config Provider 目录项 */
    materializeRuntimeModel: (ref: string, input: ProviderModelInput & { enabled: boolean }) =>
      request<MutationResult>("/api/models/materialize", {
        method: "POST",
        body: JSON.stringify({ ref, input })
      }),
    /** PATCH /api/plugins/:pluginId/state：插件级启停（confirm 恒为 true；runtimeConfirmed:false 不是失败） */
    setPluginState: (pluginId: string, enabled: boolean) =>
      request<PluginStateMutationResult>(`/api/plugins/${encodeURIComponent(pluginId)}/state`, {
        method: "PATCH",
        body: JSON.stringify({ enabled, confirm: true })
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
