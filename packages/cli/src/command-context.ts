import { defaultPresetDirs, getActivePaths, isProviderDisabled, providerEnvVar as coreProviderEnvVar, type FetchImpl, type OpenClawConfig } from "@oc-switch/core";
import JSON5 from "json5";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** monorepo 根目录（自 packages/cli/src 上溯三级） */
export const repoRoot = join(dirname(import.meta.path), "../../..");

function activePaths() {
  return getActivePaths();
}

function readConfig(): OpenClawConfig {
  const paths = activePaths();
  return JSON5.parse(readFileSync(paths.openclawPath, "utf8")) as OpenClawConfig;
}

function readEnvContent(): string | undefined {
  const paths = activePaths();
  return existsSync(paths.envPath) ? readFileSync(paths.envPath, "utf8") : undefined;
}

function assertProviderCanEnable(providerId: string): void {
  const paths = activePaths();
  if (isProviderDisabled(paths.stateDir, providerId)) {
    throw new Error(`Provider ${providerId} is disabled. Restore the provider before enabling models.`);
  }
}

function providerEnvVar(config: OpenClawConfig, providerId: string): string | undefined {
  return coreProviderEnvVar(config.models?.providers?.[providerId]);
}

function presetDirs() {
  const paths = activePaths();
  return defaultPresetDirs(paths.stateDir);
}

function mockSyncFetch(): FetchImpl | undefined {
  const mock = process.env.OC_SWITCH_MOCK_SYNC;
  if (!mock) return undefined;
  const ids = mock.split(",").map((id) => id.trim()).filter(Boolean);
  return async () =>
    new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      headers: { "content-type": "application/json" }
    });
}

function defaultEnvName(providerId: string): string {
  return `${providerId.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase()}_API_KEY`;
}

function parseModelIds(value: string): string[] {
  return value.split(",").map((id) => id.trim()).filter(Boolean);
}

function parseAliasMap(value: string | undefined): Map<string, string> {
  const aliases = new Map<string, string>();
  if (!value) return aliases;
  for (const pair of value.split(",")) {
    const [id, alias] = pair.split(":").map((part) => part.trim());
    if (!id || !alias) throw new Error(`Invalid alias mapping ${pair}`);
    aliases.set(id, alias);
  }
  return aliases;
}

export interface CommandContext {
  activePaths: typeof activePaths;
  readConfig: typeof readConfig;
  readEnvContent: typeof readEnvContent;
  assertProviderCanEnable: typeof assertProviderCanEnable;
  providerEnvVar: typeof providerEnvVar;
  presetDirs: typeof presetDirs;
  mockSyncFetch: typeof mockSyncFetch;
  defaultEnvName: typeof defaultEnvName;
  parseModelIds: typeof parseModelIds;
  parseAliasMap: typeof parseAliasMap;
}

export function createCommandContext(): CommandContext {
  return {
    activePaths,
    readConfig,
    readEnvContent,
    assertProviderCanEnable,
    providerEnvVar,
    presetDirs,
    mockSyncFetch,
    defaultEnvName,
    parseModelIds,
    parseAliasMap
  };
}
