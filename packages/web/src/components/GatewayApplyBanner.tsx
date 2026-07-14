import { RefreshCw } from "lucide-react";
import { useState } from "react";
import type { ApiClient, EnvWriteVerification, GatewayEnvSyncResult } from "../api";
import { formatGatewayServiceEnvLabel } from "../env-feedback";

interface GatewayApplyBannerProps {
  client: ApiClient;
  envWrite?: EnvWriteVerification;
  gatewayEnvSync?: GatewayEnvSyncResult;
  onDismiss?: () => void;
}

/** env 写入成功后提示同步/重启 Gateway */
export function GatewayApplyBanner({ client, envWrite, gatewayEnvSync, onDismiss }: GatewayApplyBannerProps) {
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!envWrite?.verified) return null;

  const serviceEnvLabel = formatGatewayServiceEnvLabel(gatewayEnvSync);
  const alreadySynced = Boolean(gatewayEnvSync?.ok);
  const candidateId = gatewayEnvSync?.candidateId;
  const canAct = Boolean(candidateId);

  async function handleApply() {
    if (!candidateId) return;
    setLoading(true);
    setError(null);
    setMessage(null);
    try {
      if (alreadySynced) {
        const result = await client.restartGateway(candidateId);
        if (!result.ok) throw new Error(result.restart.message);
        setMessage("Gateway 已重启，新环境变量应对运行中进程生效。");
      } else {
        const result = await client.applyGateway(candidateId);
        if (!result.ok) throw new Error(result.restart.message);
        setMessage(`已同步到 ${serviceEnvLabel} 并重启 Gateway。`);
      }
      onDismiss?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Gateway 操作失败");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      data-testid="gateway-apply-banner"
      className="mb-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
    >
      <p className="font-medium text-amber-700 dark:text-amber-300">
        {!canAct
          ? "密钥已写入托管块，但未能确定唯一 Gateway 运行实例。请到设置中选择运行实例后再同步/重启。"
          : alreadySynced
            ? `托管块已同步到 ${serviceEnvLabel}；Gateway 需重启后才会加载新密钥。`
            : "密钥已写入托管块。Gateway 使用服务环境快照，请同步并重启后生效。"}
      </p>
      {gatewayEnvSync?.warnings.length ? (
        <ul className="mt-2 list-inside list-disc text-xs text-muted-foreground">
          {gatewayEnvSync.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      ) : null}
      {error ? <p className="mt-2 text-destructive">{error}</p> : null}
      {message ? <p className="mt-2 text-emerald-600 dark:text-emerald-400">{message}</p> : null}
      <div className="mt-3 flex flex-wrap gap-2">
        {canAct ? (
          <button
            type="button"
            disabled={loading}
            onClick={() => void handleApply()}
            className="inline-flex h-9 items-center gap-2 rounded-md bg-amber-600 px-4 text-sm font-medium text-primary-foreground hover:bg-amber-600/90 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            {loading ? "处理中…" : alreadySynced ? "重启 Gateway" : "同步并重启 Gateway"}
          </button>
        ) : (
          <p className="text-sm text-amber-800 dark:text-amber-200">
            请先确认目标并同步/重启 Gateway（设置 → 路径 / Gateway 环境）。
          </p>
        )}
        {onDismiss ? (
          <button
            type="button"
            disabled={loading}
            onClick={onDismiss}
            className="inline-flex h-9 items-center rounded-md border px-4 text-sm hover:bg-muted"
          >
            稍后
          </button>
        ) : null}
      </div>
    </div>
  );
}
