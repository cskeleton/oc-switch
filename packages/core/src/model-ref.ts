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
