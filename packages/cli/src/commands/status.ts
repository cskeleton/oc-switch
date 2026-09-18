import { createConfigAdapter, inspectConfigStatus, repairOpenClawCompatibility, summarizeConfigDiff, writeOpenClawTransaction } from "@oc-switch/core";
import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import type { CommandContext } from "../command-context";
import { commandErrorMessage } from "../errors";

export function registerStatusCommands(program: Command, context: CommandContext): void {
  program.command("status").action(() => {
    const status = createConfigAdapter(context.readConfig()).getStatus();
    console.log(`Primary: ${status.primaryModel ?? "(none)"}`);
    console.log(`Providers: ${status.providerCount}`);
    console.log(`Provider models: ${status.providerModelCount}`);
    console.log(`Allowlist models: ${status.allowlistModelCount}`);
  });

  const health = program.command("health");

  health.command("repair")
    .option("--dry-run", "预览修复差异，不写入配置")
    .action(async (options: { dryRun?: boolean }) => {
      const paths = context.activePaths();
      const before = context.readConfig();
      const repaired = repairOpenClawCompatibility(structuredClone(before));
      if (options.dryRun) {
        console.log(JSON.stringify(summarizeConfigDiff(before, repaired.config), null, 2));
        for (const warning of repaired.warnings) console.warn(warning);
        console.log(repaired.changed ? "Would repair OpenClaw compatibility and Provider ID casing" : "No compatibility or Provider ID casing repairs needed");
        return;
      }
      if (!repaired.changed) {
        console.log("No compatibility or Provider ID casing repairs needed");
        for (const warning of repaired.warnings) console.warn(warning);
        return;
      }
      const result = await writeOpenClawTransaction({
        ...paths,
        runtimeDiscoveryProvider: context.runtimeDiscoveryProvider,
        reason: "repair OpenClaw compatibility",
        mutate() {
          return repaired.config;
        }
      });
      console.log(`Repaired OpenClaw compatibility and Provider ID casing (backup: ${result.backupDir.split("/").pop()})`);
      for (const warning of repaired.warnings) console.warn(warning);
    });

  health
    .option("--json", "以 JSON 输出健康报告与 issues 数组")
    .action(async (options: { json?: boolean }) => {
    try {
      const paths = context.activePaths();
      const config = context.readConfig(paths);
      const envContent = existsSync(paths.envPath) ? readFileSync(paths.envPath, "utf8") : "";
      const catalog = await context.pluginCatalog(paths);
      // 与 cleanup-stale-policy-refs 同款组装（models.ts），issues 汇总走统一 config-status
      const status = inspectConfigStatus({
        config,
        paths,
        envContent,
        pluginProviders: catalog.providers
      });
      const issues = [...status.issues].sort((a, b) => {
        const rank = { blocking: 0, warning: 1, info: 2 } as const;
        return rank[a.severity] - rank[b.severity];
      });
      if (options.json) {
        console.log(JSON.stringify({ health: status.health, issues }, null, 2));
        return;
      }
      if (issues.length > 0) {
        console.log(`发现 ${issues.length} 个配置问题：`);
        for (const issue of issues) {
          const label = issue.severity === "blocking" ? "阻断" : issue.severity === "warning" ? "警告" : "提示";
          console.log(`\n[${label}] ${issue.title}`);
          if (issue.detail) console.log(`  ${issue.detail}`);
          if (issue.action) console.log(`  建议操作：${issue.action}`);
        }
      }
      const report = status.health;
      if (report.caseDuplicateGroups.length === 0) {
        if (issues.length === 0) console.log("未发现 Provider 大小写重复");
        return;
      }
      console.log(`发现 ${report.summary.duplicateGroupCount} 组 Provider 大小写重复：`);
      for (const group of report.caseDuplicateGroups) {
        const flag = group.mergeable ? "可合并" : "需人工核对";
        console.log(`\n[${group.groupKey}] ${group.ids.join(" / ")}  (${group.confidence}, ${flag})`);
        console.log(`  建议保留 ${group.canonicalId}，合并并删除 ${group.duplicateIds.join(", ")}`);
        for (const reason of group.reasons) console.log(`  - ${reason}`);
        if (group.mergeBlockers.length) console.log(`  ⚠ 阻断合并：${group.mergeBlockers.join("；")}`);
        if (group.mergeable) {
          console.log(`  合并命令：oc-switch providers merge-duplicates --group ${group.groupKey} --keep ${group.canonicalId} --remove ${group.duplicateIds.join(",")}`);
        }
      }
    } catch (error) {
      console.error(commandErrorMessage(error));
      process.exitCode = 1;
    }
  });
}
