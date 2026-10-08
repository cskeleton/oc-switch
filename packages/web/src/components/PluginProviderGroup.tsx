import { OperationProgress } from "./OperationProgress";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ModelInventoryEntry, ModelPluginDescriptor, PluginStateMutationResult, ProviderInventoryEntry, PluginExtensionProvider } from "../api";
import { DataTable, type Column } from "./DataTable";
import { ConfirmDialog } from "./ConfirmDialog";
import { CATALOG_SOURCE_LABELS, AVAILABILITY_REASON_LABELS } from "./ModelStateBadges";
import { useToast } from "./Toast";
import { Button } from "./ui/button";
import { Pill } from "./ui/pill";
import { Switch } from "./ui/switch";

interface PluginProviderGroupProps {
  plugin: ModelPluginDescriptor;
  forceExpanded?: boolean;
  /** 包括 config 同名来源；不能因其在 config 表中出现而漏报插件影响面。 */
  providers: ProviderInventoryEntry[];
  extensionProviders?: PluginExtensionProvider[];
  runtimeReady?: boolean;
  models?: ModelInventoryEntry[];
  onSetPluginState: (pluginId: string, enabled: boolean, cleanupMetadata?: boolean) => Promise<PluginStateMutationResult>;
  onMutated?: (result: PluginStateMutationResult) => void | Promise<void>;
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
export function PluginProviderGroup({ plugin, providers, models = [], onSetPluginState, onMutated, onOpenSettings, renderProviderActions, forceExpanded, extensionProviders = [], runtimeReady = true }: PluginProviderGroupProps) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  useEffect(() => { if (forceExpanded) setExpanded(true); }, [forceExpanded]);
  const [confirming, setConfirming] = useState(false);
  const [cleanupMetadata, setCleanupMetadata] = useState(false);
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
      render: row => <span>{row.pickerModelCount ?? row.availableModelCount} 选项 / {row.modelCount} 目录</span>
    },
    {
      key: "availability", header: "运行状态", wrap: "nowrap",
      // oc-switch 可逆关闭优先于运行可用性展示：关闭时「可用」会误导为仍可选用。
      render: row => row.disabled ? (
        <Pill variant="muted" title="oc-switch 可逆关闭状态：选择规则已移出，API Key 保留，可从操作列恢复">已关闭</Pill>
      ) : (
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
      const written = cleanupMetadata ? await onSetPluginState(plugin.id, pendingEnabled, true) : await onSetPluginState(plugin.id, pendingEnabled);
      setResult(written);
      setConfirming(false);
      if (written.runtimeConfirmed) toast.success(`已${targetLabel}插件 ${plugin.id}`);
      // HTTP 写入成功不能因随后的列表刷新失败而被报告成写入失败。
      try {
        await onMutated?.(written);
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
      <header className="flex min-h-12 flex-wrap items-center gap-3 px-3 py-2">
        <Button variant="ghost" size="sm" className="min-w-0 flex-1 justify-start gap-2" aria-expanded={expanded} aria-label={`${expanded ? "收起" : "展开"}插件 ${plugin.id}`} onClick={() => setExpanded(value => !value)}>
          {expanded ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <h3 className="truncate text-sm font-semibold" title={plugin.name ?? plugin.id}>{plugin.id}</h3>
        </Button>
        <span className="text-xs text-muted-foreground">{plugin.providerIds.length} Provider · {providers.reduce((n, p) => n + (p.pickerModelCount ?? 0), 0)} 选项</span>
        <Pill variant="muted">插件</Pill>
        <Pill variant={plugin.enabled ? "success" : "muted"}>{plugin.enabled ? "已启用" : "已停用"}</Pill>
        {plugin.enabled && providers.some(provider => provider.disabled) ? (
          <Pill variant="muted" title="oc-switch 可逆关闭状态：插件本身启用，但 Provider 的选择规则已移出，可从 Provider 行恢复">
            {providers.every(provider => provider.disabled) ? "Provider 已关闭" : "部分 Provider 已关闭"}
          </Pill>
        ) : null}
        <Switch
          checked={plugin.enabled}
          disabled={mutating || !runtimeReady}
          aria-label={`${plugin.enabled ? "停用" : "启用"}插件 ${plugin.id}`}
          onCheckedChange={checked => { setPendingEnabled(checked); setCleanupMetadata(false); setError(null); setConfirming(true); }}
        />
        {!plugin.enabled && models.some(model => model.pickerVisible || model.policyAllowed) ? (
          <Button variant="outline" size="sm" aria-label={`移出残留模型选项 ${plugin.id}`} onClick={() => { setPendingEnabled(false); setCleanupMetadata(false); setError(null); setConfirming(true); }}>移出残留模型选项</Button>
        ) : null}
      </header>
      {mutating ? <OperationProgress phase="saving" className="mx-3 mb-3" message="正在校验并保存插件配置…" /> : null}
      {!runtimeReady ? <p className="px-3 pb-2 text-xs text-muted-foreground">插件目录已读取，在线状态待确认；启停操作等待运行时证据。</p> : null}
      {result && (!result.runtimeConfirmed || result.warnings.length > 0 || result.diagnostics?.length || refreshError) ? (
        <div role="status" className="m-4 space-y-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
          {!result.runtimeConfirmed ? <p>已{result.enabled ? "启用" : "停用"}插件 {plugin.id}；在线状态待确认。请点击「检查并确认」；若配置仍未生效，可到设置中同步并重启 Gateway。</p> : null}
          <ul className="list-inside list-disc break-words">
            {result.warnings.map((warning, index) => <li key={`warning-${index}`}>{warning}</li>)}
            {result.diagnostics?.map((diagnostic, index) => <li key={`diagnostic-${index}`}>{diagnostic.message}</li>)}
          </ul>
          {refreshError ? <p>{refreshError}</p> : null}
          {!result.runtimeConfirmed && onOpenSettings ? <Button variant="outline" size="sm" onClick={onOpenSettings}>前往设置</Button> : null}
        </div>
      ) : null}
      {expanded && !runtimeReady ? <div className="border-t border-border px-3 py-2"><DataTable rows={extensionProviders} rowKey={row => row.providerId} minWidthClass="min-w-[18rem]" columns={[
        { key: "providerId", header: "Provider", wrap: "anywhere", render: row => row.providerId },
        { key: "models", header: "目录模型", wrap: "normal", render: row => <span>{row.models.map(model => model.id).join("、") || "无模型声明"}</span> },
        { key: "state", header: "在线状态", wrap: "nowrap", render: () => <Pill variant="muted">待确认</Pill> }
      ]} /></div> : expanded && (plugin.enabled || providers.some(p => p.sources.includes("config"))) ? <div className="border-t border-border px-3 py-2">
        <DataTable columns={columns} rows={plugin.enabled ? providers : providers.filter(p => p.sources.includes("config"))} rowKey={row => row.providerId} defaultSort={{ key: "providerId", dir: "asc" }} minWidthClass="min-w-[18rem] md:min-w-[28rem]" emptyMessage="该插件未贡献任何 Provider" rowClassName={row => (row.disabled ? "opacity-60" : undefined)} />
      </div> : null}
      {expanded ? <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">{plugin.name ?? plugin.id} · {plugin.origin} · Provider：{plugin.providerIds.join("、")}{plugin.nonModelCapabilities.length ? ` · 还影响 ${plugin.nonModelCapabilities.map(c => NON_MODEL_CAPABILITY_LABELS[c]).join("、")}` : ""}</p> : null}
      <ConfirmDialog
        open={confirming}
        title={`${targetLabel}插件 ${plugin.name ?? plugin.id}？`}
        message={`将${targetLabel}此插件及其模型选项，影响范围如下。API Key 保留，操作前自动备份。`}
        danger={!pendingEnabled}
        confirmLabel={mutating ? "写入中…" : "确认"}
        confirmDisabled={mutating || disableBlocked}
        onCancel={() => { if (!mutating) setConfirming(false); }}
        onConfirm={() => void confirmToggle()}
      >
        <div className="space-y-3 text-sm">
          <p className="break-all">Provider：{plugin.providerIds.join("、")}</p>
          {!pendingEnabled ? <>
            <p>停用会移出这些 Provider 的精确和通配选择规则，使其退出 IM 模型选项；.env 密钥保留。恢复时合并保存的规则。</p>
            <label className="flex items-center gap-2"><input type="checkbox" checked={cleanupMetadata} onChange={event => setCleanupMetadata(event.target.checked)} />同时清理相关别名与模型参数（metadata）</label>
          </> : null}
          <ul className="list-inside list-disc break-all">
            {(plugin.enabled ? models : []).map(model => <li key={model.ref}><span>{model.ref}</span>{model.referenceSources.includes("primary") ? "（主模型）" : model.referenceSources.includes("fallback") ? "（fallback）" : ""}</li>)}
          </ul>
          {disableBlocked ? <p role="alert" className="text-destructive">包含主模型或 fallback 引用，不能停用；请先替换主模型或处理回退链。</p> : null}
          <p>未勾选清理时，别名和模型参数保留；停用项不再计入待处理。</p>
          <ul className="list-inside list-disc">{plugin.nonModelCapabilities.map(capability => <li key={capability}>{NON_MODEL_CAPABILITY_LABELS[capability] ?? capability}</li>)}</ul>
          {error ? <p role="alert" className="text-destructive">{error}</p> : null}
        </div>
      </ConfirmDialog>
    </section>
  );
}
