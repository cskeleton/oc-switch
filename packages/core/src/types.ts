export type ApiType = "openai-completions" | "anthropic-messages" | "google-generative-ai";

export interface EnvRef {
  source: "env";
  id: string;
}

export interface OpenClawSecretRef {
  source: "env" | "file" | "exec";
  provider: string;
  id: string;
}

export type OpenClawSecretInput = string | EnvRef | OpenClawSecretRef;

export interface OpenClawModel {
  id: string;
  name?: string;
  alias?: string;
  api?: ApiType;
  reasoning?: boolean;
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
  input?: string[];
  cost?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenClawProvider {
  baseUrl?: string;
  api?: ApiType;
  apiKey?: OpenClawSecretInput;
  authHeader?: boolean | EnvRef;
  models?: OpenClawModel[];
  [key: string]: unknown;
}

export interface AllowlistEntry {
  alias?: string;
  agentRuntime?: { id: string };
  [key: string]: unknown;
}

/**
 * OpenClaw 新版对象形态主模型：primary 与运行时回退链 fallbacks。
 * oc-switch 只归一读写 primary；其余键原样穿透（前向兼容保留策略）。
 */
export interface OpenClawPrimaryModelObject {
  primary?: string;
  [key: string]: unknown;
}

/** `agents.defaults.model` 的两种合法形态：旧版字符串 ref / 新版对象 */
export type OpenClawPrimaryModel = string | OpenClawPrimaryModelObject;

export interface OpenClawConfig {
  models?: {
    mode?: string;
    providers?: Record<string, OpenClawProvider>;
    [key: string]: unknown;
  };
  agents?: {
    defaults?: {
      model?: OpenClawPrimaryModel;
      models?: Record<string, AllowlistEntry>;
      /** OpenClaw 2026.8+ 覆盖 allowlist；非空时取代 models 成员作为可选性判据。读写一律走 model-policy.ts 归一层 */
      modelPolicy?: {
        allow?: unknown[];
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ProviderSummary {
  id: string;
  api: string | undefined;
  baseUrl: string | undefined;
  modelCount: number;
  enabledModelCount: number;
  containsPrimary: boolean;
  disabled: boolean;
}

export interface ModelSummary {
  ref: string;
  providerId: string;
  modelId: string;
  name: string | undefined;
  alias: string | undefined;
  enabled: boolean;
  /** undefined 表示该行没有有效 selection 来源。 */
  selectionSource?: ModelSelectionSource;
  isPrimary: boolean;
  api?: ApiType;
  reasoning?: boolean;
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
  input?: string[];
}

export interface StatusSummary {
  primaryModel: string | undefined;
  providerCount: number;
  providerModelCount: number;
  allowlistModelCount: number;
  modelPolicyMode: ModelPolicyMode;
  effectiveModelCount: number;
}

export type ModelPolicyMode = "legacy" | "unrestricted" | "restricted";

export type ModelSelectionSource = "legacy" | "unrestricted" | "policy-exact" | "policy-wildcard";

export interface ProviderPreset {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  provider: {
    api: ApiType;
    baseUrl: string;
    apiKeyEnv: string;
  };
  models: Array<OpenClawModel & { alias?: string }>;
}

export interface CustomProviderModelInput {
  id: string;
  name?: string;
  alias?: string;
}

export interface ProviderModelInput {
  id: string;
  name?: string;
  alias?: string;
  enabled: boolean;
  api?: ApiType;
  reasoning?: boolean;
  contextWindow?: number;
  contextTokens?: number;
  maxTokens?: number;
  input?: string[];
}

export interface CustomProviderInput {
  providerId: string;
  displayName: string;
  notes?: string;
  websiteUrl?: string;
  api: ApiType;
  baseUrl: string;
  isFullUrl: boolean;
  apiKeyEnv: string;
  models: CustomProviderModelInput[];
  enableAllModels: boolean;
}
