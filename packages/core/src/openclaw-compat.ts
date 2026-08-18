import type { EnvRef, OpenClawConfig, OpenClawModel, OpenClawProvider, OpenClawSecretRef } from "./types";
import { normalizeConfigForStorage } from "./config-normalization";

export const OPENCLAW_ENV_VAR_PATTERN = /^[A-Z][A-Z0-9_]{0,127}$/;

function parseEnvId(id: string): string | undefined {
  if (OPENCLAW_ENV_VAR_PATTERN.test(id)) return id;
  return parseEnvVarName(id);
}

function isEnvRefObject(input: unknown): input is EnvRef | OpenClawSecretRef {
  if (typeof input !== "object" || input === null) return false;
  const ref = input as { source?: string; id?: string };
  return ref.source === "env" && typeof ref.id === "string";
}

function isLegacyEnvRef(input: unknown): input is EnvRef {
  return isEnvRefObject(input) && (input as { provider?: unknown }).provider === undefined;
}

function isCanonicalSecretRef(input: unknown): input is OpenClawSecretRef {
  if (typeof input !== "object" || input === null) return false;
  const ref = input as { source?: string; provider?: string; id?: string };
  return ref.source === "env" && typeof ref.provider === "string" && ref.provider.trim().length > 0 && typeof ref.id === "string";
}

/** 从 OpenClaw 密钥引用或 env 简写解析变量名 */
export function parseEnvVarName(input: unknown): string | undefined {
  if (typeof input === "string") {
    const dollarBrace = input.match(/^\$\{([A-Z][A-Z0-9_]{0,127})\}$/);
    if (dollarBrace?.[1]) return dollarBrace[1];
    const dollarOnly = input.match(/^\$([A-Z][A-Z0-9_]{0,127})$/);
    if (dollarOnly?.[1]) return dollarOnly[1];
    return undefined;
  }
  if (isEnvRefObject(input)) {
    return parseEnvId(input.id);
  }
  return undefined;
}

/** 将合法 env 变量名格式化为 OpenClaw canonical SecretRef */
export function formatEnvRefForOpenClaw(varName: string): OpenClawSecretRef {
  if (!OPENCLAW_ENV_VAR_PATTERN.test(varName)) {
    throw new Error(`env var name must match ${OPENCLAW_ENV_VAR_PATTERN.source}`);
  }
  return { source: "env", provider: "default", id: varName };
}

/** 输入是否为 OpenClaw 可识别的 env 引用 */
export function isValidOpenClawEnvRef(input: unknown): boolean {
  return parseEnvVarName(input) !== undefined;
}

export interface ProviderSecretRefMigrationCandidate {
  providerId: string;
  envVar: string;
  currentFormat: "env-shorthand" | "legacy-env-ref";
}

/** 列出可无损升级为 canonical SecretRef 的 Provider apiKey。 */
export function inspectProviderSecretRefMigrations(
  config: OpenClawConfig
): ProviderSecretRefMigrationCandidate[] {
  const candidates: ProviderSecretRefMigrationCandidate[] = [];
  for (const [providerId, provider] of Object.entries(config.models?.providers ?? {})) {
    const apiKey = provider.apiKey;
    const envVar = parseEnvVarName(apiKey);
    if (!envVar) continue;
    if (typeof apiKey === "string") {
      candidates.push({ providerId, envVar, currentFormat: "env-shorthand" });
    } else if (isLegacyEnvRef(apiKey)) {
      candidates.push({ providerId, envVar, currentFormat: "legacy-env-ref" });
    }
  }
  return candidates.sort((a, b) => a.providerId.localeCompare(b.providerId));
}

/** 仅迁移调用方明确选择的 Provider；未知或已变化的候选会 fail closed。 */
export function migrateProviderSecretRefs<T extends OpenClawConfig>(
  config: T,
  providerIds: string[]
): { config: T; changed: boolean } {
  const candidates = new Map(
    inspectProviderSecretRefMigrations(config).map((candidate) => [candidate.providerId, candidate])
  );
  for (const providerId of providerIds) {
    if (!candidates.has(providerId)) {
      throw new Error(`Provider ${providerId} is not an eligible SecretRef migration candidate`);
    }
  }
  for (const providerId of providerIds) {
    const candidate = candidates.get(providerId)!;
    config.models!.providers![providerId]!.apiKey = formatEnvRefForOpenClaw(candidate.envVar);
  }
  return { config, changed: providerIds.length > 0 };
}

/** 从 model id 生成可读默认名称 */
export function defaultModelName(id: string): string {
  return id
    .split(/[/_\-]+/)
    .filter(Boolean)
    .map((part) => {
      if (/[a-z]/.test(part) && /[A-Z]/.test(part)) return part;
      if (part.length === 0) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join(" ");
}

/** 确保 model 带有非空 name */
export function ensureModelName(model: OpenClawModel): OpenClawModel {
  const trimmed = model.name?.trim();
  if (trimmed) return { ...model, name: trimmed };
  return { ...model, name: defaultModelName(model.id) };
}

/** 从 provider 配置解析 env 变量名（apiKey 优先，兼容 legacy authHeader） */
export function providerEnvVar(provider: OpenClawProvider | undefined): string | undefined {
  if (!provider) return undefined;
  const fromApiKey = parseEnvVarName(provider.apiKey);
  if (fromApiKey) return fromApiKey;
  if (isLegacyEnvRef(provider.authHeader)) {
    return parseEnvVarName(provider.authHeader);
  }
  return undefined;
}

function repairProvider(provider: OpenClawProvider, providerId: string, warnings: string[]): boolean {
  let changed = false;

  if (isEnvRefObject(provider.authHeader)) {
    const varName = parseEnvVarName(provider.authHeader);
    if (varName) {
      if (!provider.apiKey) {
        provider.apiKey = isCanonicalSecretRef(provider.authHeader)
          ? { ...provider.authHeader, id: varName }
          : formatEnvRefForOpenClaw(varName);
      }
      provider.authHeader = true;
      changed = true;
    }
  } else if (typeof provider.authHeader === "string") {
    warnings.push(`Provider ${providerId}: authHeader 为字符串，无法自动修复`);
  }

  for (const model of provider.models ?? []) {
    const trimmed = model.name?.trim();
    if (!trimmed) {
      model.name = defaultModelName(model.id);
      changed = true;
    }
  }

  return changed;
}

/** 就地修复 OpenClaw 2026.6.8 不兼容的 provider/model 字段 */
export function repairOpenClawCompatibility<T extends OpenClawConfig>(config: T): {
  config: T;
  changed: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  let changed = false;

  const normalized = normalizeConfigForStorage(config);
  changed ||= normalized.changed;

  for (const [providerId, provider] of Object.entries(config.models?.providers ?? {})) {
    if (repairProvider(provider, providerId, warnings)) {
      changed = true;
    }
  }

  return { config, changed, warnings };
}
