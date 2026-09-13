interface ModelDeleteLayersProps {
  /** 「连同使用配置（别名/参数）」勾选状态 */
  metadata: boolean;
  /** 「连同精确放行（policy exact 条目）」勾选状态 */
  policyExact: boolean;
  /** 该 ref 被 policy wildcard 覆盖时，「连同精确放行」置灰并附说明 */
  wildcardCovered: boolean;
  disabled?: boolean;
  onChange: (next: { metadata: boolean; policyExact: boolean }) => void;
}

/**
 * 删除模型的三层写模型分级选项（ModelsView 与 ProviderModelsDialog 共用）。
 * 默认全不勾 = 临时移除：只删目录条目，随时可加回；API Key 永不在删除范围内。
 */
export function ModelDeleteLayers({ metadata, policyExact, wildcardCovered, disabled = false, onChange }: ModelDeleteLayersProps) {
  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">默认临时移除：只删目录条目，模型随时可加回；API Key 不受影响。</p>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={metadata}
          disabled={disabled}
          onChange={(event) => onChange({ metadata: event.target.checked, policyExact })}
        />
        <span>连同使用配置（别名/参数）</span>
      </label>
      <label className="flex items-start gap-2">
        <input
          type="checkbox"
          checked={!wildcardCovered && policyExact}
          disabled={disabled || wildcardCovered}
          onChange={(event) => onChange({ metadata, policyExact: event.target.checked })}
        />
        <span>连同精确放行（policy exact 条目）</span>
      </label>
      {wildcardCovered ? (
        <p className="text-xs text-muted-foreground">已被通配规则覆盖，无需删除 exact 条目。</p>
      ) : null}
    </div>
  );
}
