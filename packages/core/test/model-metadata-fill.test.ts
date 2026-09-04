import { describe, expect, test } from "bun:test";
import { applyMetadataFill, computeMetadataFill, missingMetadataFieldCount } from "../src/model-metadata-fill";
import type { NormalizedModelMetadata } from "../src/model-metadata-catalog";
import type { OpenClawModel } from "../src/types";

const metadata: NormalizedModelMetadata = {
  catalogKey: "zai/glm-4.6",
  providerId: "zai",
  modelId: "glm-4.6",
  name: "GLM-4.6",
  reasoning: true,
  contextWindow: 200000,
  maxTokens: 128000,
  input: ["text", "image", "pdf"], // pdf 不在已知模态集合，应被过滤
  sourceKind: "models-dev-model",
  sourceUrl: "https://models.dev/models.json"
};

describe("computeMetadataFill（fill-empty）", () => {
  test("全空条目填满五项（input 过滤未知模态）", () => {
    const fill = computeMetadataFill({ id: "glm-4.6" }, metadata);
    expect(fill).toEqual({
      name: "GLM-4.6",
      reasoning: true,
      contextWindow: 200000,
      maxTokens: 128000,
      input: ["text", "image"]
    });
  });

  test("已有值字段一律不动", () => {
    const fill = computeMetadataFill(
      { id: "glm-4.6", name: "我的名字", reasoning: false, contextWindow: 128000, maxTokens: 8192, input: ["text"] },
      metadata
    );
    expect(fill).toBeUndefined();
    expect(missingMetadataFieldCount({ id: "glm-4.6", name: "x", reasoning: true, contextWindow: 1, maxTokens: 1, input: ["text"] })).toBe(0);
  });

  test("只填缺失子集；空字符串 name 视为缺失", () => {
    const fill = computeMetadataFill({ id: "glm-4.6", name: "  ", contextWindow: 128000 }, metadata);
    expect(fill).toEqual({ name: "GLM-4.6", reasoning: true, maxTokens: 128000, input: ["text", "image"] });
  });

  test("候选缺值不填；input 过滤后为空则不填", () => {
    const missingAll: NormalizedModelMetadata = {
      catalogKey: metadata.catalogKey,
      modelId: metadata.modelId,
      sourceKind: metadata.sourceKind,
      sourceUrl: metadata.sourceUrl
    };
    expect(computeMetadataFill({ id: "m" }, missingAll)).toBeUndefined();
    const fill = computeMetadataFill({ id: "m" }, { ...metadata, input: ["pdf"] });
    expect(fill?.input).toBeUndefined();
  });
});

describe("applyMetadataFill", () => {
  test("合并填充并保留未知键与原 id", () => {
    const model: OpenClawModel = { id: "glm-4.6", contextTokens: 60000, customKey: { keep: 1 } };
    const next = applyMetadataFill(model, { contextWindow: 200000, input: ["text"] });
    expect(next).toEqual({ id: "glm-4.6", contextTokens: 60000, customKey: { keep: 1 }, contextWindow: 200000, input: ["text"] });
    expect(model.contextWindow).toBeUndefined(); // 不改原对象
  });
});
