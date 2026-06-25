import { Edit3, Plus, RefreshCw, Search, Star, ToggleLeft, ToggleRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DataTable } from "../components/DataTable";
import { ModelDialog } from "../components/ModelDialog";
import type { ApiClient, ModelSummary, ProviderModelInput, ProviderSummary } from "../api";

interface ModelsViewProps {
  client: ApiClient;
}

/** 模型列表：设主模型、启用/禁用、新增与编辑 */
export function ModelsView({ client }: ModelsViewProps) {
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [editTarget, setEditTarget] = useState<ModelSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");

  const load = useCallback(async () => {
    setError(null);
    try {
      const [{ models: list }, { providers: providerList }] = await Promise.all([
        client.getModels(),
        client.getProviders()
      ]);
      setModels(list);
      setProviders(providerList ?? []);
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
    await client.createModel(providerId, model);
    setCreating(false);
    await load();
  }

  async function handleEdit(_providerId: string, model: ProviderModelInput) {
    if (!editTarget) return;
    await client.updateModel(editTarget.ref, model);
    setEditTarget(null);
    await load();
  }

  const providerIds = [...new Set([
    ...providers.map((provider) => provider.id),
    ...models.map((model) => model.providerId)
  ])].sort((a, b) => a.localeCompare(b));
  const normalizedQuery = query.trim().toLowerCase();
  const filteredModels = models.filter((model) => {
    const matchesProvider = providerFilter === "all" || model.providerId === providerFilter;
    const haystack = [
      model.ref,
      model.providerId,
      model.modelId,
      model.name ?? "",
      model.alias ?? ""
    ].join(" ").toLowerCase();
    return matchesProvider && (!normalizedQuery || haystack.includes(normalizedQuery));
  });

  return (
    <section data-testid="models-view">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">模型</h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="inline-flex items-center gap-1 rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500"
          >
            <Plus className="h-4 w-4" />
            添加模型
          </button>
          <button
            type="button"
            aria-label="刷新"
            onClick={() => void load()}
            className="rounded-md border border-slate-600 p-2 hover:bg-slate-800"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error ? <p className="mb-3 text-red-400">{error}</p> : null}

      <div className="mb-3 grid gap-2 md:grid-cols-[minmax(0,1fr)_14rem]">
        <label className="relative block text-sm">
          <span className="sr-only">搜索模型</span>
          <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-500" />
          <input
            aria-label="搜索模型"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 ref、model、alias"
            className="w-full rounded border border-slate-600 bg-slate-950 py-2 pl-9 pr-3 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="sr-only">Provider 筛选</span>
          <select
            aria-label="Provider 筛选"
            value={providerFilter}
            onChange={(event) => setProviderFilter(event.target.value)}
            className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-sm"
          >
            <option value="all">全部 Provider</option>
            {providerIds.map((providerId) => (
              <option key={providerId} value={providerId}>{providerId}</option>
            ))}
          </select>
        </label>
      </div>

      <DataTable
        rows={filteredModels}
        rowKey={(row) => row.ref}
        emptyMessage="没有匹配的模型"
        columns={[
          {
            key: "ref",
            header: "引用",
            render: (row) => (
              <div className="space-y-1">
                <span className={row.isPrimary ? "font-medium text-amber-300" : ""}>{row.ref}</span>
                {row.isPrimary ? (
                  <span className="inline-flex rounded border border-amber-500/50 px-1.5 py-0.5 text-[11px] text-amber-200">
                    当前主模型
                  </span>
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
            key: "enabled",
            header: "状态",
            render: (row) => (row.enabled ? "已启用" : "已禁用")
          },
          {
            key: "actions",
            header: "操作",
            render: (row) => (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-label={`编辑模型 ${row.ref}`}
                  disabled={busy === row.ref}
                  onClick={() => setEditTarget(row)}
                  className="inline-flex items-center gap-1 rounded border border-slate-600 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-40"
                >
                  <Edit3 className="h-3 w-3" />
                  编辑
                </button>
                <button
                  type="button"
                  aria-label={`设为主模型 ${row.ref}`}
                  disabled={busy === row.ref || row.isPrimary}
                  onClick={() => void handleSetPrimary(row.ref)}
                  className="inline-flex items-center gap-1 rounded border border-amber-600/50 px-2 py-1 text-xs text-amber-200 hover:bg-amber-900/30 disabled:opacity-40"
                >
                  <Star className="h-3 w-3" />
                  主模型
                </button>
                <button
                  type="button"
                  aria-label={row.enabled ? `禁用 ${row.ref}` : `启用 ${row.ref}`}
                  disabled={busy === row.ref}
                  onClick={() => void handleToggle(row.ref, row.enabled)}
                  className="inline-flex items-center gap-1 rounded border border-slate-600 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-40"
                >
                  {row.enabled ? <ToggleRight className="h-3 w-3" /> : <ToggleLeft className="h-3 w-3" />}
                  {row.enabled ? "禁用" : "启用"}
                </button>
              </div>
            )
          }
        ]}
      />

      <ModelDialog
        open={creating}
        mode="create"
        providers={providers}
        onCancel={() => setCreating(false)}
        onSave={handleCreate}
      />
      <ModelDialog
        open={Boolean(editTarget)}
        mode="edit"
        providers={providers}
        {...(editTarget ? { model: editTarget } : {})}
        onCancel={() => setEditTarget(null)}
        onSave={handleEdit}
      />
    </section>
  );
}
