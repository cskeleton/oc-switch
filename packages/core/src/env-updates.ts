import { inspectEnvFile, type ProviderEnvRef } from "./env-inspector";
import { migrateEnvVarToManagedBlock, updateManagedEnv, type EnvUpdateResult } from "./env-manager";
import type { OcSwitchManifest } from "./manifest-manager";
import type { EnvPreview } from "./env-operations";

export interface EnvUpdateOptions {
  confirmMigration?: boolean;
  confirmComplex?: boolean;
}

export interface EnvUpdatesInput {
  content: string;
  providerRefs: ProviderEnvRef[];
  manifest: OcSwitchManifest;
  updates: Record<string, string>;
  options?: EnvUpdateOptions;
}

/** 根据 updates 与当前 .env 状态生成预览（不含密钥值） */
export function previewEnvUpdates(input: Omit<EnvUpdatesInput, "options">): EnvPreview {
  const inspection = inspectEnvFile({
    content: input.content,
    providerRefs: input.providerRefs,
    manifest: input.manifest
  });
  const keys = Object.keys(input.updates);
  const warnings: string[] = [];
  let requiresConfirmation = false;
  let requiresMigration = false;
  let requiresComplex = false;

  for (const key of keys) {
    const summary = inspection.variables.find((item) => item.envVar === key);
    const unmanaged = Boolean(summary?.present && !summary.managed);
    const complex = Boolean(summary?.complex || summary?.duplicate);
    if (unmanaged) {
      requiresConfirmation = true;
      requiresMigration = true;
      warnings.push(`${key} will be migrated into the oc-switch managed block`);
    }
    if (complex) {
      requiresConfirmation = true;
      requiresComplex = true;
      warnings.push(`${key} has duplicate or complex syntax and requires explicit confirmation`);
    }
  }

  return {
    affectedKeys: keys,
    requiresConfirmation,
    requiresMigration,
    requiresComplex,
    warnings,
    backupWillIncludeSecrets: true
  };
}

/** 将 updates 写入 .env，非托管/复杂变量须通过 options 确认 */
export function applyEnvUpdates(input: EnvUpdatesInput): EnvUpdateResult {
  const inspection = inspectEnvFile({
    content: input.content,
    providerRefs: input.providerRefs,
    manifest: input.manifest
  });

  let content = input.content;
  const changedKeys: string[] = [];

  for (const [key, value] of Object.entries(input.updates)) {
    const summary = inspection.variables.find((item) => item.envVar === key);
    const unmanaged = Boolean(summary?.present && !summary.managed);
    const complex = Boolean(summary?.complex || summary?.duplicate);
    if (unmanaged && !input.options?.confirmMigration) {
      throw new Error("env var migration requires confirmation");
    }
    if (complex && !input.options?.confirmComplex) {
      throw new Error("complex env var requires confirmation");
    }

    const result = unmanaged || complex
      ? migrateEnvVarToManagedBlock(content, key, value)
      : updateManagedEnv(content, { [key]: value });
    content = result.content;
    changedKeys.push(...result.changedKeys);
  }

  return { content, changedKeys: Array.from(new Set(changedKeys)) };
}
