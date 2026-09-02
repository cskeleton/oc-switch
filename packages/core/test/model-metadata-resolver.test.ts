import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import modelsFixture from "./fixtures/model-metadata/models.json";
import apiFixture from "./fixtures/model-metadata/api.json";
import {
  loadModelMetadataCatalog,
  MODELS_DEV_API_URL,
  MODELS_DEV_MODELS_URL
} from "../src/model-metadata-catalog";
import {
  resolveModelMetadata,
  type ModelMetadataCatalogData
} from "../src/model-metadata-resolver";
import type { FetchImpl } from "../src/provider-sync";

const BASE_NOW = Date.parse("2026-08-01T00:00:00.000Z");

async function loadFixtureCatalog(): Promise<ModelMetadataCatalogData> {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-resolver-"));
  try {
    const fetchImpl: FetchImpl = async (input) => {
      const url = String(input);
      if (url === MODELS_DEV_MODELS_URL) return new Response(JSON.stringify(modelsFixture), { status: 200 });
      if (url === MODELS_DEV_API_URL) return new Response(JSON.stringify(apiFixture), { status: 200 });
      throw new Error(`unexpected url: ${url}`);
    };
    const result = await loadModelMetadataCatalog({ stateDir: dir, fetchImpl, now: () => BASE_NOW });
    return { modelFacts: result.modelFacts, providerCatalog: result.providerCatalog };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("resolveModelMetadata", () => {
  test("OpenRouter Provider/raw ID 精确命中 provider-specific 行", async () => {
    const catalog = await loadFixtureCatalog();
    const suggestions = resolveModelMetadata(
      { providerId: "openrouter", modelId: "openai/gpt-5.2" },
      catalog
    );
    const top = suggestions[0];
    expect(top?.matchKind).toBe("provider-exact");
    expect(top?.confidence).toBe("high");
    expect(top?.model.sourceKind).toBe("models-dev-provider");
    expect(top?.model.catalogKey).toBe("openrouter/openai/gpt-5.2");
    expect(top?.model.contextWindow).toBe(400000);
    expect(top?.model.inputLimit).toBe(272000);
    expect(top?.model.maxTokens).toBe(128000);
  });

  test("Provider-specific 与 model-only 冲突时顺序稳定、来源保留", async () => {
    const catalog = await loadFixtureCatalog();
    const suggestions = resolveModelMetadata(
      { providerId: "openrouter", modelId: "openai/gpt-5.2" },
      catalog
    );
    const providerSpecific = suggestions.find((s) => s.model.sourceKind === "models-dev-provider");
    const modelOnly = suggestions.find((s) => s.model.sourceKind === "models-dev-model");
    expect(providerSpecific).toBeTruthy();
    expect(modelOnly).toBeTruthy();
    // provider-specific 排在前面
    expect(suggestions[0]!.model.sourceKind).toBe("models-dev-provider");
    // 两个来源都保留，不静默合并
    expect(providerSpecific?.model.inputLimit).toBe(272000);
    expect(modelOnly?.model.inputLimit).toBeUndefined();
  });

  test("arbitrary Provider + 完整 openai/gpt-* key 精确命中模型事实", async () => {
    const catalog = await loadFixtureCatalog();
    const suggestions = resolveModelMetadata(
      { providerId: "custom-proxy", modelId: "openai/gpt-5.2" },
      catalog
    );
    const top = suggestions[0];
    expect(top?.matchKind).toBe("model-key-exact");
    expect(top?.confidence).toBe("high");
    expect(top?.model.sourceKind).toBe("models-dev-model");
    expect(top?.model.catalogKey).toBe("openai/gpt-5.2");
    expect(top?.model.contextWindow).toBe(400000);
  });

  test("ISO 日期后缀经核心 ID 回退命中（已知类别，medium）；非日期近似仍不命中", async () => {
    const catalog = await loadFixtureCatalog();
    const suggestions = resolveModelMetadata(
      { providerId: "custom-proxy", modelId: "gpt-5.2-2026-01-01" },
      catalog
    );
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.every((s) => s.matchKind === "core-model-id")).toBe(true);
    expect(suggestions.every((s) => s.confidence === "medium")).toBe(true);
    // provider 目录来源排在模型事实之前
    expect(suggestions[0]!.model.sourceKind).toBe("models-dev-provider");
    expect(suggestions[0]!.model.catalogKey).toBe("openai/gpt-5.2");
    // 接近但剥不出已知核心的仍不命中
    expect(
      resolveModelMetadata({ providerId: "custom-proxy", modelId: "gpt-5.20" }, catalog)
    ).toEqual([]);
  });

  test("唯一 bare ID 最多返回 low confidence candidate", async () => {
    const catalog = await loadFixtureCatalog();
    const suggestions = resolveModelMetadata(
      { providerId: "custom-proxy", modelId: "unique-model" },
      catalog
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.matchKind).toBe("unique-model-id");
    expect(suggestions[0]!.confidence).toBe("low");
    expect(suggestions[0]!.model.catalogKey).toBe("unique-vendor/unique-model");
  });

  test("歧义 bare ID 经核心 ID 回退返回多候选（medium，封顶 5，稳定排序），无 unique-model-id", async () => {
    const catalog = await loadFixtureCatalog();
    const suggestions = resolveModelMetadata({ providerId: "custom-proxy", modelId: "shared" }, catalog);
    expect(suggestions).toHaveLength(5);
    expect(suggestions.every((s) => s.matchKind === "core-model-id")).toBe(true);
    expect(suggestions.every((s) => s.confidence === "medium")).toBe(true);
    expect(suggestions.map((s) => s.model.catalogKey)).toEqual([
      "aaa/shared",
      "bbb/shared",
      "ccc/shared",
      "ddd/shared",
      "eee/shared"
    ]);
  });

  test("同一查询候选超过 5 条时封顶，排序稳定", () => {
    // 合成目录：6 个 Provider 声明同一 endpoint 与同一 raw model id → 6 个 endpoint-exact 候选
    const providerCatalog = ["fff", "aaa", "eee", "bbb", "ddd", "ccc"].map((providerId) => ({
      catalogKey: `${providerId}/shared-x`,
      providerId,
      modelId: "shared-x",
      providerApi: "https://shared.example/v1",
      contextWindow: 1000,
      sourceKind: "models-dev-provider" as const,
      sourceUrl: MODELS_DEV_API_URL
    }));
    const suggestions = resolveModelMetadata(
      { providerId: "whatever", baseUrl: "https://shared.example/v1", modelId: "shared-x" },
      { modelFacts: [], providerCatalog }
    );
    expect(suggestions).toHaveLength(5);
    expect(suggestions.every((s) => s.matchKind === "endpoint-exact")).toBe(true);
    expect(suggestions.map((s) => s.model.catalogKey)).toEqual([
      "aaa/shared-x",
      "bbb/shared-x",
      "ccc/shared-x",
      "ddd/shared-x",
      "eee/shared-x"
    ]);
  });

  test("latest 不命中；大小写差异经核心 ID 回退命中（medium），精确层级保持大小写敏感", async () => {
    const catalog = await loadFixtureCatalog();
    expect(resolveModelMetadata({ providerId: "custom-proxy", modelId: "latest" }, catalog)).toEqual([]);
    const folded = resolveModelMetadata({ providerId: "custom-proxy", modelId: "GPT-5.2" }, catalog);
    expect(folded.length).toBeGreaterThan(0);
    expect(folded.every((s) => s.matchKind === "core-model-id")).toBe(true);
    expect(folded.every((s) => s.confidence === "medium")).toBe(true);
    // 精确层级不命中（模型 ID 大小写敏感），命中完全来自回退层
    const fromOpenAi = resolveModelMetadata({ providerId: "openai", modelId: "GPT-5.2" }, catalog);
    expect(fromOpenAi.find((s) => s.matchKind === "provider-exact")).toBeUndefined();
    expect(fromOpenAi.every((s) => s.matchKind === "core-model-id")).toBe(true);
  });

  test("baseUrl 仅在声明 api 且标准化后完全匹配时产生 endpoint-exact", async () => {
    const catalog = await loadFixtureCatalog();
    // 命中：endpoint-provider 声明了 https://api.endpoint.example/v1
    const hit = resolveModelMetadata(
      { providerId: "whatever", baseUrl: "https://api.endpoint.example/v1", modelId: "special-model" },
      catalog
    );
    expect(hit[0]?.matchKind).toBe("endpoint-exact");
    expect(hit[0]?.confidence).toBe("high");
    expect(hit[0]?.model.catalogKey).toBe("endpoint-provider/special-model");

    // 末尾斜杠差异仍应命中（标准化）
    const trailing = resolveModelMetadata(
      { providerId: "whatever", baseUrl: "https://api.endpoint.example/v1/", modelId: "special-model" },
      catalog
    );
    expect(trailing[0]?.matchKind).toBe("endpoint-exact");

    // path 不同不命中
    const miss = resolveModelMetadata(
      { providerId: "whatever", baseUrl: "https://api.endpoint.example/v2", modelId: "special-model" },
      catalog
    );
    expect(miss.find((s) => s.matchKind === "endpoint-exact")).toBeUndefined();

    // 未声明 api 的 provider 不能产生 endpoint-exact
    const noApi = resolveModelMetadata(
      { providerId: "whatever", baseUrl: "https://no-api.example/v1", modelId: "local-model" },
      catalog
    );
    expect(noApi.find((s) => s.matchKind === "endpoint-exact")).toBeUndefined();
  });

  test("provider-exact 对 Provider ID 大小写折叠，Model ID 大小写敏感", async () => {
    const catalog = await loadFixtureCatalog();
    // Provider ID 大小写折叠命中 openrouter
    const folded = resolveModelMetadata(
      { providerId: "OpenRouter", modelId: "openai/gpt-5.2" },
      catalog
    );
    expect(folded[0]?.matchKind).toBe("provider-exact");
    // Model ID 大小写不同则不命中 provider-exact
    const caseMismatch = resolveModelMetadata(
      { providerId: "openrouter", modelId: "openai/GPT-5.2" },
      catalog
    );
    expect(caseMismatch.find((s) => s.matchKind === "provider-exact")).toBeUndefined();
  });

  test("同一模型被多种规则命中时按优先级去重，保留高优先级匹配", async () => {
    const catalog = await loadFixtureCatalog();
    const suggestions = resolveModelMetadata(
      { providerId: "openai", modelId: "gpt-5.2" },
      catalog
    );
    // provider-exact（openai provider catalog）+ provider-model-exact（openai/gpt-5.2 model facts）
    const kinds = suggestions.map((s) => s.matchKind);
    expect(kinds).toContain("provider-exact");
    expect(kinds).toContain("provider-model-exact");
    // unique-model-id 与 provider-model-exact 同一 dedup key，被去重
    expect(kinds.filter((k) => k === "unique-model-id")).toHaveLength(0);
    // provider-exact 排最前
    expect(suggestions[0]!.matchKind).toBe("provider-exact");
  });

  test("前缀与大小写差异经核心 ID 回退命中（深度 0，medium）", async () => {
    const catalog = await loadFixtureCatalog();
    const suggestions = resolveModelMetadata(
      { providerId: "custom-proxy", modelId: "zai-org/GLM-5" },
      catalog
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.matchKind).toBe("core-model-id");
    expect(suggestions[0]!.confidence).toBe("medium");
    expect(suggestions[0]!.model.catalogKey).toBe("zhipuai/glm-5");
  });

  test("思考等级后缀剥离命中（medium）", async () => {
    const catalog = await loadFixtureCatalog();
    const suggestions = resolveModelMetadata(
      { providerId: "custom-proxy", modelId: "openai/gpt-5.2-high" },
      catalog
    );
    // 3 个候选：openai provider 目录（raw）+ openai/gpt-5.2 模型事实（raw）+ openrouter 目录 openai/gpt-5.2（core 命中，排最后）
    expect(suggestions.length).toBe(3);
    expect(suggestions.every((s) => s.matchKind === "core-model-id" && s.confidence === "medium")).toBe(true);
    expect(suggestions[0]!.model.sourceKind).toBe("models-dev-provider");
    expect(suggestions[0]!.model.catalogKey).toBe("openai/gpt-5.2");
    expect(suggestions[2]!.model.catalogKey).toBe("openrouter/openai/gpt-5.2");
  });

  test("目录侧带检查点日期时本地无日期 id 命中（medium）", () => {
    const modelFacts = [
      {
        catalogKey: "anthropic/claude-sonnet-4-5-20250929",
        providerId: "anthropic",
        modelId: "claude-sonnet-4-5-20250929",
        contextWindow: 200000,
        sourceKind: "models-dev-model" as const,
        sourceUrl: MODELS_DEV_MODELS_URL
      }
    ];
    const suggestions = resolveModelMetadata(
      { providerId: "custom-proxy", modelId: "claude-sonnet-4-5" },
      { modelFacts, providerCatalog: [] }
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.matchKind).toBe("core-model-id");
    expect(suggestions[0]!.confidence).toBe("medium");
  });

  test("剥离段含未归类段时置信度 low", () => {
    const modelFacts = [
      {
        catalogKey: "moonshotai/kimi-k2",
        providerId: "moonshotai",
        modelId: "kimi-k2",
        contextWindow: 128000,
        sourceKind: "models-dev-model" as const,
        sourceUrl: MODELS_DEV_MODELS_URL
      }
    ];
    const suggestions = resolveModelMetadata(
      { providerId: "custom-proxy", modelId: "kimi-k2-0711-preview" },
      { modelFacts, providerCatalog: [] }
    );
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.matchKind).toBe("core-model-id");
    expect(suggestions[0]!.confidence).toBe("low");
  });

  test("同一深度内 raw 命中排在 core 命中之前", () => {
    const modelFacts = [
      {
        catalogKey: "foo/gpt-4o",
        providerId: "foo",
        modelId: "gpt-4o",
        sourceKind: "models-dev-model" as const,
        sourceUrl: MODELS_DEV_MODELS_URL
      },
      {
        catalogKey: "openai/gpt-4o-2024-08-06",
        providerId: "openai",
        modelId: "gpt-4o-2024-08-06",
        sourceKind: "models-dev-model" as const,
        sourceUrl: MODELS_DEV_MODELS_URL
      }
    ];
    const suggestions = resolveModelMetadata(
      { providerId: "custom-proxy", modelId: "gpt-4o-high" },
      { modelFacts, providerCatalog: [] }
    );
    expect(suggestions.map((s) => s.model.catalogKey)).toEqual(["foo/gpt-4o", "openai/gpt-4o-2024-08-06"]);
  });

  test("最小剥离深度胜出，更深层候选不返回", () => {
    const modelFacts = [
      {
        catalogKey: "x/a-b",
        providerId: "x",
        modelId: "a-b",
        sourceKind: "models-dev-model" as const,
        sourceUrl: MODELS_DEV_MODELS_URL
      },
      {
        catalogKey: "y/a",
        providerId: "y",
        modelId: "a",
        sourceKind: "models-dev-model" as const,
        sourceUrl: MODELS_DEV_MODELS_URL
      }
    ];
    const suggestions = resolveModelMetadata(
      { providerId: "custom-proxy", modelId: "a-b-c" },
      { modelFacts, providerCatalog: [] }
    );
    expect(suggestions.map((s) => s.model.catalogKey)).toEqual(["x/a-b"]);
  });

  test("精确层级已有候选时不产生 core-model-id", async () => {
    const catalog = await loadFixtureCatalog();
    const suggestions = resolveModelMetadata({ providerId: "openai", modelId: "gpt-5.2" }, catalog);
    expect(suggestions.find((s) => s.matchKind === "core-model-id")).toBeUndefined();
  });
});
