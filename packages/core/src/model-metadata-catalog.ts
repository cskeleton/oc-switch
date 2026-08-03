import { readJsonState, writeJsonState } from "./json-state-store";
import type { FetchImpl } from "./provider-sync";

/**
 * Models.dev 模型元数据目录加载器。
 *
 * 只下载两份固定的公开 JSON（models.json 模型事实、api.json Provider 目录），
 * 在本地归一化并做版本化缓存。绝不把 Provider ID / Model ID / baseUrl / API Key
 * 拼进请求，外发请求永远是固定 allowlist URL。
 */

export type ModelMetadataSourceKind = "models-dev-model" | "models-dev-provider";

export const MODELS_DEV_MODELS_URL = "https://models.dev/models.json";
export const MODELS_DEV_API_URL = "https://models.dev/api.json";

/** 缓存 schema 版本；未知版本视为不可用并重新获取 */
export const MODEL_METADATA_CACHE_VERSION = 1;
export const MODEL_METADATA_CACHE_FILENAME = "model-metadata-cache.json";

/** Fresh TTL：24 小时内复用缓存不联网 */
export const MODEL_METADATA_FRESH_TTL_MS = 24 * 60 * 60 * 1000;
/** Stale fallback：最后成功快照最多使用 30 天 */
export const MODEL_METADATA_STALE_MAX_MS = 30 * 24 * 60 * 60 * 1000;
/** 单次请求超时（测试可注入更短值） */
export const MODEL_METADATA_TIMEOUT_MS = 5000;

/** 响应大小上限 */
export const MODEL_METADATA_MODELS_MAX_BYTES = 2 * 1024 * 1024;
export const MODEL_METADATA_API_MAX_BYTES = 8 * 1024 * 1024;

/** 归一化后的单条模型元数据（不泄漏完整第三方 schema） */
export interface NormalizedModelMetadata {
  catalogKey: string;
  providerId?: string;
  modelId: string;
  name?: string;
  contextWindow?: number;
  inputLimit?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
  updatedAt?: string;
  /** 仅 provider-specific 条目：Models.dev Provider 声明的 api base URL（用于 endpoint-exact 匹配） */
  providerApi?: string;
  sourceKind: ModelMetadataSourceKind;
  sourceUrl: string;
}

export interface ModelMetadataCacheSource {
  fetchedAt: string;
  checkedAt: string;
  etag?: string;
  entries: NormalizedModelMetadata[];
}

export interface ModelMetadataCache {
  version: 1;
  modelFacts?: ModelMetadataCacheSource;
  providerCatalog?: ModelMetadataCacheSource;
}

/** 逐源时间/stale 状态（不含 entries） */
export interface ModelMetadataSourceStatus {
  kind: ModelMetadataSourceKind;
  fetchedAt: string;
  checkedAt: string;
  stale: boolean;
}

export interface LoadModelMetadataOptions {
  stateDir: string;
  fetchImpl?: FetchImpl;
  /** 可注入时钟，便于测试 TTL/stale */
  now?: () => number;
  /** 可注入超时，默认 5s */
  timeoutMs?: number;
  /** true 时绕过 fresh TTL 强制刷新（仍使用 ETag） */
  forceRefresh?: boolean;
  /** 测试注入：覆盖单源响应大小上限 */
  maxBytesOverride?: Partial<Record<ModelMetadataSourceKind, number>>;
}

export interface LoadModelMetadataResult {
  modelFacts: NormalizedModelMetadata[];
  providerCatalog: NormalizedModelMetadata[];
  sources: ModelMetadataSourceStatus[];
  warnings: string[];
}

