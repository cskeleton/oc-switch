import { useEffect, useMemo, useState } from "react";
import type { ApiClient, CaseDuplicateGroup, ConfigDiffSummary, ModelSummary } from "../api";
import { ConfirmDialog } from "./ConfirmDialog";

interface MergeCaseDuplicateDialogProps {
  open: boolean;
  group: CaseDuplicateGroup | null;
  client: ApiClient;
  onCancel: () => void;
  onMerged: () => void;
}

/** 取 ModelRef 的 provider 前缀 */
function refPrefix(ref: string): string {
  const i = ref.indexOf("/");
  return i > 0 ? ref.slice(0, i) : ref;
}

/** Provider 大小写重复合并向导：用户选 canonical → 选保留模型 → preview diff → 提交 */
export function MergeCaseDuplicateDialog({ open, group, client, onCancel, onMerged }: MergeCaseDuplicateDialogProps) {
  const [canonicalId, setCanonicalId] = useState("");
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [keep, setKeep] = useState<Record<string, boolean>>({});
  const [diff, setDiff] = useState<ConfigDiffSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 组内并集模型 id（来自 provider 块与 allowlist 两侧）
  const groupModelIds = useMemo(() => {
    if (!group) return [] as string[];
    const ids = new Set(group.ids);
    return [...new Set(models.filter((m) => ids.has(m.providerId)).map((m) => m.modelId))].sort();
  }, [group, models]);

  // 主模型对应的组内模型 id（不可取消保留）
  const primaryModelId = useMemo(() => {
    const primary = group?.details.primaryModel;
    if (!primary || !group) return undefined;
    return group.ids.includes(refPrefix(primary)) ? primary.slice(refPrefix(primary).length + 1) : undefined;
  }, [group]);

  useEffect(() => {
    if (!open || !group) return;
    setCanonicalId(group.canonicalId);
    setDiff(null);
    setError(null);
    void client.getModels().then(({ models: list }) => setModels(list)).catch(() => setModels([]));
  }, [open, group, client]);

  useEffect(() => {
    setKeep(Object.fromEntries(groupModelIds.map((id) => [id, true])));
  }, [groupModelIds]);

  if (!open || !group) return null;

  const removeIds = group.ids.filter((id) => id !== canonicalId);
  const keepModelIds = groupModelIds.filter((id) => keep[id] ?? true);
  const mergeInput = { groupKey: group.groupKey, canonicalId, removeIds, keepModelIds };

  async function preview() {
    setError(null);
    try {
      setDiff(await client.previewMergeCaseDuplicates(mergeInput));
    } catch (err) {
      setError(err instanceof Error ? err.message : "预览失败");
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await client.mergeCaseDuplicates(mergeInput);
      onMerged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "合并失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title={`合并 Provider「${group.groupKey}」`}
      message={`将 ${removeIds.join(", ")} 合并到 ${canonicalId}。已选模型与启用项会迁移，不会删除 API Key。`}
      danger
      confirmDisabled={busy || removeIds.length === 0 || keepModelIds.length === 0}
      onCancel={onCancel}
      onConfirm={() => void submit()}
    >
      <div className="grid gap-3 text-sm">
        <label className="grid gap-1">
          <span className="text-muted-foreground">保留哪个大小写（canonical）</span>
          <select
            aria-label="保留的 Provider"
            value={canonicalId}
            onChange={(event) => { setCanonicalId(event.target.value); setDiff(null); }}
            className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          >
            {group.ids.map((id) => <option key={id} value={id}>{id === group.canonicalId ? `${id}（建议）` : id}</option>)}
          </select>
        </label>

        <div className="grid gap-1">
          <span className="text-muted-foreground">保留的模型</span>
          <div className="max-h-48 overflow-y-auto rounded-md border border-border p-2">
            {groupModelIds.length === 0 ? (
              <span className="text-muted-foreground">加载中…</span>
            ) : groupModelIds.map((id) => {
              const locked = id === primaryModelId;
              return (
                <label key={id} className="flex items-center gap-2 py-0.5">
                  <input
                    type="checkbox"
                    aria-label={`保留模型 ${id}`}
                    checked={locked ? true : (keep[id] ?? true)}
                    disabled={locked}
                    onChange={(event) => { setKeep((prev) => ({ ...prev, [id]: event.target.checked })); setDiff(null); }}
                  />
                  <span className="break-all">{id}{locked ? "（主模型，必须保留）" : ""}</span>
                </label>
              );
            })}
          </div>
        </div>

        <button type="button" onClick={() => void preview()} className="justify-self-start rounded-md border border-input px-3 py-1.5 text-sm hover:bg-accent">
          预览改动
        </button>
        {diff ? (
          <ul className="max-h-48 list-inside list-disc space-y-1 overflow-y-auto rounded-md border border-border p-2 text-muted-foreground">
            {diff.providersRemoved.map((p) => <li key={p} className="break-all">删除 Provider {p}</li>)}
            {diff.modelsEnabled.map((m) => <li key={`e${m}`} className="break-all">启用 {m}</li>)}
            {diff.modelsDisabled.map((m) => <li key={`d${m}`} className="break-all">移除 {m}</li>)}
            {diff.primaryChanged ? <li>主模型 {diff.primaryChanged.before ?? "(无)"} → {diff.primaryChanged.after ?? "(无)"}</li> : null}
          </ul>
        ) : null}
        {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}
      </div>
    </ConfirmDialog>
  );
}
