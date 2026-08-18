import { describe, expect, test } from "bun:test";
import {
  defaultModelName,
  ensureModelName,
  formatEnvRefForOpenClaw,
  inspectProviderSecretRefMigrations,
  isValidOpenClawEnvRef,
  migrateProviderSecretRefs,
  parseEnvVarName,
  repairOpenClawCompatibility
} from "../src/openclaw-compat";
import type { OpenClawConfig } from "../src/types";

describe("openclaw compatibility helpers", () => {
  test("parses env refs supported by oc-switch and OpenClaw", () => {
    expect(parseEnvVarName("${NVIDIA_API_KEY}")).toBe("NVIDIA_API_KEY");
    expect(parseEnvVarName("$NVIDIA_API_KEY")).toBe("NVIDIA_API_KEY");
    expect(parseEnvVarName({ source: "env", id: "NVIDIA_API_KEY" })).toBe("NVIDIA_API_KEY");
    expect(parseEnvVarName({ source: "env", provider: "default", id: "NVIDIA_API_KEY" })).toBe("NVIDIA_API_KEY");
    expect(parseEnvVarName("sk-live-secret")).toBeUndefined();
    expect(parseEnvVarName("${_BAD}")).toBeUndefined();
  });

  test("formats only OpenClaw-valid env names", () => {
    expect(formatEnvRefForOpenClaw("NVIDIA_API_KEY")).toEqual({
      source: "env",
      provider: "default",
      id: "NVIDIA_API_KEY"
    });
    expect(() => formatEnvRefForOpenClaw("_NVIDIA_API_KEY")).toThrow("env var name");
  });

  test("isValidOpenClawEnvRef detects supported ref shapes", () => {
    expect(isValidOpenClawEnvRef("${NVIDIA_API_KEY}")).toBe(true);
    expect(isValidOpenClawEnvRef({ source: "env", id: "NVIDIA_API_KEY" })).toBe(true);
    expect(isValidOpenClawEnvRef("sk-live-secret")).toBe(false);
  });

  test("fills default model names", () => {
    expect(defaultModelName("deepseek-ai/deepseek-v4-flash")).toBe("Deepseek Ai Deepseek V4 Flash");
    expect(ensureModelName({ id: "MiniMax-M3" }).name).toBe("MiniMax M3");
    expect(ensureModelName({ id: "m", name: "Custom Name" }).name).toBe("Custom Name");
  });

  test("leaves Provider apiKey migration opt-in while repairing authHeader and model names", () => {
    const config = {
      models: {
        providers: {
          nvidia: {
            apiKey: { source: "env" as const, id: "NVIDIA_API_KEY" },
            models: [{ id: "vendor/model-a" }, { id: "model-b", name: "" }]
          },
          anthropicProxy: {
            authHeader: { source: "env" as const, id: "ANTHROPIC_API_KEY" },
            models: [{ id: "claude-proxy" }]
          }
        }
      }
    } as OpenClawConfig;

    const result = repairOpenClawCompatibility(config);
    expect(result.changed).toBe(true);
    const nvidia = result.config.models?.providers?.nvidia;
    const anthropicProxy = result.config.models?.providers?.anthropicproxy;
    expect(nvidia?.apiKey).toEqual({ source: "env", id: "NVIDIA_API_KEY" });
    expect(nvidia?.models?.[0]?.name).toBe("Vendor Model A");
    expect(anthropicProxy?.apiKey).toEqual({ source: "env", provider: "default", id: "ANTHROPIC_API_KEY" });
    expect(anthropicProxy?.authHeader).toBe(true);
  });

  test("repairs Provider ID casing and refs while preserving model ID casing", () => {
    const config = {
      models: {
        providers: {
          DeepSeek: {
            models: [{ id: "DeepSeek-Chat" }]
          }
        }
      },
      agents: {
        defaults: {
          model: "DeepSeek/DeepSeek-Chat",
          models: { "DeepSeek/DeepSeek-Chat": {} }
        }
      }
    } as OpenClawConfig;

    const result = repairOpenClawCompatibility(config);

    expect(result.changed).toBe(true);
    expect(result.config.models?.providers?.deepseek?.models?.[0]?.id).toBe("DeepSeek-Chat");
    expect(result.config.agents?.defaults?.model).toBe("deepseek/DeepSeek-Chat");
    expect(result.config.agents?.defaults?.models?.["deepseek/DeepSeek-Chat"]).toEqual({});
  });

  test("does not rewrite canonical SecretRef objects", () => {
    const config = {
      models: {
        providers: {
          vaultbacked: {
            apiKey: { source: "env" as const, provider: "custom-env", id: "NVIDIA_API_KEY" },
            models: [{ id: "vendor/model-a", name: "Vendor Model A" }]
          }
        }
      }
    } as OpenClawConfig;

    const result = repairOpenClawCompatibility(config);
    expect(result.changed).toBe(false);
    expect(result.config.models?.providers?.vaultbacked?.apiKey).toEqual({
      source: "env",
      provider: "custom-env",
      id: "NVIDIA_API_KEY"
    });
  });

  test("reports only legacy Provider env references as SecretRef migration candidates", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          shorthand: { apiKey: "${SHORTHAND_KEY}" },
          dollar: { apiKey: "$DOLLAR_KEY" },
          legacy: { apiKey: { source: "env", id: "LEGACY_KEY" } },
          canonical: { apiKey: { source: "env", provider: "default", id: "CANONICAL_KEY" } },
          literal: { apiKey: "sk-literal-secret" }
        }
      }
    };

    expect(inspectProviderSecretRefMigrations(config)).toEqual([
      { providerId: "dollar", envVar: "DOLLAR_KEY", currentFormat: "env-shorthand" },
      { providerId: "legacy", envVar: "LEGACY_KEY", currentFormat: "legacy-env-ref" },
      { providerId: "shorthand", envVar: "SHORTHAND_KEY", currentFormat: "env-shorthand" }
    ]);
  });

  test("migrates only the explicitly selected Provider references", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          first: { apiKey: "${FIRST_KEY}" },
          second: { apiKey: "${SECOND_KEY}" }
        }
      }
    };

    const result = migrateProviderSecretRefs(config, ["second"]);

    expect(result.changed).toBe(true);
    expect(result.config.models?.providers?.first?.apiKey).toBe("${FIRST_KEY}");
    expect(result.config.models?.providers?.second?.apiKey).toEqual({
      source: "env",
      provider: "default",
      id: "SECOND_KEY"
    });
  });

  test("does not auto-migrate legacy env refs during compatibility repair", () => {
    const config = {
      models: {
        providers: {
          deepseek: {
            apiKey: { source: "env" as const, id: "${DEEPSEEK_API_KEY}" },
            models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }]
          }
        }
      }
    } as OpenClawConfig;

    const result = repairOpenClawCompatibility(config);
    expect(result.changed).toBe(false);
    expect(result.config.models?.providers?.deepseek?.apiKey).toEqual({
      source: "env",
      id: "${DEEPSEEK_API_KEY}"
    });
  });
});
