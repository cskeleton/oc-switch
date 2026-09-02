import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import modelsFixture from "./fixtures/model-metadata/models.json";
import apiFixture from "./fixtures/model-metadata/api.json";
import {
  loadModelMetadataCatalog,
  MODELS_DEV_API_URL,
  MODELS_DEV_MODELS_URL,
  MODEL_METADATA_CACHE_FILENAME,
  MODEL_METADATA_FRESH_TTL_MS,
  type ModelMetadataCache
} from "../src/model-metadata-catalog";
import type { FetchImpl } from "../src/provider-sync";

const tempDirs: string[] = [];
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const BASE_NOW = Date.parse("2026-08-01T00:00:00.000Z");

const MODELS_BODY = JSON.stringify(modelsFixture);
const API_BODY = JSON.stringify(apiFixture);

function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-metadata-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface MockSpec {
  status?: number;
  body?: string;
  etag?: string;
  throwError?: Error;
  never?: boolean;
}

function mockFetch(byUrl: Record<string, MockSpec>) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl: FetchImpl = async (input, init) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, headers });
    const spec = byUrl[url];
    if (!spec) throw new Error(`unexpected url: ${url}`);
    if (spec.never) {
      return new Promise<Response>(() => {
        // 永不 resolve，交由 fetchSource 的超时竞赛处理
      });
    }
    if (spec.throwError) throw spec.throwError;
    const responseHeaders: Record<string, string> = {};
    if (spec.etag) responseHeaders["etag"] = spec.etag;
    return new Response(spec.body ?? "", { status: spec.status ?? 200, headers: responseHeaders });
  };
  return { fetchImpl, calls };
}

function successFetch(etagModels = "etag-models", etagApi = "etag-api") {
  return mockFetch({
    [MODELS_DEV_MODELS_URL]: { status: 200, body: MODELS_BODY, etag: etagModels },
    [MODELS_DEV_API_URL]: { status: 200, body: API_BODY, etag: etagApi }
  });
}

function readCacheFile(dir: string): ModelMetadataCache | undefined {
  const path = join(dir, MODEL_METADATA_CACHE_FILENAME);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, "utf8")) as ModelMetadataCache;
}

