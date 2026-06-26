import {
  addProviderModel,
  createConfigAdapter,
  disableModel,
  enableModel,
  parseModelRef,
  removeProviderModel,
  setPrimaryModel,
  updateProviderModel,
  writeOpenClawTransaction
} from "@oc-switch/core";
import type { Hono } from "hono";
import { assertProviderCanEnable, readConfig, type AppRuntime } from "../context";
import { jsonError } from "../errors";
import { requireBoolean, requireProviderModelInput, requireString } from "../schemas";

export function registerModelRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/models", (c) => {
    const adapter = createConfigAdapter(readConfig(runtime.currentPaths()));
    return c.json({ models: adapter.listModels() });
  });

  app.put("/api/models/primary", async (c) => {
    try {
      const body = await c.req.json();
      const ref = requireString(body.ref, "ref");
      const result = await writeOpenClawTransaction({
        ...runtime.currentPaths(),
        reason: `set primary model ${ref}`,
        mutate(config) {
          return setPrimaryModel(config, ref).config;
        }
      });
      return c.json({ ok: true, ref, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.patch("/api/models", async (c) => {
    try {
      const body = await c.req.json();
      const ref = requireString(body.ref, "ref");
      const enabled = requireBoolean(body.enabled, "enabled");
      if (enabled) {
        assertProviderCanEnable(runtime.currentPaths(), parseModelRef(ref).providerId);
      }
      const result = await writeOpenClawTransaction({
        ...runtime.currentPaths(),
        reason: enabled ? `enable model ${ref}` : `disable model ${ref}`,
        mutate(config) {
          return enabled ? enableModel(config, ref, body.alias).config : disableModel(config, ref).config;
        }
      });
      return c.json({ ok: true, ref, enabled, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/models", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const providerId = requireString(body.providerId, "providerId");
      const model = requireProviderModelInput(body.model);
      if (model.enabled) {
        assertProviderCanEnable(runtime.currentPaths(), providerId);
      }
      const ref = `${providerId}/${model.id}`;
      const result = await writeOpenClawTransaction({
        ...runtime.currentPaths(),
        reason: `add model ${ref}`,
        mutate(config) {
          return addProviderModel(config, providerId, model).config;
        }
      });
      return c.json({ ok: true, ref, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.put("/api/models", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const ref = requireString(body.ref, "ref");
      const model = requireProviderModelInput(body.model);
      if (model.enabled) {
        assertProviderCanEnable(runtime.currentPaths(), parseModelRef(ref).providerId);
      }
      const result = await writeOpenClawTransaction({
        ...runtime.currentPaths(),
        reason: `edit model ${ref}`,
        mutate(config) {
          return updateProviderModel(config, ref, model).config;
        }
      });
      return c.json({ ok: true, ref, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.delete("/api/models", async (c) => {
    try {
      const body = await c.req.json() as Record<string, unknown>;
      const ref = requireString(body.ref, "ref");
      const removeOptions: { force: boolean; newPrimary?: string } = {
        force: Boolean(body.force)
      };
      if (body.newPrimary !== undefined) {
        removeOptions.newPrimary = requireString(body.newPrimary, "newPrimary");
      }
      const result = await writeOpenClawTransaction({
        ...runtime.currentPaths(),
        reason: `remove model ${ref}`,
        mutate(config) {
          return removeProviderModel(config, ref, removeOptions).config;
        }
      });
      return c.json({ ok: true, ref, backupId: result.backupDir.split("/").pop() });
    } catch (error) {
      return jsonError(c, error);
    }
  });
}
