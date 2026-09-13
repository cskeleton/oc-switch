import {
  addModelPolicyRule,
  addProviderModel,
  createConfigAdapter,
  disableModel,
  enableModel,
  materializeRuntimeModel,
  normalizeModelRefForStorage,
  parseModelRef,
  removeModelPolicyExactRef,
  removeModelPolicyWildcard,
  removeProviderModel,
  readProviderStates,
  setPrimaryModel,
  writeOpenClawTransaction,
  type ModelInventory,
  type ModelInventoryEntry
} from "@oc-switch/core";
import type { Command } from "commander";
import type { CommandContext } from "../command-context";
import { commandErrorMessage } from "../errors";

/** inventory 表格行：ref / policy / availability / reason / sources（spec §6.1 五列事实） */
function printInventoryRow(entry: ModelInventoryEntry): void {
  const policy = entry.selectionSource ?? (entry.policyAllowed ? "allowed" : "-");
  const reasons = entry.availabilityReasons.join(",") || "-";
  const sources = entry.catalogSources.join(",");
  console.log(`${entry.ref}\t${policy}\t${entry.availability}\t${reasons}\t${sources}`);
}

function printInventoryTable(inventory: ModelInventory): void {
  console.log("ref\tpolicy\tavailability\treason\tsources");
  for (const entry of inventory.models) printInventoryRow(entry);
  const { modelCount, availableCount, unavailableCount, unknownCount } = inventory.summary;
  console.log(`# models=${modelCount} available=${availableCount} unavailable=${unavailableCount} unknown=${unknownCount}`);
  for (const diagnostic of inventory.diagnostics) {
    // 探测诊断是信息性事实（部分失败不阻断主流程），走 stdout 便于机器可读
    console.log(`diagnostic: ${diagnostic.message}`);
  }
}

/** 从 inventory 里按 ref 找模型行（Provider 折叠 + model 大小写敏感，与 server 的 materialize 路由一致） */
function findInventoryEntry(inventory: ModelInventory, ref: string): ModelInventoryEntry | undefined {
  return inventory.models.find(
    (model) => normalizeModelRefForStorage(model.ref) === normalizeModelRefForStorage(ref)
  );
}

/** 供 CLI 销毁性操作做 fail-closed 非交互确认（与 sync push 同款约束） */
function requireNonInteractiveYes(command: string, confirmed: boolean | undefined): void {
  if (confirmed) return;
  if (!process.stdin.isTTY) {
    throw new Error(`非交互环境必须显式 --yes 确认${command}（fail closed，未写入任何内容）`);
  }
  throw new Error(`请使用 --yes 确认${command}（未写入任何内容）`);
}

