// packages/core/src/model-metadata-sync.ts
/**
 * 模型参数批量同步编排（spec §4-§7）。
 * 分两段：plan（异步，加载 models.dev 目录并逐模型分流，零副作用）
 * 与 apply/record/resolve（纯函数或队列落盘），供 server/CLI 包进写事务。
 */
import { loadModelMetadataCatalog, type ModelMetadataSourceStatus, type NormalizedModelMetadata } from "./model-metadata-catalog";
import { computeMetadataFill, applyMetadataFill, missingMetadataFieldCount, type MetadataFill } from "./model-metadata-fill";
import { matchFuzzyModelMetadata } from "./model-metadata-matcher";
import {
  readModelMetadataQueue,
  writeModelMetadataQueue,
  removeQueueItem,
  setQueueItemDismissed,
  upsertQueueItem,
  type ModelMetadataQueueCandidate,
  type ModelMetadataSyncQueue
} from "./model-metadata-queue";
import { resolveModelMetadata, type ModelMetadataCatalogData } from "./model-metadata-resolver";
import { resolveProviderId } from "./operation-common";
import type { FetchImpl } from "./provider-sync";
import type { OpenClawConfig } from "./types";

export interface SyncProviderModelMetadataInput {
  providerId: string;
  modelIds?: string[];
}

export interface ModelMetadataSyncApply {
  modelId: string;
  metadata: NormalizedModelMetadata;
  catalogKey: string;
  matchKind: string;
}

export interface ModelMetadataSyncPlan {
  providerId: string;
  applies: ModelMetadataSyncApply[];
  queued: Array<{ modelId: string; candidates: ModelMetadataQueueCandidate[] }>;
  unmatched: string[];
  skipped: string[];
  sources: ModelMetadataSourceStatus[];
  warnings: string[];
}

export interface ModelMetadataSyncUpdated {
  modelId: string;
  filled: MetadataFill;
  catalogKey: string;
  matchKind: string;
}

export interface PlanSyncOptions {
  stateDir: string;
  fetchImpl?: FetchImpl;
  now?: () => number;
  timeoutMs?: number;
  forceRefresh?: boolean;
}

/**
 * 生成同步计划：确定性 resolver 唯一 high 置信 → applies；
 * 有建议但非唯一 high → queued（score=1，reason=resolver-<matchKind>）；
 * resolver 落空 → 模糊层，命中 → queued，落空 → unmatched。
 * 目录两源均空时 throw（fail closed，零写入）。
 */
export async function planProviderModelMetadataSync(
  config: OpenClawConfig,
  input: SyncProviderModelMetadataInput,
  options: PlanSyncOptions
): Promise<ModelMetadataSyncPlan> {
  const resolvedProviderId = resolveProviderId(config, input.providerId);
  const provider = resolvedProviderId ? config.models?.providers?.[resolvedProviderId] : undefined;
  if (!provider || !resolvedProviderId) throw new Error(`Provider ${input.providerId} not found`);
  const models = provider.models ?? [];

  if (input.modelIds !== undefined) {
    for (const id of input.modelIds) {
      if (!models.some((model) => model.id === id)) {
        throw new Error(`Model ${id} not found in provider ${resolvedProviderId}`);
      }
    }
  }
  const wanted = input.modelIds === undefined ? models : models.filter((model) => input.modelIds!.includes(model.id));
  const pending = wanted.filter((model) => missingMetadataFieldCount(model) > 0);
  const skipped = wanted.filter((model) => missingMetadataFieldCount(model) === 0).map((model) => model.id);

  const catalog = await loadModelMetadataCatalog({
    stateDir: options.stateDir,
    ...(options.fetchImpl !== undefined ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.forceRefresh !== undefined ? { forceRefresh: options.forceRefresh } : {})
  });
  if (catalog.modelFacts.length === 0 && catalog.providerCatalog.length === 0) {
    throw new Error(`Models.dev 目录不可用：${catalog.warnings.join("; ") || "no entries"}`);
  }
  const catalogData: ModelMetadataCatalogData = { modelFacts: catalog.modelFacts, providerCatalog: catalog.providerCatalog };
  const baseUrl = provider.baseUrl?.trim() || undefined;

  const applies: ModelMetadataSyncApply[] = [];
  const queued: Array<{ modelId: string; candidates: ModelMetadataQueueCandidate[] }> = [];
  const unmatched: string[] = [];
  const warnings = [...catalog.warnings];

  for (const model of pending) {
    // 单模型匹配异常不中断整批：计入 unmatched 并附 warning（spec §11）
    try {
      const suggestions = resolveModelMetadata(
        { providerId: resolvedProviderId, ...(baseUrl !== undefined ? { baseUrl } : {}), modelId: model.id },
        catalogData
      );
      const uniqueHigh = suggestions.length === 1 && suggestions[0]!.confidence === "high" ? suggestions[0] : undefined;
      if (uniqueHigh !== undefined && computeMetadataFill(model, uniqueHigh.model) !== undefined) {
        applies.push({ modelId: model.id, metadata: uniqueHigh.model, catalogKey: uniqueHigh.model.catalogKey, matchKind: uniqueHigh.matchKind });
        continue;
      }
      if (suggestions.length > 0) {
        queued.push({
          modelId: model.id,
          candidates: suggestions.map((suggestion) => ({
            catalogKey: suggestion.model.catalogKey,
            score: 1, // resolver 为确定性命中，仅因非 high 置信入队
            reason: `resolver-${suggestion.matchKind}`,
            metadata: suggestion.model
          }))
        });
        continue;
      }
      const fuzzy = matchFuzzyModelMetadata({ providerId: resolvedProviderId, modelId: model.id }, catalogData);
      if (fuzzy.length > 0) {
        queued.push({
          modelId: model.id,
          candidates: fuzzy.map((hit) => ({
            catalogKey: hit.metadata.catalogKey,
            score: hit.score,
            reason: hit.reason,
            metadata: hit.metadata
          }))
        });
      } else {
        unmatched.push(model.id);
      }
    } catch (error) {
      warnings.push(`${model.id}: 匹配失败 - ${error instanceof Error ? error.message : String(error)}`);
      unmatched.push(model.id);
    }
  }

  return {
    providerId: resolvedProviderId,
    applies,
    queued,
    unmatched,
    skipped,
    sources: catalog.sources,
    warnings
  };
}

