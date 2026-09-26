import { normalizeProviderId, parseModelRef } from "./model-ref";
import {
  exactEntryMatches,
  getModelPolicyMode,
  readModelPolicyAllowRaw,
  wildcardEntryMatches
} from "./model-policy";
import { readFallbackModelRefs, readPrimaryModelRef } from "./primary-model";
import type { ModelPolicyMode, ModelSelectionSource, OpenClawConfig } from "./types";

/**
 * modelPolicy.allow 的单次纯计算匹配上下文（2026-09-26 运行效率方案 §4 O2）：
 * 一次构建、重复查询，消除投影路径上逐模型 × 逐规则（R×M）与逐规则重扫（R²）的工作。
 *
 * - exact 条目按「Provider 折叠 + model 敏感」identity 建索引（与 model-policy.ts
 *   的 exactEntryMatches 同一语义，含 OpenRouter free 别名分支）；wildcard 按
 *   折叠 Provider 分桶，查询只扫相关 Provider 的模型；
 * - 同时预计算原始字符串副本计数与 primary/fallback 受保护引用，供规则删除的
 *   共享判定（assessPolicyRuleRemoval）使用；防清空按含 invalid 条目的原始长度判定；
 * - 原始 allow 数组仍是唯一写入权威：上下文只读、可在一次投影调用内反复查询，
 *   不引入任何长期缓存，也不修改输入；不规范化用户 wildcard 的大小写/顺序/重复。
 */

/** 解析失败条目不产生 identity（与现有 matcher「解析失败永不匹配」一致）。 */
function identityOf(ref: string): string | undefined {
  try {
    const { providerId, modelId } = parseModelRef(ref);
    return `${normalizeProviderId(providerId)}/${modelId}`;
  } catch {
    return undefined;
  }
}

const OPENROUTER_ALIAS_MODEL_IDS = new Set(["free", "openrouter/free"]);

/**
 * OpenRouter free 别名的 identity 变体（exactEntryMatches 别名分支的对称展开）：
 * 仅当折叠 Provider 为 openrouter 且 model ID 属于别名集合时存在两个互相命中的 identity。
 */
function identityVariants(identity: string | undefined): string[] {
  if (identity === undefined) return [];
  const slash = identity.indexOf("/");
  const modelId = identity.slice(slash + 1);
  if (identity.slice(0, slash) === "openrouter" && OPENROUTER_ALIAS_MODEL_IDS.has(modelId)) {
    return [identity, `openrouter/${modelId === "free" ? "openrouter/free" : "free"}`];
  }
  return [identity];
}

/** wildcard 条目按 Provider 分桶的键：前缀首个 `/` 之前的段做大小写折叠（与分桶构建一致）。 */
export function wildcardProviderBucketKey(wildcardEntry: string): string {
  const prefix = wildcardEntry.slice(0, -1);
  const slash = prefix.indexOf("/");
  return normalizeProviderId(slash >= 0 ? prefix.slice(0, slash) : prefix);
}

/** 单条规则的预解析匹配器：从现有 matcher 语义抽出，规则解析一次、模型查询多次。 */
export function createRuleMatcher(rule: string): (ref: string) => boolean {
  if (rule.endsWith("/*")) {
    // 与 wildcardEntryMatches 相同的三个分支（原始前缀 / 折叠 ref / 折叠前缀）
    const prefix = rule.slice(0, -1);
    const slash = prefix.indexOf("/");
    const foldedPrefix = slash > 0 ? `${normalizeProviderId(prefix.slice(0, slash))}${prefix.slice(slash)}` : undefined;
    return (ref) => {
      if (ref.startsWith(prefix)) return true;
      try {
        const { providerId, modelId } = parseModelRef(ref);
        const foldedRef = `${normalizeProviderId(providerId)}/${modelId}`;
        if (foldedRef.startsWith(prefix)) return true;
        return foldedPrefix !== undefined && foldedRef.startsWith(foldedPrefix);
      } catch {
        return false;
      }
    };
  }
  const ruleVariants = new Set(identityVariants(identityOf(rule)));
  return (ref) => {
    if (ref === rule) return true;
    const identity = identityOf(ref);
    if (identity === undefined) return false;
    for (const variant of identityVariants(identity)) {
      if (ruleVariants.has(variant)) return true;
    }
    return false;
  };
}

interface ProtectedRefEntry {
  kind: "primary" | "fallback";
  identity: string;
}

