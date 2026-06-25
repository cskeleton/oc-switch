import { Cpu, Edit3, Plus, RefreshCw, RotateCw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { CustomProviderDialog } from "../components/CustomProviderDialog";
import { DataTable } from "../components/DataTable";
import { ProviderModelsDialog } from "../components/ProviderModelsDialog";
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
  const [editTarget, setEditTarget] = useState<ProviderSummary | null>(null);
  const [editBaseUrl, setEditBaseUrl] = useState("");
  const [editApiKey, setEditApiKey] = useState("");
  const [newPrimaryCandidates, setNewPrimaryCandidates] = useState<ModelSummary[]>([]);
  const [selectedNewPrimary, setSelectedNewPrimary] = useState("");
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [modelTarget, setModelTarget] = useState<ProviderSummary | null>(null);

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

  function openEdit(row: ProviderSummary) {
    setError(null);
    setEditTarget(row);
    setEditBaseUrl(row.baseUrl ?? "");
    setEditApiKey("");
  }

  async function confirmEdit() {
    if (!editTarget) return;
    const changes: { baseUrl?: string; apiKey?: string } = {};
    const nextBaseUrl = editBaseUrl.trim();
    if (nextBaseUrl) changes.baseUrl = nextBaseUrl;
    if (editApiKey) changes.apiKey = editApiKey;
    if (!changes.baseUrl && !changes.apiKey) {
      setError("请输入 baseUrl 或 API Key 新值");
      return;
    }
    try {
      await client.updateProvider(editTarget.id, changes);
      setEditTarget(null);
      setEditApiKey("");
      await load();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "保存失败");
    }
  }

  async function handleSync(row: ProviderSummary) {
    setSyncing(row.id);
    setSyncMessage(null);
    setError(null);
    try {
      const result = await client.syncProvider(row.id);
      if (result.unsupportedReason) {
        setSyncMessage(`同步未执行：${result.unsupportedReason}`);
      } else {
        setSyncMessage(`同步完成：新增 ${result.addedModelIds?.length ?? 0} 个模型`);
      }
      await load();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "同步失败");
    } finally {
      setSyncing(null);
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
            className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" />
            添加 Provider
          </button>
          <button
            type="button"
            aria-label="刷新"
            onClick={() => void load()}
            className="rounded-md border border-input p-2 hover:bg-accent hover:text-foreground"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
      </div>

      {error ? <p className="mb-3 text-destructive">{error}</p> : null}
      {syncMessage ? <p className="mb-3 text-sm text-emerald-500 dark:text-emerald-400">{syncMessage}</p> : null}

      <DataTable
        rows={providers}
        rowKey={(row) => row.id}
        columns={[
          {
            key: "id",
            header: "ID",
            render: (row) => (
              <span className={row.containsPrimary ? "font-medium text-amber-500 dark:text-amber-400" : ""}>
                {row.id}
                {row.containsPrimary ? " ★" : ""}
              </span>
            )
          },
          { key: "api", header: "API 类型", render: (row) => row.api ?? "—" },
          { key: "baseUrl", header: "Base URL", render: (row) => row.baseUrl ?? "—" },
          {
            key: "models",
            header: "模型 / 已启用",
            render: (row) => `${row.modelCount} / ${row.enabledModelCount}`
          },
          {
            key: "actions",
            header: "操作",
            render: (row) => (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-label={`管理模型 ${row.id}`}
                  onClick={() => setModelTarget(row)}
                  className="inline-flex items-center gap-1 rounded border border-input px-2 py-1 text-xs hover:bg-accent hover:text-foreground"
                >
                  <Cpu className="h-3 w-3" />
                  模型
                </button>
                <button
                  type="button"
                  aria-label={`编辑 ${row.id}`}
                  onClick={() => openEdit(row)}
                  className="inline-flex items-center gap-1 rounded border border-input px-2 py-1 text-xs hover:bg-accent hover:text-foreground"
                >
                  <Edit3 className="h-3 w-3" />
                  编辑
                </button>
                <button
                  type="button"
                  aria-label={`同步 ${row.id}`}
                  disabled={syncing === row.id}
                  onClick={() => void handleSync(row)}
                  className="inline-flex items-center gap-1 rounded border border-primary/50 px-2 py-1 text-xs text-primary hover:bg-primary/10 disabled:opacity-40"
                >
                  <RotateCw className="h-3 w-3" />
                  同步
                </button>
                <button
                  type="button"
                  aria-label={`删除 ${row.id}`}
                  onClick={() => void openDelete(row)}
                  className="inline-flex items-center gap-1 rounded border border-destructive/50 px-2 py-1 text-xs text-destructive hover:bg-destructive hover:text-destructive-foreground"
                >
                  <Trash2 className="h-3 w-3" />
                  删除
                </button>
              </div>
            )
          }
        ]}
      />

      <ProviderModelsDialog
        open={Boolean(modelTarget)}
        provider={modelTarget}
        providers={providers}
        client={client}
        onCancel={() => setModelTarget(null)}
        onChanged={() => {
          void load();
          onRefresh?.();
        }}
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
      </ConfirmDialog>

      {editTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
          <div className="w-full max-w-md rounded-lg border border-border bg-card p-4 shadow-xl">
            <h2 className="text-lg font-semibold text-foreground">编辑 Provider</h2>
            <p className="mt-1 break-all text-xs text-muted-foreground">{editTarget.id}</p>
            <div className="mt-4 space-y-3">
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">baseUrl</span>
                <input
                  aria-label="Provider baseUrl"
                  value={editBaseUrl}
                  onChange={(event) => setEditBaseUrl(event.target.value)}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-foreground"
                />
              </label>
              <label className="block text-sm">
                <span className="mb-1 block text-muted-foreground">API Key 新值</span>
                <input
                  type="password"
                  aria-label="Provider API Key 新值"
                  value={editApiKey}
                  onChange={(event) => setEditApiKey(event.target.value)}
                  className="w-full rounded border border-input bg-background px-3 py-2 text-foreground"
                  autoComplete="off"
                />
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setEditTarget(null);
                  setEditApiKey("");
                }}
                className="rounded-md border border-input px-3 py-1.5 text-sm text-foreground hover:bg-accent"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmEdit()}
                className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90"
              >
                保存 Provider
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
