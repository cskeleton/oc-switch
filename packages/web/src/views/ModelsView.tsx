import { RefreshCw, Star, ToggleLeft, ToggleRight } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DataTable } from "../components/DataTable";
import type { ApiClient, ModelSummary } from "../api";

interface ModelsViewProps {
  client: ApiClient;
}

/** 模型列表：设主模型、启用/禁用 */
export function ModelsView({ client }: ModelsViewProps) {
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const { models: list } = await client.getModels();
      setModels(list);
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

  return (
    <section data-testid="models-view">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">模型</h1>
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
        rows={models}
        rowKey={(row) => row.ref}
        columns={[
          {
            key: "ref",
            header: "引用",
            render: (row) => (
              <span className={row.isPrimary ? "font-medium text-amber-300" : ""}>{row.ref}</span>
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
    </section>
  );
}