interface SourceConfig {
  kind: ModelMetadataSourceKind;
  url: string;
  maxBytes: number;
  cacheKey: "modelFacts" | "providerCatalog";
  normalize: (parsed: unknown, warnings: string[]) => NormalizedModelMetadata[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只接受正有限整数 token 值；其余返回 undefined（不允许 NaN/负数进入建议层） */
function positiveIntegerLimit(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return value;
}

function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

function normalizeModelEntry(
  raw: Record<string, unknown>,
  ids: { catalogKey: string; providerId?: string; modelId: string; providerApi?: string },
  sourceKind: ModelMetadataSourceKind,
  sourceUrl: string,
  warnings: string[]
): NormalizedModelMetadata {
  const limit = isPlainObject(raw.limit) ? raw.limit : {};
  const modalities = isPlainObject(raw.modalities) ? raw.modalities : {};

  const entry: NormalizedModelMetadata = {
    catalogKey: ids.catalogKey,
    modelId: ids.modelId,
    sourceKind,
    sourceUrl
  };
  if (ids.providerId !== undefined) entry.providerId = ids.providerId;
  if (ids.providerApi !== undefined) entry.providerApi = ids.providerApi;
  if (typeof raw.name === "string" && raw.name.trim()) entry.name = raw.name;
  if (typeof raw.reasoning === "boolean") entry.reasoning = raw.reasoning;
  if (typeof raw.last_updated === "string" && raw.last_updated.trim()) entry.updatedAt = raw.last_updated;

  const contextWindow = positiveIntegerLimit(limit.context);
  const inputLimit = positiveIntegerLimit(limit.input);
  const maxTokens = positiveIntegerLimit(limit.output);
  if (contextWindow !== undefined) entry.contextWindow = contextWindow;
  else if (limit.context !== undefined) warnings.push(`${ids.catalogKey}: 忽略非法 limit.context`);
  if (inputLimit !== undefined) entry.inputLimit = inputLimit;
  else if (limit.input !== undefined) warnings.push(`${ids.catalogKey}: 忽略非法 limit.input`);
  if (maxTokens !== undefined) entry.maxTokens = maxTokens;
  else if (limit.output !== undefined) warnings.push(`${ids.catalogKey}: 忽略非法 limit.output`);

  if (Array.isArray(modalities.input)) {
    const input = modalities.input.filter((mode): mode is string => typeof mode === "string");
    if (input.length) entry.input = input;
  }
  return entry;
}

/** 归一化 models.json：顶层为 { "<provider>/<model>": {...} } */
function normalizeModelsFacts(parsed: unknown, warnings: string[]): NormalizedModelMetadata[] {
  if (!isPlainObject(parsed)) throw new Error("models.json 顶层必须是对象");
  const entries: NormalizedModelMetadata[] = [];
  for (const [catalogKey, raw] of Object.entries(parsed)) {
    if (!isPlainObject(raw)) {
      warnings.push(`models.json: 跳过非法条目 ${catalogKey}`);
      continue;
    }
    const slash = catalogKey.indexOf("/");
    const providerId = slash > 0 ? catalogKey.slice(0, slash) : undefined;
    const modelId = slash >= 0 && slash < catalogKey.length - 1 ? catalogKey.slice(slash + 1) : catalogKey;
    entries.push(
      normalizeModelEntry(
        raw,
        { catalogKey, ...(providerId !== undefined ? { providerId } : {}), modelId },
        "models-dev-model",
        MODELS_DEV_MODELS_URL,
        warnings
      )
    );
  }
  return entries;
}

/** 归一化 api.json：顶层为 { "<providerId>": { models: { "<rawModelId>": {...} } } } */
function normalizeProviderCatalog(parsed: unknown, warnings: string[]): NormalizedModelMetadata[] {
  if (!isPlainObject(parsed)) throw new Error("api.json 顶层必须是对象");
  const entries: NormalizedModelMetadata[] = [];
  for (const [providerId, providerRaw] of Object.entries(parsed)) {
    if (!isPlainObject(providerRaw)) {
      warnings.push(`api.json: 跳过非法 provider ${providerId}`);
      continue;
    }
    const models = providerRaw.models;
    if (!isPlainObject(models)) continue;
    const providerApi = typeof providerRaw.api === "string" && providerRaw.api.trim() ? providerRaw.api : undefined;
    for (const [modelId, modelRaw] of Object.entries(models)) {
      if (!isPlainObject(modelRaw)) {
        warnings.push(`api.json: 跳过非法模型 ${providerId}/${modelId}`);
        continue;
      }
      entries.push(
        normalizeModelEntry(
          modelRaw,
          { catalogKey: `${providerId}/${modelId}`, providerId, modelId, ...(providerApi ? { providerApi } : {}) },
          "models-dev-provider",
          MODELS_DEV_API_URL,
          warnings
        )
      );
    }
  }
  return entries;
}

const MODELS_SOURCE: SourceConfig = {
  kind: "models-dev-model",
  url: MODELS_DEV_MODELS_URL,
  maxBytes: MODEL_METADATA_MODELS_MAX_BYTES,
  cacheKey: "modelFacts",
  normalize: normalizeModelsFacts
};

const PROVIDER_SOURCE: SourceConfig = {
  kind: "models-dev-provider",
  url: MODELS_DEV_API_URL,
  maxBytes: MODEL_METADATA_API_MAX_BYTES,
  cacheKey: "providerCatalog",
  normalize: normalizeProviderCatalog
};

/** 从缓存重建可信条目对象（丢弃任意未知字段） */
function rebuildEntry(raw: unknown): NormalizedModelMetadata | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.catalogKey !== "string" || typeof raw.modelId !== "string") return undefined;
  if (raw.sourceKind !== "models-dev-model" && raw.sourceKind !== "models-dev-provider") return undefined;
  if (typeof raw.sourceUrl !== "string") return undefined;
  const entry: NormalizedModelMetadata = {
    catalogKey: raw.catalogKey,
    modelId: raw.modelId,
    sourceKind: raw.sourceKind,
    sourceUrl: raw.sourceUrl
  };
  if (typeof raw.providerId === "string") entry.providerId = raw.providerId;
  if (typeof raw.name === "string") entry.name = raw.name;
  // 缓存重建必须重新校验数值：损坏/被篡改缓存中的负数、0、小数不得进入建议层
  const contextWindow = positiveIntegerLimit(raw.contextWindow);
  if (contextWindow !== undefined) entry.contextWindow = contextWindow;
  const inputLimit = positiveIntegerLimit(raw.inputLimit);
  if (inputLimit !== undefined) entry.inputLimit = inputLimit;
  const maxTokens = positiveIntegerLimit(raw.maxTokens);
  if (maxTokens !== undefined) entry.maxTokens = maxTokens;
  if (typeof raw.reasoning === "boolean") entry.reasoning = raw.reasoning;
  if (Array.isArray(raw.input)) {
    const input = raw.input.filter((mode): mode is string => typeof mode === "string");
    if (input.length) entry.input = input;
  }
  if (typeof raw.updatedAt === "string") entry.updatedAt = raw.updatedAt;
  if (typeof raw.providerApi === "string") entry.providerApi = raw.providerApi;
  return entry;
}

