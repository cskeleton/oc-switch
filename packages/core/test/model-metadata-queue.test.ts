// packages/core/test/model-metadata-queue.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MODEL_METADATA_QUEUE_FILENAME,
  readModelMetadataQueue,
  removeQueueItem,
  setQueueItemDismissed,
  upsertQueueItem,
  writeModelMetadataQueue,
  type ModelMetadataQueueCandidate,
  type ModelMetadataSyncQueue
} from "../src/model-metadata-queue";

const candidate: ModelMetadataQueueCandidate = {
  catalogKey: "zai/glm-4.6",
  score: 0.72,
  reason: "shared-model-tokens",
  metadata: {
    catalogKey: "zai/glm-4.6",
    providerId: "zai",
    modelId: "glm-4.6",
    contextWindow: 200000,
    sourceKind: "models-dev-model",
    sourceUrl: "https://models.dev/models.json"
  }
};

const empty: ModelMetadataSyncQueue = { version: 1, items: [] };

describe("model metadata sync queue", () => {
  test("upsert 新项追加；重复 upsert 刷新候选且保留 dismissed", () => {
    let queue = upsertQueueItem(empty, { providerId: "zai", modelId: "glm-4.6-air", candidates: [candidate] }, "2026-09-05T00:00:00.000Z");
    queue = setQueueItemDismissed(queue, "zai", "glm-4.6-air", true);
    const refreshed = { ...candidate, score: 0.9 };
    queue = upsertQueueItem(queue, { providerId: "zai", modelId: "glm-4.6-air", candidates: [refreshed] }, "2026-09-05T01:00:00.000Z");
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]!.candidates[0]!.score).toBe(0.9);
    expect(queue.items[0]!.lastSeenAt).toBe("2026-09-05T01:00:00.000Z");
    expect(queue.items[0]!.dismissed).toBe(true);
  });

  test("removeQueueItem / setQueueItemDismissed 不影响其它项", () => {
    let queue = upsertQueueItem(empty, { providerId: "zai", modelId: "a", candidates: [candidate] }, "t");
    queue = upsertQueueItem(queue, { providerId: "zai", modelId: "b", candidates: [candidate] }, "t");
    queue = removeQueueItem(queue, "zai", "a");
    expect(queue.items.map((item) => item.modelId)).toEqual(["b"]);
  });

  test("providerId 大小写折叠匹配：不产生重复项、dismissed 保留；modelId 仍大小写敏感", () => {
    // 归一化前写入的大写 key 与归一化后的小写 key 视为同一项
    let queue = upsertQueueItem(empty, { providerId: "NVIDIA", modelId: "a", candidates: [candidate] }, "t0");
    queue = setQueueItemDismissed(queue, "nvidia", "a", true);
    expect(queue.items[0]!.dismissed).toBe(true);
    const refreshed = { ...candidate, score: 0.9 };
    queue = upsertQueueItem(queue, { providerId: "nvidia", modelId: "a", candidates: [refreshed] }, "t1");
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]!.providerId).toBe("nvidia"); // 存储值以后写为准
    expect(queue.items[0]!.candidates[0]!.score).toBe(0.9);
    expect(queue.items[0]!.dismissed).toBe(true);
    // modelId 不折叠
    queue = upsertQueueItem(queue, { providerId: "nvidia", modelId: "A", candidates: [candidate] }, "t2");
    expect(queue.items).toHaveLength(2);
    // remove 同样折叠 providerId
    queue = removeQueueItem(queue, "NVIDIA", "A");
    expect(queue.items.map((item) => item.modelId)).toEqual(["a"]);
  });

  test("读写往返；损坏文件 fallback 空队列", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-switch-queue-"));
    try {
      const queue = upsertQueueItem(empty, { providerId: "zai", modelId: "a", candidates: [candidate] }, "t");
      writeModelMetadataQueue(dir, queue);
      expect(readModelMetadataQueue(dir).items).toHaveLength(1);
      // 损坏 JSON → 空队列
      writeFileSync(join(dir, MODEL_METADATA_QUEUE_FILENAME), "{oops", "utf8");
      expect(readModelMetadataQueue(dir)).toEqual({ version: 1, items: [] });
      // 版本不符 → 空队列
      writeFileSync(join(dir, MODEL_METADATA_QUEUE_FILENAME), JSON.stringify({ version: 99, items: [{}] }), "utf8");
      expect(readModelMetadataQueue(dir)).toEqual({ version: 1, items: [] });
      // 不存在 → 空队列
      rmSync(join(dir, MODEL_METADATA_QUEUE_FILENAME), { force: true });
      expect(readModelMetadataQueue(dir)).toEqual({ version: 1, items: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
