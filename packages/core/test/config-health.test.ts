import { describe, expect, test } from "bun:test";
import { inspectConfigHealth, mergeProviderCaseDuplicates } from "../src/config-health";
import type { OpenClawConfig } from "../src/types";

function cfg(partial: OpenClawConfig): OpenClawConfig {
  return partial;
}

describe("inspectConfigHealth", () => {
  test("无重复时返回空报告", () => {
    const report = inspectConfigHealth(cfg({
      models: { providers: { cerebras: { baseUrl: "https://api.cerebras.ai/v1", models: [{ id: "qwen" }] } } },
      agents: { defaults: { model: "cerebras/qwen", models: { "cerebras/qwen": {} } } }
    }));
    expect(report.caseDuplicateGroups).toEqual([]);
    expect(report.summary.duplicateGroupCount).toBe(0);
  });

  test("纯 allowlist（无 provider 块，疑似 OAuth）即使大小写撞车也不上报", () => {
    const report = inspectConfigHealth(cfg({
      models: { providers: {} },
      agents: { defaults: { model: "x/y", models: { "openai/gpt": {}, "OpenAI/gpt": {} } } }
    }));
    expect(report.caseDuplicateGroups).toEqual([]);
  });

  test("provider-duplicate 同 baseUrl 同 env：sameOrigin + mergeable + canonical 取配置完整且 allowlist 多的一侧", () => {
    const report = inspectConfigHealth(cfg({
      models: {
        providers: {
          deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "${DEEPSEEK_API_KEY}" }, models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] },
          DeepSeek: { baseUrl: "https://api.deepseek.com/v1/", apiKey: { source: "env", id: "DEEPSEEK_API_KEY" }, models: [{ id: "deepseek-chat" }, { id: "deepseek-reasoner" }] }
        }
      },
      agents: { defaults: { model: "minimax-portal/x", models: { "deepseek/deepseek-chat": {}, "deepseek/deepseek-reasoner": {} } } }
    }));

    expect(report.caseDuplicateGroups).toHaveLength(1);
    const group = report.caseDuplicateGroups[0]!;
    expect(group.groupKey).toBe("deepseek");
    expect([...group.ids].sort()).toEqual(["DeepSeek", "deepseek"]);
    expect(group.kinds).toContain("provider-duplicate");
    expect(group.kinds).toContain("same-origin-hint");
    expect(group.sameOrigin).toBe(true);
    expect(group.mergeable).toBe(true);
    expect(group.mergeBlockers).toEqual([]);
    expect(group.canonicalId).toBe("deepseek");
    expect(group.duplicateIds).toEqual(["DeepSeek"]);
    expect(group.confidence).toBe("high");
  });

  test("allowlist-drift：provider 块仅 9R，allowlist 全用 9r → canonical 取持有配置的 9R", () => {
    const report = inspectConfigHealth(cfg({
      models: { providers: { "9R": { baseUrl: "http://192.168.22.20:20128/v1", apiKey: { source: "env", id: "X_KEY" }, models: [{ id: "deepseek-v3" }, { id: "kimi" }] } } },
      agents: { defaults: { model: "minimax/x", models: { "9r/deepseek-v3": {}, "9r/kimi": {} } } }
    }));

    expect(report.caseDuplicateGroups).toHaveLength(1);
    const group = report.caseDuplicateGroups[0]!;
    expect(group.kinds).toContain("allowlist-drift");
    expect(group.canonicalId).toBe("9R");
    expect(group.duplicateIds).toEqual(["9r"]);
    expect(group.details.allowlistCounts).toEqual({ "9R": 0, "9r": 2 });
    expect(group.details.modelCounts).toEqual({ "9R": 2, "9r": 0 });
    expect(group.mergeable).toBe(true);
  });

  test("主模型落在重复组 → primary-split 且 canonicalId 取主模型一侧", () => {
    const report = inspectConfigHealth(cfg({
      models: {
        providers: {
          "9r": { baseUrl: "http://h/v1", apiKey: { source: "env", id: "K" }, models: [{ id: "foo" }] },
          "9R": { baseUrl: "http://h/v1", apiKey: { source: "env", id: "K" }, models: [{ id: "foo" }] }
        }
      },
      agents: { defaults: { model: "9R/foo", models: { "9R/foo": {} } } }
    }));
    const group = report.caseDuplicateGroups[0]!;
    expect(group.kinds).toContain("primary-split");
    expect(group.canonicalId).toBe("9R");
    expect(group.details.primaryModel).toBe("9R/foo");
  });

  test("baseUrl 不同 → 非 sameOrigin、非 mergeable，记录 blocker，confidence 降为 low", () => {
    const report = inspectConfigHealth(cfg({
      models: {
        providers: {
          joverna: { baseUrl: "https://a.example/v1", apiKey: { source: "env", id: "A" }, models: [{ id: "m" }] },
          Joverna: { baseUrl: "https://b.example/v1", apiKey: { source: "env", id: "B" }, models: [{ id: "m" }] }
        }
      },
      agents: { defaults: { model: "x/y", models: {} } }
    }));
    const group = report.caseDuplicateGroups[0]!;
    expect(group.sameOrigin).toBe(false);
    expect(group.mergeable).toBe(false);
    expect(group.mergeBlockers.length).toBeGreaterThan(0);
    expect(group.confidence).toBe("low");
  });

  test("平局（同源、配置同样完整）→ 字典序稳定 canonical + medium + 建议人工确认", () => {
    const report = inspectConfigHealth(cfg({
      models: {
        providers: {
          openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: { source: "env", id: "${OPENROUTER_API_KEY}" }, models: [] },
          OpenRouter: { baseUrl: "https://openrouter.ai/api/v1", apiKey: { source: "env", id: "OPENROUTER_API_KEY" }, models: [{ id: "z" }] }
        }
      },
      agents: { defaults: { model: "x/y", models: { "openrouter/a": {}, "openrouter/b": {} } } }
    }));
    const group = report.caseDuplicateGroups[0]!;
    expect(group.canonicalId).toBe("OpenRouter");
    expect(group.confidence).toBe("medium");
    expect(group.mergeable).toBe(true);
    expect(group.reasons.some((r) => r.includes("人工确认"))).toBe(true);
  });

  test("summary 聚合多组", () => {
    const report = inspectConfigHealth(cfg({
      models: {
        providers: {
          deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "D" }, models: [{ id: "c" }] },
          DeepSeek: { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "D" }, models: [{ id: "c" }] },
          "9R": { baseUrl: "http://h/v1", apiKey: { source: "env", id: "K" }, models: [{ id: "v3" }] }
        }
      },
      agents: { defaults: { model: "x/y", models: { "deepseek/c": {}, "9r/v3": {} } } }
    }));
    expect(report.summary.duplicateGroupCount).toBe(2);
    expect(report.summary.affectedProviderCount).toBe(3);
    expect(report.summary.affectedAllowlistCount).toBe(2);
  });
});

