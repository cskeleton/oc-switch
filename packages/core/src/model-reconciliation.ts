import {
  assertNoPolicyWildcardForRef,
  assertPolicyExactRefsRemovalAllowed,
  readModelPolicyAllow,
  removePolicyAllow
} from "./model-policy";
import { normalizeModelRefForStorage } from "./model-ref";
import { addProviderModel } from "./model-operations";
import type { ModelInventoryEntry } from "./model-inventory";
import {
  matchingAllowlistRefs,
  resolveProviderId,
  type OperationResult
} from "./operation-common";
import { isPrimaryModelRef, readFallbackModelRefs } from "./primary-model";
import type { OpenClawConfig, ProviderModelInput } from "./types";

/**
 * 模型引用协调 operation（spec §8.1）。
 *
 * 两个纯 mutation，供 Server（Task 5）与 CLI（Task 6）在
 * `writeOpenClawTransaction` 内调用：
 * - `removeModelPolicyExactRef`：删除 `agents.defaults.modelPolicy.allow` 的
 *   一条 exact 引用，可选清理 legacy metadata；
 * - `materializeRuntimeModel`：把运行时确认可用的模型补入已有 config Provider。
 *
 * 两者的输入 config 都不会被修改（入口 structuredClone），错误一律以
 * `ModelReconciliationError`（结构化 code）抛出，由上层映射为 HTTP 400 /
 * CLI 非零退出。
 */

/** 结构化 blocker code：Server/CLI 据此映射为可操作的 400 提示 */
export type ModelReconciliationErrorCode =
  | "wildcard-ref-rejected"
  | "policy-ref-not-found"
  | "primary-model-referenced"
  | "fallback-referenced"
  | "model-input-mismatch"
  | "provider-config-required"
  | "runtime-model-unavailable"
  | "materialization-not-allowed"
  | "model-already-in-catalog";

export class ModelReconciliationError extends Error {
  readonly code: ModelReconciliationErrorCode;

  constructor(code: ModelReconciliationErrorCode, message: string) {
    super(message);
    this.name = "ModelReconciliationError";
    this.code = code;
  }
}

export function isModelReconciliationError(error: unknown): error is ModelReconciliationError {
  return error instanceof ModelReconciliationError;
}

export interface RemoveModelPolicyExactRefOptions {
  /** 同时删除 agents.defaults.models 中的同名 legacy metadata（spec §8.1 独立复选项，默认 false） */
  removeMetadata?: boolean;
}

/**
 * 删除一条 policy exact 引用（spec §8.1「删除引用」）。
 *
 * - 默认只删 `modelPolicy.allow` 的 exact ref，不删 wildcard、不动 legacy
 *   metadata（`removeMetadata` 显式开启才删）；
 * - policy 中不存在该 exact ref（含 legacy / unrestricted 配置）时拒绝；
 * - 删除后 allow 会变 `[]`（unrestricted）时 fail closed——本 operation 无
 *   force 选项，直接拒绝（`assertPolicyExactRefsRemovalAllowed`）；
 * - 主模型 / 合法 fallback 命中时 fail closed，force 不可绕过；
 * - 被 wildcard 覆盖的 ref 在删除前拒绝（`assertNoPolicyWildcardForRef`），
 *   提示先收窄规则；
 * - 输入 config 不被修改。
 */
export function removeModelPolicyExactRef(
  config: OpenClawConfig,
  ref: string,
  options: RemoveModelPolicyExactRefOptions = {}
): OperationResult {
  // 先做不依赖克隆的纯校验（wildcard 输入、保护性引用、存在性），全部通过后再复制配置
  const normalizedRef = normalizeModelRefForStorage(ref);

  if (ref.endsWith("/*")) {
    throw new ModelReconciliationError(
      "wildcard-ref-rejected",
      `Refusing to remove ${ref}: wildcard policy entries are read-only in oc-switch; narrow the policy manually if needed.`
    );
  }

  if (isPrimaryModelRef(config, ref)) {
    throw new ModelReconciliationError(
      "primary-model-referenced",
      `Model ${ref} is the primary model. Switch primary model before removing its policy reference.`
    );
  }

  // fallback 依赖保护（fail closed）：匹配语义与 primary-model 归一层一致（Provider 折叠 + model 敏感）
  if (readFallbackModelRefs(config).some((fallbackRef) => normalizeModelRefForStorage(fallbackRef) === normalizedRef)) {
    throw new ModelReconciliationError(
      "fallback-referenced",
      `Model ${ref} is referenced by agents.defaults.model.fallbacks. Remove it from the OpenClaw fallback list first.`
    );
  }

  // 存在性：restricted policy 里必须存在该 exact ref 才谈得上删除
  const allow = readModelPolicyAllow(config);
  const exactEntryExists =
    allow !== undefined &&
    allow.some((entry) => {
      try {
        return (
          !entry.endsWith("/*") &&
          normalizeModelRefForStorage(entry) === normalizedRef
        );
      } catch {
        return false;
      }
    });
  if (!exactEntryExists) {
    throw new ModelReconciliationError(
      "policy-ref-not-found",
      `Exact ref ${ref} not found in agents.defaults.modelPolicy.allow; nothing to remove.`
    );
  }

  // 通配覆盖与「最后一条 restricted exact」保护必须在任何写入前拒绝（含 provider 段大小写折叠匹配）
  assertNoPolicyWildcardForRef(config, ref, "remove policy reference to");
  assertPolicyExactRefsRemovalAllowed(config, [ref], "remove policy reference to", ref);

  const next = structuredClone(config);

  const warnings: string[] = [];
  const removed = removePolicyAllow(next, ref);
  if (!removed) {
    // removePolicyAllow 与上方存在性检查语义一致，这里只是防御性兜底
    throw new ModelReconciliationError(
      "policy-ref-not-found",
      `Exact ref ${ref} not found in agents.defaults.modelPolicy.allow; nothing to remove.`
    );
  }

  if (options.removeMetadata) {
    for (const allowlistRef of matchingAllowlistRefs(next, ref)) {
      delete next.agents!.defaults!.models![allowlistRef];
    }
  } else {
    // 默认保留 legacy metadata：提示该悬空引用仍存在，供 UI/CLI 二次确认
    const leftover = matchingAllowlistRefs(next, ref);
    if (leftover.length > 0) {
      warnings.push(
        `Legacy metadata ${leftover.join(", ")} was kept; pass removeMetadata to remove it as well.`
      );
    }
  }

  return { config: next, warnings };
}