export class ModelPolicyMatchContext {
  private readonly raw: unknown[];
  private readonly strings: readonly string[];
  private readonly exactCounts: Map<string, number>;
  private readonly exactStrings: Map<string, Set<string>>;
  private readonly wildcardBuckets: Map<string, string[]>;
  private readonly copies: Map<string, number>;
  private readonly metadataIdentities: Set<string>;
  private readonly metadataRawStrings: Set<string>;
  private readonly metadataKeyCount: number;
  private readonly protectedRefList: ProtectedRefEntry[];
  private readonly coveringMemo = new Map<string, Set<string>>();

  private constructor(args: {
    raw: unknown[];
    strings: string[];
    mode: ModelPolicyMode;
    exactCounts: Map<string, number>;
    exactStrings: Map<string, Set<string>>;
    wildcardBuckets: Map<string, string[]>;
    copies: Map<string, number>;
    metadataIdentities: Set<string>;
    metadataRawStrings: Set<string>;
    metadataKeyCount: number;
    protectedRefs: ProtectedRefEntry[];
  }) {
    this.raw = args.raw;
    this.strings = args.strings;
    this.mode = args.mode;
    this.exactCounts = args.exactCounts;
    this.exactStrings = args.exactStrings;
    this.wildcardBuckets = args.wildcardBuckets;
    this.copies = args.copies;
    this.metadataIdentities = args.metadataIdentities;
    this.metadataRawStrings = args.metadataRawStrings;
    this.metadataKeyCount = args.metadataKeyCount;
    this.protectedRefList = args.protectedRefs;
  }

  readonly mode: ModelPolicyMode;

  /** 由 config 构建：解析每个字符串条目一次，建立索引与受保护引用（primary/fallback）。 */
  static fromConfig(config: OpenClawConfig): ModelPolicyMatchContext {
    const raw = readModelPolicyAllowRaw(config) ?? [];
    const mode = getModelPolicyMode(config);
    const metadataKeys = Object.keys(config.agents?.defaults?.models ?? {});
    const protectedRefs: ProtectedRefEntry[] = [];
    const primaryIdentity = protectedIdentity(readPrimaryModelRef(config));
    if (primaryIdentity !== undefined) protectedRefs.push({ kind: "primary", identity: primaryIdentity });
    for (const fallback of readFallbackModelRefs(config)) {
      const identity = protectedIdentity(fallback);
      if (identity !== undefined) protectedRefs.push({ kind: "fallback", identity });
    }
    return ModelPolicyMatchContext.build({ raw, mode, metadataKeys, protectedRefs });
  }

  /**
   * 由任意字符串列表构建（如规则编辑后的最终 allow）：模式/legacy metadata 不适用，
   * 仅用于 allows / coveringRules 等模式无关查询。
   */
  static fromAllowStrings(strings: readonly string[]): ModelPolicyMatchContext {
    return ModelPolicyMatchContext.build({ raw: [...strings], mode: "restricted", metadataKeys: [], protectedRefs: [] });
  }

  private static build(args: {
    raw: unknown[];
    mode: ModelPolicyMode;
    metadataKeys: string[];
    protectedRefs: ProtectedRefEntry[];
  }): ModelPolicyMatchContext {
    const strings: string[] = [];
    const exactCounts = new Map<string, number>();
    const exactStrings = new Map<string, Set<string>>();
    const wildcardBuckets = new Map<string, string[]>();
    const copies = new Map<string, number>();
    for (const entry of args.raw) {
      if (typeof entry !== "string") continue;
      strings.push(entry);
      copies.set(entry, (copies.get(entry) ?? 0) + 1);
      if (entry.endsWith("/*")) {
        const bucket = wildcardBuckets.get(wildcardProviderBucketKey(entry)) ?? [];
        bucket.push(entry);
        wildcardBuckets.set(wildcardProviderBucketKey(entry), bucket);
        continue;
      }
      // 解析失败的字符串条目永不覆盖可解析 ref（entry === ref 与 ref 可解析矛盾），不进索引
      const identity = identityOf(entry);
      if (identity === undefined) continue;
      exactCounts.set(identity, (exactCounts.get(identity) ?? 0) + 1);
      const set = exactStrings.get(identity) ?? new Set<string>();
      set.add(entry);
      exactStrings.set(identity, set);
    }
    const metadataIdentities = new Set<string>();
    const metadataRawStrings = new Set<string>();
    for (const key of args.metadataKeys) {
      // exactEntryMatches 对 wildcard 键（endsWith "/*"）在入口即恒 false，不入索引
      if (key.endsWith("/*")) continue;
      const identity = identityOf(key);
      if (identity === undefined) {
        // 不可解析键仅有 entry === ref 一条命中路径（exactEntryMatches 的字符串全等分支）
        metadataRawStrings.add(key);
        continue;
      }
      for (const variant of identityVariants(identity)) metadataIdentities.add(variant);
    }
    return new ModelPolicyMatchContext({
      raw: args.raw,
      strings,
      mode: args.mode,
      exactCounts,
      exactStrings,
      wildcardBuckets,
      copies,
      metadataIdentities,
      metadataRawStrings,
      metadataKeyCount: args.metadataKeys.length,
      protectedRefs: args.protectedRefs
    });
  }

