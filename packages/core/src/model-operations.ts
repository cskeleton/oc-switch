import { formatModelRef, normalizeModelRefForStorage, normalizeProviderId, parseModelRef } from "./model-ref";
import { defaultModelName } from "./openclaw-compat";
import {
  ensureDefaults,
  hasKnownModel,
  matchingAllowlistRefs,
  resolveProviderId,
  type OperationResult
} from "./operation-common";
import {
  addPolicyAllow,
  assertNoPolicyWildcardForRef,
  assertPolicyExactRefsRemovalAllowed,
  removePolicyAllow
} from "./model-policy";
import { isPrimaryModelRef, readFallbackModelRefs, readPrimaryModelRef, writePrimaryModelRef } from "./primary-model";
import type { PluginProvider } from "./plugin-catalog";
import { assertProviderModelCapacity } from "./provider-model-limits";
import type { AllowlistEntry, OpenClawConfig, OpenClawModel, ProviderModelInput } from "./types";

/**
 * fallback 依赖保护（fail closed）：被 agents.defaults.model.fallbacks 引用的模型
 * 不得删除或改名，force 也不可绕过；oc-switch 不自动改写 fallbacks。
 */
function assertFallbackRemovalAllowed(config: OpenClawConfig, ref: string): void {
  if (readFallbackModelRefs(config).some((fallbackRef) => normalizeModelRefForStorage(fallbackRef) === normalizeModelRefForStorage(ref))) {
    throw new Error(
      `Model ${ref} is referenced by agents.defaults.model.fallbacks. Remove it from the OpenClaw fallback list first.`
    );
  }
}

function assertPrimaryRemovalAllowed(
  config: OpenClawConfig,
  ref: string,
  options: { force: boolean; newPrimary?: string }
): void {
  if (!isPrimaryModelRef(config, ref)) return;
  if (options.newPrimary) {
    setPrimaryModel(config, options.newPrimary);
    return;
  }
  if (!options.force) {
    throw new Error(`Model ${ref} is the primary model`);
  }
}

/**
 * 目录校验失败时的报错：命中「插件已停用」时给出可操作提示，
 * 否则沿用既有的 not defined 文案（外部依赖该文案的测试与提示不变）。
 */
function assertKnownModel(
  config: OpenClawConfig,
  ref: string,
  pluginProviders: PluginProvider[]
): void {
  if (hasKnownModel(config, ref, pluginProviders)) return;
  const { providerId, modelId } = parseModelRef(ref);
  const disabledPlugin = pluginProviders.find(
    (plugin) =>
      !plugin.enabled &&
      normalizeProviderId(plugin.providerId) === normalizeProviderId(providerId) &&
      plugin.models.some((model) => model.id === modelId)
  );
  if (disabledPlugin) {
    throw new Error(
      `Model ${ref} belongs to plugin ${disabledPlugin.pluginId}, which is disabled in OpenClaw (plugins.entries.${disabledPlugin.pluginId}.enabled=false); enable the plugin in OpenClaw first`
    );
  }
  throw new Error(`Model ${ref} is not defined in provider models`);
}

export function setPrimaryModel(
  config: OpenClawConfig,
  ref: string,
  pluginProviders: PluginProvider[] = []
): OperationResult {
  ensureDefaults(config);
  assertKnownModel(config, ref, pluginProviders);
  writePrimaryModelRef(config, ref);
  return { config, warnings: [] };
}

export function disableModel(config: OpenClawConfig, ref: string): OperationResult {
  assertNoPolicyWildcardForRef(config, ref, "disable");
  assertPolicyExactRefsRemovalAllowed(config, [ref], "disable", ref);
  ensureDefaults(config);
  for (const allowlistRef of matchingAllowlistRefs(config, ref)) {
    delete config.agents!.defaults!.models![allowlistRef];
  }
  removePolicyAllow(config, ref);
  return { config, warnings: [] };
}

export function enableModel(
  config: OpenClawConfig,
  ref: string,
  alias?: string,
  pluginProviders: PluginProvider[] = []
): OperationResult {
  ensureDefaults(config);
  assertKnownModel(config, ref, pluginProviders);
  const matchingRefs = matchingAllowlistRefs(config, ref);
  const existingRef = matchingRefs[0];
  const existing = existingRef ? config.agents!.defaults!.models![existingRef] ?? {} : {};
  const next: AllowlistEntry = alias ? { ...existing, alias } : existing;
  for (const matchingRef of matchingRefs) delete config.agents!.defaults!.models![matchingRef];
  const storageRef = normalizeModelRefForStorage(ref);
  config.agents!.defaults!.models![storageRef] = next;
  addPolicyAllow(config, storageRef);
  return { config, warnings: [] };
}

