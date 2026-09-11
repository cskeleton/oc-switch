import { useState, type ReactNode } from "react";
import type { ModelInventoryEntry, ModelPluginDescriptor, PluginStateMutationResult, ProviderInventoryEntry } from "../api";
import { DataTable, type Column } from "./DataTable";
import { ConfirmDialog } from "./ConfirmDialog";
import { CATALOG_SOURCE_LABELS, AVAILABILITY_REASON_LABELS } from "./ModelStateBadges";
import { useToast } from "./Toast";
import { Button } from "./ui/button";
import { Pill } from "./ui/pill";
import { Switch } from "./ui/switch";

interface PluginProviderGroupProps {
  plugin: ModelPluginDescriptor;
  /** 包括 config 同名来源；不能因其在 config 表中出现而漏报插件影响面。 */
  providers: ProviderInventoryEntry[];
  models?: ModelInventoryEntry[];
  onSetPluginState: (pluginId: string, enabled: boolean) => Promise<PluginStateMutationResult>;
  onMutated?: () => void | Promise<void>;
  onOpenSettings?: (() => void) | undefined;
  renderProviderActions?: (provider: ProviderInventoryEntry) => ReactNode;
}

const NON_MODEL_CAPABILITY_LABELS: Record<string, string> = {
  channels: "频道（channels）", tools: "工具（tools）", hooks: "钩子（hooks）",
  commands: "命令（commands）", services: "服务（services）", speech: "语音（speech）",
  realtime: "实时（realtime）", media: "媒体（media）", search: "搜索（search）",
  "other-contracts": "其他扩展能力（other-contracts）"
};