describe("mergeProviderCaseDuplicates", () => {
  test("provider-duplicate：合并模型去重、删除重复块、不改 env", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          deepseek: { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "DEEPSEEK_API_KEY" }, models: [{ id: "deepseek-chat", name: "保留" }] },
          DeepSeek: { baseUrl: "https://api.deepseek.com/v1", apiKey: { source: "env", id: "DEEPSEEK_API_KEY" }, models: [{ id: "deepseek-chat", name: "丢弃" }, { id: "deepseek-reasoner" }] }
        }
      },
      agents: { defaults: { model: "minimax/x", models: { "deepseek/deepseek-chat": { alias: "ds" }, "DeepSeek/deepseek-reasoner": {} } } }
    };

    const result = mergeProviderCaseDuplicates(config, { groupKey: "deepseek", canonicalId: "deepseek", removeIds: ["DeepSeek"] });

    expect(result.config.models?.providers?.DeepSeek).toBeUndefined();
    const models = result.config.models?.providers?.deepseek?.models ?? [];
    expect(models.map((m) => m.id).sort()).toEqual(["deepseek-chat", "deepseek-reasoner"]);
    expect(models.find((m) => m.id === "deepseek-chat")?.name).toBe("保留");
    expect(result.config.agents?.defaults?.models?.["DeepSeek/deepseek-reasoner"]).toBeUndefined();
    expect(result.config.agents?.defaults?.models?.["deepseek/deepseek-reasoner"]).toEqual({});
    expect(result.config.agents?.defaults?.models?.["deepseek/deepseek-chat"]).toEqual({ alias: "ds" });
  });

  test("allowlist-drift：canonical 仅在重复侧有 provider 块时整体改名", () => {
    const config: OpenClawConfig = {
      models: { providers: { "9R": { baseUrl: "http://h/v1", apiKey: { source: "env", id: "K" }, models: [{ id: "v3" }, { id: "kimi" }] } } },
      agents: { defaults: { model: "minimax/x", models: { "9r/v3": { alias: "a" }, "9r/kimi": {} } } }
    };

    const result = mergeProviderCaseDuplicates(config, { groupKey: "9r", canonicalId: "9R", removeIds: ["9r"] });

    expect(result.config.models?.providers?.["9R"]?.models?.map((m) => m.id)).toEqual(["v3", "kimi"]);
    expect(result.config.agents?.defaults?.models?.["9r/v3"]).toBeUndefined();
    expect(result.config.agents?.defaults?.models?.["9R/v3"]).toEqual({ alias: "a" });
    expect(result.config.agents?.defaults?.models?.["9R/kimi"]).toEqual({});
  });

  test("主模型前缀在重复侧 → 迁移到 canonical", () => {
    const config: OpenClawConfig = {
      models: { providers: { "9r": { baseUrl: "http://h/v1", apiKey: { source: "env", id: "K" }, models: [{ id: "foo" }] }, "9R": { baseUrl: "http://h/v1", apiKey: { source: "env", id: "K" }, models: [{ id: "foo" }] } } },
      agents: { defaults: { model: "9R/foo", models: { "9R/foo": {} } } }
    };
    const result = mergeProviderCaseDuplicates(config, { groupKey: "9r", canonicalId: "9r", removeIds: ["9R"] });
    expect(result.config.agents?.defaults?.model).toBe("9r/foo");
    expect(result.config.models?.providers?.["9R"]).toBeUndefined();
  });

  test("canonicalId 不在组内或 removeIds 含 canonical → 抛错", () => {
    const config: OpenClawConfig = { models: { providers: { a: {}, A: {} } }, agents: { defaults: { models: {} } } };
    expect(() => mergeProviderCaseDuplicates(config, { groupKey: "a", canonicalId: "B", removeIds: ["A"] })).toThrow("canonicalId must be one of");
    expect(() => mergeProviderCaseDuplicates(config, { groupKey: "a", canonicalId: "a", removeIds: ["a"] })).toThrow("removeIds must not include canonicalId");
  });

  test("keepModelIds：仅保留所选模型，丢弃其余及其 allowlist（两侧）", () => {
    const config: OpenClawConfig = {
      models: {
        providers: {
          deepseek: { baseUrl: "u", apiKey: { source: "env", id: "K" }, models: [{ id: "chat" }, { id: "reasoner" }] },
          DeepSeek: { baseUrl: "u", apiKey: { source: "env", id: "K" }, models: [{ id: "chat" }, { id: "coder" }] }
        }
      },
      agents: { defaults: { model: "minimax/x", models: { "deepseek/chat": {}, "deepseek/reasoner": {}, "DeepSeek/coder": {} } } }
    };
    const result = mergeProviderCaseDuplicates(config, { groupKey: "deepseek", canonicalId: "deepseek", removeIds: ["DeepSeek"], keepModelIds: ["chat"] });
    expect(result.config.models?.providers?.deepseek?.models?.map((m) => m.id)).toEqual(["chat"]);
    expect(result.config.agents?.defaults?.models?.["deepseek/chat"]).toEqual({});
    expect(result.config.agents?.defaults?.models?.["deepseek/reasoner"]).toBeUndefined();
    expect(result.config.agents?.defaults?.models?.["DeepSeek/coder"]).toBeUndefined();
    expect(result.config.agents?.defaults?.models?.["deepseek/coder"]).toBeUndefined();
  });

  test("keepModelIds 丢弃了主模型对应的模型 → 抛错", () => {
    const config: OpenClawConfig = {
      models: { providers: { deepseek: { models: [{ id: "chat" }] }, DeepSeek: { models: [{ id: "chat" }] } } },
      agents: { defaults: { model: "deepseek/chat", models: { "deepseek/chat": {} } } }
    };
    expect(() => mergeProviderCaseDuplicates(config, { groupKey: "deepseek", canonicalId: "deepseek", removeIds: ["DeepSeek"], keepModelIds: [] }))
      .toThrow("Cannot drop the primary model");
  });
});
