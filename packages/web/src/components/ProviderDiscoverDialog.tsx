import { ChevronDown, ChevronRight, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ApiClient, ProviderSummary, RemoteModelInfo } from "../api";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Switch } from "./ui/switch";

/** 与 core MAX_PROVIDER_MODELS 对齐（spec §5.1 / §9.2） */
const MAX_PROVIDER_MODELS = 20;

interface ProviderDiscoverDialogProps {
  open: boolean;
  provider: ProviderSummary | null;
  client: ApiClient;
  onCancel: () => void;
  onAdded: (result: { addedCount: number; enabled: boolean }) => void;
}

interface ModelGroup {
  key: string;
  models: RemoteModelInfo[];
}

/** 按 model id 第一个 `/` 前缀分组；无斜杠归入「其他」 */
function groupRemoteModels(models: RemoteModelInfo[]): ModelGroup[] {
  const map = new Map<string, RemoteModelInfo[]>();
  for (const model of models) {
    const slash = model.id.indexOf("/");
    const key = slash === -1 ? "其他" : model.id.slice(0, slash);
    const list = map.get(key);
    if (list) list.push(model);
    else map.set(key, [model]);
  }
  const groups = Array.from(map.entries()).map(([key, groupModels]) => ({
    key,
    models: groupModels.slice().sort((a, b) => a.id.localeCompare(b.id))
  }));
  groups.sort((a, b) => {
    if (a.key === "其他") return 1;
    if (b.key === "其他") return -1;
    return a.key.localeCompare(b.key);
  });
  return groups;
}

