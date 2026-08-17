import { normalizeModelRefForStorage, normalizeProviderId } from "./model-ref";
import type { OpenClawConfig } from "./types";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRefIfValid(ref: unknown): string | undefined {
  if (typeof ref !== "string") return undefined;
  try {
    return normalizeModelRefForStorage(ref.trim());
  } catch {
    return undefined;
  }
}

function normalizeProviderKeys(config: OpenClawConfig): boolean {
  const providers = config.models?.providers;
  if (!providers) return false;

  const normalized: typeof providers = {};
  let changed = false;
  for (const [providerId, provider] of Object.entries(providers)) {
    const normalizedId = normalizeProviderId(providerId);
    if (Object.prototype.hasOwnProperty.call(normalized, normalizedId)) {
      throw new Error(
        `Provider ID ${providerId} conflicts with ${normalizedId} after lowercase normalization; merge the duplicate provider blocks first.`
      );
    }
    normalized[normalizedId] = provider;
    changed ||= normalizedId !== providerId;
  }

  if (changed) config.models!.providers = normalized;
  return changed;
}

function normalizeAllowlistKeys(config: OpenClawConfig): boolean {
  const allowlist = config.agents?.defaults?.models;
  if (!allowlist) return false;

  const normalized: typeof allowlist = {};
  let changed = false;
  for (const [ref, entry] of Object.entries(allowlist)) {
    const normalizedRef = normalizeRefIfValid(ref) ?? ref;
    const hasExisting = Object.prototype.hasOwnProperty.call(normalized, normalizedRef);
    const existing = normalized[normalizedRef];
    if (hasExisting && JSON.stringify(existing) !== JSON.stringify(entry)) {
      throw new Error(
        `Allowlist refs ${ref} and ${normalizedRef} conflict after lowercase Provider ID normalization.`
      );
    }
    if (!hasExisting) normalized[normalizedRef] = entry;
    changed ||= normalizedRef !== ref;
  }

  if (changed) config.agents!.defaults!.models = normalized;
  return changed;
}

function normalizePrimaryRefs(config: OpenClawConfig): boolean {
  const value = config.agents?.defaults?.model;
  if (typeof value === "string") {
    const normalized = normalizeRefIfValid(value);
    if (normalized !== undefined && normalized !== value) {
      config.agents!.defaults!.model = normalized;
      return true;
    }
    return false;
  }
  if (!isRecord(value)) return false;

  let changed = false;
  const primary = normalizeRefIfValid(value.primary);
  if (primary !== undefined && primary !== value.primary) {
    value.primary = primary;
    changed = true;
  }
  if (Array.isArray(value.fallbacks)) {
    value.fallbacks = value.fallbacks.map((ref) => {
      const normalized = normalizeRefIfValid(ref);
      if (normalized !== undefined && normalized !== ref) changed = true;
      return normalized ?? ref;
    });
  }
  return changed;
}

/** 将 OpenClaw 配置转换为 Provider ID 小写、model ID 原样的持久化形式。 */
export function normalizeConfigForStorage<T extends OpenClawConfig>(config: T): { config: T; changed: boolean } {
  const providerKeysChanged = normalizeProviderKeys(config);
  const allowlistKeysChanged = normalizeAllowlistKeys(config);
  const primaryRefsChanged = normalizePrimaryRefs(config);
  const changed = providerKeysChanged || allowlistKeysChanged || primaryRefsChanged;
  return { config, changed };
}
