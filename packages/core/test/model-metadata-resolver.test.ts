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

  test("arbitrary Provider + bare gpt-* 不因字符串相似度自动映射", async () => {
    const catalog = await loadFixtureCatalog();
    // 带日期后缀的近似 ID 不应命中 gpt-5.2
    expect(
      resolveModelMetadata({ providerId: "custom-proxy", modelId: "gpt-5.2-2026-01-01" }, catalog)
    ).toEqual([]);
    // 接近但不相等
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

  test("歧义 bare ID（多个同名候选）不产生 unique-model-id 匹配", async () => {
    const catalog = await loadFixtureCatalog();
    // fixture 中 shared 有 6 个厂商候选：不得返回列表靠前者，避免误用错误厂商参数
    expect(resolveModelMetadata({ providerId: "custom-proxy", modelId: "shared" }, catalog)).toEqual([]);
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

  test("latest、日期后缀、大小写近似不得被改写猜测", async () => {
    const catalog = await loadFixtureCatalog();
    expect(resolveModelMetadata({ providerId: "custom-proxy", modelId: "latest" }, catalog)).toEqual([]);
    // 大小写近似不命中（模型 ID 大小写敏感）
    expect(resolveModelMetadata({ providerId: "custom-proxy", modelId: "GPT-5.2" }, catalog)).toEqual([]);
    expect(resolveModelMetadata({ providerId: "openai", modelId: "GPT-5.2" }, catalog)).toEqual([]);
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
});
