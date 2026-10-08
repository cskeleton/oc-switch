import { buildModelConfigSnapshot, buildPluginExtensionsSnapshot, readManifest } from "@oc-switch/core";
import type { Hono } from "hono";
import { readConfig, readDisabledProviderIds, readEnvContent, type AppRuntime } from "../context";

export function registerModelConfigRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/model-config", c => {
    const paths = runtime.currentPaths();
    return c.json(buildModelConfigSnapshot({
      config: readConfig(paths),
      envContent: readEnvContent(paths) ?? "",
      disabledProviderIds: readDisabledProviderIds(paths),
      manifest: readManifest(paths.stateDir)
    }));
  });

  app.get("/api/model-extensions", async c => {
    // 与完整 inventory 共用插件缓存/在途请求，本入口不读取运行时模型目录。
    const catalog = await runtime.currentPluginCatalog();
    return c.json(buildPluginExtensionsSnapshot(catalog));
  });
}
