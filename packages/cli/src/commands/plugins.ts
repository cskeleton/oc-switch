import {
  setModelPluginEnabled,
  suspendModelProviders, restoreModelProviderSelection, readPluginSelectionState, savePluginSelectionState, mergeModelSelectionEntries, readProviderStates,
  writeOpenClawTransaction,
  type ModelPluginDescriptor
} from "@oc-switch/core";
import type { Command } from "commander";
import type { CommandContext } from "../command-context";
import { commandErrorMessage } from "../errors";

/**
 * 插件级启停命令（spec §9 / §10.2）。
 *
 * 安全边界（Task 4 review 裁定，binding）：core 的 `setModelPluginEnabled` 信任传入
 * descriptor，因此 CLI 必须先把 plugin-id 解析到当前发现的 `plugins: ModelPluginDescriptor[]`
 * （`await context.pluginCatalog()`），未知 id → 清晰报错 + 非零退出、不写任何文件——镜像
 * server 端 PATCH /api/plugins/:pluginId/state 的 404 边界，杜绝凭空注入 descriptor。
 *
 * 非 TTY destructive action 无 `--yes` fail closed；写入走 Core 事务
 * `writeOpenClawTransaction`（自动备份 + diff guard），组合插件开关与
 * 可恢复的目标 Provider 选择规则移出。与 `sync push --enable-plugins` 的
 * 「仅显式列出的 pluginId、仅 false→true」收窄互不相干（后者在 config-sync，本文件不触碰）。
 */

/** 与 models.ts 的 model 命令保持同款非交互确认约束 */
function requireNonInteractiveYes(command: string, confirmed: boolean | undefined): void {
  if (confirmed) return;
  if (!process.stdin.isTTY) {
    throw new Error(`非交互环境必须显式 --yes 确认${command}（fail closed，未写入任何内容）`);
  }
  throw new Error(`请使用 --yes 确认${command}（未写入任何内容）`);
}

/** 影响面提示：受影响 Provider（一个插件可贡献多个 Provider）与非模型能力 */
function printAffectedProviders(plugin: ModelPluginDescriptor): void {
  const providerIds = [...new Set(plugin.providerIds)].sort();
  console.log(`影响 Provider（插件 ${plugin.id} 贡献，插件级开关，不逐 Provider 拆分）：${providerIds.join(", ")}`);
  if (plugin.nonModelCapabilities.length > 0) {
    console.log(`非模型能力影响：${plugin.nonModelCapabilities.join(", ")}（停用/启用影响这些能力，不只是模型 Provider）`);
  }
}

