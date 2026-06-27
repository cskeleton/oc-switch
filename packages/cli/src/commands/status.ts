import { createConfigAdapter, inspectConfigHealth, repairOpenClawCompatibility, summarizeConfigDiff, writeOpenClawTransaction } from "@oc-switch/core";
import type { Command } from "commander";
import type { CommandContext } from "../command-context";

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
        console.log(repaired.changed ? "Would repair OpenClaw compatibility issues" : "No compatibility repairs needed");
        return;
      }
      if (!repaired.changed) {
        console.log("No compatibility repairs needed");
        for (const warning of repaired.warnings) console.warn(warning);
        return;
      }
      const result = await writeOpenClawTransaction({
        ...paths,
        reason: "repair OpenClaw compatibility",
        mutate() {
          return repaired.config;
        }
      });
      console.log(`Repaired OpenClaw compatibility (backup: ${result.backupDir.split("/").pop()})`);
      for (const warning of repaired.warnings) console.warn(warning);
    });

  health.action(() => {
    const report = inspectConfigHealth(context.readConfig());
    if (report.caseDuplicateGroups.length === 0) {
      console.log("未发现 Provider 大小写重复");
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
  });
}
