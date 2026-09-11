import {
  addProviderModel,
  createConfigAdapter,
  disableModel,
  enableModel,
  normalizeModelRefForStorage,
  parseModelRef,
  removeProviderModel,
  setPrimaryModel,
  updateProviderModel,
  writeOpenClawTransaction
} from "@oc-switch/core";
import type { Hono } from "hono";
import { assertProviderCanEnable, readConfig, readDisabledProviderIds, type AppRuntime } from "../context";
import { jsonError } from "../errors";
import { optionalString, requireBoolean, requireBooleanDefault, requireJsonObject, requireProviderModelInput, requireString } from "../schemas";

export function registerModelRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/models", (c) => {
    const paths = runtime.currentPaths();
    const adapter = createConfigAdapter(readConfig(paths), {
      disabledProviderIds: readDisabledProviderIds(paths),
      pluginProviders: runtime.currentPluginProviders()
    });
    return c.json({ models: adapter.listModels() });
  });

  // 目录写入后的缓存失效（Task 9 修复）：模型增删改改变了 config，30s TTL 的
  // 运行时 snapshot 若不失效，新添加的模型会按「旧目录证据」被判
  // `unavailable/model-not-in-catalog` 落入待处理区段、编辑/删除入口不可达
  // （Task 8 迁移后 Models 页完全由 inventory 驱动，该竞态是真实回归）。
  // 与插件启停 / exact-ref 删除 / materialize 端点的 post-write 行为对齐。

  app.put("/api/models/primary", async (c) => {
    try {
      const body = await requireJsonObject(c.req);
      const ref = requireString(body.ref, "ref");
      const paths = runtime.currentPaths();
      const result = await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: `set primary model ${ref}`,
        mutate(config) {
          const entry = runtime.buildCurrentInventory({ refresh: true, config, paths }).models.find(row => normalizeModelRefForStorage(row.ref) === normalizeModelRefForStorage(ref));
          if (!entry) throw new Error(`Model ${ref} not found in current inventory.`);
          assertProviderCanEnable(paths, entry.providerId);
          return setPrimaryModel(config, ref, runtime.currentPluginProviders({ paths }), entry).config;
        }
      });
      runtime.invalidateCatalogCaches();
      return c.json({ ok: true, ref, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.patch("/api/models", async (c) => {
    try {
      const body = await requireJsonObject(c.req);
      const ref = requireString(body.ref, "ref");
      const enabled = requireBoolean(body.enabled, "enabled");
      const alias = optionalString(body.alias, "alias");
      const paths = runtime.currentPaths();
      const result = await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: enabled ? `enable model ${ref}` : `disable model ${ref}`,
        mutate(config) {
          const entry = runtime.buildCurrentInventory({ refresh: true, config, paths }).models.find(row => normalizeModelRefForStorage(row.ref) === normalizeModelRefForStorage(ref));
          if (!entry) throw new Error(`Model ${ref} not found in current inventory.`);
          if (enabled) {
            assertProviderCanEnable(paths, entry.providerId);
            return enableModel(config, ref, alias, runtime.currentPluginProviders({ paths }), entry).config;
          }
          if (entry.availability !== "available") throw new Error(`Runtime model availability is ${entry.availability}; use reference reconciliation instead of disabling.`);
          return disableModel(config, ref).config;
        }
      });
      runtime.invalidateCatalogCaches();
      return c.json({ ok: true, ref, enabled, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/models", async (c) => {
    try {
      const body = await requireJsonObject(c.req);
      const providerId = requireString(body.providerId, "providerId");
      const model = requireProviderModelInput(body.model);
      if (model.enabled) {
        assertProviderCanEnable(runtime.currentPaths(), providerId);
      }
      const ref = `${providerId}/${model.id}`;
      const result = await writeOpenClawTransaction({
        ...runtime.currentPaths(),
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: `add model ${ref}`,
        mutate(config) {
          return addProviderModel(config, providerId, model).config;
        }
      });
      runtime.invalidateCatalogCaches();
      return c.json({ ok: true, ref, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.put("/api/models", async (c) => {
    try {
      const body = await requireJsonObject(c.req);
      const ref = requireString(body.ref, "ref");
      const model = requireProviderModelInput(body.model);
      const paths = runtime.currentPaths();
      const result = await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: `edit model ${ref}`,
        mutate(config) {
          const entry = runtime.buildCurrentInventory({ refresh: true, config, paths }).models.find(row => normalizeModelRefForStorage(row.ref) === normalizeModelRefForStorage(ref));
          if (entry?.availability === "unknown") throw new Error("Runtime model availability is unknown; refresh before editing its catalog entry.");
          if (model.enabled) assertProviderCanEnable(paths, parseModelRef(ref).providerId);
          return updateProviderModel(config, ref, model).config;
        }
      });
      runtime.invalidateCatalogCaches();
      return c.json({ ok: true, ref, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.delete("/api/models", async (c) => {
    try {
      const body = await requireJsonObject(c.req);
      const ref = requireString(body.ref, "ref");
      const removeOptions: { force: boolean; newPrimary?: string } = {
        force: requireBooleanDefault(body.force, "force", false)
      };
      if (body.newPrimary !== undefined) {
        removeOptions.newPrimary = requireString(body.newPrimary, "newPrimary");
      }
      const paths = runtime.currentPaths();
      const result = await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: `remove model ${ref}`,
        mutate(config) {
          const entry = runtime.buildCurrentInventory({ refresh: true, config, paths }).models.find(row => normalizeModelRefForStorage(row.ref) === normalizeModelRefForStorage(ref));
          if (entry?.availability === "unknown") throw new Error("Runtime model availability is unknown; refresh before removing its catalog entry.");
          return removeProviderModel(config, ref, removeOptions).config;
        }
      });
      runtime.invalidateCatalogCaches();
      return c.json({ ok: true, ref, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });
}
