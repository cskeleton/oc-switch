import { ModelAttentionPanel } from "../components/ModelAttentionPanel";
import { Box, Cpu, ListChecks, RefreshCw, Star } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient, CaseDuplicateGroup, ConfigDiffSummary, ConfigHealthReport, StatusResponse, ModelInventory } from "../api";
import { countDiffChangelogEntries, DiffChangelog } from "../components/DiffChangelog";
import { MergeCaseDuplicateDialog } from "../components/MergeCaseDuplicateDialog";
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
  const [inventory, setInventory] = useState<ModelInventory | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [diff, setDiff] = useState<ConfigDiffSummary | null>(null);
  const [diffUnavailable, setDiffUnavailable] = useState(false);
  const [health, setHealth] = useState<ConfigHealthReport | null>(null);
  const [mergeTarget, setMergeTarget] = useState<CaseDuplicateGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDiffUnavailable(false);
    try {
      const [statusResult, diffResult, healthResult, inventoryResult] = await Promise.allSettled([
        client.getStatus(),
        client.getDiff(),
        client.getHealth(),
        client.getModelInventory()
      ]);
      if (statusResult.status === "fulfilled") {
        setStatus(statusResult.value);
      } else {
        throw statusResult.reason;
      }
      if (diffResult.status === "fulfilled" && isConfigDiffSummary(diffResult.value)) {
        setDiff(diffResult.value);
      } else {
        setDiff(null);
        setDiffUnavailable(true);
      }
      if (inventoryResult.status === "fulfilled") setInventory(inventoryResult.value);
      else setError(inventoryResult.reason instanceof Error ? inventoryResult.reason.message : "模型状态未确认");
      setHealth(healthResult.status === "fulfilled" ? healthResult.value : null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <section data-testid="dashboard-view">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold tracking-tight">仪表盘</h1>
        <Button variant="outline" size="icon" aria-label="刷新" onClick={() => void load()}>
          <RefreshCw className="h-4 w-4" />
        </Button>
      </div>

      {loading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5" aria-label="加载中">
          <Skeleton className="h-28 lg:col-span-2" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-28" />
          <Skeleton className="h-32 md:col-span-2 lg:col-span-5" />
        </div>
      ) : null}
      {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}

      <div className="mb-4"><ModelAttentionPanel client={client} inventory={inventory} onChanged={load} onConfigure={onConfigureProvider} /></div>
      {status ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <StatCard label="主模型" value={status.primaryModel ?? "未设置"} icon={Star} className="lg:col-span-2" />
          <StatCard label="Provider 数量" value={String(status.providerCount)} icon={Box} />
          <StatCard label="Provider 模型" value={String(status.providerModelCount)} icon={Cpu} />
          <StatCard
            label={`有效可选模型（${modelPolicyModeLabels[status.modelPolicyMode]}）`}
            value={String(status.effectiveModelCount)}
            icon={ListChecks}
          />
          <StatCard label="传统元数据条目" value={String(status.allowlistModelCount)} icon={ListChecks} />
          <HealthCard diff={diff} unavailable={diffUnavailable} className="md:col-span-2 lg:col-span-5" />
          <CaseDuplicateCard
            groups={health?.caseDuplicateGroups ?? []}
            onMerge={setMergeTarget}
            className="md:col-span-2 lg:col-span-5"
          />
        </div>
      ) : null}

      <MergeCaseDuplicateDialog
        open={Boolean(mergeTarget)}
        group={mergeTarget}
        client={client}
        onCancel={() => setMergeTarget(null)}
        onMerged={() => { setMergeTarget(null); void load(); }}
      />
    </section>
  );
}

function StatCard({ label, value, icon: Icon, className }: { label: string; value: string; icon: typeof Star; className?: string }) {
  return (
    <Card className={cn("transition hover:-translate-y-0.5 hover:shadow-md", className)}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="break-all text-2xl font-semibold tabular-nums">{value}</div>
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
