import { getModelPolicyMode, readModelPolicyAllowRaw } from "./model-policy";
import { normalizeProviderId, parseModelRef } from "./model-ref";
import { readFallbackModelRefs, readPrimaryModelRef } from "./primary-model";
import type { OpenClawConfig } from "./types";
import { readJsonState, writeJsonState } from "./json-state-store";

interface PluginSelectionState { openclawPath: string; policyEntries: string[] }
const STATE_FILE = "plugin-selection-states.json";
export function readPluginSelectionState(stateDir: string, pluginId: string, openclawPath: string): PluginSelectionState | undefined {
  const state = readJsonState<Record<string, PluginSelectionState>>({ stateDir, filename: STATE_FILE, fallback: () => ({}), invalidJson: "throw" })[pluginId];
  if (state && state.openclawPath !== openclawPath) throw new Error(`Plugin ${pluginId} snapshot belongs to another OpenClaw config`);
  if (state) validateSelectionEntries(state.policyEntries);
  return state;
}

function validateSelectionEntries(entries: unknown): asserts entries is string[] {
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== "string")) throw new Error("Invalid saved model policy entries");
  for (const entry of entries) parseModelRef(entry);
}

/** 只补缺失的出现次数：幂等合并，用户保存的重复 wildcard 不被去重。 */
export function mergeModelSelectionEntries(current: string[], saved: string[]): string[] {
  const next = [...current];
  const counts = new Map<string, number>();
  const wanted = new Map<string, number>();
  for (const entry of current) counts.set(entry, (counts.get(entry) ?? 0) + 1);
  for (const entry of saved) {
    const count = (wanted.get(entry) ?? 0) + 1;
    wanted.set(entry, count);
    if ((counts.get(entry) ?? 0) < count) next.push(entry);
  }
  return next;
}
export function savePluginSelectionState(stateDir: string, pluginId: string, state?: PluginSelectionState): void {
  const states = readJsonState<Record<string, PluginSelectionState>>({ stateDir, filename: STATE_FILE, fallback: () => ({}), invalidJson: "throw" });
  if (state) states[pluginId] = state;
  else delete states[pluginId];
  writeJsonState({ stateDir, filename: STATE_FILE, value: states });
}

export interface ModelSuspensionOptions {
  cleanupMetadata?: boolean;
  /** 仅完整探测得到的当前选择器 ref；开放策略停用必须显式收窄。 */
  visibleRefs?: string[];
}

