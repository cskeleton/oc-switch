// packages/core/src/model-metadata-queue.ts
/**
 * 模型参数同步确认队列（机器产物，stateDir 下，不进备份/Git）。
 * 损坏即丢弃重建；候选内嵌 metadata 快照，accept 不依赖联网。
 */
import { readJsonState, writeJsonState } from "./json-state-store";
import { normalizeProviderId } from "./model-ref";
import type { NormalizedModelMetadata } from "./model-metadata-catalog";

export const MODEL_METADATA_QUEUE_FILENAME = "model-metadata-sync-queue.json";

export interface ModelMetadataQueueCandidate {
  catalogKey: string;
  score: number;
  reason: string;
  metadata: NormalizedModelMetadata;
}

export interface ModelMetadataQueueItem {
  providerId: string;
  modelId: string;
  candidates: ModelMetadataQueueCandidate[];
  lastSeenAt: string;
  dismissed: boolean;
}

export interface ModelMetadataSyncQueue {
  version: 1;
  items: ModelMetadataQueueItem[];
}

function emptyQueue(): ModelMetadataSyncQueue {
  return { version: 1, items: [] };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 防御性重建：只保留形状合法的项，字段类型不符整项丢弃 */
function normalizeQueue(value: unknown): ModelMetadataSyncQueue {
  if (!isPlainObject(value) || value.version !== 1 || !Array.isArray(value.items)) return emptyQueue();
  const items: ModelMetadataQueueItem[] = [];
  for (const raw of value.items) {
    if (!isPlainObject(raw)) continue;
    if (typeof raw.providerId !== "string" || typeof raw.modelId !== "string") continue;
    if (!Array.isArray(raw.candidates) || typeof raw.lastSeenAt !== "string") continue;
    const candidates: ModelMetadataQueueCandidate[] = [];
    for (const rawCandidate of raw.candidates) {
      if (!isPlainObject(rawCandidate)) continue;
      if (typeof rawCandidate.catalogKey !== "string" || typeof rawCandidate.score !== "number") continue;
      if (typeof rawCandidate.reason !== "string" || !isPlainObject(rawCandidate.metadata)) continue;
      candidates.push({
        catalogKey: rawCandidate.catalogKey,
        score: rawCandidate.score,
        reason: rawCandidate.reason,
        metadata: rawCandidate.metadata as unknown as NormalizedModelMetadata
      });
    }
    if (candidates.length === 0) continue;
    items.push({
      providerId: raw.providerId,
      modelId: raw.modelId,
      candidates,
      lastSeenAt: raw.lastSeenAt,
      dismissed: raw.dismissed === true
    });
  }
  return { version: 1, items };
}

export function readModelMetadataQueue(stateDir: string): ModelMetadataSyncQueue {
  return readJsonState<ModelMetadataSyncQueue>({
    stateDir,
    filename: MODEL_METADATA_QUEUE_FILENAME,
    fallback: emptyQueue,
    invalidJson: "fallback",
    normalize: normalizeQueue
  });
}

export function writeModelMetadataQueue(stateDir: string, queue: ModelMetadataSyncQueue): void {
  writeJsonState({ stateDir, filename: MODEL_METADATA_QUEUE_FILENAME, value: queue });
}

/** 队列项匹配：providerId 大小写折叠（写事务会把 config key 归一为小写，队列项可能存着归一前的大写 key），modelId 保持大小写敏感 */
function sameQueueItem(aProviderId: string, aModelId: string, bProviderId: string, bModelId: string): boolean {
  return normalizeProviderId(aProviderId) === normalizeProviderId(bProviderId) && aModelId === bModelId;
}

/** 同 (providerId, modelId) upsert：刷新 candidates/lastSeenAt，保留 dismissed */
export function upsertQueueItem(
  queue: ModelMetadataSyncQueue,
  item: { providerId: string; modelId: string; candidates: ModelMetadataQueueCandidate[] },
  now: string
): ModelMetadataSyncQueue {
  const index = queue.items.findIndex(
    (existing) => sameQueueItem(existing.providerId, existing.modelId, item.providerId, item.modelId)
  );
  const next: ModelMetadataQueueItem = {
    providerId: item.providerId,
    modelId: item.modelId,
    candidates: item.candidates,
    lastSeenAt: now,
    dismissed: index >= 0 ? queue.items[index]!.dismissed : false
  };
  const items = queue.items.slice();
  if (index >= 0) items[index] = next;
  else items.push(next);
  return { version: 1, items };
}

export function removeQueueItem(
  queue: ModelMetadataSyncQueue,
  providerId: string,
  modelId: string
): ModelMetadataSyncQueue {
  return {
    version: 1,
    items: queue.items.filter((item) => !sameQueueItem(item.providerId, item.modelId, providerId, modelId))
  };
}

export function setQueueItemDismissed(
  queue: ModelMetadataSyncQueue,
  providerId: string,
  modelId: string,
  dismissed: boolean
): ModelMetadataSyncQueue {
  return {
    version: 1,
    items: queue.items.map((item) =>
      sameQueueItem(item.providerId, item.modelId, providerId, modelId) ? { ...item, dismissed } : item
    )
  };
}