/** Provider 远端模型发现与按需添加弹窗 */
export function ProviderDiscoverDialog({
  open,
  provider,
  client,
  onCancel,
  onAdded
}: ProviderDiscoverDialogProps) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unsupportedReason, setUnsupportedReason] = useState<string | null>(null);
  const [remoteModels, setRemoteModels] = useState<RemoteModelInfo[]>([]);
  const [alreadyAddedIds, setAlreadyAddedIds] = useState<Set<string>>(new Set());
  const [truncated, setTruncated] = useState(false);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [enable, setEnable] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);

  function resetSession() {
    setLoading(false);
    setError(null);
    setUnsupportedReason(null);
    setRemoteModels([]);
    setAlreadyAddedIds(new Set());
    setTruncated(false);
    setSearch("");
    setSelectedIds(new Set());
    setEnable(false);
    setCollapsedGroups(new Set());
    setSubmitting(false);
  }

  async function loadDiscover() {
    if (!provider) return;
    setLoading(true);
    setError(null);
    setUnsupportedReason(null);
    setRemoteModels([]);
    setAlreadyAddedIds(new Set());
    setTruncated(false);
    setSelectedIds(new Set());
    try {
      const result = await client.discoverProvider(provider.id);
      if (result.unsupportedReason) {
        setUnsupportedReason(result.unsupportedReason);
        return;
      }
      setRemoteModels(result.remoteModels);
      setAlreadyAddedIds(new Set(result.alreadyAddedIds));
      setTruncated(result.truncated);
    } catch (err) {
      setError(err instanceof Error ? err.message : "发现模型失败");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) {
      resetSession();
      return;
    }
    if (provider) void loadDiscover();
  }, [open, provider?.id]);

  const filteredModels = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return remoteModels;
    return remoteModels.filter((model) => {
      const idMatch = model.id.toLowerCase().includes(q);
      const nameMatch = model.name?.toLowerCase().includes(q) ?? false;
      return idMatch || nameMatch;
    });
  }, [remoteModels, search]);

  const groups = useMemo(() => groupRemoteModels(filteredModels), [filteredModels]);

  const alreadyAddedCount = provider?.modelCount ?? alreadyAddedIds.size;
  const newlySelected = selectedIds.size;
  const remainingSlots = Math.max(0, MAX_PROVIDER_MODELS - alreadyAddedCount);
  const overCapacity = alreadyAddedCount + newlySelected > MAX_PROVIDER_MODELS;
  const canSubmit =
    newlySelected > 0 &&
    !overCapacity &&
    !submitting &&
    !loading &&
    !unsupportedReason &&
    !provider?.disabled;

  function toggleSelect(id: string) {
    if (alreadyAddedIds.has(id)) return;
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleGroup(key: string) {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleSubmit() {
    if (!provider || !canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      // 会话内 name 一并提交；服务端不重新 discover
      const models = Array.from(selectedIds).map((id) => {
        const remote = remoteModels.find((entry) => entry.id === id);
        const item: { id: string; name?: string } = { id };
        if (remote?.name) item.name = remote.name;
        return item;
      });
      const result = await client.batchAddProviderModels(provider.id, { models, enable });
      onAdded({ addedCount: result.addedModelIds.length, enabled: result.enabled });
    } catch (err) {
      setError(err instanceof Error ? err.message : "添加模型失败");
      setSubmitting(false);
    }
  }

  function handleOpenChange(val: boolean) {
    if (!val) onCancel();
  }

  if (!provider) return null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>发现模型 — {provider.id}</DialogTitle>
          <DialogDescription>
            从远端拉取模型目录，勾选后添加到本地配置。关闭弹窗将丢弃本次列表。
          </DialogDescription>
        </DialogHeader>

        {truncated ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-400">
            远端列表可能不完整（已达拉取上限）
          </p>
        ) : null}

        {error ? <p className="text-sm text-destructive font-medium">{error}</p> : null}

        {loading ? (
          <p className="py-8 text-center text-sm text-muted-foreground">正在发现远端模型…</p>
        ) : unsupportedReason ? (
          <div className="space-y-2 py-6 text-sm">
            <p className="text-muted-foreground">该 Provider 不支持自动发现：{unsupportedReason}</p>
            <p className="text-muted-foreground">请使用「模型」弹窗手动添加。</p>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                aria-label="搜索远端模型"
                placeholder="搜索 id 或名称…"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="pl-8"
              />
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto rounded-md border border-border">
              {groups.length === 0 ? (
                <p className="p-4 text-sm text-muted-foreground">无匹配的远端模型</p>
              ) : (
                groups.map((group) => {
                  const collapsed = collapsedGroups.has(group.key);
                  return (
                    <div key={group.key} className="border-b border-border last:border-b-0">
                      <button
                        type="button"
                        aria-expanded={!collapsed}
                        aria-label={`分组 ${group.key}`}
                        onClick={() => toggleGroup(group.key)}
                        className="flex w-full items-center gap-2 bg-muted/40 px-3 py-2 text-left text-sm font-medium hover:bg-muted/70"
                      >
                        {collapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                        <span>{group.key}</span>
                        <span className="text-xs text-muted-foreground">({group.models.length})</span>
                      </button>
                      {!collapsed ? (
                        <ul className="divide-y divide-border">
                          {group.models.map((model) => {
                            const added = alreadyAddedIds.has(model.id);
                            const checked = added || selectedIds.has(model.id);
                            return (
                              <li key={model.id}>
                                <label
                                  className={`flex cursor-pointer items-start gap-3 px-3 py-2 text-sm ${
                                    added ? "cursor-not-allowed opacity-60" : "hover:bg-accent/50"
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    aria-label={`选择模型 ${model.id}`}
                                    checked={checked}
                                    disabled={added}
                                    onChange={() => toggleSelect(model.id)}
                                    className="mt-0.5"
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className="break-all font-medium">{model.id}</span>
                                    {model.name ? (
                                      <span className="ml-2 text-muted-foreground">{model.name}</span>
                                    ) : null}
                                    {added ? (
                                      <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                                        已添加
                                      </span>
                                    ) : null}
                                  </span>
                                </label>
                              </li>
                            );
                          })}
                        </ul>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          </>
        )}

        <DialogFooter className="flex-col items-stretch gap-3 sm:flex-col">
          <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">
              已选 {newlySelected} 个
              {overCapacity
                ? ` · 超出上限（剩余可添加 ${remainingSlots} 个）`
                : ` · 剩余可添加 ${remainingSlots} 个`}
            </span>
            <div className="flex items-center gap-2">
              <Switch
                id="discover-enable"
                checked={enable}
                onCheckedChange={(value) => setEnable(value === true)}
                disabled={Boolean(unsupportedReason) || loading || provider.disabled}
                aria-label="同时启用"
              />
              <Label htmlFor="discover-enable" className="cursor-pointer">
                同时启用
              </Label>
            </div>
          </div>
          {provider.disabled ? (
            <p className="text-sm text-amber-600 dark:text-amber-400">
              该 Provider 已关闭，仅可浏览；请先恢复后再添加模型。
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground"
            >
              关闭
            </button>
            <button
              type="button"
              disabled={!canSubmit}
              onClick={() => void handleSubmit()}
              className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {submitting ? "添加中…" : "添加到配置"}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
