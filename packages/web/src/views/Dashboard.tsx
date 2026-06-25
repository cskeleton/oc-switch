import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient, ConfigDiffSummary, StatusResponse } from "../api";

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
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">仪表盘</h1>
        <button
          type="button"
          aria-label="刷新"
          onClick={() => void load()}
          className="rounded-md border border-slate-600 p-2 hover:bg-slate-800"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {loading ? <p className="text-slate-400">加载中…</p> : null}
      {error ? <p className="text-red-400">{error}</p> : null}

      {status ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
          <StatCard label="主模型" value={status.primaryModel ?? "未设置"} large />
          <StatCard label="Provider 数量" value={String(status.providerCount)} />
          <StatCard label="Provider 模型" value={String(status.providerModelCount)} />
          <StatCard label="Allowlist 模型" value={String(status.allowlistModelCount)} />
          <HealthCard diff={diff} unavailable={diffUnavailable} />
        </div>
      ) : null}
    </section>
  );
}

function StatCard({ label, value, large = false }: { label: string; value: string; large?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
      <p className="text-xs uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 break-all font-medium text-slate-100 ${large ? "text-base" : "text-2xl"}`}>{value}</p>
    </div>
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

function HealthCard({ diff, unavailable }: { diff: ConfigDiffSummary | null; unavailable: boolean }) {
  const count = diff ? diffCount(diff) : 0;
  const summary = unavailable
    ? "没有可比较备份"
    : count === 0
      ? "与最近备份无差异"
      : `与最近备份有 ${count} 项差异`;

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-800/50 p-4">
      <p className="text-xs uppercase tracking-wide text-slate-400">配置健康</p>
      <p className={`mt-1 font-medium ${count > 0 ? "text-amber-200" : "text-slate-100"}`}>{summary}</p>
      {diff && count > 0 ? (
        <ul className="mt-2 space-y-1 text-xs text-slate-300">
          {diffHighlights(diff).map((item) => (
            <li key={item} className="break-all">{item}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
