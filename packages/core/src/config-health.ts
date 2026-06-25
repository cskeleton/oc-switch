import { formatModelRef } from "./model-ref";
import type { OperationResult } from "./operations";
import type { AllowlistEntry, OpenClawConfig, OpenClawModel, OpenClawProvider } from "./types";

export type CaseDuplicateKind =
  | "provider-duplicate"
  | "allowlist-drift"
  | "same-origin-hint"
  | "primary-split";

export interface CaseDuplicateGroup {
  /** toLowerCase() 归一后的分组 key，仅用于分组/展示 */
  groupKey: string;
  /** 组内实际出现的 provider ID（保留原始大小写） */
  ids: string[];
  kinds: CaseDuplicateKind[];
  confidence: "high" | "medium" | "low";
  /** 是否大概率同一来源（同 baseUrl 或同 env 变量） */
  sameOrigin: boolean;
  /** 是否满足「仅大小写差异、其余一致」的安全合并门槛 */
  mergeable: boolean;
  /** 阻断安全合并的具体原因（mergeable=false 时非空） */
  mergeBlockers: string[];
  /** 建议保留的 ID */
  canonicalId: string;
  /** 建议合并后删除的 ID */
  duplicateIds: string[];
  /** 可读说明，供 UI 展示 */
  reasons: string[];
  details: {
    baseUrls: Record<string, string | undefined>;
    allowlistCounts: Record<string, number>;
    modelCounts: Record<string, number>;
    primaryModel?: string;
    envVars: Record<string, string | undefined>;
  };
}

export interface ConfigHealthReport {
  caseDuplicateGroups: CaseDuplicateGroup[];
  summary: {
    duplicateGroupCount: number;
    affectedProviderCount: number;
    affectedAllowlistCount: number;
  };
}

/** baseUrl 轻度归一：trim + 去末尾斜杠（首版不改 host 大小写） */
function normalizeBaseUrl(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  return url.trim().replace(/\/+$/, "");
}

/** env 变量归一：剥离 `${...}` 包裹，仅取变量名，便于跨写法比较 */
function normalizeEnvVar(ref: OpenClawProvider | undefined): string | undefined {
  const raw = ref?.apiKey?.id ?? ref?.authHeader?.id;
  if (raw === undefined) return undefined;
  const match = raw.match(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/);
  return match ? match[1] : raw.trim();
}

/** 安全解析 allowlist key 的 provider 前缀（不抛错） */
function allowlistProviderPrefix(ref: string): string | undefined {
  const slashIndex = ref.indexOf("/");
  if (slashIndex <= 0) return undefined;
  return ref.slice(0, slashIndex);
}

interface GroupAccumulator {
  groupKey: string;
  ids: Set<string>;
  providerIds: Set<string>;
  allowlistIds: Set<string>;
}

