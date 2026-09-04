// packages/core/src/model-metadata-matcher.ts
/**
 * 批量同步专用模糊匹配器（纯函数）。
 *
 * 打分与阈值移植自 CPAMP modelPriceMatcher（经 OpenClawUsage
 * pricing-catalog-matcher.js）；仅供 model-metadata-sync 批量同步使用，
 * 不改变 model-metadata-resolver 的确定性建议语义。
 * 模糊命中一律进确认队列，不自动应用（spec §5.3）。
 */
import { localCoreCandidates } from "./model-id-core";
import type { NormalizedModelMetadata } from "./model-metadata-catalog";
import type { ModelMetadataCatalogData } from "./model-metadata-resolver";

export const FUZZY_SCORE_THRESHOLD = 0.55; // CPAMP 唯一自动生效阈值（此处仅用于 reason 标注）
export const FUZZY_WEAK_THRESHOLD = 0.34; // 弱召回阈值：低于此值不进队列
export const FUZZY_MAX_CANDIDATES = 8;
const TOKEN_JACCARD_WEIGHT = 0.86;
const EDIT_SIMILARITY_WEIGHT = 0.82;

/** 已知模型厂官方 provider 集合（对照 models.dev 实际 provider id，保持保守） */
export const KNOWN_MODEL_CREATORS: ReadonlySet<string> = new Set([
  "anthropic", "openai", "google", "deepseek", "moonshotai", "moonshotai-cn",
  "meta", "mistral", "xai", "zai"
]);

export function tokenizeModelId(value: string): string[] {
  // 保留小数点：「5.6」「4.6」等版本号必须视为单 token，
  // 否则版本差异（glm-4.6 vs glm-4.5）会被错误地算作共享 token
  return value.toLowerCase().split(/[^a-z0-9.]+/).filter(Boolean);
}

export function tokenJaccard(a: string, b: string): number {
  const sa = new Set(tokenizeModelId(a));
  const sb = new Set(tokenizeModelId(b));
  if (!sa.size || !sb.size) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => [i, ...Array<number>(n).fill(0)]);
  for (let j = 1; j <= n; j++) dp[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i]![j] = Math.min(
        dp[i - 1]![j]! + 1,
        dp[i]![j - 1]! + 1,
        dp[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m]![n]!;
}

export function editSimilarity(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - levenshtein(a, b) / maxLen;
}

/** 候选打分：token Jaccard × 0.86 与编辑相似度 × 0.82 取大（参考 CPAMP） */
export function scoreCandidate(probe: string, catalogModelId: string): number {
  return Math.max(
    tokenJaccard(probe, catalogModelId) * TOKEN_JACCARD_WEIGHT,
    editSimilarity(probe, catalogModelId) * EDIT_SIMILARITY_WEIGHT
  );
}

/** 官方条目启发式：已知模型厂 provider，或 provider id 作为 token 出现在 model id 中 */
export function isOfficialMetadataEntry(entry: NormalizedModelMetadata): boolean {
  const provider = entry.providerId?.toLowerCase() ?? "";
  if (!provider) return false;
  return KNOWN_MODEL_CREATORS.has(provider) || tokenizeModelId(entry.modelId).includes(provider);
}

/** 两 id 的 token 集合互为严格子集（一方是另一方的截断/加长版） */
export function hasStrictTokenContainment(a: string, b: string): boolean {
  const sa = new Set(tokenizeModelId(a));
  const sb = new Set(tokenizeModelId(b));
  if (sa.size === sb.size) return false;
  const [small, large] = sa.size < sb.size ? [sa, sb] : [sb, sa];
  for (const t of small) if (!large.has(t)) return false;
  return true;
}

export interface FuzzyMetadataCandidate {
  metadata: NormalizedModelMetadata;
  score: number;
  reason: string;
}

/** 同 id 条目组内选代表：优先本 provider，其次官方条目，最后按 catalogKey 稳定序 */
function pickRepresentative(
  entries: NormalizedModelMetadata[],
  providerId: string
): NormalizedModelMetadata {
  const own = entries.filter((entry) => entry.providerId?.toLowerCase() === providerId);
  if (own.length > 0) return own.slice().sort((a, b) => a.catalogKey.localeCompare(b.catalogKey))[0]!;
  const official = entries.filter(isOfficialMetadataEntry);
  const pool = official.length > 0 ? official : entries;
  return pool.slice().sort((a, b) => a.catalogKey.localeCompare(b.catalogKey))[0]!;
}

/**
 * 对本地模型 id 做模糊召回：probe 取 core 归一化的**首个**候选（剥前缀、不逐段截断，
 * 保留最多区分信息）；对目录全部 modelId 打分，按组选代表后过滤弱阈值、降序取前 8。
 */
export function matchFuzzyModelMetadata(
  input: { providerId: string; modelId: string },
  catalog: ModelMetadataCatalogData
): FuzzyMetadataCandidate[] {
  const cores = localCoreCandidates(input.modelId);
  const probe = (cores[0] ?? input.modelId.trim()).toLowerCase();
  if (!probe) return [];
  const providerId = input.providerId.trim().toLowerCase();

  const groups = new Map<string, NormalizedModelMetadata[]>();
  for (const entry of [...catalog.providerCatalog, ...catalog.modelFacts]) {
    const key = entry.modelId.toLowerCase();
    const list = groups.get(key);
    if (list) list.push(entry);
    else groups.set(key, [entry]);
  }

  const scored: FuzzyMetadataCandidate[] = [];
  for (const [id, entries] of groups) {
    const score = scoreCandidate(probe, id);
    if (score < FUZZY_WEAK_THRESHOLD) continue;
    scored.push({
      metadata: pickRepresentative(entries, providerId),
      score,
      reason: hasStrictTokenContainment(probe, id)
        ? "token-containment"
        : score >= FUZZY_SCORE_THRESHOLD
          ? "shared-model-tokens"
          : "weak-recall"
    });
  }
  scored.sort((a, b) => b.score - a.score || a.metadata.catalogKey.localeCompare(b.metadata.catalogKey));
  return scored.slice(0, FUZZY_MAX_CANDIDATES);
}
