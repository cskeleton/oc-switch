import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ApiClient, StatusResponse } from "../api";

interface DashboardProps {
  client: ApiClient;
}

/** 仪表盘：当前主模型与统计概览 */
export function Dashboard({ client }: DashboardProps) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await client.getStatus());
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
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label="主模型" value={status.primaryModel ?? "未设置"} large />
          <StatCard label="Provider 数量" value={String(status.providerCount)} />
          <StatCard label="Provider 模型" value={String(status.providerModelCount)} />
          <StatCard label="Allowlist 模型" value={String(status.allowlistModelCount)} />
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
