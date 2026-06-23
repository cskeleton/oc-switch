import type { OpenClawConfig } from "./types";

export interface ConfigDiffSummary {
  providersAdded: string[];
  providersRemoved: string[];
  providersChanged: string[];
  modelsEnabled: string[];
  modelsDisabled: string[];
  primaryChanged: { before: string | undefined; after: string | undefined } | null;
}

export function summarizeConfigDiff(before: OpenClawConfig, after: OpenClawConfig): ConfigDiffSummary {
  const beforeProviders = before.models?.providers ?? {};
  const afterProviders = after.models?.providers ?? {};
  const beforeIds = new Set(Object.keys(beforeProviders));
  const afterIds = new Set(Object.keys(afterProviders));

  const providersAdded = [...afterIds].filter((id) => !beforeIds.has(id)).sort();
  const providersRemoved = [...beforeIds].filter((id) => !afterIds.has(id)).sort();
  const providersChanged = [...beforeIds]
    .filter((id) => afterIds.has(id) && JSON.stringify(beforeProviders[id]) !== JSON.stringify(afterProviders[id]))
    .sort();

  const beforeAllowlist = before.agents?.defaults?.models ?? {};
  const afterAllowlist = after.agents?.defaults?.models ?? {};
  const beforeRefs = new Set(Object.keys(beforeAllowlist));
  const afterRefs = new Set(Object.keys(afterAllowlist));

  const modelsEnabled = [...afterRefs].filter((ref) => !beforeRefs.has(ref)).sort();
  const modelsDisabled = [...beforeRefs].filter((ref) => !afterRefs.has(ref)).sort();

  const beforePrimary = before.agents?.defaults?.model;
  const afterPrimary = after.agents?.defaults?.model;
  const primaryChanged = beforePrimary === afterPrimary
    ? null
    : { before: beforePrimary, after: afterPrimary };

  return {
    providersAdded,
    providersRemoved,
    providersChanged,
    modelsEnabled,
    modelsDisabled,
    primaryChanged
  };
}
