import { Edit3, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ApiClient, ModelSummary, ProviderModelInput, ProviderSummary } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { DataTable } from "./DataTable";
import { ModelDialog } from "./ModelDialog";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Label } from "./ui/label";

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

  const selectClassName = "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm";

  return (
    <>
      <Dialog open={open && !provider} onOpenChange={() => {}} />
      {/* 这是一个小 hack 保证没有 provider 时什么都不渲染，因为下面是 <Dialog open={open}>，我们希望 provider 为 null 时不渲染主 Dialog */}
      {provider && (
        <Dialog open={open} onOpenChange={(val) => { if (!val) onCancel(); }}>
          <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
            <DialogHeader className="flex-row items-center justify-between space-y-0">
              <div className="flex flex-col space-y-1.5">
                <DialogTitle>{provider.id} 模型</DialogTitle>
                <DialogDescription>
                  管理 {provider.id} 下的模型
                </DialogDescription>
              </div>
              <div className="flex gap-2 mr-6">
                <button type="button" onClick={() => setCreating(true)} className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 font-medium shadow-sm">
                  <Plus className="h-4 w-4" />
                  添加模型
                </button>
              </div>
            </DialogHeader>

            {error ? <p className="mb-3 text-sm text-destructive font-medium">{error}</p> : null}

            <div className="py-2">
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
                        <button type="button" aria-label={`编辑模型 ${row.ref}`} onClick={() => setEditing(row)} className="inline-flex items-center gap-1 rounded border border-input bg-background px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground font-medium shadow-sm">
                          <Edit3 className="h-3 w-3" />
                          编辑
                        </button>
                        <button type="button" aria-label={`删除模型 ${row.ref}`} onClick={() => openDelete(row)} className="inline-flex items-center gap-1 rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive hover:bg-destructive hover:text-destructive-foreground font-medium shadow-sm">
                          <Trash2 className="h-3 w-3" />
                          删除
                        </button>
                      </div>
                    )
                  }
                ]}
              />
            </div>

            <DialogFooter>
              <button type="button" onClick={onCancel} className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground">
                关闭
              </button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <ModelDialog open={creating} mode="create" providers={providers} fixedProviderId={provider?.id} onCancel={() => setCreating(false)} onSave={saveCreate} />
      <ModelDialog open={Boolean(editing)} mode="edit" providers={providers} fixedProviderId={provider?.id} {...(editing ? { model: editing } : {})} onCancel={() => setEditing(null)} onSave={saveEdit} />

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
            <Label>新主模型</Label>
            <select aria-label="新主模型" value={newPrimary} onChange={(event) => setNewPrimary(event.target.value)} className={selectClassName}>
              {models.filter((entry) => entry.ref !== deleteTarget.ref).map((entry) => (
                <option key={entry.ref} value={entry.ref}>{entry.ref}</option>
              ))}
            </select>
          </div>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
