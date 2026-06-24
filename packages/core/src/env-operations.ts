import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { inspectEnvFile, listProviderEnvRefs } from "./env-inspector";
import { migrateEnvVarToManagedBlock, removeManagedEnvKeys, renameManagedEnvKey, updateManagedEnv } from "./env-manager";
import { readManifest, removeExtraEnvManifest, upsertExtraEnvManifest } from "./manifest-manager";
import { writeEnvTransaction } from "./transaction-writer";
import type { OcSwitchPaths } from "./paths";
import type { OpenClawConfig } from "./types";
import JSON5 from "json5";

const ENV_VAR_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EnvOperation =
  | { type: "upsert"; envVar: string; value?: string; note?: string; confirmMigration?: boolean; confirmComplex?: boolean }
  | { type: "delete"; envVar: string; confirmComplex?: boolean }
  | { type: "rename"; fromEnvVar: string; toEnvVar: string; note?: string; confirmComplex?: boolean };

export interface EnvPreview {
  affectedKeys: string[];
  requiresConfirmation: boolean;
  warnings: string[];
  backupWillIncludeSecrets: boolean;
}

export interface EnvOperationResult {
  ok: true;
  affectedKeys: string[];
  backupId?: string;
}

function assertEnvVar(envVar: string): void {
  if (!ENV_VAR_PATTERN.test(envVar)) throw new Error("envVar must be a valid env var name");
}

function readConfig(paths: OcSwitchPaths): OpenClawConfig {
  return JSON5.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
}

function readEnv(paths: OcSwitchPaths): string {
  return existsSync(paths.envPath) ? readFileSync(paths.envPath, "utf8") : "";
}

function inspect(paths: OcSwitchPaths) {
  return inspectEnvFile({
    content: readEnv(paths),
    providerRefs: listProviderEnvRefs(readConfig(paths)),
    manifest: readManifest(paths.stateDir)
  });
}

export function previewEnvOperation(input: {
  paths: OcSwitchPaths;
  operation:
    | { type: "upsert" | "delete"; envVar: string; note?: string }
    | { type: "rename"; fromEnvVar: string; toEnvVar: string; note?: string };
}): EnvPreview {
  const envVar = input.operation.type === "rename" ? input.operation.fromEnvVar : input.operation.envVar;
  assertEnvVar(envVar);
  if (input.operation.type === "rename") assertEnvVar(input.operation.toEnvVar);
  const summary = inspect(input.paths).variables.find((item) => item.envVar === envVar);
  const unmanaged = Boolean(summary?.present && !summary.managed);
  const complex = Boolean(summary?.complex || summary?.duplicate);
  const affectedKeys = input.operation.type === "rename" ? [input.operation.fromEnvVar, input.operation.toEnvVar] : [input.operation.envVar];
  return {
    affectedKeys,
    requiresConfirmation: unmanaged || complex,
    warnings: [
      ...(unmanaged ? [`${envVar} will be migrated into the oc-switch managed block`] : []),
      ...(complex ? [`${envVar} has duplicate or complex syntax and requires explicit confirmation`] : [])
    ],
    backupWillIncludeSecrets: true
  };
}

export async function applyEnvOperation(input: { paths: OcSwitchPaths; operation: EnvOperation }): Promise<EnvOperationResult> {
  const envVar = input.operation.type === "rename" ? input.operation.fromEnvVar : input.operation.envVar;
  assertEnvVar(envVar);
  if (input.operation.type === "rename") assertEnvVar(input.operation.toEnvVar);
  if (input.operation.type === "upsert" && input.operation.value === undefined) {
    throw new Error("value is required");
  }

  const inspection = inspect(input.paths);
  const summary = inspection.variables.find((item) => item.envVar === envVar);
  const unmanaged = Boolean(summary?.present && !summary.managed);
  const complex = Boolean(summary?.complex || summary?.duplicate);
  if (input.operation.type === "rename" && summary?.providerRef) {
    throw new Error("provider env var cannot be renamed from env management");
  }
  if (input.operation.type === "rename" && !summary?.managed) {
    throw new Error("managed env var is required for rename");
  }
  if (unmanaged && input.operation.type !== "rename" && !("confirmMigration" in input.operation && input.operation.confirmMigration)) {
    throw new Error("env var migration requires confirmation");
  }
  if (complex && !input.operation.confirmComplex) {
    throw new Error("complex env var requires confirmation");
  }

  const result = await writeEnvTransaction({
    ...input.paths,
    reason: input.operation.type === "rename"
      ? `rename env var ${input.operation.fromEnvVar} to ${input.operation.toEnvVar}`
      : `${input.operation.type} env var ${input.operation.envVar}`,
    mutateEnv(content) {
      if (input.operation.type === "delete") {
        return removeManagedEnvKeys(content, [input.operation.envVar]).content;
      }
      if (input.operation.type === "rename") {
        return renameManagedEnvKey(content, input.operation.fromEnvVar, input.operation.toEnvVar).content;
      }
      if (unmanaged) {
        return migrateEnvVarToManagedBlock(content, input.operation.envVar, input.operation.value!).content;
      }
      return updateManagedEnv(content, { [input.operation.envVar]: input.operation.value! }).content;
    },
    afterWrite() {
      if (input.operation.type === "upsert" && !summary?.providerRef) {
        upsertExtraEnvManifest(input.paths.stateDir, input.operation.envVar, {
          ...(input.operation.note !== undefined ? { note: input.operation.note } : {}),
          managed: true
        });
      } else if (input.operation.type === "rename") {
        const manifest = readManifest(input.paths.stateDir);
        const existing = manifest.extraEnv?.[input.operation.fromEnvVar];
        upsertExtraEnvManifest(input.paths.stateDir, input.operation.toEnvVar, {
          ...(input.operation.note !== undefined ? { note: input.operation.note } : existing?.note ? { note: existing.note } : {}),
          managed: true
        });
        removeExtraEnvManifest(input.paths.stateDir, input.operation.fromEnvVar);
      }
    }
  });

  return {
    ok: true,
    affectedKeys: input.operation.type === "rename"
      ? [input.operation.fromEnvVar, input.operation.toEnvVar]
      : [input.operation.envVar],
    backupId: basename(result.backupDir)
  };
}
