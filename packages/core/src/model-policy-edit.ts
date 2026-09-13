import {
  findPolicyExactEntryForRef,
  findPolicyWildcardForRef,
  getModelPolicyMode,
  isPolicyAllowsRef,
  readModelPolicyAllow,
  readModelPolicyAllowRaw
} from "./model-policy";
import { normalizeModelRefForStorage, normalizeProviderId, parseModelRef } from "./model-ref";
import type { ModelInventory } from "./model-inventory";
import type { OperationResult } from "./operation-common";
import { readFallbackModelRefs, readPrimaryModelRef } from "./primary-model";
import type { OpenClawConfig } from "./types";

/**
 * `agents.defaults.modelPolicy.allow` 显式规则编辑 operation（spec §3 Core 契约）。
 *
 * 两个用户显式指令驱动的纯 mutation，供 Server/CLI 在 `writeOpenClawTransaction`
 * 内调用：
 * - `addModelPolicyRule`：添加 exact 或 wildcard 规则（按 `/*` 后缀识别）；
 * - `removeModelPolicyWildcard`：按完全相同字符串删除 wildcard 规则（含全部重复副本）。
 *
 * 写入纪律（spec §7）：只在 restricted 模式下编辑，永不创建/清空 policy、不做
 * 模式切换；除 push 新规则与按完全相同字符串 filter 外，绝不动已有条目的大小写、
 * 顺序、重复次数与非字符串条目。守卫（模式门禁 / 防清空 / primary / fallback 覆盖）
 * fail closed，无 force 选项。
 *
 * 输入 config 都不会被修改（入口 structuredClone），错误一律以
 * `ModelPolicyEditError`（结构化 code）抛出，由上层映射为 HTTP 400 / CLI 非零退出。
 */

/** 结构化 blocker code：Server/CLI 据此映射为可操作的 400 提示 */
export type ModelPolicyEditErrorCode =
  | "invalid-rule-format"
  | "duplicate-rule"
  | "policy-not-restricted"
  | "policy-rule-not-found"
  | "primary-model-referenced"
  | "fallback-referenced"
  | "last-rule-removal";

export class ModelPolicyEditError extends Error {
  readonly code: ModelPolicyEditErrorCode;

  constructor(code: ModelPolicyEditErrorCode, message: string) {
    super(message);
    this.name = "ModelPolicyEditError";
    this.code = code;
  }
}

export function isModelPolicyEditError(error: unknown): error is ModelPolicyEditError {
  return error instanceof ModelPolicyEditError;
}

/** 同一逻辑模型的引用归一：Provider 折叠 + model 敏感；解析失败返回 undefined（永不命中保护）。 */
function protectedRefIdentity(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  try {
    return normalizeModelRefForStorage(ref);
  } catch {
    return undefined;
  }
}

export interface AddModelPolicyRuleOptions {
  /** 已知 Provider 目录 ID 集合（大小写折叠比较）；未命中时只追加 warning，不阻断。 */
  knownProviderIds?: Iterable<string>;
}

/**
 * 添加一条 policy 规则（spec §3.1）。
 *
 * - `provider/model` 精确规则按 `normalizeModelRefForStorage` 归一存储；wildcard
 *   规则按用户输入原样存储（仅 trim）；写入仅限 raw allow 末尾 push；
 * - exact 已被现有 exact 条目语义覆盖时拒绝（duplicate）；仅被 wildcard 覆盖时
 *   允许写入并提示冗余；wildcard 已存在完全相同字符串时拒绝，被更宽 wildcard
 *   覆盖时允许并提示；
 * - 模式门禁：非 restricted（legacy / unrestricted）一律拒绝，不创建 policy；
 * - 守卫通过前不克隆、不落盘；输入 config 不被修改。
 */
