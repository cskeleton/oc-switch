// packages/core/test/model-metadata-sync.test.ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import modelsFixture from "./fixtures/model-metadata/models.json";
import apiFixture from "./fixtures/model-metadata/api.json";
import {
  applyModelMetadataSyncPlan,
  planProviderModelMetadataSync,
  recordModelMetadataSyncQueue,
  resolveModelMetadataQueue
} from "../src/model-metadata-sync";
import { normalizeConfigForStorage } from "../src/config-normalization";
import { readModelMetadataQueue } from "../src/model-metadata-queue";
import { MODELS_DEV_API_URL, MODELS_DEV_MODELS_URL } from "../src/model-metadata-catalog";
import type { FetchImpl } from "../src/provider-sync";
import type { OpenClawConfig } from "../src/types";

const BASE_NOW = Date.parse("2026-09-05T00:00:00.000Z");

function fixtureFetch(): FetchImpl {
  return async (input) => {
    const url = String(input);
    if (url === MODELS_DEV_MODELS_URL) return new Response(JSON.stringify(modelsFixture), { status: 200 });
    if (url === MODELS_DEV_API_URL) return new Response(JSON.stringify(apiFixture), { status: 200 });
    throw new Error(`unexpected url: ${url}`);
  };
}

function tempStateDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "oc-switch-mmsync-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** endpoint-provider/special-model：provider-exact 与 endpoint-exact 命中同一条目，去重后唯一 high */
function endpointConfig(): OpenClawConfig {
  return {
    models: { providers: { "endpoint-provider": {
      baseUrl: "https://api.endpoint.example/v1",
      models: [
        { id: "special-model" },
        { id: "full", name: "n", reasoning: true, contextWindow: 1, maxTokens: 1, input: ["text"] }
      ]
    } } },
    agents: { defaults: { models: { "endpoint-provider/special-model": { alias: "keep" } } } }
  };
}

