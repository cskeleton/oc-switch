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

/** 仅用于跨配置比较和展示关联；不改变实际写入的 Provider ID。 */
export function normalizeProviderId(providerId: string): string {
  return providerId.toLowerCase();
}

/** 仅折叠 ModelRef 的 Provider 前缀，保留 model ID 大小写。 */
export function normalizeModelRefForIdentity(ref: string): string {
  const { providerId, modelId } = parseModelRef(ref);
  return formatModelRef(normalizeProviderId(providerId), modelId);
}
