import { resolveModelMetadataSuggestions } from "@oc-switch/core";
import type { Hono } from "hono";
import { readConfig, type AppRuntime } from "../context";
import { jsonError } from "../errors";
import { requireModelMetadataSuggestionsQuery } from "../schemas";

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
}
