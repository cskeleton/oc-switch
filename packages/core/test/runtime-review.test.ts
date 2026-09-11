import { describe, expect, test } from "bun:test";
import { buildModelInventory } from "../src/model-inventory";
import { discoverRuntimeModelCatalog, type RuntimeModelSnapshot } from "../src/runtime-model-catalog";
import { enableModel, setPrimaryModel } from "../src/model-operations";
import { materializeRuntimeModel, removeModelPolicyExactRef } from "../src/model-reconciliation";
import { discoverPluginCatalog } from "../src/plugin-catalog";
import type { OpenClawConfig } from "../src/types";

const runtime = (overrides: Partial<RuntimeModelSnapshot> = {}): RuntimeModelSnapshot => ({
  fallbackRefs: [], allowedRefs: [], configuredModels: [], allModels: [],
  completeness: { status: true, configuredList: true, allList: true },
  diagnostics: [], capturedAt: "2026-09-10T00:00:00Z", ...overrides
});
const available = (ref: string) => ({ ref, available: true, tags: [] });
const config = (allow?: unknown[]): OpenClawConfig => ({
  models: { providers: { p: { models: [{ id: "one" }, { id: "two" }] } } },
  agents: { defaults: { models: { "p/one": {} }, ...(allow ? { modelPolicy: { allow } } : {}) } }
});

