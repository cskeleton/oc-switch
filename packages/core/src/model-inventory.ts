import { normalizeProviderId, parseModelRef } from "./model-ref";
import { getModelPolicyMode, readModelPolicyAllowRaw, wildcardEntryMatches } from "./model-policy";
import { assessPolicyRuleRemoval, ModelPolicyMatchContext, wildcardProviderBucketKey } from "./model-policy-index";
import { buildModelPolicyRevision } from "./model-policy-edit";
import type { PluginProvider } from "./plugin-catalog";
import { readFallbackModelRefs, readPrimaryModelRef } from "./primary-model";
import type { RuntimeModelDiagnostic, RuntimeModelEntry, RuntimeModelSnapshot } from "./runtime-model-catalog";
import type { ModelPolicyMode, ModelSelectionSource, OpenClawConfig } from "./types";

/**
 * 统一模型/Provider inventory 纯计算层（spec §6/§7）。
 *
 * 合并 config、插件 manifest、OpenClaw 运行时目录与引用来源（policy exact、
 * legacy metadata、primary/fallback）为一个确定性 inventory；本模块只做纯计算：
 * 不读写文件、不 shell-out、不修改任何输入。
 *
 * 三条不变量：
 * - `policyAllowed`、插件启停与运行可用性是三个独立维度，绝不合并成一个 boolean；
 * - 探测证据不足时 availability 必须是 `unknown`，绝不误判 `unavailable`；
 * - 数组字段去重且按「固定枚举优先级 + 字典序」稳定排序。
 */

/** spec §6.1：模型目录来源（config / 插件 manifest / OpenClaw 运行时）。 */
export type ModelCatalogSource = "config" | "plugin-manifest" | "openclaw-runtime";

/** spec §6.1：引用来源（主模型 / fallback / legacy metadata / policy 精确 / policy 通配）。 */
export type ModelReferenceSource = "primary" | "fallback" | "legacy-metadata" | "policy-exact" | "policy-wildcard";

/** spec §6.1：运行可用性三态。 */
export type ModelAvailability = "available" | "unavailable" | "unknown";

/** spec §6.1：不可用/未知原因（含探测失败）。 */
export type ModelAvailabilityReason =
  | "plugin-disabled"
  | "provider-not-found"
  | "model-not-in-catalog"
  | "missing-auth"
  | "route-incompatible"
  | "provider-rejected"
  | "probe-failed";

/** spec §6.1：模型行的能力开关（从事实推导，不由 UI 猜）。 */
export interface ModelInventoryCapabilities {
  /** 可切换 policy 允许状态：仅 restricted 精确条目（非通配、非主模型/fallback、探测未知不可用）。 */
  canTogglePolicy: boolean;
  /** 可设为主模型：policyAllowed + available，且当前不是 primary。 */
  canSetPrimary: boolean;
  /** 可编辑目录定义：仅 config 来源（spec §7.3「只有 config 来源的模型定义可直接编辑/删除」）。 */
  canEditCatalogEntry: boolean;
  /** 可补全为 config Provider 的目录项：runtime available + config Provider 存在 + 非 config 来源。 */
  canMaterializeConfigModel: boolean;
  /** 可安全删除 policy 精确引用：policy-exact 来源，且非 primary/fallback、非通配覆盖。 */
  canRemovePolicyExactRef: boolean;
}

/** spec §6.1：统一模型行。 */
export interface ModelInventoryEntry {
  /** 默认 Agent 选择器是否列出；不等同于可调用性。 */
  pickerVisible?: boolean;
  /** 未选用或主动停用，且没有 primary/fallback 依赖。 */
  inactive?: boolean;
  /** 正在选择/保护的引用出现可用性问题，才需要处理。 */
  needsAttention?: boolean;
  ref: string;
  providerId: string;
  modelId: string;
  catalogSources: ModelCatalogSource[];
  referenceSources: ModelReferenceSource[];
  policyMode: ModelPolicyMode;
  selectionSource?: ModelSelectionSource;
  policyAllowed: boolean;
  availability: ModelAvailability;
  availabilityReasons: ModelAvailabilityReason[];
  pluginIds: string[];
  capabilities: ModelInventoryCapabilities;
}

/** spec §6.2：Provider 的能力开关（写权限按来源限制）。 */
export interface ProviderInventoryCapabilities {
  /** 可编辑连接信息（baseUrl/api 等）：仅 config 来源。 */
  canEditConnection: boolean;
  /** 可增删改模型目录：仅 config 来源。 */
  canManageModels: boolean;
  /** 可用 oc-switch 可逆关闭：仅 config 来源且不含主模型（此处只按来源判定，主模型阻断由 operation 预检负责）。 */
  canDisableProvider: boolean;
  /** 可经 .env 托管块设置 API Key：config 来源，或声明了 apiKeyEnvVars 的插件 Provider。 */
  canSetApiKey: boolean;
}

