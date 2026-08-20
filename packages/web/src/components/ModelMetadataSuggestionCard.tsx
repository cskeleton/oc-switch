import { useState } from "react";
import type {
  ModelMetadataSourceKind,
  ModelMetadataSourceStatus,
  ModelMetadataSuggestion,
  ModelMetadataMatchKind
} from "../api";
import { Button } from "./ui/button";

/**
 * 参考模型建议卡。
 *
 * 职责仅限：候选选择、来源展示与 apply 回调。
 * 网络/加载/错误状态由 ModelDialog 负责。
 * 任何数值只有在用户点击“应用”后才会写入表单；
 * 多候选时必须先由用户显式选择候选，应用按钮才可用。
 */

const MATCH_KIND_LABELS: Record<ModelMetadataMatchKind, string> = {
  "provider-exact": "Provider 精确匹配",
  "endpoint-exact": "Endpoint 精确匹配",
  "model-key-exact": "模型 Key 精确匹配",
  "provider-model-exact": "Provider/Model 组合精确匹配",
  "unique-model-id": "唯一模型 ID 匹配"
};

const SOURCE_KIND_LABELS: Record<ModelMetadataSourceKind, string> = {
  "models-dev-model": "Models.dev 模型事实",
  "models-dev-provider": "Models.dev Provider 目录"
};

export interface ModelMetadataSuggestionCardProps {
  suggestions: ModelMetadataSuggestion[];
  sources: ModelMetadataSourceStatus[];
  currentContextWindow?: number | undefined;
  currentMaxTokens?: number | undefined;
  onApplyContextWindow: (value: number) => void;
  onApplyMaxTokens: (value: number) => void;
}

function formatValue(value: number | undefined): string {
  return value === undefined ? "—" : String(value);
}

export function ModelMetadataSuggestionCard({
  suggestions,
  sources,
  currentContextWindow,
  currentMaxTokens,
  onApplyContextWindow,
  onApplyMaxTokens
}: ModelMetadataSuggestionCardProps) {
  const multiple = suggestions.length > 1;
  // 多候选时不预选：避免用户未注意就把字典序/优先级第一的候选应用掉
  const [selectedIndex, setSelectedIndex] = useState<number | null>(multiple ? null : 0);
  if (suggestions.length === 0) return null;

  const index = selectedIndex === null ? null : Math.min(selectedIndex, suggestions.length - 1);
  const selected = index === null ? undefined : suggestions[index]!;
  const model = selected?.model;
  const sourceStatus = model ? sources.find((source) => source.kind === model.sourceKind) : undefined;
  const staleSource = Boolean(sourceStatus?.stale);

  function applyAll() {
    if (model?.contextWindow !== undefined) onApplyContextWindow(model.contextWindow);
    if (model?.maxTokens !== undefined) onApplyMaxTokens(model.maxTokens);
  }

  const contextDiffers =
    model?.contextWindow !== undefined &&
    currentContextWindow !== undefined &&
    currentContextWindow !== model.contextWindow;
  const maxDiffers =
    model?.maxTokens !== undefined && currentMaxTokens !== undefined && currentMaxTokens !== model.maxTokens;

  return (
    <div
      data-testid="model-metadata-suggestion-card"
      className="space-y-2 rounded-md border border-border bg-muted/30 p-3 text-sm"
    >
      <p className="font-medium">参考参数建议</p>

      {multiple ? (
        <div role="radiogroup" aria-label="候选参考模型" className="space-y-1">
          {suggestions.map((entry, entryIndex) => (
            <label key={`${entry.model.sourceKind}:${entry.model.catalogKey}`} className="flex items-center gap-2">
              <input
                type="radio"
                name="model-metadata-suggestion-select"
                aria-label={`选择参考模型 ${entry.model.catalogKey}`}
                checked={entryIndex === index}
                onChange={() => setSelectedIndex(entryIndex)}
                className="h-3.5 w-3.5"
              />
              <span>{entry.model.name ?? entry.model.catalogKey}</span>
              <span className="text-xs text-muted-foreground">
                （{SOURCE_KIND_LABELS[entry.model.sourceKind]} · {MATCH_KIND_LABELS[entry.matchKind]}）
              </span>
            </label>
          ))}
        </div>
      ) : null}

      {multiple && index === null ? (
        <p role="status" className="text-xs text-muted-foreground">
          请先选择一个候选参考模型，再应用参数。
        </p>
      ) : null}

      {model && selected ? (
        <>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs md:grid-cols-3">
            <div>
              <dt className="text-muted-foreground">模型</dt>
              <dd className="font-medium">{model.name ?? model.catalogKey}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">原生上下文</dt>
              <dd className="font-medium">{formatValue(model.contextWindow)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">最大输出</dt>
              <dd className="font-medium">{formatValue(model.maxTokens)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">匹配方式</dt>
              <dd>{MATCH_KIND_LABELS[selected.matchKind]}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">来源</dt>
              <dd>
                {SOURCE_KIND_LABELS[model.sourceKind]}
                {staleSource ? "（缓存数据）" : ""}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">数据更新 / 缓存检查</dt>
              <dd>
                {model.updatedAt ?? "—"} / {sourceStatus?.checkedAt ?? "—"}
              </dd>
            </div>
          </dl>

          {selected.confidence === "low" ? (
            <p className="text-xs font-medium text-warning">
              低置信匹配：仅根据模型 ID 唯一性推断，请人工核对后再应用。
            </p>
          ) : null}

          {staleSource ? (
            <p className="text-xs font-medium text-warning">
              该候选来自缓存快照（目录刷新失败），数据可能已过期。
            </p>
          ) : null}

          {contextDiffers ? (
            <p className="text-xs text-muted-foreground">
              原生上下文当前值 {currentContextWindow}，应用后将替换为 {model.contextWindow}
            </p>
          ) : null}
          {maxDiffers ? (
            <p className="text-xs text-muted-foreground">
              最大输出当前值 {currentMaxTokens}，应用后将替换为 {model.maxTokens}
            </p>
          ) : null}
        </>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={model?.contextWindow === undefined}
          onClick={() => {
            if (model?.contextWindow !== undefined) onApplyContextWindow(model.contextWindow);
          }}
          aria-label={
            model?.contextWindow !== undefined
              ? `应用建议的原生上下文 ${model.contextWindow}`
              : "应用建议的原生上下文"
          }
        >
          应用上下文{model?.contextWindow !== undefined ? ` ${model.contextWindow}` : ""}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={model?.maxTokens === undefined}
          onClick={() => {
            if (model?.maxTokens !== undefined) onApplyMaxTokens(model.maxTokens);
          }}
          aria-label={
            model?.maxTokens !== undefined ? `应用建议的最大输出 ${model.maxTokens}` : "应用建议的最大输出"
          }
        >
          应用最大输出{model?.maxTokens !== undefined ? ` ${model.maxTokens}` : ""}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={model === undefined || (model.contextWindow === undefined && model.maxTokens === undefined)}
          onClick={applyAll}
          aria-label="全部应用建议值"
        >
          全部应用
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">“全部应用”只写入原生上下文与最大输出，不会修改运行上下文预算。</p>
    </div>
  );
}