/** 一个插件一个开关；写入结果和运行时确认独立展示，失败不静默降级。 */
export function PluginProviderGroup({ plugin, providers, models = [], onSetPluginState, onMutated, onOpenSettings, renderProviderActions }: PluginProviderGroupProps) {
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [pendingEnabled, setPendingEnabled] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PluginStateMutationResult | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const targetLabel = pendingEnabled ? "启用" : "停用";
  const protectedModels = models.filter(model => model.referenceSources.includes("primary") || model.referenceSources.includes("fallback"));
  const disableBlocked = !pendingEnabled && protectedModels.length > 0;

  const columns: Column<ProviderInventoryEntry>[] = [
    {
      key: "providerId", header: "Provider", wrap: "anywhere", sortable: true, sortValue: row => row.providerId,
      render: row => (
        <div className="space-y-1">
          <span className="font-medium">{row.providerId}</span>
          <div className="flex flex-wrap gap-1">{row.sources.map(source => <Pill key={source} variant="muted">{CATALOG_SOURCE_LABELS[source]}</Pill>)}</div>
        </div>
      )
    },
    {
      key: "modelCount", header: "模型数", align: "right", wrap: "nowrap", className: "hidden sm:table-cell",
      sortable: true, sortValue: row => row.modelCount,
      render: row => <span>{row.availableModelCount} 可用 / {row.modelCount} 总数</span>
    },
    {
      key: "availability", header: "运行状态", wrap: "nowrap",
      render: row => (
        <Pill
          variant={row.availability === "available" ? "success" : row.availability === "unknown" ? "warning" : "destructive"}
          title={row.availabilityReasons.map(reason => AVAILABILITY_REASON_LABELS[reason] ?? reason).join("、")}
        >
          {row.availability === "available" ? "可用" : row.availability === "unknown" ? "无法确认" : "不可用·待处理"}
        </Pill>
      )
    },
    ...(renderProviderActions ? [{ key: "actions", header: "操作", wrap: "nowrap" as const, render: (row: ProviderInventoryEntry) => renderProviderActions(row) }] : [])
  ];

  async function confirmToggle(): Promise<void> {
    if (mutating || disableBlocked) return;
    setMutating(true);
    setError(null);
    setRefreshError(null);
    try {
      const written = await onSetPluginState(plugin.id, pendingEnabled);
      setResult(written);
      setConfirming(false);
      if (written.runtimeConfirmed) toast.success(`已${targetLabel}插件 ${plugin.id}`);
      // HTTP 写入成功不能因随后的列表刷新失败而被报告成写入失败。
      try {
        await onMutated?.();
      } catch (err) {
        setRefreshError(`配置已写入，但刷新失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMutating(false);
    }
  }

  return (
    <section className="min-w-0 rounded-lg border border-border">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="break-all text-sm font-semibold">{plugin.name ?? plugin.id}</h3>
            <Pill variant="muted">插件</Pill>
            <Pill variant={plugin.enabled ? "success" : "warning"}>{plugin.enabled ? "启用中" : "已停用"}</Pill>
          </div>
          <p className="break-all text-xs text-muted-foreground"><span>{plugin.id}</span> · 来源：{plugin.origin} · 影响 {plugin.providerIds.length} 个 Provider</p>
          {plugin.nonModelCapabilities.length > 0 ? <p className="text-xs text-warning">插件启停也影响 {plugin.nonModelCapabilities.length} 项非模型能力，请在确认前核对影响范围。</p> : null}
        </div>
        <Switch
          checked={plugin.enabled}
          disabled={mutating}
          aria-label={`${plugin.enabled ? "停用" : "启用"}插件 ${plugin.id}`}
          onCheckedChange={checked => { setPendingEnabled(checked); setError(null); setConfirming(true); }}
        />
      </header>
      {result && (!result.runtimeConfirmed || result.warnings.length > 0 || result.diagnostics?.length || refreshError) ? (
        <div role="status" className="m-4 space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          {!result.runtimeConfirmed ? <p>已{result.enabled ? "启用" : "停用"}插件 {plugin.id}；运行时状态未能确认，待应用/重启。请到设置中选择运行实例后同步/重启 Gateway，再刷新探测。</p> : null}
          <ul className="list-inside list-disc break-words">
            {result.warnings.map((warning, index) => <li key={`warning-${index}`}>{warning}</li>)}
            {result.diagnostics?.map((diagnostic, index) => <li key={`diagnostic-${index}`}>{diagnostic.message}</li>)}
          </ul>
          {refreshError ? <p>{refreshError}</p> : null}
          {!result.runtimeConfirmed && onOpenSettings ? <Button variant="outline" size="sm" onClick={onOpenSettings}>前往设置</Button> : null}
        </div>
      ) : null}
      <div className="px-4 py-3">
        <DataTable columns={columns} rows={providers} rowKey={row => row.providerId} defaultSort={{ key: "providerId", dir: "asc" }} minWidthClass="min-w-[18rem] md:min-w-[28rem]" emptyMessage="该插件未贡献任何 Provider" />
      </div>
      <ConfirmDialog
        open={confirming}
        title={`${targetLabel}插件 ${plugin.name ?? plugin.id}？`}
        message={`将把 plugins.entries.${plugin.id}.enabled 写为 ${pendingEnabled}，影响以下 Provider、模型与非模型能力。此操作会创建备份。`}
        danger={!pendingEnabled}
        confirmLabel={mutating ? "写入中…" : "确认"}
        confirmDisabled={mutating || disableBlocked}
        onCancel={() => { if (!mutating) setConfirming(false); }}
        onConfirm={() => void confirmToggle()}
      >
        <div className="space-y-3 text-sm">
          <p className="break-all">Provider：{plugin.providerIds.join("、")}</p>
          <ul className="list-inside list-disc break-all">
            {models.map(model => <li key={model.ref}><span>{model.ref}</span>{model.referenceSources.includes("primary") ? "（主模型）" : model.referenceSources.includes("fallback") ? "（fallback）" : ""}</li>)}
          </ul>
          {disableBlocked ? <p role="alert" className="text-destructive">包含主模型或 fallback 引用，不能停用；请先替换主模型或处理回退链。</p> : null}
          <p>policy exact / wildcard 与 legacy metadata 均保留；停用后可能成为不可用项，重新启用后恢复原策略。</p>
          <ul className="list-inside list-disc">{plugin.nonModelCapabilities.map(capability => <li key={capability}>{NON_MODEL_CAPABILITY_LABELS[capability] ?? capability}</li>)}</ul>
          {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        </div>
      </ConfirmDialog>
    </section>
  );
}
