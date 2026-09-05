import {
  normalizeProviderId,
  readModelMetadataQueue,
  resolveModelMetadataQueue,
  resolveModelMetadataSuggestions,
  writeModelMetadataQueue,
  writeOpenClawTransaction
} from "@oc-switch/core";
import type { Hono } from "hono";
import { readConfig, type AppRuntime } from "../context";
import { jsonError } from "../errors";
import { requireModelMetadataQueueResolveInput, requireModelMetadataSuggestionsQuery } from "../schemas";

/**
 * 只读模型元数据建议端点。
 *
 * 只下载固定的公开 Models.dev JSON；Provider/baseUrl 仅在本地参与匹配，
 * 绝不拼进外发请求。查询不写 openclaw.json/.env，也不创建 backup。
 */
export function registerModelMetadataRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/model-metadata/suggestions", async (c) => {
    try {
      const query = requireModelMetadataSuggestionsQuery({
        providerId: c.req.query("providerId"),
        modelId: c.req.query("modelId"),
        refresh: c.req.query("refresh")
      });

      // Provider 必须已存在于当前配置；未知 Provider 直接 4xx，不访问 Models.dev
      const config = readConfig(runtime.currentPaths());
      const provider = config.models?.providers?.[query.providerId];
      if (!provider) {
        return c.json({ error: `Provider ${query.providerId} not found` }, 404);
      }

      const baseUrl = provider.baseUrl?.trim() || undefined;
      const result = await resolveModelMetadataSuggestions(
        {
          providerId: query.providerId,
          ...(baseUrl !== undefined ? { baseUrl } : {}),
          modelId: query.modelId
        },
        {
          stateDir: runtime.currentPaths().stateDir,
          fetchImpl: runtime.fetchImpl,
          ...(query.refresh ? { forceRefresh: true } : {})
        }
      );

      return c.json({
        suggestions: result.suggestions,
        sources: result.sources,
        warnings: result.warnings
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.get("/api/model-metadata/sync-queue", async (c) => {
    try {
      const providerId = c.req.query("providerId")?.trim();
      const queue = readModelMetadataQueue(runtime.currentPaths().stateDir);
      // providerId 过滤大小写折叠：队列项可能存着归一化前的大写 key
      const items = providerId
        ? queue.items.filter((item) => normalizeProviderId(item.providerId) === normalizeProviderId(providerId))
        : queue.items;
      return c.json({ items });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/model-metadata/sync-queue/resolve", async (c) => {
    try {
      const body = (await c.req.json()) as Record<string, unknown>;
      const input = requireModelMetadataQueueResolveInput(body);
      const paths = runtime.currentPaths();
      // 先试算（不落盘）：无实际字段变更（纯 dismiss / accept 但字段已齐）只更新队列文件，不走写事务
      const preview = resolveModelMetadataQueue(readConfig(paths), readModelMetadataQueue(paths.stateDir), input.items);
      if (!preview.configChanged) {
        writeModelMetadataQueue(paths.stateDir, preview.queue);
        return c.json({ ok: true, applied: preview.applied, dismissedCount: preview.dismissedCount, failed: preview.failed });
      }
      let resolved = preview;
      const result = await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: "resolve model metadata sync queue",
        mutate(config) {
          resolved = resolveModelMetadataQueue(config, readModelMetadataQueue(paths.stateDir), input.items);
          return resolved.config;
        },
        afterWrite() {
          writeModelMetadataQueue(paths.stateDir, resolved.queue);
        }
      });
      return c.json({
        ok: true,
        applied: resolved.applied,
        dismissedCount: resolved.dismissedCount,
        failed: resolved.failed,
        backupId: result.backupDir.split("/").pop()
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });
}