function rebuildCacheSource(raw: unknown): ModelMetadataCacheSource | undefined {
  if (!isPlainObject(raw)) return undefined;
  if (typeof raw.fetchedAt !== "string" || typeof raw.checkedAt !== "string") return undefined;
  if (!Array.isArray(raw.entries)) return undefined;
  const entries: NormalizedModelMetadata[] = [];
  for (const entry of raw.entries) {
    const rebuilt = rebuildEntry(entry);
    if (rebuilt) entries.push(rebuilt);
  }
  const source: ModelMetadataCacheSource = { fetchedAt: raw.fetchedAt, checkedAt: raw.checkedAt, entries };
  if (typeof raw.etag === "string") source.etag = raw.etag;
  return source;
}

function readCache(stateDir: string): ModelMetadataCache {
  return readJsonState<ModelMetadataCache>({
    stateDir,
    filename: MODEL_METADATA_CACHE_FILENAME,
    fallback: () => ({ version: 1 }),
    invalidJson: "fallback",
    normalize(value) {
      if (!isPlainObject(value) || value.version !== MODEL_METADATA_CACHE_VERSION) return { version: 1 };
      const cache: ModelMetadataCache = { version: 1 };
      const modelFacts = rebuildCacheSource(value.modelFacts);
      const providerCatalog = rebuildCacheSource(value.providerCatalog);
      if (modelFacts) cache.modelFacts = modelFacts;
      if (providerCatalog) cache.providerCatalog = providerCatalog;
      return cache;
    }
  });
}


/** 读取响应体并累计字节，超过上限即中止（不仅依赖 Content-Length） */
async function readBodyWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new Error("Model metadata response exceeds size limit");
  }
  const body = response.body;
  if (!body) {
    const text = await response.text();
    if (text.length > maxBytes) throw new Error("Model metadata response exceeds size limit");
    return text;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) throw new Error("Model metadata response exceeds size limit");
        chunks.push(value);
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 忽略释放锁失败
    }
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