/** spec §6.2：统一 Provider 行。 */
export interface ProviderInventoryEntry {
  pickerModelCount?: number;
  needsAttention?: boolean;
  providerId: string;
  sources: ModelCatalogSource[];
  /** 支持一个 Provider 多插件来源及一个插件多 Provider。 */
  pluginIds: string[];
  /** true | false | null：null 表示非插件或无法确认。 */
  pluginEnabled: boolean | null;
  /** oc-switch 可逆关闭状态（provider-states.json），与插件 enabled 无关。 */
  disabled: boolean;
  availability: ModelAvailability;
  availabilityReasons: ModelAvailabilityReason[];
  modelCount: number;
  policyAllowedModelCount: number;
  availableModelCount: number;
  unavailableModelCount: number;
  capabilities: ProviderInventoryCapabilities;
}

/** policy.allow 原始规则投影：wildcard 不是模型行，只作为规则展示（spec §7.1）。 */
export interface ModelPolicyRuleEntry {
  value: string;
  kind: "exact" | "wildcard" | "invalid";
  /** 该规则在 allow 数组中的原始下标（invalid 条目只回显 index，不回显值）。 */
  invalidIndex?: number;
  matchedModelCount: number;
  unavailableModelCount: number;
  /**
   * 纯规则删除（removeModelPolicyRule）的结果投影（2026-09-16 spec §4）：
   * 与 Core 实际判定严格一致，不再从模型行 canRemovePolicyExactRef 推断；
   * invalid 条目恒为 false。
   */
  removable: boolean;
  /**
   * restricted 模式下合法字符串规则恒为 true（可打开行内编辑，最终结果由服务器校验；
   * 不可删除不等于不可编辑——sole wildcard removable=false 仍 editable=true）；invalid 为 false。
   */
  editable: boolean;
}

/** 插件级 descriptor：Task 4 由 plugin-catalog 产出；本层只消费 id/origin/enabled/providerIds。 */
export type ModelPluginNonModelCapability =
  | "channels"
  | "tools"
  | "hooks"
  | "commands"
  | "services"
  | "speech"
  | "realtime"
  | "media"
  | "search"
  | "other-contracts";

export interface ModelPluginDescriptor {
  id: string;
  name?: string;
  origin: string;
  enabled: boolean;
  providerIds: string[];
  nonModelCapabilities: ModelPluginNonModelCapability[];
}
export interface BuildModelInventoryInput {
  config: OpenClawConfig;
  /** oc-switch 可逆关闭的 Provider（provider-states.json，经外层注入）。 */
  disabledProviderIds?: Iterable<string>;
  /** 插件 manifest 的只读 provider 目录（plugin-catalog.ts）。 */
  pluginProviders?: PluginProvider[];
  /** 插件级 descriptor（Task 4 起注入）；enabled 优先于 pluginProviders 的同名字段。 */
  plugins?: ModelPluginDescriptor[];
  pluginDiagnostics?: string[];
  runtime: RuntimeModelSnapshot;
}

export interface ModelInventory {
  schemaVersion?: 2;
  pickerSource?: "gateway" | "inferred";
  providers: ProviderInventoryEntry[];
  models: ModelInventoryEntry[];
  plugins: ModelPluginDescriptor[];
  policyRules: ModelPolicyRuleEntry[];
  /** 全局 policy 模式（spec §3.4 顶层透出；前端据此显隐规则编辑入口）。 */
  policyMode: ModelPolicyMode;
  /** 当前 policy 指纹（buildModelPolicyRevision；规则编辑请求携带用于冲突检测，2026-09-16 spec §4/§5）。 */
  policyRevision: string;
  diagnostics: RuntimeModelDiagnostic[];
  summary: {
    modelCount: number;
    policyAllowedCount: number;
    availableCount: number;
    unavailableCount: number;
    unknownCount: number;
  };
}

/** 各数组字段的固定枚举优先级（spec §6.1「数组字段必须去重且稳定排序」）。 */
const CATALOG_SOURCE_ORDER: Record<ModelCatalogSource, number> = {
  config: 0,
  "plugin-manifest": 1,
  "openclaw-runtime": 2
};
const REFERENCE_SOURCE_ORDER: Record<ModelReferenceSource, number> = {
  primary: 0,
  fallback: 1,
  "legacy-metadata": 2,
  "policy-exact": 3,
  "policy-wildcard": 4
};
const POLICY_RULE_KIND_ORDER: Record<ModelPolicyRuleEntry["kind"], number> = { exact: 0, wildcard: 1, invalid: 2 };
const AVAILABILITY_REASON_ORDER: Record<ModelAvailabilityReason, number> = {
  "plugin-disabled": 0,
  "provider-not-found": 1,
  "model-not-in-catalog": 2,
  "missing-auth": 3,
  "route-incompatible": 4,
  "provider-rejected": 5,
  "probe-failed": 6
};

/** 未知键的 plugin descriptor 派生形态（inventory.plugins 无输入时由 pluginProviders 生成）。 */
const DERIVED_PLUGIN_ORIGIN = "derived";

/** 按固定枚举优先级 + 字典序去重排序（简并字符串数组）。 */
function sortUniqueEnum<T extends string>(values: Iterable<T>, order: Record<T, number>): T[] {
  const unique = [...new Set(values)];
  return unique.sort((a, b) => order[a] - order[b] || (a < b ? -1 : a > b ? 1 : 0));
}