/** 补全模型输入：ProviderModelInput 的目录字段 + 是否写入 selection（brief Step 4 固定形状） */
export interface MaterializeRuntimeModelInput extends ProviderModelInput {
  enabled: boolean;
}

/** materialize 前置校验的错误 code 归一：目录冲突区分「已在 config 目录」与「Provider 缺配置」 */
function materializePreflightErrorCode(config: OpenClawConfig, entry: ModelInventoryEntry): ModelReconciliationErrorCode | undefined {
  // 与 addProviderModel 相同的 Provider 解析语义（大小写折叠 + 真实重复时回退精确键）
  const resolvedProviderId = resolveProviderId(config, entry.providerId);
  if (!resolvedProviderId) return "provider-config-required";
  const provider = config.models!.providers![resolvedProviderId]!;
  if ((provider.models ?? []).some((model) => model.id === entry.modelId)) {
    return "model-already-in-catalog";
  }
  return undefined;
}

/**
 * 把运行时确认可用的模型补入已有 config Provider（spec §8.1「补全配置」）。
 *
 * 前置校验（全部通过才落到 `addProviderModel`）：
 * - 目标 Provider 必须是 config 来源（`models.providers` 已存在），否则返回
 *   结构化 blocker `provider-config-required`——绝不创建猜测配置；
 * - runtime entry 必须明确 `availability === "available"`；
 * - model ID 不得已存在于该 Provider 目录。
 *
 * 本函数只验证 inventory 证据并转换输入；真正写入复用 `addProviderModel`，
 * 从而保留 100 模型上限、metadata 默认值与 policy 写入规则。
 * 运行时事实（tags / catalogSources / availability 等）绝不写入 openclaw.json。
 */
export function materializeRuntimeModel(
  config: OpenClawConfig,
  entry: ModelInventoryEntry,
  input: MaterializeRuntimeModelInput
): OperationResult {
  if (entry.modelId !== input.id) {
    throw new ModelReconciliationError(
      "model-input-mismatch",
      `Input model id ${input.id} does not match inventory entry ${entry.ref}; refusing to materialize a different model.`
    );
  }

  if (entry.availability !== "available") {
    throw new ModelReconciliationError(
      "runtime-model-unavailable",
      `Runtime model ${entry.ref} is not confirmed available (${entry.availability}); only available runtime models can be materialized into a config provider.`
    );
  }

  if (isPrimaryModelRef(config, entry.ref)) {
    throw new ModelReconciliationError("primary-model-referenced", `Model ${entry.ref} is the primary model; switch primary before materializing it.`);
  }
  if (readFallbackModelRefs(config).some(ref => normalizeModelRefForStorage(ref) === normalizeModelRefForStorage(entry.ref))) {
    throw new ModelReconciliationError("fallback-referenced", `Model ${entry.ref} is a fallback reference; resolve that reference before materializing it.`);
  }
  if (!entry.catalogSources.includes("openclaw-runtime")) {
    throw new ModelReconciliationError("runtime-model-unavailable", `Model ${entry.ref} has no runtime catalog evidence.`);
  }

  const preflightCode = materializePreflightErrorCode(config, entry);
  if (preflightCode === "provider-config-required") {
    throw new ModelReconciliationError(
      "provider-config-required",
      `Provider ${entry.providerId} is not defined in models.providers; add the provider (baseUrl, API, credentials) before materializing ${entry.ref}.`
    );
  }
  if (preflightCode === "model-already-in-catalog") {
    throw new ModelReconciliationError(
      "model-already-in-catalog",
      `Model ${entry.ref} already exists in the ${entry.providerId} catalog; nothing to materialize.`
    );
  }
  if (!entry.capabilities.canMaterializeConfigModel) {
    throw new ModelReconciliationError(
      "materialization-not-allowed",
      `Materializing ${entry.ref} is not permitted by the current inventory; resolve the provider or reference state first.`
    );
  }

  // 输入归一：ProviderModelInput 白名单显式挑选，运行时事实字段不透传
  const providerModelInput: ProviderModelInput = {
    id: input.id,
    enabled: input.enabled,
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.alias !== undefined ? { alias: input.alias } : {}),
    ...(input.api !== undefined ? { api: input.api } : {}),
    ...(input.reasoning !== undefined ? { reasoning: input.reasoning } : {}),
    ...(input.contextWindow !== undefined ? { contextWindow: input.contextWindow } : {}),
    ...(input.contextTokens !== undefined ? { contextTokens: input.contextTokens } : {}),
    ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    ...(input.input !== undefined ? { input: input.input } : {})
  };

  // 深拷贝后再交给 addProviderModel（其自身也原地改 config），输入保持不变
  const next = structuredClone(config);
  const result = addProviderModel(next, entry.providerId, providerModelInput);
  return { config: result.config, warnings: result.warnings };
}
