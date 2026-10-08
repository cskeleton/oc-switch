import { runtimeConfirmationIssue } from "../api";
import { OperationProgress } from "../components/OperationProgress";
import { inventoryFromWriteResponse, type PluginExtensionsSnapshot } from "../api";
import { ModelAttentionPanel } from "../components/ModelAttentionPanel";
import { Cpu, Edit3, KeyRound, ListChecks, MoreHorizontal, Plus, Power, PowerOff, RefreshCw, Search, Sparkles, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GatewayApplyBanner } from "../components/GatewayApplyBanner";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CustomProviderDialog } from "../components/CustomProviderDialog";
import { DataTable } from "../components/DataTable";
import { EnvMigrationConfirmDialog } from "../components/EnvMigrationConfirmDialog";
import { LoadingNotice } from "../components/LoadingNotice";
import { MergeCaseDuplicateDialog } from "../components/MergeCaseDuplicateDialog";
import { ModelMetadataQueueDialog } from "../components/ModelMetadataQueueDialog";
import { PluginProviderGroup } from "../components/PluginProviderGroup";
import { PageHeader } from "../components/PageHeader";
import { CATALOG_SOURCE_LABELS, AVAILABILITY_REASON_LABELS } from "../components/ModelStateBadges";
import { ProviderDiscoverDialog } from "../components/ProviderDiscoverDialog";
import { ProviderModelsDialog } from "../components/ProviderModelsDialog";
import { useToast } from "../components/Toast";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "../components/ui/dropdown-menu";
import { Input } from "../components/ui/input";
import { Pill } from "../components/ui/pill";
import { formatEnvWriteSuccess } from "../env-feedback";
import { cn } from "../lib/utils";
import type {
  ApiClient,
  ApiType,
  CaseDuplicateGroup,
  EnvWriteVerification,
  GatewayEnvSyncResult,
  ModelAttentionReport,
  ModelInventory,
  ModelSummary,
  ProviderSecretRefMigrationBlocker,
  ProviderSecretRefMigrationPreview,
  ProviderSummary
} from "../api";

const EDITABLE_API_TYPES: ApiType[] = [
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai"
];

function isEditableApiType(value: string): value is ApiType {
  return EDITABLE_API_TYPES.includes(value as ApiType);
}

/**
 * 插件 Provider 只读接入的既有提示（模型目录来自 manifest，不写 openclaw.json）。
 * 插件启停改由 inventory 驱动的 PluginProviderGroup 展示，不与 Provider 可逆关闭混用。
 */
const PLUGIN_READONLY_HINT = "插件 provider 目录只读，请在 OpenClaw 插件侧调整";
const PLUGIN_STATE_HINT = "插件启停由 OpenClaw 的 plugins.entries 控制，请使用插件组的总开关";

interface ProvidersViewProps {
  client: ApiClient;
  onOpenSettings?: () => void;
  onOpenModels?: () => void;
  requestedProviderId?: string | undefined;
  onRequestHandled?: (() => void) | undefined;
}