/** 不抛错的 ref 解析：无法解析的 ref 不参与任何目录/引用合并。 */
function tryParseRef(ref: string): { providerId: string; modelId: string } | undefined {
  try {
    return parseModelRef(ref);
  } catch {
    return undefined;
  }
}

/** ref 的合并标识：Provider 段小写折叠、model 段保持大小写敏感。 */
function refIdentity(ref: string): string | undefined {
  const parsed = tryParseRef(ref);
  return parsed ? `${normalizeProviderId(parsed.providerId)}/${parsed.modelId}` : undefined;
}

interface WorkingModel {
  /** 展示用 ref 的候选（config 大小写优先，其次插件/运行时首个出现）。 */
  displayRef: string | undefined;
  providerId: string;
  modelId: string;
  catalogSources: ModelCatalogSource[];
  referenceSources: ModelReferenceSource[];
  pluginIds: Set<string>;
}

interface WorkingProvider {
  providerId: string;
  sources: ModelCatalogSource[];
  pluginIds: Set<string>;
}

function makeWorkingModel(providerId: string, modelId: string): WorkingModel {
  return {
    displayRef: undefined,
    providerId,
    modelId,
    catalogSources: [],
    referenceSources: [],
    pluginIds: new Set<string>()
  };
}

/**
 * 构建统一模型/Provider inventory。
 *
 * 输出确定性：数组字段去重 + 稳定排序，models/providers/policyRules 各自按固定键排序，
 * 同一输入永远得到同一输出；不修改任何输入对象。
 */
