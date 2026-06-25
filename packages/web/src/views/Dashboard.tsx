import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient, ConfigDiffSummary, StatusResponse } from "../api";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";

interface DashboardProps {
  client: ApiClient;
}

/** 仪表盘：当前主模型与统计概览 */
export function Dashboard({ client }: DashboardProps) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [diff, setDiff] = useState<ConfigDiffSummary | null>(null);
  const [diffUnavailable, setDiffUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setDiffUnavailable(false);
    try {
      const [statusResult, diffResult] = await Promise.allSettled([
        client.getStatus(),
        client.getDiff()
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
        <button
          type="button"
          aria-label="刷新"
          onClick={() => void load()}
          className="inline-flex items-center justify-center rounded-md border border-input bg-background p-2 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {loading ? <p className="text-sm text-muted-foreground">加载中…</p> : null}
      {error ? <p className="text-sm font-medium text-destructive">{error}</p> : null}

      {status ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-5">
          <StatCard label="主模型" value={status.primaryModel ?? "未设置"} className="lg:col-span-2" />
          <StatCard label="Provider 数量" value={String(status.providerCount)} />
          <StatCard label="Provider 模型" value={String(status.providerModelCount)} />
          <StatCard label="Allowlist 模型" value={String(status.allowlistModelCount)} />
          <HealthCard diff={diff} unavailable={diffUnavailable} className="md:col-span-2 lg:col-span-5" />
        </div>
      ) : null}
    </section>
  );
}

function StatCard({ label, value, className }: { label: string; value: string; className?: string }) {
  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="break-all text-2xl font-bold">{value}</div>
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
    (diff.primaryChanged === null || diff.primaryChanged === undefined || typeof diff.primaryChanged === "object");
}

function diffCount(diff: ConfigDiffSummary): number {
  return diff.providersAdded.length +
    diff.providersRemoved.length +
    diff.providersChanged.length +
    diff.modelsEnabled.length +
    diff.modelsDisabled.length +
    (diff.primaryChanged ? 1 : 0);
}

function diffHighlights(diff: ConfigDiffSummary): string[] {
  return [
    ...diff.providersAdded,
    ...diff.providersRemoved,
    ...diff.providersChanged,
    ...diff.modelsEnabled,
    ...diff.modelsDisabled,
    ...(diff.primaryChanged ? [`${diff.primaryChanged.before ?? "(无)"} -> ${diff.primaryChanged.after ?? "(无)"}`] : [])
  ].slice(0, 3);
}

function HealthCard({ diff, unavailable, className }: { diff: ConfigDiffSummary | null; unavailable: boolean; className?: string }) {
  const count = diff ? diffCount(diff) : 0;
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
        <div className={`text-xl font-bold ${count > 0 ? "text-amber-500" : "text-foreground"}`}>
          {summary}
        </div>
        {diff && count > 0 ? (
          <ul className="mt-3 list-inside list-disc space-y-1 text-sm text-muted-foreground">
            {diffHighlights(diff).map((item) => (
              <li key={item} className="break-all">{item}</li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}
