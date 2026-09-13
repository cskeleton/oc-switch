import { ModelAttentionPanel } from "../components/ModelAttentionPanel";
import { Edit3, Inbox, Plus, RefreshCw, Search, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, useMemo } from "react";
import { DataTable } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { ModelDialog } from "../components/ModelDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CustomProviderDialog } from "../components/CustomProviderDialog";
import { ModelDeleteLayers } from "../components/ModelDeleteLayers";
import { ModelPolicyPanel } from "../components/ModelPolicyPanel";
import { AVAILABILITY_REASON_LABELS, ModelStateBadges } from "../components/ModelStateBadges";
import { UnavailableModelsPanel } from "../components/UnavailableModelsPanel";
import { useToast } from "../components/Toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "../components/ui/dialog";
import { Pill } from "../components/ui/pill";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";
import type {
  ApiClient,
  ModelInventory,
  ModelInventoryEntry,
  ModelSummary,
  ProviderModelInput,
  ProviderSummary
} from "../api";

interface ModelsViewProps {
  client: ApiClient;
  onOpenProviders?: (providerId?: string) => void;
}

/** 处理向导只记录目标；权限始终读取当前 inventory，不复制策略算法。 */
interface PendingModelAction {
  kind: "handle" | "remove-policy-ref" | "materialize" | "replace";
  ref: string;
}

/** 编辑能力不等于删除能力：引用保护与 exact 删除许可均使用 Core 返回的事实。 */
function canDeleteCatalogEntry(entry: ModelInventoryEntry): boolean {
  if (!entry.capabilities.canEditCatalogEntry || entry.availability === "unknown") return false;
  if (entry.referenceSources.includes("primary") || entry.referenceSources.includes("fallback")) return false;
  // wildcard 覆盖不再阻止删除（服务端已放宽，删除后仅以 warning 提示）；
  // 仅 policy-exact 引用仍要求 Core 许可（防清空 guard 等）
  if (entry.referenceSources.includes("policy-exact")) return entry.capabilities.canRemovePolicyExactRef;
  return true;
}

/** 待处理行的严重性权重（小者在前）：主模型 > fallback > 悬空精确引用 > 其余不可用 > 探测未知 */
function pendingSeverity(entry: ModelInventoryEntry): number {
  if (entry.availability === "unknown") return 5;
  if (entry.referenceSources.includes("primary")) return 0;
  if (entry.referenceSources.includes("fallback")) return 1;
  if (entry.referenceSources.includes("policy-exact")) return 2;
  if (entry.availability === "unavailable") return 3;
  return 4;
}

/** 悬空引用行优先按 ref 字典序排（与待处理区段整体稳定排序配合） */
function comparePendingModels(a: ModelInventoryEntry, b: ModelInventoryEntry): number {
  const severityDiff = pendingSeverity(a) - pendingSeverity(b);
  return severityDiff !== 0 ? severityDiff : a.ref.localeCompare(b.ref);
}