/** Provider 列表与管理：搜索 + 排序（已关闭沉底）+ 操作收敛为 2+1；插件 Provider 按插件分组展示 */
export function ProvidersView({ client, onOpenSettings, onOpenModels, requestedProviderId, onRequestHandled }: ProvidersViewProps) {
  const toast = useToast();
  const [staticReady, setStaticReady] = useState(false);
  const [extensions, setExtensions] = useState<PluginExtensionsSnapshot | null>(null);
  const [extensionsLoading, setExtensionsLoading] = useState(false);
  const [extensionsError, setExtensionsError] = useState<string | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [onlinePending, setOnlinePending] = useState(false);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  /** 统一 inventory 是状态事实来源；请求失败明确报错，不回落为旧插件语义。 */
  const [inventory, setInventory] = useState<ModelInventory | null>(null);
  const [duplicateGroups, setDuplicateGroups] = useState<CaseDuplicateGroup[]>([]);
  const [mergeTarget, setMergeTarget] = useState<CaseDuplicateGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 一轮加载是否进行中；首轮（inventory 尚未取得）据此展示加载提示 */
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"active" | "disabled" | "all">("active");
  const manageCatalog = scope === "all";
  const showDisabledPlugins = scope !== "active";
  const [focusedPlugin, setFocusedPlugin] = useState<string | null>(null);
  const [cleanupMetadata, setCleanupMetadata] = useState(false);
  const [stateNotice, setStateNotice] = useState<string | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProviderSummary | null>(null);
  /** 删除 Provider 时显式勾选才移除其 policy wildcard 条目（默认保留为悬空规则） */
  const [removePolicyWildcard, setRemovePolicyWildcard] = useState(false);
  const [editTarget, setEditTarget] = useState<ProviderSummary | null>(null);
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editApi, setEditApi] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [editError, setEditError] = useState<string | null>(null);
  const [newPrimaryCandidates, setNewPrimaryCandidates] = useState<ModelSummary[]>([]);
  const [selectedNewPrimary, setSelectedNewPrimary] = useState("");
  const [gatewayApply, setGatewayApply] = useState<{
    envWrite: EnvWriteVerification;
    gatewayEnvSync?: GatewayEnvSyncResult;
  } | null>(null);
  const [modelTarget, setModelTarget] = useState<ProviderSummary | null>(null);
  const [discoverTarget, setDiscoverTarget] = useState<ProviderSummary | null>(null);
  const [queueTarget, setQueueTarget] = useState<ProviderSummary | null>(null);
  /** 各 Provider 参数待确认队列计数（只计未忽略项；加载失败静默为空） */
  const [queueCounts, setQueueCounts] = useState<Record<string, number>>({});
  const [stateTarget, setStateTarget] = useState<ProviderSummary | null>(null);
  const [pendingEnvConfirm, setPendingEnvConfirm] = useState<{
    /** provider = 走 PATCH /api/providers/:id；plugin-key = 只走 .env upsert */
    kind: "provider" | "plugin-key";
    providerId: string;
    changes: { baseUrl?: string; api?: ApiType; apiKey?: string };
    warnings: string[];
    confirmMigration?: boolean;
    confirmComplex?: boolean;
  } | null>(null);
  const [secretRefMigrations, setSecretRefMigrations] = useState<ProviderSecretRefMigrationPreview | null>(null);
  const [showSecretRefMigration, setShowSecretRefMigration] = useState(false);
  /** 插件 provider 的 API Key 设置（直接走 .env 托管块 upsert，不碰 models.providers） */
  const [pluginKeyTarget, setPluginKeyTarget] = useState<ProviderSummary | null>(null);
  const [pluginKeyValue, setPluginKeyValue] = useState("");
  const [pluginKeyError, setPluginKeyError] = useState<string | null>(null);
  /** 问题报告由本页统一读取（每轮一次），面板只消费 report 与事件回调 */
  const [attention, setAttention] = useState<ModelAttentionReport>({ pending: [], ignored: [] });
  const [attentionError, setAttentionError] = useState<string | null>(null);
  /** 可选辅助读取（健康检查 / SecretRef 迁移预览 / 参数确认队列）失败信息：独立展示「未取得」，不假装成 0 项 */
  const [auxErrors, setAuxErrors] = useState<{ health?: string; migrations?: string; queue?: string }>({});

  /**
   * 本页是写后刷新的唯一责任方：一轮并行读取全部必要端点。
   * presetInventory 用于消费「写响应 / 显式重探测」已取得的 inventory，避免重复 GET。
   * 每轮携带递增序号，迟到的旧响应不得覆盖更新的页面结果。
   */
  const loadSeq = useRef(0);
  const loadStatic = useCallback(async (seq: number) => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await client.getModelConfig();
      if (seq !== loadSeq.current) return;
      setProviders(snapshot.providers);
      setStaticReady(true);
    } catch (err) {
      if (seq === loadSeq.current) setError(err instanceof Error ? err.message : "本地配置读取失败");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    void (async () => {
      const results = await Promise.allSettled([client.getHealth(), client.getProviderSecretRefMigrations(), client.getModelMetadataSyncQueue()]);
      if (seq !== loadSeq.current) return;
      const [health, migrations, queue] = results;
      const message = (result: PromiseSettledResult<unknown>) => result.status === "rejected" ? (result.reason instanceof Error ? result.reason.message : "读取失败") : undefined;
      setAuxErrors({ ...(message(health) ? { health: message(health)! } : {}), ...(message(migrations) ? { migrations: message(migrations)! } : {}), ...(message(queue) ? { queue: message(queue)! } : {}) });
      setDuplicateGroups(health.status === "fulfilled" ? health.value.caseDuplicateGroups ?? [] : []);
      setSecretRefMigrations(migrations.status === "fulfilled" && migrations.value.summary && Array.isArray(migrations.value.candidates) ? migrations.value : null);
      const counts: Record<string, number> = {};
      if (queue.status === "fulfilled" && Array.isArray(queue.value.items)) for (const item of queue.value.items) {
        if (!item.dismissed) { const key = item.providerId.toLowerCase(); counts[key] = (counts[key] ?? 0) + 1; }
      }
      setQueueCounts(counts);
    })();
  }, [client]);
  const loadExtensions = useCallback(async (seq: number) => {
    setExtensionsLoading(true);
    setExtensionsError(null);
    try {
      const next = await client.getModelExtensions();
      if (seq === loadSeq.current) setExtensions(next);
    } catch (err) {
      if (seq === loadSeq.current) setExtensionsError(err instanceof Error ? err.message : "插件目录读取失败");
    } finally { if (seq === loadSeq.current) setExtensionsLoading(false); }
  }, [client]);
  const loadRuntime = useCallback(async (seq: number, preset?: ModelInventory, force = false) => {
    setRuntimeLoading(true);
    setRuntimeError(null);
    try {
      const next = preset ?? await (force ? client.refreshModelInventory() : client.getModelInventory());
      if (seq !== loadSeq.current) return;
      setInventory(next);
      setStateNotice(null);
      const confirmationIssue = runtimeConfirmationIssue(next);
      setOnlinePending(confirmationIssue !== null);
      setRuntimeError(confirmationIssue);
      const report = await client.getModelAttention().catch(err => { if (seq === loadSeq.current) setAttentionError(err instanceof Error ? err.message : "无法读取问题状态"); return null; });
      if (!report) return;
      if (seq !== loadSeq.current) return;
      if (Array.isArray(report.pending) && Array.isArray(report.ignored)) { setAttention(report); setAttentionError(null); }
      else setAttentionError("提醒协议不兼容，请重启服务。");
    } catch (err) {
      if (seq === loadSeq.current) setRuntimeError(err instanceof Error ? err.message : "运行时状态未确认");
    } finally { if (seq === loadSeq.current) setRuntimeLoading(false); }
  }, [client]);
  const load = useCallback(async (_propagateError = false, preset?: ModelInventory) => {
    const seq = ++loadSeq.current;
    await Promise.all([loadStatic(seq), loadExtensions(seq), loadRuntime(seq, preset)]);
  }, [loadStatic, loadExtensions, loadRuntime]);
  const saved = useCallback(async (result?: unknown, preserveRuntime = false) => {
    const seq = ++loadSeq.current;
    const next = inventoryFromWriteResponse(result && typeof result === "object" ? result : {});
    setInventory(previous => next ?? (preserveRuntime ? previous : null));
    if (result && typeof result === "object" && "pluginId" in result && "enabled" in result && typeof result.pluginId === "string" && typeof result.enabled === "boolean") {
      const { pluginId, enabled } = result;
      setExtensions(previous => previous ? { ...previous, plugins: previous.plugins.map(plugin => plugin.id === pluginId ? { ...plugin, enabled } : plugin), providers: previous.providers.map(provider => provider.pluginId === pluginId ? { ...provider, enabled } : provider) } : previous);
    }
    setRuntimeLoading(false);
    setExtensionsLoading(false);
    if (!preserveRuntime) setAttention({ pending: [], ignored: [] });
    setAttentionError(null);
    setRuntimeError(null);
    setOnlinePending(!next);
    setStateNotice(next ? "本地配置已保存" : "本地配置已保存，在线状态待确认");
    await loadStatic(seq);
    if (next) await loadRuntime(seq, next);
  }, [loadStatic, loadRuntime]);
  async function checkRuntime() {
    if (checking || saving) return;
    setChecking(true);
    const seq = ++loadSeq.current;
    try { await Promise.all([loadStatic(seq), loadExtensions(seq), loadRuntime(seq, undefined, true)]); }
    finally { if (seq === loadSeq.current) setChecking(false); }
  }

  const groupByProviderId = useMemo(() => {
    const map = new Map<string, CaseDuplicateGroup>();
    for (const group of duplicateGroups) for (const id of group.ids) map.set(id, group);
    return map;
  }, [duplicateGroups]);

  // config 表保留连接信息 CRUD；运行时来源和插件贡献关系只消费 inventory。
  const allPluginGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (inventory?.plugins ?? extensions?.plugins ?? []).filter(plugin => plugin.providerIds.length > 0).map(plugin => ({
      plugin,
      // 同名 config Provider 也必须出现在插件组和停用影响面中。
      providers: (inventory?.providers ?? []).filter(provider => provider.pluginIds.includes(plugin.id)),
      extensions: (extensions?.providers ?? []).filter(provider => provider.pluginId === plugin.id),
      models: (inventory?.models ?? []).filter(model => plugin.providerIds.some(id => id.toLowerCase() === model.providerId.toLowerCase()))
    })).filter(group => !q || [group.plugin.id, group.plugin.name ?? "", ...group.plugin.providerIds].some(value => value.toLowerCase().includes(q)));
  }, [inventory, extensions, query]);

  // 有效使用 = 插件启用且至少一个 Provider 未被 oc-switch 关闭。
  // 插件启用但 Provider 已关闭（如 nvidia）不算「当前使用」，避免与 IM 实际可见性矛盾。
  const isPluginGroupActive = (group: (typeof allPluginGroups)[number]): boolean =>
    group.plugin.enabled && (group.providers.length > 0 ? group.providers.some(provider => !provider.disabled) : group.plugin.providerIds.some(id => !providers.find(provider => provider.id.toLowerCase() === id.toLowerCase())?.disabled));

  const pluginGroups = useMemo(
    () => allPluginGroups.filter(group => scope === "all" || (scope === "disabled" ? !isPluginGroupActive(group) : isPluginGroupActive(group))),
    [allPluginGroups, scope]
  );

  const filteredProviders = useMemo(() => {
    const q = query.trim().toLowerCase();
    return providers.filter(row => row.source === "config" && (scope === "all" || (scope === "disabled" ? row.disabled : !row.disabled)) &&
      (!q || row.id.toLowerCase().includes(q) || (row.baseUrl ?? "").toLowerCase().includes(q)));
  }, [providers, query, pluginGroups, scope]);

  const disabledCount = useMemo(() => {
    const disabledGroups = allPluginGroups.filter(group => !isPluginGroupActive(group));
    const disabledGroupOwners = new Set(disabledGroups.flatMap(group => group.plugin.providerIds.map(id => id.toLowerCase())));
    return disabledGroups.length + providers.filter(provider => provider.source === "config" && provider.disabled && !disabledGroupOwners.has(provider.id.toLowerCase())).length;
  }, [allPluginGroups, providers]);
  const inventoryProviders = useMemo(() => new Map((inventory?.providers ?? []).map(provider => [provider.providerId.toLowerCase(), provider])), [inventory]);
  const runtimeProviders = (inventory?.providers ?? []).filter(provider => scope !== "disabled" && !provider.sources.includes("config") && provider.pluginIds.length === 0 && (manageCatalog || (provider.pickerModelCount ?? 0) > 0) &&
    (!query.trim() || provider.providerId.toLowerCase().includes(query.trim().toLowerCase())));


  /** 插件 Provider 的 API Key 环境变量名：来自独立 extensions 的 manifest 声明（inventory DTO 不含密钥字段） */
  const pluginApiKeyEnv = useCallback((providerId: string): string | null => {
    const match = extensions?.providers.find(provider => provider.providerId.toLowerCase() === providerId.toLowerCase());
    return match?.apiKeyEnvVars[0] ?? null;
  }, [extensions]);

  useEffect(() => {
    void load();
    return () => { loadSeq.current += 1; };
  }, [load]);

  function configureProvider(id: string) {
    const row = providers.find(p => p.id.toLowerCase() === id.toLowerCase());
    setScope("all");
    const owner = (inventory?.plugins ?? extensions?.plugins ?? []).find(p => p.providerIds.some(providerId => providerId.toLowerCase() === id.toLowerCase()));
    setFocusedPlugin(owner?.id ?? null);
    if (row?.source === "config") openEdit(row);
    else if (row?.apiKeyEnv) openPluginKey(row);
    else if (pluginApiKeyEnv(id)) {
      const declared = extensions?.providers.find(provider => provider.providerId.toLowerCase() === id.toLowerCase());
      openPluginKey({ id, source: "plugin", api: declared?.api, baseUrl: declared?.baseUrl, disabled: declared?.enabled === false, containsPrimary: false, modelCount: declared?.models.length ?? 0, enabledModelCount: 0, apiKeyEnv: pluginApiKeyEnv(id), apiKeyEnvManaged: false, apiKeyEnvStatus: "missing" });
    }
    else if (owner) setStateNotice(`${id} 未声明可编辑的 API Key，请使用 OpenClaw 的认证入口；也可在本页停用该插件或忽略非关键提示。`);
    else { setRepairProviderId(id); setRepairModelId(inventory?.models.find(m => m.providerId.toLowerCase() === id.toLowerCase())?.modelId); setAddingProvider(true); }
  }
  const [repairModelId, setRepairModelId] = useState<string | undefined>();
  const [repairProviderId, setRepairProviderId] = useState<string | undefined>();
  useEffect(() => {
    if (!requestedProviderId || !staticReady) return;
    // 配置 Provider 可立即编辑；非配置目标先等独立插件目录，避免误开新增表单。
    if (!providers.some(provider => provider.id.toLowerCase() === requestedProviderId.toLowerCase()) && extensionsLoading) return;
    configureProvider(requestedProviderId);
    onRequestHandled?.();
  }, [requestedProviderId, staticReady, inventory, providers, extensions, extensionsLoading]);

  async function openDelete(row: ProviderSummary) {
    setError(null);
    setDeleteTarget(row);
    setRemovePolicyWildcard(false);
    setNewPrimaryCandidates([]);
    setSelectedNewPrimary("");
    if (!row.containsPrimary) return;
    try {
      const { models } = await client.getModelConfig();
      const candidates = models.filter((model) => model.providerId !== row.id);
      setNewPrimaryCandidates(candidates);
      setSelectedNewPrimary(candidates[0]?.ref ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载可选主模型失败");
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    if (deleteTarget.containsPrimary && !selectedNewPrimary) {
      toast.error("删除包含 primary 的 Provider 前请选择新的主模型");
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      const result = await client.deleteProvider(deleteTarget.id, {
        ...(deleteTarget.containsPrimary ? { newPrimary: selectedNewPrimary } : {}),
        ...(removePolicyWildcard ? { removePolicyWildcard: true } : {})
      });
      setDeleteTarget(null);
      setRemovePolicyWildcard(false);
      setNewPrimaryCandidates([]);
      setSelectedNewPrimary("");
      toast.success(`Provider ${deleteTarget.id} 已删除`);
      for (const warning of result.warnings ?? []) toast.warning(warning);
      await saved(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除失败");
      setDeleteTarget(null);
      setRemovePolicyWildcard(false);
    } finally { setSaving(false); }
  }

  function openEdit(row: ProviderSummary) {
    setError(null);
    setEditError(null);
    setEditTarget(row);
    setEditBaseUrl(row.baseUrl ?? "");
    setEditApi(row.api ?? "openai-completions");
    setEditApiKey("");
  }

  function closeEdit() {
    setEditTarget(null);
    setEditApi("");
    setEditApiKey("");
    setEditError(null);
  }

  function showGatewayApply(result: { envWrite?: EnvWriteVerification | undefined; gatewayEnvSync?: GatewayEnvSyncResult }) {
    if (!result.envWrite?.verified) {
      setGatewayApply(null);
      return;
    }
    setGatewayApply({
      envWrite: result.envWrite,
      ...(result.gatewayEnvSync ? { gatewayEnvSync: result.gatewayEnvSync } : {})
    });
  }

  async function submitProviderUpdate(providerId: string, changes: { baseUrl?: string; api?: ApiType; apiKey?: string; confirmMigration?: boolean; confirmComplex?: boolean }) {
    const result = await client.updateProvider(providerId, changes);
    closeEdit();
    setPendingEnvConfirm(null);
    if (changes.apiKey) {
      toast.success(formatEnvWriteSuccess({
        label: `Provider ${providerId} 的 API Key`,
        envWrite: result.envWrite,
        gatewayEnvSync: result.gatewayEnvSync,
        fallback: changes.confirmMigration
          ? `Provider ${providerId} 的 API Key 已迁入托管块并更新`
          : changes.confirmComplex
            ? `Provider ${providerId} 的 API Key 已改写为标准格式并更新`
            : `Provider ${providerId} 的 API Key 已更新`
      }));
      showGatewayApply(result);
    } else {
      setGatewayApply(null);
      toast.success(`Provider ${providerId} 已更新`);
    }
    await saved(result);
  }

  async function confirmEdit() {
    if (!editTarget) return;
    const changes: { baseUrl?: string; api?: ApiType; apiKey?: string } = {};
    const nextBaseUrl = editBaseUrl.trim();
    if (nextBaseUrl) changes.baseUrl = nextBaseUrl;
    const currentApi = editTarget.api ?? "openai-completions";
    if (editApi !== currentApi) {
      if (!isEditableApiType(editApi)) {
        setEditError("请选择支持的 API 类型");
        return;
      }
      changes.api = editApi;
    }
    if (editApiKey) changes.apiKey = editApiKey;
    if (!changes.baseUrl && !changes.api && !changes.apiKey) {
      setEditError("请输入 baseUrl、API 类型或 API Key 新值");
      return;
    }
    setEditError(null);
    if (saving) return;
    setSaving(true);
    try {
      if (changes.apiKey) {
        const preview = await client.previewUpdateProvider(editTarget.id, {
          ...(changes.baseUrl ? { baseUrl: changes.baseUrl } : {}),
          ...(changes.api ? { api: changes.api } : {}),
          includeApiKeyEnv: true
        });
        const envPreview = preview.envPreview;
        if (envPreview?.requiresConfirmation) {
          setPendingEnvConfirm({
            kind: "provider",
            providerId: editTarget.id,
            changes,
            warnings: envPreview.warnings,
            ...(envPreview.requiresMigration ? { confirmMigration: true } : {}),
            ...(envPreview.requiresComplex ? { confirmComplex: true } : {})
          });
          return;
        }
      }
      await submitProviderUpdate(editTarget.id, changes);
    } catch (err) {
      // 表单内错误留在弹窗中展示
      setEditError(err instanceof Error ? err.message : "保存失败");
    } finally { setSaving(false); }
  }

  async function confirmEnvMigration() {
    if (!pendingEnvConfirm) return;
    setError(null);
    const flags = {
      ...(pendingEnvConfirm.confirmMigration ? { confirmMigration: true } : {}),
      ...(pendingEnvConfirm.confirmComplex ? { confirmComplex: true } : {})
    };
    if (pendingEnvConfirm.kind === "plugin-key") {
      await confirmPluginKey(flags);
      return;
    }
    if (saving) return;
    setSaving(true);
    try {
      await submitProviderUpdate(pendingEnvConfirm.providerId, {
        ...pendingEnvConfirm.changes,
        ...flags
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "保存失败");
      setPendingEnvConfirm(null);
    } finally { setSaving(false); }
  }

  async function runSyncMetadata(row: ProviderSummary) {
    if (saving) return;
    setSaving(true);
    try {
      const result = await client.syncProviderModelMetadata(row.id, {});
      toast.success(`已回填 ${result.updated.length}，待确认 ${result.queued.length}，未匹配 ${result.unmatched.length}，齐全跳过 ${result.skipped.length}`);
      // 参数同步不改变模型身份或选择规则；保留上次在线视图，避免插件组切回静态表格。
      await saved(result, true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "同步参数失败");
    } finally { setSaving(false); }
  }

  async function confirmProviderStateChange() {
    if (!stateTarget) return;
    setError(null);
    if (saving) return;
    setSaving(true);
    try {
      // stateTarget.disabled 为 true 时恢复（enabled: true），为 false 时关闭（enabled: false）
      const result = cleanupMetadata ? await client.patchProviderState(stateTarget.id, stateTarget.disabled, true) : await client.patchProviderState(stateTarget.id, stateTarget.disabled);
      setStateNotice(result.runtimeConfirmed === false ? "配置已保存；尚未确认 Gateway 已应用。请刷新，或到设置中应用 Gateway 配置。" : null);
      setStateTarget(null);
      toast.success(stateTarget.disabled ? `Provider ${stateTarget.id} 已恢复` : `Provider ${stateTarget.id} 已关闭`);
      await saved(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新 Provider 状态失败");
      setStateTarget(null);
    } finally { setSaving(false); }
  }

  function openPluginKey(row: ProviderSummary) {
    setError(null);
    setPluginKeyError(null);
    setPluginKeyValue("");
    setPluginKeyTarget(row);
  }

  function closePluginKey() {
    setPluginKeyTarget(null);
    setPluginKeyValue("");
    setPluginKeyError(null);
  }

  /** 写插件 provider 的 API Key：只 upsert manifest 声明的环境变量，不写 openclaw.json */
  async function confirmPluginKey(flags: { confirmMigration?: boolean; confirmComplex?: boolean } = {}) {
    if (!pluginKeyTarget?.apiKeyEnv) return;
    const envVar = pluginKeyTarget.apiKeyEnv;
    const value = pluginKeyValue;
    if (!value) {
      setPluginKeyError("请输入 API Key");
      return;
    }
    setPluginKeyError(null);
    if (saving) return;
    setSaving(true);
    try {
      const preview = await client.previewEnvVar({ type: "upsert", envVar });
      if (preview.requiresConfirmation && !flags.confirmMigration && !flags.confirmComplex) {
        setPendingEnvConfirm({
          kind: "plugin-key",
          providerId: pluginKeyTarget.id,
          changes: { apiKey: value },
          warnings: preview.warnings,
          ...(preview.requiresMigration ? { confirmMigration: true } : {}),
          ...(preview.requiresComplex ? { confirmComplex: true } : {})
        });
        return;
      }
      const result = await client.updateEnvVar({
        type: "upsert",
        envVar,
        value,
        note: `plugin provider ${pluginKeyTarget.id}`,
        ...flags
      });
      const providerId = pluginKeyTarget.id;
      closePluginKey();
      setPendingEnvConfirm(null);
      toast.success(formatEnvWriteSuccess({
        label: `Provider ${providerId} 的 API Key`,
        envWrite: result.envWrite,
        gatewayEnvSync: result.gatewayEnvSync,
        fallback: `Provider ${providerId} 的 API Key 已写入 ${envVar}`
      }));
      showGatewayApply(result);
      await saved(result);
    } catch (err) {
      // 迁移确认分支失败时必须一并关掉确认框，否则错误被盖在弹窗下面看不到
      setPendingEnvConfirm(null);
      setPluginKeyError(err instanceof Error ? err.message : "保存失败");
    } finally { setSaving(false); }
  }

  async function confirmSecretRefMigration() {
    const providerIds = secretRefMigrations?.candidates
      .filter((candidate) => candidate.status === "ready")
      .map((candidate) => candidate.providerId) ?? [];
    if (providerIds.length === 0) return;
    setError(null);
    if (saving) return;
    setSaving(true);
    try {
      const result = await client.migrateProviderSecretRefs(providerIds);
      setShowSecretRefMigration(false);
      toast.success(
        `已将 ${result.migratedProviderIds.length} 个 Provider API Key 引用迁移为 SecretRef；请重启 Gateway 使运行时快照生效。`
      );
      await saved(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "SecretRef 迁移失败");
      setShowSecretRefMigration(false);
    } finally { setSaving(false); }
  }

  function secretRefBlockerLabel(blocker: ProviderSecretRefMigrationBlocker): string {
    switch (blocker) {
      case "source-env-missing": return ".env 中缺少变量";
      case "source-env-empty": return ".env 中的变量为空";
      case "source-env-duplicate": return ".env 中存在重复变量";
      case "source-env-complex": return ".env 值是复杂表达式";
      case "gateway-target-unavailable": return "无法确认 Gateway 服务环境";
      case "gateway-env-drift": return "Gateway 服务环境中的值与 .env 不一致";
    }
  }

  const renderProviderActions = (row: ProviderSummary) => {
              // 插件 provider 目录只读：编辑 / 增删模型 / 同步参数 / 删除 / 关闭恢复一律禁用
              const isPlugin = row.source === "plugin";
              return (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`管理模型 ${row.id}`}
                    title="模型"
                    onClick={() => setModelTarget(row)}
                  >
                    <Cpu className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${row.disabled ? "恢复" : "关闭"} Provider ${row.id}`}
                    disabled={saving || isPlugin || (!row.disabled && row.containsPrimary)}
                    title={
                      isPlugin
                        ? PLUGIN_STATE_HINT
                        : !row.disabled && row.containsPrimary
                          ? "该 Provider 包含当前主模型，请先切换主模型后再关闭"
                          : row.disabled ? "恢复" : "关闭"
                    }
                    onClick={() => { setCleanupMetadata(false); setStateTarget(row); }}
                  >
                    {row.disabled ? <Power className="h-4 w-4" /> : <PowerOff className="h-4 w-4" />}
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" aria-label={`更多操作 ${row.id}`}>
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {row.disabled && (inventoryProviders.get(row.id.toLowerCase())?.pickerModelCount ?? 0) > 0 ? (
                        <DropdownMenuItem disabled={row.containsPrimary} onClick={() => { setCleanupMetadata(false); setStateTarget({ ...row, disabled: false }); }}>移出残留模型选项</DropdownMenuItem>
                      ) : null}
                      {isPlugin ? (
                        <DropdownMenuItem
                          aria-label={`设置 Key ${row.id}`}
                          disabled={!row.apiKeyEnv}
                          onSelect={() => openPluginKey(row)}
                        >
                          <KeyRound className="mr-2 h-3.5 w-3.5" />
                          设置 Key{row.apiKeyEnv ? ` (${row.apiKeyEnv})` : "（插件未声明环境变量）"}
                        </DropdownMenuItem>
                      ) : null}
                      <DropdownMenuItem
                        aria-label={`编辑 ${row.id}`}
                        disabled={isPlugin}
                        onSelect={() => openEdit(row)}
                      >
                        <Edit3 className="mr-2 h-3.5 w-3.5" />
                        编辑
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        aria-label={`发现模型 ${row.id}`}
                        disabled={isPlugin}
                        onSelect={() => setDiscoverTarget(row)}
                      >
                        <Search className="mr-2 h-3.5 w-3.5" />
                        发现模型
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        aria-label={`同步参数 ${row.id}`}
                        disabled={isPlugin}
                        onSelect={() => void runSyncMetadata(row)}
                      >
                        <Sparkles className="mr-2 h-3.5 w-3.5" />
                        同步参数
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        aria-label={`参数待确认 ${row.id}`}
                        disabled={isPlugin || (queueCounts[row.id.toLowerCase()] ?? 0) === 0}
                        onSelect={() => setQueueTarget(row)}
                      >
                        <ListChecks className="mr-2 h-3.5 w-3.5" />
                        参数待确认{queueCounts[row.id.toLowerCase()] ? ` (${queueCounts[row.id.toLowerCase()]})` : ""}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        aria-label={`删除 ${row.id}`}
                        disabled={isPlugin}
                        className="text-destructive focus:bg-destructive/10 focus:text-destructive"
                        onSelect={() => void openDelete(row)}
                      >
                        <Trash2 className="mr-2 h-3.5 w-3.5" />
                        删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              );
            };

  return (
    <section data-testid="providers-view">
      <PageHeader
        title="服务商"
        description="管理模型服务商（Provider）的连接与 API 密钥"
        actions={
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="搜索 Provider"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索 ID / Base URL"
                className="h-8 w-44 pl-8 text-xs sm:w-52"
              />
            </div>
            <Button size="sm" onClick={() => { setRepairProviderId(undefined); setRepairModelId(undefined); setAddingProvider(true); }}>
              <Plus className="h-4 w-4" />
              添加 Provider
            </Button>
            <Button variant="outline" size="sm" disabled={checking || saving} onClick={() => void checkRuntime()}>{checking ? "检查中…" : "检查并确认"}</Button>
            <Button variant="outline" disabled={loading || saving || checking} size="icon" aria-label="刷新" title={loading ? "正在加载…" : undefined} onClick={() => void load()}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
            </Button>
          </>
        }
      />

      <div className="mb-3 space-y-2">
        <OperationProgress phase={saving ? "saving" : runtimeLoading ? "checking-runtime" : onlinePending ? "partial" : runtimeError ? "error" : inventory ? "success" : "idle"} message={!saving && !runtimeLoading && runtimeError ? `运行时未确认：${runtimeError}` : undefined} />
        <OperationProgress phase={extensionsLoading ? "loading-plugin" : extensionsError ? "error" : "idle"} message={extensionsError ? `插件目录未取得：${extensionsError}` : undefined} />
        {extensions?.diagnostics.length ? <p className="text-xs text-warning">插件目录提示：{extensions.diagnostics.join("；")}</p> : null}
      </div>
      {error ? <p role="alert" className="mb-3 text-sm text-destructive">{error}</p> : null}
      {stateNotice ? <p role="status" className="mb-3 text-sm text-warning">{stateNotice}</p> : null}
      {/* 可选辅助读取失败：明示「未取得」并提供重试，不阻塞主列表、不假装成 0 项 */}
      {Object.keys(auxErrors).length > 0 ? (
        <div role="status" className="mb-3 flex flex-wrap items-center gap-2 rounded-md border border-warning/30 bg-warning/[0.06] px-3 py-2 text-xs text-warning">
          <span>
            部分信息未取得：
            {[
              auxErrors.health ? "Provider 健康检查" : null,
              auxErrors.migrations ? "SecretRef 迁移预览" : null,
              auxErrors.queue ? "参数确认队列" : null
            ].filter(Boolean).join("、")}
            ，相关计数与提示暂不可用。
          </span>
          <Button variant="outline" size="sm" aria-label="重试辅助信息" onClick={() => void load()}>重试</Button>
        </div>
      ) : null}
      {/* 范围分段控件：当前使用 / 已停用 / 全部配置 */}
      <div role="tablist" aria-label="Provider 范围" className="mb-4 inline-flex w-full items-center gap-1 rounded-lg bg-muted p-1 sm:w-auto">
        {([['active', '当前使用'], ['disabled', `已停用 (${disabledCount})`], ['all', '全部配置']] as const).map(([value, label]) => (
          <button
            type="button"
            role="tab"
            aria-selected={scope === value}
            key={value}
            onClick={() => { setScope(value); setFocusedPlugin(null); }}
            className={cn(
              "flex-1 rounded-md px-3 py-1.5 text-xs font-medium transition-colors sm:flex-none",
              scope === value
                ? "bg-card text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground"
            )}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="mb-3"><ModelAttentionPanel client={client} inventory={inventory} report={attention} onReport={setAttention} onSaved={async (result) => { await saved(result); }} loadError={attentionError} onChanged={(next) => load(false, next)} onConfigure={configureProvider} /></div>
      {gatewayApply ? (
        <GatewayApplyBanner
          client={client}
          envWrite={gatewayApply.envWrite}
          {...(gatewayApply.gatewayEnvSync ? { gatewayEnvSync: gatewayApply.gatewayEnvSync } : {})}
          onDismiss={() => setGatewayApply(null)}
        />
      ) : null}
      {secretRefMigrations && secretRefMigrations.summary.candidateCount > 0 ? (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/30 bg-warning/[0.06] px-4 py-3 text-sm">
          <div>
            <p className="font-medium text-foreground">
              发现 {secretRefMigrations.summary.candidateCount} 个旧环境变量引用
            </p>
            <p className="text-muted-foreground">
              {secretRefMigrations.summary.readyCount} 个可迁移，{secretRefMigrations.summary.blockedCount} 个需要先处理环境问题。
            </p>
          </div>
          <Button size="sm" onClick={() => setShowSecretRefMigration(true)}>
            查看并迁移
          </Button>
        </div>
      ) : null}

      {/* 自定义 Provider（config 来源）：连接信息 CRUD + 模型目录管理 */}
      <section data-testid="static-providers" aria-label="自定义 Provider">
        <h2 className="mb-2 text-xs font-semibold tracking-wider text-muted-foreground">自定义 Provider</h2>
      {/* 首轮加载提示：inventory 未取得前不渲染空表格，避免把「读取中」误显为「暂无 Provider」 */}
      {!staticReady ? (
        error ? null : (
          <LoadingNotice
            title="正在加载服务商…"
            description="读取本地配置文件。"
          />
        )
      ) : (
      <DataTable
        rows={filteredProviders}
        rowKey={(row) => row.id}
        emptyMessage={query ? "没有匹配的 Provider" : "暂无 Provider"}
        pinnedBottom={(row) => row.disabled}
        defaultSort={{ key: "id" }}
        rowClassName={(row) => (row.disabled ? "opacity-60" : undefined)}
        // 窄屏只保留 ID / 状态 / 操作（其余列按断点隐藏），宽屏才需要 64rem 免挤压
        minWidthClass="min-w-[22rem] sm:min-w-[34rem] lg:min-w-[62rem]"
        columns={[
          {
            key: "id",
            header: "ID",
            sortable: true,
            sortValue: (row) => row.id,
            // 窄屏 8rem：12rem 会让 ID+状态+操作 超出 390px 视口，把「更多操作」挤出屏幕
            className: "min-w-[8rem] sm:min-w-[12rem]",
            render: (row) => (
              <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
                {row.containsPrimary ? (
                  <Star aria-label="包含当前主模型" className="h-3.5 w-3.5 fill-brand text-brand" />
                ) : null}
                <span className={row.containsPrimary ? "font-medium" : undefined}>{row.id}</span>
                {inventoryProviders.get(row.id.toLowerCase())?.sources.map(source => <Pill key={source} variant="muted">{CATALOG_SOURCE_LABELS[source]}</Pill>)}
                {groupByProviderId.has(row.id) ? (
                  <span className="ml-1 inline-flex items-center gap-2">
                    <Pill variant="warning">⚠ 重复</Pill>
                    {(() => {
                      const group = groupByProviderId.get(row.id)!;
                      return group.mergeable ? (
                        <button
                          type="button"
                          aria-label={`合并 ${group.groupKey}`}
                          onClick={() => setMergeTarget(group)}
                          className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-accent"
                        >
                          合并到 {group.canonicalId}
                        </button>
                      ) : (
                        <span className="text-[10px] text-muted-foreground">建议保留 {group.canonicalId}</span>
                      );
                    })()}
                  </span>
                ) : null}
              </span>
            )
          },
          {
            key: "api",
            header: "API 类型",
            wrap: "nowrap",
            className: "hidden sm:table-cell",
            render: (row) => row.api ?? "—"
          },
          {
            key: "baseUrl",
            header: "Base URL",
            // URL 是唯一需要任意位置断开的列
            wrap: "anywhere",
            className: "hidden min-w-[14rem] lg:table-cell",
            render: (row) => <span className="font-mono text-xs">{row.baseUrl ?? "—"}</span>
          },
          {
            key: "models",
            header: "模型数",
            sortable: true,
            sortValue: (row) => (manageCatalog ? inventoryProviders.get(row.id.toLowerCase())?.modelCount : inventoryProviders.get(row.id.toLowerCase())?.pickerModelCount) ?? row.modelCount,
            align: "right",
            wrap: "nowrap",
            className: "hidden sm:table-cell",
            render: (row) => (manageCatalog ? inventoryProviders.get(row.id.toLowerCase())?.modelCount : inventoryProviders.get(row.id.toLowerCase())?.pickerModelCount) ?? row.modelCount
          },
          {
            key: "enabled",
            header: "策略允许",
            align: "right",
            wrap: "nowrap",
            className: "hidden md:table-cell",
            render: (row) => inventory ? (manageCatalog ? inventoryProviders.get(row.id.toLowerCase())?.policyAllowedModelCount ?? row.enabledModelCount : inventory.models.filter(model => model.pickerVisible && model.policyAllowed && model.providerId.toLowerCase() === row.id.toLowerCase()).length) : row.enabledModelCount
          },
          {
            key: "status",
            header: "状态",
            sortable: true,
            wrap: "nowrap",
            // 升序时已启用(0)在前、已关闭(1)在后
            sortValue: (row) => (row.disabled ? 1 : 0),
            render: (row) => {
              const fact = inventoryProviders.get(row.id.toLowerCase());
              return <span className="inline-flex flex-wrap gap-1">
                <Pill variant={row.disabled ? "muted" : "success"} title="oc-switch 可逆关闭状态">{row.disabled ? "已关闭" : "已启用"}</Pill>
                {fact && !row.disabled && (fact.needsAttention || (fact.pickerModelCount ?? 1) > 0) ? <Pill variant={fact.availability === "available" ? "success" : fact.availability === "unknown" ? "warning" : "destructive"}>{fact.availability === "available" ? "可用" : fact.availability === "unknown" ? "无法确认" : "不可用"}</Pill> : null}
              </span>;
            }
          },
          {
            key: "actions",
            header: "操作",
            wrap: "nowrap",
            className: "w-[7.5rem]",
            render: renderProviderActions
          }
        ]}
      />
      )}
      </section>

      {/* 插件 Provider 分组（spec §11.1 / §9.1）：pluginId 为 key，一组一个总开关。
          插件 enabled 语义（plugins.entries）与 oc-switch 可逆关闭互不混用 */}
      {pluginGroups.length > 0 ? (
        <section aria-label="插件 Provider" className="mt-6 space-y-2">
          <h2 className="text-xs font-semibold tracking-wider text-muted-foreground">插件 Provider</h2>
          {pluginGroups.map(({ plugin, providers: groupProviders, extensions: groupExtensions, models: groupModels }) => (
            <PluginProviderGroup
              key={plugin.id}
              plugin={plugin}
              providers={groupProviders}
              models={groupModels}
              extensionProviders={groupExtensions}
              runtimeReady={inventory !== null}
              onOpenSettings={onOpenSettings}
              onSetPluginState={client.setPluginState}
              onMutated={async (result) => { await saved(result); }}
              forceExpanded={focusedPlugin === plugin.id}
              renderProviderActions={(provider) => {
                const configured = providers.find(row => row.source === "config" && row.id.toLowerCase() === provider.providerId.toLowerCase());
                if (configured) return renderProviderActions(configured);
                // manifest 声明了 env 变量且 capability 允许时提供「设置 Key」（只写 .env 托管块）
                const apiKeyEnv = pluginApiKeyEnv(provider.providerId);
                if (!provider.capabilities.canSetApiKey || !apiKeyEnv) {
                  return <span className="text-xs text-muted-foreground">—</span>;
                }
                return (
                  <Button
                    variant="outline"
                    size="sm"
                    aria-label={`设置 Key ${provider.providerId}`}
                    title={`${apiKeyEnv}（只写 .env 托管块，不写 openclaw.json）`}
                    onClick={() => openPluginKey({
                      id: provider.providerId,
                      api: undefined,
                      baseUrl: undefined,
                      modelCount: provider.modelCount,
                      enabledModelCount: provider.policyAllowedModelCount,
                      containsPrimary: false,
                      disabled: provider.pluginEnabled === false,
                      source: "plugin",
                      apiKeyEnv,
                      apiKeyEnvManaged: true,
                      apiKeyEnvStatus: "managed"
                    })}
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    设置 Key
                  </Button>
                );
              }}
            />
          ))}
        </section>
      ) : null}

      {runtimeProviders.length > 0 ? (
        <section aria-label="运行时 Provider" className="mt-6 space-y-2">
          <h2 className="text-xs font-semibold tracking-wider text-muted-foreground">运行时 Provider</h2>
          <p className="text-xs text-muted-foreground">运行时目录只读；不会自动生成本地 Provider 配置。</p>
          <DataTable rows={runtimeProviders} rowKey={row => row.providerId} minWidthClass="min-w-[20rem]" columns={[
            { key: "id", header: "Provider / 来源", wrap: "anywhere", render: row => <div className="space-y-1"><span>{row.providerId}</span><div className="flex flex-wrap gap-1">{row.sources.map(source => <Pill key={source} variant="muted">{CATALOG_SOURCE_LABELS[source]}</Pill>)}</div></div> },
            { key: "state", header: "运行状态", wrap: "normal", render: row => <div><Pill variant={row.availability === "available" ? "success" : "warning"}>{row.availability === "available" ? "可用" : row.availability === "unknown" ? "无法确认" : "不可用·待处理"}</Pill><p className="text-xs text-muted-foreground">{row.availabilityReasons.map(reason => AVAILABILITY_REASON_LABELS[reason] ?? reason).join("、")}</p></div> }
          ]} />
        </section>
      ) : null}

      <ProviderModelsDialog
        inventoryModels={inventory?.models ?? []}
        open={Boolean(modelTarget)}
        provider={modelTarget}
        providers={providers}
        client={client}
        onCancel={() => setModelTarget(null)}
        onMetadataChanged={() => { void saved(undefined, true); }}
        onChanged={() => {
          void saved();
        }}
      />

      <ProviderDiscoverDialog
        open={Boolean(discoverTarget)}
        provider={discoverTarget}
        client={client}
        onCancel={() => setDiscoverTarget(null)}
        onAdded={({ addedCount, enabled }) => {
          setDiscoverTarget(null);
          toast.success(
            enabled
              ? `已添加并启用 ${addedCount} 个模型`
              : `已添加 ${addedCount} 个模型`
          );
          void saved();
        }}
      />

      <ModelMetadataQueueDialog
        open={Boolean(queueTarget)}
        providerId={queueTarget?.id}
        client={client}
        onClose={() => setQueueTarget(null)}
        onChanged={() => {
          // 只刷新数据不关框：对话框内已连续处理多项，关框只走 onClose
          void saved(undefined, true);
        }}
      />

      <CustomProviderDialog
        open={addingProvider}
        client={client}
        initialProviderId={repairProviderId}
        initialModels={repairModelId ? [{ id: repairModelId }] : undefined}
        onCancel={() => setAddingProvider(false)}
        onSaved={(result) => {
          setAddingProvider(false);
          toast.success(formatEnvWriteSuccess({
            label: `Provider ${result.providerId} 的 API Key`,
            envWrite: result.envWrite,
            gatewayEnvSync: result.gatewayEnvSync,
            fallback: `Provider ${result.providerId} 已添加`
          }));
          showGatewayApply(result);
          void saved();
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除 Provider"
        message={`确认删除 ${deleteTarget?.id ?? ""}？此操作将创建备份。`}
        danger
        confirmDisabled={saving}
        confirmLabel={saving ? "保存中…" : "确认"}
        onCancel={() => {
          setDeleteTarget(null);
          setRemovePolicyWildcard(false);
          setNewPrimaryCandidates([]);
          setSelectedNewPrimary("");
        }}
        onConfirm={() => void confirmDelete()}
      >
        {saving ? <OperationProgress phase="saving" /> : null}
        <div className="space-y-4">
          {deleteTarget?.containsPrimary ? (
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">新主模型</span>
              <select
                aria-label="新主模型"
                value={selectedNewPrimary}
                onChange={(event) => setSelectedNewPrimary(event.target.value)}
                className="w-full rounded border border-input bg-background px-3 py-2 text-foreground"
              >
                {newPrimaryCandidates.map((model) => (
                  <option key={model.ref} value={model.ref}>
                    {model.ref}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <div className="space-y-1 text-sm">
            <label className="flex items-start gap-2">
              <input
                type="checkbox"
                checked={removePolicyWildcard}
                onChange={(event) => setRemovePolicyWildcard(event.target.checked)}
              />
              <span>同时删除 policy 中该 Provider 的通配规则</span>
            </label>
            <p className="text-xs text-muted-foreground">不勾选时残留的悬空 wildcard 不会自动删除；API Key 永不在删除范围内。</p>
          </div>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={Boolean(stateTarget)}
        title={`${stateTarget?.disabled ? "恢复" : "关闭"} ${stateTarget?.id ?? ""}？`}
        message={
          stateTarget?.disabled
            ? "将恢复关闭前保存的模型选择规则。目录和 API Key 保留。"
            : `该 Provider 的 ${stateTarget?.enabledModelCount ?? 0} 个有效可选模型将从 OpenClaw 菜单中隐藏。Provider 配置和模型目录会保留，可稍后恢复。`
        }
        confirmDisabled={saving}
        confirmLabel={saving ? "保存中…" : "确认"}
        onCancel={() => { if (!saving) setStateTarget(null); }}
        onConfirm={() => void confirmProviderStateChange()}
      >
        {!stateTarget?.disabled ? <div className="space-y-2 text-sm">
          <p>移出此 Provider 的精确和通配选择规则，密钥保留。开放策略会收窄为当前其他模型；恢复时合并保存的规则。</p>
          <label className="flex items-center gap-2"><input type="checkbox" checked={cleanupMetadata} onChange={event => setCleanupMetadata(event.target.checked)} />同时清理此 Provider 的别名与模型参数（metadata）</label>
          <p className="text-muted-foreground">目录定义会保留；如需一并清理，可使用删除 Provider，.env 密钥仍保留。</p>
        </div> : null}
      </ConfirmDialog>

      {/* 编辑 Provider：统一使用 Radix Dialog */}
      <Dialog open={Boolean(editTarget)} onOpenChange={(val) => { if (!val && !saving) closeEdit(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>编辑 Provider</DialogTitle>
            <DialogDescription className="break-all">{editTarget?.id}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">baseUrl</span>
              <Input
                aria-label="Provider baseUrl"
                value={editBaseUrl}
                onChange={(event) => setEditBaseUrl(event.target.value)}
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">API 类型</span>
              <select
                aria-label="Provider API 类型"
                value={editApi}
                onChange={(event) => setEditApi(event.target.value)}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground"
              >
                {editTarget?.api && !isEditableApiType(editTarget.api) ? (
                  <option value={editTarget.api}>{editTarget.api}（当前值）</option>
                ) : null}
                {EDITABLE_API_TYPES.map((api) => <option key={api} value={api}>{api}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">API Key 新值</span>
              <Input
                type="password"
                aria-label="Provider API Key 新值"
                value={editApiKey}
                onChange={(event) => setEditApiKey(event.target.value)}
                autoComplete="off"
              />
            </label>
            {editTarget?.apiKeyEnvStatus === "unmanaged" && editTarget.apiKeyEnv ? (
              <p className="text-sm text-warning">
                {editTarget.apiKeyEnv} 当前在托管块外；保存新 API Key 时会迁移到 oc-switch 托管区。
              </p>
            ) : null}
            {editError ? <p className="text-sm text-destructive">{editError}</p> : null}
          </div>
          {saving ? <OperationProgress phase="saving" /> : null}
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={closeEdit}>
              取消
            </Button>
            <Button disabled={saving} onClick={() => void confirmEdit()}>{saving ? "保存中…" : "保存 Provider"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* 插件 Provider 的 API Key：只写 .env 托管块中 manifest 声明的环境变量 */}
      <Dialog open={Boolean(pluginKeyTarget)} onOpenChange={(val) => { if (!val && !saving) closePluginKey(); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>设置插件 Provider 的 API Key</DialogTitle>
            <DialogDescription className="break-all">
              {pluginKeyTarget?.id}{pluginKeyTarget?.apiKeyEnv ? ` → ${pluginKeyTarget.apiKeyEnv}` : ""}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              插件 Provider 的密钥只经环境变量生效，不写入 openclaw.json。保存后需同步并重启 Gateway 才会被运行中的进程加载。
            </p>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">API Key 新值</span>
              <Input
                type="password"
                aria-label="插件 Provider API Key 新值"
                value={pluginKeyValue}
                onChange={(event) => setPluginKeyValue(event.target.value)}
                autoComplete="off"
              />
            </label>
            {pluginKeyTarget?.apiKeyEnvStatus === "unmanaged" && pluginKeyTarget.apiKeyEnv ? (
              <p className="text-sm text-warning">
                {pluginKeyTarget.apiKeyEnv} 当前在托管块外；保存时会迁移到 oc-switch 托管区。
              </p>
            ) : null}
            {pluginKeyError ? <p className="text-sm text-destructive">{pluginKeyError}</p> : null}
          </div>
          {saving ? <OperationProgress phase="saving" /> : null}
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={closePluginKey}>
              取消
            </Button>
            <Button disabled={saving} onClick={() => void confirmPluginKey()}>{saving ? "保存中…" : "保存 API Key"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <EnvMigrationConfirmDialog
        busy={saving}
        open={Boolean(pendingEnvConfirm)}
        warnings={pendingEnvConfirm?.warnings ?? []}
        {...(pendingEnvConfirm?.confirmMigration ? { confirmMigration: true } : {})}
        {...(pendingEnvConfirm?.confirmComplex ? { confirmComplex: true } : {})}
        title="确认 API Key 写入"
        onCancel={() => setPendingEnvConfirm(null)}
        onConfirm={() => void confirmEnvMigration()}
      />

      <ConfirmDialog
        open={showSecretRefMigration}
        title="迁移 Provider API Key 引用"
        message="只修改 openclaw.json 中的引用格式，不改动 .env 中的 Key；写入前会创建备份。"
        confirmLabel={`迁移 ${secretRefMigrations?.summary.readyCount ?? 0} 项`}
        confirmDisabled={saving || !secretRefMigrations?.summary.readyCount}
        onCancel={() => setShowSecretRefMigration(false)}
        onConfirm={() => void confirmSecretRefMigration()}
      >
        <ul className="space-y-2 text-sm">
          {secretRefMigrations?.candidates.map((candidate) => (
            <li key={candidate.providerId} className="rounded border border-border px-3 py-2 text-foreground">
              {candidate.providerId} · {candidate.envVar} · {candidate.status === "ready"
                ? "可迁移"
                : candidate.blockers.map(secretRefBlockerLabel).join("；")}
            </li>
          ))}
        </ul>
      </ConfirmDialog>

      <MergeCaseDuplicateDialog
        open={Boolean(mergeTarget)}
        group={mergeTarget}
        client={client}
        onCancel={() => setMergeTarget(null)}
        onMerged={() => { setMergeTarget(null); void saved(); }}
      />
    </section>
  );
}
