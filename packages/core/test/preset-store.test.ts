import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sample from "./fixtures/openclaw.sample.json";
import { exportProviderPreset, listPresets, loadPreset, saveCustomPreset } from "../src/preset-store";
import type { OpenClawConfig, ProviderPreset } from "../src/types";

const tempDirs: string[] = [];

function dirs() {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-preset-"));
  tempDirs.push(dir);
  return {
    builtinDir: join(dir, "builtin"),
    customDir: join(dir, "custom")
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("PresetStore", () => {
  test("lists builtin and custom presets", () => {
    const d = dirs();
    const preset: ProviderPreset = {
      id: "custom",
      name: "Custom",
      provider: { api: "openai-completions", baseUrl: "https://example.com/v1", apiKeyEnv: "CUSTOM_API_KEY" },
      models: [{ id: "model", alias: "model" }]
    };
    saveCustomPreset(d.customDir, preset);
    mkdirSync(d.builtinDir, { recursive: true });
    writeFileSync(join(d.builtinDir, "builtin.json"), JSON.stringify({ ...preset, id: "builtin", name: "Builtin" }));

    expect(listPresets(d).map((entry) => entry.id).sort()).toEqual(["builtin", "custom"]);
  });

  test("loads preset by id", () => {
    const d = dirs();
    saveCustomPreset(d.customDir, {
      id: "custom",
      name: "Custom",
      provider: { api: "openai-completions", baseUrl: "https://example.com/v1", apiKeyEnv: "CUSTOM_API_KEY" },
      models: [{ id: "model" }]
    });

    expect(loadPreset(d, "custom").name).toBe("Custom");
  });

  test("custom preset overrides builtin with same id", () => {
    const d = dirs();
    const builtin: ProviderPreset = {
      id: "shared",
      name: "Builtin",
      provider: { api: "openai-completions", baseUrl: "https://builtin.example/v1", apiKeyEnv: "BUILTIN_API_KEY" },
      models: [{ id: "a" }]
    };
    const custom: ProviderPreset = {
      id: "shared",
      name: "Custom",
      provider: { api: "openai-completions", baseUrl: "https://custom.example/v1", apiKeyEnv: "CUSTOM_API_KEY" },
      models: [{ id: "b" }]
    };
    mkdirSync(d.builtinDir, { recursive: true });
    writeFileSync(join(d.builtinDir, "shared.json"), JSON.stringify(builtin));
    saveCustomPreset(d.customDir, custom);

    expect(loadPreset(d, "shared").name).toBe("Custom");
  });

  test("exports provider preset from current config without secret values", () => {
    const preset = exportProviderPreset(sample as OpenClawConfig, "nvidia");
    expect(preset.id).toBe("nvidia");
    expect(preset.provider.apiKeyEnv).toBe("NVIDIA_API_KEY");
    expect(JSON.stringify(preset)).not.toContain("sk-");
  });
});
