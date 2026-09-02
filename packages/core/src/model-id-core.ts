/**
 * 模型 ID 核心归一化（仅供 Models.dev 参数建议匹配使用）。
 *
 * 全部为确定性规则的纯函数：不做编辑距离/相似度。
 * 归一化只影响匹配，绝不用于写回 openclaw.json。
 * 详见 docs/superpowers/specs/2026-09-02-oc-switch-model-metadata-core-id-matching-design.md §5。
 */

/** 已知思考等级尾段（小写比较） */
export const THINKING_LEVEL_SUFFIXES: readonly string[] = ["high", "medium", "low", "minimal"];

/** 已知路由/供应商尾段（小写比较）；集中定义便于扩充 */
export const ROUTING_SUFFIXES: readonly string[] = [
  "fireworks",
  "groq",
  "together",
  "deepinfra",
  "openrouter",
  "azure",
  "cerebras",
  "sambanova",
  "novita",
  "baseten",
  "nebius",
  "hyperbolic"
];

const DATE_MMDD = /^\d{4}$/;
const DATE_YYYYMMDD = /^\d{8}$/;
const DATE_ISO = /^\d{4}-\d{2}-\d{2}$/;

/** 取最后一个 `/` 之后的子串；无 `/` 原样返回 */
export function stripModelIdPrefix(id: string): string {
  const slash = id.lastIndexOf("/");
  return slash >= 0 ? id.slice(slash + 1) : id;
}

/**
 * 目录侧 coreId：剥前缀后循环剥离尾部日期段
 * （`\d{8}`、`\d{4}-\d{2}-\d{2}` 三段组合、`\d{4}`）。
 * 目录侧只剥日期，不剥枚举后缀；永不剥成空串。
 */
export function stripCatalogDateSuffixes(id: string): { core: string; stripped: string[] } {
  let core = stripModelIdPrefix(id.trim());
  const stripped: string[] = [];
  for (;;) {
    const segments = core.split("-");
    if (segments.length >= 4) {
      const tail3 = segments.slice(-3).join("-");
      if (DATE_ISO.test(tail3)) {
        core = segments.slice(0, -3).join("-");
        stripped.unshift(tail3);
        continue;
      }
    }
    const last = segments[segments.length - 1] ?? "";
    if (segments.length >= 2 && (DATE_YYYYMMDD.test(last) || DATE_MMDD.test(last))) {
      core = segments.slice(0, -1).join("-");
      stripped.unshift(last);
      continue;
    }
    break;
  }
  return { core, stripped };
}

/** 本地侧渐进候选：core0（剥前缀后）→ 逐段剥尾，最长优先；最少保留 1 段；去重 */
export function localCoreCandidates(id: string): string[] {
  const base = stripModelIdPrefix(id.trim());
  if (!base) return [];
  const candidates: string[] = [base];
  let current = base;
  while (current.includes("-")) {
    const next = current.slice(0, current.lastIndexOf("-"));
    if (!next || candidates.includes(next)) break;
    candidates.push(next);
    current = next;
  }
  return candidates;
}

/** 分类单个尾段（大小写不敏感） */
export function classifyTailSegment(segment: string): "date" | "thinking" | "routing" | "unknown" {
  if (DATE_MMDD.test(segment) || DATE_YYYYMMDD.test(segment)) return "date";
  const lower = segment.toLowerCase();
  if ((THINKING_LEVEL_SUFFIXES as readonly string[]).includes(lower)) return "thinking";
  if ((ROUTING_SUFFIXES as readonly string[]).includes(lower)) return "routing";
  return "unknown";
}

/**
 * 分类「从 base 剥到 core 所去掉的尾缀」整体是否全部为已知类别。
 * 先整体匹配 ISO 日期，避免把 2024-08-06 拆段后把 08/06 误判为 unknown。
 */
export function classifyStrippedSuffix(base: string, core: string): "known" | "unknown" {
  if (base === core) return "known";
  const suffix = base.startsWith(`${core}-`) ? base.slice(core.length + 1) : "";
  if (!suffix) return "unknown";
  if (DATE_ISO.test(suffix)) return "known";
  return suffix.split("-").every((segment) => classifyTailSegment(segment) !== "unknown") ? "known" : "unknown";
}
