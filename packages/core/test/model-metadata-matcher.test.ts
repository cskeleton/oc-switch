// packages/core/test/model-metadata-matcher.test.ts
import { describe, expect, test } from "bun:test";
import {
  editSimilarity,
  FUZZY_MAX_CANDIDATES,
  hasStrictTokenContainment,
  isOfficialMetadataEntry,
  matchFuzzyModelMetadata,
  scoreCandidate,
  tokenJaccard
} from "../src/model-metadata-matcher";
import type { NormalizedModelMetadata } from "../src/model-metadata-catalog";

function entry(catalogKey: string, extra: Partial<NormalizedModelMetadata> = {}): NormalizedModelMetadata {
  const slash = catalogKey.indexOf("/");
  return {
    catalogKey,
    providerId: slash > 0 ? catalogKey.slice(0, slash) : undefined,
    modelId: slash >= 0 ? catalogKey.slice(slash + 1) : catalogKey,
    sourceKind: "models-dev-model",
    sourceUrl: "https://models.dev/models.json",
    ...extra
  } as NormalizedModelMetadata;
}

describe("scoring primitives", () => {
  test("tokenJaccard / editSimilarity / scoreCandidate 权重与 CPAMP 一致", () => {
    expect(tokenJaccard("gpt-5.6-codex-mini", "gpt-5.6-codex")).toBeCloseTo(3 / 4);
    expect(editSimilarity("glm-4.6", "glm-4.5")).toBeCloseTo(1 - 1 / 7);
    // score = max(jaccard*0.86, edit*0.82)
    expect(scoreCandidate("gpt-5.6-codex", "gpt-5.6-codex")).toBeCloseTo(Math.max(1 * 0.86, 1 * 0.82));
  });

  test("hasStrictTokenContainment 识别互为截断的 token 集", () => {
    expect(hasStrictTokenContainment("gpt-5.6-codex-mini", "gpt-5.6-codex")).toBe(true);
    expect(hasStrictTokenContainment("gpt-5.6-codex", "gpt-5.6-codex-mini")).toBe(true);
    expect(hasStrictTokenContainment("glm-4.6", "glm-4.5")).toBe(false);
    expect(hasStrictTokenContainment("gpt-5", "gpt-5")).toBe(false);
  });

  test("isOfficialMetadataEntry 命中已知模型厂或自产自销 token", () => {
    expect(isOfficialMetadataEntry(entry("anthropic/claude-opus-5"))).toBe(true);
    expect(isOfficialMetadataEntry(entry("deepseek/deepseek-v4-flash"))).toBe(true);
    expect(isOfficialMetadataEntry(entry("bedrock/anthropic.claude-opus-5"))).toBe(false);
    expect(isOfficialMetadataEntry(entry("openrouter/openai/gpt-5"))).toBe(false);
  });
});

describe("matchFuzzyModelMetadata", () => {
  const catalog = {
    modelFacts: [
      entry("zai/glm-4.6", { contextWindow: 200000 }),
      entry("openrouter/z-ai/glm-4.6", { contextWindow: 200000 }),
      entry("openai/gpt-5.6-codex", {}),
      entry("anthropic/claude-opus-5", {})
    ],
    providerCatalog: [entry("zai/glm-4.6", { sourceKind: "models-dev-provider" } as Partial<NormalizedModelMetadata>)]
  };

  test("本地带厂商前缀的 id 经 core 归一化后模糊命中，score≥0.55 reason 为 shared-model-tokens", () => {
    const hits = matchFuzzyModelMetadata({ providerId: "custom", modelId: "zai-org/GLM-4.6" }, catalog);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.score).toBeGreaterThanOrEqual(0.55);
    expect(hits[0]!.reason).toBe("shared-model-tokens");
  });

  test("同 id 多条目优先选本 provider 条目", () => {
    const hits = matchFuzzyModelMetadata({ providerId: "zai", modelId: "glm-4.6-preview" }, {
      modelFacts: [entry("openrouter/z-ai/glm-4.6"), entry("zai/glm-4.6")],
      providerCatalog: []
    });
    expect(hits[0]!.metadata.providerId).toBe("zai");
  });

  test("无 provider 命中时优先官方条目", () => {
    const hits = matchFuzzyModelMetadata({ providerId: "custom", modelId: "claude-opus-5-0909" }, {
      modelFacts: [entry("bedrock/anthropic.claude-opus-5"), entry("anthropic/claude-opus-5")],
      providerCatalog: []
    });
    // 两条 catalog id 不同（anthropic.claude-opus-5 vs claude-opus-5），各自成组；官方组应存在
    const official = hits.find((h) => h.metadata.providerId === "anthropic");
    expect(official).toBeTruthy();
  });

  test("低于弱召回阈值不返回；token 严格包含时 reason 标注 token-containment", () => {
    const hits = matchFuzzyModelMetadata({ providerId: "custom", modelId: "gpt-5.6-codex-mini" }, {
      modelFacts: [entry("openai/gpt-5.6-codex"), entry("anthropic/claude-opus-5")],
      providerCatalog: []
    });
    expect(hits.every((h) => h.metadata.modelId !== "claude-opus-5")).toBe(true);
    const codex = hits.find((h) => h.metadata.modelId === "gpt-5.6-codex");
    expect(codex?.reason).toBe("token-containment");
  });

  test("候选数封顶 FUZZY_MAX_CANDIDATES", () => {
    const many = Array.from({ length: 20 }, (_, i) => entry(`p${i}/glm-4.${i}`));
    const hits = matchFuzzyModelMetadata({ providerId: "custom", modelId: "glm-4" }, { modelFacts: many, providerCatalog: [] });
    expect(hits.length).toBeLessThanOrEqual(FUZZY_MAX_CANDIDATES);
  });
});
