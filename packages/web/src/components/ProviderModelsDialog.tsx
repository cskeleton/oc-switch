import { Edit3, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ApiClient, ModelSummary, ProviderModelInput, ProviderSummary } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { DataTable } from "./DataTable";
import { ModelDialog } from "./ModelDialog";
import { useToast } from "./Toast";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "./ui/dialog";
import { Label } from "./ui/label";
import { Pill } from "./ui/pill";

interface ProviderModelsDialogProps {
  open: boolean;
  provider: ProviderSummary | null;
  providers: ProviderSummary[];
  client: ApiClient;
  onCancel: () => void;
  onChanged: () => void;
}

/** 本地模型排序：主模型 → 已启用 → 未启用；同组内按 modelId 稳定排序 */
export function sortLocalModels(a: ModelSummary, b: ModelSummary): number {
  const rank = (m: ModelSummary) => (m.isPrimary ? 0 : m.enabled ? 1 : 2);
  const d = rank(a) - rank(b);
  return d !== 0 ? d : a.modelId.localeCompare(b.modelId);
}

/** Provider 专属模型管理弹窗 */
export function ProviderModelsDialog({ open, provider, providers, client, onCancel, onChanged }: ProviderModelsDialogProps) {
  const toast = useToast();
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ModelSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ModelSummary | null>(null);
  const [newPrimary, setNewPrimary] = useState("");
  const [error, setError] = useState<string | null>(null);
  /** 多选：存 raw modelId（非完整 ref） */
  const [selectedModelIds, setSelectedModelIds] = useState<Set<string>>(new Set());
  const [confirmBatchDelete, setConfirmBatchDelete] = useState(false);
  const [confirmKeepEnabledOnly, setConfirmKeepEnabledOnly] = useState(false);
  const [batchBusy, setBatchBusy] = useState(false);

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
    if (open) {
      setSelectedModelIds(new Set());
      setConfirmBatchDelete(false);
      setConfirmKeepEnabledOnly(false);
      setError(null);
      void load();
    }
  }, [open, provider?.id]);

  const scopedModels = useMemo(
    () => models.filter((entry) => entry.providerId === provider?.id).slice().sort(sortLocalModels),
    [models, provider?.id]
  );

  function toggleSelect(modelId: string, isPrimary: boolean) {
    if (isPrimary) return;
    setSelectedModelIds((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  }

  function openDelete(row: ModelSummary) {
    setDeleteTarget(row);
    setNewPrimary(row.isPrimary ? models.find((entry) => entry.ref !== row.ref)?.ref ?? "" : "");
  }

  async function saveCreate(providerId: string, model: ProviderModelInput) {
    await client.createModel(providerId, model);
    setCreating(false);
    toast.success(`已添加模型 ${providerId}/${model.id}`);
    await load();
    onChanged();
  }

  async function saveEdit(_providerId: string, model: ProviderModelInput) {
    if (!editing) return;
    await client.updateModel(editing.ref, model);
    setEditing(null);
    toast.success(`模型 ${editing.ref} 已更新`);
    await load();
    onChanged();
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    if (deleteTarget.isPrimary && !newPrimary) {
      toast.error("删除当前主模型前请选择新的主模型");
      return;
    }
    try {
      await client.deleteModel(deleteTarget.ref, deleteTarget.isPrimary ? { newPrimary } : {});
      setDeleteTarget(null);
      toast.success(`已删除模型 ${deleteTarget.ref}`);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "删除模型失败");
    }
  }

  async function runBatchRemove(body: { modelIds: string[] } | { keepEnabledOnly: true }) {
    if (!provider || batchBusy) return;
    setBatchBusy(true);
    setError(null);
    try {
      const result = await client.batchRemoveProviderModels(provider.id, body);
      setSelectedModelIds(new Set());
      setConfirmBatchDelete(false);
      setConfirmKeepEnabledOnly(false);
      toast.success(`已从目录删除 ${result.removedModelIds.length} 个模型`);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "批量删除失败");
      setConfirmBatchDelete(false);
      setConfirmKeepEnabledOnly(false);
    } finally {
      setBatchBusy(false);
    }
  }

  async function runSyncMetadata() {
    if (!provider || batchBusy) return;
    setBatchBusy(true);
    try {
      // 有勾选同步勾选，无勾选同步该 provider 全部本地模型
      const body = selectedModelIds.size > 0 ? { modelIds: [...selectedModelIds] } : {};
      const result = await client.syncProviderModelMetadata(provider.id, body);
      toast.success(`已回填 ${result.updated.length}，待确认 ${result.queued.length}，未匹配 ${result.unmatched.length}`);
      await load();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "同步参数失败");
    } finally {
      setBatchBusy(false);
    }
  }

  const selectClassName = "flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-base shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring md:text-sm";
  const selectedCount = selectedModelIds.size;
  // 插件 provider 的模型目录来自插件 manifest，只读：批量删除 / 只保留已启用 / 同步参数 / 增删改一律不可用
  const isPlugin = provider?.source === "plugin";

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
                  {isPlugin
                    ? "插件 Provider 的模型目录只读：可在 Models 页启停模型与设为主模型，不能在此增删改。"
                    : provider.disabled
                      ? "该 Provider 已关闭：不可新增或启用模型，仍可批量清理目录。"
                      : `管理 ${provider.id} 下的模型`}
                </DialogDescription>
              </div>
              <div className="flex flex-wrap gap-2 mr-6">
                <Button
                  variant="destructive"
                  size="sm"
                  aria-label="删除所选模型"
                  disabled={isPlugin || selectedCount === 0 || batchBusy}
                  title={isPlugin ? "插件 Provider 的模型目录只读" : "关闭状态下仍可批量清理目录（不可新增/启用）"}
                  onClick={() => setConfirmBatchDelete(true)}
                >
                  <Trash2 className="h-4 w-4" />
                  删除所选{selectedCount > 0 ? ` (${selectedCount})` : ""}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="同步所选模型参数"
                  disabled={isPlugin || batchBusy}
                  title={
                    isPlugin
                      ? "插件 Provider 的模型参数由插件 manifest 提供，无法回填"
                      : selectedCount > 0 ? `同步已选 ${selectedCount} 个模型的参数` : "同步该 Provider 全部本地模型的参数"
                  }
                  onClick={() => void runSyncMetadata()}
                >
                  同步参数
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  aria-label="只保留已启用模型"
                  disabled={isPlugin || batchBusy || scopedModels.length === 0}
                  title={isPlugin ? "插件 Provider 的模型目录只读" : "关闭状态下仍可清理未启用模型，便于目录降到上限以内"}
                  onClick={() => setConfirmKeepEnabledOnly(true)}
                >
                  只保留已启用
                </Button>
                <Button
                  size="sm"
                  aria-label="添加模型"
                  disabled={isPlugin || provider.disabled}
                  title={
                    isPlugin
                      ? "插件 Provider 的模型目录只读，无法添加模型"
                      : provider.disabled ? "该 Provider 已关闭，请先恢复 Provider 后再启用模型" : undefined
                  }
                  onClick={() => setCreating(true)}
                >
                  <Plus className="h-4 w-4" />
                  添加模型
                </Button>
              </div>
            </DialogHeader>

            {error ? <p className="mb-3 text-sm text-destructive font-medium">{error}</p> : null}

            <div className="py-2">
              <DataTable
                rows={scopedModels}
                rowKey={(row) => row.ref}
                emptyMessage="该 Provider 暂无模型"
                minWidthClass="min-w-[38rem]"
                columns={[
                  {
                    key: "select",
                    header: "",
                    wrap: "nowrap",
                    className: "w-10",
                    render: (row) => (
                      <input
                        type="checkbox"
                        aria-label={`选择本地模型 ${row.modelId}`}
                        checked={selectedModelIds.has(row.modelId)}
                        disabled={isPlugin || row.isPrimary || batchBusy}
                        title={
                          isPlugin
                            ? "插件 Provider 的模型目录只读"
                            : row.isPrimary ? "主模型不可批量删除，请先切换主模型" : undefined
                        }
                        onChange={() => toggleSelect(row.modelId, row.isPrimary)}
                        className="mt-0.5"
                      />
                    )
                  },
                  { key: "ref", header: "引用", wrap: "anywhere", render: (row) => row.ref },
                  { key: "alias", header: "别名", render: (row) => row.alias ?? "-" },
                  {
                    key: "enabled",
                    header: "状态",
                    wrap: "nowrap",
                    render: (row) => {
                      if (row.isPrimary) return <Pill variant="brand">主模型</Pill>;
                      return row.enabled
                        ? <Pill variant="success">已启用</Pill>
                        : <Pill variant="muted">已禁用</Pill>;
                    }
                  },
                  {
                    key: "actions",
                    header: "操作",
                    wrap: "nowrap",
                    render: (row) => (
                      isPlugin ? (
                        <span className="text-xs text-muted-foreground">只读</span>
                      ) : (
                      <div className="flex flex-wrap gap-1.5">
                        <Button variant="outline" size="sm" aria-label={`编辑模型 ${row.ref}`} onClick={() => setEditing(row)}>
                          <Edit3 className="h-3 w-3" />
                          编辑
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          aria-label={`删除模型 ${row.ref}`}
                          onClick={() => openDelete(row)}
                          className="text-destructive hover:text-destructive"
                        >
                          <Trash2 className="h-3 w-3" />
                          删除
                        </Button>
                      </div>
                      )
                    )
                  }
                ]}
              />
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={onCancel}>
                关闭
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      <ModelDialog open={creating} mode="create" providers={providers} fixedProviderId={provider?.id} onCancel={() => setCreating(false)} onSave={saveCreate} onLookupMetadata={client.getModelMetadataSuggestions} />
      <ModelDialog open={Boolean(editing)} mode="edit" providers={providers} fixedProviderId={provider?.id} {...(editing ? { model: editing } : {})} onCancel={() => setEditing(null)} onSave={saveEdit} onLookupMetadata={client.getModelMetadataSuggestions} />

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

      <ConfirmDialog
        open={confirmBatchDelete}
        title="删除所选模型"
        message={`确认从目录删除已选的 ${selectedCount} 个模型？已启用项会同步移出 allowlist。此操作将创建备份。`}
        danger
        confirmDisabled={batchBusy || selectedCount === 0}
        onCancel={() => setConfirmBatchDelete(false)}
        onConfirm={() => void runBatchRemove({ modelIds: Array.from(selectedModelIds) })}
      />

      <ConfirmDialog
        open={confirmKeepEnabledOnly}
        title="只保留已启用"
        message="将从目录移除未启用的模型。主模型始终保留。不会删除 Provider，也不会修改 API Key。若主模型已不在目录，操作将失败并提示先修复配置。"
        danger
        confirmDisabled={batchBusy}
        onCancel={() => setConfirmKeepEnabledOnly(false)}
        onConfirm={() => void runBatchRemove({ keepEnabledOnly: true })}
      />
    </>
  );
}
