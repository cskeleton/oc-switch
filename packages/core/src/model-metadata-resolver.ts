import {
  loadModelMetadataCatalog,
  type ModelMetadataSourceKind,
  type ModelMetadataSourceStatus,
  type NormalizedModelMetadata
} from "./model-metadata-catalog";
import { classifyStrippedSuffix, localCoreCandidates, stripCatalogDateSuffixes } from "./model-id-core";
import type { FetchImpl } from "./provider-sync";

/**
 * 确定性本地建议解析器。
 *
 * resolveModelMetadata 是纯函数：不访问网络、不读文件、不修改 config。
 * 匹配分两层：先做 5 级精确匹配；全部落空后才启用第 6 层 core-model-id
 * 确定性归一化回退（见 ./model-id-core.ts 与
 * docs/superpowers/specs/2026-09-02-oc-switch-model-metadata-core-id-matching-design.md）。
 * 仍禁止模糊字符串相似度、按名称猜厂商、从任意 baseUrl 域名关键词猜 Provider；
 * 归一化只用于匹配，绝不改写用户输入。
 */

export type ModelMetadataMatchKind =
  | "provider-exact"
  | "endpoint-exact"
  | "model-key-exact"
  | "provider-model-exact"
  | "unique-model-id"
  | "core-model-id";

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

const MATCH_CONFIDENCE: Record<Exclude<ModelMetadataMatchKind, "core-model-id">, ModelMetadataConfidence> = {
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
  // 仅 core 层使用：raw 命中（0）排在 core 命中（1）之前
  const hitRank = new Map<string, number>();
  function add(
    matchKind: ModelMetadataMatchKind,
    model: NormalizedModelMetadata,
    confidenceOverride?: ModelMetadataConfidence
  ): void {
    const key = dedupKey(model);
    if (!byKey.has(key)) {
      const confidence =
        confidenceOverride ??
        (matchKind === "core-model-id" ? "low" : MATCH_CONFIDENCE[matchKind]);
      byKey.set(key, { matchKind, confidence, model });
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

  // 6. core-model-id：仅在前 5 级全部落空后启用（spec §5）。
  //    本地渐进剥离取最小命中深度；目录侧剥前缀+日期尾段；raw 命中优先于 core 命中。
  if (byKey.size === 0) {
    const catalogEntries = [...catalog.providerCatalog, ...catalog.modelFacts];
    const coreLowerByEntry = new Map<NormalizedModelMetadata, string>();
    for (const entry of catalogEntries) {
      coreLowerByEntry.set(entry, stripCatalogDateSuffixes(entry.modelId).core.toLowerCase());
    }
    const candidates = localCoreCandidates(rawModelId);
    const base = candidates[0];
    for (const core of candidates) {
      const folded = core.toLowerCase();
      const hits: Array<{ entry: NormalizedModelMetadata; rank: number }> = [];
      for (const entry of catalogEntries) {
        if (entry.modelId.toLowerCase() === folded) hits.push({ entry, rank: 0 });
        else if (coreLowerByEntry.get(entry) === folded) hits.push({ entry, rank: 1 });
      }
      if (hits.length === 0) continue;
      const confidence: ModelMetadataConfidence =
        base !== undefined && classifyStrippedSuffix(base, core) === "known" ? "medium" : "low";
      for (const hit of hits) {
        add("core-model-id", hit.entry, confidence);
        hitRank.set(dedupKey(hit.entry), hit.rank);
      }
      break; // 最小剥离深度胜出，更深层不再测试
    }
  }

  const suggestions = [...byKey.values()].sort((a, b) => {
    const confidenceDelta = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (confidenceDelta !== 0) return confidenceDelta;
    const hitDelta = (hitRank.get(dedupKey(a.model)) ?? 0) - (hitRank.get(dedupKey(b.model)) ?? 0);
    if (hitDelta !== 0) return hitDelta;
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