export function inspectConfigHealth(
  config: OpenClawConfig,
  options: { presetIds?: string[] } = {}
): ConfigHealthReport {
  const providers = config.models?.providers ?? {};
  const allowlist = config.agents?.defaults?.models ?? {};
  const primaryModel = config.agents?.defaults?.model;
  const presetIds = new Set(options.presetIds ?? []);

  // 1. 收集 provider 块 ID 与 allowlist 前缀 ID，按 toLowerCase() 分组
  const groups = new Map<string, GroupAccumulator>();
  function ensure(id: string): GroupAccumulator {
    const key = id.toLowerCase();
    let acc = groups.get(key);
    if (!acc) {
      acc = { groupKey: key, ids: new Set(), providerIds: new Set(), allowlistIds: new Set() };
      groups.set(key, acc);
    }
    acc.ids.add(id);
    return acc;
  }
  for (const id of Object.keys(providers)) ensure(id).providerIds.add(id);
  const allowlistCountByExactId = new Map<string, number>();
  for (const ref of Object.keys(allowlist)) {
    const prefix = allowlistProviderPrefix(ref);
    if (!prefix) continue;
    ensure(prefix).allowlistIds.add(prefix);
    allowlistCountByExactId.set(prefix, (allowlistCountByExactId.get(prefix) ?? 0) + 1);
  }

  // 2. 仅保留「组内出现 >1 个不同大小写 ID」且「至少一个 ID 有 provider 块」的组。
  //    没有任何 provider 块的组 = 纯 allowlist 引用，通常是 OAuth 认证、由 OpenClaw 自身维护，
  //    本项目不管（见 spec 非目标 / 用户决策），跳过。
  const reportable = [...groups.values()].filter((acc) => acc.ids.size > 1 && acc.providerIds.size >= 1);

  const caseDuplicateGroups: CaseDuplicateGroup[] = reportable.map((acc) => {
    const ids = [...acc.ids].sort();
    const baseUrls: Record<string, string | undefined> = {};
    const envVars: Record<string, string | undefined> = {};
    const modelCounts: Record<string, number> = {};
    const allowlistCounts: Record<string, number> = {};
    for (const id of ids) {
      const provider = providers[id];
      baseUrls[id] = normalizeBaseUrl(provider?.baseUrl);
      envVars[id] = normalizeEnvVar(provider);
      modelCounts[id] = provider?.models?.length ?? 0;
      allowlistCounts[id] = allowlistCountByExactId.get(id) ?? 0;
    }

    // 3. 分类
    const kinds: CaseDuplicateKind[] = [];
    if (acc.providerIds.size > 1) kinds.push("provider-duplicate");
    const allowlistCaseMismatch = [...acc.allowlistIds].some((id) => !acc.providerIds.has(id)) ||
      acc.allowlistIds.size > 1;
    if (allowlistCaseMismatch) kinds.push("allowlist-drift");

    const presentBaseUrls = ids.map((id) => baseUrls[id]).filter((u): u is string => Boolean(u));
    const presentEnvVars = ids.map((id) => envVars[id]).filter((v): v is string => Boolean(v));
    const baseUrlSet = new Set(presentBaseUrls);
    const envVarSet = new Set(presentEnvVars);
    const sharedBaseUrl = presentBaseUrls.length >= 2 && baseUrlSet.size === 1;
    const sharedEnv = presentEnvVars.length >= 2 && envVarSet.size === 1;
    const sameOrigin = sharedBaseUrl || sharedEnv;
    if (sameOrigin) kinds.push("same-origin-hint");

    const primaryPrefix = primaryModel ? allowlistProviderPrefix(primaryModel) : undefined;
    const primaryInGroup = primaryPrefix !== undefined && acc.ids.has(primaryPrefix);
    if (primaryInGroup) kinds.push("primary-split");

    // 4. 评分选 canonical
    const score: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
    const reasons: string[] = [];
    if (primaryInGroup && primaryPrefix) {
      score[primaryPrefix]! += 2;
      reasons.push(`主模型当前为 ${primaryModel}`);
    }
    for (const id of ids) {
      const provider = providers[id];
      if (provider?.baseUrl) score[id]! += 1;
      if (provider?.apiKey || provider?.authHeader) score[id]! += 1;
      if ((provider?.models?.length ?? 0) > 0) score[id]! += 1;
      if (presetIds.has(id)) score[id]! += 1;
    }
    const maxAllowlist = Math.max(...ids.map((id) => allowlistCounts[id]!));
    const allowlistLeaders = ids.filter((id) => allowlistCounts[id]! === maxAllowlist && maxAllowlist > 0);
    if (allowlistLeaders.length === 1) score[allowlistLeaders[0]!]! += 1;

    const noStrongSignal = ids.every((id) => score[id] === 0);
    if (noStrongSignal) {
      for (const id of ids) {
        if (id === id.toLowerCase()) score[id]! += 1; // 自定义站偏小写
      }
    }

    const maxScore = Math.max(...ids.map((id) => score[id]!));
    const leaders = ids.filter((id) => score[id] === maxScore);
    const tie = leaders.length > 1;
    const canonicalId = [...leaders].sort()[0]!; // 字典序稳定
    const duplicateIds = ids.filter((id) => id !== canonicalId);

    if (sharedBaseUrl) reasons.push(`baseUrl 相同：${[...baseUrlSet][0]}`);
    if (sharedEnv) reasons.push(`引用同一 env 变量：${[...envVarSet][0]}`);
    for (const id of ids) {
      if (allowlistCounts[id]! > 0) reasons.push(`allowlist：${id} ${allowlistCounts[id]} 条`);
    }
    if (tie) reasons.push("评分持平，建议人工确认保留方");

    // 5. mergeable 门槛：同 baseUrl / 同 env，其余无冲突
    const mergeBlockers: string[] = [];
    if (presentBaseUrls.length >= 2 && baseUrlSet.size > 1) {
      mergeBlockers.push(`baseUrl 不一致：${[...baseUrlSet].join(" / ")}`);
    }
    if (presentEnvVars.length >= 2 && envVarSet.size > 1) {
      mergeBlockers.push(`env 变量不同：${[...envVarSet].join(" / ")}`);
    }
    const apiSet = new Set(ids.map((id) => providers[id]?.api).filter(Boolean));
    if (apiSet.size > 1) mergeBlockers.push(`api 类型不一致：${[...apiSet].join(" / ")}`);
    const mergeable = mergeBlockers.length === 0;

    // 6. confidence
    let confidence: CaseDuplicateGroup["confidence"];
    if (mergeBlockers.length > 0) confidence = "low";
    else if (tie) confidence = "medium";
    else confidence = "high";

    return {
      groupKey: acc.groupKey,
      ids,
      kinds,
      confidence,
      sameOrigin,
      mergeable,
      mergeBlockers,
      canonicalId,
      duplicateIds,
      reasons,
      details: {
        baseUrls,
        allowlistCounts,
        modelCounts,
        ...(primaryModel !== undefined ? { primaryModel } : {}),
        envVars
      }
    };
  });

  caseDuplicateGroups.sort((a, b) => a.groupKey.localeCompare(b.groupKey));

  const affectedProviderCount = caseDuplicateGroups.reduce(
    (sum, group) => sum + group.ids.filter((id) => providers[id]).length,
    0
  );
  const affectedAllowlistCount = caseDuplicateGroups.reduce(
    (sum, group) => sum + group.ids.reduce((s, id) => s + (group.details.allowlistCounts[id] ?? 0), 0),
    0
  );

  return {
    caseDuplicateGroups,
    summary: {
      duplicateGroupCount: caseDuplicateGroups.length,
      affectedProviderCount,
      affectedAllowlistCount
    }
  };
}

