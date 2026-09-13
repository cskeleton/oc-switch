import type { ModelInventoryEntry, ModelPluginDescriptor } from "../api";
import { Pill } from "./ui/pill";

/**
 * 模型行状态徽章组。
 *
 * 三个维度互相独立、绝不合成为一个 boolean：
 * - 策略（精确/通配）：brand 语义色；
 * - 插件启停逐插件展示，不覆盖策略或运行状态；
 * - 可用性（可用/不可用/无法确认）：success / destructive / warning 语义色。
 * 目录来源额外显示完整并集；仅引用不伪装成目录项。
 *
 * 硬约束：不可用 badge 不得复用「已禁用」文案（那是 policy 禁用语义）；
 * 策略 badge 与可用性 badge 使用不同语义色，不混用。
 */

interface ModelStateBadgesProps {
  entry: ModelInventoryEntry;
  plugins?: ModelPluginDescriptor[];
  /** 是否渲染目录来源 badge（默认 true；表格窄列可关） */
  showCatalogSource?: boolean;
}

/** 策略来源只解释允许方式，不替代 policyAllowed。 */
const POLICY_SOURCE_LABELS = {
  legacy: "传统元数据",
  unrestricted: "无限制策略",
  "policy-exact": "精确策略",
  "policy-wildcard": "通配策略"
} as const;

/** 来源是并集，不按 config 优先级遮蔽其它来源。 */
export const CATALOG_SOURCE_LABELS = {
  config: "本地配置",
  "plugin-manifest": "插件目录",
  "openclaw-runtime": "运行时目录"
} as const;

/** 可用性 badge：三态各自独立文案，「不可用」绝不写成「已禁用」 */
function availabilityBadge(entry: ModelInventoryEntry): { label: string; tone: "success" | "destructive" | "warning" } {
  switch (entry.availability) {
    case "available":
      return { label: "可用", tone: "success" };
    case "unavailable":
      return { label: "不可用", tone: "destructive" };
    default:
      return { label: "无法确认", tone: "warning" };
  }
}

/** 可用性原因的中文映射（title 提示用，不占用表格宽度） */
export const AVAILABILITY_REASON_LABELS: Record<string, string> = {
  "plugin-disabled": "插件已停用",
  "provider-not-found": "Provider 不存在",
  "model-not-in-catalog": "模型不在目录中",
  "missing-auth": "缺少认证",
  "route-incompatible": "路由不兼容",
  "provider-rejected": "Provider 拒绝",
  "probe-failed": "探测失败或信息不足"
};

/** 模型行状态徽章组：策略、插件状态、可用性独立；目录来源完整保留。 */
export function ModelStateBadges({ entry, plugins = [], showCatalogSource = true }: ModelStateBadgesProps) {
  const availability = availabilityBadge(entry);
  const reasonText = entry.availabilityReasons
    .map((reason) => AVAILABILITY_REASON_LABELS[reason] ?? reason)
    .join("、");

  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Pill variant={entry.policyAllowed ? "brand" : "muted"}>
        {entry.policyAllowed ? "策略允许" : "策略未允许"}
      </Pill>
      {entry.selectionSource ? <Pill variant="brand">{POLICY_SOURCE_LABELS[entry.selectionSource]}</Pill> : null}
      {showCatalogSource ? (
        entry.catalogSources.length === 0
          ? <Pill variant="muted">仅引用</Pill>
          : entry.catalogSources.map(source => <Pill key={source} variant="muted">{CATALOG_SOURCE_LABELS[source]}</Pill>)
      ) : null}
      {entry.pluginIds.map(id => {
        const plugin = plugins.find(candidate => candidate.id === id);
        return (
          <Pill key={id} variant={plugin?.enabled ? "success" : entry.inactive ? "muted" : "warning"}>
            插件 {id}：{plugin ? plugin.enabled ? "启用中" : "已停用" : "状态未知"}
          </Pill>
        );
      })}
      <Pill variant={entry.inactive ? "muted" : availability.tone} title={reasonText || undefined}>
        {availability.label}
      </Pill>
    </span>
  );
}