async function changePluginState(
  context: CommandContext,
  pluginId: string,
  enabled: boolean,
  options: { yes?: boolean; json?: boolean; cleanupMetadata?: boolean }
): Promise<void> {
  try {
    // 边界校验优先（Task 4 review 裁定）：descriptor 只来自当前发现的插件列表，
    // 未知 id → 清晰报错 + 非零退出、不写盘——先于 --yes 闸门，让用户先知道 id 本身不合法
    const paths = context.activePaths();
    const currentDescriptor = async (): Promise<ModelPluginDescriptor> => {
      context.invalidateCatalogCaches();
      const catalog = await context.pluginCatalog(paths);
      if (catalog.diagnostics.length > 0) throw new Error("Plugin catalog is incomplete; refresh before changing plugin state.");
      const descriptor = catalog.plugins.find((plugin) => plugin.id === pluginId);
      if (!descriptor) throw new Error(`Plugin ${pluginId} is not installed or does not contribute any model provider; oc-switch only manages installed model plugins.`);
      return descriptor;
    };
    if (!options.yes) {
      await currentDescriptor();
      requireNonInteractiveYes(enabled ? "plugin enable" : "plugin disable", options.yes);
    }
    let descriptor!: ModelPluginDescriptor;

    let warnings: string[] = [];
    let policyEntries: string[] = [];
    const result = await writeOpenClawTransaction({
      ...paths,
      runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
      reason: `${enabled ? "enable" : "disable"} plugin ${pluginId}`,
      normalizeConfig: false,
      async mutate(config) {
        descriptor = await currentDescriptor();
        const operation = setModelPluginEnabled(config, descriptor, enabled);
        warnings = operation.warnings.filter(warning => warning.includes("non-model capabilities"));
        const saved = config.plugins?.entries?.[pluginId]?.enabled === false ? readPluginSelectionState(paths.stateDir, pluginId, paths.openclawPath) : undefined;
        if (enabled) return restoreModelProviderSelection(operation.config, saved?.policyEntries ?? [], { providerIds: descriptor.providerIds, blockedProviderIds: Object.values(readProviderStates(paths.stateDir).disabledProviders).filter(state => state.openclawPath === paths.openclawPath && !!config.models?.providers?.[state.providerId]).map(state => state.providerId) });
        const inventory = await context.buildInventory({ config, paths });
        const suspended = suspendModelProviders(operation.config, descriptor.providerIds, {
          cleanupMetadata: options.cleanupMetadata === true,
          ...(inventory.pickerSource === "gateway" ? { visibleRefs: inventory.models.filter(model => model.pickerVisible).map(model => model.ref) } : {})
        });
        policyEntries = mergeModelSelectionEntries(saved?.policyEntries ?? [], suspended.policyEntries);
        return suspended.config;
      },
      afterWrite() {
        savePluginSelectionState(paths.stateDir, pluginId, enabled ? undefined : { openclawPath: paths.openclawPath, policyEntries });
      }
    });

    let runtimeConfirmed = false;
    let diagnostics: { command: string; code: string; message: string }[] = [];
    try {
      const inventory = await context.buildInventory({ refresh: true, paths });
      diagnostics = inventory.diagnostics;
      runtimeConfirmed = diagnostics.length === 0 && Object.values((await context.runtimeModelSnapshot(paths)).completeness).every(Boolean) &&
        inventory.plugins.some(plugin => plugin.id === pluginId && plugin.enabled === enabled) &&
        (enabled || !inventory.models.some(model => model.pickerVisible && descriptor.providerIds.some(id => id.toLowerCase() === model.providerId.toLowerCase())));
    } catch {
      diagnostics = [{ command: "status", code: "invalid-shape", message: "Write succeeded; runtime confirmation failed" }];
    }

    if (options.json) {
      console.log(JSON.stringify({
        ok: true,
        pluginId,
        enabled,
        runtimeConfirmed,
        diagnostics,
        affectedProviderIds: [...new Set(descriptor.providerIds)].sort(),
        backupId: result.backupDir.split("/").pop(),
        warnings
      }));
      return;
    }
    printAffectedProviders(descriptor);
    console.log(`Plugin ${pluginId} configuration is now ${enabled ? "enabled" : "disabled"} (backup: ${result.backupDir.split("/").pop()})`);
    if (!runtimeConfirmed) console.warn("配置已写入，运行时未确认；请刷新或使用 gateway apply。");
    for (const warning of warnings) console.warn(warning);
  } catch (error) {
    // PluginStateError（primary/fallback 阻断等）统一转 message + 非零退出
    console.error(commandErrorMessage(error));
    process.exitCode = 1;
  }
}

export function registerPluginCommands(program: Command, context: CommandContext): void {
  const plugin = program
    .command("plugin")
    .description("模型插件启停（保留 API Key，可恢复地移出/恢复模型选择规则）");

  plugin.command("enable")
    .description("启用一个已安装的模型插件（plugins.entries.<id>.enabled=true）")
    .argument("<plugin-id>")
    .option("--yes", "非交互环境显式确认（destructive action fail closed）")
    .option("--json", "输出 JSON 结果")
    .action(async (pluginId: string, options: { yes?: boolean; json?: boolean; cleanupMetadata?: boolean }) => {
      await changePluginState(context, pluginId, true, options);
    });

  plugin.command("disable")
    .option("--cleanup-metadata", "同时清理别名和模型参数，保留 .env 密钥")
    .description("停用一个已安装的模型插件（plugins.entries.<id>.enabled=false；主模型/fallback 命中时阻断）")
    .argument("<plugin-id>")
    .option("--yes", "非交互环境显式确认（destructive action fail closed）")
    .option("--json", "输出 JSON 结果")
    .action(async (pluginId: string, options: { yes?: boolean; json?: boolean; cleanupMetadata?: boolean }) => {
      await changePluginState(context, pluginId, false, options);
    });
}
