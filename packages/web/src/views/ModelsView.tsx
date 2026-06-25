import { Edit3, Plus, RefreshCw, Search, Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState, useMemo } from "react";
import { DataTable } from "../components/DataTable";
import { ModelDialog } from "../components/ModelDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Badge } from "../components/ui/badge";
import { Switch } from "../components/ui/switch";
import type { ApiClient, ModelSummary, ProviderModelInput, ProviderSummary } from "../api";

interface ModelsViewProps {
  client: ApiClient;
}

export function ModelsView({ client }: ModelsViewProps) {
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
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
      const [{ models: list }, { providers: providerList }] = await Promise.all([
        client.getModels(),
        client.getProviders()
      ]);
      setModels(list);
      setProviders(providerList ?? []);

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
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "设置主模型失败");
    } finally {
      setBusy(null);
    }
  }

  async function handleToggle(ref: string, enabled: boolean) {
    setBusy(ref);
    try {
      await client.patchModel(ref, !enabled);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "更新模型状态失败");
    } finally {
      setBusy(null);
    }
  }

  async function handleCreate(providerId: string, model: ProviderModelInput) {
    setError(null);
    try {
      await client.createModel(providerId, model);
      setCreating(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    }
  }

  async function handleEdit(_providerId: string, model: ProviderModelInput) {
    if (!editTarget) return;
    setError(null);
    try {
      await client.updateModel(editTarget.ref, model);
      setEditTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    }
  }

  function openDelete(row: ModelSummary) {
    setDeleteTarget(row);
    setNewPrimary(row.isPrimary ? models.find((entry) => entry.ref !== row.ref)?.ref ?? "" : "");
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    if (deleteTarget.isPrimary && !newPrimary) {
      setError("删除当前主模型前请选择新的主模型");
      return;
    }
    setError(null);
    try {
      await client.deleteModel(deleteTarget.ref, deleteTarget.isPrimary ? { newPrimary } : {});
      setDeleteTarget(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "操作失败");
    }
  }

  const providerIds = useMemo(() => {
    return [...new Set([
      ...providers.map((p) => p.id),
      ...models.map((m) => m.providerId)
    ])].sort((a, b) => a.localeCompare(b));
  }, [providers, models]);

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

  const activeEnabledModels = useMemo(() => activeModels.filter(m => m.enabled), [activeModels]);
  const activeDisabledModels = useMemo(() => activeModels.filter(m => !m.enabled), [activeModels]);

  const activeProvider = providers.find(p => p.id === selectedProviderId);

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
                  <span className={row.isPrimary ? "font-semibold text-amber-500 dark:text-amber-400" : "font-medium"}>
                    {row.ref}
                  </span>
                  {row.isPrimary ? (
                    <Badge variant="outline" className="border-amber-500 text-amber-600 dark:border-amber-500/50 dark:text-amber-200 py-0 text-[10px]">
                      当前主模型
                    </Badge>
                  ) : null}
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
                  <button
                    type="button"
                    disabled={busy === row.ref}
                    onClick={() => { if (!row.isPrimary) void handleSetPrimary(row.ref); }}
                    aria-label={`设为主模型 ${row.ref}`}
                    className={`rounded p-1 hover:bg-accent transition-colors ${row.isPrimary ? "text-amber-500 pointer-events-none" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    <Star className={`h-3.5 w-3.5 ${row.isPrimary ? "fill-current" : "fill-none"}`} />
                  </button>
                  <Switch
                    checked={row.enabled}
                    disabled={busy === row.ref}
                    onCheckedChange={() => void handleToggle(row.ref, row.enabled)}
                    aria-label={`${row.enabled ? "禁用" : "启用"} ${row.ref}`}
                  />
                  <button
                    type="button"
                    onClick={() => setEditTarget(row)}
                    aria-label={`编辑模型 ${row.ref}`}
                    className="rounded p-1 hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <Edit3 className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => openDelete(row)}
                    aria-label={`删除模型 ${row.ref}`}
                    className="rounded p-1 hover:bg-accent text-muted-foreground hover:text-destructive transition-colors"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
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
          <button
            type="button"
            aria-label="刷新"
            onClick={() => void load()}
            className="rounded p-1.5 hover:bg-accent text-muted-foreground hover:text-foreground border border-border"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
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
            return (
              <button
                key={pId}
                type="button"
                onClick={() => setSelectedProviderId(pId)}
                className={`flex w-full items-center justify-between rounded-md px-3 py-1.5 text-sm font-medium transition-all ${
                  isSelected
                    ? "bg-primary/10 text-primary border-l-2 border-primary pl-2.5"
                    : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                }`}
              >
                <span>{pId}</span>
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
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 shadow-sm"
          >
            <Plus className="h-4 w-4" />
            添加模型
          </button>
        </div>

        {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}

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
              <p className="text-sm text-muted-foreground">没有匹配的模型</p>
            ) : (
              <div className="space-y-6">
                {activeEnabledModels.length > 0 && (
                  <div className="space-y-2">
                    <h3 className="text-xs font-semibold text-emerald-600 dark:text-emerald-400 uppercase tracking-wider">
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
      />
      <ModelDialog
        open={Boolean(editTarget)}
        mode="edit"
        providers={providers}
        fixedProviderId={selectedProviderId || undefined}
        {...(editTarget ? { model: editTarget } : {})}
        onCancel={() => setEditTarget(null)}
        onSave={handleEdit}
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