async function fetchSource(
  config: SourceConfig,
  etag: string | undefined,
  fetchImpl: FetchImpl,
  timeoutMs: number,
  maxBytes: number
): Promise<{ notModified: true } | { bodyText: string; etag?: string }> {
  // 超时必须覆盖“请求 + 响应体读取”全过程：慢速传输（头部先到、body 拖延）同样要中止，
  // 否则查询会长期挂起。定时器在整个序列完成前保持有效，并在超时时 abort 以取消底层流。
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`Model metadata request timeout: ${config.url}`));
    }, timeoutMs);
  });
  const sequence = (async () => {
    const headers: Record<string, string> = {};
    if (etag) headers["If-None-Match"] = etag;
    const response = await fetchImpl(config.url, { headers, signal: controller.signal });
    if (response.status === 304) return { notModified: true as const };
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Model metadata source returned HTTP ${response.status}: ${config.url}`);
    }
    const bodyText = await readBodyWithLimit(response, maxBytes);
    const responseEtag = response.headers?.get?.("etag") ?? undefined;
    return { bodyText, ...(responseEtag ? { etag: responseEtag } : {}) };
  })();
  try {
    return await Promise.race([sequence, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * 加载 Models.dev 元数据目录（带缓存、ETag、TTL 与 stale 降级）。
 * 只在用户查询建议或显式刷新时调用；不在应用启动时联网。
 */
export async function loadModelMetadataCatalog(options: LoadModelMetadataOptions): Promise<LoadModelMetadataResult> {
  const nowValue = (options.now ?? Date.now)();
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? MODEL_METADATA_TIMEOUT_MS;
  const forceRefresh = options.forceRefresh ?? false;

  const cache = readCache(options.stateDir);
  const nextCache: ModelMetadataCache = { version: 1 };
  if (cache.modelFacts) nextCache.modelFacts = cache.modelFacts;
  if (cache.providerCatalog) nextCache.providerCatalog = cache.providerCatalog;

  const warnings: string[] = [];
  const sources: ModelMetadataSourceStatus[] = [];
  let dirty = false;

  async function processSource(config: SourceConfig): Promise<NormalizedModelMetadata[]> {
    const maxBytes = options.maxBytesOverride?.[config.kind] ?? config.maxBytes;
    const cached = nextCache[config.cacheKey];

    // Fresh TTL 内复用缓存，不联网
    if (cached && !forceRefresh && nowValue - Date.parse(cached.checkedAt) < MODEL_METADATA_FRESH_TTL_MS) {
      sources.push({ kind: config.kind, fetchedAt: cached.fetchedAt, checkedAt: cached.checkedAt, stale: false });
      return cached.entries;
    }

    try {
      const fetched = await fetchSource(config, cached?.etag, fetchImpl, timeoutMs, maxBytes);
      if ("notModified" in fetched) {
        if (!cached) throw new Error("304 without cached snapshot");
        // 304 仅更新 checkedAt，保留数据与 fetchedAt
        const updated: ModelMetadataCacheSource = { ...cached, checkedAt: toIso(nowValue) };
        nextCache[config.cacheKey] = updated;
        dirty = true;
        sources.push({ kind: config.kind, fetchedAt: updated.fetchedAt, checkedAt: updated.checkedAt, stale: false });
        return cached.entries;
      }
      const parsed = JSON.parse(fetched.bodyText) as unknown;
      const entries = config.normalize(parsed, warnings);
      const newSource: ModelMetadataCacheSource = {
        fetchedAt: toIso(nowValue),
        checkedAt: toIso(nowValue),
        entries
      };
      if (fetched.etag) newSource.etag = fetched.etag;
      nextCache[config.cacheKey] = newSource;
      dirty = true;
      sources.push({ kind: config.kind, fetchedAt: newSource.fetchedAt, checkedAt: newSource.checkedAt, stale: false });
      return entries;
    } catch (error) {
      // 失败 → 若最后成功快照仍在 30 天窗口内则作为 stale 返回，不覆盖 last-known-good
      if (cached && nowValue - Date.parse(cached.fetchedAt) <= MODEL_METADATA_STALE_MAX_MS) {
        warnings.push(`${config.kind} 目录刷新失败，使用缓存数据：${failureMessage(error)}`);
        sources.push({ kind: config.kind, fetchedAt: cached.fetchedAt, checkedAt: cached.checkedAt, stale: true });
        return cached.entries;
      }
      warnings.push(`${config.kind} 目录不可用：${failureMessage(error)}`);
      return [];
    }
  }

  const modelFacts = await processSource(MODELS_SOURCE);
  const providerCatalog = await processSource(PROVIDER_SOURCE);

  if (dirty) {
    writeJsonState({ stateDir: options.stateDir, filename: MODEL_METADATA_CACHE_FILENAME, value: nextCache });
  }

  return { modelFacts, providerCatalog, sources, warnings };
}
