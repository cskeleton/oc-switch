import { RefreshCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable } from "../components/DataTable";
import type { ApiClient, ProviderSummary } from "../api";

interface ProvidersViewProps {
  client: ApiClient;
  onRefresh?: () => void;
}

/** Provider 列表与管理 */
export function ProvidersView({ client, onRefresh }: ProvidersViewProps) {
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ProviderSummary | null>(null);

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

  async function confirmDelete() {
    if (!deleteTarget) return;
    try {
      await client.deleteProvider(deleteTarget.id, {
        ...(deleteTarget.containsPrimary ? { force: true } : {})
      });
      setDeleteTarget(null);
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
        <button
          type="button"
          aria-label="刷新"
          onClick={() => void load()}
          className="rounded-md border border-slate-600 p-2 hover:bg-slate-800"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
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
                onClick={() => setDeleteTarget(row)}
                className="inline-flex items-center gap-1 rounded border border-red-700/50 px-2 py-1 text-xs text-red-300 hover:bg-red-900/30"
              >
                <Trash2 className="h-3 w-3" />
                删除
              </button>
            )
          }
        ]}
      />

      <ConfirmDialog
        open={Boolean(deleteTarget)}
        title="删除 Provider"
        message={`确认删除 ${deleteTarget?.id ?? ""}？此操作将创建备份。`}
        danger
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => void confirmDelete()}
      />
    </section>
  );
}
