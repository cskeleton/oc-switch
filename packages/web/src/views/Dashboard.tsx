import { runtimeConfirmationIssue } from "../api";
import { OperationProgress } from "../components/OperationProgress";
import { ModelAttentionPanel } from "../components/ModelAttentionPanel";
import { Box, Cpu, ListChecks, RefreshCw, Star } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, CaseDuplicateGroup, ConfigDiffSummary, ConfigHealthReport, ModelAttentionReport, StatusResponse, ModelInventory, PluginExtensionsSnapshot } from "../api";
import { countDiffChangelogEntries, DiffChangelog } from "../components/DiffChangelog";
import { MergeCaseDuplicateDialog } from "../components/MergeCaseDuplicateDialog";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Skeleton } from "../components/ui/skeleton";
import { cn } from "../lib/utils";

interface DashboardProps {
  client: ApiClient;
  onConfigureProvider?: ((id: string) => void) | undefined;
}

const modelPolicyModeLabels = {
  legacy: "传统模式",
  unrestricted: "无限制策略",
  restricted: "受限策略"
} as const;

/** 仪表盘：当前主模型与统计概览 */
export function Dashboard({ client, onConfigureProvider }: DashboardProps) {
  const [extensions, setExtensions] = useState<PluginExtensionsSnapshot | null>(null);
  const [extensionsLoading, setExtensionsLoading] = useState(false);
  const [extensionsError, setExtensionsError] = useState<string | null>(null);
  const [runtimeLoading, setRuntimeLoading] = useState(false);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [onlinePending, setOnlinePending] = useState(false);
  const [inventory, setInventory] = useState<ModelInventory | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [diff, setDiff] = useState<ConfigDiffSummary | null>(null);
  const [diffUnavailable, setDiffUnavailable] = useState(false);
  const [health, setHealth] = useState<ConfigHealthReport | null>(null);
  const [attention, setAttention] = useState<ModelAttentionReport>({ pending: [], ignored: [] });
  const [attentionError, setAttentionError] = useState<string | null>(null);
  const [mergeTarget, setMergeTarget] = useState<CaseDuplicateGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** 每轮携带递增序号，迟到的旧响应不得覆盖更新的页面结果 */
  const loadSeq = useRef(0);
  const loadStatic = useCallback(async (seq: number) => {
    setLoading(true);
    setError(null);
    try {
      const snapshot = await client.getModelConfig();
      if (seq !== loadSeq.current) return;
      setStatus({ ok: true, ...snapshot.status });
    } catch (err) {
      if (seq === loadSeq.current) setError(err instanceof Error ? err.message : "本地配置读取失败");
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
    const [diffResult, healthResult] = await Promise.allSettled([client.getDiff(), client.getHealth()]);
    if (seq !== loadSeq.current) return;
    setDiff(diffResult.status === "fulfilled" && isConfigDiffSummary(diffResult.value) ? diffResult.value : null);
    setDiffUnavailable(diffResult.status === "rejected" || !isConfigDiffSummary(diffResult.value));
    setHealth(healthResult.status === "fulfilled" ? healthResult.value : null);
  }, [client]);

  const loadExtensions = useCallback(async (seq: number) => {
    setExtensionsLoading(true);
    setExtensionsError(null);
    try {
      const next = await client.getModelExtensions();
      if (seq === loadSeq.current) setExtensions(next);
    } catch (err) {
      if (seq === loadSeq.current) setExtensionsError(err instanceof Error ? err.message : "插件目录读取失败");
    } finally {
      if (seq === loadSeq.current) setExtensionsLoading(false);
    }
  }, [client]);

  const loadRuntime = useCallback(async (seq: number, preset?: ModelInventory, force = false) => {
    setRuntimeLoading(true);
    setRuntimeError(null);
    try {
      const next = preset ?? await (force ? client.refreshModelInventory() : client.getModelInventory());
      if (seq !== loadSeq.current) return;
      setInventory(next);
      const confirmationIssue = runtimeConfirmationIssue(next);
      setOnlinePending(confirmationIssue !== null);
      setRuntimeError(confirmationIssue);
      const report = await client.getModelAttention().catch(err => { if (seq === loadSeq.current) setAttentionError(err instanceof Error ? err.message : "无法读取问题状态"); return null; });
      if (!report) return;
      if (seq !== loadSeq.current) return;
      if (isAttentionReport(report)) { setAttention(report); setAttentionError(null); }
      else setAttentionError("提醒协议不兼容，请重启服务。");
    } catch (err) {
      if (seq === loadSeq.current) setRuntimeError(err instanceof Error ? err.message : "模型状态未确认");
    } finally {
      if (seq === loadSeq.current) setRuntimeLoading(false);
    }
  }, [client]);

  const load = useCallback(async (preset?: ModelInventory) => {
    const seq = ++loadSeq.current;
    await Promise.all([loadStatic(seq), loadExtensions(seq), loadRuntime(seq, preset)]);
  }, [loadStatic, loadExtensions, loadRuntime]);

  async function checkRuntime() {
    if (confirming) return;
    setConfirming(true);
    const seq = ++loadSeq.current;
    setLoading(false);
    setExtensionsLoading(false);
    try { await Promise.all([loadStatic(seq), loadExtensions(seq), loadRuntime(seq, undefined, true)]); }
    finally { if (seq === loadSeq.current) setConfirming(false); }
  }

  function saved() {
    const seq = ++loadSeq.current;
    setInventory(null);
    setRuntimeLoading(false);
    setExtensionsLoading(false);
    setRuntimeError(null);
    setOnlinePending(true);
    void loadStatic(seq);
  }

  useEffect(() => { void load(); return () => { loadSeq.current += 1; }; }, [load]);

  return (
    <section data-testid="dashboard-view">
      <PageHeader
        title="仪表盘"
        actions={
          <>
          <Button variant="outline" size="sm" disabled={confirming} onClick={() => void checkRuntime()}>{confirming ? "检查中…" : "检查并确认"}</Button>
          <Button variant="outline" size="icon" aria-label="刷新" disabled={loading || confirming} onClick={() => void load()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
          </>
        }
      />

      {loading && !status ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-label="加载中">
          <Skeleton className="h-24 sm:col-span-2 lg:col-span-4" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-32 sm:col-span-2 lg:col-span-4" />
        </div>
      ) : null}
      {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}

      <div className="mb-4 space-y-2">
        <OperationProgress phase={runtimeLoading ? "checking-runtime" : onlinePending ? "partial" : runtimeError ? "error" : inventory ? "success" : "idle"} message={runtimeError ? `运行时未确认：${runtimeError}` : undefined} />
        <OperationProgress phase={extensionsLoading ? "loading-plugin" : extensionsError ? "error" : "idle"} message={extensionsError ? `插件目录未取得：${extensionsError}` : undefined} />
        {extensions ? <p className="text-xs text-muted-foreground">插件目录：{extensions.plugins.length} 个插件 · {extensions.providers.length} 个 Provider{extensions.diagnostics.length ? `；${extensions.diagnostics.join("；")}` : ""}</p> : null}
        <ModelAttentionPanel client={client} inventory={inventory} report={attention} onReport={setAttention} onSaved={async (result) => { saved(); }} loadError={attentionError} onChanged={(next) => void load(next)} onConfigure={onConfigureProvider} /></div>
      {status ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {/* 主模型独占首行，四个统计卡在第二行 */}
          <StatCard label="主模型" value={status.primaryModel ?? "未设置"} icon={Star} featured className="sm:col-span-2 lg:col-span-4" />
          <StatCard label="Provider 数量" value={String(status.providerCount)} icon={Box} />
          <StatCard label="Provider 模型" value={String(status.providerModelCount)} icon={Cpu} />
          <StatCard
            label={`本地策略允许模型（${modelPolicyModeLabels[status.modelPolicyMode]}）`}
            value={String(status.effectiveModelCount)}
            icon={ListChecks}
          />
          <StatCard label="传统元数据条目" value={String(status.allowlistModelCount)} icon={ListChecks} />
          <HealthCard diff={diff} unavailable={diffUnavailable} className="sm:col-span-2 lg:col-span-4" />
          <CaseDuplicateCard
            groups={health?.caseDuplicateGroups ?? []}
            onMerge={setMergeTarget}
            className="sm:col-span-2 lg:col-span-4"
          />
        </div>
      ) : null}

      <MergeCaseDuplicateDialog
        open={Boolean(mergeTarget)}
        group={mergeTarget}
        client={client}
        onCancel={() => setMergeTarget(null)}
        onMerged={() => { setMergeTarget(null); saved(); }}
      />
    </section>
  );
}

