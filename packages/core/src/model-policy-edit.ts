import { createHash } from "node:crypto";
import {
  findExactEntryInAllowList,
  findPolicyExactEntryForRef,
  findPolicyWildcardForRef,
  findWildcardEntryInAllowList,
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
 * 用户显式指令驱动的纯 mutation，供 Server/CLI 在 `writeOpenClawTransaction`
 * 内调用：
 * - `addModelPolicyRule`：添加 exact 或 wildcard 规则（按 `/*` 后缀识别）；
 * - `removeModelPolicyWildcard`：按完全相同字符串删除 wildcard 规则（含全部重复副本）；
 * - `replaceModelPolicyRule`：原子替换——构造最终 allow 后统一校验最终状态，
 *   不经过先删后加的中间状态（2026-09-16 spec §3.1/§3.2）；
 * - `removeModelPolicyRule`：纯规则删除入口，exact 与 wildcard 同一入口，
 *   使用与替换一致的最终覆盖判断（允许删除仍被其他规则覆盖的 primary exact）；
 * - `buildModelPolicyRevision`：policy 指纹（模式 + 完整原始 allow 的确定性序列化
 *   SHA-256），供事务层比对过期编辑冲突。
 *
 * 写入纪律（spec §7）：只在 restricted 模式下编辑，永不创建/清空 policy、不做
 * 模式切换；除 push 新规则、按完全相同字符串替换/filter 外，绝不动已有条目的大小写、
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
  | "last-rule-removal"
  | "unchanged-rule"
  | "policy-revision-conflict";

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

/**
 * policy 指纹（2026-09-16 spec §3）：带版本前缀的 SHA-256。
 *
 * 输入为确定性序列化的「当前 policy 模式 + 完整原始 allow 数组」：保留数组顺序、
 * 大小写与重复次数；非字符串项以类型标记代替（原始值永不回显）。不包含全配置、
 * 认证或 env，因此与 policy 无关的配置变化不会使 revision 失效。
 */
export function buildModelPolicyRevision(config: OpenClawConfig): string {
  const mode = getModelPolicyMode(config);
  const raw = readModelPolicyAllowRaw(config);
  const serializedAllow =
    raw?.map((entry) => {
      if (typeof entry === "string") return entry;
      if (entry === null) return "<null>";
      if (Array.isArray(entry)) return "<array>";
      return `<${typeof entry}>`;
    }) ?? null;
  return `v1:${createHash("sha256").update(JSON.stringify([mode, serializedAllow])).digest("hex")}`;
}

/**
 * 比对事务内当前 policy revision 与调用方期望（2026-09-16 spec §5 冲突保护）。
 * 不一致抛 `policy-revision-conflict`（Server 映射 409 / CLI 非零退出）；
 * 调用方必须在事务 mutate 内对最新 config 调用，外部改动触发 prepare 重做时
 * 仍比对原 expectedRevision，绝不更新后继续写。
 */
export function assertModelPolicyRevision(config: OpenClawConfig, expectedRevision: string): void {
  const current = buildModelPolicyRevision(config);
  if (current !== expectedRevision) {
    throw new ModelPolicyEditError(
      "policy-revision-conflict",
      "The model policy has changed since the rules were loaded; refresh and review the current rules before editing again."
    );
  }
}

interface ParsedPolicyRule {
  kind: "exact" | "wildcard";
  trimmed: string;
  providerSegment: string;
}

/** 新规则输入格式校验（add / replace 共用）；任一失败抛 invalid-rule-format。 */
function validatePolicyRuleFormat(rule: string): ParsedPolicyRule {
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
  return { kind, trimmed, providerSegment };
}

/** restricted 模式门禁（add / replace / remove 共用）；不创建 policy、不改 unrestricted 形状。 */
function assertPolicyRestricted(config: OpenClawConfig): void {
  const mode = getModelPolicyMode(config);
  if (mode !== "restricted") {
    throw new ModelPolicyEditError(
      "policy-not-restricted",
      `Policy rule editing requires restricted mode; the current modelPolicy.allow mode is ${mode}.`
    );
  }
}

/** knownProviderIds 未命中 warning（未知 Provider 不阻断规则编辑）；未提供时不提示。 */
function unknownProviderWarnings(providerSegment: string, options: AddModelPolicyRuleOptions): string[] {
  if (options.knownProviderIds === undefined) return [];
  const known = new Set([...options.knownProviderIds].map((id) => normalizeProviderId(id)));
  if (known.has(normalizeProviderId(providerSegment))) return [];
  return [
    `Provider ${providerSegment} is not in the known catalog; this rule currently matches no model.`
  ];
}

/**
 * 最终状态保护（2026-09-16 spec §3.2）：原子替换与纯规则删除共用，对构造好的最终
 * allow 统一校验，禁止先删后加的中间状态。
 *
 * - 防清空（fail closed）：编辑后 raw allow 不得为 []（非字符串项计入剩余，
 *   沿用 raw 长度语义；replace 保持条目数不会触发，remove 主要在此拦截）；
 * - primary/fallback 覆盖保护（fail closed）：defaults primary 与合法 fallback
 *   编辑前被 policy 覆盖、编辑后不再覆盖时拒绝；exact 与 wildcard 用同一匹配器，
 *   非字符串项不贡献覆盖，不依赖 availability。已存在的未覆盖问题不会被无关编辑
 *   扩大为全局阻断（coveredBefore && !coveredAfter 才拒绝）。
 */
function assertPolicyFinalState(config: OpenClawConfig, finalRaw: unknown[], action: string): void {
  if (finalRaw.length === 0) {
    throw new ModelPolicyEditError(
      "last-rule-removal",
      `Cannot ${action} because removing the last agents.defaults.modelPolicy.allow entry would make [] unrestricted; keep another rule or narrow the policy first.`
    );
  }
  const beforeStrings = readModelPolicyAllow(config) ?? [];
  const afterStrings = finalRaw.filter((entry): entry is string => typeof entry === "string");
  const primaryIdentity = protectedRefIdentity(readPrimaryModelRef(config));
  if (
    primaryIdentity !== undefined &&
    isPolicyAllowsRef(beforeStrings, primaryIdentity) &&
    !isPolicyAllowsRef(afterStrings, primaryIdentity)
  ) {
    throw new ModelPolicyEditError(
      "primary-model-referenced",
      `Cannot ${action}: the primary model ${primaryIdentity} is covered by the current policy and no remaining rule would cover it. Switch the primary model first.`
    );
  }
  for (const fallbackRef of readFallbackModelRefs(config)) {
    const fallbackIdentity = protectedRefIdentity(fallbackRef);
    if (
      fallbackIdentity !== undefined &&
      isPolicyAllowsRef(beforeStrings, fallbackIdentity) &&
      !isPolicyAllowsRef(afterStrings, fallbackIdentity)
    ) {
      throw new ModelPolicyEditError(
        "fallback-referenced",
        `Cannot ${action}: the fallback model ${fallbackIdentity} is covered by the current policy and no remaining rule would cover it. Resolve the fallback reference first.`
      );
    }
  }
}

/** 「失去策略放行」warning：被 removedRule 放行、但最终规则不再覆盖的 inventory 模型行。 */
function losingAllowanceWarnings(
  inventory: ModelInventory | undefined,
  removedRule: string,
  finalStrings: string[]
): string[] {
  if (inventory === undefined) return [];
  const losingRefs = inventory.models
    .filter((model) => {
      const ref = `${model.providerId}/${model.modelId}`;
      return isPolicyAllowsRef([removedRule], ref) && !isPolicyAllowsRef(finalStrings, ref);
    })
    .map((model) => model.ref)
    .sort();
  if (losingRefs.length === 0) return [];
  const shown = losingRefs.slice(0, 5).join(", ");
  const suffix = losingRefs.length > 5 ? ", …" : "";
  return [
    `After removal, ${losingRefs.length} model(s) will lose policy allowance: ${shown}${suffix}.`
  ];
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
  const { kind, trimmed, providerSegment } = validatePolicyRuleFormat(rule);

  // 2. 模式门禁：不创建 policy，也不允许在 unrestricted 下改 [] 的形状
  assertPolicyRestricted(config);

  const raw = readModelPolicyAllowRaw(config)!;
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
    // 用探测 ref `body/_` 检查是否被更宽的现有 wildcard 覆盖；探测 ref 不会命中 exact 条目，
    // 因为 findPolicyWildcardForRef 只执行 wildcard 匹配（与 `_` 是否出现在条目中无关）
    const coveringWildcard = findPolicyWildcardForRef(config, `${storedRule.slice(0, -2)}/_`);
    if (coveringWildcard !== undefined) {
      warnings.push(
        `Rule ${storedRule} is already covered by the broader wildcard ${coveringWildcard}; this rule is currently redundant.`
      );
    }
  }

  // 4. knownProviderIds 未命中只提示（未知 Provider 不阻断规则编辑）
  warnings.push(...unknownProviderWarnings(providerSegment, options));

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

/**
 * 原子替换一条 policy 规则（2026-09-16 spec §3.1/§3.2）。
 *
 * - `value` 为读取到的旧字符串，按原字符串完全相同匹配：不 trim、不按行下标定位、
 *   不做 Provider 大小写折叠；每个匹配位置写入同一新规则，保留副本数量与原位置；
 * - 新 `rule` trim；exact 按 `normalizeModelRefForStorage` 归一存储，wildcard 保留
 *   输入大小写（仅 trim）；新值归一后与旧值相同返回 `unchanged-rule`；
 * - duplicate 检查排除本次全部旧值副本后沿用添加语义：exact 语义重复 / wildcard
 *   完全相同重复拒绝；仅被其他 wildcard 覆盖允许并提示冗余；
 * - 最终状态保护对构造好的最终 allow 统一校验（assertPolicyFinalState），
 *   禁止先删后加的中间状态；旧值不存在返回 `policy-rule-not-found`；
 * - 不调用 `removeModelPolicyExactRef`；输入 config 不被修改。
 */
export function replaceModelPolicyRule(
  config: OpenClawConfig,
  value: string,
  rule: string,
  options: AddModelPolicyRuleOptions & RemoveModelPolicyWildcardOptions = {}
): OperationResult & { rule: string; kind: "exact" | "wildcard"; replacedCount: number } {
  // 1. 新规则格式校验（与添加入口共用）
  const { kind, trimmed, providerSegment } = validatePolicyRuleFormat(rule);

  // 2. 模式门禁
  assertPolicyRestricted(config);

  const raw = readModelPolicyAllowRaw(config)!;

  // 3. 旧值按原字符串完全相同匹配（不 trim、不折叠大小写）
  const replacedCount = raw.filter((entry) => entry === value).length;
  if (replacedCount === 0) {
    throw new ModelPolicyEditError(
      "policy-rule-not-found",
      `Rule ${value} not found in agents.defaults.modelPolicy.allow; nothing to replace.`
    );
  }

  // 4. 归一存储新规则；与旧值相同则无变化（不产生写入/备份）
  const storedRule = kind === "exact" ? normalizeModelRefForStorage(trimmed) : trimmed;
  if (storedRule === value) {
    throw new ModelPolicyEditError(
      "unchanged-rule",
      `Rule ${value} is unchanged after normalization; nothing to write.`
    );
  }

  // 5. duplicate / 冗余检查：排除本次全部旧值副本后沿用添加语义
  const remainingRaw = raw.filter((entry) => entry !== value);
  const remainingStrings = remainingRaw.filter((entry): entry is string => typeof entry === "string");
  const warnings: string[] = [];
  if (kind === "exact") {
    const duplicate = findExactEntryInAllowList(remainingStrings, storedRule);
    if (duplicate !== undefined) {
      throw new ModelPolicyEditError(
        "duplicate-rule",
        `Rule ${storedRule} is already covered by the existing exact entry ${duplicate}.`
      );
    }
    const coveringWildcard = findWildcardEntryInAllowList(remainingStrings, storedRule);
    if (coveringWildcard !== undefined) {
      warnings.push(
        `Rule ${storedRule} is already covered by wildcard ${coveringWildcard}; this exact rule is currently redundant.`
      );
    }
  } else {
    if (remainingStrings.includes(storedRule)) {
      throw new ModelPolicyEditError(
        "duplicate-rule",
        `Wildcard rule ${storedRule} already exists in agents.defaults.modelPolicy.allow.`
      );
    }
    // 用探测 ref `body/_` 检查是否被更宽的剩余 wildcard 覆盖（与添加入口同一语义）
    const coveringWildcard = findWildcardEntryInAllowList(remainingStrings, `${storedRule.slice(0, -2)}/_`);
    if (coveringWildcard !== undefined) {
      warnings.push(
        `Rule ${storedRule} is already covered by the broader wildcard ${coveringWildcard}; this rule is currently redundant.`
      );
    }
  }

  // 6. knownProviderIds 未命中只提示（未知 Provider 不阻断规则编辑）
  warnings.push(...unknownProviderWarnings(providerSegment, options));

  // 7. 构造最终 allow（每个匹配位置写入同一新规则，保留副本数量与原位置）并统一校验最终状态
  const finalRaw = raw.map((entry) => (entry === value ? storedRule : entry));
  assertPolicyFinalState(config, finalRaw, `replace ${value}`);

  // 8. 写入：在克隆上重新计算最终 allow，输出不与输入共享任何引用；不动其它条目
  const next = structuredClone(config);
  next.agents!.defaults!.modelPolicy!.allow = readModelPolicyAllowRaw(next)!.map((entry) =>
    entry === value ? storedRule : entry
  );

  if (replacedCount > 1) {
    warnings.push(`Replaced ${replacedCount} identical entries of the rule ${value}.`);
  }
  warnings.push(
    ...losingAllowanceWarnings(
      options.inventory,
      value,
      finalRaw.filter((entry): entry is string => typeof entry === "string")
    )
  );

  return { config: next, warnings, rule: storedRule, kind, replacedCount };
}

/**
 * 纯规则删除入口（2026-09-16 spec §3.1/§3.2）：exact 与 wildcard 同一入口。
 *
 * - `value` 按原字符串完全相同匹配（不 trim），删除所有完全相同副本返回 `removedCount`；
 * - 最终状态保护与替换共用（assertPolicyFinalState）：防清空；primary/fallback 编辑前
 *   被 policy 覆盖、编辑后不再覆盖时拒绝——因此「删除仍被其他规则覆盖的 primary exact」
 *   允许，这是与旧 `removeModelPolicyExactRef`（无条件保护 primary/fallback exact、
 *   拒绝删除被 wildcard 覆盖的 exact）的关键区别；
 * - 不接受 removeMetadata；规则删除只收窄策略，不触碰目录 / metadata / 密钥；
 * - 输入 config 不被修改。
 */
export function removeModelPolicyRule(
  config: OpenClawConfig,
  value: string,
  options: RemoveModelPolicyWildcardOptions = {}
): OperationResult & { removedCount: number } {
  // 1. 模式门禁
  assertPolicyRestricted(config);

  const raw = readModelPolicyAllowRaw(config)!;

  // 2. 旧值按原字符串完全相同匹配（不 trim、不折叠大小写）
  const removedCount = raw.filter((entry) => entry === value).length;
  if (removedCount === 0) {
    throw new ModelPolicyEditError(
      "policy-rule-not-found",
      `Rule ${value} not found in agents.defaults.modelPolicy.allow; nothing to remove.`
    );
  }

  // 3. 构造最终 allow 并统一校验最终状态（防清空 + primary/fallback 覆盖）
  const finalRaw = raw.filter((entry) => entry !== value);
  assertPolicyFinalState(config, finalRaw, `remove ${value}`);

  // 4. 写入：在克隆上重新计算，删除全部相同副本；不动其它条目与非字符串条目
  const next = structuredClone(config);
  next.agents!.defaults!.modelPolicy!.allow = readModelPolicyAllowRaw(next)!.filter((entry) => entry !== value);

  const warnings: string[] = [];
  if (removedCount > 1) {
    warnings.push(`Removed ${removedCount} identical entries of the rule ${value}.`);
  }
  warnings.push(
    ...losingAllowanceWarnings(
      options.inventory,
      value,
      finalRaw.filter((entry): entry is string => typeof entry === "string")
    )
  );

  return { config: next, warnings, removedCount };
}

/**
 * 纯规则删除可删性投影（非抛出）：与 removeModelPolicyRule 的成败严格一致——
 * 同一模式门禁、同一完全相同匹配存在性检查、同一 assertPolicyFinalState 最终状态保护，
 * 只是不构造写入结果。供 inventory 规则行 `removable` 投影使用（2026-09-16 spec §4：
 * 共用 Core 守卫，不复制匹配器，不用模型行 canRemovePolicyExactRef 推断规则可删性）。
 */
export function canRemoveModelPolicyRule(config: OpenClawConfig, value: string): boolean {
  try {
    assertPolicyRestricted(config);
    const raw = readModelPolicyAllowRaw(config)!;
    if (!raw.some((entry) => entry === value)) return false;
    assertPolicyFinalState(config, raw.filter((entry) => entry !== value), `remove ${value}`);
    return true;
  } catch (error) {
    if (isModelPolicyEditError(error)) return false;
    throw error;
  }
}