export function registerModelCommands(program: Command, context: CommandContext): void {
  const models = program.command("models");
  models.command("list").option("--provider <name>").action(async (options: { provider?: string }) => {
    const paths = context.activePaths();
    const rows = createConfigAdapter(context.readConfig(paths), {
      pluginProviders: (await context.pluginCatalog(paths)).providers,
      disabledProviderIds: Object.keys(readProviderStates(paths.stateDir).disabledProviders)
    }).listModels()
      .filter((row) => !options.provider || row.providerId === options.provider);
    for (const row of rows) {
      const flags = [row.enabled ? "enabled" : "disabled", row.isPrimary ? "primary" : ""].filter(Boolean).join(",");
      console.log(`${row.ref}\t${row.alias ?? ""}\t${flags}`);
    }
  });

  models.command("inventory")
    .description("统一模型 inventory（config / 插件 / OpenClaw 运行时三来源合并视图）")
    .option("--json", "输出 Core ModelInventory 原样 JSON")
    .option("--refresh", "强制重新探测")
    .action(async (options: { json?: boolean; refresh?: boolean }) => {
      const inventory = await context.buildInventory({ refresh: options.refresh === true });
      if (options.json) {
        console.log(JSON.stringify(inventory, null, 2));
        return;
      }
      printInventoryTable(inventory);
    });

  models.command("unavailable")
    .description("只列 unavailable / unknown 的模型行（unknown 明确标注，不给删除建议）")
    .option("--json", "输出过滤后的模型行 JSON")
    .action(async (options: { json?: boolean }) => {
      const inventory = await context.buildInventory();
      const rows = inventory.models.filter(
        (entry) => entry.needsAttention ?? (entry.availability === "unavailable" || entry.availability === "unknown")
      );
      if (options.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      if (rows.length === 0) {
        console.log("没有 unavailable / unknown 的模型");
        return;
      }
      console.log("ref\tpolicy\tavailability\treason\tsources");
      for (const entry of rows) printInventoryRow(entry);
    });

  program.command("use")
    .argument("<ref>")
    .action(async (ref: string) => {
      const paths = context.activePaths();
      await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: `set primary model ${ref}`,
        async mutate(config) {
          const entry = findInventoryEntry(await context.buildInventory({ refresh: true, config, paths }), ref);
          if (!entry) throw new Error(`Model ${ref} not found in current inventory.`);
          context.assertProviderCanEnable(entry.providerId, paths);
          return setPrimaryModel(config, ref, (await context.pluginCatalog(paths)).providers, entry).config;
        }
      });
      console.log(`Primary model set to ${ref}`);
    });

  const model = program.command("model");
  model.command("disable")
    .argument("<ref>")
    .action(async (ref: string) => {
      const paths = context.activePaths();
      await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: `disable model ${ref}`,
        async mutate(config) {
          const entry = findInventoryEntry(await context.buildInventory({ refresh: true, config, paths }), ref);
          if (!entry) throw new Error(`Model ${ref} not found in current inventory.`);
          if (entry.availability !== "available") throw new Error(`Runtime model availability is ${entry.availability}; use reference reconciliation instead of disabling.`);
          return disableModel(config, ref).config;
        }
      });
      console.log(`Disabled ${ref}`);
    });

  model.command("enable")
    .argument("<ref>")
    .option("--alias <alias>")
    .action(async (ref: string, options: { alias?: string }) => {
      const paths = context.activePaths();
      await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: `enable model ${ref}`,
        async mutate(config) {
          const entry = findInventoryEntry(await context.buildInventory({ refresh: true, config, paths }), ref);
          if (!entry) throw new Error(`Model ${ref} not found in current inventory.`);
          context.assertProviderCanEnable(entry.providerId, paths);
          return enableModel(config, ref, options.alias, (await context.pluginCatalog(paths)).providers, entry).config;
        }
      });
      console.log(`Enabled ${ref}`);
    });

  model.command("add")
    .argument("<ref>")
    .option("--alias <alias>")
    .option("--enable", "Add model to allowlist")
    .action(async (ref: string, options: { alias?: string; enable?: boolean }) => {
      const paths = context.activePaths();
      const input: { enabled: boolean; alias?: string } = { enabled: Boolean(options.enable) };
      if (options.alias !== undefined) input.alias = options.alias;
      if (input.enabled) {
        context.assertProviderCanEnable(parseModelRef(ref).providerId);
      }
      await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: `add model ${ref}`,
        async mutate(config) {
          return addProviderModel(config, ref, input).config;
        }
      });
      console.log(`Added model ${ref}`);
    });

  model.command("remove")
    .argument("<ref>")
    .option("--force")
    .option("--new-primary <ref>")
    .action(async (ref: string, options: { force?: boolean; newPrimary?: string }) => {
      const paths = context.activePaths();
      const removeOptions: { force: boolean; newPrimary?: string } = { force: Boolean(options.force) };
      if (options.newPrimary !== undefined) removeOptions.newPrimary = options.newPrimary;
      await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: `remove model ${ref}`,
        async mutate(config) {
          const entry = findInventoryEntry(await context.buildInventory({ refresh: true, config, paths }), ref);
          if (entry?.availability === "unknown") throw new Error("Runtime model availability is unknown; refresh before removing its catalog entry.");
          return removeProviderModel(config, ref, removeOptions).config;
        }
      });
      console.log(`Removed model ${ref}`);
    });

  model.command("remove-policy-ref")
    .description("删除 agents.defaults.modelPolicy.allow 的一条 exact 引用（wildcard 只读，metadata 默认保留）")
    .argument("<ref>")
    .option("--remove-metadata", "同时删除 agents.defaults.models 中的同名 legacy metadata")
    .option("--yes", "非交互环境显式确认删除（destructive action fail closed）")
    .option("--json", "输出 JSON 结果")
    .action(async (ref: string, options: { removeMetadata?: boolean; yes?: boolean; json?: boolean }) => {
      try {
        requireNonInteractiveYes("model remove-policy-ref", options.yes);
        const paths = context.activePaths();
        let warnings: string[] = [];
        const result = await writeOpenClawTransaction({
          ...paths,
          runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
          reason: `remove policy exact ref ${ref}`,
          normalizeConfig: false,
          async mutate(config) {
            const entry = findInventoryEntry(await context.buildInventory({ refresh: true, config, paths }), ref);
            // 精确停用不判断可调用性，仍由 Core 校验主模型、fallback 与 wildcard。
            const operation = removeModelPolicyExactRef(config, ref, {
              ...(options.removeMetadata === undefined ? {} : { removeMetadata: options.removeMetadata })
            });
            warnings = operation.warnings;
            return operation.config;
          }
        });
        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            ref,
            backupId: result.backupDir.split("/").pop(),
            warnings
          }));
          return;
        }
        console.log(`Removed policy exact ref ${ref} (backup: ${result.backupDir.split("/").pop()})`);
        for (const warning of warnings) console.warn(warning);
      } catch (error) {
        console.error(commandErrorMessage(error));
        process.exitCode = 1;
      }
    });

  model.command("add-policy-rule")
    .description("向 agents.defaults.modelPolicy.allow 添加一条规则（exact provider/model 或 wildcard provider/*；仅 restricted 模式）")
    .argument("<rule>")
    .option("--json", "输出 JSON 结果")
    .action(async (rule: string, options: { json?: boolean }) => {
      try {
        // 添加规则只扩大选择范围（与 model enable 同级），不要求 --yes；守卫全在 Core operation 内
        const paths = context.activePaths();
        let warnings: string[] = [];
        let stored: { rule: string; kind: "exact" | "wildcard" } | undefined;
        const result = await writeOpenClawTransaction({
          ...paths,
          runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
          reason: `add model policy rule ${rule}`,
          normalizeConfig: false,
          async mutate(config) {
            const inventory = await context.buildInventory({ refresh: true, config, paths });
            const operation = addModelPolicyRule(config, rule, {
              knownProviderIds: inventory.providers.map((provider) => provider.providerId)
            });
            warnings = operation.warnings;
            stored = { rule: operation.rule, kind: operation.kind };
            return operation.config;
          }
        });
        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            rule: stored!.rule,
            kind: stored!.kind,
            backupId: result.backupDir.split("/").pop(),
            warnings
          }));
          return;
        }
        console.log(`Added policy ${stored!.kind} rule ${stored!.rule} (backup: ${result.backupDir.split("/").pop()})`);
        for (const warning of warnings) console.warn(warning);
      } catch (error) {
        console.error(commandErrorMessage(error));
        process.exitCode = 1;
      }
    });

  model.command("remove-policy-wildcard")
    .description("按完全相同字符串删除 agents.defaults.modelPolicy.allow 的一条 wildcard 规则（含全部重复副本；exact 走 remove-policy-ref）")
    .argument("<value>")
    .option("--yes", "非交互环境显式确认删除（destructive action fail closed）")
    .option("--json", "输出 JSON 结果")
    .action(async (value: string, options: { yes?: boolean; json?: boolean }) => {
      try {
        requireNonInteractiveYes("model remove-policy-wildcard", options.yes);
        const paths = context.activePaths();
        let warnings: string[] = [];
        let removedCount = 0;
        const result = await writeOpenClawTransaction({
          ...paths,
          runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
          reason: `remove model policy wildcard ${value}`,
          normalizeConfig: false,
          async mutate(config) {
            const inventory = await context.buildInventory({ refresh: true, config, paths });
            const operation = removeModelPolicyWildcard(config, value, { inventory });
            warnings = operation.warnings;
            removedCount = operation.removedCount;
            return operation.config;
          }
        });
        if (options.json) {
          console.log(JSON.stringify({
            ok: true,
            value,
            removedCount,
            backupId: result.backupDir.split("/").pop(),
            warnings
          }));
          return;
        }
        console.log(`Removed policy wildcard ${value} (${removedCount} entries, backup: ${result.backupDir.split("/").pop()})`);
        for (const warning of warnings) console.warn(warning);
      } catch (error) {
        console.error(commandErrorMessage(error));
        process.exitCode = 1;
      }
    });

  model.command("reconcile")
    .description("协调一个模型引用：预览并（--yes 后）把运行时可用的模型补入已有 config Provider")
    .argument("<ref>")
    .option("--yes", "确认写入（materialize 是 destructive action，非交互环境必须显式指定）")
    .option("--json", "输出 JSON 结果")
    .action(async (ref: string, options: { yes?: boolean; json?: boolean }) => {
      try {
        const paths = context.activePaths();
        const inventory = await context.buildInventory({ paths });
        const entry = findInventoryEntry(inventory, ref);
        if (entry === undefined) {
          throw new Error(`Model ${ref} not found in current inventory; nothing to reconcile.`);
        }

        // 可以 materialize：预览 / --yes 执行
        if (entry.capabilities.canMaterializeConfigModel) {
          const input = { id: entry.modelId, enabled: false };
          if (!options.yes) {
            if (options.json) {
              console.log(JSON.stringify({ action: "materialize", ...entry, confirmed: false }));
              return;
            }
            console.log(`materialize ${entry.ref}: runtime available + provider ${entry.providerId} 已在 config`);
            console.log("预览：将把该模型补入 models.providers（enabled=false，不写入 policy/allowlist）");
            console.log("确认执行请加 --yes（未写入任何内容）");
            return;
          }
          let warnings: string[] = [];
          const result = await writeOpenClawTransaction({
            ...paths,
            runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
            reason: `materialize runtime model ${ref}`,
            normalizeConfig: false,
            async mutate(config) {
              const freshEntry = findInventoryEntry(await context.buildInventory({ refresh: true, config, paths }), ref);
              if (!freshEntry) throw new Error(`Model ${ref} not found in current inventory.`);
              context.assertProviderCanEnable(freshEntry.providerId, paths);
              const operation = materializeRuntimeModel(config, freshEntry, input);
              warnings = operation.warnings;
              return operation.config;
            }
          });
          if (options.json) {
            console.log(JSON.stringify({
              ok: true,
              ref: entry.ref,
              action: "materialize",
              backupId: result.backupDir.split("/").pop(),
              warnings
            }));
            return;
          }
          console.log(`Materialized ${entry.ref} into provider ${entry.providerId} (backup: ${result.backupDir.split("/").pop()})`);
          for (const warning of warnings) console.warn(warning);
          return;
        }

        // 证据未知不能建议补造 Provider；--yes 请求被拒绝时必须非零退出。
        if (entry.availability === "unknown") {
          throw new Error("Runtime model availability is unknown; refresh before reconciling.");
        }

        // Provider 缺配置（provider-config-required）：打印下一步所需字段，绝不自动创建
        if (isProviderMissing(context.readConfig(paths), entry.providerId)) {
          const hint = [
            `Provider ${entry.providerId} is not defined in models.providers; add the provider before materializing ${entry.ref}.`,
            "下一步（不自动创建，需用户提供连接信息）：",
            `  1. providerId: ${entry.providerId}`,
            "  2. baseUrl（如 https://api.example/v1）",
            "  3. API 类型（openai-completions / anthropic-messages 等）",
            "  4. credentials：API Key 的 env 变量名（值只写 .env，不回显）",
            `可运行: oc-switch provider add-custom --id ${entry.providerId} ...`
          ].join("\n");
          if (options.json) {
            console.log(JSON.stringify({
              ok: false,
              ref: entry.ref,
              action: "provider-config-required",
              requiredFields: ["providerId", "baseUrl", "api", "apiKeyEnv"]
            }));
          } else {
            console.error(hint);
          }
          process.exitCode = 1;
          return;
        }

        // 其余不可 materialize 的状态：预览仅报告事实，显式写入请求不能伪装成功。
        if (options.yes) throw new Error(`Model ${entry.ref} cannot be materialized (${entry.availability}).`);
        if (options.json) {
          console.log(JSON.stringify({ action: "none", ...entry }));
          return;
        }
        console.log(`${entry.ref}: availability=${entry.availability} (${entry.availabilityReasons.join(", ") || "-"})`);
        console.log(`catalogSources=${entry.catalogSources.join(",")}; 无法 materialize（不需要任何操作时保留即可）`);
      } catch (error) {
        console.error(commandErrorMessage(error));
        process.exitCode = 1;
      }
    });
}

/** Provider 是否在 config 的 models.providers（大小写折叠解析，与 core resolveProviderId 语义一致） */
function isProviderMissing(config: { models?: { providers?: Record<string, unknown> } }, providerId: string): boolean {
  const providerIds = Object.keys(config.models?.providers ?? {});
  const folded = providerId.toLowerCase();
  return !providerIds.some((candidate) => candidate.toLowerCase() === folded);
}