function StatCard({
  label,
  value,
  icon: Icon,
  featured = false,
  className
}: {
  label: string;
  value: string;
  icon: typeof Star;
  /** 主模型等重点卡：brand 着色图标底 */
  featured?: boolean;
  className?: string;
}) {
  return (
    <Card
      className={cn(
        "transition-[transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md",
        featured && "border-brand/30 bg-gradient-to-br from-brand/[0.06] to-transparent",
        className
      )}
    >
      <CardContent className="flex items-center gap-4 p-5">
        <span
          className={cn(
            "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
            featured ? "bg-brand/15 text-brand" : "bg-muted text-muted-foreground"
          )}
        >
          <Icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-xs font-medium text-muted-foreground" title={label}>{label}</p>
          <p className={cn("truncate font-semibold tabular-nums text-foreground", featured ? "text-2xl" : "text-xl")} title={value}>{value}</p>
        </div>
      </CardContent>
    </Card>
  );
}

function isConfigDiffSummary(value: unknown): value is ConfigDiffSummary {
  if (!value || typeof value !== "object") return false;
  const diff = value as Partial<ConfigDiffSummary>;
  return Array.isArray(diff.providersAdded) &&
    Array.isArray(diff.providersRemoved) &&
    Array.isArray(diff.providersChanged) &&
    Array.isArray(diff.modelsEnabled) &&
    Array.isArray(diff.modelsDisabled) &&
    Array.isArray(diff.credentialsChanged) &&
    Array.isArray(diff.providerStateChanges) &&
    Array.isArray(diff.providerFieldChanges) &&
    (diff.primaryChanged === null || diff.primaryChanged === undefined || typeof diff.primaryChanged === "object");
}