describe("planProviderModelMetadataSync", () => {
  test("唯一 high 置信 → applies；五项齐全 → skipped；未知 modelIds → throw", async () => {
    const { dir, cleanup } = tempStateDir();
    try {
      const config = endpointConfig();
      const plan = await planProviderModelMetadataSync(config, { providerId: "endpoint-provider" }, { stateDir: dir, fetchImpl: fixtureFetch(), now: () => BASE_NOW });
      expect(plan.providerId).toBe("endpoint-provider");
      expect(plan.applies.map((a) => a.modelId)).toEqual(["special-model"]);
      expect(plan.applies[0]!.catalogKey).toBe("endpoint-provider/special-model");
      expect(plan.skipped).toEqual(["full"]);
      expect(plan.queued).toEqual([]);
      expect(plan.unmatched).toEqual([]);
      await expect(
        planProviderModelMetadataSync(config, { providerId: "endpoint-provider", modelIds: ["nope"] }, { stateDir: dir, fetchImpl: fixtureFetch(), now: () => BASE_NOW })
      ).rejects.toThrow("not found");
    } finally {
      cleanup();
    }
  });

  test("多条 high 建议（provider-exact + model-key-exact  corroborating）也入队，不自动应用", async () => {
    const { dir, cleanup } = tempStateDir();
    try {
      const config: OpenClawConfig = {
        models: { providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1", models: [{ id: "openai/gpt-5.2" }] } } }
      };
      const plan = await planProviderModelMetadataSync(config, { providerId: "openrouter" }, { stateDir: dir, fetchImpl: fixtureFetch(), now: () => BASE_NOW });
      expect(plan.applies).toEqual([]);
      expect(plan.queued).toHaveLength(1);
      expect(plan.queued[0]!.modelId).toBe("openai/gpt-5.2");
      expect(plan.queued[0]!.candidates.length).toBeGreaterThanOrEqual(2);
      for (const candidate of plan.queued[0]!.candidates) {
        expect(candidate.score).toBe(1);
        expect(candidate.reason).toMatch(/^resolver-/);
      }
    } finally {
      cleanup();
    }
  });

  test("core-model-id 多候选（medium）→ queued；两级全落空 → unmatched", async () => {
    const { dir, cleanup } = tempStateDir();
    try {
      const config: OpenClawConfig = {
        models: { providers: { openrouter: { baseUrl: "https://openrouter.ai/api/v1", models: [
          { id: "shared" },               // models.json 有 6 条 shared → 多候选 medium
          { id: "qxzjv-7274" }            // 实测对 fixture 全部条目模糊得分 < 0.34（best 0.0965），两级均落空
        ] } } }
      };
      const plan = await planProviderModelMetadataSync(config, { providerId: "openrouter" }, { stateDir: dir, fetchImpl: fixtureFetch(), now: () => BASE_NOW });
      expect(plan.queued.map((item) => item.modelId)).toEqual(["shared"]);
      expect(plan.queued[0]!.candidates[0]!.reason).toBe("resolver-core-model-id");
      expect(plan.queued[0]!.candidates.length).toBeLessThanOrEqual(5);
      expect(plan.unmatched).toEqual(["qxzjv-7274"]);
    } finally {
      cleanup();
    }
  });

  test("resolver 全落空 → 模糊层命中 anthropic/claude-sonnet-4.5 → queued（非 resolver- reason）", async () => {
    const { dir, cleanup } = tempStateDir();
    try {
      const config: OpenClawConfig = {
        models: { providers: { custom: { models: [{ id: "claude-sonnet-4.6" }] } } }
      };
      const plan = await planProviderModelMetadataSync(config, { providerId: "custom" }, { stateDir: dir, fetchImpl: fixtureFetch(), now: () => BASE_NOW });
      expect(plan.applies).toEqual([]);
      expect(plan.queued).toHaveLength(1);
      const top = plan.queued[0]!.candidates[0]!;
      expect(top.catalogKey).toBe("anthropic/claude-sonnet-4.5");
      expect(top.score).toBeGreaterThanOrEqual(0.55);
      expect(top.reason).toBe("shared-model-tokens");
    } finally {
      cleanup();
    }
  });

  test("目录两源均不可用 → throw 且零写入", async () => {
    const { dir, cleanup } = tempStateDir();
    try {
      const failingFetch: FetchImpl = async () => { throw new Error("offline"); };
      await expect(
        planProviderModelMetadataSync(endpointConfig(), { providerId: "endpoint-provider" }, { stateDir: dir, fetchImpl: failingFetch, now: () => BASE_NOW })
      ).rejects.toThrow("Models.dev 目录不可用");
      // 队列文件不应被创建
      expect(readModelMetadataQueue(dir).items).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("applyModelMetadataSyncPlan", () => {
  test("fill 在 apply 时按当前条目共算：plan 后被手工填上的字段不会被覆盖", async () => {
    const { dir, cleanup } = tempStateDir();
    try {
      const config = endpointConfig();
      const plan = await planProviderModelMetadataSync(config, { providerId: "endpoint-provider" }, { stateDir: dir, fetchImpl: fixtureFetch(), now: () => BASE_NOW });
      // plan 之后用户手工填了 contextWindow
      const model = config.models!.providers!["endpoint-provider"]!.models![0]!;
      model.contextWindow = 32000;
      const { updated } = applyModelMetadataSyncPlan(config, plan);
      expect(updated).toHaveLength(1);
      expect(updated[0]!.filled).toEqual({ name: "Special Model", maxTokens: 8192 }); // fixture 无 reasoning/modalities
      expect(model.contextWindow).toBe(32000);
    } finally {
      cleanup();
    }
  });

  test("不动 allowlist / 其它 provider 条目", async () => {
    const { dir, cleanup } = tempStateDir();
    try {
      const config = endpointConfig();
      const plan = await planProviderModelMetadataSync(config, { providerId: "endpoint-provider" }, { stateDir: dir, fetchImpl: fixtureFetch(), now: () => BASE_NOW });
      applyModelMetadataSyncPlan(config, plan);
      expect(config.agents?.defaults?.models).toEqual({ "endpoint-provider/special-model": { alias: "keep" } });
      expect(config.models?.providers?.["endpoint-provider"]?.models?.[1]).toEqual(
        { id: "full", name: "n", reasoning: true, contextWindow: 1, maxTokens: 1, input: ["text"] }
      );
    } finally {
      cleanup();
    }
  });
});

describe("recordModelMetadataSyncQueue + resolveModelMetadataQueue", () => {
  test("queued 写入队列；accept 落盘并移除；dismiss 仅标记；孤儿 accept 报 failed 并移除", async () => {
    const { dir, cleanup } = tempStateDir();
    try {
      const config: OpenClawConfig = {
        models: { providers: { custom: { models: [{ id: "claude-sonnet-4.6" }] } } }
      };
      const plan = await planProviderModelMetadataSync(config, { providerId: "custom" }, { stateDir: dir, fetchImpl: fixtureFetch(), now: () => BASE_NOW });
      expect(plan.applies).toEqual([]);
      recordModelMetadataSyncQueue(dir, plan, "2026-09-05T00:00:00.000Z");
      let queue = readModelMetadataQueue(dir);
      expect(queue.items).toHaveLength(1);
      expect(queue.items[0]!.dismissed).toBe(false);

      // dismiss：仅标记，仍在队列
      const dismissed = resolveModelMetadataQueue(config, queue, [{ providerId: "custom", modelId: "claude-sonnet-4.6", action: "dismiss" }]);
      expect(dismissed.dismissedCount).toBe(1);
      expect(dismissed.configChanged).toBe(false);
      expect(dismissed.queue.items[0]!.dismissed).toBe(true);

      // accept：填字段、configChanged、从队列移除
      const accepted = resolveModelMetadataQueue(config, dismissed.queue, [
        { providerId: "custom", modelId: "claude-sonnet-4.6", action: "accept", catalogKey: "anthropic/claude-sonnet-4.5" }
      ]);
      expect(accepted.configChanged).toBe(true);
      expect(accepted.applied[0]!.filled).toEqual({
        name: "Claude Sonnet 4.5", reasoning: true, contextWindow: 200000, maxTokens: 64000, input: ["text", "image"]
      });
      expect(accepted.queue.items).toHaveLength(0);
      expect(config.models!.providers!["custom"]!.models![0]!.contextWindow).toBe(200000);

      // 孤儿：模型被删除后 accept → failed 且队列项移除
      recordModelMetadataSyncQueue(dir, plan, "2026-09-05T01:00:00.000Z");
      queue = readModelMetadataQueue(dir);
      config.models!.providers!["custom"]!.models = [];
      const orphan = resolveModelMetadataQueue(config, queue, [
        { providerId: "custom", modelId: "claude-sonnet-4.6", action: "accept", catalogKey: "anthropic/claude-sonnet-4.5" }
      ]);
      expect(orphan.failed).toHaveLength(1);
      expect(orphan.queue.items).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("队列项存归一化前的大写 providerId：accept/dismiss 跨大小写命中，重新入队不产生重复项", async () => {
    const { dir, cleanup } = tempStateDir();
    try {
      // 归一化前：config key 为大写 CUSTOM，plan 与入队都使用原始 key
      const config: OpenClawConfig = {
        models: { providers: { CUSTOM: { models: [{ id: "claude-sonnet-4.6" }] } } }
      };
      const plan = await planProviderModelMetadataSync(config, { providerId: "custom" }, { stateDir: dir, fetchImpl: fixtureFetch(), now: () => BASE_NOW });
      expect(plan.providerId).toBe("CUSTOM");
      recordModelMetadataSyncQueue(dir, plan, "2026-09-05T00:00:00.000Z");
      let queue = readModelMetadataQueue(dir);
      expect(queue.items).toHaveLength(1);
      expect(queue.items[0]!.providerId).toBe("CUSTOM");

      // 任意写事务后 config key 被归一化为小写
      expect(normalizeConfigForStorage(config).changed).toBe(true);
      expect(config.models!.providers!["custom"]).toBeTruthy();

      // accept 传小写（当前 config key）：命中大写队列项，字段回填、队列移除
      const accepted = resolveModelMetadataQueue(config, queue, [
        { providerId: "custom", modelId: "claude-sonnet-4.6", action: "accept", catalogKey: "anthropic/claude-sonnet-4.5" }
      ]);
      expect(accepted.failed).toEqual([]);
      expect(accepted.configChanged).toBe(true);
      expect(accepted.applied).toHaveLength(1);
      expect(accepted.queue.items).toHaveLength(0);
      expect(config.models!.providers!["custom"]!.models![0]!.contextWindow).toBe(200000);

      // resolve 是纯函数不落盘：队列文件里的旧项再 sync 时被折叠 upsert 覆盖，不产生第二条
      recordModelMetadataSyncQueue(dir, plan, "2026-09-05T01:00:00.000Z");
      queue = readModelMetadataQueue(dir);
      expect(queue.items).toHaveLength(1);
      expect(queue.items[0]!.lastSeenAt).toBe("2026-09-05T01:00:00.000Z");

      // dismiss 传大写（resolveProviderId 返回小写）：折叠后仍命中同一队列项
      const dismissed = resolveModelMetadataQueue(config, queue, [
        { providerId: "CUSTOM", modelId: "claude-sonnet-4.6", action: "dismiss" }
      ]);
      expect(dismissed.failed).toEqual([]);
      expect(dismissed.dismissedCount).toBe(1);
      expect(dismissed.queue.items[0]!.dismissed).toBe(true);
    } finally {
      cleanup();
    }
  });
});
