import type { ModelPolicyMode, ModelPolicyRuleEntry } from "../api";
import { DataTable, type Column } from "./DataTable";
import { EmptyState } from "./EmptyState";
import { Button } from "./ui/button";
import { Pill } from "./ui/pill";

/**
 * modelPolicy.allow 规则面板（spec §11.3 + 规则编辑 spec §6）。
 *
 * - exact 规则：仅按 Core 的 removable 提供删除入口，保护性/最后一条/unknown 等只读；
 * - wildcard 规则：removable 时可显式删除；不可删时显示「受保护」；
 * - invalid 条目：值不回显（secret-free 纪律），仅显示原始下标；
 * - 规则编辑仅适用于 restricted 模式；其它模式（或旧后端缺 policyMode）只显示提示。
 */

interface ModelPolicyPanelProps {
  rules: ModelPolicyRuleEntry[];
  /** 当前策略模式；缺失（旧后端）时隐藏添加入口，安全回退为提示 */
  policyMode?: ModelPolicyMode | undefined;
  /** 有写操作进行中时禁用添加入口 */
  busy?: boolean;
  /** 打开添加规则对话框（仅 restricted 模式渲染入口） */
  onAddRule: () => void;
  /** 删除规则入口；由调用方按 rule.kind 分发到 exact / wildcard 流程 */
  onRemoveRule: (rule: ModelPolicyRuleEntry) => void | Promise<void>;
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

export function ModelPolicyPanel({ rules, policyMode, busy, onAddRule, onRemoveRule }: ModelPolicyPanelProps) {
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
        // invalid 条目永远只读（不回显值）
        if (row.kind === "invalid") return <Pill variant="muted">只读</Pill>;
        // gating 一律读 Core 投影的 removable，前端不重新实现 policy 守卫
        if (row.removable) {
          return (
            <Button
              variant="ghost"
              size="sm"
              aria-label={`删除规则 ${row.value}`}
              onClick={() => void onRemoveRule(row)}
            >
              删除
            </Button>
          );
        }
        // 不可删的 wildcard：受主模型/fallback 覆盖保护或为避免清空策略
        if (row.kind === "wildcard") {
          return <Pill variant="muted" title="被主模型/fallback 依赖，或为避免清空策略">受保护</Pill>;
        }
        // 保护性 exact 等只读
        return <Pill variant="muted">只读</Pill>;
      }
    }
  ];

  if (rules.length === 0) {
    return <EmptyState title="当前模式无策略规则" description="legacy / unrestricted 模式下 modelPolicy.allow 不产生有效规则。" />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-muted-foreground">
          {policyMode === "restricted"
            ? "添加或删除规则只改 modelPolicy.allow；目录、metadata 与 API Key 不变。"
            : `当前为 ${policyMode ?? "legacy / unrestricted"} 模式，规则编辑仅适用于 restricted 模式。`}
        </p>
        {policyMode === "restricted" ? (
          <Button variant="outline" size="sm" disabled={busy === true} onClick={onAddRule}>
            添加规则
          </Button>
        ) : null}
      </div>
      {([["exact", "精确规则"], ["wildcard", "通配规则"], ["invalid", "无效规则"]] as const).map(([kind, label]) => {
        const group = rules.filter(rule => rule.kind === kind);
        if (group.length === 0) return null;
        return (
          <section key={kind} aria-label={label} className="space-y-2">
            <h3 className="text-sm font-medium">{label}</h3>
            {kind === "wildcard" ? <p className="text-xs text-muted-foreground">通配规则可显式删除；oc-switch 绝不自动改写。</p> : null}
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
