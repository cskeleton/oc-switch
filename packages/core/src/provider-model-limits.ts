import type { OpenClawProvider } from "./types";

/** 每 Provider 本地模型目录硬上限（spec §5.1） */
export const MAX_PROVIDER_MODELS = 50;

/** 在净增加 provider.models 条数前调用；addingCount 为即将新增的条数（不含已存在跳过） */
export function assertProviderModelCapacity(provider: OpenClawProvider | undefined, addingCount: number): void {
  if (addingCount <= 0) return;
  const current = provider?.models?.length ?? 0;
  if (current + addingCount > MAX_PROVIDER_MODELS) {
    throw new Error(
      `Provider model catalog exceeds limit: ${current} existing + ${addingCount} new > ${MAX_PROVIDER_MODELS}. Remove models or keep enabled-only before adding.`
    );
  }
}