export function buildModelInventory(input: BuildModelInventoryInput): ModelInventory {
  const { config, runtime } = input;
  const configProviderIds = new Set(Object.keys(config.models?.providers ?? {}).map(normalizeProviderId));
  const disabledProviderIds = new Set(
    [...(input.disabledProviderIds ?? [])].map((providerId) => normalizeProviderId(providerId)).filter(id => configProviderIds.has(id))
  );
  const pluginProviders = input.pluginProviders ?? [];
  const plugins = input.plugins ?? [];

  // 插件 enabled 事实：descriptor 优先（Task 4 起的真实来源），否则回落 pluginProviders
  const pluginEnabledById = new Map<string, boolean>();
  for (const provider of pluginProviders) {
    if (!pluginEnabledById.has(provider.pluginId)) pluginEnabledById.set(provider.pluginId, provider.enabled);
  }
  for (const plugin of plugins) pluginEnabledById.set(plugin.id, plugin.enabled);
  // 全部插件启用时无需逐模型计算 authoredRefs 身份（惰性短路，语义不变）
  const anyPluginDisabled = [...pluginEnabledById.values()].some((enabled) => enabled === false);

  const primaryRef = readPrimaryModelRef(config);
  const fallbackRefs = readFallbackModelRefs(config);
  const policyMode = getModelPolicyMode(config);
  // 单次投影共用的 policy 匹配上下文：exact 身份索引 / wildcard 分桶 / 副本计数 /
  // primary-fallback 覆盖（一次构建、重复查询；2026-09-26 方案 §4 O2）
  const policyMatch = ModelPolicyMatchContext.fromConfig(config);
  const primaryIdentity = primaryRef !== undefined ? refIdentity(primaryRef) : undefined;
  const fallbackIdentities = new Set(fallbackRefs.map((ref) => refIdentity(ref)).filter((id) => id !== undefined));
  const providerDisabled = (providerIdentity: string): boolean => disabledProviderIds.has(providerIdentity);
  const authoredRefs = new Set([
    ...Object.keys(config.agents?.defaults?.models ?? {}),
    ...(readModelPolicyAllowRaw(config) ?? []).filter((ref): ref is string => typeof ref === "string" && !ref.endsWith("/*")),
    ...(primaryRef ? [primaryRef] : []), ...fallbackRefs
  ].map(refIdentity));

  // ---------- 1. 收集 Provider 与模型行（spec §7.1 候选集合并集） ----------
  const providersByNormal = new Map<string, WorkingProvider>();
  const modelsByIdentity = new Map<string, WorkingModel>();

function makeWorkingProvider(providerId: string): WorkingProvider {
  return { providerId, sources: [], pluginIds: new Set<string>() };
}

function ensureProvider(providerIdentity: string, providerId: string, source: ModelCatalogSource): WorkingProvider {
  let provider = providersByNormal.get(providerIdentity);
  if (!provider) {
    provider = makeWorkingProvider(providerId);
    providersByNormal.set(providerIdentity, provider);
  }
  if (!provider.sources.includes(source)) provider.sources.push(source);
  return provider;
}

  function ensureModel(ref: string, source?: ModelCatalogSource): WorkingModel | undefined {
    const parsed = tryParseRef(ref);
    if (parsed === undefined) return undefined;
    const identity = `${normalizeProviderId(parsed.providerId)}/${parsed.modelId}`;
    let model = modelsByIdentity.get(identity);
    if (!model) {
      model = makeWorkingModel(normalizeProviderId(parsed.providerId), parsed.modelId);
      // 新建行用首个来源的原始大小写作为展示 ref
      model.displayRef = ref;
      modelsByIdentity.set(identity, model);
    } else if (source === "config" && !model.catalogSources.includes("config")) {
      // config 大小写优先覆盖非 config 来源的展示 ref
      model.displayRef = ref;
    }
    if (source !== undefined && !model.catalogSources.includes(source)) model.catalogSources.push(source);
    return model;
  }

  // config Provider 模型
  for (const [providerId, provider] of Object.entries(config.models?.providers ?? {})) {
    const providerIdentity = normalizeProviderId(providerId);
    ensureProvider(providerIdentity, providerId, "config");
    for (const model of provider.models ?? []) {
      if (typeof model.id !== "string" || model.id === "") continue;
      ensureModel(`${providerId}/${model.id}`, "config");
    }
  }

  // 插件 manifest 模型（config 同名 Provider 不再遮蔽插件成员，spec §7.3 并集）
  for (const plugin of pluginProviders) {
    const providerIdentity = normalizeProviderId(plugin.providerId);
    const provider = ensureProvider(providerIdentity, plugin.providerId, "plugin-manifest");
    if (!provider.pluginIds.has(plugin.pluginId)) provider.pluginIds.add(plugin.pluginId);
    for (const model of plugin.models) {
      if (anyPluginDisabled && pluginEnabledById.get(plugin.pluginId) === false && !authoredRefs.has(refIdentity(`${plugin.providerId}/${model.id}`))) continue;
      const working = ensureModel(`${plugin.providerId}/${model.id}`, "plugin-manifest");
      if (working) working.pluginIds.add(plugin.pluginId);
    }
  }

  // 插件 descriptor 声明但未给出 manifest 的 Provider：仅作为 Provider 行来源
  for (const plugin of plugins) {
    for (const providerId of plugin.providerIds) {
      const providerIdentity = normalizeProviderId(providerId);
      const provider = ensureProvider(providerIdentity, providerId, "plugin-manifest");
      provider.pluginIds.add(plugin.id);
    }
  }

  // 运行时目录模型（configured + all）：ref 进入模型行并集；Provider 行只有在
  // config/插件已声明该 Provider 时才追加 openclaw-runtime 来源——「policy 里出现
  // providerId 不自动认定为可用 Provider，没有目录的归入未解析引用分组」（spec §6.2）
  const pickerIdentities = new Set((runtime.pickerModels ?? []).map(entry => refIdentity(entry.ref)));
  const configuredIdentities = new Set(runtime.configuredModels.map(entry => refIdentity(entry.ref)));
  for (const entry of [...(runtime.pickerModels ?? []), ...runtime.configuredModels, ...runtime.allModels]) {
    const parsed = tryParseRef(entry.ref);
    if (parsed === undefined) continue;
    const identity = refIdentity(entry.ref);
    const providerKnown = providersByNormal.get(normalizeProviderId(parsed.providerId));
    const disabledPluginOnly = providerKnown && !providerKnown.sources.includes("config") && providerKnown.pluginIds.size > 0 && [...providerKnown.pluginIds].every(id => pluginEnabledById.get(id) === false);
    if (disabledPluginOnly && !authoredRefs.has(identity) && !pickerIdentities.has(identity)) continue;
    // --all 只补所选或已管理模型的证据，不把世界目录变成用户待办。
    if (!pickerIdentities.has(identity) && !configuredIdentities.has(identity) && !modelsByIdentity.has(identity!) && !providerKnown?.sources.includes("config") && !authoredRefs.has(identity) && policyMatch.selectionSourceFor(entry.ref) === undefined) continue;
    if (!pickerIdentities.has(identity) && !configuredIdentities.has(identity) && !modelsByIdentity.has(identity!) && !authoredRefs.has(identity) && entry.available !== true) continue;
    // missing 行只是 OpenClaw 为悬空引用生成的占位，不能作为目录或 wildcard 命中证据。
    const runtimeEvidence = entry.missing !== true;
    const model = ensureModel(entry.ref, runtimeEvidence ? "openclaw-runtime" : undefined)!;
    // 只有实际目录条目才给 Provider 追加运行时来源。
    const providerIdentity = normalizeProviderId(parsed.providerId);
    const known = providersByNormal.get(providerIdentity);
    if (known && runtimeEvidence) {
      if (!known.sources.includes("openclaw-runtime")) known.sources.push("openclaw-runtime");
    } else if (!known && runtimeEvidence) {
      ensureProvider(providerIdentity, parsed.providerId, "openclaw-runtime");
    }
    // manifest 已明确模型归属时，不把同 Provider 的其他插件误算成模型贡献者。
    if (model.pluginIds.size === 0) {
      for (const pluginId of providersByNormal.get(providerIdentity)?.pluginIds ?? []) model.pluginIds.add(pluginId);
    }
  }

  // 引用来源（非字符串 policy 条目不参与匹配，只在 policyRules 里以 index/invalid 呈现）
  const policyAllowRaw = readModelPolicyAllowRaw(config) ?? [];
  const policyStrings: readonly string[] = policyMatch.stringEntries;

  function addReference(identity: string, ref: string, source: ModelReferenceSource): void {
    let model = modelsByIdentity.get(identity);
    if (!model) {
      const parsed = tryParseRef(ref);
      if (parsed === undefined) return;
      model = makeWorkingModel(normalizeProviderId(parsed.providerId), parsed.modelId);
      model.displayRef = ref;
      modelsByIdentity.set(identity, model);
    }
    if (!model.referenceSources.includes(source)) model.referenceSources.push(source);
  }

  if (primaryIdentity !== undefined && primaryRef !== undefined) addReference(primaryIdentity, primaryRef, "primary");
  for (const ref of fallbackRefs) {
    const identity = refIdentity(ref);
    if (identity !== undefined) addReference(identity, ref, "fallback");
  }
  // legacy metadata refs（始终作为引用来源展示，悬空行保留）
  for (const ref of Object.keys(config.agents?.defaults?.models ?? {})) {
    const identity = refIdentity(ref);
    if (identity !== undefined) addReference(identity, ref, "legacy-metadata");
  }
  // policy 精确条目；通配不生成模型行，只在覆盖目录模型时补 policy-wildcard 引用
  for (const entry of policyStrings) {
    if (entry.endsWith("/*")) continue;
    const identity = refIdentity(entry);
    if (identity !== undefined) addReference(identity, entry, "policy-exact");
  }
  if (policyMode === "restricted") {
    for (const model of modelsByIdentity.values()) {
      if (model.catalogSources.length === 0) continue;
      const ref = `${model.providerId}/${model.modelId}`;
      if (policyMatch.findWildcardCovering(ref) !== undefined) {
        if (!model.referenceSources.includes("policy-wildcard")) model.referenceSources.push("policy-wildcard");
      }
    }
  }

  // ---------- 2. 模型行计算 ----------
  // 运行时证据索引：同一 identity 的 configured / all 条目（all 合并时保留首个 available 证据）
  const runtimeConfiguredByIdentity = new Map<string, RuntimeModelEntry>();
  for (const entry of [...(runtime.pickerModels ?? []), ...runtime.configuredModels]) {
    const identity = refIdentity(entry.ref);
    if (identity === undefined) continue;
    const existing = runtimeConfiguredByIdentity.get(identity);
    if (existing && pickerIdentities.has(identity)) continue;
    if (existing === undefined || (entry.available === true && entry.missing !== true && !(existing.available === true && existing.missing !== true))) {
      runtimeConfiguredByIdentity.set(identity, entry);
    }
  }
  const runtimeAllByIdentity = new Map<string, RuntimeModelEntry>();
  for (const entry of runtime.allModels) {
    const identity = refIdentity(entry.ref);
    if (identity === undefined) continue;
    if (!runtimeAllByIdentity.has(identity)) runtimeAllByIdentity.set(identity, entry);
  }

  const knownProviderIdentities = new Set(providersByNormal.keys());
  const models: ModelInventoryEntry[] = [];
  for (const model of modelsByIdentity.values()) {
    const catalogSources = sortUniqueEnum(model.catalogSources, CATALOG_SOURCE_ORDER);
    const referenceSources = sortUniqueEnum(model.referenceSources, REFERENCE_SOURCE_ORDER);
    const ref = model.displayRef ?? `${model.providerId}/${model.modelId}`;
    const providerIdentity = model.providerId;
    const identity = `${model.providerId}/${model.modelId}`;
    const fromConfig = catalogSources.includes("config");
    const isPrimary = primaryIdentity === identity;
    const isFallback = fallbackIdentities.has(identity);
    const selectionSource: ModelSelectionSource | undefined =
      referenceSources.includes("policy-exact")
        ? "policy-exact"
        : referenceSources.includes("policy-wildcard")
          ? "policy-wildcard"
          : policyMode === "legacy" ? policyMatch.selectionSourceFor(ref)
            : policyMode === "unrestricted" && catalogSources.length > 0 ? "unrestricted" : policyMatch.selectionSourceFor(ref) === "policy-exact" ? "policy-exact" : undefined;
    const policyAllowed = selectionSource !== undefined;

    // 可用性证据规则（spec §7.2）：OpenClaw 明确 available 的事实优先
    let availabilityReasons: ModelAvailabilityReason[] = [];
    let availability: ModelAvailability;
    const runtimeConfigured = runtimeConfiguredByIdentity.get(identity);
    const runtimeAllEntry = runtimeAllByIdentity.get(identity);
    // 当前列表优先；仅当前列表没有该行时才使用完整目录，不能覆盖当前的否定标记。
    const runtimeEntry = runtimeConfigured ?? runtimeAllEntry;
    const runtimeAvailable = runtimeEntry?.available === true && runtimeEntry.missing !== true;
    // 明确不可用事实：标记为 false 或 missing；不凭 boolean 猜测具体拒绝原因。
    const runtimeRejectedEntry = runtimeEntry && (runtimeEntry.available === false || runtimeEntry.missing === true) ? runtimeEntry : undefined;
    const ownerPluginIds = model.pluginIds.size ? [...model.pluginIds] : [...(providersByNormal.get(providerIdentity)?.pluginIds ?? [])];
    const pluginDisabled = !fromConfig && ownerPluginIds.length > 0 && ownerPluginIds.every((pluginId) => pluginEnabledById.get(pluginId) === false);
    const providerMissing = !knownProviderIdentities.has(providerIdentity);
    // 完整探测 = 判定 unavailable 需要的目录证据全部到位（当前列表 + 完整目录 + status）
    const probeComplete = runtime.completeness.configuredList && runtime.completeness.allList && runtime.completeness.status && !(input.pluginDiagnostics?.length);
    // 目录证据：任一 catalog（config / 插件 manifest / 运行时 all 目录）出现该 ref
    const hasAnyCatalogEvidence = catalogSources.length > 0;

    if (runtimeAvailable) {
      availability = "available";
    } else if (!probeComplete) {
      availability = "unknown";
      availabilityReasons = ["probe-failed"];
    } else if (pluginDisabled) {
      availability = "unavailable";
      availabilityReasons.push("plugin-disabled");
    } else if (runtimeRejectedEntry !== undefined) {
      // 目录证据完整后采信否定标记；missing 可解释为目录缺失，其余原因不猜测。
      availability = "unavailable";
      if (runtimeRejectedEntry.missing === true) availabilityReasons.push("model-not-in-catalog");
    } else if (probeComplete) {
      availability = "unavailable";
      if (runtimeEntry !== undefined && runtimeEntry.available === undefined && runtimeEntry.missing !== true) {
        // all 目录出现但无任何明确标记：证据不足，保持 unknown
        availability = "unknown";
        availabilityReasons = ["probe-failed"];
      } else if (!hasAnyCatalogEvidence) {
        // exact ref 不在当前或完整 catalog 且探测完整
        availabilityReasons.push("model-not-in-catalog");
        // Provider 也明确不存在时用更精确的 provider-not-found（spec §7.2）
        if (providerMissing) availabilityReasons = ["provider-not-found"];
      } else if (providerMissing) {
        availabilityReasons.push("provider-not-found");
      } else {
        availabilityReasons.push("model-not-in-catalog");
      }
    } else {
      availability = "unknown";
      availabilityReasons.push("probe-failed");
    }
    const availabilityReasonsSorted = sortUniqueEnum(availabilityReasons, AVAILABILITY_REASON_ORDER);

    // capability 从事实推导（spec §6.1 / §7.3 / §11.2）
    const isExactOnlySelection = referenceSources.includes("policy-exact") && !referenceSources.includes("policy-wildcard");
    const protectedReference = isPrimary || isFallback;
    const inactive = !protectedReference && (providerDisabled(providerIdentity) || pluginDisabled || !policyAllowed);
    const pickerVisible = runtime.pickerModels !== undefined ? pickerIdentities.has(identity) :
      !inactive && (protectedReference || referenceSources.includes("policy-exact") || (policyAllowed && availability === "available"));
    const needsAttention = !inactive && (policyAllowed || protectedReference) && availability !== "available";
    // 不可用行走「处理」流程（补全/替换/删除引用/保留），不提供普通启停开关（spec §11.2）
    // preservesRestricted：只有当 raw 全部条目都是覆盖本 ref 的字符串时才是 false（旧实现 some 语义含空数组）
    const preservesRestricted = !(
      policyMatch.rawLength === policyMatch.stringEntries.length &&
      policyMatch.countExactCovers(ref) === policyMatch.stringEntries.length
    );
    const canRemovePolicyExactRef = isExactOnlySelection && !protectedReference && preservesRestricted && policyMatch.findWildcardCovering(ref) === undefined;
    // primary/fallback 只阻断关闭；为它们补回缺失的允许规则是安全的启用操作。
    const canTogglePolicy = !providerDisabled(providerIdentity) && (!policyAllowed || !protectedReference) && availability === "available" &&
      (policyMode === "legacy" || (policyMode === "restricted" && (!policyAllowed || canRemovePolicyExactRef)));
    const canSetPrimary = !providerDisabled(providerIdentity) && policyAllowed && availability === "available" && !isPrimary;
    const canEditCatalogEntry = fromConfig && availability !== "unknown";
    const providerFromConfig = fromConfig || providersByNormal.get(providerIdentity)?.sources.includes("config") === true;
    const canMaterializeConfigModel =
      !fromConfig &&
      !providerDisabled(providerIdentity) && !protectedReference &&
      catalogSources.includes("openclaw-runtime") &&
      runtimeAvailable &&
      providerFromConfig &&
      availability === "available";

    models.push({
      pickerVisible,
      inactive,
      needsAttention,
      ref,
      providerId: model.providerId,
      modelId: model.modelId,
      catalogSources,
      referenceSources,
      policyMode,
      ...(selectionSource === undefined ? {} : { selectionSource }),
      policyAllowed,
      availability,
      availabilityReasons: availabilityReasonsSorted,
      pluginIds: [...model.pluginIds].sort(),
      capabilities: {
        canTogglePolicy,
        canSetPrimary,
        canEditCatalogEntry,
        canMaterializeConfigModel,
        canRemovePolicyExactRef
      }
    });
  }
  // 稳定排序：providerId（小写）→ modelId（大小写敏感字典序）
  models.sort((a, b) => a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : a.modelId < b.modelId ? -1 : a.modelId > b.modelId ? 1 : 0);
  // 按 Provider 一次分组：Provider 行聚合与规则投影共用（models[].providerId 已归一，可直接作键）
  const modelsByProviderId = new Map<string, ModelInventoryEntry[]>();
  const modelByIdentity = new Map<string, ModelInventoryEntry>();
  for (const model of models) {
    const list = modelsByProviderId.get(model.providerId) ?? [];
    list.push(model);
    modelsByProviderId.set(model.providerId, list);
    modelByIdentity.set(`${model.providerId}/${model.modelId}`, model);
  }

  // ---------- 3. Provider 行计算 ----------
  const providers: ProviderInventoryEntry[] = [];
  for (const provider of providersByNormal.values()) {
    const providerIdentity = normalizeProviderId(provider.providerId);
    const providerModels = modelsByProviderId.get(providerIdentity) ?? [];
    const pluginIds = [...provider.pluginIds].sort();
    const fromConfig = provider.sources.includes("config");
    const pluginEnabled =
      pluginIds.length === 0
        ? null
        : pluginIds.some((pluginId) => pluginEnabledById.get(pluginId) !== false)
          ? true
          : false;
    const apiKeyEnvVarsKnown =
      fromConfig ||
      pluginProviders.some(
        (candidate) =>
          normalizeProviderId(candidate.providerId) === providerIdentity && candidate.apiKeyEnvVars.length > 0
      );

    // Provider 可用性：贡献模型聚合（无模型时按插件/探测状态判定）
    let availability: ModelAvailability;
    const availabilityReasons: ModelAvailabilityReason[] = [];
    if (providerModels.length > 0) {
      if (providerModels.every((model) => model.availability === "unknown")) {
        availability = "unknown";
        availabilityReasons.push("probe-failed");
      } else if (providerModels.some((model) => model.availability === "available")) {
        availability = "available";
      } else if (providerModels.some((model) => model.availability === "unknown")) {
        // 混合 [unavailable, unknown]：存在探测未知的模型，Provider 整体不确定
        availability = "unknown";
        availabilityReasons.push("probe-failed");
      } else {
        availability = "unavailable";
        availabilityReasons.push(...providerModels.flatMap((model) => model.availabilityReasons));
      }
    } else if (pluginEnabled === false) {
      availability = "unavailable";
      availabilityReasons.push("plugin-disabled");
    } else {
      availability = "unknown";
      availabilityReasons.push("probe-failed");
    }
    const availableModelCount = providerModels.filter((model) => model.availability === "available").length;
    const unavailableModelCount = providerModels.filter((model) => model.availability === "unavailable").length;

    providers.push({
      pickerModelCount: providerModels.filter(model => model.pickerVisible).length,
      needsAttention: providerModels.some(model => model.needsAttention),
      providerId: provider.providerId,
      sources: sortUniqueEnum(provider.sources, CATALOG_SOURCE_ORDER),
      pluginIds,
      pluginEnabled,
      disabled: providerDisabled(providerIdentity),
      availability,
      availabilityReasons: sortUniqueEnum(availabilityReasons, AVAILABILITY_REASON_ORDER),
      modelCount: providerModels.length,
      policyAllowedModelCount: providerModels.filter((model) => model.policyAllowed).length,
      availableModelCount,
      unavailableModelCount,
      capabilities: {
        canEditConnection: fromConfig,
        canManageModels: fromConfig,
        canDisableProvider: fromConfig,
        canSetApiKey: apiKeyEnvVarsKnown
      }
    });
  }
  providers.sort((a, b) => (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0));

  // ---------- 4. policy rule 投影 ----------
  const policyRules = projectPolicyRules(policyMatch, policyAllowRaw, policyMode, modelByIdentity, modelsByProviderId);

  // ---------- 5. summary 与插件回显 ----------
  let summaryPolicyAllowed = 0;
  let summaryAvailable = 0;
  let summaryUnavailable = 0;
  let summaryUnknown = 0;
  for (const model of models) {
    if (model.policyAllowed) summaryPolicyAllowed++;
    if (model.availability === "available") summaryAvailable++;
    else if (model.availability === "unavailable") summaryUnavailable++;
    else summaryUnknown++;
  }
  return {
    schemaVersion: 2,
    pickerSource: runtime.pickerSource ?? "inferred",
    providers,
    models,
    plugins: derivePlugins(plugins, pluginProviders),
    policyRules,
    policyMode,
    policyRevision: buildModelPolicyRevision(config),
    // 防御性拷贝：消费方修改输出不得污染缓存的 runtime snapshot
    diagnostics: [
      ...runtime.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      ...(input.pluginDiagnostics?.length ? [{ command: "plugins" as const, code: "invalid-shape" as const, message: "openclaw plugins list: catalog discovery incomplete" }] : [])
    ],
    summary: {
      modelCount: models.length,
      policyAllowedCount: summaryPolicyAllowed,
      availableCount: summaryAvailable,
      unavailableCount: summaryUnavailable,
      unknownCount: summaryUnknown
    }
  };
}

