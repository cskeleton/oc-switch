import { describe, expect, test } from "bun:test";
import { normalizeConfigForStorage } from "../src/config-normalization";
import type { OpenClawConfig } from "../src/types";

describe("normalizeConfigForStorage", () => {
  test("stores provider keys and all provider ref prefixes in lowercase while preserving model IDs", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          CPA: { models: [{ id: "Vendor/Model-X" }] },
          DeepSeek: { models: [{ id: "deepseek-chat" }] }
        }
      },
      agents: {
        defaults: {
          model: {
            primary: "CPA/Vendor/Model-X",
            fallbacks: ["DeepSeek/deepseek-chat"]
          },
          models: {
            "cpa/Vendor/Model-X": { alias: "x" },
            "DeepSeek/deepseek-chat": {}
          }
        }
      }
    };

    const result = normalizeConfigForStorage(config);

    expect(result.changed).toBe(true);
    expect(Object.keys(result.config.models?.providers ?? {})).toEqual(["cpa", "deepseek"]);
    expect(result.config.models?.providers?.cpa?.models?.[0]?.id).toBe("Vendor/Model-X");
    expect(Object.keys(result.config.agents?.defaults?.models ?? {})).toEqual([
      "cpa/Vendor/Model-X",
      "deepseek/deepseek-chat"
    ]);
    expect(result.config.agents?.defaults?.model).toEqual({
      primary: "cpa/Vendor/Model-X",
      fallbacks: ["deepseek/deepseek-chat"]
    });
  });

  test("rejects two real provider blocks that would collide after lowercasing", () => {
    const config: OpenClawConfig = {
      models: { providers: { CPA: {}, cpa: {} } }
    };

    expect(() => normalizeConfigForStorage(config)).toThrow(/Provider ID.*CPA.*cpa|case-insensitive/i);
  });

  test("rejects conflicting allowlist entries that would collide after lowercasing", () => {
    const config: OpenClawConfig = {
      agents: {
        defaults: {
          models: {
            "CPA/model": { alias: "upper" },
            "cpa/model": { alias: "lower" }
          }
        }
      }
    };

    expect(() => normalizeConfigForStorage(config)).toThrow(/allowlist.*CPA\/model.*cpa\/model/i);
  });
});
