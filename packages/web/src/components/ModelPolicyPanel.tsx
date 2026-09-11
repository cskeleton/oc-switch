import type { ModelPolicyRuleEntry } from "../api";
import { DataTable, type Column } from "./DataTable";
import { EmptyState } from "./EmptyState";
import { Button } from "./ui/button";
import { Pill } from "./ui/pill";

/**
 * modelPolicy.allow 规则面板（spec §11.3）。
 *
 * - exact 规则：仅按 Core 的 removable 提供删除入口，保护性/最后一条/unknown 等只读；
 * - wildcard 规则：本期只读，显示命中/不可用计数；
 * - invalid 条目：值不回显（secret-free 纪律），仅显示原始下标。
 */

interface ModelPolicyPanelProps {
  rules: ModelPolicyRuleEntry[];
  /** 删除 exact 规则（上层负责确认框与 API 调用） */
  onRemoveRule: (value: string) => void | Promise<void>;
}

function kindPill(rule: ModelPolicyRuleEntry): { label: string; tone: "brand" | "muted" | "destructive" } {
  switch (rule.kind) {
    case "exact":
      return { label: "精确", tone: "brand" };
    case "wildcard":
      return { label: "通配", tone: "muted" };
    default:
      return { label: "无效", tone: "destructive" };
  }
}

/** 两种布局共享同一份计数内容，手机把它放到完整规则值下方。 */
function RuleCounts({ rule }: { rule: ModelPolicyRuleEntry }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-muted-foreground">
      命中 {rule.matchedModelCount} 个模型
      {rule.unavailableModelCount > 0 ? `，其中 ${rule.unavailableModelCount} 个不可用` : ""}
      {rule.kind === "wildcard" && rule.matchedModelCount === 0 ? <Pill variant="warning">零命中</Pill> : null}
    </span>
  );
}

export function ModelPolicyPanel({ rules, onRemoveRule }: ModelPolicyPanelProps) {
  const columns: Column<ModelPolicyRuleEntry>[] = [
    {
      key: "value",
      header: "规则",
      wrap: "anywhere",
      sortable: true,
      sortValue: (row) => row.value,
      render: (row) => (
        <div className="min-w-0">
          {/* invalid 条目不回显值（可能含敏感内容），只显示下标；合法规则保持完整。 */}
          {row.kind === "invalid"
            ? <span className="text-muted-foreground">modelPolicy.allow[{row.invalidIndex}]（非字符串条目）</span>
            : <span className="font-medium">{row.value}</span>}
          <div className="mt-1 whitespace-normal text-xs md:hidden"><RuleCounts rule={row} /></div>
        </div>
      )
    },
    {
      key: "kind",
      header: "类型",
      wrap: "nowrap",
      className: "hidden md:table-cell",
      sortable: true,
      sortValue: (row) => row.kind,
      render: (row) => {
        const kind = kindPill(row);
        return <Pill variant={kind.tone}>{kind.label}</Pill>;
      }
    },
    {
      key: "counts",
      header: "命中情况",
      wrap: "nowrap",
      className: "hidden md:table-cell",
      render: (row) => <RuleCounts rule={row} />
    },
    {
      key: "actions",
      header: "操作",
      wrap: "nowrap",
      className: "w-20 md:w-auto",
      render: (row) => {
        // 只读规则（wildcard 本期 / 保护性 exact / invalid）不提供删除入口
        if (row.kind !== "exact" || !row.removable) return <Pill variant="muted">只读</Pill>;
        return (
          <Button
            variant="ghost"
            size="sm"
            aria-label={`删除规则 ${row.value}`}
            onClick={() => void onRemoveRule(row.value)}
          >
            删除
          </Button>
        );
      }
    }
  ];

  if (rules.length === 0) {
    return <EmptyState title="当前模式无策略规则" description="legacy / unrestricted 模式下 modelPolicy.allow 不产生有效规则。" />;
  }

  return (
    <div className="space-y-4">
      {([["exact", "精确规则"], ["wildcard", "通配规则"], ["invalid", "无效规则"]] as const).map(([kind, label]) => {
        const group = rules.filter(rule => rule.kind === kind);
        if (group.length === 0) return null;
        return (
          <section key={kind} aria-label={label} className="space-y-2">
            <h3 className="text-sm font-medium">{label}</h3>
            {kind === "wildcard" ? <p className="text-xs text-muted-foreground">通配规则只读；若要单独禁用模型，请先在 OpenClaw 配置中收窄规则。</p> : null}
            <DataTable
              columns={columns}
              rows={group}
              // 原始规则允许重复值；用位置区分，invalid 值不进入 DOM/key。
              rowKey={row => `rule-${rules.indexOf(row)}`}
              defaultSort={{ key: "value", dir: "asc" }}
              // 手机固定两列：仅为操作保留窄列，其余宽度给规则；桌面恢复四列自动布局。
              minWidthClass="min-w-0 table-fixed md:min-w-[32rem] md:table-auto"
            />
          </section>
        );
      })}
    </div>
  );
}
