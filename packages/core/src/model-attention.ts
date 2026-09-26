import { createHash } from "node:crypto";
import { readJsonState, writeJsonState } from "./json-state-store";
import { readPrimaryModelRef, readFallbackModelRefs } from "./primary-model";
import type { ModelInventory, ModelInventoryEntry, ModelPluginDescriptor, ProviderInventoryEntry } from "./model-inventory";
import type { OpenClawConfig } from "./types";

export interface ModelAttentionIssue {
  id: string;
  revision: string;
  kind: "probe" | "unavailable" | "residual" | "dependency";
  ownerType: "plugin" | "provider" | "model" | "runtime";
  ownerId: string;
  providerIds: string[];
  refs: string[];
  protectedRefs: string[];
  title: string;
  detail: string;
  canIgnore: boolean;
  canDisable: boolean;
}
export interface ModelAttentionReport { pending: ModelAttentionIssue[]; ignored: ModelAttentionIssue[] }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identity = (ref: string) => { const slash = ref.indexOf("/"); return slash < 0 ? ref : ref.slice(0, slash).toLowerCase() + ref.slice(slash); };

/** 所有实际依赖只读汇总；不把 alias/metadata 当主模型依赖。 */
function protectedRefs(config: OpenClawConfig): string[] {
  const defaults = config.agents?.defaults;
  const entries = config.agents?.entries;
  const scopes = [defaults, ...Object.values(entries && typeof entries === "object" ? entries : {})];
  const refs: string[] = [];
  for (const raw of scopes) {
    if (!raw || typeof raw !== "object") continue;
    const scope = raw as NonNullable<OpenClawConfig["agents"]>["defaults"];
    const cfg = { agents: { defaults: scope! } };
    const primary = readPrimaryModelRef(cfg);
    if (primary) refs.push(primary);
    refs.push(...readFallbackModelRefs(cfg));
    for (const key of ["imageModel", "pdfModel", "utilityModel"]) {
      const value = scope?.[key];
      if (typeof value === "string" && value.includes("/")) refs.push(value);
      else if (value && typeof value === "object") {
        const model = value as { primary?: unknown; fallbacks?: unknown };
        if (typeof model.primary === "string") refs.push(model.primary);
        if (Array.isArray(model.fallbacks)) refs.push(...model.fallbacks.filter((v): v is string => typeof v === "string"));
      }
    }
  }
  return [...new Set(refs.map(identity))].sort();
}

