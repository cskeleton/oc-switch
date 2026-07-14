import type { EnvWriteVerification, GatewayEnvSyncResult } from "./api";

/** 自动 sync 成功后的下一步提示 */
export const GATEWAY_RESTART_NEXT_STEP_HINT = "下一步：重启 Gateway";

/** sync 跳过/失败时的下一步提示 */
export const GATEWAY_CONFIRM_SYNC_NEXT_STEP_HINT = "下一步：确认目标并同步/重启 Gateway";

/** @deprecated 兼容旧引用；等价于确认目标提示 */
export const GATEWAY_NEXT_STEP_HINT = GATEWAY_CONFIRM_SYNC_NEXT_STEP_HINT;

/** 根据 sync 结果选择下一步文案 */
export function nextStepHintForGatewayEnvSync(gatewayEnvSync?: GatewayEnvSyncResult): string {
  return gatewayEnvSync?.ok ? GATEWAY_RESTART_NEXT_STEP_HINT : GATEWAY_CONFIRM_SYNC_NEXT_STEP_HINT;
}

/** 根据 sync 结果生成服务环境文件展示名（不含完整路径） */
export function formatGatewayServiceEnvLabel(sync?: GatewayEnvSyncResult): string {
  if (!sync?.targetPath) return "Gateway 服务环境文件";
  const parts = sync.targetPath.split(/[/\\]/);
  return parts[parts.length - 1] || "Gateway 服务环境文件";
}

export function formatEnvWriteSuccess(input: {
  label: string;
  envWrite?: EnvWriteVerification | undefined;
  gatewayEnvSync?: GatewayEnvSyncResult | undefined;
  fallback?: string | undefined;
}): string {
  if (!input.envWrite) return input.fallback ?? `${input.label} 已更新。`;
  if (!input.envWrite.verified) {
    return `${input.label} 保存请求已返回，但写后校验失败；请不要认为新值已生效。`;
  }

  const entry = input.envWrite.entries[0];
  const base = !entry
    ? (input.fallback ?? `${input.label} 已更新。`)
    : entry.maskedValue
      ? `${input.label} 已写入托管块：${entry.envVar} = ${entry.maskedValue}`
      : (input.fallback ?? `${input.label} 已写入托管块。`);
  return `${base} ${nextStepHintForGatewayEnvSync(input.gatewayEnvSync)}`;
}
