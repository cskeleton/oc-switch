import type { ConfigDiffSummary } from "../api";

interface DiffSummaryProps {
  diff: ConfigDiffSummary;
}

function ListSection({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <h4 className="text-xs font-medium uppercase tracking-wide text-slate-400">{title}</h4>
      <ul className="mt-1 list-inside list-disc text-sm text-slate-200">
        {items.map((item) => (
          <li key={item} className="break-all">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 配置变更摘要，用于预览写入影响 */
export function DiffSummary({ diff }: DiffSummaryProps) {
  const empty =
    diff.providersAdded.length === 0 &&
    diff.providersRemoved.length === 0 &&
    diff.providersChanged.length === 0 &&
    diff.modelsEnabled.length === 0 &&
    diff.modelsDisabled.length === 0 &&
    !diff.primaryChanged;

  if (empty) {
    return <p className="text-sm text-slate-400">无待展示的变更</p>;
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-700 bg-slate-800/50 p-3" data-testid="diff-summary">
      <ListSection title="新增 Provider" items={diff.providersAdded} />
      <ListSection title="移除 Provider" items={diff.providersRemoved} />
      <ListSection title="变更 Provider" items={diff.providersChanged} />
      <ListSection title="启用模型" items={diff.modelsEnabled} />
      <ListSection title="禁用模型" items={diff.modelsDisabled} />
      {diff.primaryChanged ? (
        <div>
          <h4 className="text-xs font-medium uppercase tracking-wide text-slate-400">主模型变更</h4>
          <p className="mt-1 break-all text-sm text-slate-200">
            {diff.primaryChanged.before ?? "(无)"} → {diff.primaryChanged.after ?? "(无)"}
          </p>
        </div>
      ) : null}
    </div>
  );
}
