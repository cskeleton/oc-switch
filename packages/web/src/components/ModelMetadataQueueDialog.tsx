import { ListChecks } from "lucide-react";
import { useEffect, useState } from "react";
import type { ApiClient, ModelMetadataQueueItem, ModelMetadataQueueResolveItem } from "../api";
import { EmptyState } from "./EmptyState";
import { useToast } from "./Toast";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { Pill } from "./ui/pill";

interface ModelMetadataQueueDialogProps {
  open: boolean;
  providerId?: string | undefined;
  client: ApiClient;
  onClose: () => void;
  onChanged: () => void;
}

/** 队列项选择态的 key（modelId 自身可能含 `/`，providerId 为第一段） */
function queueItemKey(item: ModelMetadataQueueItem): string {
  return `${item.providerId}/${item.modelId}`;
}

/** 参数确认队列：多候选匹配置顶等待用户选择应用或忽略 */
export function ModelMetadataQueueDialog({ open, providerId, client, onClose, onChanged }: ModelMetadataQueueDialogProps) {
  const toast = useToast();
  const [items, setItems] = useState<ModelMetadataQueueItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 每项当前选中的候选 catalogKey；默认 candidates[0] */
  const [selections, setSelections] = useState<Record<string, string>>({});

  async function loadQueue() {
    setLoading(true);
    setError(null);
    try {
      const result = await client.getModelMetadataSyncQueue(providerId);
      const list = Array.isArray(result.items) ? result.items : [];
      setItems(list);
      setSelections((prev) => {
        const next = { ...prev };
        for (const item of list) {
          const key = queueItemKey(item);
          if (!next[key] && item.candidates[0]) next[key] = item.candidates[0].catalogKey;
        }
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载参数待确认队列失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setSelections({});
    void loadQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, providerId]);

  async function submitResolve(item: ModelMetadataQueueItem, action: "accept" | "dismiss") {
    if (busy) return;
    const selected = selections[queueItemKey(item)] ?? item.candidates[0]?.catalogKey;
    if (action === "accept" && !selected) return;
    setBusy(true);
    try {
      const payload: ModelMetadataQueueResolveItem[] = [
        action === "accept"
          ? { providerId: item.providerId, modelId: item.modelId, action: "accept", catalogKey: selected! }
          : { providerId: item.providerId, modelId: item.modelId, action: "dismiss" }
      ];
      const result = await client.resolveModelMetadataSyncQueue(payload);
      if (result.failed.length > 0) {
        toast.error(result.failed[0]?.error ?? "队列处理失败");
      } else {
        toast.success(
          action === "accept"
            ? `已应用 ${item.providerId}/${item.modelId} 的参数`
            : `已忽略 ${item.providerId}/${item.modelId}`
        );
      }
      await loadQueue();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "队列处理失败");
    } finally {
      setBusy(false);
    }
  }

  // 已忽略项沉底展示，组内保持原顺序
  const orderedItems = [...items.filter((item) => !item.dismissed), ...items.filter((item) => item.dismissed)];

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) onClose(); }}>
      <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>参数待确认</DialogTitle>
          <DialogDescription>
            {providerId
              ? `${providerId} 的多候选参数匹配，选择候选后应用，或忽略该模型`
              : "全部 Provider 的多候选参数匹配，选择候选后应用，或忽略该模型"}
          </DialogDescription>
        </DialogHeader>

        {error ? <p className="mb-3 text-sm text-destructive font-medium">{error}</p> : null}

        {orderedItems.length === 0 && !loading ? (
          <EmptyState icon={ListChecks} title="暂无待确认项" description="多候选参数匹配会在这里等待确认" />
        ) : (
          <ul className="space-y-3 py-1">
            {orderedItems.map((item) => {
              const key = queueItemKey(item);
              const selected = selections[key] ?? item.candidates[0]?.catalogKey;
              return (
                <li
                  key={key}
                  className={`rounded-md border border-border px-3 py-2 ${item.dismissed ? "opacity-60" : ""}`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <span className="font-mono">{item.providerId}/{item.modelId}</span>
                      <span className="text-xs text-muted-foreground">{item.candidates.length} 个候选</span>
                      {item.dismissed ? <Pill variant="muted">已忽略</Pill> : null}
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        size="sm"
                        aria-label={`应用候选 ${selected ?? ""}`}
                        disabled={busy || item.dismissed || !selected}
                        onClick={() => void submitResolve(item, "accept")}
                      >
                        应用
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={`忽略 ${item.providerId}/${item.modelId}`}
                        disabled={busy || item.dismissed}
                        onClick={() => void submitResolve(item, "dismiss")}
                      >
                        忽略
                      </Button>
                    </div>
                  </div>
                  <div className="mt-2 space-y-1">
                    {item.candidates.map((candidate) => (
                      <label key={candidate.catalogKey} className="flex flex-wrap items-center gap-2 text-xs">
                        <input
                          type="radio"
                          name={`candidate-${item.providerId}-${item.modelId}`}
                          checked={selected === candidate.catalogKey}
                          disabled={busy || item.dismissed}
                          onChange={() => setSelections((prev) => ({ ...prev, [key]: candidate.catalogKey }))}
                        />
                        <span className="font-mono text-foreground">{candidate.catalogKey}</span>
                        <span className="text-muted-foreground">匹配度 {candidate.score.toFixed(2)}</span>
                        {candidate.metadata.contextWindow !== undefined ? (
                          <span className="text-muted-foreground">上下文 {candidate.metadata.contextWindow}</span>
                        ) : null}
                        {candidate.metadata.maxTokens !== undefined ? (
                          <span className="text-muted-foreground">最大输出 {candidate.metadata.maxTokens}</span>
                        ) : null}
                      </label>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
