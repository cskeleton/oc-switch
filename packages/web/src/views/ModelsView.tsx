import { Edit3, Inbox, Plus, RefreshCw, Search, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, useMemo } from "react";
import { DataTable } from "../components/DataTable";
import { EmptyState } from "../components/EmptyState";
import { ModelDialog } from "../components/ModelDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useToast } from "../components/Toast";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Pill } from "../components/ui/pill";
import { Switch } from "../components/ui/switch";
import { cn } from "../lib/utils";
import type { ApiClient, CaseDuplicateGroup, ModelSummary, ProviderModelInput, ProviderSummary } from "../api";

interface ModelsViewProps {
  client: ApiClient;
}

export function ModelsView({ client }: ModelsViewProps) {
  const toast = useToast();
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [duplicateGroups, setDuplicateGroups] = useState<CaseDuplicateGroup[]>([]);
  const [creating, setCreating] = useState(false);
  const [editTarget, setEditTarget] = useState<ModelSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelSummary | null>(null);
  const [newPrimary, setNewPrimary] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [providerQuery, setProviderQuery] = useState("");
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ models: list }, { providers: providerList }, health] = await Promise.all([
        client.getModels(),
        client.getProviders(),
        client.getHealth().catch(() => null)
      ]);
      setModels(list);
      setProviders(providerList ?? []);
      setDuplicateGroups(health?.caseDuplicateGroups ?? []);

      // Auto-select first provider
      const pIds = [...new Set([
        ... (providerList ?? []).map((p) => p.id),
        ... list.map((m) => m.providerId)
      ])].sort((a, b) => a.localeCompare(b));
      if (pIds.length > 0) {
        setSelectedProviderId(prev => prev || pIds[0] || null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleSetPrimary(ref: string) {
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

  function openDelete(row: ModelSummary) {
    setDeleteTarget(row);
    setNewPrimary(row.isPrimary ? models.find((entry) => entry.ref !== row.ref)?.ref ?? "" : "");
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    if (deleteTarget.isPrimary && !newPrimary) {
      toast.error("删除当前主模型前请选择新的主模型");
      return;
    }
    setError(null);
    try {
      await client.deleteModel(deleteTarget.ref, deleteTarget.isPrimary ? { newPrimary } : {});
      setDeleteTarget(null);
      toast.success(`已删除模型 ${deleteTarget.ref}`);
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "操作失败");
    }
  }

  // 左侧 Provider 导航：启用在前、已关闭沉底，组内按 id localeCompare
  const providerIds = useMemo(() => {
    const ids = [...new Set([
      ...providers.map((p) => p.id),
      ...models.map((m) => m.providerId)
    ])];
    const disabledIds = new Set(providers.filter((p) => p.disabled).map((p) => p.id));
    const enabled = ids.filter((id) => !disabledIds.has(id)).sort((a, b) => a.localeCompare(b));
    const disabled = ids.filter((id) => disabledIds.has(id)).sort((a, b) => a.localeCompare(b));
    return [...enabled, ...disabled];
  }, [providers, models]);

  const dupIdInfo = useMemo(() => {
    const map = new Map<string, { canonicalId: string; isCanonical: boolean }>();
    for (const group of duplicateGroups) {
      for (const id of group.ids) map.set(id, { canonicalId: group.canonicalId, isCanonical: id === group.canonicalId });
    }
    return map;
  }, [duplicateGroups]);

  const filteredProviderIds = useMemo(() => {
    const normalized = providerQuery.trim().toLowerCase();
    if (!normalized) return providerIds;
    return providerIds.filter(pId => pId.toLowerCase().includes(normalized));
  }, [providerIds, providerQuery]);

  const providerCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of models) {
      counts[m.providerId] = (counts[m.providerId] || 0) + 1;
    }
    return counts;
  }, [models]);

  const activeModels = useMemo(() => {
    if (!selectedProviderId) return [];
    const pModels = models.filter((m) => m.providerId === selectedProviderId);
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return pModels;
    return pModels.filter((m) => {
      const haystack = [m.ref, m.modelId, m.name ?? "", m.alias ?? ""].join(" ").toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [models, selectedProviderId, query]);

  // 两个区段各自按 ref 排序（区段本身固定，不提供表头排序）
  const activeEnabledModels = useMemo(
    () => activeModels.filter(m => m.enabled).slice().sort((a, b) => a.ref.localeCompare(b.ref)),
    [activeModels]
  );
  const activeDisabledModels = useMemo(
    () => activeModels.filter(m => !m.enabled).slice().sort((a, b) => a.ref.localeCompare(b.ref)),
    [activeModels]
  );

  const activeProvider = providers.find(p => p.id === selectedProviderId);
  const activeProviderDisabled = Boolean(activeProvider?.disabled);

  function renderModelTable(list: ModelSummary[], opacityClass: string = "") {
    return (
      <div className={`${opacityClass} border border-border rounded-md overflow-hidden bg-card text-card-foreground shadow-sm`}>
        <DataTable
          rows={list}
          rowKey={(row) => row.ref}
          emptyMessage="没有匹配的模型"
          columns={[
            {
              key: "ref",
              header: "引用",
              render: (row) => (
                <div className="flex items-center gap-2">
                  {row.isPrimary ? (
                    <Star aria-label="当前主模型" className="h-3.5 w-3.5 shrink-0 fill-brand text-brand" />
                  ) : null}
                  <span className={row.isPrimary ? "font-semibold" : "font-medium"}>
                    {row.ref}
                  </span>
                  {row.isPrimary ? <Pill variant="brand">当前主模型</Pill> : null}
                </div>
              )
            },
            {
              key: "alias",
              header: "别名",
              render: (row) => row.alias ?? "—"
            },
            {
              key: "actions",
              header: "操作",
              className: "w-40 text-right pr-4",
              render: (row) => (
                <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity duration-150">
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={busy === row.ref}
                    onClick={() => { if (!row.isPrimary) void handleSetPrimary(row.ref); }}
                    aria-label={`设为主模型 ${row.ref}`}
                    className={row.isPrimary ? "pointer-events-none text-brand" : "text-muted-foreground hover:text-foreground"}
                  >
                    <Star className={`h-3.5 w-3.5 ${row.isPrimary ? "fill-brand" : "fill-none"}`} />
                  </Button>
                  <Switch
                    checked={row.enabled}
                    disabled={busy === row.ref || activeProviderDisabled}
                    onCheckedChange={() => void handleToggle(row.ref, row.enabled)}
                    aria-label={`${row.enabled ? "禁用" : "启用"} ${row.ref}`}
                    title={activeProviderDisabled ? "该 Provider 已关闭，请先恢复 Provider 后再启用模型" : undefined}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => setEditTarget(row)}
                    aria-label={`编辑模型 ${row.ref}`}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => openDelete(row)}
                    aria-label={`删除模型 ${row.ref}`}
                    className="text-muted-foreground hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              )
            }
          ]}
        />
      </div>
    );
  }

  return (
    <section data-testid="models-view" className="flex flex-col md:flex-row gap-6 min-h-[calc(100vh-4rem)]">
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
            const isDisabled = Boolean(providers.find((provider) => provider.id === pId)?.disabled);
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
                  isDisabled && "opacity-60"
                )}
              >
                {isSelected ? (
                  <span className="absolute left-0.5 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-brand" />
                ) : null}
                <span className="flex items-center gap-1">
                  {pId}
                  {dupIdInfo.has(pId) ? (
                    <span className={`text-[10px] ${dupIdInfo.get(pId)!.isCanonical ? "text-success" : "text-warning"}`}>
                      {dupIdInfo.get(pId)!.isCanonical ? `（推荐）` : `（重复）`}
                    </span>
                  ) : null}
                  {isDisabled ? (
                    <span className="text-[10px] text-muted-foreground">（已关闭）</span>
                  ) : null}
                </span>
                <Badge variant="secondary" className="px-1.5 py-0 text-[10px] leading-none shrink-0 font-normal">
                  {providerCounts[pId] || 0}
                </Badge>
              </button>
            );
          })}
        </nav>
      </div>

      {/* Right Column: Models Pane */}
      <div className="flex-1 max-w-4xl space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <span>{selectedProviderId || "选择 Provider"}</span>
              {activeProvider?.api ? (
                <span className="text-xs font-normal text-muted-foreground bg-muted px-2 py-0.5 rounded">
                  {activeProvider.api}
                </span>
              ) : null}
            </h1>
          </div>
          <Button
            size="sm"
            aria-label="添加模型"
            disabled={activeProviderDisabled}
            title={activeProviderDisabled ? "该 Provider 已关闭，请先恢复 Provider 后再启用模型" : undefined}
            onClick={() => setCreating(true)}
          >
            <Plus className="h-4 w-4" />
            添加模型
          </Button>
        </div>

        {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}

        {activeProviderDisabled ? (
          <p className="text-sm text-muted-foreground">该 Provider 已关闭，请先在 Providers 页恢复后再启用模型。</p>
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
                {activeEnabledModels.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-success uppercase tracking-wider">
                      已启用 ({activeEnabledModels.length})
                    </h3>
                    {renderModelTable(activeEnabledModels)}
                  </div>
                )}
                {activeDisabledModels.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      已禁用 ({activeDisabledModels.length})
                    </h3>
                    {renderModelTable(activeDisabledModels, "opacity-60 grayscale-[0.2]")}
                  </div>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">请在左侧选择一个 Provider 进行管理。</p>
        )}
      </div>

      <ModelDialog
        open={creating}
        mode="create"
        providers={providers}
        fixedProviderId={selectedProviderId || undefined}
        onCancel={() => setCreating(false)}
        onSave={handleCreate}
        onLookupMetadata={client.getModelMetadataSuggestions}
      />
      <ModelDialog
        open={Boolean(editTarget)}
        mode="edit"
        providers={providers}
        fixedProviderId={selectedProviderId || undefined}
        {...(editTarget ? { model: editTarget } : {})}
        onCancel={() => setEditTarget(null)}
        onSave={handleEdit}
        onLookupMetadata={client.getModelMetadataSuggestions}
      />
      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除模型"
        message={`确认删除 ${deleteTarget?.ref ?? ""}？此操作将创建备份。`}
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      >
        {deleteTarget?.isPrimary ? (
          <div className="grid gap-2">
            <span className="text-sm text-muted-foreground">新主模型</span>
            <select
              aria-label="新主模型"
              value={newPrimary}
              onChange={(event) => setNewPrimary(event.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm"
            >
              {models.filter((entry) => entry.ref !== deleteTarget.ref).map((entry) => (
                <option key={entry.ref} value={entry.ref}>{entry.ref}</option>
              ))}
            </select>
          </div>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
