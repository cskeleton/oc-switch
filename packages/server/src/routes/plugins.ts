import { setModelPluginEnabled, writeOpenClawTransaction } from "@oc-switch/core";
import type { Hono } from "hono";
import type { AppRuntime } from "../context";
import { jsonError } from "../errors";
import { requireJsonObject, requirePluginStateInput } from "../schemas";

/**
 * 插件级启停端点（spec §9 / Task 5）。
 *
 * 安全边界（Task 4 review 裁定，binding）：core 的 `setModelPluginEnabled` 信任
 * 传入的 descriptor（不存在已安装注册表），因此 server 必须把 `:pluginId` 解析到
 * **当前发现的** `plugins: ModelPluginDescriptor[]`，未知 id → 404，且不触碰配置文件。
 * 该边界保证只有「已安装插件」可被启停，杜绝凭空注入 descriptor。
 *
 * `confirm: true` 必填（400），写入口统一 `writeOpenClawTransaction`；
 * 写入成功但确认探测失败/不完整 → `ok: true, runtimeConfirmed: false`，
 * 绝不把已完成写入伪装成整体失败。
 */
class UnknownModelPluginError extends Error {}

export function registerPluginRoutes(app: Hono, runtime: AppRuntime): void {
  app.patch("/api/plugins/:pluginId/state", async (c) => {
    try {
      const pluginId = c.req.param("pluginId");
      const body = await requireJsonObject(c.req);
      const { enabled } = requirePluginStateInput(body);

      const paths = runtime.currentPaths();
      let capturedWarnings: string[] = [];
      let affectedProviderIds: string[] = [];

      const result = await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: `${enabled ? "enable" : "disable"} plugin ${pluginId}`,
        normalizeConfig: false,
        mutate(config) {
          // Core 可能因文件变化重新执行 mutate，每次都必须重新发现 descriptor。
          runtime.invalidateCatalogCaches();
          const catalog = runtime.currentPluginCatalog({ paths });
          if (catalog.diagnostics.length > 0) throw new Error("Plugin catalog is incomplete; refresh before changing plugin state.");
          const descriptor = catalog.plugins.find((plugin) => plugin.id === pluginId);
          if (!descriptor) throw new UnknownModelPluginError(`Plugin ${pluginId} is not installed or does not contribute any model provider; oc-switch only manages installed model plugins.`);
          const operation = setModelPluginEnabled(config, descriptor, enabled);
          affectedProviderIds = [...new Set(descriptor.providerIds)].sort();
          capturedWarnings = operation.warnings;
          return operation.config;
        }
      });

      // 写后：同时失效两个缓存（插件状态 + 运行时模型目录），避免新插件状态与旧模型目录混用
      runtime.invalidateCatalogCaches();
      let runtimeConfirmed = false;
      let diagnostics: { command: string; code: string; message: string }[];
      try {
        const inventory = runtime.buildCurrentInventory({ refresh: true, paths });
        diagnostics = inventory.diagnostics;
        runtimeConfirmed = diagnostics.length === 0 && Object.values(runtime.currentRuntimeModelSnapshot({ paths }).completeness).every(Boolean) &&
          inventory.plugins.some(plugin => plugin.id === pluginId && plugin.enabled === enabled);
      } catch {
        diagnostics = [{ command: "status", code: "invalid-shape", message: "Write succeeded; runtime confirmation failed" }];
      }

      return c.json({
        ok: true,
        pluginId,
        enabled,
        backupId: result.backupDir.split("/").pop(),
        affectedProviderIds,
        warnings: capturedWarnings,
        runtimeConfirmed,
        diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic }))
      });
    } catch (error) {
      if (error instanceof UnknownModelPluginError) return c.json({ error: error.message }, 404);
      return jsonError(c, error);
    }
  });
}