describe("runtime review regressions", () => {
  test("legacy and restricted unselected models can be enabled", () => {
    for (const cfg of [config(), config(["p/one"])]) {
      const inv = buildModelInventory({ config: cfg, runtime: runtime({ allModels: [available("p/two")] }) });
      expect(inv.models.find(m => m.ref === "p/two")!.capabilities.canTogglePolicy).toBe(true);
    }
  });
  test("primary and fallback protection blocks disabling, not enabling a missing policy selection", () => {
    for (const cfg of [config(), config(["p/one"])]) {
      cfg.agents!.defaults!.model = { primary: "p/two", fallbacks: ["p/fallback"] };
      const snap = runtime({ allModels: [available("p/two"), available("p/fallback")] });
      const before = buildModelInventory({ config: cfg, runtime: snap });
      for (const ref of ["p/two", "p/fallback"]) {
        const row = before.models.find(m => m.ref === ref)!;
        expect(row.policyAllowed).toBe(false);
        expect(row.capabilities.canTogglePolicy).toBe(true);
        enableModel(cfg, ref, undefined, [], row);
      }
      const after = buildModelInventory({ config: cfg, runtime: snap });
      for (const ref of ["p/two", "p/fallback"]) {
        expect(after.models.find(m => m.ref === ref)).toMatchObject({ policyAllowed: true, capabilities: { canTogglePolicy: false } });
      }
    }
  });
  test("last exact and unknown policy rules never advertise removal", () => {
    for (const snap of [runtime({ allModels: [available("p/one")] }), runtime({ completeness: { status: false, configuredList: false, allList: false } })]) {
      const inv = buildModelInventory({ config: config(["p/one"]), runtime: snap });
      expect(inv.policyRules[0]!.removable).toBe(false);
      expect(inv.models.find(m => m.ref === "p/one")!.capabilities.canRemovePolicyExactRef).toBe(false);
    }
  });
  test("unrestricted and wildcard never select reference-only missing models", () => {
    for (const allow of [[], ["ghost/*"]]) {
      const cfg = config(allow);
      cfg.agents!.defaults!.models!["ghost/missing"] = {};
      const inv = buildModelInventory({ config: cfg, runtime: runtime() });
      const row = inv.models.find(m => m.ref === "ghost/missing")!;
      expect(row.policyAllowed).toBe(false);
      expect(row.referenceSources).not.toContain("policy-wildcard");
      if (allow.length) expect(inv.policyRules[0]!.matchedModelCount).toBe(0);
    }
  });
  test("runtime descriptor-only models retain plugin ownership even when disabled", () => {
    const inv = buildModelInventory({ config: {}, plugins: [{ id: "plug", origin: "npm", enabled: false, providerIds: ["p"], nonModelCapabilities: [] }], runtime: runtime({ allModels: [{ ref: "p/live", tags: [] }] }) });
    expect(inv.providers[0]).toMatchObject({ providerId: "p", pluginIds: ["plug"], pluginEnabled: false });
    expect(inv.models[0]).toMatchObject({ pluginIds: ["plug"], availability: "unavailable", availabilityReasons: ["plugin-disabled"] });
  });
  test("runtime rows do not assign a manifest model to unrelated plugins sharing its provider", () => {
    const inv = buildModelInventory({ config: {}, pluginProviders: [
      { pluginId: "disabled-owner", providerId: "p", origin: "npm", enabled: false, models: [{ id: "one" }], apiKeyEnvVars: [] },
      { pluginId: "other-plugin", providerId: "p", origin: "npm", enabled: true, models: [{ id: "two" }], apiKeyEnvVars: [] }
    ], runtime: runtime({ allModels: [{ ref: "p/one", tags: [] }, available("p/two")] }) });
    expect(inv.models.find(m => m.ref === "p/one")).toMatchObject({
      pluginIds: ["disabled-owner"], availability: "unavailable", availabilityReasons: ["plugin-disabled"]
    });
    expect(inv.models.find(m => m.ref === "p/two")!.pluginIds).toEqual(["other-plugin"]);
  });
  test("current list negative wins over all-list positive; no invented rejection reason", () => {
    const inv = buildModelInventory({ config: config(), runtime: runtime({ configuredModels: [{ ref: "p/one", available: false, tags: [] }], allModels: [available("p/one")] }) });
    expect(inv.models.find(m => m.ref === "p/one")).toMatchObject({ availability: "unavailable", availabilityReasons: [] });
  });
  test("unmarked runtime rows are unknown and empty provider is not available", () => {
    const inv = buildModelInventory({ config: { models: { providers: { empty: { models: [] } } } }, runtime: runtime({ configuredModels: [{ ref: "p/one", tags: [] }] }) });
    expect(inv.models[0]!.availability).toBe("unknown");
    expect(inv.providers.find(p => p.providerId === "empty")!.availability).not.toBe("available");
  });
  test("disabled provider cannot enable, set primary or materialize", () => {
    const inv = buildModelInventory({ config: config(["p/one"]), disabledProviderIds: ["p"], runtime: runtime({ allModels: [available("p/one"), available("p/live")] }) });
    for (const row of inv.models) {
      expect(row.capabilities.canTogglePolicy).toBe(false);
      expect(row.capabilities.canSetPrimary).toBe(false);
      expect(row.capabilities.canMaterializeConfigModel).toBe(false);
    }
  });
  test("malformed catalog row makes source incomplete while preserving good rows", () => {
    const snap = discoverRuntimeModelCatalog({ runCommand: (_cmd, args) => ({ status: 0, timedOut: false, stdout: args[0] === "--version" ? "OpenClaw 2026.9.3" : JSON.stringify(args[1] === "status" ? { allowed: ["p/one"] } : { models: [{ key: "p/one", available: true }, { key: 99 }] }) }) });
    expect(snap.completeness.configuredList).toBe(false);
    expect(snap.completeness.allList).toBe(false);
    expect(snap.configuredModels[0]!.ref).toBe("p/one");
    expect(snap.diagnostics.some(d => d.code === "invalid-shape")).toBe(true);
  });
  test("OpenClaw nullable availability preserves the row without invalidating the entire catalog", () => {
    const snap = discoverRuntimeModelCatalog({ runCommand: (_cmd, args) => ({
      status: 0, timedOut: false,
      stdout: args[0] === "--version" ? "OpenClaw 2026.9.3" : JSON.stringify(args[1] === "status"
        ? { allowed: ["p/one", "ghost/missing"] }
        : { models: [
          { key: "p/one", available: true, missing: false },
          { key: "runtime/unprobed", available: null, missing: false }
        ] })
    }) });
    expect(snap.completeness).toEqual({ status: true, configuredList: true, allList: true });
    expect(snap.diagnostics).toEqual([]);
    const inv = buildModelInventory({ config: config(["p/one", "ghost/missing"]), runtime: snap });
    expect(inv.models.find(m => m.ref === "p/one")!.availability).toBe("available");
    expect(inv.models.find(m => m.ref === "runtime/unprobed")).toMatchObject({
      catalogSources: ["openclaw-runtime"], availability: "unknown"
    });
    expect(inv.models.find(m => m.ref === "ghost/missing")!.availability).toBe("unavailable");
  });
  test("runner exception is isolated to its command and never echoes error text", () => {
    const snap = discoverRuntimeModelCatalog({ runCommand: (_cmd, args) => {
      if (args[1] === "status") throw new Error("SECRET failure");
      return { status: 0, timedOut: false, stdout: args[0] === "--version" ? "OpenClaw 2026.9.3" : JSON.stringify({ models: [] }) };
    } });
    expect(snap.completeness).toEqual({ status: false, configuredList: true, allList: true });
    expect(JSON.stringify(snap)).not.toContain("SECRET");
  });
  test("missing placeholders are references, not catalog or wildcard matches", () => {
    for (const allow of [[], ["ghost/*", "p/one"]]) {
      const cfg = config(allow);
      cfg.agents!.defaults!.models!["ghost/missing"] = {};
      const inv = buildModelInventory({ config: cfg, runtime: runtime({
        configuredModels: [{ ref: "ghost/missing", available: false, missing: true, tags: ["missing"] }]
      }) });
      expect(inv.models.find(m => m.ref === "ghost/missing")).toMatchObject({
        catalogSources: [], referenceSources: ["legacy-metadata"], policyAllowed: false
      });
      expect(inv.providers.some(p => p.providerId === "ghost")).toBe(false);
      if (allow.length) expect(inv.policyRules.find(r => r.value === "ghost/*")!.matchedModelCount).toBe(0);
    }
  });
  test("available config provider does not acquire a plugin-disabled availability reason", () => {
    const inv = buildModelInventory({ config: config(),
      plugins: [{ id: "plug", origin: "npm", enabled: false, providerIds: ["p"], nonModelCapabilities: [] }],
      runtime: runtime({ configuredModels: [available("p/one"), available("p/two")] })
    });
    expect(inv.providers[0]).toMatchObject({ pluginEnabled: false, availability: "available", availabilityReasons: [] });
  });
  test("explicit unknown or unavailable evidence cannot fall back to the static catalog", () => {
    for (const availability of ["unknown", "unavailable"] as const) {
      const cfg = config();
      const before = structuredClone(cfg);
      const row = buildModelInventory({ config: cfg, runtime: runtime() }).models[0]!;
      row.availability = availability;
      expect(() => enableModel(cfg, row.ref, undefined, [], row)).toThrow(/not confirmed available/);
      expect(() => setPrimaryModel(cfg, row.ref, [], row)).toThrow(/not confirmed available/);
      expect(cfg).toEqual(before);
    }
  });
  test("runtime evidence must belong to the exact requested model", () => {
    const cfg = config();
    const row = buildModelInventory({ config: cfg, runtime: runtime({ allModels: [available("p/two")] }) }).models.find(m => m.ref === "p/two")!;
    expect(() => enableModel(cfg, "p/one", undefined, [], row)).toThrow(/does not match/);
    expect(() => setPrimaryModel(cfg, "p/one", [], row)).toThrow(/does not match/);
  });
  test("materialize cannot bypass a disabled provider capability", () => {
    const cfg = config();
    const before = structuredClone(cfg);
    const row = buildModelInventory({ config: cfg, disabledProviderIds: ["p"], runtime: runtime({ allModels: [available("p/live")] }) }).models.find(m => m.ref === "p/live")!;
    expect(() => materializeRuntimeModel(cfg, row, { id: "live", enabled: false })).toThrow(/not permitted/);
    expect(cfg).toEqual(before);
  });
  test("materialize reports distinct primary and fallback blockers", () => {
    for (const primary of [true, false]) {
      const cfg = config(["p/one", "p/live"]);
      cfg.agents!.defaults!.model = { primary: primary ? "p/live" : "p/one", fallbacks: primary ? [] : ["p/live"] };
      const row = buildModelInventory({ config: cfg, runtime: runtime({ allModels: [available("p/live")] }) }).models.find(m => m.ref === "p/live")!;
      let error: unknown;
      try { materializeRuntimeModel(cfg, row, { id: "live", enabled: false }); } catch (caught) { error = caught; }
      expect(error).toMatchObject({ code: primary ? "primary-model-referenced" : "fallback-referenced" });
    }
  });
  test("optional metadata cleanup uses model identity even when provider config is absent", () => {
    const cfg = config(["Ghost/missing", "p/one"]);
    cfg.agents!.defaults!.models!["GHOST/missing"] = { alias: "kept-unless-selected" };
    cfg.agents!.defaults!.models!["not-a-ref"] = {};
    const result = removeModelPolicyExactRef(cfg, "ghost/missing", { removeMetadata: true });
    expect(result.config.agents!.defaults!.models!["GHOST/missing"]).toBeUndefined();
    expect(result.config.agents!.defaults!.models!["not-a-ref"]).toEqual({});
    expect(cfg.agents!.defaults!.models!["GHOST/missing"]).toBeDefined();
  });
  test("malformed plugin selection facts yield diagnostics, never an implicitly enabled plugin", () => {
    const result = discoverPluginCatalog({
      runCommand: () => ({ status: 0, timedOut: false, stdout: JSON.stringify({ plugins: [
        { id: "bad-state", rootDir: "/unused", providerIds: ["p"], enabled: "SECRET" },
        { id: "bad-providers", rootDir: "/unused", providerIds: { p: true }, enabled: true },
        { id: "good", rootDir: "/unused", providerIds: ["p"], enabled: false }
      ] }) }),
      readTextFile: () => "{}"
    });
    expect(result.plugins.map(p => p.id)).toEqual(["good"]);
    expect(result.diagnostics.length).toBe(2);
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
  test("plugin impact covers the actual OpenClaw names/counts and provider capability fields", () => {
    const result = discoverPluginCatalog({
      runCommand: () => ({ status: 0, timedOut: false, stdout: JSON.stringify({ plugins: [{
        id: "multi-capability", rootDir: "/unused", providerIds: ["p"], enabled: true,
        channelIds: ["chat"], toolNames: ["search-tool"], hookCount: 2,
        cliBackendIds: ["cli"], gatewayDiscoveryServiceIds: ["discovery"], speechProviderIds: ["speech"],
        realtimeTranscriptionProviderIds: ["transcription"], realtimeVoiceProviderIds: ["voice"],
        mediaUnderstandingProviderIds: ["vision"], imageGenerationProviderIds: ["image"],
        videoGenerationProviderIds: ["video"], musicGenerationProviderIds: ["music"],
        webSearchProviderIds: ["web-search"], webFetchProviderIds: ["web-fetch"], embeddingProviderIds: ["embed"]
      }] }) }), readTextFile: () => "{}"
    });
    expect(result.plugins[0]!.nonModelCapabilities).toEqual([
      "channels", "tools", "hooks", "commands", "services", "speech", "realtime", "media", "search", "other-contracts"
    ]);
  });
});
