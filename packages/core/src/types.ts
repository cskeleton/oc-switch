export type ApiType = "openai-completions" | "anthropic-messages" | "google-generative-ai";

export interface EnvRef {
  source: "env";
  id: string;
}

export interface OpenClawModel {
  id: string;
  name?: string;
  alias?: string;
  api?: ApiType;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  cost?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface OpenClawProvider {
  baseUrl?: string;
  api?: ApiType;
  apiKey?: EnvRef;
  authHeader?: EnvRef;
  models?: OpenClawModel[];
  [key: string]: unknown;
}

export interface AllowlistEntry {
  alias?: string;
  agentRuntime?: { id: string };
  [key: string]: unknown;
}

export interface OpenClawConfig {
  models?: {
    mode?: string;
    providers?: Record<string, OpenClawProvider>;
    [key: string]: unknown;
  };
  agents?: {
    defaults?: {
      model?: string;
      models?: Record<string, AllowlistEntry>;
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
  isPrimary: boolean;
  api?: ApiType;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
}

export interface StatusSummary {
  primaryModel: string | undefined;
  providerCount: number;
  providerModelCount: number;
  allowlistModelCount: number;
}

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
