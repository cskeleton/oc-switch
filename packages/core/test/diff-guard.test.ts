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
});
