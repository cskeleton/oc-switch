import type { EnvWriteVerification } from "./api";

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
  if (!entry) return input.fallback ?? `${input.label} 已更新。`;
  if (entry.maskedValue) {
    return `${input.label} 已写入托管块：${entry.envVar} = ${entry.maskedValue}`;
  }
  return `${input.label} 已写入托管块。`;
}
