import type { OcSwitchManifest } from "./manifest-manager";
import type { OpenClawConfig } from "./types";

const START = "# oc-switch:start";
const END = "# oc-switch:end";

export interface ProviderEnvRef {
  providerId: string;
  envVar: string;
}

export interface EnvVariableSummary {
  envVar: string;
  present: boolean;
  managed: boolean;
  providerRef: boolean;
  providerIds: string[];
  extraManaged: boolean;
  orphan: boolean;
  missing: boolean;
  duplicate: boolean;
  complex: boolean;
  note?: string;
  updatedAt?: string;
}

export interface EnvInspection {
  variables: EnvVariableSummary[];
  warnings: string[];
}

interface ParsedEnvLine {
  envVar: string;
  managed: boolean;
  complex: boolean;
}

function parseEnvLine(line: string, managed: boolean): ParsedEnvLine | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return undefined;
  const exportPrefix = trimmed.startsWith("export ");
  const normalized = exportPrefix ? trimmed.slice("export ".length).trimStart() : trimmed;
  const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (!match?.[1]) return undefined;
  const rawValue = match[2] ?? "";
  const complex = exportPrefix ||
    /\s+#/.test(rawValue) ||
    rawValue.includes("${") ||
    ((rawValue.startsWith("\"") && rawValue.endsWith("\"")) || (rawValue.startsWith("'") && rawValue.endsWith("'")));
  return { envVar: match[1], managed, complex };
}

export function listProviderEnvRefs(config: OpenClawConfig): ProviderEnvRef[] {
  return Object.entries(config.models?.providers ?? {})
    .flatMap(([providerId, provider]) => {
      const envVar = provider.apiKey?.id ?? provider.authHeader?.id;
      return envVar ? [{ providerId, envVar }] : [];
    })
    .sort((a, b) => a.envVar.localeCompare(b.envVar) || a.providerId.localeCompare(b.providerId));
}

export function inspectEnvFile(input: {
  content: string;
  providerRefs: ProviderEnvRef[];
  manifest: OcSwitchManifest;
}): EnvInspection {
  const lines = input.content.length ? input.content.split(/\n/) : [];
  const startIndex = lines.indexOf(START);
  const endIndex = lines.indexOf(END);
  const hasBlock = startIndex >= 0 && endIndex > startIndex;
  const parsed: ParsedEnvLine[] = [];

  lines.forEach((line, index) => {
    const managed = hasBlock && index > startIndex && index < endIndex;
    const parsedLine = parseEnvLine(line, managed);
    if (parsedLine) parsed.push(parsedLine);
  });

  const byEnv = new Map<string, ParsedEnvLine[]>();
  for (const item of parsed) {
    byEnv.set(item.envVar, [...(byEnv.get(item.envVar) ?? []), item]);
  }

  const providerRefs = new Map<string, string[]>();
  for (const ref of input.providerRefs) {
    providerRefs.set(ref.envVar, [...(providerRefs.get(ref.envVar) ?? []), ref.providerId]);
  }

  const allKeys = new Set<string>([
    ...byEnv.keys(),
    ...providerRefs.keys(),
    ...Object.values(input.manifest.providers).map((entry) => entry.envVar),
    ...Object.keys(input.manifest.extraEnv ?? {})
  ]);

  const variables = Array.from(allKeys).sort().map((envVar): EnvVariableSummary => {
    const entries = byEnv.get(envVar) ?? [];
    const extra = input.manifest.extraEnv?.[envVar];
    const orphan = Object.values(input.manifest.providers).some((entry) => entry.envVar === envVar && entry.orphan);
    const providerIds = providerRefs.get(envVar) ?? [];
    return {
      envVar,
      present: entries.length > 0,
      managed: entries.some((entry) => entry.managed),
      providerRef: providerIds.length > 0,
      providerIds,
      extraManaged: Boolean(extra),
      orphan,
      missing: entries.length === 0 && providerIds.length > 0,
      duplicate: entries.length > 1,
      complex: entries.some((entry) => entry.complex),
      ...(extra?.note ? { note: extra.note } : {}),
      ...(extra?.updatedAt ? { updatedAt: extra.updatedAt } : {})
    };
  });

  const warnings = variables
    .filter((item) => item.duplicate || item.complex)
    .map((item) => `${item.envVar} requires confirmation before migration`);

  return { variables, warnings };
}