/** 明确 Provider/插件级停用的限定例外：移出目标规则，不展开或修改其他 wildcard。 */
export function suspendModelProviders(config: OpenClawConfig, providerIds: string[], options: ModelSuspensionOptions = {}) {
  const targets = new Set(providerIds.map(normalizeProviderId));
  const matches = (ref: unknown): ref is string => {
    if (typeof ref !== "string") return false;
    try { return targets.has(normalizeProviderId(parseModelRef(ref).providerId)); } catch { return false; }
  };
  const primary = readPrimaryModelRef(config);
  if (matches(primary)) throw new Error(`Provider contains primary model ${primary}; switch primary before disabling.`);
  const protectedAuxiliaryRefs = (defaults: Record<string, unknown> | undefined) => {
    const refs: string[] = [];
    for (const key of ["utilityModel", "imageModel", "pdfModel"]) {
      const raw = defaults?.[key];
      if (typeof raw === "string") refs.push(raw);
      else if (raw && typeof raw === "object") {
        const shape = raw as { primary?: string; fallbacks?: string[] };
        if (shape.primary) refs.push(shape.primary);
        if (Array.isArray(shape.fallbacks)) refs.push(...shape.fallbacks);
      }
    }
    return refs;
  };
  if (protectedAuxiliaryRefs(config.agents?.defaults).some(matches)) throw new Error("Provider is referenced by an image/pdf/utility model; migrate that model first.");
  const fallback = readFallbackModelRefs(config).find(matches);
  if (fallback) throw new Error(`Provider is referenced by fallbacks (${fallback}); migrate the fallback first.`);
  // 单个 IM 可以绑定不同 Agent；不能只改 defaults 后宣称所有频道均已停用。
  const entries = config.agents?.entries;
  if (entries && typeof entries === "object" && !Array.isArray(entries)) {
    for (const [id, raw] of Object.entries(entries)) {
      if (!raw || typeof raw !== "object") continue;
      const agent = raw as NonNullable<OpenClawConfig["agents"]>["defaults"];
      const scoped = { agents: { defaults: agent! } };
      if ((agent?.modelPolicy && Object.hasOwn(agent.modelPolicy, "allow") && (!Array.isArray(agent.modelPolicy.allow) || agent.modelPolicy.allow.length === 0)) || [readPrimaryModelRef(scoped), ...readFallbackModelRefs(scoped), ...protectedAuxiliaryRefs(agent), ...(agent?.modelPolicy?.allow ?? [])].some(matches)) {
        throw new Error(`Agent ${id} explicitly references this provider; update its model/policy before disabling.`);
      }
    }
  }
  const rawAllow = readModelPolicyAllowRaw(config);
  const policy = config.agents?.defaults?.modelPolicy;
  if (policy && Object.hasOwn(policy, "allow") && !rawAllow) throw new Error("Repair invalid modelPolicy.allow before disabling a provider.");
  if (rawAllow?.some(entry => typeof entry !== "string")) throw new Error("Repair invalid modelPolicy.allow entries before disabling a provider.");
  const mode = getModelPolicyMode(config);
  const legacyRefs = Object.keys(config.agents?.defaults?.models ?? {});
  let before: string[];
  if (mode === "restricted") before = rawAllow as string[];
  else if (mode === "legacy" && legacyRefs.length > 0) before = legacyRefs;
  else {
    if (!options.visibleRefs) throw new Error("A complete model picker is required to restrict an unrestricted policy; refresh first.");
    before = options.visibleRefs;
  }
  if (before.some(ref => typeof ref !== "string" || !ref.includes("/"))) throw new Error("Provider suspension requires qualified provider/model policy refs; resolve aliases first.");
  const policyEntries = before.filter(matches);
  const allow = before.filter(ref => !matches(ref));
  // 默认模型不受 override policy 限制，保留它可避免 [] 意外开放所有 Provider。
  if (allow.length === 0 && primary) allow.push(primary);
  if (allow.length === 0) throw new Error("Disabling would leave [] unrestricted; choose another primary/model first.");
  const next = structuredClone(config);
  const defaults = (next.agents ??= {}).defaults ??= {};
  (defaults.modelPolicy ??= {}).allow = allow;
  if (options.cleanupMetadata) {
    for (const ref of Object.keys(defaults.models ?? {})) if (matches(ref)) delete defaults.models![ref];
  }
  return { config: next, policyEntries };
}

/** 恢复只追加保存的目标规则，不覆盖用户在停用期间编辑的其他规则。 */
export function restoreModelProviderSelection(config: OpenClawConfig, policyEntries: string[], options: { providerIds?: string[]; blockedProviderIds?: string[] } = {}): OpenClawConfig {
  validateSelectionEntries(policyEntries);
  const expected = options.providerIds?.map(normalizeProviderId);
  const blocked = options.blockedProviderIds?.map(normalizeProviderId) ?? [];
  for (const ref of policyEntries) {
    const provider = normalizeProviderId(parseModelRef(ref).providerId);
    if (expected && !expected.includes(provider)) throw new Error("Saved policy entries belong to another provider");
    if (blocked.includes(provider)) throw new Error(`Provider ${provider} is independently disabled; restore that provider first.`);
  }
  const next = structuredClone(config);
  if (getModelPolicyMode(next) !== "restricted" || policyEntries.length === 0) return next;
  const allow = readModelPolicyAllowRaw(next)!;
  // 非字符串历史条目原样保留，补齐规则时只计数合法字符串。
  const merged = mergeModelSelectionEntries(allow.filter((entry): entry is string => typeof entry === "string"), policyEntries);
  allow.push(...merged.slice(allow.filter(entry => typeof entry === "string").length));
  return next;
}