export function ModelsView({ client, onOpenProviders }: ModelsViewProps) {
  const toast = useToast();
  const [inventory, setInventory] = useState<ModelInventory | null>(null);
  const [creating, setCreating] = useState(false);
  /** 打开 Custom Provider 向导（Provider 缺失的补全路径）并预填首行模型 */
  const [customPrefill, setCustomPrefill] = useState<{ providerId: string; modelId: string } | null>(null);
  const [editTarget, setEditTarget] = useState<ModelInventoryEntry | null>(null);
  /** 编辑对话框的目录定义（打开编辑时经兼容期 GET /api/models 补全） */
  const [editSummary, setEditSummary] = useState<ModelSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelInventoryEntry | null>(null);
  /** 删除分级（三层写模型）：默认全 false = 临时移除，仅删目录条目 */
  const [deleteLayers, setDeleteLayers] = useState({ metadata: false, policyExact: false });
  const [newPrimary, setNewPrimary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [query, setQuery] = useState("");
  const [manageCatalog, setManageCatalog] = useState(false);
  const [providerQuery, setProviderQuery] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  /** 处理向导（待处理区段「处理」入口）：补全 / 替换 / 独立 metadata 复选 / 保留 */
  const [pendingAction, setPendingAction] = useState<PendingModelAction | null>(null);
  /** policy 规则视图（spec §11.3）：默认折叠，展开后渲染 inventory.policyRules */
  const [showPolicyRules, setShowPolicyRules] = useState(false);
  const [removeMetadata, setRemoveMetadata] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await client.getModelInventory();
      setInventory(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 强制重探测：POST /api/model-inventory/refresh 返回刷新后的完整 inventory */
  async function refreshProbe() {
    if (refreshing || busy) return;
    setRefreshing(true);
    setError(null);
    try {
      const next = await client.refreshModelInventory();
      setInventory(next);
      if (next.diagnostics.length === 0 && next.summary.unknownCount === 0) toast.success("已重新探测运行时模型状态");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "刷新失败");
    } finally {
      setRefreshing(false);
    }
  }

  async function handleSetPrimary(ref: string) {
    if (busy) return;
    setBusy(ref);
    try {
      await client.setPrimary(ref);
      toast.success(`已切换主模型为 ${ref}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "设置主模型失败");
    } finally {
      setBusy(null);
    }
  }

  async function handleToggle(ref: string, enabled: boolean) {
    if (busy) return;
    setBusy(ref);
    try {
      await client.patchModel(ref, !enabled);
      toast.success(!enabled ? `已启用 ${ref}` : `已禁用 ${ref}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "更新模型状态失败");
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate(providerId: string, model: ProviderModelInput) {
    setError(null);
    try {
      await client.createModel(providerId, model);
      setCreating(false);
      toast.success(`已添加模型 ${providerId}/${model.id}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    }
  }

  async function handleEdit(_providerId: string, model: ProviderModelInput) {
    if (!editTarget) return;
    setError(null);
    try {
      await client.updateModel(editTarget.ref, model);
      setEditTarget(null);
      toast.success(`模型 ${editTarget.ref} 已更新`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    }
  }

  /** 编辑必须取得原始目录定义；读取失败不能以空参数覆盖现有配置。 */
  async function openEdit(row: ModelInventoryEntry) {
    if (busy) return;
    setBusy(row.ref);
    try {
      const { models } = await client.getModels();
      const matches = models.filter(model => model.providerId.toLowerCase() === row.providerId.toLowerCase() && model.modelId === row.modelId);
      if (matches.length === 0) throw new Error("模型目录已变化，请刷新后再编辑。");
      if (matches.length !== 1) throw new Error("模型目录存在 Provider 大小写冲突，请先处理重复 Provider 后再编辑。");
      const summary = matches[0]!;
      setEditTarget(row);
      setEditSummary(summary);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "读取模型目录失败");
    } finally {
      setBusy(null);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget || busy || !canDeleteCatalogEntry(deleteTarget)) return;
    setBusy(deleteTarget.ref);
    // wildcard 覆盖行不存在可删的 exact 条目，policyExact 恒为 false
    const wildcardCovered = deleteTarget.referenceSources.includes("policy-wildcard");
    try {
      const result = await client.deleteModel(deleteTarget.ref, {
        layers: { metadata: deleteLayers.metadata, policyExact: wildcardCovered ? false : deleteLayers.policyExact }
      });
      setDeleteTarget(null);
      toast.success(`已删除模型 ${deleteTarget.ref}`);
      for (const warning of result.warnings ?? []) toast.warning(warning);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除模型失败");
    } finally {
      setBusy(null);
    }
  }

  function openAction(action: PendingModelAction) {
    if (busy) return;
    setRemoveMetadata(false);
    setActionError(null);
    setPendingAction(action);
  }

  function closeAction() {
    if (!busy) setPendingAction(null);
  }

  function openPendingAction(ref: string) {
    const entry = inventory?.models.find(model => model.ref === ref);
    if (!entry || (entry.availability === "unknown" && !entry.capabilities.canRemovePolicyExactRef)) return;
    const protectedRef = entry.referenceSources.includes("primary") || entry.referenceSources.includes("fallback");
    setNewPrimary(inventory?.models.find(model => model.capabilities.canSetPrimary)?.ref ?? "");
    openAction({ kind: protectedRef ? "replace" : "handle", ref });
  }

  // 原始规则值可能保留 Provider 大小写；这里只关联 DTO 行，不重新匹配或计算 policy。
  const pendingEntry = inventory?.models.find(model => {
    if (!pendingAction) return false;
    const slash = pendingAction.ref.indexOf("/");
    return model.providerId.toLowerCase() === pendingAction.ref.slice(0, slash).toLowerCase() &&
      model.modelId === pendingAction.ref.slice(slash + 1);
  });
  const canRemovePendingRef = pendingAction?.kind === "remove-policy-ref"
    ? inventory?.policyRules.some(rule => rule.kind === "exact" && rule.value === pendingAction.ref && rule.removable) === true
    : pendingEntry?.capabilities.canRemovePolicyExactRef === true;

  /** 仅决定是否打开人工填写表单，不声明模型可运行或可写；创建仍走 Core 预检。 */
  function needsProviderForm(entry: ModelInventoryEntry): boolean {
    return entry.availability !== "unknown" && entry.pluginIds.length === 0 &&
      !entry.catalogSources.includes("plugin-manifest") &&
      !entry.referenceSources.includes("primary") && !entry.referenceSources.includes("fallback") &&
      !inventory?.providers.some(provider => provider.providerId.toLowerCase() === entry.providerId.toLowerCase() && provider.sources.includes("config"));
  }

  async function confirmRemovePolicyRef() {
    if (!pendingAction || busy || !canRemovePendingRef) return;
    setBusy(pendingAction.ref);
    setActionError(null);
    const cleanMetadata = removeMetadata && pendingEntry?.referenceSources.includes("legacy-metadata") === true;
    try {
      await client.removeModelPolicyExactRef(pendingAction.ref, cleanMetadata);
      setPendingAction(null);
      toast.success(`已删除 ${pendingAction.ref} 的 policy 引用（legacy metadata ${cleanMetadata ? "已清理" : "保留"}）`);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "删除引用失败");
    } finally {
      setBusy(null);
    }
  }

  async function confirmMaterialize() {
    if (!pendingEntry?.capabilities.canMaterializeConfigModel || busy) return;
    setBusy(pendingEntry.ref);
    setActionError(null);
    try {
      await client.materializeRuntimeModel(pendingEntry.ref, { id: pendingEntry.modelId, enabled: false });
      setPendingAction(null);
      toast.success(`已把 ${pendingEntry.ref} 补入 Provider ${pendingEntry.providerId} 的本地目录`);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "补全配置失败");
    } finally {
      setBusy(null);
    }
  }

  function openCreateProvider() {
    if (!pendingEntry || !needsProviderForm(pendingEntry)) return;
    setCustomPrefill({ providerId: pendingEntry.providerId, modelId: pendingEntry.modelId });
    setPendingAction(null);
  }

  async function confirmReplacePrimary() {
    if (busy || !pendingEntry?.referenceSources.includes("primary")) return;
    if (!inventory?.models.some(model => model.ref === newPrimary && model.capabilities.canSetPrimary)) return;
    setBusy(newPrimary);
    setActionError(null);
    try {
      await client.setPrimary(newPrimary);
      setPendingAction(null);
      toast.success(`已切换主模型为 ${newPrimary}；回退链保持不变`);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "替换主模型失败");
    } finally {
      setBusy(null);
    }
  }

  // 左侧 Provider 导航：未关闭在前、已关闭沉底，组内按 id localeCompare
  const providerIds = useMemo(() => {
    const providers = (inventory?.providers ?? []).filter(provider => manageCatalog || inventory?.pickerSource === undefined || (inventory?.models ?? []).some(model => model.providerId.toLowerCase() === provider.providerId.toLowerCase() && (model.pickerVisible ?? true)));
    const disabledIds = new Set(providers.filter((p) => p.disabled).map((p) => p.providerId));
    const enabled = providers.filter((p) => !disabledIds.has(p.providerId)).map((p) => p.providerId).sort((a, b) => a.localeCompare(b));
    const disabled = providers.filter((p) => disabledIds.has(p.providerId)).map((p) => p.providerId).sort((a, b) => a.localeCompare(b));
    return [...enabled, ...disabled];
  }, [inventory, manageCatalog]);

  useEffect(() => {
    setSelectedProviderId(previous => providerIds.find(id => id.toLowerCase() === previous?.toLowerCase()) ?? providerIds[0] ?? null);
  }, [providerIds]);

  const filteredProviderIds = useMemo(() => {
    const normalized = providerQuery.trim().toLowerCase();
    if (!normalized) return providerIds;
    return providerIds.filter((pId) => pId.toLowerCase().includes(normalized));
  }, [providerIds, providerQuery]);

  /** 默认完整呈现选择器选项；管理视图另外显示闲置目录，问题行集中在待处理区。 */
  const selectableModels = useMemo(() => {
    const models = inventory?.models ?? [];
    return models.filter((model) => manageCatalog ? !model.needsAttention : (model.pickerVisible ?? model.availability === "available"));
  }, [inventory, manageCatalog]);

  const providerCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const model of selectableModels) {
      const providerId = model.providerId.toLowerCase();
      counts[providerId] = (counts[providerId] || 0) + 1;
    }
    return counts;
  }, [selectableModels]);

  const activeModels = useMemo(() => {
    if (!selectedProviderId) return [];
    const pModels = selectableModels.filter((m) => m.providerId.toLowerCase() === selectedProviderId.toLowerCase());
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return pModels;
    return pModels.filter((m) => {
      const haystack = [m.ref, m.modelId].join(" ").toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [selectableModels, selectedProviderId, query]);

  // 可用模型按 ref 排序（区段固定，不提供表头排序）。
  // 策略未允许（policyAllowed=false）的 available 行也必须可达，开关用于安全启用策略，
  // capability.canTogglePolicy 为 false 时无开关（如通配覆盖行）——不拆独立「已禁用」区段
  const activeAvailableModels = useMemo(
    () => activeModels.slice().sort((a, b) => a.ref.localeCompare(b.ref)),
    [activeModels]
  );

  // 待处理区段：unavailable / unknown 全量（跨 Provider 汇总入口），按严重性排序
  const pendingModels = useMemo(() => {
    const models = (inventory?.models ?? []).filter(
      (model) => model.needsAttention === true
    );
    return models.slice().sort(comparePendingModels);
  }, [inventory]);

  const activeProvider = (inventory?.providers ?? []).find((p) => p.providerId.toLowerCase() === selectedProviderId?.toLowerCase());
  const activeProviderDisabled = Boolean(activeProvider?.disabled);
  const activeProviderFromConfig = Boolean(activeProvider?.sources.includes("config"));
  const activeProviderPluginDisabled = activeProvider?.pluginEnabled === false;
  const pluginOnlyProvider = activeProvider?.sources.includes("plugin-manifest") && !activeProviderFromConfig;
  const providerDisabledHint = "该 Provider 已关闭，请先恢复 Provider 后再启用模型";

  const unavailableCount = pendingModels.filter(model => model.availability === "unavailable").length;
  const unknownCount = pendingModels.filter(model => model.availability === "unknown").length;

  function renderModelTable(list: ModelInventoryEntry[], opacityClass: string = "") {
    return (
      <div className={`${opacityClass} border border-border rounded-md overflow-hidden bg-card text-card-foreground shadow-sm`}>
        <DataTable
          rows={list}
          rowKey={(row) => row.ref}
          emptyMessage="没有匹配的模型"
          minWidthClass="min-w-[20rem] sm:min-w-[34rem]"
          columns={[
            {
              key: "ref",
              header: "引用",
              // ref 是长路径（provider/vendor/model），允许任意位置断行
              wrap: "anywhere",
              render: (row) => (
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {row.referenceSources.includes("primary") ? (
                    <Star aria-label="当前主模型" className="h-3.5 w-3.5 shrink-0 fill-brand text-brand" />
                  ) : null}
                  <span className={row.referenceSources.includes("primary") ? "font-semibold" : "font-medium"}>
                    {row.ref}
                  </span>
                  {row.referenceSources.includes("primary") ? <Pill variant="brand">当前主模型</Pill> : null}
                  <ModelStateBadges entry={row} plugins={inventory?.plugins ?? []} />
                </div>
              )
            },
            {
              key: "actions",
              header: "操作",
              wrap: "nowrap",
              className: "w-40 text-right pr-4",
              render: (row) => {
                // 普通区段只渲染 available 行；不可用 / 未知行走待处理区段（无普通启停开关）
                const wildcardSelected = row.selectionSource === "policy-wildcard";
                // 能力门控（binding）：开关 / 主模型 / 编辑 / 删除入口全部由 capability 决定。
                // capability 拒绝的启停不渲染开关（unavailable 行无普通开关；wildcard 行不可逐模型关闭）
                const canToggle = row.capabilities.canTogglePolicy;
                const canPrimary = row.capabilities.canSetPrimary;
                const canEdit = row.capabilities.canEditCatalogEntry;
                const canDelete = canDeleteCatalogEntry(row);
                // runtime-only 可用模型可补全进 config Provider 目录（spec §8.1 补全配置）
                const canMaterialize = row.capabilities.canMaterializeConfigModel;
                return (
                <div className="flex items-center justify-end gap-1.5 md:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150">
                  {canPrimary ? (
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={busy !== null}
                      onClick={() => { if (!row.referenceSources.includes("primary")) void handleSetPrimary(row.ref); }}
                      aria-label={`设为主模型 ${row.ref}`}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      <Star className="h-3.5 w-3.5 fill-none" />
                    </Button>
                  ) : null}
                  {canToggle ? (
                    <Switch
                      checked={row.policyAllowed}
                      disabled={busy !== null}
                      onCheckedChange={() => void handleToggle(row.ref, row.policyAllowed)}
                      aria-label={`${row.policyAllowed ? "禁用" : "启用"} ${row.ref}`}
                      title={activeProviderDisabled ? providerDisabledHint : undefined}
                    />
                  ) : null}
                  {/* 通配覆盖行：无逐模型开关，但「先收窄规则」提示必须可达（spec §11.2） */}
                  {wildcardSelected ? (
                    <span
                      className="text-xs text-muted-foreground whitespace-nowrap"
                      title="该模型由通配策略启用；请先收窄 policy 后再单独禁用"
                    >
                      通配覆盖
                    </span>
                  ) : null}
                  {canMaterialize ? (
                    <Button
                      variant="outline"
                      size="sm"
                      aria-label={`补全到目录 ${row.ref}`}
                      title="把该运行时模型补入本 Provider 的本地目录"
                      disabled={busy !== null}
                      onClick={() => openAction({ kind: "materialize", ref: row.ref })}
                    >
                      补全到目录
                    </Button>
                  ) : null}
                  {needsProviderForm(row) ? (
                    <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => openAction({ kind: "handle", ref: row.ref })} aria-label={`补全 Provider 配置 ${row.ref}`}>
                      补全 Provider
                    </Button>
                  ) : null}
                  {canEdit ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy !== null}
                        onClick={() => void openEdit(row)}
                        aria-label={`编辑模型 ${row.ref}`}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <Edit3 className="h-3.5 w-3.5" />
                      </Button>
                  ) : null}
                  {canDelete ? (
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={busy !== null}
                        onClick={() => { setDeleteLayers({ metadata: false, policyExact: false }); setDeleteTarget(row); }}
                        aria-label={`删除模型 ${row.ref}`}
                        className="text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                  ) : null}
                </div>
                );
              }
            }
          ]}
        />
      </div>
    );
  }

  return (
    <section data-testid="models-view" className="flex flex-col gap-6 min-h-[calc(100vh-4rem)]">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{manageCatalog ? "配置目录：保留参数不代表启用。" : inventory?.pickerSource === "gateway" ? "当前 Gateway 模型选项（默认 Agent）；独立策略的 Agent 可能不同。" : "本地推算的模型选项；尚未确认与运行中的 IM 一致。"}</p>
        <Button variant="outline" onClick={() => setManageCatalog(value => !value)}>{manageCatalog ? "返回 IM 模型选项" : "管理配置目录"}</Button>
      </div>
      <ModelAttentionPanel client={client} inventory={inventory} onChanged={load} onConfigure={onOpenProviders ? id => onOpenProviders(id) : undefined} />
      <div className="flex justify-end"><Button variant="outline" size="sm" aria-label="刷新探测" disabled={refreshing || busy !== null} onClick={() => void refreshProbe()}>刷新探测</Button></div>
      {/* 主体：左 Provider 导航 + 右模型区段 */}
      <div className="flex flex-col md:flex-row gap-6">
        {/* Left Column: Provider List */}
        <div className="w-full md:w-[260px] shrink-0 border-b md:border-b-0 md:border-r border-border pb-4 md:pb-0 md:pr-4">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">Providers</h2>
            <Button
              variant="outline"
              size="icon"
              aria-label="刷新"
              onClick={() => void load()}
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </Button>
          </div>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <input
              aria-label="搜索 Provider"
              value={providerQuery}
              onChange={(event) => setProviderQuery(event.target.value)}
              placeholder="过滤 Providers..."
              className="w-full rounded-md border border-input bg-background py-1.5 pl-8 pr-2.5 text-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <nav className="space-y-1">
            {filteredProviderIds.map((pId) => {
              const isSelected = pId === selectedProviderId;
              const navProvider = (inventory?.providers ?? []).find((provider) => provider.providerId === pId);
              const isDisabled = Boolean(navProvider?.disabled);
              const isPluginStopped = navProvider?.pluginEnabled === false;
              const navSuffix = isPluginStopped
                ? "插件·已停用"
                : isDisabled
                  ? "已关闭"
                  : "";
              return (
                <button
                  key={pId}
                  type="button"
                  onClick={() => setSelectedProviderId(pId)}
                  className={cn(
                    "relative flex w-full items-center justify-between rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
                    isSelected
                      ? "bg-brand/10 text-brand"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
                    (isDisabled || isPluginStopped) && "opacity-60"
                  )}
                >
                  {isSelected ? (
                    <span className="absolute left-0.5 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand" />
                  ) : null}
                  <span className="flex min-w-0 items-center gap-1">
                    {/* provider id 可能很长（qwen-token-plan），截断而不是折行——完整值给 title */}
                    <span className="truncate" title={pId}>{pId}</span>
                    {/* 来源与状态合并成单个后缀：两个括号会把 260px 侧栏挤到折行 */}
                    {navSuffix ? (
                      <span className="shrink-0 text-[10px] text-muted-foreground">（{navSuffix}）</span>
                    ) : null}
                  </span>
                  <Badge variant="secondary" className="ml-1 shrink-0 px-1.5 py-0 text-[10px] font-normal leading-none" aria-label={`模型数 ${providerCounts[pId.toLowerCase()] || 0}`}>
                    {providerCounts[pId.toLowerCase()] || 0}
                  </Badge>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Right Column: Models Pane */}
        <div className="min-w-0 flex-1 max-w-4xl space-y-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold flex items-center gap-2 break-all">
                <span>{selectedProviderId || "选择 Provider"}</span>
              </h1>
            </div>
            {/* 添加模型：仅 config 来源 Provider（目录可写）；插件 / 已关闭 Provider 一律禁用 */}
            <Button
              size="sm"
              aria-label="添加模型"
              disabled={!activeProviderFromConfig || activeProviderDisabled}
              title={
                !activeProviderFromConfig
                  ? "插件 provider 的模型目录只读，无法在 oc-switch 添加模型"
                  : activeProviderDisabled ? providerDisabledHint : undefined
              }
              onClick={() => setCreating(true)}
            >
              <Plus className="h-4 w-4" />
              添加模型
            </Button>
          </div>

          {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}

          {activeProviderPluginDisabled && pluginOnlyProvider ? (
            <p className="text-sm text-muted-foreground">
              该插件已在 OpenClaw 的 plugins.entries 中停用；请先在 Providers 页启用该插件后再启用其模型。
            </p>
          ) : null}
          {pluginOnlyProvider && !activeProviderPluginDisabled ? (
            <p className="text-sm text-muted-foreground">
              插件 Provider 的模型目录由 OpenClaw 插件提供，只读；可启停模型与设为主模型，不能增删改。
            </p>
          ) : null}
          {activeProviderPluginDisabled && activeProviderFromConfig ? (
            <p className="text-sm text-muted-foreground">该 Provider 的插件来源已停用；本地配置模型仍按各自的策略和运行可用性管理。</p>
          ) : null}
          {activeProvider && !activeProviderFromConfig && !pluginOnlyProvider ? (
            <p className="text-sm text-muted-foreground">运行时目录只读；可用模型按 Core 能力管理策略和主模型，不会自动写入本地目录。</p>
          ) : null}
          {activeProviderDisabled ? (
            <p className="text-sm text-muted-foreground">
              该 Provider 已关闭，请先在 Providers 页恢复后再启用模型。
            </p>
          ) : null}

          {selectedProviderId ? (
            <>
              {/* Search filter for selected Provider */}
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                <input
                  aria-label="搜索模型"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索引用或别名..."
                  className="w-full rounded-md border border-input bg-background py-2 pl-9 pr-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                />
              </div>

              {activeModels.length === 0 ? (
                <EmptyState icon={Inbox} title="没有匹配的模型" />
              ) : (
                <div className="space-y-6">
                  {activeAvailableModels.length > 0 && (
                    <div className="space-y-2">
                      <h3 className="text-xs font-semibold text-success uppercase tracking-wider">
                        {manageCatalog ? "目录模型" : "模型选项"} ({activeAvailableModels.length})
                      </h3>
                      {renderModelTable(activeAvailableModels)}
                    </div>
                  )}
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">请在左侧选择一个 Provider 进行管理。</p>
          )}
        </div>
      </div>

      {/* Policy 规则视图（spec §11.3）：modelPolicy.allow 原始规则投影，默认折叠的次级区段。
          exact removable 可删（经确认框走 removeModelPolicyExactRef）；wildcard 本期只读 */}
      <section aria-label="Policy 规则">
        <button
          type="button"
          aria-expanded={showPolicyRules}
          aria-label={showPolicyRules ? "收起 Policy 规则" : "展开 Policy 规则"}
          onClick={() => setShowPolicyRules((prev) => !prev)}
          className="flex w-full items-center justify-between rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground hover:bg-accent/50"
        >
          <span>Policy 规则（modelPolicy.allow）</span>
          <span className="text-xs text-muted-foreground">
            {showPolicyRules ? "收起" : `展开（${(inventory?.policyRules ?? []).length} 条）`}
          </span>
        </button>
        {showPolicyRules ? (
          <div className="mt-3">
            <ModelPolicyPanel
              rules={inventory?.policyRules ?? []}
              onRemoveRule={(ref) => openAction({ kind: "remove-policy-ref", ref })}
            />
          </div>
        ) : null}
      </section>

      {/* 同一个处理向导提供可用选项，而不是把「处理」直接等同于删除。 */}
      <Dialog open={pendingAction?.kind === "handle" || pendingAction?.kind === "remove-policy-ref"} onOpenChange={open => { if (!open) closeAction(); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{pendingAction?.kind === "remove-policy-ref" ? "删除 Policy 规则" : "处理模型引用"}</DialogTitle>
            <DialogDescription className="break-all">
              {pendingAction?.kind === "remove-policy-ref"
                ? `确认删除 ${pendingAction.ref} 的 modelPolicy.allow 精确引用？此操作将创建备份。`
                : pendingAction?.ref}
            </DialogDescription>
          </DialogHeader>
          {pendingEntry ? <ModelStateBadges entry={pendingEntry} plugins={inventory?.plugins ?? []} /> : null}
          {pendingEntry?.availabilityReasons.length ? (
            <p className="text-sm text-muted-foreground">{pendingEntry.availabilityReasons.map(reason => AVAILABILITY_REASON_LABELS[reason] ?? reason).join("、")}</p>
          ) : null}
          {pendingEntry && needsProviderForm(pendingEntry) ? (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">Provider 不在本地配置中。请在向导中填写并确认 baseUrl、API 类型及凭据，不会自动猜测连接信息。</p>
              <Button variant="outline" disabled={busy !== null} aria-label="创建 Provider 并补全模型" onClick={openCreateProvider}>创建 Provider 并补全模型</Button>
            </div>
          ) : null}
          {pendingEntry?.capabilities.canMaterializeConfigModel ? (
            <Button variant="outline" disabled={busy !== null} onClick={() => openAction({ kind: "materialize", ref: pendingEntry.ref })}>预览补全到目录</Button>
          ) : null}
          {pendingEntry && (pendingEntry.pluginIds.length > 0 || pendingEntry.catalogSources.includes("plugin-manifest")) ? (
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>插件目录由 OpenClaw 管理；已下架模型不可伪造为本地配置。插件停用或缺少认证时，请到 Providers 页检查插件状态与凭据。</p>
              {onOpenProviders ? <Button variant="outline" disabled={busy !== null} onClick={() => onOpenProviders?.(pendingEntry?.providerId)}>前往 Providers</Button> : null}
            </div>
          ) : null}
          {canRemovePendingRef ? (
            <form className="space-y-3" onSubmit={event => { event.preventDefault(); void confirmRemovePolicyRef(); }}>
              <p className="text-sm text-muted-foreground">默认仅删除 policy 精确引用；不会修改 wildcard，也不会删除认证 Profile。写入前由 Core 重新预检并创建备份。</p>
              {pendingEntry?.referenceSources.includes("legacy-metadata") ? (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" name="removeMetadata" checked={removeMetadata} disabled={busy !== null} onChange={event => setRemoveMetadata(event.target.checked)} />
                  <span>同时清理 metadata（agents.defaults.models 同名条目；默认保留）</span>
                </label>
              ) : null}
              <Button type="submit" variant="destructive" disabled={busy !== null} aria-label={removeMetadata ? "删除引用并清理 metadata" : "仅删除 policy 引用"}>
                {removeMetadata ? "删除引用并清理 metadata" : "仅删除 policy 引用"}
              </Button>
            </form>
          ) : <p className="text-sm text-muted-foreground">当前引用不能安全删除；可保留配置，等待恢复或先处理受保护的引用。</p>}
          {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
          <DialogFooter><Button variant="outline" disabled={busy !== null} onClick={closeAction}>暂不处理</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={pendingAction?.kind === "materialize"}
        title="补全模型配置"
        message={`把 ${pendingAction?.ref ?? ""} 补入 Provider 本地目录（不主动启用策略）。此操作将创建备份。`}
        confirmLabel="补全到本 Provider 目录"
        confirmDisabled={busy !== null || !pendingEntry?.capabilities.canMaterializeConfigModel}
        onCancel={closeAction}
        onConfirm={() => void confirmMaterialize()}
      >
        <dl className="space-y-2 break-all text-sm">
          <div><dt className="text-muted-foreground">Provider</dt><dd>{pendingEntry?.providerId}</dd></div>
          <div><dt className="text-muted-foreground">模型 ID</dt><dd>{pendingEntry?.modelId}</dd></div>
        </dl>
        <p className="mt-3 text-sm text-muted-foreground">本次提交仅包含模型 ID，不猜测 contextWindow、maxTokens 或 API；已有策略保持不变。</p>
        {actionError ? <p role="alert" className="mt-3 text-sm text-destructive">{actionError}</p> : null}
      </ConfirmDialog>

      <Dialog open={pendingAction?.kind === "replace"} onOpenChange={open => { if (!open) closeAction(); }}>
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{pendingEntry?.referenceSources.includes("primary") ? "替换主模型" : "替换 fallback 指引"}</DialogTitle>
            <DialogDescription className="break-all">{pendingAction?.ref} 的引用受保护；本操作不会删除目录或修改回退链。</DialogDescription>
          </DialogHeader>
          {pendingEntry?.referenceSources.includes("primary") ? (
            <form className="space-y-3" onSubmit={event => { event.preventDefault(); void confirmReplacePrimary(); }}>
              <label className="grid gap-2 text-sm">
                替代主模型
                <select aria-label="替代主模型" name="replacement" className="w-full min-w-0 rounded-md border border-input bg-background p-2" value={newPrimary} disabled={busy !== null} onChange={event => setNewPrimary(event.target.value)}>
                  <option value="">请选择可用且策略允许的模型</option>
                  {(inventory?.models ?? []).filter(model => model.capabilities.canSetPrimary).map(model => <option key={model.ref} value={model.ref}>{model.ref}</option>)}
                </select>
              </label>
              <p className="text-xs text-muted-foreground">列表仅包含 Core 允许设为主模型的条目；没有候选时，请先启用其它可用模型的策略。</p>
              <Button type="submit" disabled={busy !== null || !inventory?.models.some(model => model.ref === newPrimary && model.capabilities.canSetPrimary)}>确认替换主模型</Button>
            </form>
          ) : (
            <div className="space-y-2 text-sm">
              <p>回退链只读：请在 OpenClaw 配置中更新 agents.defaults.model.fallbacks 后刷新。这里不会把 fallback 的替换误操作为切换主模型。</p>
              <p className="text-muted-foreground">可用的替代候选：</p>
              <ul className="list-inside list-disc break-all">{(inventory?.models ?? []).filter(model => model.capabilities.canSetPrimary).map(model => <li key={model.ref}>{model.ref}</li>)}</ul>
            </div>
          )}
          {actionError ? <p role="alert" className="text-sm text-destructive">{actionError}</p> : null}
          <DialogFooter><Button variant="outline" disabled={busy !== null} onClick={closeAction}>暂不处理</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {customPrefill ? (
        <CustomProviderDialog
          open
          client={client}
          initialProviderId={customPrefill.providerId}
          initialModels={[{ id: customPrefill.modelId }]}
          onCancel={() => setCustomPrefill(null)}
          onSaved={() => {
            setCustomPrefill(null);
            toast.success("Provider 已创建；请刷新后复核运行时模型状态。");
            void load();
          }}
        />
      ) : null}

      <ModelDialog
        open={creating}
        mode="create"
        providers={configProviderSummaries(inventory)}
        fixedProviderId={selectedProviderId || undefined}
        onCancel={() => setCreating(false)}
        onSave={handleCreate}
        onLookupMetadata={client.getModelMetadataSuggestions}
      />
      <ModelDialog
        open={Boolean(editTarget)}
        mode="edit"
        providers={configProviderSummaries(inventory)}
        fixedProviderId={editSummary?.providerId}
        {...(editTarget && editSummary ? { model: editSummary } : {})}
        onCancel={() => { setEditTarget(null); setEditSummary(null); }}
        onSave={handleEdit}
        onLookupMetadata={client.getModelMetadataSuggestions}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除模型"
        message={`确认删除 ${deleteTarget?.ref ?? ""}？此操作将创建备份。`}
        danger
        confirmDisabled={busy !== null}
        onCancel={() => { if (!busy) setDeleteTarget(null); }}
        onConfirm={() => void confirmDelete()}
      >
        {deleteTarget ? (
          <ModelDeleteLayers
            metadata={deleteLayers.metadata}
            policyExact={deleteLayers.policyExact}
            wildcardCovered={deleteTarget.referenceSources.includes("policy-wildcard")}
            disabled={busy !== null}
            onChange={setDeleteLayers}
          />
        ) : null}
      </ConfirmDialog>
    </section>
  );
}

/** config 来源 Provider → ModelDialog 的 Provider 选项（目录可写的 Provider 才可添加/编辑模型） */
function configProviderSummaries(inventory: ModelInventory | null): ProviderSummary[] {
  return (inventory?.providers ?? [])
    .filter((provider) => provider.sources.includes("config"))
    .map((provider) => ({
      id: provider.providerId,
      api: undefined,
      baseUrl: undefined,
      modelCount: provider.modelCount,
      enabledModelCount: provider.policyAllowedModelCount,
      containsPrimary: false,
      disabled: provider.disabled,
      source: "config" as const,
      apiKeyEnv: null,
      apiKeyEnvManaged: false,
      apiKeyEnvStatus: "missing" as const
    }));
}