export function addModelPolicyRule(
  config: OpenClawConfig,
  rule: string,
  options: AddModelPolicyRuleOptions = {}
): OperationResult & { rule: string; kind: "exact" | "wildcard" } {
  // 1. 格式校验（任一失败即抛，不落盘）
  const trimmed = rule.trim();
  if (trimmed === "") {
    throw new ModelPolicyEditError("invalid-rule-format", "Policy rule must not be empty.");
  }
  const kind: "exact" | "wildcard" = trimmed.endsWith("/*") ? "wildcard" : "exact";
  let providerSegment: string;
  if (kind === "wildcard") {
    const body = trimmed.slice(0, -2);
    const slashIndex = body.indexOf("/");
    // body 必须非空、不得再含 `*`、第一段（首个 `/` 之前）非空
    if (body === "" || body.includes("*") || slashIndex === 0) {
      throw new ModelPolicyEditError(
        "invalid-rule-format",
        `Invalid wildcard rule ${trimmed}: expected provider/* or provider/namespace/*.`
      );
    }
    providerSegment = slashIndex === -1 ? body : body.slice(0, slashIndex);
  } else {
    // exact 规则不得含 `*`（`abc/*x`、`*/x` 这类混入通配符的非法形态在此拒绝）
    if (trimmed.includes("*")) {
      throw new ModelPolicyEditError(
        "invalid-rule-format",
        `Invalid exact rule ${trimmed}: wildcard markers are only allowed as a trailing /*.`
      );
    }
    try {
      providerSegment = parseModelRef(trimmed).providerId;
    } catch {
      throw new ModelPolicyEditError(
        "invalid-rule-format",
        `Invalid exact rule ${trimmed}: expected provider/model.`
      );
    }
  }

  // 2. 模式门禁：不创建 policy，也不允许在 unrestricted 下改 [] 的形状
  const mode = getModelPolicyMode(config);
  if (mode !== "restricted") {
    throw new ModelPolicyEditError(
      "policy-not-restricted",
      `Policy rule editing requires restricted mode; the current modelPolicy.allow mode is ${mode}.`
    );
  }

  const raw = readModelPolicyAllowRaw(config)!;
  const allowStrings = readModelPolicyAllow(config) ?? [];
  const warnings: string[] = [];

  // 3. duplicate / 冗余覆盖检查
  let storedRule: string;
  if (kind === "exact") {
    storedRule = normalizeModelRefForStorage(trimmed);
    const duplicate = findPolicyExactEntryForRef(config, storedRule);
    if (duplicate !== undefined) {
      throw new ModelPolicyEditError(
        "duplicate-rule",
        `Rule ${storedRule} is already covered by the existing exact entry ${duplicate}.`
      );
    }
    const coveringWildcard = findPolicyWildcardForRef(config, storedRule);
    if (coveringWildcard !== undefined) {
      warnings.push(
        `Rule ${storedRule} is already covered by wildcard ${coveringWildcard}; this exact rule is currently redundant.`
      );
    }
  } else {
    storedRule = trimmed;
    if (raw.some((entry) => entry === storedRule)) {
      throw new ModelPolicyEditError(
        "duplicate-rule",
        `Wildcard rule ${storedRule} already exists in agents.defaults.modelPolicy.allow.`
      );
    }
    // 用探测 ref `body/_` 检查是否被更宽的现有 wildcard 覆盖（`_` 不在任何条目中出现，不会命中 exact）
    const coveringWildcard = findPolicyWildcardForRef(config, `${storedRule.slice(0, -2)}/_`);
    if (coveringWildcard !== undefined) {
      warnings.push(
        `Rule ${storedRule} is already covered by the broader wildcard ${coveringWildcard}; this rule is currently redundant.`
      );
    }
  }

  // 4. knownProviderIds 未命中只提示（未知 Provider 不阻断规则编辑）
  if (options.knownProviderIds !== undefined) {
    const known = new Set([...options.knownProviderIds].map((id) => normalizeProviderId(id)));
    if (!known.has(normalizeProviderId(providerSegment))) {
      warnings.push(
        `Provider ${providerSegment} is not in the known catalog; this rule currently matches no model.`
      );
    }
  }

  // 5. 写入：仅向 raw allow 数组末尾 push；不动其它条目的大小写、顺序、重复次数与非字符串条目
  const next = structuredClone(config);
  next.agents!.defaults!.modelPolicy!.allow!.push(storedRule);
  return { config: next, warnings, rule: storedRule, kind };
}

export interface RemoveModelPolicyWildcardOptions {
  /** 提供时追加「失去策略放行」warning；缺省时跳过该 warning。 */
  inventory?: ModelInventory;
}

/**
 * 按完全相同字符串删除一条 wildcard 规则（spec §3.2），含全部重复副本。
 *
 * - 模式门禁：非 restricted 拒绝；raw 中不存在完全相同字符串拒绝；
 * - 防清空（fail closed）：移除所有相同条目后 raw 会变 []（unrestricted）时拒绝，
 *   非字符串条目计入剩余；
 * - primary/fallback 覆盖保护（fail closed）：ref 当前被该 wildcard 覆盖且剩余
 *   规则（exact + 其他 wildcard）不再覆盖它时拒绝；
 * - 写入仅限 `raw.filter(e => e !== value)`；不动其它条目；
 * - 输入 config 不被修改。
 */