/** attention 报告形状校验：pending/ignored 必须为数组，否则按协议不兼容处理 */
function isAttentionReport(value: unknown): value is ModelAttentionReport {
  if (!value || typeof value !== "object") return false;
  const report = value as Partial<ModelAttentionReport>;
  return Array.isArray(report.pending) && Array.isArray(report.ignored);
}

function HealthCard({ diff, unavailable, className }: { diff: ConfigDiffSummary | null; unavailable: boolean; className?: string }) {
  const count = diff ? countDiffChangelogEntries(diff) : 0;
  const summary = unavailable
    ? "没有可比较备份"
    : count === 0
      ? "与最近备份无差异"
      : `与最近备份有 ${count} 项差异`;

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">配置健康</CardTitle>
      </CardHeader>
      <CardContent>
        <div className={`text-xl font-semibold tabular-nums ${count > 0 ? "text-destructive" : "text-foreground"}`}>
          {summary}
        </div>
        {diff && count > 0 ? <DiffChangelog diff={diff} /> : null}
      </CardContent>
    </Card>
  );
}

function CaseDuplicateCard({ groups, onMerge, className }: { groups: CaseDuplicateGroup[]; onMerge: (group: CaseDuplicateGroup) => void; className?: string }) {
  if (groups.length === 0) return null;
  const names = groups.map((g) => g.ids.join("/")).join("、");
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">Provider 大小写重复</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="text-xl font-semibold text-warning">{`发现 ${groups.length} 组 Provider 大小写重复（${names}）`}</div>
        <ul className="mt-3 space-y-3 text-sm">
          {groups.map((group) => (
            <li key={group.groupKey} className="border-t border-border pt-2">
              <div className="flex items-center justify-between gap-2">
                <span className="break-all">建议保留 <strong>{group.canonicalId}</strong>，合并并删除 {group.duplicateIds.join(", ")}</span>
                {group.mergeable ? (
                  <Button
                    size="sm"
                    aria-label={`合并 ${group.groupKey}`}
                    onClick={() => onMerge(group)}
                    className="shrink-0"
                  >
                    合并
                  </Button>
                ) : (
                  <span className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground">需人工核对</span>
                )}
              </div>
              <ul className="mt-1 list-inside list-disc text-muted-foreground">
                {group.reasons.map((reason) => <li key={reason} className="break-all">{reason}</li>)}
                {group.mergeBlockers.map((blocker) => <li key={blocker} className="break-all text-warning">{blocker}</li>)}
              </ul>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
