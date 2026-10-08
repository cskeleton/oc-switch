import { describe, expect, test } from "bun:test";
import { buildModelConfigSnapshot, buildPluginExtensionsSnapshot } from "../src/model-config-snapshot";
import { buildModelPolicyRevision } from "../src/model-policy-edit";
import type { OpenClawConfig } from "../src/types";
import type { PluginCatalogResult } from "../src/plugin-catalog";
import sample from "./fixtures/openclaw.sample.json";

function configFixture(): OpenClawConfig {
  return structuredClone(sample) as OpenClawConfig;
}

describe("local model config snapshot", () => {
  test("projects local policy/key facts without runtime fields or credential values", () => {
    const config = configFixture();
    config.agents!.defaults!.modelPolicy = { allow: ["nvidia/*", "DeepSeek/deepseek-chat", "minimax-portal/MiniMax-M3"] };
    config.agents!.defaults!.models!["nvidia/missing"] = { alias: "leftover" };
    const before = JSON.stringify(config);
    const result = buildModelConfigSnapshot({
      config,
      envContent: "# oc-switch:start\nNVIDIA_API_KEY=fixture-value-not-for-response\n# oc-switch:end\n",
      capturedAt: "2026-10-08T00:00:00.000Z"
    });
    expect(result.schemaVersion).toBe(1);
    expect(result.capturedAt).toBe("2026-10-08T00:00:00.000Z");
    expect(result.policyMode).toBe("restricted");
    expect(result.policyRevision).toBe(buildModelPolicyRevision(config));
    expect(result.status.providerCount).toBe(3);
    expect(result.status.providerModelCount).toBe(4);
    expect(result.providers.find(provider => provider.id === "nvidia")).toMatchObject({
      source: "config", apiKeyEnv: "NVIDIA_API_KEY", apiKeyEnvManaged: true, apiKeyEnvStatus: "managed"
    });
    const local = result.models.find(model => model.ref === "nvidia/z-ai/glm5.1")!;
    expect(local.catalogConfigured).toBe(true);
    expect(local.capabilities).toMatchObject({ canEditCatalogEntry: true, canRemoveCatalogEntry: true, canTogglePolicy: false });
    const metadataOnly = result.models.find(model => model.ref === "nvidia/missing")!;
    expect(metadataOnly.catalogConfigured).toBe(false);
    expect(Object.values(metadataOnly.capabilities).every(value => value === false)).toBe(true);
    expect(local).not.toHaveProperty("availability");
    expect(local).not.toHaveProperty("pickerVisible");
    expect(local).not.toHaveProperty("needsAttention");
    expect(result.policyRules.every(rule => !("matchedModelCount" in rule) && !("unavailableModelCount" in rule))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fixture-value-not-for-response");
    expect(JSON.stringify(config)).toBe(before);
  });

  test("primary/fallback, provider disable and last restricted rule protect static controls", () => {
    const config = configFixture();
    config.agents!.defaults!.model = { primary: "minimax-portal/MiniMax-M3", fallbacks: ["DeepSeek/deepseek-chat"] };
    config.agents!.defaults!.modelPolicy = { allow: ["DeepSeek/deepseek-chat", "minimax-portal/MiniMax-M3", "nvidia/z-ai/glm5.1"] };
    const result = buildModelConfigSnapshot({ config, disabledProviderIds: ["NVIDIA"] });
    expect(result.models.find(model => model.isPrimary)!.capabilities).toMatchObject({ canSetPrimary: false, canTogglePolicy: false, canRemoveCatalogEntry: false });
    expect(result.models.find(model => model.ref === "DeepSeek/deepseek-chat")!.capabilities).toMatchObject({ canTogglePolicy: false, canRemoveCatalogEntry: false });
    expect(result.models.find(model => model.ref === "nvidia/z-ai/glm5.1")!.capabilities).toMatchObject({ canSetPrimary: false, canTogglePolicy: false });
    expect(result).not.toHaveProperty("fallbacks");
    expect(result).not.toHaveProperty("fallbackRefs");

    config.agents!.defaults!.modelPolicy.allow = ["nvidia/z-ai/glm5.1"];
    expect(buildModelConfigSnapshot({ config }).models.find(model => model.ref === "nvidia/z-ai/glm5.1")!.capabilities.canTogglePolicy).toBe(false);
  });

  test("keeps policy absence/empty distinct and does not reveal invalid policy values", () => {
    const config = configFixture();
    expect(buildModelConfigSnapshot({ config }).policyMode).toBe("legacy");
    config.agents!.defaults!.modelPolicy = { allow: [] };
    const unrestricted = buildModelConfigSnapshot({ config });
    expect(unrestricted.policyMode).toBe("unrestricted");
    expect(unrestricted.policyRules).toEqual([]);
    expect(unrestricted.models.every(model => !model.capabilities.canTogglePolicy)).toBe(true);
    config.agents!.defaults!.modelPolicy.allow = ["nvidia/*", { secret: "invalid-policy-sensitive-data" }] as unknown as string[];
    const invalid = buildModelConfigSnapshot({ config });
    expect(invalid.policyRules.find(rule => rule.kind === "invalid")).toEqual({ value: "", kind: "invalid", invalidIndex: 1, removable: false, editable: false });
    expect(JSON.stringify(invalid)).not.toContain("invalid-policy-sensitive-data");
  });

  test("extensions return public manifest fields and drop unexpected CLI fields", () => {
    const catalog: PluginCatalogResult = {
      providers: [{ pluginId: "plugin", providerId: "plugin-provider", origin: "bundled", enabled: true,
        apiKeyEnvVars: ["PLUGIN_API_KEY"], models: [{ id: "model", reasoning: true, input: ["text"] }] }],
      plugins: [{ id: "plugin", name: "Plugin", origin: "bundled", enabled: true, providerIds: ["plugin-provider"], nonModelCapabilities: ["speech"] }],
      diagnostics: ["fixture diagnostic"]
    };
    Object.assign(catalog.providers[0]!, { credentials: "private-cli-entry" });
    Object.assign(catalog.providers[0]!.models[0]!, { apiKey: "private-model-entry" });
    Object.assign(catalog.plugins[0]!, { token: "private-plugin-entry" });
    const result = buildPluginExtensionsSnapshot(catalog);
    expect(result.providers[0]).toMatchObject({ providerId: "plugin-provider", apiKeyEnvVars: ["PLUGIN_API_KEY"] });
    expect(result.plugins[0]!.nonModelCapabilities).toEqual(["speech"]);
    expect(result.diagnostics).toEqual(["fixture diagnostic"]);
    expect(JSON.stringify(result)).not.toContain("private-");
  });
});
