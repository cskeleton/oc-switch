import { describe, expect, test } from "bun:test";
import sampleJson from "./fixtures/openclaw.sample.json";
import { assertAllowedSemanticChange } from "../src/diff-guard";
import type { OpenClawConfig } from "../src/types";

const sample = sampleJson as OpenClawConfig;

function cloneSample() {
  return structuredClone(sample);
}

describe("assertAllowedSemanticChange", () => {
  test("allows provider, allowlist, and primary model changes", () => {
    const before = cloneSample();
    const after = cloneSample();
    after.models!.providers!.nvidia!.baseUrl = "https://new.example/v1";
    after.agents!.defaults!.model = "nvidia/deepseek-ai/deepseek-v4-flash";
    after.agents!.defaults!.models!["nvidia/deepseek-ai/deepseek-v4-pro"] = { alias: "nv-ds-pro" };

    expect(() => assertAllowedSemanticChange(before, after)).not.toThrow();
  });

  test("blocks non-whitelisted agents changes", () => {
    const before = cloneSample();
    const after = cloneSample();
    after.agents!.auth = { token: "changed" };

    expect(() => assertAllowedSemanticChange(before, after)).toThrow("Diff guard blocked change to agents.auth");
  });

  test("blocks non-whitelisted models changes", () => {
    const before = cloneSample();
    const after = cloneSample();
    after.models!.mode = "replace";

    expect(() => assertAllowedSemanticChange(before, after)).toThrow("Diff guard blocked change to models.mode");
  });

  test("ignores unchanged array fields such as acp.allowedAgents", () => {
    const before = cloneSample();
    const after = cloneSample();
    before.acp = {
      enabled: true,
      allowedAgents: ["gemini", "cursor", "codex"]
    };
    after.acp = structuredClone(before.acp);
    after.agents!.defaults!.models!["nvidia/deepseek-ai/deepseek-v4-flash"] = { alias: "nv-ds-flash" };

    expect(() => assertAllowedSemanticChange(before, after)).not.toThrow();
  });

  test("blocks changes inside non-whitelisted array fields", () => {
    const before = cloneSample();
    const after = cloneSample();
    before.acp = { allowedAgents: ["gemini", "cursor"] };
    after.acp = { allowedAgents: ["gemini", "cursor", "codex"] };

    expect(() => assertAllowedSemanticChange(before, after)).toThrow(
      "Diff guard blocked change to acp.allowedAgents"
    );
  });

  test("allows creating missing containers when only allowed child paths change", () => {
    const before: OpenClawConfig = {};
    const after: OpenClawConfig = {
      models: {
        providers: {
          custom: {
            api: "openai-completions",
            models: [{ id: "model", name: "Model" }]
          }
        }
      },
      agents: {
        defaults: {
          model: "custom/model",
          models: {
            "custom/model": { alias: "custom" }
          }
        }
      }
    };

    expect(() => assertAllowedSemanticChange(before, after)).not.toThrow();
  });

  test("allows agents.defaults.model 深层路径变更（pin：primary/fallbacks 子键放行）", () => {
    const before = cloneSample();
    const after = cloneSample();
    after.agents!.defaults!.model = {
      primary: "nvidia/deepseek-ai/deepseek-v4-flash",
      fallbacks: ["DeepSeek/deepseek-chat"]
    };

    expect(() => assertAllowedSemanticChange(before, after)).not.toThrow();
  });

  test("allows agents.defaults.modelPolicy.allow changes", () => {
    const before = cloneSample();
    const after = cloneSample();
    before.agents!.defaults!.modelPolicy = {
      allow: ["nvidia/deepseek-ai/deepseek-v4-flash"]
    };
    after.agents!.defaults!.modelPolicy = {
      allow: [
        "nvidia/deepseek-ai/deepseek-v4-flash",
        "opencode/new-model"
      ]
    };

    expect(() => assertAllowedSemanticChange(before, after)).not.toThrow();
  });

  test("allows plugins.entries.<id>.enabled flips（跨机同步 §6.3 白名单项）", () => {
    const before = cloneSample();
    const after = cloneSample();
    before.plugins = { entries: { "my-plugin": { enabled: false } } };
    after.plugins = { entries: { "my-plugin": { enabled: true } } };

    expect(() => assertAllowedSemanticChange(before, after)).not.toThrow();
  });

  describe("plugins.entries.<id>.enabled 四种转换（Task 4 插件启停）", () => {
    test("absence→false 允许（停用 enabledByDefault 插件时创建最小 entry）", () => {
      const before = cloneSample();
      const after = cloneSample();
      before.plugins = { entries: {} };
      after.plugins = { entries: { xiaomi: { enabled: false } } };

      expect(() => assertAllowedSemanticChange(before, after)).not.toThrow();
    });

    test("absence→true 允许（启用时创建最小 entry）", () => {
      const before = cloneSample();
      const after = cloneSample();
      before.plugins = { entries: {} };
      after.plugins = { entries: { xiaomi: { enabled: true } } };

      expect(() => assertAllowedSemanticChange(before, after)).not.toThrow();
    });

    test("false→true 允许", () => {
      const before = cloneSample();
      const after = cloneSample();
      before.plugins = { entries: { xiaomi: { enabled: false } } };
      after.plugins = { entries: { xiaomi: { enabled: true } } };

      expect(() => assertAllowedSemanticChange(before, after)).not.toThrow();
    });

    test("true→false 允许", () => {
      const before = cloneSample();
      const after = cloneSample();
      before.plugins = { entries: { xiaomi: { enabled: true } } };
      after.plugins = { entries: { xiaomi: { enabled: false } } };

      expect(() => assertAllowedSemanticChange(before, after)).not.toThrow();
    });

    test("同事务修改 plugins.entries.<id>.config 时阻断", () => {
      const before = cloneSample();
      const after = cloneSample();
      before.plugins = { entries: { xiaomi: { enabled: true, config: { region: "cn" } } } };
      after.plugins = { entries: { xiaomi: { enabled: false, config: { region: "global" } } } };

      expect(() => assertAllowedSemanticChange(before, after)).toThrow(
        "Diff guard blocked change to plugins.entries.xiaomi.config"
      );
    });

    test("同事务新增非 enabled 键（config）时阻断（enabled 不变）", () => {
      const before = cloneSample();
      const after = cloneSample();
      before.plugins = { entries: { xiaomi: { enabled: true } } };
      after.plugins = { entries: { xiaomi: { enabled: true, config: { region: "cn" } } } };

      expect(() => assertAllowedSemanticChange(before, after)).toThrow(
        "Diff guard blocked change to plugins.entries.xiaomi.config"
      );
    });
  });

  test("blocks other plugins.entries fields", () => {
    const before = cloneSample();
    const after = cloneSample();
    before.plugins = { entries: { "my-plugin": { enabled: false, pinned: "1.0.0" } } };
    after.plugins = { entries: { "my-plugin": { enabled: true, pinned: "2.0.0" } } };

    expect(() => assertAllowedSemanticChange(before, after)).toThrow(
      "Diff guard blocked change to plugins.entries.my-plugin.pinned"
    );
  });
});