  /** 原始 allow 数组长度（含 invalid 条目；防清空守卫的权威语义）。 */
  get rawLength(): number {
    return this.raw.length;
  }

  /** 字符串条目（保序）。 */
  get stringEntries(): readonly string[] {
    return this.strings;
  }

  /** 「完全相同字符串」的原始副本数（removeModelPolicyRule 的存在性/副本语义）。 */
  copyCountOf(value: string): number {
    return this.copies.get(value) ?? 0;
  }

  /** exactEntryCovers（inventory 口径，无别名）覆盖 ref 的字符串条目数；ref 应可解析。 */
  countExactCovers(ref: string): number {
    const identity = identityOf(ref);
    if (identity === undefined) {
      // 罕见 fallback：ref 不可解析时旧实现只有 entry === ref 可能命中（逐条等价）
      let count = 0;
      for (const entry of this.strings) {
        if (!entry.endsWith("/*") && entry === ref) count++;
      }
      return count;
    }
    return this.exactCounts.get(identity) ?? 0;
  }

  /** 首个覆盖 ref 的 wildcard 条目（allow 顺序；findPolicyWildcardForRef 等价，模式无关）。 */
  findWildcardCovering(ref: string): string | undefined {
    const identity = identityOf(ref);
    if (identity === undefined) {
      for (const entry of this.strings) {
        if (wildcardEntryMatches(entry, ref)) return entry;
      }
      return undefined;
    }
    const provider = identity.slice(0, identity.indexOf("/"));
    const bucket = this.wildcardBuckets.get(provider);
    if (bucket === undefined) return undefined;
    for (const entry of bucket) {
      if (wildcardEntryMatches(entry, ref)) return entry;
    }
    return undefined;
  }

  /** isPolicyAllowsRef(strings, ref) 等价（别名感知 exact + wildcard）。 */
  allows(ref: string): boolean {
    const identity = identityOf(ref);
    if (identity === undefined) {
      for (const entry of this.strings) {
        if (exactEntryMatches(entry, ref) || wildcardEntryMatches(entry, ref)) return true;
      }
      return false;
    }
    for (const variant of identityVariants(identity)) {
      if (this.exactCounts.has(variant)) return true;
    }
    return this.findWildcardCovering(ref) !== undefined;
  }

  /** 单条规则字符串是否覆盖 ref（与 isPolicyAllowsRef([rule], ref) 一致）。 */
  ruleCovers(rule: string, ref: string): boolean {
    return exactEntryMatches(rule, ref) || wildcardEntryMatches(rule, ref);
  }

  /** 覆盖 ref（别名感知）的全部字符串条目集合（去重）；memo 仅在单次上下文生命周期内生效。 */
  coveringRules(ref: string): Set<string> {
    const cached = this.coveringMemo.get(ref);
    if (cached !== undefined) return cached;
    const result = new Set<string>();
    const identity = identityOf(ref);
    if (identity === undefined) {
      for (const entry of this.strings) {
        if (exactEntryMatches(entry, ref) || wildcardEntryMatches(entry, ref)) result.add(entry);
      }
    } else {
      for (const variant of identityVariants(identity)) {
        const strings = this.exactStrings.get(variant);
        if (strings === undefined) continue;
        for (const entry of strings) result.add(entry);
      }
      const provider = identity.slice(0, identity.indexOf("/"));
      const bucket = this.wildcardBuckets.get(provider);
      if (bucket !== undefined) {
        for (const entry of bucket) {
          if (wildcardEntryMatches(entry, ref)) result.add(entry);
        }
      }
    }
    this.coveringMemo.set(ref, result);
    return result;
  }

  /**
   * 编辑后 identity 是否仍被覆盖：剩余覆盖条目（不在 removedValues 内）或新增规则覆盖。
   * 规则删除/替换的共享最终覆盖判定（2026-09-16 spec §3.2；编辑前未覆盖不新增阻断）。
   */
  coveredAfterEdit(identity: string, removedValues: ReadonlySet<string>, addedRules: readonly string[]): boolean {
    for (const entry of this.coveringRules(identity)) {
      if (!removedValues.has(entry)) return true;
    }
    for (const rule of addedRules) {
      if (this.ruleCovers(rule, identity)) return true;
    }
    return false;
  }