describe("loadModelMetadataCatalog", () => {
  test("无缓存时下载两个固定 URL、归一化并原子落盘", async () => {
    const dir = stateDir();
    const { fetchImpl, calls } = successFetch();

    const result = await loadModelMetadataCatalog({
      stateDir: dir,
      fetchImpl,
      now: () => BASE_NOW
    });

    // 两个固定 URL 各被请求一次
    expect(calls.map((c) => c.url).sort()).toEqual([MODELS_DEV_API_URL, MODELS_DEV_MODELS_URL]);

    // models.json 归一化
    const gpt = result.modelFacts.find((entry) => entry.catalogKey === "openai/gpt-5.2");
    expect(gpt).toMatchObject({
      providerId: "openai",
      modelId: "gpt-5.2",
      contextWindow: 400000,
      maxTokens: 128000,
      reasoning: true,
      sourceKind: "models-dev-model"
    });
    expect(gpt?.input).toEqual(["text", "image"]);
    expect(gpt?.output).toEqual(["text"]);

    // api.json 归一化（provider-specific，含 inputLimit）
    const openRouterGpt = result.providerCatalog.find((entry) => entry.catalogKey === "openrouter/openai/gpt-5.2");
    expect(openRouterGpt).toMatchObject({
      providerId: "openrouter",
      modelId: "openai/gpt-5.2",
      contextWindow: 400000,
      inputLimit: 272000,
      maxTokens: 128000,
      sourceKind: "models-dev-provider"
    });

    // 非法数值不进入建议层
    const broken = result.modelFacts.find((entry) => entry.catalogKey === "broken/negative");
    expect(broken?.contextWindow).toBeUndefined();
    expect(broken?.maxTokens).toBe(99999);
    for (const entry of result.modelFacts) {
      if (entry.contextWindow !== undefined) expect(entry.contextWindow).toBeGreaterThan(0);
    }

    // 原子落盘
    const cache = readCacheFile(dir);
    expect(cache?.version).toBe(2);
    expect(cache?.modelFacts?.entries.length).toBeGreaterThan(0);
    expect(cache?.providerCatalog?.entries.length).toBeGreaterThan(0);
    expect(cache?.modelFacts?.etag).toBe("etag-models");
    expect(cache?.providerCatalog?.etag).toBe("etag-api");

    // 两个源各自的 sources 状态
    expect(result.sources).toHaveLength(2);
    expect(result.sources.every((source) => source.stale === false)).toBe(true);
  });

  test("24 小时内复用缓存，不调用 fetch", async () => {
    const dir = stateDir();
    const first = successFetch();
    await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: first.fetchImpl, now: () => BASE_NOW });
    expect(first.calls).toHaveLength(2);

    // 第二次使用会抛错的 fetch，证明没有联网
    const second = mockFetch({
      [MODELS_DEV_MODELS_URL]: { throwError: new Error("must not fetch") },
      [MODELS_DEV_API_URL]: { throwError: new Error("must not fetch") }
    });
    const result = await loadModelMetadataCatalog({
      stateDir: dir,
      fetchImpl: second.fetchImpl,
      now: () => BASE_NOW + MODEL_METADATA_FRESH_TTL_MS - HOUR
    });

    expect(second.calls).toHaveLength(0);
    expect(result.modelFacts.find((entry) => entry.catalogKey === "openai/gpt-5.2")).toBeTruthy();
    expect(result.sources.every((source) => source.stale === false)).toBe(true);
  });

  test("过期后带 ETag；304 更新 checkedAt 且保留数据", async () => {
    const dir = stateDir();
    const first = successFetch("etag-m", "etag-a");
    await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: first.fetchImpl, now: () => BASE_NOW });
    const before = readCacheFile(dir)!;

    const expiredNow = BASE_NOW + MODEL_METADATA_FRESH_TTL_MS + HOUR;
    const second = mockFetch({
      [MODELS_DEV_MODELS_URL]: { status: 304 },
      [MODELS_DEV_API_URL]: { status: 304 }
    });
    const result = await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: second.fetchImpl, now: () => expiredNow });

    // 请求带 If-None-Match
    const modelsCall = second.calls.find((c) => c.url === MODELS_DEV_MODELS_URL);
    const apiCall = second.calls.find((c) => c.url === MODELS_DEV_API_URL);
    expect(modelsCall?.headers["If-None-Match"]).toBe("etag-m");
    expect(apiCall?.headers["If-None-Match"]).toBe("etag-a");

    // 数据保留，fetchedAt 不变，checkedAt 更新
    const after = readCacheFile(dir)!;
    expect(after.modelFacts?.fetchedAt).toBe(before.modelFacts?.fetchedAt);
    expect(after.modelFacts?.checkedAt).not.toBe(before.modelFacts?.checkedAt);
    expect(after.modelFacts?.entries.length).toBe(before.modelFacts?.entries.length);
    expect(result.modelFacts.find((entry) => entry.catalogKey === "openai/gpt-5.2")).toBeTruthy();
    expect(result.sources.every((source) => source.stale === false)).toBe(true);
  });

  test("provider 源失败但 model 源成功时仍可用，分别保留各自时间与 stale 状态", async () => {
    const dir = stateDir();
    const first = successFetch();
    await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: first.fetchImpl, now: () => BASE_NOW });

    const expiredNow = BASE_NOW + MODEL_METADATA_FRESH_TTL_MS + HOUR;
    const second = mockFetch({
      [MODELS_DEV_MODELS_URL]: { status: 200, body: MODELS_BODY, etag: "etag-m2" },
      [MODELS_DEV_API_URL]: { status: 500 }
    });
    const result = await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: second.fetchImpl, now: () => expiredNow });

    const modelSource = result.sources.find((source) => source.kind === "models-dev-model");
    const providerSource = result.sources.find((source) => source.kind === "models-dev-provider");
    expect(modelSource?.stale).toBe(false);
    expect(providerSource?.stale).toBe(true);
    expect(result.modelFacts.length).toBeGreaterThan(0);
    expect(result.providerCatalog.length).toBeGreaterThan(0); // stale 回退仍有数据
  });

  test("一个源返回 304、另一个源失败时，只更新前者的 checkedAt，失败源不得被误标为 fresh", async () => {
    const dir = stateDir();
    const first = successFetch("etag-m", "etag-a");
    await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: first.fetchImpl, now: () => BASE_NOW });
    const before = readCacheFile(dir)!;

    const expiredNow = BASE_NOW + MODEL_METADATA_FRESH_TTL_MS + HOUR;
    const second = mockFetch({
      [MODELS_DEV_MODELS_URL]: { status: 304 },
      [MODELS_DEV_API_URL]: { status: 500 }
    });
    const result = await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: second.fetchImpl, now: () => expiredNow });

    const after = readCacheFile(dir)!;
    // 304 源 checkedAt 更新、标记 fresh
    expect(after.modelFacts?.checkedAt).not.toBe(before.modelFacts?.checkedAt);
    expect(result.sources.find((source) => source.kind === "models-dev-model")?.stale).toBe(false);
    // 失败源 checkedAt 不变、标记 stale
    expect(after.providerCatalog?.checkedAt).toBe(before.providerCatalog?.checkedAt);
    expect(result.sources.find((source) => source.kind === "models-dev-provider")?.stale).toBe(true);
  });

  test("刷新失败时返回 30 天内 stale cache 和 warning", async () => {
    const dir = stateDir();
    const first = successFetch();
    await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: first.fetchImpl, now: () => BASE_NOW });

    const staleNow = BASE_NOW + 2 * DAY; // 超过 fresh TTL 但在 30 天内
    const second = mockFetch({
      [MODELS_DEV_MODELS_URL]: { throwError: new Error("network down") },
      [MODELS_DEV_API_URL]: { throwError: new Error("network down") }
    });
    const result = await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: second.fetchImpl, now: () => staleNow });

    expect(result.modelFacts.find((entry) => entry.catalogKey === "openai/gpt-5.2")).toBeTruthy();
    expect(result.providerCatalog.length).toBeGreaterThan(0);
    expect(result.sources.every((source) => source.stale === true)).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.join(" ")).toContain("缓存数据");
  });

  test("超过 30 天的快照不作为建议数据", async () => {
    const dir = stateDir();
    const first = successFetch();
    await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: first.fetchImpl, now: () => BASE_NOW });

    const tooOldNow = BASE_NOW + 31 * DAY;
    const second = mockFetch({
      [MODELS_DEV_MODELS_URL]: { throwError: new Error("network down") },
      [MODELS_DEV_API_URL]: { throwError: new Error("network down") }
    });
    const result = await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: second.fetchImpl, now: () => tooOldNow });

    expect(result.modelFacts).toEqual([]);
    expect(result.providerCatalog).toEqual([]);
    expect(result.sources).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  test("损坏 JSON 与未知 cache version 不作为建议数据", async () => {
    const failFetch = mockFetch({
      [MODELS_DEV_MODELS_URL]: { status: 500 },
      [MODELS_DEV_API_URL]: { status: 500 }
    });

    // 损坏 JSON
    const corruptDir = stateDir();
    writeFileSync(join(corruptDir, MODEL_METADATA_CACHE_FILENAME), "{not valid json");
    const corruptResult = await loadModelMetadataCatalog({
      stateDir: corruptDir,
      fetchImpl: failFetch.fetchImpl,
      now: () => BASE_NOW
    });
    expect(corruptResult.modelFacts).toEqual([]);
    expect(corruptResult.providerCatalog).toEqual([]);

    // 未知 version
    const unknownDir = stateDir();
    writeFileSync(
      join(unknownDir, MODEL_METADATA_CACHE_FILENAME),
      JSON.stringify({ version: 999, modelFacts: { fetchedAt: "x", checkedAt: "x", entries: [] } })
    );
    const unknownFetch = mockFetch({
      [MODELS_DEV_MODELS_URL]: { status: 500 },
      [MODELS_DEV_API_URL]: { status: 500 }
    });
    const unknownResult = await loadModelMetadataCatalog({
      stateDir: unknownDir,
      fetchImpl: unknownFetch.fetchImpl,
      now: () => BASE_NOW
    });
    expect(unknownResult.modelFacts).toEqual([]);
    expect(unknownResult.providerCatalog).toEqual([]);
  });

  test("超时、非 2xx、响应超限、顶层 schema 错误不会覆盖 last-known-good", async () => {
    async function expectPreserved(setup: Record<string, MockSpec>, label: string) {
      const dir = stateDir();
      const first = successFetch();
      await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: first.fetchImpl, now: () => BASE_NOW });
      const before = readCacheFile(dir)!;

      const expiredNow = BASE_NOW + MODEL_METADATA_FRESH_TTL_MS + HOUR;
      const second = mockFetch(setup);
      const result = await loadModelMetadataCatalog({
        stateDir: dir,
        fetchImpl: second.fetchImpl,
        now: () => expiredNow,
        timeoutMs: 20,
        maxBytesOverride: { "models-dev-model": 16, "models-dev-provider": 16 }
      });

      const after = readCacheFile(dir)!;
      expect(after.modelFacts?.entries.length).toBe(before.modelFacts?.entries.length);
      expect(after.providerCatalog?.entries.length).toBe(before.providerCatalog?.entries.length);
      expect(after.modelFacts?.fetchedAt).toBe(before.modelFacts?.fetchedAt);
      // 回退为 stale 数据
      expect(result.modelFacts.find((entry) => entry.catalogKey === "openai/gpt-5.2")).toBeTruthy();
      expect(result.sources.find((source) => source.kind === "models-dev-model")?.stale).toBe(true);
    }

    // 超时
    await expectPreserved(
      {
        [MODELS_DEV_MODELS_URL]: { never: true },
        [MODELS_DEV_API_URL]: { never: true }
      },
      "timeout"
    );
    // 非 2xx
    await expectPreserved(
      {
        [MODELS_DEV_MODELS_URL]: { status: 503 },
        [MODELS_DEV_API_URL]: { status: 503 }
      },
      "non-2xx"
    );
    // 响应超限（body 远大于 16 字节 override）
    await expectPreserved(
      {
        [MODELS_DEV_MODELS_URL]: { status: 200, body: MODELS_BODY },
        [MODELS_DEV_API_URL]: { status: 200, body: API_BODY }
      },
      "size-exceeded"
    );
    // 顶层 schema 错误（数组而非对象）
    await expectPreserved(
      {
        [MODELS_DEV_MODELS_URL]: { status: 200, body: "[1,2,3]" },
        [MODELS_DEV_API_URL]: { status: 200, body: "[4,5,6]" }
      },
      "schema-error"
    );
  });

  test("任何请求 URL 都是固定 allowlist URL，不拼接 Provider/Model/Key", async () => {
    const dir = stateDir();
    const { fetchImpl, calls } = successFetch();
    await loadModelMetadataCatalog({ stateDir: dir, fetchImpl, now: () => BASE_NOW });
    const allowlist = new Set([MODELS_DEV_MODELS_URL, MODELS_DEV_API_URL]);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(allowlist.has(call.url)).toBe(true);
      expect(call.url).not.toContain("sk-");
    }
  });

  test("超时覆盖响应体读取：慢速传输不会让查询长期挂起", async () => {
    const dir = stateDir();
    const first = successFetch();
    await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: first.fetchImpl, now: () => BASE_NOW });

    // 响应头立即返回，但 body 拖延 150ms；30ms 超时必须中止并回退 stale
    const slowBodyFetch: FetchImpl = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => {
            try {
              controller.enqueue(new TextEncoder().encode(MODELS_BODY));
              controller.close();
            } catch {
              // 流已被中止，忽略
            }
          }, 150);
        }
      });
      return new Response(stream, { status: 200 });
    };

    const expiredNow = BASE_NOW + MODEL_METADATA_FRESH_TTL_MS + HOUR;
    const startedAt = Date.now();
    const result = await loadModelMetadataCatalog({
      stateDir: dir,
      fetchImpl: slowBodyFetch,
      now: () => expiredNow,
      timeoutMs: 30
    });
    // 若超时未覆盖 body 读取，将等到 150ms 后成功返回
    expect(Date.now() - startedAt).toBeLessThan(120);
    expect(result.modelFacts.find((entry) => entry.catalogKey === "openai/gpt-5.2")).toBeTruthy();
    expect(result.sources.find((source) => source.kind === "models-dev-model")?.stale).toBe(true);
    expect(result.warnings.join(" ")).toContain("缓存数据");
  });

  test("缓存重建重新校验数值：负数/小数不进入建议层", async () => {
    const dir = stateDir();
    const first = successFetch();
    await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: first.fetchImpl, now: () => BASE_NOW });

    // 篡改缓存中的数值字段
    const cache = readCacheFile(dir)!;
    const corrupted = cache.modelFacts?.entries.find((entry) => entry.catalogKey === "openai/gpt-5.2");
    expect(corrupted).toBeTruthy();
    corrupted!.contextWindow = -5;
    corrupted!.maxTokens = 1.5;
    writeFileSync(join(dir, MODEL_METADATA_CACHE_FILENAME), JSON.stringify(cache));

    // fresh TTL 内直接复用缓存路径，也不得把非法数值带出来
    const noFetch = mockFetch({
      [MODELS_DEV_MODELS_URL]: { throwError: new Error("must not fetch") },
      [MODELS_DEV_API_URL]: { throwError: new Error("must not fetch") }
    });
    const result = await loadModelMetadataCatalog({
      stateDir: dir,
      fetchImpl: noFetch.fetchImpl,
      now: () => BASE_NOW + HOUR
    });
    expect(noFetch.calls).toHaveLength(0);
    const rebuilt = result.modelFacts.find((entry) => entry.catalogKey === "openai/gpt-5.2");
    expect(rebuilt).toBeTruthy();
    expect(rebuilt?.contextWindow).toBeUndefined();
    expect(rebuilt?.maxTokens).toBeUndefined();
  });

  test("forceRefresh 绕过 fresh TTL 但仍使用 ETag", async () => {
    const dir = stateDir();
    const first = successFetch("etag-m", "etag-a");
    await loadModelMetadataCatalog({ stateDir: dir, fetchImpl: first.fetchImpl, now: () => BASE_NOW });

    // 仍在 TTL 内，但 forceRefresh
    const second = mockFetch({
      [MODELS_DEV_MODELS_URL]: { status: 304 },
      [MODELS_DEV_API_URL]: { status: 304 }
    });
    const result = await loadModelMetadataCatalog({
      stateDir: dir,
      fetchImpl: second.fetchImpl,
      now: () => BASE_NOW + HOUR,
      forceRefresh: true
    });

    expect(second.calls).toHaveLength(2);
    expect(second.calls.find((c) => c.url === MODELS_DEV_MODELS_URL)?.headers["If-None-Match"]).toBe("etag-m");
    expect(result.sources.every((source) => source.stale === false)).toBe(true);
  });

  test("version 1 旧缓存废弃并重新获取", async () => {
    const dir = stateDir();
    // 写入 v1 旧缓存（带明显标记条目）
    writeFileSync(
      join(dir, MODEL_METADATA_CACHE_FILENAME),
      JSON.stringify({
        version: 1,
        modelFacts: {
          fetchedAt: new Date(BASE_NOW).toISOString(),
          checkedAt: new Date(BASE_NOW).toISOString(),
          entries: [
            {
              catalogKey: "legacy/old-model",
              modelId: "old-model",
              sourceKind: "models-dev-model",
              sourceUrl: MODELS_DEV_MODELS_URL
            }
          ]
        }
      })
    );
    const { fetchImpl } = successFetch();
    const result = await loadModelMetadataCatalog({ stateDir: dir, fetchImpl, now: () => BASE_NOW });
    // v1 缓存被废弃：结果来自重新获取，不含旧缓存标记条目
    expect(result.modelFacts.find((entry) => entry.catalogKey === "legacy/old-model")).toBeUndefined();
    expect(result.modelFacts.find((entry) => entry.catalogKey === "openai/gpt-5.2")).toBeTruthy();
    expect(readCacheFile(dir)?.version).toBe(2);
  });
});
