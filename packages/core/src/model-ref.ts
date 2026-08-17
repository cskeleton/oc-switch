export interface ModelRefParts {
  providerId: string;
  modelId: string;
}

export function parseModelRef(ref: string): ModelRefParts {
  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0 || slashIndex === ref.length - 1) {
    throw new Error("ModelRef must contain a provider and model id");
  }

  return {
    providerId: ref.slice(0, slashIndex),
    modelId: ref.slice(slashIndex + 1)
  };
}

export function formatModelRef(providerId: string, modelId: string): string {
  if (!providerId || providerId.includes("/") || !modelId) {
    throw new Error("Invalid provider or model id");
  }
  return `${providerId}/${modelId}`;
}

/** Provider ID 的持久化规范：统一小写，model ID 保留原样。 */
export function normalizeProviderId(providerId: string): string {
  return providerId.toLowerCase();
}

/** 仅归一化 ModelRef 的 Provider 前缀，保留 model ID 大小写。 */
export function normalizeModelRefForStorage(ref: string): string {
  const { providerId, modelId } = parseModelRef(ref);
  return formatModelRef(normalizeProviderId(providerId), modelId);
}

/** 跨配置比较使用与持久化相同的 Provider 前缀归一规则。 */
export function normalizeModelRefForIdentity(ref: string): string {
  return normalizeModelRefForStorage(ref);
}
