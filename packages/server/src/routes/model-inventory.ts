import {
  addModelPolicyRule,
  materializeRuntimeModel,
  normalizeModelRefForStorage,
  removeModelPolicyExactRef,
  removeModelPolicyWildcard,
  writeOpenClawTransaction,
  type OcSwitchPaths
} from "@oc-switch/core";
import type { Hono } from "hono";
import { assertProviderCanEnable, type AppRuntime } from "../context";
import { jsonError } from "../errors";
import {
  requireAddModelPolicyRuleInput,
  requireJsonObject,
  requireMaterializeModelInput,
  requireRemoveModelPolicyWildcardInput,
  requireRemovePolicyExactRefInput
} from "../schemas";

/**
 * 统一模型 inventory 只读端点（spec §10）。
 *
 * - `GET /api/model-inventory`：使用 30s 缓存的 runtime snapshot + 插件 catalog
 *   组装完整 inventory（providers / models / plugins / policyRules / diagnostics / summary）；
 * - `POST /api/model-inventory/refresh`：同时失效两个缓存并强制重新探测，
 *   返回刷新后的完整 inventory（而非只 {ok:true}），让 Web 单次请求即可更新状态。
 *
 * 两端都是只读：不写 openclaw.json/.env、不创建 backup。
 */
export function registerModelInventoryRoutes(app: Hono, runtime: AppRuntime): void {
  app.get("/api/model-inventory", async (c) => {
    try {
      const inventory = await runtime.buildCurrentInventory();
      return c.json(inventory);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/model-inventory/refresh", async (c) => {
    try {
      const inventory = await runtime.buildCurrentInventory({ refresh: true });
      return c.json(inventory);
    } catch (error) {
      return jsonError(c, error);
    }
  });

  /**
   * 写后统一处理：失效两个缓存、重探测一次，返回确认结果与刷新后的 inventory。
   *
   * 写入已成功时绝不把确认失败伪装成整体失败：
   * `ok: true, runtimeConfirmed: false, diagnostics: [...]`。
   */
  async function postWriteConfirmation(paths: OcSwitchPaths): Promise<{
    runtimeConfirmed: boolean;
    diagnostics: { command: string; code: string; message: string }[];
    inventory: Record<string, unknown>;
  }> {
    runtime.invalidateCatalogCaches();
    let inventory;
    try { inventory = await runtime.buildCurrentInventory({ refresh: true, paths }); }
    catch { return { runtimeConfirmed: false, diagnostics: [{ command: "status", code: "invalid-shape", message: "Write succeeded; runtime confirmation failed" }], inventory: {} }; }
    const diagnostics = inventory.diagnostics;
    // 探测完整 = 三项 completeness 全到位；诊断非空视为不完整（provider 抛错降级路径）
    const snapshotComplete = diagnostics.length === 0 && Object.values((await runtime.currentRuntimeModelSnapshot({ paths })).completeness).every(Boolean);
    return {
      runtimeConfirmed: snapshotComplete,
      diagnostics: diagnostics.map((diagnostic) => ({ ...diagnostic })),
      inventory: inventory as unknown as Record<string, unknown>
    };
  }

  app.delete("/api/model-policy/exact-ref", async (c) => {
    try {
      const body = await requireJsonObject(c.req);
      const parsed = requireRemovePolicyExactRefInput(body);
      // warnings 在 mutate 内捕获后经闭包透出（事务只落盘 config）
      const paths = runtime.currentPaths();
      let capturedWarnings: string[] = [];
      const result = await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: `remove policy exact ref ${parsed.ref}`,
        normalizeConfig: false,
        async mutate(config) {
          const inventory = await runtime.buildCurrentInventory({ refresh: true, config, paths });
          const entry = inventory.models.find(model => normalizeModelRefForStorage(model.ref) === normalizeModelRefForStorage(parsed.ref));
          // 精确引用停用只减少选择范围；保护与最后一条规则校验由 Core 执行，不依赖在线可用性。
          const operation = removeModelPolicyExactRef(config, parsed.ref, {
            ...(parsed.removeMetadata === undefined ? {} : { removeMetadata: parsed.removeMetadata })
          });
          capturedWarnings = operation.warnings;
          return operation.config;
        }
      });
      const confirmation = await postWriteConfirmation(paths);
      return c.json({
        ok: true,
        ref: parsed.ref,
        backupId: result.backupDir.split("/").pop(),
        warnings: capturedWarnings,
        ...confirmation
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  // 添加 policy 规则（exact 或 wildcard，spec §4）；守卫全在 Core operation 内
  app.post("/api/model-policy/rules", async (c) => {
    try {
      const body = await requireJsonObject(c.req);
      const parsed = requireAddModelPolicyRuleInput(body);
      // warnings 在 mutate 内捕获后经闭包透出（事务只落盘 config）
      const paths = runtime.currentPaths();
      let capturedWarnings: string[] = [];
      let stored: { rule: string; kind: "exact" | "wildcard" } | undefined;
      const result = await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: `add model policy rule ${parsed.rule}`,
        normalizeConfig: false,
        async mutate(config) {
          const inventory = await runtime.buildCurrentInventory({ refresh: true, config, paths });
          const operation = addModelPolicyRule(config, parsed.rule, {
            knownProviderIds: inventory.providers.map((provider) => provider.providerId)
          });
          capturedWarnings = operation.warnings;
          stored = { rule: operation.rule, kind: operation.kind };
          return operation.config;
        }
      });
      const confirmation = await postWriteConfirmation(paths);
      return c.json({
        ok: true,
        rule: stored!.rule,
        kind: stored!.kind,
        backupId: result.backupDir.split("/").pop(),
        warnings: capturedWarnings,
        ...confirmation
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  // 删除 policy wildcard 规则（按完全相同字符串，含全部重复副本，spec §4）
  app.delete("/api/model-policy/wildcard", async (c) => {
    try {
      const body = await requireJsonObject(c.req);
      const parsed = requireRemoveModelPolicyWildcardInput(body);
      // warnings 在 mutate 内捕获后经闭包透出（事务只落盘 config）
      const paths = runtime.currentPaths();
      let capturedWarnings: string[] = [];
      let removedCount = 0;
      const result = await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: `remove model policy wildcard ${parsed.value}`,
        normalizeConfig: false,
        async mutate(config) {
          const inventory = await runtime.buildCurrentInventory({ refresh: true, config, paths });
          const operation = removeModelPolicyWildcard(config, parsed.value, { inventory });
          capturedWarnings = operation.warnings;
          removedCount = operation.removedCount;
          return operation.config;
        }
      });
      const confirmation = await postWriteConfirmation(paths);
      return c.json({
        ok: true,
        value: parsed.value,
        removedCount,
        backupId: result.backupDir.split("/").pop(),
        warnings: capturedWarnings,
        ...confirmation
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });

  app.post("/api/models/materialize", async (c) => {
    try {
      const body = await requireJsonObject(c.req);
      const parsed = requireMaterializeModelInput(body);
      // inventory entry 由 server 端按 ref 从当前 inventory 取，不信客户端的可用性断言；
      // operation 自身会重新校验（availability / provider / 目录冲突）
      // warnings 在 mutate 内捕获后经闭包透出（事务只落盘 config）
      const paths = runtime.currentPaths();
      let capturedWarnings: string[] = [];
      const result = await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: runtime.runtimeDiscoveryProvider,
        reason: `materialize runtime model ${parsed.ref}`,
        normalizeConfig: false,
        async mutate(config) {
          const inventory = await runtime.buildCurrentInventory({ refresh: true, config, paths });
          const entry = inventory.models.find(model => normalizeModelRefForStorage(model.ref) === normalizeModelRefForStorage(parsed.ref));
          if (!entry) throw new Error(`Model ${parsed.ref} not found in current inventory.`);
          assertProviderCanEnable(paths, entry.providerId);
          const operation = materializeRuntimeModel(config, entry, parsed.input);
          capturedWarnings = operation.warnings;
          return operation.config;
        }
      });
      const confirmation = await postWriteConfirmation(paths);
      return c.json({
        ok: true,
        ref: parsed.ref,
        backupId: result.backupDir.split("/").pop(),
        warnings: capturedWarnings,
        ...confirmation
      });
    } catch (error) {
      return jsonError(c, error);
    }
  });
}
