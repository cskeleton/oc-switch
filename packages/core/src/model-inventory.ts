import { normalizeProviderId, parseModelRef } from "./model-ref";
import { getModelPolicyMode, getModelSelectionSource, readModelPolicyAllowRaw, isPolicyAllowsRef, findPolicyWildcardForRef } from "./model-policy";
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
  removable: boolean;
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

  const primaryRef = readPrimaryModelRef(config);
  const fallbackRefs = readFallbackModelRefs(config);
  const policyMode = getModelPolicyMode(config);
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
      if (pluginEnabledById.get(plugin.pluginId) === false && !authoredRefs.has(refIdentity(`${plugin.providerId}/${model.id}`))) continue;
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
    if (!pickerIdentities.has(identity) && !configuredIdentities.has(identity) && !modelsByIdentity.has(identity!) && !providerKnown?.sources.includes("config") && !authoredRefs.has(identity) && getModelSelectionSource(config, entry.ref) === undefined) continue;
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
  const policyStrings: string[] = [];
  policyAllowRaw.forEach((entry) => {
    if (typeof entry === "string") policyStrings.push(entry);
  });

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
      if (policyStrings.some((entry) => entry.endsWith("/*") && wildcardEntryCovers(entry, ref))) {
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
          : policyMode === "legacy" ? getModelSelectionSource(config, ref)
            : policyMode === "unrestricted" && catalogSources.length > 0 ? "unrestricted" : getModelSelectionSource(config, ref) === "policy-exact" ? "policy-exact" : undefined;
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
    const preservesRestricted = policyAllowRaw.some(entry => typeof entry !== "string" || !exactEntryCovers(entry, ref));
    const canRemovePolicyExactRef = isExactOnlySelection && !protectedReference && preservesRestricted && !findPolicyWildcardForRef(config, ref);
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

  // ---------- 3. Provider 行计算 ----------
  const providers: ProviderInventoryEntry[] = [];
  for (const provider of providersByNormal.values()) {
    const providerIdentity = normalizeProviderId(provider.providerId);
    const providerModels = models.filter((model) => normalizeProviderId(model.providerId) === providerIdentity);
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
  const protectedIdentities = new Set(
    [primaryIdentity, ...fallbackIdentities].filter((identity) => identity !== undefined)
  );
  const policyRules = projectPolicyRules(policyAllowRaw, policyMode, models, protectedIdentities);

  // ---------- 5. summary 与插件回显 ----------
  return {
    schemaVersion: 2,
    pickerSource: runtime.pickerSource ?? "inferred",
    providers,
    models,
    plugins: derivePlugins(plugins, pluginProviders),
    policyRules,
    policyMode,
    // 防御性拷贝：消费方修改输出不得污染缓存的 runtime snapshot
    diagnostics: [
      ...runtime.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      ...(input.pluginDiagnostics?.length ? [{ command: "plugins" as const, code: "invalid-shape" as const, message: "openclaw plugins list: catalog discovery incomplete" }] : [])
    ],
    summary: {
      modelCount: models.length,
      policyAllowedCount: models.filter((model) => model.policyAllowed).length,
      availableCount: models.filter((model) => model.availability === "available").length,
      unavailableCount: models.filter((model) => model.availability === "unavailable").length,
      unknownCount: models.filter((model) => model.availability === "unknown").length
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

/** 通配条目是否覆盖 ref：复用 model-policy 的折叠前缀语义（不重复实现匹配细节）。 */
function wildcardEntryCovers(entry: string, ref: string): boolean {
  return entry.endsWith("/*") && isPolicyAllowsRef([entry], ref);
}

/** 与 model-policy 的精确匹配语义一致（Provider 折叠 + model 敏感）。 */
function exactEntryCovers(entry: string, ref: string): boolean {
  if (entry.endsWith("/*")) return false;
  if (entry === ref) return true;
  const parsedEntry = tryParseRef(entry);
  const parsedRef = tryParseRef(ref);
  if (parsedEntry === undefined || parsedRef === undefined) return false;
  return (
    normalizeProviderId(parsedEntry.providerId) === normalizeProviderId(parsedRef.providerId) &&
    parsedEntry.modelId === parsedRef.modelId
  );
}

/**
 * policy.allow 原始规则投影。
 *
 * - exact 条目回显值；仅当不命中主模型/fallback 引用时 removable=true（保护性引用
 *   即使可删除也会被 operation 预检阻断，规则行不应诱导注定失败的删除）；
 * - wildcard 的 removable 与 removeModelPolicyWildcard 的守卫事实严格对齐（spec §3.4）：
 *   移除该值的所有完全相同字符串条目后，raw 仍剩 ≥1 条（含非字符串条目），且无
 *   protected identity（primary/fallback）失去全部剩余规则覆盖，才可删；
 * - 非字符串条目不回显值，仅返回 index/invalid 诊断（secret-free 纪律）。
 */
function projectPolicyRules(
  policyAllowRaw: unknown[],
  policyMode: ModelPolicyMode,
  models: ModelInventoryEntry[],
  protectedIdentities: Set<string>
): ModelPolicyRuleEntry[] {
  // legacy / unrestricted 模式下 allow 不产生有效规则，不投影（保持三态语义）
  if (policyMode === "legacy" || policyMode === "unrestricted") return [];

  /** wildcard 可删性：与 removeModelPolicyWildcard 的防清空 + primary/fallback 覆盖守卫一致。 */
  const wildcardRemovable = (entry: string): boolean => {
    const remainingRaw = policyAllowRaw.filter((candidate) => candidate !== entry);
    if (remainingRaw.length === 0) return false;
    const remainingStrings = remainingRaw.filter((candidate): candidate is string => typeof candidate === "string");
    for (const identity of protectedIdentities) {
      const stillCovered = remainingStrings.some(
        (candidate) => exactEntryCovers(candidate, identity) || wildcardEntryCovers(candidate, identity)
      );
      if (wildcardEntryCovers(entry, identity) && !stillCovered) return false;
    }
    return true;
  };

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
        removable: false
      });
      return;
    }
    const kind: ModelPolicyRuleEntry["kind"] = entry.endsWith("/*") ? "wildcard" : "exact";
    const matched = models.filter((model) =>
      kind === "wildcard"
        ? model.catalogSources.length > 0 && wildcardEntryCovers(entry, `${model.providerId}/${model.modelId}`)
        : exactEntryCovers(entry, `${model.providerId}/${model.modelId}`)
    );
    // exact 规则自身命中主模型/fallback 时不可删（规则行与模型行的 fail-closed 对齐）
    const protectedExact = kind === "exact" && protectedIdentities.has(refIdentity(entry) ?? "");
    rules.push({
      value: entry,
      kind,
      matchedModelCount: matched.length,
      unavailableModelCount: matched.filter((model) => model.availability === "unavailable").length,
      removable:
        kind === "wildcard"
          ? wildcardRemovable(entry)
          : !protectedExact && matched.some(model => model.capabilities.canRemovePolicyExactRef)
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