/** 在写事务内应用计划：对当前条目重算 fill-empty（plan 之后被手工填上的字段不覆盖） */
export function applyModelMetadataSyncPlan(
  config: OpenClawConfig,
  plan: ModelMetadataSyncPlan
): { config: OpenClawConfig; updated: ModelMetadataSyncUpdated[] } {
  const provider = config.models?.providers?.[plan.providerId];
  if (!provider) throw new Error(`Provider ${plan.providerId} not found`);
  const updated: ModelMetadataSyncUpdated[] = [];
  for (const apply of plan.applies) {
    const index = (provider.models ?? []).findIndex((model) => model.id === apply.modelId);
    if (index === -1) continue; // plan 后被删除：跳过，不报错
    const current = provider.models![index]!;
    const fill = computeMetadataFill(current, apply.metadata);
    if (fill === undefined) continue;
    provider.models = provider.models!.map((model, i) => (i === index ? applyMetadataFill(model, fill) : model));
    updated.push({ modelId: apply.modelId, filled: fill, catalogKey: apply.catalogKey, matchKind: apply.matchKind });
  }
  return { config, updated };
}

/** 把计划中的 queued 项写入确认队列；queued 为空时不碰队列文件 */
export function recordModelMetadataSyncQueue(stateDir: string, plan: ModelMetadataSyncPlan, now?: string): void {
  if (plan.queued.length === 0) return;
  const timestamp = now ?? new Date().toISOString();
  let queue = readModelMetadataQueue(stateDir);
  for (const item of plan.queued) {
    queue = upsertQueueItem(queue, { providerId: plan.providerId, modelId: item.modelId, candidates: item.candidates }, timestamp);
  }
  writeModelMetadataQueue(stateDir, queue);
}

export type ModelMetadataQueueResolveAction =
  | { providerId: string; modelId: string; action: "accept"; catalogKey: string }
  | { providerId: string; modelId: string; action: "dismiss" };

export interface ModelMetadataQueueResolveResult {
  config: OpenClawConfig;
  queue: ModelMetadataSyncQueue;
  applied: ModelMetadataSyncUpdated[];
  dismissedCount: number;
  failed: Array<{ providerId: string; modelId: string; error: string }>;
  configChanged: boolean;
}

/**
 * 批量解决确认队列（纯函数：config/queue 进，新 config/queue 出）。
 * accept：候选 catalogKey 不存在 → failed；目标模型已不存在（孤儿）→ failed 并移除队列项；
 * 正常 accept 无论是否有字段可填都移除队列项（已解决）。dismiss：仅标记，保留在队列。
 */
export function resolveModelMetadataQueue(
  config: OpenClawConfig,
  queue: ModelMetadataSyncQueue,
  actions: ModelMetadataQueueResolveAction[]
): ModelMetadataQueueResolveResult {
  let nextQueue = queue;
  const applied: ModelMetadataSyncUpdated[] = [];
  const failed: Array<{ providerId: string; modelId: string; error: string }> = [];
  let dismissedCount = 0;
  let configChanged = false;

  for (const action of actions) {
    const resolvedProviderId = resolveProviderId(config, action.providerId) ?? action.providerId;
    const item = nextQueue.items.find((entry) => entry.providerId === resolvedProviderId && entry.modelId === action.modelId);
    if (!item) {
      failed.push({ providerId: action.providerId, modelId: action.modelId, error: "queue item not found" });
      continue;
    }
    if (action.action === "dismiss") {
      nextQueue = setQueueItemDismissed(nextQueue, item.providerId, item.modelId, true);
      dismissedCount++;
      continue;
    }
    const candidate = item.candidates.find((entry) => entry.catalogKey === action.catalogKey);
    if (!candidate) {
      failed.push({ providerId: action.providerId, modelId: action.modelId, error: `catalog candidate ${action.catalogKey} not found` });
      continue;
    }
    const provider = config.models?.providers?.[item.providerId];
    const model = provider?.models?.find((entry) => entry.id === item.modelId);
    if (!provider || !model) {
      // 孤儿队列项：模型已被删除/改名，移除并报 failed
      nextQueue = removeQueueItem(nextQueue, item.providerId, item.modelId);
      failed.push({ providerId: action.providerId, modelId: action.modelId, error: "model no longer exists in provider catalog" });
      continue;
    }
    const fill = computeMetadataFill(model, candidate.metadata);
    if (fill !== undefined) {
      provider.models = provider.models!.map((entry) => (entry.id === item.modelId ? applyMetadataFill(entry, fill) : entry));
      applied.push({ modelId: item.modelId, filled: fill, catalogKey: candidate.catalogKey, matchKind: `queue-${candidate.reason}` });
      configChanged = true;
    }
    nextQueue = removeQueueItem(nextQueue, item.providerId, item.modelId);
  }

  return { config, queue: nextQueue, applied, dismissedCount, failed, configChanged };
}
