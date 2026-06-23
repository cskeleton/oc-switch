import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatModelRef } from "./model-ref";
import type { OpenClawConfig, ProviderPreset } from "./types";

export interface PresetDirs {
  builtinDir: string;
  customDir: string;
}

export interface PresetListEntry {
  id: string;
  name: string;
  source: "builtin" | "custom";
  path: string;
  tags: string[];
}

function readPresetFile(path: string): ProviderPreset | null {
  try {
    const preset = JSON.parse(readFileSync(path, "utf8")) as ProviderPreset;
    if (!preset.id || !preset.name || !preset.provider?.apiKeyEnv) return null;
    return preset;
  } catch {
    return null;
  }
}

function listPresetFiles(dir: string, source: "builtin" | "custom"): PresetListEntry[] {
  if (!existsSync(dir)) return [];
  const entries: PresetListEntry[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    const preset = readPresetFile(path);
    if (!preset) continue;
    entries.push({
      id: preset.id,
      name: preset.name,
      source,
      path,
      tags: preset.tags ?? []
    });
  }
  return entries;
}

export function listPresets(dirs: PresetDirs): PresetListEntry[] {
  const customIds = new Set(listPresetFiles(dirs.customDir, "custom").map((e) => e.id));
  const builtin = listPresetFiles(dirs.builtinDir, "builtin").filter((e) => !customIds.has(e.id));
  const custom = listPresetFiles(dirs.customDir, "custom");
  return [...builtin, ...custom].sort((a, b) => {
    const sourceCmp = a.source.localeCompare(b.source);
    return sourceCmp !== 0 ? sourceCmp : a.id.localeCompare(b.id);
  });
}

export function loadPreset(dirs: PresetDirs, id: string): ProviderPreset {
  const customPath = join(dirs.customDir, `${id}.json`);
  if (existsSync(customPath)) {
    const preset = readPresetFile(customPath);
    if (preset) return preset;
  }
  const builtinPath = join(dirs.builtinDir, `${id}.json`);
  if (existsSync(builtinPath)) {
    const preset = readPresetFile(builtinPath);
    if (preset) return preset;
  }
  throw new Error(`Preset ${id} not found`);
}

export function saveCustomPreset(customDir: string, preset: ProviderPreset): string {
  mkdirSync(customDir, { recursive: true });
  const path = join(customDir, `${preset.id}.json`);
  writeFileSync(path, `${JSON.stringify(preset, null, 2)}\n`);
  return path;
}

export function exportProviderPreset(config: OpenClawConfig, providerId: string): ProviderPreset {
  const provider = config.models?.providers?.[providerId];
  if (!provider) throw new Error(`Provider ${providerId} not found`);

  const apiKeyEnv = provider.apiKey?.id ?? provider.authHeader?.id;
  if (!apiKeyEnv) throw new Error(`Provider ${providerId} has no env key reference`);

  const allowlist = config.agents?.defaults?.models ?? {};
  const models = (provider.models ?? []).map((model) => {
    const ref = formatModelRef(providerId, model.id);
    const alias = allowlist[ref]?.alias;
    return alias ? { ...model, alias } : { ...model };
  });

  return {
    id: providerId,
    name: providerId,
    provider: {
      api: provider.api ?? "openai-completions",
      baseUrl: provider.baseUrl ?? "",
      apiKeyEnv
    },
    models
  };
}

export function defaultPresetDirs(stateDir: string, repoRoot?: string): PresetDirs {
  const builtinDir = repoRoot
    ? join(repoRoot, "presets", "builtin")
    : join(stateDir, "presets", "builtin");
  return {
    builtinDir,
    customDir: join(stateDir, "presets", "custom")
  };
}
