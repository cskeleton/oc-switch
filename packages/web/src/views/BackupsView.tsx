import { RefreshCw, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { DataTable } from "../components/DataTable";
import type { ApiClient, BackupEntry } from "../api";

interface BackupsViewProps {
  client: ApiClient;
  onRefresh?: () => void;
}

/** 备份时间线与回滚 */
export function BackupsView({ client, onRefresh }: BackupsViewProps) {
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<BackupEntry | null>(null);
  const [restoreMode, setRestoreMode] = useState<"backup" | "current">("backup");

  const load = useCallback(async () => {
    setError(null);
    try {
      const { backups: list } = await client.getBackups();
      setBackups(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : "加载失败");
    }
  }, [client]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirmRestore() {
    if (!restoreTarget) return;
    try {
      await client.restoreBackup(restoreTarget.id, restoreTarget.pathMatchesActive ? undefined : restoreMode);
      setRestoreTarget(null);
      setRestoreMode("backup");
      await load();
      onRefresh?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "恢复失败");
      setRestoreTarget(null);
    }
  }

  return (
    <section data-testid="backups-view">
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">备份</h1>
        <button
          type="button"
          aria-label="刷新"
          onClick={() => void load()}
          className="rounded-md border border-slate-600 p-2 hover:bg-slate-800"
        >
          <RefreshCw className="h-4 w-4" />
        </button>
      </div>

      {error ? <p className="mb-3 text-red-400">{error}</p> : null}

      <DataTable
        rows={backups}
        rowKey={(row) => row.id}
        emptyMessage="尚无备份记录"
        columns={[
          { key: "id", header: "ID", render: (row) => row.id },
          { key: "createdAt", header: "时间", render: (row) => row.createdAt },
          { key: "reason", header: "原因", render: (row) => row.reason },
          { key: "openclawPath", header: "openclaw.json", render: (row) => row.openclawPath },
          { key: "envPath", header: ".env", render: (row) => row.envPath },
          {
            key: "actions",
            header: "操作",
            render: (row) => (
              <button
                type="button"
                aria-label={`恢复备份 ${row.id}`}
                onClick={() => {
                  setRestoreTarget(row);
                  setRestoreMode(row.pathMatchesActive ? "current" : "backup");
                }}
                className="inline-flex items-center gap-1 rounded border border-amber-600/50 px-2 py-1 text-xs text-amber-200 hover:bg-amber-900/30"
              >
                <RotateCcw className="h-3 w-3" />
                恢复
              </button>
            )
          }
        ]}
      />

      <ConfirmDialog
        open={Boolean(restoreTarget)}
        title="恢复备份"
        message={restoreTarget?.pathMatchesActive
          ? `确认恢复到 ${restoreTarget.id}？将覆盖当前 openclaw.json 与 .env。`
          : "备份路径与当前路径不一致，请选择恢复目标。"}
        danger
        confirmLabel="恢复"
        onCancel={() => {
          setRestoreTarget(null);
          setRestoreMode("backup");
        }}
        onConfirm={() => void confirmRestore()}
      >
        {restoreTarget ? (
          <div className="space-y-3 text-sm text-slate-300">
            <div className="space-y-1 rounded border border-slate-700 bg-slate-950/60 p-3 text-xs">
              <p className="break-all">备份 openclaw: {restoreTarget.openclawPath}</p>
              <p className="break-all">备份 env: {restoreTarget.envPath}</p>
            </div>
            {!restoreTarget.pathMatchesActive ? (
              <div className="space-y-2">
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="restore-target"
                    checked={restoreMode === "backup"}
                    onChange={() => setRestoreMode("backup")}
                    className="mt-1"
                  />
                  <span>恢复到备份原路径</span>
                </label>
                <label className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="restore-target"
                    aria-label="明确恢复到当前选中路径"
                    checked={restoreMode === "current"}
                    onChange={() => setRestoreMode("current")}
                    className="mt-1"
                  />
                  <span>明确恢复到当前选中路径</span>
                </label>
              </div>
            ) : null}
          </div>
        ) : null}
      </ConfirmDialog>
    </section>
  );
}
