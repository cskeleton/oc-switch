import type { ModelInventoryEntry, ModelPluginDescriptor } from "../api";
import { DataTable, type Column } from "./DataTable";
import { EmptyState } from "./EmptyState";
import { Button } from "./ui/button";
import { Pill } from "./ui/pill";
import { AVAILABILITY_REASON_LABELS, ModelStateBadges } from "./ModelStateBadges";

interface UnavailableModelsPanelProps {
  /** 由上层按严重性排序；unknown 仅供诊断，不开放处理入口。 */
  models: ModelInventoryEntry[];
  plugins?: ModelPluginDescriptor[];
  onHandleRef: (ref: string) => void | Promise<void>;
}

const REFERENCE_LABELS = {
  primary: "主模型引用",
  fallback: "fallback 引用",
  "legacy-metadata": "legacy metadata 引用",
  "policy-exact": "policy 精确引用",
  "policy-wildcard": "policy 通配引用"
} as const;

function guidance(entry: ModelInventoryEntry): string {
  if (entry.availability === "unknown") return "探测证据不足，请刷新后复核；暂不提供清理操作。";
  if (entry.referenceSources.includes("primary")) return "主模型不可直接删除，请先替换主模型（agents.defaults.model）";
  if (entry.referenceSources.includes("fallback")) return "fallback 引用不可直接删除，请先更新回退链（agents.defaults.model.fallbacks）";
  return entry.availabilityReasons.map(reason => AVAILABILITY_REASON_LABELS[reason] ?? reason).join("、") || "运行时标记为不可用";
}

/** 处理入口不等于删除权限：即使没有清理能力，用户仍可查看原因、手动补全或保留。 */
export function UnavailableModelsPanel({ models, plugins = [], onHandleRef }: UnavailableModelsPanelProps) {
  const columns: Column<ModelInventoryEntry>[] = [
    {
      key: "ref",
      header: "模型与状态",
      wrap: "anywhere",
      sortable: true,
      sortValue: row => row.ref,
      render: row => (
        <div className="space-y-2">
          <span className="font-medium">{row.ref}</span>
          <div className="flex flex-wrap gap-1">
            {row.referenceSources.map(source => <Pill key={source} variant="muted">{REFERENCE_LABELS[source]}</Pill>)}
          </div>
          <ModelStateBadges entry={row} plugins={plugins} />
          <p className="text-xs text-muted-foreground">{guidance(row)}</p>
        </div>
      )
    },
    {
      key: "actions",
      header: "操作",
      wrap: "nowrap",
      render: row => {
        if (row.availability === "unknown") return null;
        const label = row.referenceSources.includes("primary")
          ? "替换主模型"
          : row.referenceSources.includes("fallback") ? "查看替换指引" : "处理";
        return (
          <Button variant="outline" size="sm" aria-label={`${label} ${row.ref}`} onClick={() => void onHandleRef(row.ref)}>
            {label}
          </Button>
        );
      }
    }
  ];

  if (models.length === 0) return <EmptyState title="没有不可用模型" description="当前 inventory 未发现不可用或未知模型。" />;

  return <DataTable columns={columns} rows={models} rowKey={row => row.ref} minWidthClass="min-w-[20rem] md:min-w-[36rem]" />;
}
