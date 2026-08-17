import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createBackup } from "./backup-manager";
import { removeManagedEnvKeys } from "./env-manager";
import { readJsonState, writeJsonState } from "./json-state-store";
import { normalizeProviderId } from "./model-ref";
import type { OcSwitchPaths } from "./paths";

export interface ManifestProviderMetadata {
  displayName?: string;
  notes?: string;
  websiteUrl?: string;
  isFullUrl?: boolean;
}

export interface ManifestProviderEntry extends ManifestProviderMetadata {
  providerId: string;
  envVar: string;
  createdAt: string;
  updatedAt: string;
  orphan: boolean;
}

export interface ManifestExtraEnvMetadata {
  note?: string;
  managed?: boolean;
}

export interface ManifestExtraEnvEntry extends ManifestExtraEnvMetadata {
  envVar: string;
  createdAt: string;
  updatedAt: string;
}

export interface OcSwitchManifest {
  providers: Record<string, ManifestProviderEntry>;
  extraEnv?: Record<string, ManifestExtraEnvEntry>;
}

export const MANIFEST_FILE = "manifest.json";

export function readManifest(stateDir: string): OcSwitchManifest {
  return readJsonState({
    stateDir,
    filename: MANIFEST_FILE,
    fallback: () => ({ providers: {}, extraEnv: {} }),
    invalidJson: "throw",
    normalize(value) {
      const parsed = value as Partial<OcSwitchManifest>;
      const providers: Record<string, ManifestProviderEntry> = {};
      for (const [key, rawEntry] of Object.entries(parsed.providers ?? {})) {
        const providerId = normalizeProviderId(rawEntry.providerId || key);
        if (Object.prototype.hasOwnProperty.call(providers, providerId)) {
          throw new Error(`Manifest provider entries ${key} and ${providerId} conflict after lowercase normalization.`);
        }
        providers[providerId] = { ...rawEntry, providerId };
      }
      return { providers, extraEnv: parsed.extraEnv ?? {} };
    }
  });
}

export function writeManifest(stateDir: string, manifest: OcSwitchManifest): void {
  const providers: Record<string, ManifestProviderEntry> = {};
  for (const [key, entry] of Object.entries(manifest.providers)) {
    const providerId = normalizeProviderId(entry.providerId || key);
    if (Object.prototype.hasOwnProperty.call(providers, providerId)) {
      throw new Error(`Manifest provider entries ${key} and ${providerId} conflict after lowercase normalization.`);
    }
    providers[providerId] = { ...entry, providerId };
  }
  writeJsonState({
    stateDir,
    filename: MANIFEST_FILE,
    value: { ...manifest, providers }
  });
}

export function upsertExtraEnvManifest(
  stateDir: string,
  envVar: string,
  metadata: ManifestExtraEnvMetadata = {},
  now = new Date().toISOString()
): void {
  const manifest = readManifest(stateDir);
  const existing = manifest.extraEnv?.[envVar];
  manifest.extraEnv = {
    ...(manifest.extraEnv ?? {}),
    [envVar]: {
      ...existing,
      ...metadata,
      envVar,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
  };
  writeManifest(stateDir, manifest);
}

export function removeExtraEnvManifest(stateDir: string, envVar: string): void {
  const manifest = readManifest(stateDir);
  if (!manifest.extraEnv?.[envVar]) return;
  delete manifest.extraEnv[envVar];
  writeManifest(stateDir, manifest);
}

export function upsertProviderEnvManifest(
  stateDir: string,
  providerId: string,
  envVar: string,
  now = new Date().toISOString(),
  metadata: ManifestProviderMetadata = {}
): void {
  const manifest = readManifest(stateDir);
  const normalizedProviderId = normalizeProviderId(providerId);
  const existing = manifest.providers[normalizedProviderId];
  manifest.providers[normalizedProviderId] = {
    ...existing,
    ...metadata,
    providerId: normalizedProviderId,
    envVar,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    orphan: false
  };
  writeManifest(stateDir, manifest);
}

export function markProviderEnvOrphan(
  stateDir: string,
  providerId: string,
  envVar: string,
  now = new Date().toISOString()
): void {
  const manifest = readManifest(stateDir);
  const normalizedProviderId = normalizeProviderId(providerId);
  const existing = manifest.providers[normalizedProviderId];
  manifest.providers[normalizedProviderId] = {
    ...existing,
    providerId: normalizedProviderId,
    envVar,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    orphan: true
  };
  writeManifest(stateDir, manifest);
}

export function listOrphanEnvKeys(stateDir: string): string[] {
  const manifest = readManifest(stateDir);
  return Array.from(new Set(
    Object.values(manifest.providers)
      .filter((entry) => entry.orphan)
      .map((entry) => entry.envVar)
  )).sort();
}

export function removeOrphanEnvKeysFromManifest(stateDir: string, envKeys: string[]): void {
  const removeSet = new Set(envKeys);
  if (removeSet.size === 0) return;
  const manifest = readManifest(stateDir);
  for (const [providerId, entry] of Object.entries(manifest.providers)) {
    if (entry.orphan && removeSet.has(entry.envVar)) {
      delete manifest.providers[providerId];
    }
  }
  writeManifest(stateDir, manifest);
}

export interface CleanupOrphanEnvKeysResult {
  removedKeys: string[];
  backupDir?: string;
}

function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function cleanupOrphanEnvKeys(paths: OcSwitchPaths): CleanupOrphanEnvKeysResult {
  const orphanKeys = listOrphanEnvKeys(paths.stateDir);
  if (orphanKeys.length === 0) return { removedKeys: [] };

  const beforeEnv = existsSync(paths.envPath) ? readFileSync(paths.envPath, "utf8") : "";
  const envResult = removeManagedEnvKeys(beforeEnv, orphanKeys);
  const envChanged = envResult.changedKeys.length > 0;
  let backupDir: string | undefined;

  if (envChanged) {
    backupDir = createBackup({
      stateDir: paths.stateDir,
      openclawPath: paths.openclawPath,
      envPath: paths.envPath,
      reason: `cleanup orphan env keys ${orphanKeys.join(",")}`,
      beforeHash: fileSha256(paths.openclawPath)
    });
    mkdirSync(dirname(paths.envPath), { recursive: true });
    const envTmp = `${paths.envPath}.tmp`;
    writeFileSync(envTmp, envResult.content);
    renameSync(envTmp, paths.envPath);
  }

  removeOrphanEnvKeysFromManifest(paths.stateDir, orphanKeys);
  return {
    removedKeys: orphanKeys,
    ...(backupDir ? { backupDir } : {})
  };
}