const MODEL_API_TYPES = new Set<NonNullable<ProviderModelInput["api"]>>([
  "openai-completions",
  "anthropic-messages",
  "google-generative-ai"
]);

function assertPositiveInteger(value: number | undefined, name: string): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
}

function assertProviderModelInput(input: ProviderModelInput): void {
  if (!input.id.trim()) throw new Error("model id must be a non-empty string");
  if (input.api !== undefined && !MODEL_API_TYPES.has(input.api)) throw new Error("api must be a supported API type");
  assertPositiveInteger(input.contextWindow, "contextWindow");
  assertPositiveInteger(input.contextTokens, "contextTokens");
  assertPositiveInteger(input.maxTokens, "maxTokens");
  // contextTokens 是运行预算，contextWindow 是模型原生能力；两者同时填写时预算不得超过能力
  if (input.contextTokens !== undefined && input.contextWindow !== undefined && input.contextTokens > input.contextWindow) {
    throw new Error("contextTokens must not be greater than contextWindow");
  }
}

function applyProviderModelInput(existing: OpenClawModel | undefined, input: ProviderModelInput): OpenClawModel {
  const next: OpenClawModel = existing
    ? { ...existing, id: input.id }
    : { id: input.id, reasoning: input.reasoning ?? true };

  if (input.name !== undefined) {
    const trimmed = input.name.trim();
    if (trimmed) {
      next.name = trimmed;
    } else if (!existing?.name?.trim()) {
      next.name = defaultModelName(input.id);
    }
  } else if (!existing?.name?.trim()) {
    next.name = defaultModelName(input.id);
  }

  for (const key of ["api", "reasoning", "contextWindow", "contextTokens", "maxTokens", "input"] as const) {
    const value = input[key];
    if (value === undefined || (Array.isArray(value) && value.length === 0)) {
      if (existing !== undefined || key !== "reasoning") delete next[key];
    } else {
      next[key] = value as never;
    }
  }
  return next;
}

function upsertAllowlistEntry(config: OpenClawConfig, ref: string, alias: string | undefined): void {
  const existing = config.agents!.defaults!.models![ref] ?? {};
  const next: AllowlistEntry = { ...existing };
  if (alias === undefined || alias === "") {
    delete next.alias;
  } else {
    next.alias = alias;
  }
  config.agents!.defaults!.models![ref] = next;
}

export function addProviderModel(
  config: OpenClawConfig,
  providerIdOrRef: string,
  input: ProviderModelInput | { name?: string; alias?: string; enabled: boolean }
): OperationResult {
  ensureDefaults(config);
  const refInput = "id" in input
    ? { providerId: providerIdOrRef, modelId: input.id, input }
    : (() => {
        const { providerId, modelId } = parseModelRef(providerIdOrRef);
        return { providerId, modelId, input: { ...input, id: modelId } };
      })();
  assertProviderModelInput(refInput.input);
  const resolvedProviderId = resolveProviderId(config, refInput.providerId);
  const provider = resolvedProviderId ? config.models!.providers![resolvedProviderId] : undefined;
  if (!provider) throw new Error(`Provider ${refInput.providerId} not found`);

  const ref = formatModelRef(resolvedProviderId!, refInput.modelId);
  const models = provider.models ?? [];
  if (models.some((model) => model.id === refInput.modelId)) {
    throw new Error(`Model ${ref} already exists`);
  }

  assertProviderModelCapacity(provider, 1);

  provider.models = [...models, applyProviderModelInput(undefined, refInput.input)];

  if (refInput.input.enabled) {
    upsertAllowlistEntry(config, ref, refInput.input.alias);
    addPolicyAllow(config, ref);
  }

  return { config, warnings: [] };
}