export function removeModelPolicyWildcard(
  config: OpenClawConfig,
  value: string,
  options: RemoveModelPolicyWildcardOptions = {}
): OperationResult & { removedCount: number } {
  // 1. 格式校验：exact 删除走 removeModelPolicyExactRef
  const trimmed = value.trim();
  if (!trimmed.endsWith("/*")) {
    throw new ModelPolicyEditError(
      "invalid-rule-format",
      `Rule ${trimmed} is not a wildcard; remove exact policy rules with removeModelPolicyExactRef instead.`
    );
  }

  // 2. 模式门禁（与 addModelPolicyRule 一致）
  const mode = getModelPolicyMode(config);
  if (mode !== "restricted") {
    throw new ModelPolicyEditError(
      "policy-not-restricted",
      `Policy rule editing requires restricted mode; the current modelPolicy.allow mode is ${mode}.`
    );
  }

  const raw = readModelPolicyAllowRaw(config)!;
  const removedCount = raw.filter((entry) => entry === trimmed).length;
  if (removedCount === 0) {
    throw new ModelPolicyEditError(
      "policy-rule-not-found",
      `Wildcard rule ${trimmed} not found in agents.defaults.modelPolicy.allow; nothing to remove.`
    );
  }

  // 3. 防清空：非字符串条目计入剩余（与 assertPolicyRemovalPreservesRestrictedMode 语义一致）
  const remainingRaw = raw.filter((entry) => entry !== trimmed);
  if (remainingRaw.length === 0) {
    throw new ModelPolicyEditError(
      "last-rule-removal",
      `Cannot remove ${trimmed} because removing the last agents.defaults.modelPolicy.allow entry would make [] unrestricted; keep another rule or narrow the policy first.`
    );
  }

  // 4. primary/fallback 覆盖保护：剩余字符串规则（exact + 其他 wildcard）必须仍覆盖受保护引用
  const remainingStrings = remainingRaw.filter((entry): entry is string => typeof entry === "string");
  const remainingAllowStrings = (readModelPolicyAllow(config) ?? []).filter((entry) => entry !== trimmed);
  const primaryIdentity = protectedRefIdentity(readPrimaryModelRef(config));
  if (
    primaryIdentity !== undefined &&
    isPolicyAllowsRef([trimmed], primaryIdentity) &&
    !isPolicyAllowsRef(remainingAllowStrings, primaryIdentity)
  ) {
    throw new ModelPolicyEditError(
      "primary-model-referenced",
      `Cannot remove ${trimmed}: the primary model ${primaryIdentity} is covered by this wildcard and no remaining rule would cover it. Switch the primary model first.`
    );
  }
  for (const fallbackRef of readFallbackModelRefs(config)) {
    const fallbackIdentity = protectedRefIdentity(fallbackRef);
    if (
      fallbackIdentity !== undefined &&
      isPolicyAllowsRef([trimmed], fallbackIdentity) &&
      !isPolicyAllowsRef(remainingAllowStrings, fallbackIdentity)
    ) {
      throw new ModelPolicyEditError(
        "fallback-referenced",
        `Cannot remove ${trimmed}: the fallback model ${fallbackIdentity} is covered by this wildcard and no remaining rule would cover it. Resolve the fallback reference first.`
      );
    }
  }

  // 5. 写入：按完全相同字符串 filter（在克隆上重新计算，输出不与输入共享任何引用），删除全部相同副本
  const next = structuredClone(config);
  next.agents!.defaults!.modelPolicy!.allow = readModelPolicyAllowRaw(next)!.filter((entry) => entry !== trimmed);

  const warnings: string[] = [];
  if (removedCount > 1) {
    warnings.push(`Removed ${removedCount} identical entries of the rule ${trimmed}.`);
  }
  if (options.inventory !== undefined) {
    // 仅由该 wildcard 放行的 inventory 模型行：被它覆盖且不被任何剩余规则覆盖
    const losingRefs = options.inventory.models
      .filter((model) => {
        const ref = `${model.providerId}/${model.modelId}`;
        return isPolicyAllowsRef([trimmed], ref) && !isPolicyAllowsRef(remainingStrings, ref);
      })
      .map((model) => model.ref)
      .sort();
    if (losingRefs.length > 0) {
      const shown = losingRefs.slice(0, 5).join(", ");
      const suffix = losingRefs.length > 5 ? ", …" : "";
      warnings.push(
        `After removal, ${losingRefs.length} model(s) will lose policy allowance: ${shown}${suffix}.`
      );
    }
  }

  return { config: next, warnings, removedCount };
}