  /** getModelSelectionSource(config, ref) 等价（三态模式 + legacy metadata + 别名 + wildcard）。 */
  selectionSourceFor(ref: string): ModelSelectionSource | undefined {
    if (this.mode === "unrestricted") return "unrestricted";
    if (this.mode === "legacy") {
      if (this.metadataKeyCount === 0) return "unrestricted";
      return this.legacyMetadataCovers(ref) ? "legacy" : undefined;
    }
    const identity = identityOf(ref);
    if (identity !== undefined) {
      for (const variant of identityVariants(identity)) {
        if (this.exactCounts.has(variant)) return "policy-exact";
      }
    } else if (this.strings.some((entry) => exactEntryMatches(entry, ref))) {
      return "policy-exact";
    }
    return this.findWildcardCovering(ref) !== undefined ? "policy-wildcard" : undefined;
  }

  /** legacy 模式下 metadata 键是否覆盖 ref（exactEntryMatches 语义）。 */
  private legacyMetadataCovers(ref: string): boolean {
    if (this.metadataRawStrings.has(ref)) return true;
    const identity = identityOf(ref);
    if (identity === undefined) return false;
    for (const variant of identityVariants(identity)) {
      if (this.metadataIdentities.has(variant)) return true;
    }
    return false;
  }

  /** primary/fallback 受保护引用（归一 identity，保序：primary 在前）。 */
  get protectedRefs(): readonly ProtectedRefEntry[] {
    return this.protectedRefList;
  }
}

/** 受保护引用归一（与 model-policy-edit 的 protectedRefIdentity 同一规则）。 */
function protectedIdentity(ref: string | undefined): string | undefined {
  if (ref === undefined) return undefined;
  try {
    const parsed = parseModelRef(ref.trim());
    return `${normalizeProviderId(parsed.providerId)}/${parsed.modelId}`;
  } catch {
    return undefined;
  }
}

export type PolicyRemovalViolation =
  | { kind: "not-found"; missing: string[] }
  | { kind: "last-rule-removal" }
  | { kind: "primary-model-referenced"; identity: string; triggeringValues: string[] }
  | { kind: "fallback-referenced"; identity: string; triggeringValues: string[] };

export interface PolicyRemovalAssessment {
  removable: boolean;
  violation: PolicyRemovalViolation | undefined;
}

/**
 * 纯规则删除的共享判定（2026-09-26 方案 §4 O2-4；与 removeModelPolicyRule(s) 的
 * assertPolicyFinalState 守卫严格一致）：存在性（完全相同字符串副本）→ 防清空
 * （含 invalid 条目的原始长度；带 addedRules 的替换每个被删位置都有新规则回补，
 * 防清空由调用方按 finalRaw 权威校验，此处不重复拦截）→ primary/fallback 最终覆盖
 * （编辑前被覆盖、删除全部副本后不再覆盖才阻断）。模式门禁由调用方负责。
 */
export function assessPolicyRuleRemoval(
  context: ModelPolicyMatchContext,
  values: readonly string[],
  options: { addedRules?: readonly string[] | undefined } = {}
): PolicyRemovalAssessment {
  const valueSet = new Set(values);
  const missing = values.filter((value) => context.copyCountOf(value) === 0);
  if (missing.length > 0) return { removable: false, violation: { kind: "not-found", missing } };
  const removedCopies = values.reduce((sum, value) => sum + context.copyCountOf(value), 0);
  if ((options.addedRules ?? []).length === 0 && context.rawLength - removedCopies === 0) {
    return { removable: false, violation: { kind: "last-rule-removal" } };
  }
  const addedRules = options.addedRules ?? [];
  for (const protectedRef of context.protectedRefs) {
    // 编辑前未被 policy 覆盖的引用不因本次编辑新增全局阻断
    if (!context.allows(protectedRef.identity)) continue;
    if (context.coveredAfterEdit(protectedRef.identity, valueSet, addedRules)) continue;
    const triggeringValues = values.filter((value) => context.ruleCovers(value, protectedRef.identity));
    return {
      removable: false,
      violation: {
        kind: protectedRef.kind === "primary" ? "primary-model-referenced" : "fallback-referenced",
        identity: protectedRef.identity,
        triggeringValues
      }
    };
  }
  return { removable: true, violation: undefined };
}