export interface MergeCaseDuplicateInput {
  groupKey: string;
  /** 用户选定的保留方（UI 的 canonical 选择器；引擎只给默认建议，最终由用户定） */
  canonicalId: string;
  removeIds: string[];
  /** 用户选定合并后保留的模型 id 集合（基于组内各块模型 id 的并集）。省略 = 全保留。 */
  keepModelIds?: string[];
}

/** 合并同一 case-insensitive 组内的 provider：迁移模型与 allowlist 到 canonicalId，删除重复块。不改 .env。 */
export function mergeProviderCaseDuplicates(config: OpenClawConfig, input: MergeCaseDuplicateInput): OperationResult {
  config.agents ??= {};
  config.agents.defaults ??= {};
  config.agents.defaults.models ??= {};
  config.models ??= {};
  config.models.providers ??= {};

  const providers = config.models.providers;
  const allowlist = config.agents.defaults.models;
  const allIds = [input.canonicalId, ...input.removeIds];
  const keepSet = input.keepModelIds ? new Set(input.keepModelIds) : undefined;
  const isKept = (modelId: string): boolean => !keepSet || keepSet.has(modelId);

  // 校验：同组、canonical 不在 removeIds
  if (!allIds.every((id) => id.toLowerCase() === input.groupKey.toLowerCase())) {
    throw new Error(`canonicalId must be one of the case-duplicate group ${input.groupKey}`);
  }
  if (input.removeIds.includes(input.canonicalId)) {
    throw new Error("removeIds must not include canonicalId");
  }
  if (input.removeIds.length === 0) {
    throw new Error("removeIds must contain at least one provider id");
  }

  const warnings: string[] = [];

  // 0. 主模型若属本组，先算出迁移后的引用，用于「不能丢弃主模型」校验
  const primary = config.agents.defaults.model;
  let migratedPrimary: string | undefined;
  if (primary) {
    const slashIndex = primary.indexOf("/");
    if (slashIndex > 0) {
      const prefix = primary.slice(0, slashIndex);
      const modelId = primary.slice(slashIndex + 1);
      if (allIds.includes(prefix)) {
        migratedPrimary = formatModelRef(input.canonicalId, modelId);
        if (!isKept(modelId)) {
          throw new Error(`Cannot drop the primary model ${primary}; keep it or set a new primary first`);
        }
      }
    }
  }

  // 1. 合并 provider 块（base = canonical 块，否则首个存在的 removeId 块），按 keepSet 过滤模型
  const baseProvider: OpenClawProvider | undefined =
    providers[input.canonicalId] ?? input.removeIds.map((id) => providers[id]).find(Boolean);

  if (baseProvider) {
    const modelsById = new Map<string, OpenClawModel>();
    // canonical 侧优先，再依次并入 removeIds（已存在则跳过，保留 canonical 字段；不校验逐字段差异）
    for (const model of providers[input.canonicalId]?.models ?? []) modelsById.set(model.id, model);
    for (const id of input.removeIds) {
      for (const model of providers[id]?.models ?? []) {
        if (!modelsById.has(model.id)) modelsById.set(model.id, model);
      }
    }
    providers[input.canonicalId] = {
      ...baseProvider,
      models: [...modelsById.values()].filter((model) => isKept(model.id))
    };
  }

  // 2. 删除重复块
  for (const id of input.removeIds) {
    if (id !== input.canonicalId) delete providers[id];
  }

  // 3. 迁移 / 清理 allowlist：removeId 前缀→canonical（丢弃不保留的模型）；canonical 侧也清理不保留的模型
  for (const ref of Object.keys(allowlist)) {
    const slashIndex = ref.indexOf("/");
    if (slashIndex <= 0) continue;
    const prefix = ref.slice(0, slashIndex);
    const modelId = ref.slice(slashIndex + 1);
    if (input.removeIds.includes(prefix)) {
      const entry: AllowlistEntry | undefined = allowlist[ref];
      delete allowlist[ref];
      if (isKept(modelId)) {
        const nextRef = formatModelRef(input.canonicalId, modelId);
        if (allowlist[nextRef] === undefined && entry !== undefined) {
          allowlist[nextRef] = entry; // 无冲突则迁移，保留原 entry（含 alias）
        }
      }
    } else if (prefix === input.canonicalId && !isKept(modelId)) {
      delete allowlist[ref]; // canonical 侧被取消保留的模型
    }
  }

  // 4. 落实主模型迁移
  if (migratedPrimary && migratedPrimary !== primary) {
    config.agents.defaults.model = migratedPrimary;
    warnings.push(`主模型已从 ${primary} 迁移到 ${migratedPrimary}`);
  }

  return { config, warnings };
}
