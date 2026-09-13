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
    expect(result.config.agents?.defaults?.models?.["nvidia/deepseek-ai/deepseek-v4-flash"]).toBeDefined();
    expect(result.config.agents?.defaults?.modelPolicy?.allow?.some(ref => typeof ref === "string" && ref.startsWith("nvidia/"))).toBe(false);
    expect(result.config.agents?.defaults?.models?.["nvidia/z-ai/glm5.1"]).toBeDefined();
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

describe("provider disable 对象形态主模型与 fallback 保护", () => {
  function objectPrimarySample() {
    const config = cloneSample();
    config.agents!.defaults!.model = {
      primary: "minimax-portal/MiniMax-M3",
      fallbacks: ["nvidia/deepseek-ai/deepseek-v4-flash"]
    } as never;
    return config;
  }

  test("disableProvider：对象形态主模型属于该 provider 时拒绝", () => {
    const config = objectPrimarySample();
    expect(() => disableProvider(config, "minimax-portal")).toThrow(
      "Provider minimax-portal contains the primary model. Switch primary model before disabling this provider."
    );
  });

  test("disableProvider：fallback 引用该 provider 时拒绝，配置不变", () => {
    const config = objectPrimarySample();
    const before = structuredClone(config);
    expect(() => disableProvider(config, "nvidia")).toThrow(/agents\.defaults\.model\.fallbacks/);
    expect(config).toEqual(before);
  });

  test("disableProvider：primary 带首尾空白时仍正确拦截", () => {
    const config = objectPrimarySample();
    (config.agents!.defaults!.model as Record<string, unknown>).primary = "  minimax-portal/MiniMax-M3  ";
    expect(() => disableProvider(config, "minimax-portal")).toThrow(/contains the primary model/);
  });
});

describe("插件 provider 不可经可逆关闭通道操作", () => {
  test("disableProvider / restoreDisabledProvider 对插件 provider 显式报 not found", () => {
    // 插件 provider 不在 models.providers 里；关闭状态由 OpenClaw 的 plugins.entries 掌管
    expect(() => disableProvider(cloneSample(), "opencode")).toThrow(/Provider opencode not found/);
    expect(() => restoreDisabledProvider(cloneSample(), "opencode", {}))
      .toThrow(/Provider opencode not found/);
  });
});
