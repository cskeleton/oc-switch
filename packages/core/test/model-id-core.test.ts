import { describe, expect, test } from "bun:test";
import {
  classifyStrippedSuffix,
  classifyTailSegment,
  localCoreCandidates,
  stripCatalogDateSuffixes,
  stripModelIdPrefix
} from "../src/model-id-core";

describe("stripModelIdPrefix", () => {
  test("取最后一个 / 之后的子串", () => {
    expect(stripModelIdPrefix("zai-org/GLM-4.6")).toBe("GLM-4.6");
    expect(stripModelIdPrefix("openrouter/openai/gpt-4o")).toBe("gpt-4o");
    expect(stripModelIdPrefix("gpt-4o")).toBe("gpt-4o");
    expect(stripModelIdPrefix("vendor/")).toBe("");
  });
});

describe("stripCatalogDateSuffixes", () => {
  test("循环剥离 MMDD / YYYYMMDD / ISO 三段日期尾段", () => {
    expect(stripCatalogDateSuffixes("deepseek-v3.1-0731")).toEqual({ core: "deepseek-v3.1", stripped: ["0731"] });
    expect(stripCatalogDateSuffixes("claude-sonnet-4-5-20250929")).toEqual({
      core: "claude-sonnet-4-5",
      stripped: ["20250929"]
    });
    expect(stripCatalogDateSuffixes("gpt-4o-2024-08-06")).toEqual({ core: "gpt-4o", stripped: ["2024-08-06"] });
    // 连续日期尾段循环剥离
    expect(stripCatalogDateSuffixes("some-model-2024-08-06-0731")).toEqual({
      core: "some-model",
      stripped: ["2024-08-06", "0731"]
    });
  });

  test("非日期尾段不剥；永不剥成空串；剥前缀后再剥日期", () => {
    expect(stripCatalogDateSuffixes("gpt-4o")).toEqual({ core: "gpt-4o", stripped: [] });
    expect(stripCatalogDateSuffixes("llama-3.1-405b")).toEqual({ core: "llama-3.1-405b", stripped: [] });
    expect(stripCatalogDateSuffixes("0731")).toEqual({ core: "0731", stripped: [] });
    expect(stripCatalogDateSuffixes("anthropic/claude-sonnet-4-5-20250929")).toEqual({
      core: "claude-sonnet-4-5",
      stripped: ["20250929"]
    });
  });
});

describe("localCoreCandidates", () => {
  test("渐进剥离、最长优先、含单段候选", () => {
    expect(localCoreCandidates("kimi-k2-0711-preview")).toEqual([
      "kimi-k2-0711-preview",
      "kimi-k2-0711",
      "kimi-k2",
      "kimi"
    ]);
    expect(localCoreCandidates("gpt-4o")).toEqual(["gpt-4o", "gpt"]);
  });

  test("先剥前缀；空输入返回空数组", () => {
    expect(localCoreCandidates("zai-org/GLM-4.6")).toEqual(["GLM-4.6", "GLM"]);
    expect(localCoreCandidates("  ")).toEqual([]);
    expect(localCoreCandidates("")).toEqual([]);
  });
});

describe("classifyTailSegment / classifyStrippedSuffix", () => {
  test("已知类别识别", () => {
    expect(classifyTailSegment("0731")).toBe("date");
    expect(classifyTailSegment("20241022")).toBe("date");
    expect(classifyTailSegment("high")).toBe("thinking");
    expect(classifyTailSegment("LOW")).toBe("thinking");
    expect(classifyTailSegment("fireworks")).toBe("routing");
    expect(classifyTailSegment("preview")).toBe("unknown");
    expect(classifyTailSegment("4o")).toBe("unknown");
  });

  test("整体尾缀分类：ISO 日期整体优先于逐段", () => {
    expect(classifyStrippedSuffix("gpt-5.2-2026-01-01", "gpt-5.2")).toBe("known");
    expect(classifyStrippedSuffix("gpt-5-high", "gpt-5")).toBe("known");
    expect(classifyStrippedSuffix("deepseek-v3.1-0731", "deepseek-v3.1")).toBe("known");
    expect(classifyStrippedSuffix("kimi-k2-0711-preview", "kimi-k2")).toBe("unknown");
    expect(classifyStrippedSuffix("gpt-4o", "gpt-4o")).toBe("known");
  });
});