/** 目录事实不等于待办：停用对象安静，同一 Provider/插件的失败合并。 */
export function buildModelAttention(config: OpenClawConfig, inventory: ModelInventory): ModelAttentionIssue[] {
  const dependencies = protectedRefs(config);
  const dependencySet = new Set(dependencies);
  // 预建查询表（单次调用内）：Provider 按小写 id 首见、插件按 id/贡献 Provider 首见，
  // 多插件贡献的选择顺序保持 inventory.plugins 原顺序（find 首个匹配的语义）
  const providerByLowerId = new Map<string, ProviderInventoryEntry>();
  for (const provider of inventory.providers) {
    const key = provider.providerId.toLowerCase();
    if (!providerByLowerId.has(key)) providerByLowerId.set(key, provider);
  }
  const pluginPositionById = new Map<string, number>();
  const pluginsByProviderLower = new Map<string, ModelPluginDescriptor[]>();
  inventory.plugins.forEach((plugin, position) => {
    if (!pluginPositionById.has(plugin.id)) pluginPositionById.set(plugin.id, position);
    for (const providerId of plugin.providerIds) {
      const key = providerId.toLowerCase();
      const list = pluginsByProviderLower.get(key) ?? [];
      if (!list.includes(plugin)) list.push(plugin);
      pluginsByProviderLower.set(key, list);
    }
  });
  const findPluginForRow = (row: ModelInventoryEntry): ModelPluginDescriptor | undefined => {
    let best: ModelPluginDescriptor | undefined;
    let bestPosition = Infinity;
    for (const pluginId of row.pluginIds) {
      const position = pluginPositionById.get(pluginId);
      if (position !== undefined && position < bestPosition) {
        bestPosition = position;
        best = inventory.plugins[position]!;
      }
    }
    for (const plugin of pluginsByProviderLower.get(row.providerId.toLowerCase()) ?? []) {
      const position = pluginPositionById.get(plugin.id)!;
      if (position < bestPosition) {
        bestPosition = position;
        best = plugin;
      }
    }
    return best;
  };
  // 各 Provider 是否仍有「可见/放行、未停用、可用」的健康选项：一次 O(M) 预建，
  // 替代逐行 O(M) 的 some 扫描（全部失效场景下旧实现接近 M²）
  const healthyByProviderLower = new Map<string, true>();
  for (const model of inventory.models) {
    if (!(model.pickerVisible || model.policyAllowed) || model.inactive || model.availability !== "available") continue;
    const key = model.providerId.toLowerCase();
    if (!healthyByProviderLower.has(key)) healthyByProviderLower.set(key, true);
  }
  const hasHealthySelectionFor = (ownerProviders: readonly string[]): boolean =>
    ownerProviders.some((providerId) => healthyByProviderLower.get(providerId.toLowerCase()) === true);

  const groups = new Map<string, ModelAttentionIssue>();
  const unknown = inventory.models.some(m => m.availability === "unknown" && !m.inactive);
  if (inventory.diagnostics.length || unknown) {
    groups.set("runtime:probe", { id: "runtime:probe", revision: "probe", kind: "probe", ownerType: "runtime", ownerId: "gateway", providerIds: [], refs: [], protectedRefs: [], canIgnore: false, canDisable: false,
      title: "运行状态尚未确认", detail: "部分探测未完成。保留已有证据，请重试或查看诊断；不会把未知目录批量列为模型故障。" });
  }
  for (const row of inventory.models) {
    const protectedRef = dependencySet.has(identity(row.ref));
    const provider = providerByLowerId.get(row.providerId.toLowerCase());
    const plugin = findPluginForRow(row);
    const stopped = provider?.disabled || (!row.catalogSources.includes("config") && plugin?.enabled === false);
    const residual = Boolean(stopped && row.pickerVisible && inventory.pickerSource === "gateway");
    if (!residual && (!protectedRef && (row.inactive || stopped || (!row.policyAllowed && !row.pickerVisible)))) continue;
    if (!residual && (row.availability === "available" || row.availability === "unknown")) continue;
    // 单模型失效不升级为整插件故障，避免关闭同组仍被正常使用的模型。
    const ownerProviders = plugin?.providerIds ?? [row.providerId];
    const hasHealthySelection = hasHealthySelectionFor(ownerProviders);
    const ownerType = protectedRef || (!residual && hasHealthySelection) ? "model" : plugin ? "plugin" : provider?.sources.includes("config") ? "provider" : "model";
    const ownerId = ownerType === "plugin" ? plugin!.id : ownerType === "provider" ? row.providerId : row.ref;
    const kind = protectedRef ? "dependency" : residual ? "residual" : "unavailable";
    const id = `${ownerType}:${encodeURIComponent(ownerId)}:${kind}`;
    let issue = groups.get(id);
    if (!issue) {
      const affectedProviders = ownerType === "plugin" ? plugin!.providerIds : [row.providerId];
      const dependencyHits = dependencies.filter(ref => affectedProviders.some(p => ref.startsWith(`${p.toLowerCase()}/`)));
      issue = { id, revision: "", kind, ownerType, ownerId, refs: [], providerIds: [...affectedProviders], protectedRefs: dependencyHits,
        title: protectedRef ? `使用中的模型需要修复：${row.ref}` : residual ? `${ownerId} 仍有残留模型选项` : `${ownerId} 的选用模型未就绪`,
        detail: protectedRef ? "该对象存在主模型、fallback 或其他实际依赖，请先替换或修复。" : residual ? "停用状态尚未完全反映到 IM；可整组移出选择规则，或只忽略此提示。" : "可配置当前 Provider、停用并保留配置，或将本问题设为不再提醒。",
        canIgnore: dependencyHits.length === 0,
        canDisable: dependencyHits.length === 0 && (ownerType !== "model" || row.capabilities.canRemovePolicyExactRef)
      };
      groups.set(id, issue);
    }
    issue.refs.push(row.ref);
  }
  for (const issue of groups.values()) {
    issue.refs = [...new Set(issue.refs)].sort();
    if (issue.kind !== "probe") {
      // 只记录使用意图指纹，不保存 Key/完整配置。新增明确引用或插件重新启用会使旧忽略失效。
      const policy = (config.agents?.defaults?.modelPolicy?.allow ?? Object.keys(config.agents?.defaults?.models ?? {}))
        .filter(ref => typeof ref === "string" && issue.providerIds.some(p => identity(ref).startsWith(`${p.toLowerCase()}/`)));
      issue.revision = hash({ kind: issue.kind, refs: issue.refs, policy, dependencies: issue.protectedRefs,
        enabled: inventory.plugins.filter(p => issue.providerIds.some(id => p.providerIds.includes(id))).map(p => [p.id, p.enabled]) });
    }
  }
  return [...groups.values()].sort((a, b) => Number(a.canIgnore) - Number(b.canIgnore) || a.id.localeCompare(b.id));
}

const FILE = "attention-decisions.json";
type Decisions = Record<string, Record<string, { revision: string }>>;
const read = (stateDir: string) => readJsonState<Decisions>({ stateDir, filename: FILE, fallback: () => ({}), invalidJson: "throw" });

export function setAttentionIgnored(stateDir: string, scope: string, issue: ModelAttentionIssue, ignored: boolean): void {
  if (ignored && !issue.canIgnore) throw new Error("该问题涉及实际依赖或探测状态，不能忽略；请先修复或替换依赖。");
  const decisions = read(stateDir);
  const key = hash(scope);
  const entries = decisions[key] ??= {};
  if (ignored) entries[issue.id] = { revision: issue.revision };
  else delete entries[issue.id];
  writeJsonState({ stateDir, filename: FILE, value: decisions });
}

/** 已有忽略记录在健康/意图改变时失效；普通读取不会创建状态文件。 */
export function applyAttentionDecisions(stateDir: string, scope: string, issues: ModelAttentionIssue[]): ModelAttentionReport {
  const decisions = read(stateDir);
  const key = hash(scope);
  const saved = decisions[key] ?? {};
  let changed = false;
  for (const id of Object.keys(saved)) {
    const issue = issues.find(i => i.id === id);
    if (issue ? !issue.canIgnore || issue.revision !== saved[id]!.revision : !issues.some(i => i.kind === "probe")) {
      delete saved[id]; changed = true;
    }
  }
  if (changed) writeJsonState({ stateDir, filename: FILE, value: decisions });
  return { pending: issues.filter(i => saved[i.id]?.revision !== i.revision), ignored: issues.filter(i => saved[i.id]?.revision === i.revision) };
}