/**
 * inventory.plugins 回显：有 descriptor 输入时防御性拷贝透传；否则由
 * pluginProviders 派生最小 descriptor（providerIds 按出现顺序去重、enabled 取首个
 * 观察值），保证「一个插件可贡献多个 Provider」的关系在 Task 4 之前也可被消费方依赖。
 */
function derivePlugins(
  plugins: ModelPluginDescriptor[],
  pluginProviders: PluginProvider[]
): ModelPluginDescriptor[] {
  // 防御性拷贝：不与输入共享 providerIds 数组，消费方改输出不影响输入
  if (plugins.length > 0) {
    return plugins.map((plugin) => ({
      ...plugin,
      providerIds: [...plugin.providerIds],
      nonModelCapabilities: [...plugin.nonModelCapabilities]
    }));
  }
  const derived = new Map<string, ModelPluginDescriptor>();
  for (const provider of pluginProviders) {
    let descriptor = derived.get(provider.pluginId);
    if (!descriptor) {
      descriptor = {
        id: provider.pluginId,
        origin: provider.origin || DERIVED_PLUGIN_ORIGIN,
        enabled: provider.enabled,
        providerIds: [],
        nonModelCapabilities: []
      };
      derived.set(provider.pluginId, descriptor);
    }
    if (!descriptor.providerIds.includes(provider.providerId)) descriptor.providerIds.push(provider.providerId);
  }
  return [...derived.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 通配条目是否覆盖 ref：直接复用 model-policy 的 wildcardEntryMatches（entry 为 wildcard 时 exact 分支恒 false）。 */
function wildcardEntryCovers(entry: string, ref: string): boolean {
  return entry.endsWith("/*") && wildcardEntryMatches(entry, ref);
}

/**
 * policy.allow 原始规则投影。
 *
 * - removable 是纯规则删除（removeModelPolicyRule / canRemoveModelPolicyRule）的结果投影
 *   （2026-09-16 spec §4）：exact 与 wildcard 同一入口、同一最终覆盖判断——删除仍被其他
 *   规则覆盖的 primary exact 允许；不再从模型行 canRemovePolicyExactRef 推断规则可删性，
 *   模型行的引用清理守卫不随面板放宽；
 * - editable：合法字符串规则在 restricted 模式下恒为 true（不可删除不等于不可编辑；
 *   sole wildcard removable=false 仍可打开编辑框），invalid 恒为 false；
 * - 非字符串条目不回显值，仅返回 index/invalid 诊断（secret-free 纪律）。
 *
 * 匹配走单次构建的 ModelPolicyMatchContext：exact 规则按 identity 索引直接取模型行，
 * wildcard 规则只扫对应 Provider 分桶，removable 复用共享删除判定（O(1)/规则）。
 */
function projectPolicyRules(
  policyMatch: ModelPolicyMatchContext,
  policyAllowRaw: unknown[],
  policyMode: ModelPolicyMode,
  modelByIdentity: Map<string, ModelInventoryEntry>,
  modelsByProvider: Map<string, ModelInventoryEntry[]>
): ModelPolicyRuleEntry[] {
  // legacy / unrestricted 模式下 allow 不产生有效规则，不投影（保持三态语义）
  if (policyMode === "legacy" || policyMode === "unrestricted") return [];

  const rules: ModelPolicyRuleEntry[] = [];
  policyAllowRaw.forEach((entry, index) => {
    if (typeof entry !== "string") {
      // 非字符串条目：值不回显，仅 index + invalid
      rules.push({
        value: "",
        kind: "invalid",
        invalidIndex: index,
        matchedModelCount: 0,
        unavailableModelCount: 0,
        removable: false,
        editable: false
      });
      return;
    }
    const kind: ModelPolicyRuleEntry["kind"] = entry.endsWith("/*") ? "wildcard" : "exact";
    let matched: ModelInventoryEntry[];
    if (kind === "wildcard") {
      // wildcard 只扫该 Provider 的模型行（分桶键与匹配上下文同一推导）；空 Provider 段
      // 的 wildcard 不可能覆盖任何可解析 ref，自然得到空桶
      const candidates = modelsByProvider.get(wildcardProviderBucketKey(entry)) ?? [];
      matched = candidates.filter((model) =>
        model.catalogSources.length > 0 && wildcardEntryCovers(entry, `${model.providerId}/${model.modelId}`)
      );
    } else {
      // exact 按 identity 取唯一模型行（与旧实现的逐行 exactEntryCovers 扫描等价）
      const model = modelByIdentity.get(refIdentity(entry) ?? "");
      matched = model === undefined ? [] : [model];
    }
    rules.push({
      value: entry,
      kind,
      matchedModelCount: matched.length,
      unavailableModelCount: matched.filter((model) => model.availability === "unavailable").length,
      // 可删性与 Core 纯规则删除共用同一守卫（同一匹配器、同一最终覆盖判断）
      removable: assessPolicyRuleRemoval(policyMatch, [entry]).removable,
      editable: true
    });
  });

  // 稳定排序：kind（exact → wildcard → invalid）→ invalid 按 index、其余按字典序
  rules.sort(
    (a, b) =>
      POLICY_RULE_KIND_ORDER[a.kind] - POLICY_RULE_KIND_ORDER[b.kind] ||
      (a.kind === "invalid" && b.kind === "invalid"
        ? (a.invalidIndex ?? 0) - (b.invalidIndex ?? 0)
        : a.value < b.value
          ? -1
          : a.value > b.value
            ? 1
            : 0)
  );
  return rules;
}
