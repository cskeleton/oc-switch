import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CustomProviderDialog } from "../components/CustomProviderDialog";
import { DataTable } from "../components/DataTable";
import type { ApiClient, ModelSummary, ProviderSummary } from "../api";

interface ProvidersViewProps {
  client: ApiClient;
  onRefresh?: () => void;
}

/** Provider 列表与管理 */
export function ProvidersView({ client, onRefresh }: ProvidersViewProps) {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [addingProvider, setAddingProvider] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ProviderSummary | null>(null);
  const [newPrimaryCandidates, setNewPrimaryCandidates] = useState<ModelSummary[]>([]);
  const [selectedNewPrimary, setSelectedNewPrimary] = useState("");

  const load = useCallback(async () => {
    setError(null);
    try {
      const { providers: list } = await client.getProviders();
      setProviders(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function openDelete(row: ProviderSummary) {
    setError(null);
    setDeleteTarget(row);
    setNewPrimaryCandidates([]);
    setSelectedNewPrimary("");
    if (!row.containsPrimary) return;
    try {
      const { models } = await client.getModels();
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
      setError("删除包含 primary 的 Provider 前请选择新的主模型");
      return;
    }
    try {
      await client.deleteProvider(deleteTarget.id, {
        ...(deleteTarget.containsPrimary ? { newPrimary: selectedNewPrimary } : {})
      });
      setDeleteTarget(null);
      setNewPrimaryCandidates([]);
      setSelectedNewPrimary("");
      await load();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "删除失败");
      setDeleteTarget(null);
    }
  }

  return (
    <section data-testid="providers-view">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Providers</h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setAddingProvider(true)}
            className="inline-flex items-center gap-1 rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500"
          >
            <Plus className="h-4 w-4" />
            添加 Provider
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

      <DataTable
        rows={providers}
        rowKey={(row) => row.id}
        columns={[
          {
            key: "id",
            header: "ID",
            render: (row) => (
              <span className={row.containsPrimary ? "font-medium text-amber-300" : ""}>
                {row.id}
                {row.containsPrimary ? " ★" : ""}
              </span>
            )
          },
          { key: "api", header: "API 类型", render: (row) => row.api ?? "—" },
          {
            key: "models",
            header: "模型 / 已启用",
            render: (row) => `${row.modelCount} / ${row.enabledModelCount}`
          },
          {
            key: "actions",
            header: "操作",
            render: (row) => (
              <button
                type="button"
                aria-label={`删除 ${row.id}`}
                onClick={() => void openDelete(row)}
                className="inline-flex items-center gap-1 rounded border border-red-700/50 px-2 py-1 text-xs text-red-300 hover:bg-red-900/30"
              >
                <Trash2 className="h-3 w-3" />
                删除
              </button>
            )
          }
        ]}
      />

      <CustomProviderDialog
        open={addingProvider}
        client={client}
        onCancel={() => setAddingProvider(false)}
        onSaved={() => {
          setAddingProvider(false);
          void load();
          onRefresh?.();
        }}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除 Provider"
        message={`确认删除 ${deleteTarget?.id ?? ""}？此操作将创建备份。`}
        danger
        onCancel={() => {
          setDeleteTarget(null);
          setNewPrimaryCandidates([]);
          setSelectedNewPrimary("");
        }}
        onConfirm={() => void confirmDelete()}
      >
        {deleteTarget?.containsPrimary ? (
          <label className="block text-sm">
            <span className="mb-1 block text-slate-400">新主模型</span>
            <select
              aria-label="新主模型"
              value={selectedNewPrimary}
              onChange={(event) => setSelectedNewPrimary(event.target.value)}
              className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100"
            >
              {newPrimaryCandidates.map((model) => (
                <option key={model.ref} value={model.ref}>
                  {model.ref}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