export function updateProviderModel(config: OpenClawConfig, ref: string, input: ProviderModelInput): OperationResult {
  assertProviderModelInput(input);
  const { providerId, modelId } = parseModelRef(ref);
  const resolvedProviderId = resolveProviderId(config, providerId);
  const provider = resolvedProviderId ? config.models!.providers![resolvedProviderId] : undefined;
  if (!provider) throw new Error(`Provider ${providerId} not found`);

  const models = provider.models ?? [];
  const existingIndex = models.findIndex((model) => model.id === modelId);
  if (existingIndex === -1) throw new Error(`Model ${ref} not found`);

  const canonicalProviderId = normalizeProviderId(resolvedProviderId!);
  const nextRef = formatModelRef(canonicalProviderId, input.id);
  if (input.id !== modelId && models.some((model) => model.id === input.id)) {
    throw new Error(`Model ${nextRef} already exists`);
  }
  // 改名会使旧 ref 从目录消失：若被 fallbacks 引用则拒绝（先于任何 mutation）
  if (input.id !== modelId) {
    assertFallbackRemovalAllowed(config, ref);
    assertNoPolicyWildcardForRef(config, ref, "rename");
    if (!input.enabled) {
      assertNoPolicyWildcardForRef(config, nextRef, "disable");
      assertPolicyExactRefsRemovalAllowed(config, [ref, nextRef], "rename", ref);
    }
  } else if (!input.enabled) {
    assertNoPolicyWildcardForRef(config, ref, "disable");
    assertPolicyExactRefsRemovalAllowed(config, [ref], "disable", ref);
  }

  ensureDefaults(config);

  // 启用改名先补入新精确条目，再移除旧条目，避免最后一条受限 policy 被短暂清空为 unrestricted。
  if (input.id !== modelId && input.enabled) {
    addPolicyAllow(config, nextRef);
  }

  const existingModel = models[existingIndex];
  provider.models = models.map((model, index) =>
    index === existingIndex ? applyProviderModelInput(existingModel, input) : model
  );

  const existingAllowlistRefs = matchingAllowlistRefs(config, ref);
  const existingAllowlistRef = existingAllowlistRefs[0];
  const existingAllowlist = existingAllowlistRef
    ? config.agents!.defaults!.models![existingAllowlistRef]
    : undefined;
  if (input.id !== modelId) {
    for (const allowlistRef of existingAllowlistRefs) {
      delete config.agents!.defaults!.models![allowlistRef];
    }
    removePolicyAllow(config, ref);
    if (isPrimaryModelRef(config, ref)) {
      writePrimaryModelRef(config, nextRef);
    }
  }

  if (input.enabled) {
    for (const allowlistRef of matchingAllowlistRefs(config, nextRef)) {
      delete config.agents!.defaults!.models![allowlistRef];
    }
    const targetAllowlistRef = formatModelRef(canonicalProviderId, input.id);
    config.agents!.defaults!.models![targetAllowlistRef] = existingAllowlist ?? {};
    upsertAllowlistEntry(config, targetAllowlistRef, input.alias);
    addPolicyAllow(config, targetAllowlistRef);
  } else {
    for (const allowlistRef of matchingAllowlistRefs(config, nextRef)) {
      delete config.agents!.defaults!.models![allowlistRef];
    }
    removePolicyAllow(config, nextRef);
  }

  return { config, warnings: [] };
}

export function removeProviderModel(
  config: OpenClawConfig,
  ref: string,
  options: { force: boolean; newPrimary?: string }
): OperationResult {
  const { providerId, modelId } = parseModelRef(ref);
  const resolvedProviderId = resolveProviderId(config, providerId);
  const provider = resolvedProviderId ? config.models!.providers![resolvedProviderId] : undefined;
  if (!provider) throw new Error(`Provider ${providerId} not found`);

  // fallback 依赖保护必须发生在任何 mutation 之前（force 也不可绕过）
  assertFallbackRemovalAllowed(config, ref);
  assertNoPolicyWildcardForRef(config, ref, "remove");
  assertPolicyExactRefsRemovalAllowed(config, [ref], "remove", ref);
  assertPrimaryRemovalAllowed(config, ref, options);

  ensureDefaults(config);

  provider.models = (provider.models ?? []).filter((model) => model.id !== modelId);
  for (const allowlistRef of matchingAllowlistRefs(config, ref)) {
    delete config.agents!.defaults!.models![allowlistRef];
  }
  removePolicyAllow(config, ref);

  const warnings: string[] = [];
  if (isPrimaryModelRef(config, ref) && options.force) {
    warnings.push(`Primary model ${ref} was removed`);
  }

  return { config, warnings };
}

export function definedRefs(config: OpenClawConfig): string[] {
  const providers = config.models?.providers ?? {};
  return Object.entries(providers).flatMap(([providerId, provider]) =>
    (provider.models ?? []).map((model) => formatModelRef(normalizeProviderId(providerId), model.id))
  );
}
