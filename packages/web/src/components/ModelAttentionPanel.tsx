import { useCallback, useEffect, useState } from "react";
import type { ApiClient, ModelAttentionIssue, ModelAttentionReport, ModelInventory } from "../api";
import { Button } from "./ui/button";
import { Pill } from "./ui/pill";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";

interface Props {
  client: ApiClient;
  inventory: ModelInventory | null;
  onChanged?: () => void | Promise<void>;
  onConfigure?: ((providerId: string) => void) | undefined;
}

/** 三个页面共享同一问题源与操作器；不会从 availability 猜测待办。 */
export function ModelAttentionPanel({ client, inventory, onChanged, onConfigure }: Props) {
  const [report, setReport] = useState<ModelAttentionReport>({ pending: [], ignored: [] });
  const [expanded, setExpanded] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [target, setTarget] = useState<ModelAttentionIssue | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [cleanupMetadata, setCleanupMetadata] = useState(false);
  const [replacement, setReplacement] = useState("");
  const load = useCallback(async () => {
    if (inventory?.schemaVersion !== 2) return;
    try {
      const next = await client.getModelAttention();
      if (!Array.isArray(next.pending) || !Array.isArray(next.ignored)) throw new Error("提醒协议不兼容，请重启服务。");
      setReport(next); setError(null);
    } catch (err) { setError(err instanceof Error ? err.message : "无法读取问题状态"); }
  }, [client, inventory]);
  useEffect(() => { void load(); }, [load]);
  if (inventory?.schemaVersion !== 2) return null;

  const ignored = target ? report.ignored.some(i => i.id === target.id) : false;
  const plugin = inventory.plugins.find(p => p.id === target?.ownerId);
  const hasMetadata = !!target && inventory.models.some(m => m.referenceSources.includes("legacy-metadata") && (target.ownerType === "model" ? target.refs.includes(m.ref) : target.providerIds.some(id => id.toLowerCase() === m.providerId.toLowerCase())));
  const candidates = inventory.models.filter(m => m.capabilities.canSetPrimary);

  async function decide(action: "ignore" | "restore" | "disable" | "replace" | "retry") {
    if (busy || !target) return;
    setBusy(true); setError(null); setNotice(null);
    try {
      if (action === "ignore" || action === "restore") {
        setReport(await client.setAttentionIgnored(target, action === "ignore"));
      } else {
        let confirmation: boolean | undefined;
        if (action === "retry") await client.refreshModelInventory();
        else if (action === "replace") { if (!replacement) throw new Error("请选择新的主模型"); await client.setPrimary(replacement); }
        else if (target.ownerType === "plugin") confirmation = (await client.setPluginState(target.ownerId, false, cleanupMetadata)).runtimeConfirmed;
        else if (target.ownerType === "provider") confirmation = (await client.patchProviderState(target.ownerId, false, cleanupMetadata)).runtimeConfirmed;
        else await client.removeModelPolicyExactRef(target.refs[0]!, cleanupMetadata);
        if (confirmation === false) setNotice("配置已保存，等待 Gateway 应用/核验；请稍后刷新。API Key 已保留。");
        await load();
      }
      setTarget(null);
      await onChanged?.();
    } catch (err) { setError(err instanceof Error ? err.message : "操作失败"); }
    finally { setBusy(false); }
  }

  return <section aria-label="模型使用问题" className="space-y-2" data-testid="attention-panel">
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" aria-expanded={expanded && !showIgnored} onClick={() => { setShowIgnored(false); setExpanded(showIgnored || !expanded); }}>需处理 {report.pending.length}</Button>
      <Button variant="ghost" size="sm" aria-expanded={expanded && showIgnored} onClick={() => { setShowIgnored(true); setExpanded(!showIgnored || !expanded); }}>已忽略 {report.ignored.length}</Button>
      {report.pending.length === 0 && !error ? <span className="text-xs text-muted-foreground">没有需要处理的模型问题</span> : null}
    </div>
    {notice ? <p role="status" className="text-sm text-warning">{notice}</p> : null}
    {error && !target ? <p role="alert" className="text-sm text-danger">{error}</p> : null}
    {expanded ? <div className="divide-y divide-border rounded-md border border-border">
      {(showIgnored ? report.ignored : report.pending).map(issue => <div key={issue.id} className="flex items-center justify-between gap-3 px-3 py-2">
        <div className="min-w-0"><p className="break-words text-sm font-medium">{issue.title}</p><p className="text-xs text-muted-foreground">{issue.refs.length ? `影响 ${issue.refs.length} 个模型选项` : "运行探测"}{showIgnored ? " · 仅停止提醒，IM 未改变" : ""}</p></div>
        <Button variant="outline" size="sm" aria-label={`处理问题 ${issue.ownerId}`} onClick={() => { setTarget(issue); setError(null); setCleanupMetadata(false); setReplacement(""); }}>查看与处理</Button>
      </div>)}
      {(showIgnored ? report.ignored : report.pending).length === 0 ? <p className="p-3 text-sm text-muted-foreground">当前没有此类问题</p> : null}
    </div> : null}
    <Dialog open={!!target} onOpenChange={open => { if (!open && !busy) { setTarget(null); setError(null); } }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto">
        <DialogHeader><DialogTitle>{target?.title}</DialogTitle><DialogDescription>{target?.detail}</DialogDescription></DialogHeader>
        {target ? <div className="space-y-3 text-sm">
          <p className="break-words">Provider：{target.providerIds.join("、") || "运行实例"}</p>
          {target.refs.length ? <details><summary className="cursor-pointer text-muted-foreground">查看 {target.refs.length} 个受影响选项</summary><ul className="mt-2 space-y-1 break-all">{target.refs.map(ref => <li key={ref}>{ref}</li>)}</ul></details> : null}
          {plugin?.nonModelCapabilities.length ? <p className="text-warning">整插件停用还影响：{plugin.nonModelCapabilities.join("、")}。</p> : null}
          {target.protectedRefs.length ? <div className="space-y-2"><Pill variant="warning">存在实际依赖，不能忽略或直接停用</Pill><ul className="break-all">{target.protectedRefs.map(ref => <li key={ref}>{ref}</li>)}</ul><p className="text-muted-foreground">主模型可在下方替换；fallback / image / pdf / utility 或独立 Agent 引用须在对应配置中处理后刷新。</p></div> : null}
          {target.refs.some(ref => inventory.models.some(m => m.ref === ref && m.referenceSources.includes("primary"))) ? <div className="space-y-2">
            <select aria-label="替换主模型" className="w-full rounded-md border border-input bg-background p-2" value={replacement} onChange={e => setReplacement(e.target.value)}><option value="">选择新的主模型</option>{candidates.map(m => <option key={m.ref} value={m.ref}>{m.ref}</option>)}</select>
            <Button disabled={busy || !replacement} onClick={() => void decide("replace")}>替换主模型</Button>
          </div> : null}
          {target.kind === "probe" ? <Button disabled={busy} onClick={() => void decide("retry")}>重新探测</Button> : null}
          {onConfigure && target.providerIds.length ? <div className="flex flex-wrap gap-2">{target.providerIds.map(id => <Button key={id} variant="outline" disabled={busy} onClick={() => { setTarget(null); onConfigure(id); }}>配置 {id}</Button>)}</div> : null}
          {target.canDisable ? <div className="space-y-2 rounded-md border border-border p-3">
            <p>不再使用会移出选择规则，并在需要时停用插件。配置和 API Key 默认保留；不会自动重启 Gateway。</p>
            {hasMetadata ? <label className="flex items-center gap-2"><input type="checkbox" checked={cleanupMetadata} onChange={e => setCleanupMetadata(e.target.checked)} />同时清理别名和模型参数</label> : null}
            <Button variant="destructive" disabled={busy} onClick={() => void decide("disable")}>不再使用，保留 Key</Button>
          </div> : null}
          {target.canIgnore ? <div className="space-y-1"><Button variant="outline" disabled={busy} onClick={() => void decide(ignored ? "restore" : "ignore")}>{ignored ? "恢复提醒" : "本问题不再提醒"}</Button><p className="text-xs text-muted-foreground">只改变 oc-switch 提醒，不改变 OpenClaw 或 IM 选项；可在已忽略中恢复。</p></div> : null}
          {error ? <p role="alert" className="text-danger">{error}</p> : null}
        </div> : null}
        <DialogFooter><Button variant="ghost" disabled={busy} onClick={() => { setTarget(null); setError(null); }}>暂不处理</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </section>;
}
