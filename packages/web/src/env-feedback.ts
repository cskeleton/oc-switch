import type { EnvWriteVerification, GatewayEnvSyncResult } from "./api";

export const GATEWAY_NEXT_STEP_HINT = "下一步：同步并重启 Gateway，使运行中的 Gateway 加载新密钥。";

/** 根据 sync 结果生成服务环境文件展示名（不含完整路径） */
export function formatGatewayServiceEnvLabel(sync?: GatewayEnvSyncResult): string {
  if (!sync?.targetPath) return "Gateway 服务环境文件";
  const parts = sync.targetPath.split(/[/\\]/);
  return parts[parts.length - 1] || "Gateway 服务环境文件";
}

export function formatEnvWriteSuccess(input: {
  label: string;
  envWrite?: EnvWriteVerification | undefined;
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
  return `${base} ${GATEWAY_NEXT_STEP_HINT}`;
}
