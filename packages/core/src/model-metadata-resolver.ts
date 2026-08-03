import {
  loadModelMetadataCatalog,
  type ModelMetadataSourceKind,
  type ModelMetadataSourceStatus,
  type NormalizedModelMetadata
} from "./model-metadata-catalog";
import type { FetchImpl } from "./provider-sync";

/**
 * 确定性本地建议解析器。
 *
 * resolveModelMetadata 是纯函数：不访问网络、不读文件、不修改 config。
 * 只做精确匹配，禁止模糊字符串相似度、自动删日期后缀、自动把 latest 映射到
 * 某个版本、按名称猜厂商、从任意 baseUrl 域名关键词猜 Provider。
 */

export type ModelMetadataMatchKind =
  | "provider-exact"
  | "endpoint-exact"
  | "model-key-exact"
  | "provider-model-exact"
  | "unique-model-id";

export type ModelMetadataConfidence = "high" | "medium" | "low";

export interface ModelMetadataSuggestion {
  matchKind: ModelMetadataMatchKind;
  confidence: ModelMetadataConfidence;
  model: NormalizedModelMetadata;
}

export interface ResolveModelMetadataInput {
  providerId: string;
  baseUrl?: string;
  modelId: string;
}

export interface ModelMetadataCatalogData {
  modelFacts: NormalizedModelMetadata[];
  providerCatalog: NormalizedModelMetadata[];
}

/** 多候选时最多返回条数 */
export const MAX_MODEL_METADATA_SUGGESTIONS = 5;

const MATCH_CONFIDENCE: Record<ModelMetadataMatchKind, ModelMetadataConfidence> = {
  "provider-exact": "high",
  "endpoint-exact": "high",
  "model-key-exact": "high",
  "provider-model-exact": "medium",
  "unique-model-id": "low"
};

const CONFIDENCE_RANK: Record<ModelMetadataConfidence, number> = { high: 0, medium: 1, low: 2 };
const SOURCE_RANK: Record<ModelMetadataSourceKind, number> = {
  "models-dev-provider": 0,
  "models-dev-model": 1
};

/** 标准化 endpoint 为 origin+path（去掉末尾斜杠）；无法解析返回 undefined */
export function normalizeEndpoint(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value.trim());
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${path}`;
  } catch {
    return undefined;
  }
}

function dedupKey(model: NormalizedModelMetadata): string {
  return `${model.sourceKind}:${model.providerId ?? ""}:${model.modelId}`;
}

/**
 * 根据 provider/baseUrl/modelId 在本地归一化目录中做确定性匹配，返回按
 * confidence → source priority → catalog key 稳定排序的建议候选（最多 5 条）。
 */
export function resolveModelMetadata(
  input: ResolveModelMetadataInput,
  catalog: ModelMetadataCatalogData
): ModelMetadataSuggestion[] {
  const rawModelId = input.modelId;
  if (!rawModelId.trim()) return [];
  const normalizedProviderId = input.providerId.trim().toLowerCase();
  const normalizedBaseUrl = normalizeEndpoint(input.baseUrl);

  // 按匹配优先级收集；dedup 保留首次出现（优先级更高者）
  const byKey = new Map<string, ModelMetadataSuggestion>();
  function add(matchKind: ModelMetadataMatchKind, model: NormalizedModelMetadata): void {
    const key = dedupKey(model);
    if (!byKey.has(key)) {
      byKey.set(key, { matchKind, confidence: MATCH_CONFIDENCE[matchKind], model });
    }
  }

  // 1. provider-exact：oc-switch Provider ID（大小写折叠）== Models.dev Provider ID，且 raw Model ID 精确命中
  for (const entry of catalog.providerCatalog) {
    if (entry.providerId?.toLowerCase() === normalizedProviderId && entry.modelId === rawModelId) {
      add("provider-exact", entry);
    }
  }

  // 2. endpoint-exact：Models.dev Provider 声明 api 且标准化 origin/path 与 baseUrl 精确匹配，且 raw Model ID 精确命中
  if (normalizedBaseUrl !== undefined) {
    for (const entry of catalog.providerCatalog) {
      const entryEndpoint = normalizeEndpoint(entry.providerApi);
      if (entryEndpoint !== undefined && entryEndpoint === normalizedBaseUrl && entry.modelId === rawModelId) {
        add("endpoint-exact", entry);
      }
    }
  }

  // 3. model-key-exact：用户输入本身是完整模型 key，精确命中 models.json
  for (const entry of catalog.modelFacts) {
    if (entry.catalogKey === rawModelId) {
      add("model-key-exact", entry);
    }
  }

  // 4. provider-model-exact：`${normalizedProviderId}/${rawModelId}` 精确命中 models.json
  //    provider 段大小写折叠比较，model 段大小写敏感精确比较
  for (const entry of catalog.modelFacts) {
    if (entry.providerId?.toLowerCase() === normalizedProviderId && entry.modelId === rawModelId) {
      add("provider-model-exact", entry);
    }
  }

  // 5. unique-model-id：raw Model ID 在模型事实表中只有唯一候选时才产生低置信匹配；
  //    歧义同名 ID 不得返回列表靠前的候选，避免用户把错误厂商的参数应用到自己模型上
  const uniqueCandidates = catalog.modelFacts.filter((entry) => entry.modelId === rawModelId);
  if (uniqueCandidates.length === 1) {
    add("unique-model-id", uniqueCandidates[0]!);
  }

  const suggestions = [...byKey.values()].sort((a, b) => {
    const confidenceDelta = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (confidenceDelta !== 0) return confidenceDelta;
    const sourceDelta = SOURCE_RANK[a.model.sourceKind] - SOURCE_RANK[b.model.sourceKind];
    if (sourceDelta !== 0) return sourceDelta;
    return a.model.catalogKey.localeCompare(b.model.catalogKey);
  });

  return suggestions.slice(0, MAX_MODEL_METADATA_SUGGESTIONS);
}

/** 组合 loader + resolver 的高层 service 结果 */
export interface ModelMetadataSuggestionsResult {
  suggestions: ModelMetadataSuggestion[];
  sources: Array<Pick<ModelMetadataSourceStatus, "kind" | "fetchedAt" | "checkedAt" | "stale">>;
  warnings: string[];
}

export interface ResolveModelMetadataSuggestionsOptions {
  stateDir: string;
  fetchImpl?: FetchImpl;
  now?: () => number;
  timeoutMs?: number;
  forceRefresh?: boolean;
  maxBytesOverride?: Partial<Record<ModelMetadataSourceKind, number>>;
}

/**
 * 加载（或复用缓存的）Models.dev 目录并解析建议。
 * 不返回缓存文件绝对路径或 raw provider metadata。
 */
export async function resolveModelMetadataSuggestions(
  query: ResolveModelMetadataInput,
  options: ResolveModelMetadataSuggestionsOptions
): Promise<ModelMetadataSuggestionsResult> {
  const catalog = await loadModelMetadataCatalog(options);
  const suggestions = resolveModelMetadata(query, {
    modelFacts: catalog.modelFacts,
    providerCatalog: catalog.providerCatalog
  });
  return {
    suggestions,
    sources: catalog.sources.map((source) => ({
      kind: source.kind,
      fetchedAt: source.fetchedAt,
      checkedAt: source.checkedAt,
      stale: source.stale
    })),
    warnings: catalog.warnings
  };
}
