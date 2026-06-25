import { Edit3, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ApiClient, ModelSummary, ProviderModelInput, ProviderSummary } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { DataTable } from "./DataTable";
import { ModelDialog } from "./ModelDialog";

interface ProviderModelsDialogProps {
  open: boolean;
  provider: ProviderSummary | null;
  providers: ProviderSummary[];
  client: ApiClient;
  onCancel: () => void;
  onChanged: () => void;
}

/** Provider 专属模型管理弹窗 */
export function ProviderModelsDialog({ open, provider, providers, client, onCancel, onChanged }: ProviderModelsDialogProps) {
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ModelSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelSummary | null>(null);
  const [newPrimary, setNewPrimary] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function load() {
    if (!provider) return;
    setError(null);
    try {
      const { models: list } = await client.getModels();
      setModels(list);
      const candidates = list.filter((entry) => entry.ref !== deleteTarget?.ref);
      setNewPrimary(candidates[0]?.ref ?? "");
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载模型失败");
    }
  }

  useEffect(() => {
    if (open) void load();
  }, [open, provider?.id]);

  const scopedModels = useMemo(
    () => models.filter((entry) => entry.providerId === provider?.id),
    [models, provider?.id]
  );

  if (!open || !provider) return null;

  function openDelete(row: ModelSummary) {
    setDeleteTarget(row);
    setNewPrimary(row.isPrimary ? models.find((entry) => entry.ref !== row.ref)?.ref ?? "" : "");
  }

  async function saveCreate(providerId: string, model: ProviderModelInput) {
    await client.createModel(providerId, model);
    setCreating(false);
    await load();
    onChanged();
  }

  async function saveEdit(_providerId: string, model: ProviderModelInput) {
    if (!editing) return;
    await client.updateModel(editing.ref, model);
    setEditing(null);
    await load();
    onChanged();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    if (deleteTarget.isPrimary && !newPrimary) {
      setError("删除当前主模型前请选择新的主模型");
      return;
    }
    await client.deleteModel(deleteTarget.ref, deleteTarget.isPrimary ? { newPrimary } : {});
    setDeleteTarget(null);
    await load();
    onChanged();
  }

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-lg border border-slate-600 bg-slate-900 p-4 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-100">{provider.id} 模型</h2>
          <div className="flex gap-2">
            <button type="button" onClick={() => setCreating(true)} className="inline-flex items-center gap-1 rounded bg-sky-600 px-3 py-1.5 text-sm text-white hover:bg-sky-500">
              <Plus className="h-4 w-4" />
              添加模型
            </button>
            <button type="button" onClick={onCancel} className="rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-200 hover:bg-slate-800">关闭</button>
          </div>
        </div>
        {error ? <p className="mb-3 text-sm text-red-400">{error}</p> : null}
        <DataTable
          rows={scopedModels}
          rowKey={(row) => row.ref}
          emptyMessage="该 Provider 暂无模型"
          columns={[
            { key: "ref", header: "引用", render: (row) => row.ref },
            { key: "alias", header: "别名", render: (row) => row.alias ?? "-" },
            { key: "enabled", header: "状态", render: (row) => (row.enabled ? "已启用" : "已禁用") },
            {
              key: "actions",
              header: "操作",
              render: (row) => (
                <div className="flex flex-wrap gap-2">
                  <button type="button" aria-label={`编辑模型 ${row.ref}`} onClick={() => setEditing(row)} className="inline-flex items-center gap-1 rounded border border-slate-600 px-2 py-1 text-xs hover:bg-slate-800">
                    <Edit3 className="h-3 w-3" />
                    编辑
                  </button>
                  <button type="button" aria-label={`删除模型 ${row.ref}`} onClick={() => openDelete(row)} className="inline-flex items-center gap-1 rounded border border-red-700/50 px-2 py-1 text-xs text-red-300 hover:bg-red-900/30">
                    <Trash2 className="h-3 w-3" />
                    删除
                  </button>
                </div>
              )
            }
          ]}
        />
        <ModelDialog open={creating} mode="create" providers={providers} fixedProviderId={provider.id} onCancel={() => setCreating(false)} onSave={saveCreate} />
        <ModelDialog open={Boolean(editing)} mode="edit" providers={providers} fixedProviderId={provider.id} {...(editing ? { model: editing } : {})} onCancel={() => setEditing(null)} onSave={saveEdit} />
        <ConfirmDialog
          open={Boolean(deleteTarget)}
          title="删除模型"
          message={`确认删除 ${deleteTarget?.ref ?? ""}？此操作将创建备份。`}
          danger
          onCancel={() => setDeleteTarget(null)}
          onConfirm={() => void confirmDelete()}
        >
          {deleteTarget?.isPrimary ? (
            <label className="block text-sm">
              <span className="mb-1 block text-slate-400">新主模型</span>
              <select aria-label="新主模型" value={newPrimary} onChange={(event) => setNewPrimary(event.target.value)} className="w-full rounded border border-slate-600 bg-slate-950 px-3 py-2 text-slate-100">
                {models.filter((entry) => entry.ref !== deleteTarget.ref).map((entry) => (
                  <option key={entry.ref} value={entry.ref}>{entry.ref}</option>
                ))}
              </select>
            </label>
          ) : null}
        </ConfirmDialog>
      </div>
    </div>
  );
}
