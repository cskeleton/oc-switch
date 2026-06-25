import type { ApiType, CustomProviderInput } from "@oc-switch/core";

/** 校验请求体中的非空字符串字段 */
export function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

/** 校验请求体中的布尔字段 */
export function requireBoolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean`);
  }
  return value;
}

const API_TYPES = new Set<ApiType>(["openai-completions", "anthropic-messages", "google-generative-ai"]);

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requireString(value, name);
}

export function requireApiType(value: unknown, name: string): ApiType {
  const api = requireString(value, name) as ApiType;
  if (!API_TYPES.has(api)) throw new Error(`${name} must be a supported API type`);
  return api;
}

export function requireBooleanDefault(value: unknown, name: string, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return requireBoolean(value, name);
}

export function requireEnvPreviewOperation(body: Record<string, unknown>) {
  if (body.value !== undefined) throw new Error("preview must not include value");
  const type = requireString(body.type, "type");
  if (type !== "upsert" && type !== "delete" && type !== "rename") throw new Error("type must be upsert, delete, or rename");
  if (type === "rename") {
    return {
      type,
      fromEnvVar: requireString(body.fromEnvVar, "fromEnvVar"),
      toEnvVar: requireString(body.toEnvVar, "toEnvVar"),
      ...(body.confirmComplex !== undefined ? { confirmComplex: requireBoolean(body.confirmComplex, "confirmComplex") } : {}),
      ...(body.note !== undefined ? { note: requireString(body.note, "note") } : {})
    };
  }
  return {
    type,
    envVar: requireString(body.envVar, "envVar"),
    ...(body.confirmMigration !== undefined ? { confirmMigration: requireBoolean(body.confirmMigration, "confirmMigration") } : {}),
    ...(body.confirmComplex !== undefined ? { confirmComplex: requireBoolean(body.confirmComplex, "confirmComplex") } : {}),
    ...(type === "upsert" && body.note !== undefined ? { note: requireString(body.note, "note") } : {})
  };
}

export function requireEnvOperation(body: Record<string, unknown>) {
  const type = requireString(body.type, "type");
  if (type !== "upsert" && type !== "delete" && type !== "rename") throw new Error("type must be upsert, delete, or rename");
  if (type === "rename") {
    return {
      type,
      fromEnvVar: requireString(body.fromEnvVar, "fromEnvVar"),
      toEnvVar: requireString(body.toEnvVar, "toEnvVar"),
      ...(body.confirmComplex !== undefined ? { confirmComplex: requireBoolean(body.confirmComplex, "confirmComplex") } : {}),
      ...(body.note !== undefined ? { note: requireString(body.note, "note") } : {})
    };
  }
  const base = {
    type,
    envVar: requireString(body.envVar, "envVar"),
    ...(body.confirmMigration !== undefined ? { confirmMigration: requireBoolean(body.confirmMigration, "confirmMigration") } : {}),
    ...(body.confirmComplex !== undefined ? { confirmComplex: requireBoolean(body.confirmComplex, "confirmComplex") } : {})
  };
  if (type === "delete") return base;
  return {
    ...base,
    value: requireString(body.value, "value"),
    ...(body.note !== undefined ? { note: requireString(body.note, "note") } : {})
  };
}

export type RestoreBackupTarget = "backup" | "current";

export function optionalRestoreBackupTarget(body: Record<string, unknown>): RestoreBackupTarget | undefined {
  if (body.target === undefined || body.target === null || body.target === "") return undefined;
  const target = requireString(body.target, "target");
  if (target !== "backup" && target !== "current") throw new Error("target must be backup or current");
  return target;
}

export function requireCustomProviderInput(body: Record<string, unknown>): CustomProviderInput {
  const modelsValue = body.models;
  if (!Array.isArray(modelsValue)) throw new Error("models must be an array");
  const notes = optionalString(body.notes, "notes");
  const websiteUrl = optionalString(body.websiteUrl, "websiteUrl");
  const input: CustomProviderInput = {
    providerId: requireString(body.providerId, "providerId"),
    displayName: requireString(body.displayName, "displayName"),
    api: requireApiType(body.api, "api"),
    baseUrl: requireString(body.baseUrl, "baseUrl"),
    isFullUrl: requireBooleanDefault(body.isFullUrl, "isFullUrl", false),
    apiKeyEnv: requireString(body.apiKeyEnv, "apiKeyEnv"),
    models: modelsValue.map((model, index) => {
      if (!model || typeof model !== "object") throw new Error(`models.${index} must be an object`);
      const entry = model as Record<string, unknown>;
      const alias = optionalString(entry.alias, `models.${index}.alias`);
      const parsed: { id: string; alias?: string } = {
        id: requireString(entry.id, `models.${index}.id`)
      };
      if (alias !== undefined) parsed.alias = alias;
      return parsed;
    }),
    enableAllModels: requireBooleanDefault(body.enableAllModels, "enableAllModels", true)
  };
  if (notes !== undefined) input.notes = notes;
  if (websiteUrl !== undefined) input.websiteUrl = websiteUrl;
  return input;
}
