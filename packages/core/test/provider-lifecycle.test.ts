import { describe, expect, test } from "bun:test";
import sampleJson from "./fixtures/openclaw.sample.json";
import { disableProvider, restoreDisabledProvider } from "../src/provider-lifecycle";
import type { OpenClawConfig } from "../src/types";

const sample = sampleJson as OpenClawConfig;

function cloneSample() {
  return structuredClone(sample);
}

describe("provider disable and restore", () => {
  test("disables provider by removing only allowlist entries and keeping provider models", () => {
    const config = cloneSample();
    const result = disableProvider(config, "nvidia");

    expect(result.config.models?.providers?.nvidia?.models?.map((model) => model.id)).toEqual([
      "deepseek-ai/deepseek-v4-flash",
      "z-ai/glm5.1"
    ]);
    expect(result.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeUndefined();
    expect(result.config.agents?.defaults?.models?.["nvidia/z-ai/glm5.1"]).toBeUndefined();
    expect(result.config.agents?.defaults?.models?.["DeepSeek/deepseek-chat"]).toEqual({ alias: "ds-chat" });
    expect(result.disabledState.allowlistEntries).toEqual({
      "nvidia/deepseek-ai/deepseek-v4-flash": {
        alias: "nv-ds-flash",
        agentRuntime: { id: "codex" }
      },
      "nvidia/z-ai/glm5.1": {
        alias: "nv-glm"
      }
    });
  });

  test("refuses to disable provider containing the primary model", () => {
    const config = cloneSample();
    expect(() => disableProvider(config, "minimax-portal")).toThrow(
      "Provider minimax-portal contains the primary model. Switch primary model before disabling this provider."
    );
  });

  test("restores disabled provider entries exactly and rejects mismatched refs", () => {
    const config = cloneSample();
    const disabled = disableProvider(config, "nvidia");
    const restored = restoreDisabledProvider(disabled.config, "nvidia", disabled.disabledState.allowlistEntries);

    expect(restored.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-flash"]).toEqual({
      alias: "nv-ds-flash",
      agentRuntime: { id: "codex" }
    });
    expect(restored.config.agents?.defaults?.models?.["nvidia/z-ai/glm5.1"]).toEqual({ alias: "nv-glm" });

    expect(() => restoreDisabledProvider(cloneSample(), "nvidia", {
      "DeepSeek/deepseek-chat": { alias: "wrong" }
    })).toThrow("Snapshot ref DeepSeek/deepseek-chat does not belong to provider nvidia");
  });
});
