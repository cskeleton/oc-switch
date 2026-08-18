import { describe, expect, test } from "bun:test";
import { assertProviderModelCapacity, MAX_PROVIDER_MODELS } from "../src/provider-model-limits";
import type { OpenClawProvider } from "../src/types";

describe("assertProviderModelCapacity", () => {
  test("exports MAX_PROVIDER_MODELS = 100", () => {
    expect(MAX_PROVIDER_MODELS).toBe(100);
  });

  test("allows adding when under cap", () => {
    const provider = { models: Array.from({ length: MAX_PROVIDER_MODELS - 1 }, (_, i) => ({ id: `m${i}`, name: `M${i}` })) } as OpenClawProvider;
    expect(() => assertProviderModelCapacity(provider, 1)).not.toThrow();
  });

  test("rejects when current + adding exceeds cap", () => {
    const provider = { models: Array.from({ length: MAX_PROVIDER_MODELS }, (_, i) => ({ id: `m${i}`, name: `M${i}` })) } as OpenClawProvider;
    expect(() => assertProviderModelCapacity(provider, 1)).toThrow(/limit|上限|capacity/i);
  });

  test("rejects addingCount 0? no — zero is no-op allow", () => {
    const provider = { models: Array.from({ length: MAX_PROVIDER_MODELS }, (_, i) => ({ id: `m${i}`, name: `M${i}` })) } as OpenClawProvider;
    expect(() => assertProviderModelCapacity(provider, 0)).not.toThrow();
  });
});
