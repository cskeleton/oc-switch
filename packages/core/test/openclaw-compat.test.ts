import { describe, expect, test } from "bun:test";
import {
  defaultModelName,
  ensureModelName,
  formatEnvRefForOpenClaw,
  isValidOpenClawEnvRef,
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
    expect(formatEnvRefForOpenClaw("NVIDIA_API_KEY")).toBe("${NVIDIA_API_KEY}");
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

  test("repairs legacy env refs and missing model names", () => {
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
    const anthropicProxy = result.config.models?.providers?.anthropicProxy;
    expect(nvidia?.apiKey).toBe("${NVIDIA_API_KEY}");
    expect(nvidia?.models?.[0]?.name).toBe("Vendor Model A");
    expect(anthropicProxy?.apiKey).toBe("${ANTHROPIC_API_KEY}");
    expect(anthropicProxy?.authHeader).toBe(true);
  });

  test("does not rewrite canonical SecretRef objects", () => {
    const config = {
      models: {
        providers: {
          vaultBacked: {
            apiKey: { source: "env" as const, provider: "custom-env", id: "NVIDIA_API_KEY" },
            models: [{ id: "vendor/model-a", name: "Vendor Model A" }]
          }
        }
      }
    } as OpenClawConfig;

    const result = repairOpenClawCompatibility(config);
    expect(result.changed).toBe(false);
    expect(result.config.models?.providers?.vaultBacked?.apiKey).toEqual({
      source: "env",
      provider: "custom-env",
      id: "NVIDIA_API_KEY"
    });
  });

  test("repairs legacy env refs whose id is wrapped in ${VAR}", () => {
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
    expect(result.changed).toBe(true);
    expect(result.config.models?.providers?.deepseek?.apiKey).toBe("${DEEPSEEK_API_KEY}");
  });
});
