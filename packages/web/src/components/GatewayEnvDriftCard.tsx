import { useCallback, useEffect, useState } from "react";
import type {
  ApiClient,
  GatewayEnvDriftEntry,
  GatewayEnvDriftReport,
  GatewayEnvDriftState
} from "../api";
import { ConfirmDialog } from "./ConfirmDialog";
import { Button } from "./ui/button";
import { Pill } from "./ui/pill";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

interface GatewayEnvDriftCardProps {
  client: ApiClient;
  /** Settings 页当前选中的运行实例候选；变化时以它为准重取 */
  candidateId?: string | null;
  /** 外部使报告失效的信号（env 写入成功等），递增即重取 */
  refreshToken?: number;
}

const STATE_LABEL: Record<GatewayEnvDriftState, string> = {
  equal: "一致",
  "missing-in-service": "快照缺失",
  different: "值不同",
  "extra-in-service": "快照残留",
  "outside-conflict": "块外冲突"
};

function severityVariant(entry: GatewayEnvDriftEntry): "destructive" | "warning" | "muted" {
  if (entry.severity === "blocking") return "destructive";
  if (entry.severity === "warning") return "warning";
  return "muted";
}

/** 环境分叉卡片：比较 .env 托管块与 Gateway 服务环境快照（文件级，不含任何 value） */
export function GatewayEnvDriftCard({ client, candidateId, refreshToken = 0 }: GatewayEnvDriftCardProps) {
  const [report, setReport] = useState<GatewayEnvDriftReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  // 歧义候选被选中后固定下来，后续 sync/apply 与重取都带该 candidateId
  const [resolvedCandidateId, setResolvedCandidateId] = useState<string | undefined>(candidateId ?? undefined);
  const [pendingAction, setPendingAction] = useState<"sync" | "apply" | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<string | null>(null);

  useEffect(() => {
    setResolvedCandidateId(candidateId ?? undefined);
  }, [candidateId]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await client.getGatewayEnvDrift(resolvedCandidateId);
      setReport(result.report);
    } catch (err) {
      // 弱化内联提示，不弹错误 toast：读报告失败不阻断设置页
      setError(err instanceof Error ? err.message : "加载环境分叉报告失败");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [client, resolvedCandidateId]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  async function runAction(action: "sync" | "apply") {
    if (!actionCandidateId) return;
    setActionLoading(true);
    setActionMessage(null);
    setError(null);
    try {
      if (action === "sync") {
        const result = await client.syncGatewayEnv(actionCandidateId);
        if (!result.ok) throw new Error("同步失败");
        setActionMessage(`已同步托管块到 Gateway 服务环境文件；Gateway 需重启后才会加载新值。`);
      } else {
        const result = await client.applyGateway(actionCandidateId);
        if (!result.ok) throw new Error(result.restart.message);
        setActionMessage("已同步并重启 Gateway，新环境变量应对运行中进程生效。");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gateway 操作失败");
    } finally {
      setActionLoading(false);
      setPendingAction(null);
    }
  }

  const driftCount = report ? report.entries.filter((entry) => entry.state !== "equal").length : 0;
  const hasDifferent = (report?.summary.different ?? 0) > 0;
  // spec：存在 blocking/warning 时提供 CTA；missing-in-service 属 info，不单独触发
  const hasActionable = report
    ? report.entries.some((entry) => entry.severity === "blocking" || entry.severity === "warning")
    : false;
  // sync/apply 优先用报告里实际解析到的目标 candidateId（automatic 模式下 prop 可能为空）
  const actionCandidateId = report?.target?.candidateId || resolvedCandidateId;
  const detailEntries = report?.entries.filter((entry) => entry.state !== "equal") ?? [];

  return (
    <Card className={hasDifferent ? "border-destructive/50" : undefined} data-testid="gateway-env-drift-card">
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="space-y-1">
            <CardTitle className={hasDifferent ? "text-destructive" : undefined}>环境分叉</CardTitle>
            <CardDescription>
              比较 .env 托管块与 Gateway 服务环境快照（文件级比较，不探测运行中进程）。
            </CardDescription>
          </div>
          {report && report.status === "ok" ? (
            driftCount > 0 ? (
              <Pill variant={hasDifferent ? "destructive" : "warning"}>{driftCount} 项分叉</Pill>
            ) : (
              <Pill variant="success">一致</Pill>
            )
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? <p className="text-sm text-muted-foreground">检查环境分叉中…</p> : null}

        {!loading && error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : null}

        {!loading && !error && report?.status === "unavailable" ? (
          report.unavailable?.code === "ambiguous-match" &&
          (report.unavailable.candidates?.length ?? 0) > 0 ? (
            <div className="space-y-2" role="radiogroup" aria-label="环境分叉目标运行实例">
              <p className="text-sm text-muted-foreground">
                检测到多个可关联的 Gateway 运行实例，请选择要检查的目标：
              </p>
              {report.unavailable.candidates!.map((candidate) => (
                <label
                  key={candidate.candidateId}
                  className="flex cursor-pointer items-start gap-2 rounded-md border p-2 text-sm hover:bg-muted/40"
                >
                  <input
                    type="radio"
                    name="gateway-env-drift-candidate"
                    className="mt-1"
                    checked={resolvedCandidateId === candidate.candidateId}
                    aria-label={`环境分叉目标 ${candidate.candidateId}`}
                    onChange={() => setResolvedCandidateId(candidate.candidateId)}
                  />
                  <span className="min-w-0 break-all">
                    <span className="font-medium">{candidate.candidateId}</span>
                    {candidate.serviceId ? (
                      <span className="ml-2 text-muted-foreground">{candidate.serviceId}</span>
                    ) : null}
                    <span className="mt-0.5 block text-xs text-muted-foreground">
                      {[candidate.serviceManager, candidate.serviceEnvPath].filter(Boolean).join(" · ")}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              未发现可关联的 Gateway 服务环境{report.unavailable?.message ? `：${report.unavailable.message}` : ""}
            </p>
          )
        ) : null}

        {!loading && !error && report?.status === "ok" ? (
          <>
            {hasDifferent ? (
              <p className="text-sm font-medium text-destructive">
                运行中 Gateway 可能仍使用旧值，重启后生效。
              </p>
            ) : null}
            {report.warnings.map((warning) => (
              <p key={warning} className="text-xs text-muted-foreground">{warning}</p>
            ))}
            {report.target ? (
              <p className="break-all text-xs text-muted-foreground">
                目标：<code className="rounded bg-muted px-1">{report.target.serviceEnvPath}</code>
              </p>
            ) : null}
            <p className="text-xs text-muted-foreground">
              共检查 {report.summary.checked} 项：一致 {report.summary.equal}、值不同 {report.summary.different}、
              快照缺失 {report.summary.missingInService}、快照残留 {report.summary.extraInService}、
              块外冲突 {report.summary.outsideConflict}
              {report.summary.unsyncable > 0 ? `、无法同步 ${report.summary.unsyncable}` : ""}
            </p>

            {detailEntries.length > 0 ? (
              <div>
                <Button variant="outline" size="sm" aria-expanded={expanded} onClick={() => setExpanded((open) => !open)}>
                  {expanded ? "收起详情" : "展开详情"}
                </Button>
                {expanded ? (
                  <ul className="mt-2 space-y-1">
                    {detailEntries.map((entry) => (
                      <li key={entry.envVar} className="flex flex-wrap items-center gap-2 text-sm">
                        <code className="min-w-0 break-all rounded bg-muted px-1 font-mono text-xs">{entry.envVar}</code>
                        <Pill variant={severityVariant(entry)}>{STATE_LABEL[entry.state]}</Pill>
                        {entry.unsyncable ? (
                          <span className="text-xs text-muted-foreground">
                            （{entry.unsyncable === "empty-value" ? "空值" : "多行值"}无法自动同步）
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            {hasActionable && actionCandidateId ? (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={actionLoading}
                  onClick={() => setPendingAction("sync")}
                >
                  同步
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={actionLoading}
                  onClick={() => setPendingAction("apply")}
                >
                  同步并重启
                </Button>
              </div>
            ) : null}
            {actionMessage ? <p className="text-sm text-success">{actionMessage}</p> : null}
          </>
        ) : null}

        {!loading ? (
          <div>
            <Button variant="ghost" size="sm" onClick={() => void load()}>
              重新检查
            </Button>
          </div>
        ) : null}
      </CardContent>

      {pendingAction ? (
        <ConfirmDialog
          open
          title={pendingAction === "sync" ? "同步 Gateway 服务环境" : "同步并重启 Gateway"}
          message={
            pendingAction === "sync"
              ? "将把 .env 托管块同步到 Gateway 服务环境文件。同步后需重启 Gateway 才会对运行中进程生效。"
              : "将先把 .env 托管块同步到 Gateway 服务环境文件，然后重启 Gateway，使运行中进程加载新值。"
          }
          confirmLabel={pendingAction === "sync" ? "确认同步" : "确认并重启"}
          onCancel={() => setPendingAction(null)}
          onConfirm={() => void runAction(pendingAction)}
        />
      ) : null}
    </Card>
  );
}
